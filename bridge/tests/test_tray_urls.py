"""Tests for scheme-aware DAV and dashboard URLs in tray actions."""

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from silentsuite_bridge import config, tray


class FakeMenu:
    SEPARATOR = object()

    def __init__(self, *items):
        self.items = items


class FakeMenuItem:
    """Mirror pystray.MenuItem: ``text`` and ``enabled`` may be callables
    taking the item, evaluated whenever the property is read."""

    def __init__(self, text, action, **kwargs):
        self._text = text
        self.action = action
        self.kwargs = kwargs

    @property
    def text(self):
        return self._text(self) if callable(self._text) else self._text

    @property
    def enabled(self):
        value = self.kwargs.get("enabled", True)
        return value(self) if callable(value) else value


def _menu_item(menu, text):
    return next(item for item in menu.items if isinstance(item, FakeMenuItem) and item.text == text)


# The autouse ``fresh_registry`` fixture in conftest.py provides an isolated
# ListenerRegistry for every test; tests request it by name to drive state.


def test_tray_url_helpers_follow_ssl_config(monkeypatch, fresh_registry):
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    # Registry never started: requested-address fallback applies.
    assert tray._dashboard_url() == "http://127.0.0.1:37358/"
    assert tray._account_dav_url("alice@example.com") == "http://127.0.0.1:37358/alice@example.com/"

    monkeypatch.setattr(config, "SSL_ENABLED", True)
    assert tray._dashboard_url() == "https://127.0.0.1:37358/"
    assert tray._account_dav_url("alice@example.com") == "https://127.0.0.1:37358/alice@example.com/"


def test_dav_url_uses_bound_loopback_once_serving_started(monkeypatch, fresh_registry):
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    fresh_registry.reset()
    fresh_registry.record_bound(("127.0.0.1", 45123), None, ssl=False)
    assert tray._account_dav_url("alice@example.com") == "http://127.0.0.1:45123/alice@example.com/"


def test_dav_url_prefers_loopback_over_bound_remote(monkeypatch, fresh_registry):
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    fresh_registry.reset()
    # Remote listed first; loopback must win.
    fresh_registry.record_bound(("192.0.2.10", 45200), None, ssl=False)
    fresh_registry.record_bound(("127.0.0.1", 45123), None, ssl=False)
    assert tray._account_dav_url("alice@example.com") == "http://127.0.0.1:45123/alice@example.com/"


def test_dav_url_falls_back_to_bound_remote_literal_without_loopback(monkeypatch, fresh_registry):
    """Remote-only bind: the copied URL is the actual bound remote literal
    with its custom port, never LISTEN_ADDRESS:LISTEN_PORT."""
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    fresh_registry.reset()
    fresh_registry.record_bound(("192.0.2.10", 45200), None, ssl=False)
    assert tray._account_dav_url("alice@example.com") == "http://192.0.2.10:45200/alice@example.com/"


def test_dav_url_never_returns_wildcard_bind(monkeypatch, fresh_registry):
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    fresh_registry.reset()
    fresh_registry.record_bound(("0.0.0.0", 37358), None, ssl=False)
    assert tray._account_dav_url("alice@example.com") is None


def test_dav_url_returns_none_after_serving_attempted_without_listener(monkeypatch, fresh_registry):
    """After serving was attempted/stopped with no usable bound listener,
    no URL may claim an unbound LISTEN_ADDRESS:LISTEN_PORT."""
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    fresh_registry.reset()
    # Serving attempted and exited with zero listeners bound.
    fresh_registry.mark_stopped()

    assert tray._account_dav_url("alice@example.com") is None
    assert tray._dashboard_url() is None


def test_dav_url_https_scheme_from_bound_ssl_listener(monkeypatch, fresh_registry):
    monkeypatch.setattr(config, "SSL_ENABLED", True)

    fresh_registry.reset()
    fresh_registry.record_bound(("127.0.0.1", 45123), None, ssl=True)
    assert tray._account_dav_url("alice@example.com") == "https://127.0.0.1:45123/alice@example.com/"


def test_https_tray_actions_copy_and_open_configured_urls(monkeypatch, fresh_registry):
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


