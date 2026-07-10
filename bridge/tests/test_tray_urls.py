"""Tests for scheme-aware DAV and dashboard URLs in tray actions."""

from types import SimpleNamespace
from unittest.mock import MagicMock

from silentsuite_bridge import config, tray


class FakeMenu:
    SEPARATOR = object()

    def __init__(self, *items):
        self.items = items


class FakeMenuItem:
    def __init__(self, text, action, **kwargs):
        self.text = text
        self.action = action
        self.kwargs = kwargs


def _menu_item(menu, text):
    return next(item for item in menu.items if isinstance(item, FakeMenuItem) and item.text == text)


def test_tray_url_helpers_follow_ssl_config(monkeypatch):
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    assert tray._dashboard_url() == "http://127.0.0.1:37358/"
    assert tray._account_dav_url("alice@example.com") == "http://127.0.0.1:37358/alice@example.com/"

    monkeypatch.setattr(config, "SSL_ENABLED", True)
    assert tray._dashboard_url() == "https://127.0.0.1:37358/"
    assert tray._account_dav_url("alice@example.com") == "https://127.0.0.1:37358/alice@example.com/"


def test_https_tray_actions_copy_and_open_configured_urls(monkeypatch):
    monkeypatch.setattr(tray, "TRAY_AVAILABLE", True)
    monkeypatch.setattr(tray, "pystray", SimpleNamespace(Menu=FakeMenu, MenuItem=FakeMenuItem))
    monkeypatch.setattr(tray, "_get_accounts", lambda: ["alice@example.com"])
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", True)

    manager = tray.BridgeTray()
    manager._copy_to_clipboard = MagicMock()
    open_browser = MagicMock()
    monkeypatch.setattr(tray.webbrowser, "open", open_browser)

    menu = manager._build_menu()
    account_item = _menu_item(menu, "alice@example.com")
    copy_caldav = _menu_item(account_item.action, "Copy CalDAV URL")
    copy_carddav = _menu_item(account_item.action, "Copy CardDAV URL")
    open_dashboard = _menu_item(menu, "Open Dashboard")

    copy_caldav.action("icon", "item")
    copy_carddav.action("icon", "item")
    open_dashboard.action("icon", "item")

    expected_dav = "https://127.0.0.1:37358/alice@example.com/"
    assert manager._copy_to_clipboard.call_args_list == [
        ((expected_dav,), {}),
        ((expected_dav,), {}),
    ]
    open_browser.assert_called_once_with("https://127.0.0.1:37358/")
