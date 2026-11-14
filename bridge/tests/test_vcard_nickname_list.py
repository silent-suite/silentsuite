"""Every NICKNAME value survives a DAV round trip through the Bridge.

A vCard NICKNAME is a comma-separated list. The PUT body is parsed by
Radicale (vobject), stored as an Etebase item and served back through the
Bridge's read path; each step must keep all values, including an escaped
comma inside one value. Real Radicale WSGI application and storage backend;
scripted SDK managers from ``test_carddav_remote_delete_convergence``.
"""

import io

import pytest
import vobject

from silentsuite_bridge.radicale.storage import Collection
from tests.test_carddav_remote_delete_convergence import (
    COLLECTION_UID,
    _bridge,
    _remote_item,
    _seed,
    _service,
)
from tests.test_macos_dav_discovery import USERNAME, _basic_auth


def _call(app, method, href, body=b""):
    captured = {}

    def start_response(status, headers):
        captured["status"] = status

    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": f"/{USERNAME}/{COLLECTION_UID}/{href}",
        "QUERY_STRING": "",
        "SCRIPT_NAME": "",
        "HTTP_HOST": "127.0.0.1:37358",
        "SERVER_NAME": "127.0.0.1",
        "SERVER_PORT": "37358",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "REMOTE_ADDR": "127.0.0.1",
        "CONTENT_LENGTH": str(len(body)),
        "CONTENT_TYPE": "text/vcard; charset=utf-8",
        "HTTP_AUTHORIZATION": _basic_auth(),
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(body),
        "wsgi.errors": io.StringIO(),
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    response = b"".join(app(environ, start_response))
    return captured["status"], response.decode()


def _card(version, uid, nickname, fn="Lars Example", group=""):
    return (
        f"BEGIN:VCARD\r\nVERSION:{version}\r\nUID:{uid}\r\nFN:{fn}\r\n"
        f"N:Example;Lars;;;\r\n{group}NICKNAME:{nickname}\r\nEND:VCARD\r\n"
    ).encode()


def _nicknames(text):
    card = vobject.readOne(text)
    return [value for line in card.contents["nickname"] for value in line.value]


@pytest.mark.parametrize("version", ["3.0", "4.0"])
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Lasse,QA-Lars", ["Lasse", "QA-Lars"]),
        ("Smith\\, Jr.,Bob", ["Smith, Jr.", "Bob"]),
    ],
    ids=["list", "escaped_comma"],
)
def test_nickname_list_survives_create_and_replace(
    tmp_path, monkeypatch, version, raw, expected
):
    app, database, user, remote, _direct = _bridge(tmp_path, monkeypatch)
    _seed(remote, _service(database, user, remote))

    status, _body = _call(app, "PUT", "lars.vcf", _card(version, "lars", raw))
    assert status.startswith("201")
    stored = remote.created[0].content.decode()
    assert _nicknames(stored) == expected
    status, served = _call(app, "GET", "lars.vcf")
    assert status.startswith("200")
    assert _nicknames(served) == expected

    replacement = _card(version, "lars", raw, fn="Lars Renamed")
    status, _body = _call(app, "PUT", "lars.vcf", replacement)
    assert status.startswith(("200", "201", "204"))
    stored = remote.created[0].content.decode()
    assert "Lars Renamed" in stored
    assert _nicknames(stored) == expected
    status, served = _call(app, "GET", "lars.vcf")
    assert _nicknames(served) == expected


def test_direct_upload_keeps_every_nickname(tmp_path, monkeypatch):
    _app, database, user, remote, direct_storage = _bridge(tmp_path, monkeypatch)
    _seed(remote, _service(database, user, remote))
    incoming = type(
        "Incoming",
        (),
        {"vobject_item": vobject.readOne(_card("3.0", "lars", "Lasse,QA-Lars").decode())},
    )()

    Collection(direct_storage, f"/{USERNAME}/{COLLECTION_UID}").upload(
        "lars.vcf", incoming
    )

    assert "NICKNAME:Lasse,QA-Lars" in remote.created[0].content.decode()


GROUPED_NICKNAMES = pytest.mark.parametrize(
    ("raw", "expected"),
    [("Lasse", ["Lasse"]), ("Lasse,QA-Lars", ["Lasse", "QA-Lars"])],
    ids=["single", "list"],
)


def _groups(text):
    return [line.group for line in vobject.readOne(text).contents["nickname"]]


@pytest.mark.parametrize("version", ["3.0", "4.0"])
@GROUPED_NICKNAMES
def test_grouped_nickname_survives_create_and_replace(
    tmp_path, monkeypatch, version, raw, expected
):
    app, database, user, remote, _direct = _bridge(tmp_path, monkeypatch)
    _seed(remote, _service(database, user, remote))

    for fn in ("Lars Example", "Lars Renamed"):
        body = _card(version, "lars", raw, fn=fn, group="item1.")
        status, _body = _call(app, "PUT", "lars.vcf", body)
        assert status.startswith("201")
        stored = remote.created[0].content.decode()
        assert fn in stored
        assert _nicknames(stored) == expected
        assert _groups(stored) == ["item1"]
        status, served = _call(app, "GET", "lars.vcf")
        assert status.startswith("200")
        assert _nicknames(served) == expected
        assert _groups(served) == ["item1"]


@pytest.mark.parametrize("version", ["3.0", "4.0"])
@GROUPED_NICKNAMES
def test_stored_grouped_nickname_is_served(
    tmp_path, monkeypatch, version, raw, expected
):
    app, database, user, remote, _direct = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    _seed(remote, service)
    content = _card(version, "lars", raw, group="item1.").decode()
    remote.queue_item_page(
        _remote_item(
            "remote-lars",
            content,
            meta={"name": "lars", "dav_href": "lars.vcf"},
            etag="etag-lars",
        ),
        stoken="items-lars",
    )
    service.sync()

    status, served = _call(app, "GET", "lars.vcf")

    assert status.startswith("200")
    assert _nicknames(served) == expected
    assert _groups(served) == ["item1"]
