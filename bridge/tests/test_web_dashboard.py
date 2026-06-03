"""Tests for the bridge dashboard renderer."""

from silentsuite_bridge import config
from silentsuite_bridge.radicale.creds import Credentials
from silentsuite_bridge.web import _render_dashboard, update_status


def test_render_dashboard_lists_each_configured_account(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)

    creds = Credentials()
    creds.set_etebase("alice@example.com", "alice-session", "https://server-a.test")
    creds.set_etebase("bob@example.com", "bob-session", "https://server-b.test")
    creds.save()

    update_status(
        "connected",
        collections={"calendars": 2, "contacts": 1, "tasks": 0},
        scope="all configured accounts",
    )

    html = _render_dashboard()

    assert "alice@example.com" in html
    assert "bob@example.com" in html
    assert "https://server-a.test" in html
    assert "https://server-b.test" in html
    assert "http://127.0.0.1:37358/alice@example.com/" in html
    assert "http://127.0.0.1:37358/bob@example.com/" in html
    assert "Collections (all configured accounts)" in html
    assert "2 calendars, 1 contacts, 0 tasks" in html