def test_tray_dashboard_disabled_when_no_loopback_bound(monkeypatch, fresh_registry):
    """When no loopback listener is bound, tray shows disabled item."""
    monkeypatch.setattr(tray, "TRAY_AVAILABLE", True)
    fake_pystray = type(sys)("pystray")
    fake_pystray.Menu = FakeMenu
    fake_pystray.MenuItem = FakeMenuItem
    monkeypatch.setattr(tray, "pystray", fake_pystray)
    monkeypatch.setattr(tray, "_get_accounts", lambda: ["alice@example.com"])
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    # Remote-only bind: dashboard disabled, DAV URL is the bound remote literal.
    fresh_registry.reset()
    fresh_registry.record_bound(("192.0.2.10", 45200), None, ssl=False)

    manager = tray.BridgeTray()
    menu = manager._build_menu()
    item = _menu_item(menu, "Dashboard not bound on a loopback listener")
    assert item.enabled is False

    account_item = _menu_item(menu, "alice@example.com")
    copy_caldav = _menu_item(account_item.action, "Copy CalDAV URL")
    manager._copy_to_clipboard = MagicMock()
    copy_caldav.action("icon", "item")
    manager._copy_to_clipboard.assert_called_once_with(
        "http://192.0.2.10:45200/alice@example.com/"
    )


def test_tray_account_shows_unavailable_when_no_listener_bound(monkeypatch, fresh_registry):
    """Serving stopped with zero usable listeners: the copy callbacks resolve
    the URL at click time and no-op (do not copy a fabricated local URL) when
    no usable listener is bound."""
    monkeypatch.setattr(tray, "TRAY_AVAILABLE", True)
    fake_pystray = type(sys)("pystray")
    fake_pystray.Menu = FakeMenu
    fake_pystray.MenuItem = FakeMenuItem
    monkeypatch.setattr(tray, "pystray", fake_pystray)
    monkeypatch.setattr(tray, "_get_accounts", lambda: ["alice@example.com"])
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    fresh_registry.reset()
    fresh_registry.mark_stopped()

    manager = tray.BridgeTray()
    menu = manager._build_menu()
    account_item = _menu_item(menu, "alice@example.com")
    copy_caldav = _menu_item(account_item.action, "Copy CalDAV URL")
    manager._copy_to_clipboard = MagicMock()
    copy_caldav.action("icon", "item")
    manager._copy_to_clipboard.assert_not_called()


def test_tray_menu_built_pre_start_uses_live_url_after_registry_changes(monkeypatch, fresh_registry):
    """Regression for stale pre-start URL snapshot: a menu built before the
    server binds must, when its callbacks are invoked AFTER the registry moves
    to a running loopback bind, open/copy the live bound URL — not the pre-start
    requested fallback."""
    monkeypatch.setattr(tray, "TRAY_AVAILABLE", True)
    fake_pystray = type(sys)("pystray")
    fake_pystray.Menu = FakeMenu
    fake_pystray.MenuItem = FakeMenuItem
    monkeypatch.setattr(tray, "pystray", fake_pystray)
    monkeypatch.setattr(tray, "_get_accounts", lambda: ["alice@example.com"])
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    # Build the menu pre-start (registry NEVER state).
    manager = tray.BridgeTray()
    menu = manager._build_menu()
    open_dashboard = _menu_item(menu, "Open Dashboard")
    account_item = _menu_item(menu, "alice@example.com")
    copy_caldav = _menu_item(account_item.action, "Copy CalDAV URL")

    # Now the server binds a loopback listener on a DIFFERENT port.
    fresh_registry.reset()
    fresh_registry.record_bound(("127.0.0.1", 45123), None, ssl=False)

    open_browser = MagicMock()
    monkeypatch.setattr(tray.webbrowser, "open", open_browser)
    manager._copy_to_clipboard = MagicMock()

    # Invoking the stale menu's callbacks must use the LIVE bound URL, not the
    # pre-start 127.0.0.1:37358 fallback.
    open_dashboard.action("icon", "item")
    open_browser.assert_called_once_with("http://127.0.0.1:45123/")

    copy_caldav.action("icon", "item")
    manager._copy_to_clipboard.assert_called_once_with(
        "http://127.0.0.1:45123/alice@example.com/"
    )


def test_tray_menu_built_with_loopback_no_ops_after_registry_stops(monkeypatch, fresh_registry):
    """A menu built while a loopback listener was bound must, when invoked
    AFTER the registry is stopped, NOT open or copy the now-stale URL."""
    monkeypatch.setattr(tray, "TRAY_AVAILABLE", True)
    fake_pystray = type(sys)("pystray")
    fake_pystray.Menu = FakeMenu
    fake_pystray.MenuItem = FakeMenuItem
    monkeypatch.setattr(tray, "pystray", fake_pystray)
    monkeypatch.setattr(tray, "_get_accounts", lambda: ["alice@example.com"])
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    # Build the menu while a loopback listener is bound.
    fresh_registry.reset()
    fresh_registry.record_bound(("127.0.0.1", 45123), None, ssl=False)
    manager = tray.BridgeTray()
    menu = manager._build_menu()
    open_dashboard = _menu_item(menu, "Open Dashboard")
    account_item = _menu_item(menu, "alice@example.com")
    copy_caldav = _menu_item(account_item.action, "Copy CalDAV URL")

    # Server stops; no usable listener bound.
    fresh_registry.mark_stopped()

    open_browser = MagicMock()
    monkeypatch.setattr(tray.webbrowser, "open", open_browser)
    manager._copy_to_clipboard = MagicMock()

    open_dashboard.action("icon", "item")
    open_browser.assert_not_called()

    copy_caldav.action("icon", "item")
    manager._copy_to_clipboard.assert_not_called()


