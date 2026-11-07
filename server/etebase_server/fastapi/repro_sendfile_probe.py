"""Subprocess probe for SELFHOST-05 (used only by test_repro_sendfile_root.py).

Inert on import: this module only defines functions. All work happens under
``if __name__ == "__main__"`` in a fresh interpreter whose environment the
parent test sets (ETEBASE_DB_PATH, ETEBASE_EASY_CONFIG_PATH and, for the
defect case, DJANGO_MEDIA_ROOT), all pointing into pytest temporary
directories. The filename deliberately does not match pytest.ini
``python_files``, so pytest never collects it.

Modes:
  migrate  - apply migrations to the temporary sqlite database.
  probe    - create a synthetic owner, token and collection, PUT one chunk
             through the real item router, download it, and print one JSON
             receipt line prefixed with RECEIPT_MARKER.
"""

from __future__ import annotations

import json
import os
import sys

RECEIPT_MARKER = "REPRO_SENDFILE_RECEIPT="
COLLECTION_PREFIX = "/api/v1/collection"
CHUNK_BYTES = b"\x00\x01selfhost05-synthetic-chunk\xff"


def _setup_django() -> None:
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "etebase_server.settings")
    import django

    django.setup()


def _uid(*parts: object) -> str:
    return "-".join(str(p) for p in parts).ljust(40, "x")[:40]


def _migrate() -> dict:
    from django.conf import settings
    from django.core.management import call_command

    call_command("migrate", interactive=False, verbosity=0)
    return {"mode": "migrate", "db_name": str(settings.DATABASES["default"]["NAME"])}


def _make_app():
    from fastapi import FastAPI, Request

    from etebase_server.fastapi.exceptions import CustomHttpException
    from etebase_server.fastapi.msgpack import MsgpackResponse
    from etebase_server.fastapi.routers.collection import collection_router, item_router

    app = FastAPI()
    app.include_router(collection_router, prefix=COLLECTION_PREFIX)
    app.include_router(item_router, prefix=COLLECTION_PREFIX + "/{collection_uid}")

    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request: Request, exc: CustomHttpException):  # noqa: RUF029
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    return app


def _probe() -> dict:
    from django.conf import settings
    from fastapi.testclient import TestClient

    from etebase_server.django import models
    from etebase_server.django.token_auth.models import AuthToken
    from etebase_server.fastapi.utils import msgpack_decode
    from etebase_server.myauth.models import get_typed_user_model

    receipt: dict = {
        "mode": "probe",
        "media_root": os.path.realpath(str(settings.MEDIA_ROOT)),
        "sendfile_root": os.path.realpath(str(settings.SENDFILE_ROOT)),
        "secret_file": os.path.realpath(str(settings.SECRET_FILE)),
        "db_name": os.path.realpath(str(settings.DATABASES["default"]["NAME"])),
        "sendfile_backend": settings.SENDFILE_BACKEND,
    }

    User = get_typed_user_model()
    owner = User.objects.create_user(username="selfhost05_owner", email="sh05@example.com", password=None)
    token = AuthToken.objects.create(user=owner).key
    col = models.Collection.objects.create(uid=_uid("sh05col"), owner=owner)
    main_item = models.CollectionItem.objects.create(uid=col.uid, collection=col, version=1)
    models.CollectionItemRevision.objects.create(
        uid=_uid("sh05revmain"), stoken=models.Stoken.objects.create(), item=main_item, meta=b"{}", current=True
    )
    col.main_item = main_item
    col.save()
    models.CollectionMember.objects.create(
        collection=col,
        user=owner,
        encryptionKey=b"\x01" * 32,
        accessLevel=models.AccessLevels.ADMIN,
        collectionType=models.CollectionType.objects.create(uid=_uid("sh05type").encode(), owner=owner),
        stoken=models.Stoken.objects.create(),
    )

    headers = {
        "Accept": "application/msgpack",
        "Content-Type": "application/msgpack",
        "Authorization": f"Token {token}",
    }
    chunk_uid = _uid("sh05chunk")
    base = f"{COLLECTION_PREFIX}/{col.uid}/item/{main_item.uid}/chunk/{chunk_uid}/"
    with TestClient(_make_app(), raise_server_exceptions=False) as client:
        put = client.put(base, content=CHUNK_BYTES, headers=headers)
        receipt["put_status"] = put.status_code
        chunk = col.chunks.filter(uid=chunk_uid).first()
        chunk_path = os.path.realpath(chunk.chunkFile.path) if chunk is not None else None
        receipt["chunk_path"] = chunk_path
        receipt["chunk_exists"] = bool(chunk_path and os.path.isfile(chunk_path))
        receipt["chunk_under_media_root"] = bool(
            chunk_path and os.path.commonpath([chunk_path, receipt["media_root"]]) == receipt["media_root"]
        )

        get = client.get(base + "download/", headers=headers)
        receipt["get_status"] = get.status_code
        receipt["body_matches_upload"] = get.status_code == 200 and get.content == CHUNK_BYTES
        detail = None
        if get.status_code != 200 and get.content:
            try:
                decoded = msgpack_decode(get.content)
                detail = decoded.get("detail") if isinstance(decoded, dict) else str(decoded)
            except Exception:  # noqa: BLE001 - receipt only
                detail = get.content[:500].decode("utf-8", "replace")
        receipt["detail"] = detail
    return receipt


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in ("migrate", "probe"):
        print("usage: repro_sendfile_probe.py migrate|probe", file=sys.stderr)
        return 2
    _setup_django()
    receipt = _migrate() if argv[1] == "migrate" else _probe()
    print(RECEIPT_MARKER + json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
