"""Tests for the bridge dashboard renderer."""

from silentsuite_bridge import config
from silentsuite_bridge.radicale.creds import Credentials
from silentsuite_bridge.web import (
    _bridge_status,
    _render_dashboard,
    forget_account_status,
    update_status,
)


def _reset_status():
    _bridge_status.update({
        "state": "starting",
        "last_sync": None,
        "error": None,
        "collections": {"calendars": 0, "contacts": 0, "tasks": 0},
        "collections_by_account": {},
        "collections_scope": "all configured accounts",
    })


def test_render_dashboard_lists_each_configured_account(tmp_path, monkeypatch):
    _reset_status()
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


def test_update_status_aggregates_background_sync_counts(tmp_path, monkeypatch):
    _reset_status()
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))

    creds = Credentials()
    creds.set_etebase("alice@example.com", "alice-session", "https://server-a.test")
    creds.set_etebase("bob@example.com", "bob-session", "https://server-b.test")
    creds.save()

    update_status(
        "connected",
        collections={"calendars": 2, "contacts": 0, "tasks": 1},
        account="alice@example.com",
    )
    update_status(
        "connected",
        collections={"calendars": 1, "contacts": 3, "tasks": 0},
        account="bob@example.com",
    )

    assert _bridge_status["collections"] == {
        "calendars": 3,
        "contacts": 3,
        "tasks": 1,
    }
    assert _bridge_status["collections_scope"] == "all configured accounts"

    html = _render_dashboard()
    assert "3 calendars, 3 contacts, 1 tasks" in html


def test_render_dashboard_handles_no_accounts(tmp_path, monkeypatch):
    _reset_status()
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))

    html = _render_dashboard()

    assert "No accounts configured" in html


def test_forget_account_status_removes_one_accounts_counts():
    _reset_status()
    update_status(
        "connected",
        collections={"calendars": 2, "contacts": 0, "tasks": 1},
        account="alice@example.com",
    )
    update_status(
        "connected",
        collections={"calendars": 1, "contacts": 3, "tasks": 0},
        account="bob@example.com",
    )

    forget_account_status("alice@example.com")

    assert _bridge_status["collections"] == {
        "calendars": 1,
        "contacts": 3,
        "tasks": 0,
    }
    assert "alice@example.com" not in _bridge_status["collections_by_account"]