def test_tray_menu_built_pre_start_no_ops_after_remote_only_bind(monkeypatch, fresh_registry):
    """A menu built pre-start must, after the server binds remote-only (no
    loopback), NOT open a stale dashboard URL (dashboard is denied) but still
    copy the live bound remote DAV URL."""
    monkeypatch.setattr(tray, "TRAY_AVAILABLE", True)
    fake_pystray = type(sys)("pystray")
    fake_pystray.Menu = FakeMenu
    fake_pystray.MenuItem = FakeMenuItem
    monkeypatch.setattr(tray, "pystray", fake_pystray)
    monkeypatch.setattr(tray, "_get_accounts", lambda: ["alice@example.com"])
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    # Build the menu pre-start (dashboard item enabled via requested fallback).
    manager = tray.BridgeTray()
    menu = manager._build_menu()
    open_dashboard = _menu_item(menu, "Open Dashboard")
    account_item = _menu_item(menu, "alice@example.com")
    copy_caldav = _menu_item(account_item.action, "Copy CalDAV URL")

    # Server binds remote-only; no loopback → dashboard URL is None.
    fresh_registry.reset()
    fresh_registry.record_bound(("192.0.2.10", 45200), None, ssl=False)

    open_browser = MagicMock()
    monkeypatch.setattr(tray.webbrowser, "open", open_browser)
    manager._copy_to_clipboard = MagicMock()

    open_dashboard.action("icon", "item")
    open_browser.assert_not_called()

    copy_caldav.action("icon", "item")
    manager._copy_to_clipboard.assert_called_once_with(
        "http://192.0.2.10:45200/alice@example.com/"
    )


def test_tray_dashboard_item_text_and_enabled_follow_registry_without_rebuild(monkeypatch, fresh_registry):
    """The dashboard item's label and enabled state are live: the same menu
    object built pre-start must report the bound state after the registry
    changes, exactly as pystray re-evaluates callable text/enabled on render."""
    monkeypatch.setattr(tray, "TRAY_AVAILABLE", True)
    fake_pystray = type(sys)("pystray")
    fake_pystray.Menu = FakeMenu
    fake_pystray.MenuItem = FakeMenuItem
    monkeypatch.setattr(tray, "pystray", fake_pystray)
    monkeypatch.setattr(tray, "_get_accounts", lambda: [])
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    manager = tray.BridgeTray()
    menu = manager._build_menu()
    item = _menu_item(menu, "Open Dashboard")
    assert item.enabled is True

    # Serving starts and only a remote listener binds: same item, now disabled.
    fresh_registry.reset()
    fresh_registry.record_bound(("192.0.2.10", 45200), None, ssl=False)
    assert item.text == "Dashboard not bound on a loopback listener"
    assert item.enabled is False

    # The loopback listener binds: same item, enabled again.
    fresh_registry.record_bound(("127.0.0.1", 45123), None, ssl=False)
    assert item.text == "Open Dashboard"
    assert item.enabled is True

    # Serving stops: disabled without any rebuild.
    fresh_registry.mark_stopped()
    assert item.text == "Dashboard not bound on a loopback listener"
    assert item.enabled is False


def test_tray_registry_changes_request_menu_refresh_on_the_changing_thread(monkeypatch, fresh_registry):
    """Every registry change asks pystray to re-render the menu via
    ``Icon.update_menu`` on the calling thread; a failing refresh never
    propagates into the serving path."""
    monkeypatch.setattr(tray, "TRAY_AVAILABLE", True)
    manager = tray.BridgeTray()

    # No icon yet (run() not called): changes are a no-op, not an error.
    fresh_registry.reset()

    icon = SimpleNamespace(update_menu=MagicMock())
    manager._icon = icon
    fresh_registry.record_bound(("127.0.0.1", 45123), None, ssl=False)
    fresh_registry.record_failed()
    fresh_registry.mark_stopped()
    assert icon.update_menu.call_count == 3

    icon.update_menu.side_effect = RuntimeError("backend gone")
    fresh_registry.reset()  # must not raise
    assert fresh_registry.is_started
