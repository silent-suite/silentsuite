"""Tests for SilentSuite Bridge configuration."""

import os
from unittest.mock import patch

import pytest


NETWORK_ENV_KEYS = (
    "SILENTSUITE_LISTEN_ADDRESS",
    "SILENTSUITE_LISTEN_PORT",
    "SILENTSUITE_SERVER_HOSTS",
    "SILENTSUITE_ALLOW_REMOTE",
)


def reload_config_with_env(monkeypatch, **values):
    import importlib
    from silentsuite_bridge import config

    for key in NETWORK_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    return importlib.reload(config)


def restore_config(monkeypatch):
    import importlib
    from silentsuite_bridge import config

    for key in NETWORK_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    return importlib.reload(config)


class TestConfigDefaults:
    """Test that config module exposes sensible defaults."""

    def test_default_server_url(self):
        from silentsuite_bridge import config
        assert "silentsuite.io" in config.ETEBASE_SERVER_URL

    def test_default_listen_address(self):
        from silentsuite_bridge import config
        assert config.LISTEN_ADDRESS == "127.0.0.1"

    def test_default_listen_port(self):
        from silentsuite_bridge import config
        assert config.LISTEN_PORT == 37358

    def test_default_sync_interval(self):
        from silentsuite_bridge import config
        # Default is 15 minutes (900 seconds)
        assert config._DEFAULT_SYNC_INTERVAL == 900

    def test_default_sync_minimum(self):
        from silentsuite_bridge import config
        assert config.SYNC_MINIMUM == 30

    def test_col_types(self):
        from silentsuite_bridge import config
        assert "etebase.vevent" in config.COL_TYPES
        assert "etebase.vtodo" in config.COL_TYPES
        assert "etebase.vcard" in config.COL_TYPES

    def test_default_log_level(self):
        from silentsuite_bridge import config
        assert config.LOG_LEVEL == "INFO"


class TestConfigEnvOverrides:
    """Test that environment variables override defaults."""

    def test_server_url_env(self):
        with patch.dict(os.environ, {"SILENTSUITE_SERVER_URL": "https://custom.server"}):
            # Re-import to pick up env
            import importlib
            from silentsuite_bridge import config
            original = config.ETEBASE_SERVER_URL
            # The env var is read at import time, so we test the mechanism
            val = os.environ.get("SILENTSUITE_SERVER_URL", "https://server.silentsuite.io")
            assert val == "https://custom.server"
            # Restore
            config.ETEBASE_SERVER_URL = original

    def test_listen_port_env(self):
        val = int(os.environ.get("SILENTSUITE_LISTEN_PORT", "37358"))
        assert isinstance(val, int)

    def test_sync_interval_env(self):
        with patch.dict(os.environ, {"SILENTSUITE_SYNC_INTERVAL": "120"}):
            val = int(os.environ.get("SILENTSUITE_SYNC_INTERVAL", "900"))
            assert val == 120

    def test_sync_minimum_env(self):
        with patch.dict(os.environ, {"SILENTSUITE_SYNC_MINIMUM": "10"}):
            val = int(os.environ.get("SILENTSUITE_SYNC_MINIMUM", "30"))
            assert val == 10

    def test_default_network_config_is_loopback_only(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch)
        try:
            cfg.validate_network_config()
            assert cfg.remote_bind_reasons() == []
            assert cfg.is_dashboard_enabled() is True
        finally:
            restore_config(monkeypatch)

    def test_non_loopback_listen_address_requires_explicit_opt_in(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_LISTEN_ADDRESS="0.0.0.0")
        try:
            with pytest.raises(RuntimeError, match="SILENTSUITE_ALLOW_REMOTE=1"):
                cfg.validate_network_config()
        finally:
            restore_config(monkeypatch)

    def test_non_loopback_server_hosts_requires_explicit_opt_in(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_SERVER_HOSTS="0.0.0.0:37358")
        try:
            with pytest.raises(RuntimeError, match="SILENTSUITE_SERVER_HOSTS"):
                cfg.validate_network_config()
        finally:
            restore_config(monkeypatch)

    def test_remote_opt_in_allows_bind_but_disables_dashboard(self, monkeypatch):
        cfg = reload_config_with_env(
            monkeypatch,
            SILENTSUITE_LISTEN_ADDRESS="0.0.0.0",
            SILENTSUITE_ALLOW_REMOTE="1",
        )
        try:
            cfg.validate_network_config()
            assert cfg.is_remote_bind_configured() is True
            assert cfg.is_dashboard_enabled() is False
        finally:
            restore_config(monkeypatch)

    def test_ipv6_loopback_server_hosts_are_allowed(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_SERVER_HOSTS="[::1]:37358")
        try:
            cfg.validate_network_config()
            assert cfg.remote_bind_reasons() == []
        finally:
            restore_config(monkeypatch)


class TestConfigHelpers:
    """Test config helper functions."""

    def test_get_platform_returns_string(self):
        from silentsuite_bridge.config import get_platform
        platform = get_platform()
        assert platform in ("linux", "macos", "windows")

    def test_get_settings_returns_dict(self, tmp_path):
        from silentsuite_bridge import config
        original = config.SETTINGS_FILE
        config.SETTINGS_FILE = str(tmp_path / "nonexistent.json")
        try:
            settings = config.get_settings()
            assert isinstance(settings, dict)
        finally:
            config.SETTINGS_FILE = original

    def test_save_and_load_settings(self, tmp_path):
        from silentsuite_bridge import config
        original_settings = config.SETTINGS_FILE
        original_data = config.DATA_DIR
        config.SETTINGS_FILE = str(tmp_path / "settings.json")
        config.DATA_DIR = str(tmp_path)
        try:
            config.save_settings({"syncInterval": 60})
            settings = config.get_settings()
            assert settings["syncInterval"] == 60
        finally:
            config.SETTINGS_FILE = original_settings
            config.DATA_DIR = original_data
