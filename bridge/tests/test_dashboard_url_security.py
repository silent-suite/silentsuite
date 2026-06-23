"""Regression tests for issue #332: credentials must never appear in a URL."""

import re

import pytest

from silentsuite_bridge import config
from silentsuite_bridge.radicale.creds import Credentials
from silentsuite_bridge.web import _bridge_status, _render_dashboard


def _reset_status():
    _bridge_status.update({
        "state": "starting",
        "last_sync": None,
        "error": None,
        "collections": {"calendars": 0, "contacts": 0, "tasks": 0},
        "collections_by_account": {},
        "collections_scope": "all configured accounts",
    })


def test_dashboard_urls_never_embed_credentials(tmp_path, monkeypatch):
    """#332: no URL rendered by the dashboard may embed Basic-Auth userinfo
    (user:password@host) or a password query param. Credentials must never
    appear in a URL (browser history / referrer / screenshots). The browser
    embedding Basic-Auth creds when a user opens the DAV URL is mitigated by
    warning users not to open it in a browser."""
    _reset_status()
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(
        "silentsuite_bridge.web._account_fingerprint", lambda _c, _u: None
    )

    creds = Credentials()
    creds.set_etebase("alice@example.com", "alice-session", "https://server.test")
    creds.save()

    html = _render_dashboard()

    # The displayed DAV URL puts the email in the path only; the authority has
    # no user:password@ userinfo.
    assert "http://127.0.0.1:37358/alice@example.com/" in html
    userinfo = re.search(r"https?://[^/\s@]+:[^/\s@]+@", html)
    assert userinfo is None, "credential userinfo embedded in URL: " + str(userinfo)
    assert re.search(r"[?&](password|passwd|token|secret)=", html, re.I) is None
    # Users are warned not to open the CalDAV URL in a browser.
    assert "do not open it in a web browser" in html
