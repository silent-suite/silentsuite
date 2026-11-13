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


def _card(version, uid, nickname, fn="Lars Example"):
    return (
        f"BEGIN:VCARD\r\nVERSION:{version}\r\nUID:{uid}\r\nFN:{fn}\r\n"
        f"N:Example;Lars;;;\r\nNICKNAME:{nickname}\r\nEND:VCARD\r\n"
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
