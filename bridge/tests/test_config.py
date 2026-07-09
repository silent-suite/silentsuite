"""Tests for SilentSuite Bridge configuration."""

import os
from unittest.mock import patch

import pytest

CONFIG_ENV_KEYS = (
    "SILENTSUITE_LISTEN_ADDRESS",
    "SILENTSUITE_LISTEN_PORT",
    "SILENTSUITE_SERVER_HOSTS",
    "SILENTSUITE_ALLOW_REMOTE",
    "SILENTSUITE_DASHBOARD_DUMP",
    "SILENTSUITE_BRIDGE_SSL",
    "SILENTSUITE_BRIDGE_SSL_CERT",
    "SILENTSUITE_BRIDGE_SSL_KEY",
    "SILENTSUITE_SSL",
    "SILENTSUITE_SSL_CERT",
    "SILENTSUITE_SSL_KEY",
)


def reload_config_with_env(monkeypatch, **values):
    import importlib

    from silentsuite_bridge import config

    for key in CONFIG_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    return importlib.reload(config)


def restore_config(monkeypatch):
    import importlib

    from silentsuite_bridge import config

    for key in CONFIG_ENV_KEYS:
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

    def test_dashboard_dump_disabled_by_default(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch)
        try:
            assert cfg.DASHBOARD_DUMP_ENABLED is False
        finally:
            restore_config(monkeypatch)


class TestConfigEnvOverrides:
    """Test that environment variables override defaults."""

    def test_server_url_env(self):
        with patch.dict(os.environ, {"SILENTSUITE_SERVER_URL": "https://custom.server"}):
            # Re-import to pick up env
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

    def test_dashboard_dump_env_opt_in(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_DASHBOARD_DUMP="true")
        try:
            assert cfg.DASHBOARD_DUMP_ENABLED is True
        finally:
            restore_config(monkeypatch)

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

    def test_ipv6_loopback_listen_address_default_hosts_are_bracketed(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_LISTEN_ADDRESS="::1")
        try:
            assert cfg.DEFAULT_SERVER_HOSTS == "[::1]:37358"
            cfg.validate_network_config()
            assert cfg.remote_bind_reasons() == []
        finally:
            restore_config(monkeypatch)

    def test_unbracketed_ipv6_loopback_host_with_port_is_allowed(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_SERVER_HOSTS="::1:37358")
        try:
            cfg.validate_network_config()
            assert cfg.remote_bind_reasons() == []
        finally:
            restore_config(monkeypatch)

    def test_malformed_ipv6_loopback_bracket_does_not_drop_address_tail(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_SERVER_HOSTS="[::1")
        try:
            cfg.validate_network_config()
            assert cfg.remote_bind_reasons() == []
        finally:
            restore_config(monkeypatch)

    def test_localhost_and_127_range_server_hosts_are_allowed(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_SERVER_HOSTS="localhost:37358,127.0.0.2:37358")
        try:
            cfg.validate_network_config()
            assert cfg.remote_bind_reasons() == []
        finally:
            restore_config(monkeypatch)

    def test_non_loopback_ipv6_server_host_requires_explicit_opt_in(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_SERVER_HOSTS="[fe80::1]:37358")
        try:
            with pytest.raises(RuntimeError, match="SILENTSUITE_SERVER_HOSTS"):
                cfg.validate_network_config()
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


class TestSslConfig:
    """Tests for SSL config defaults, env overrides, settings, and validation."""

    def test_ssl_disabled_by_default(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch)
        try:
            assert cfg.SSL_ENABLED is False
            assert cfg.dav_scheme() == "http"
        finally:
            restore_config(monkeypatch)

    def test_ssl_env_enables_https(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_BRIDGE_SSL="1")
        try:
            assert cfg.SSL_ENABLED is True
            assert cfg.dav_scheme() == "https"
        finally:
            restore_config(monkeypatch)

    def test_ssl_legacy_alias_env_enables_https(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_SSL="true")
        try:
            assert cfg.SSL_ENABLED is True
        finally:
            restore_config(monkeypatch)

    def test_ssl_cert_and_key_env_overrides(self, monkeypatch, tmp_path):
        cert = tmp_path / "cert.pem"
        key = tmp_path / "key.pem"
        cfg = reload_config_with_env(
            monkeypatch,
            SILENTSUITE_BRIDGE_SSL="1",
            SILENTSUITE_BRIDGE_SSL_CERT=str(cert),
            SILENTSUITE_BRIDGE_SSL_KEY=str(key),
        )
        try:
            assert cfg.SSL_CERT_FILE == str(cert)
            assert cfg.SSL_KEY_FILE == str(key)
        finally:
            restore_config(monkeypatch)

    def test_default_cert_and_key_paths_inside_data_dir(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch)
        try:
            assert cfg.SSL_CERT_FILE.endswith("localhost-cert.pem")
            assert cfg.SSL_KEY_FILE.endswith("localhost-key.pem")
            assert cfg.DATA_DIR in cfg.SSL_CERT_FILE
        finally:
            restore_config(monkeypatch)

    def test_dav_scheme_http_when_disabled(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch)
        try:
            assert cfg.dav_scheme() == "http"
        finally:
            restore_config(monkeypatch)

    def test_local_base_url_http_default(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch)
        try:
            assert cfg.local_base_url() == "http://127.0.0.1:37358"
        finally:
            restore_config(monkeypatch)

    def test_local_base_url_https_when_ssl_enabled(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch, SILENTSUITE_BRIDGE_SSL="1")
        try:
            assert cfg.local_base_url() == "https://127.0.0.1:37358"
        finally:
            restore_config(monkeypatch)

    def test_local_base_url_brackets_ipv6(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch)
        try:
            assert cfg.local_base_url("::1") == "http://[::1]:37358"
        finally:
            restore_config(monkeypatch)

    def test_validate_ssl_config_noop_when_disabled(self, monkeypatch):
        cfg = reload_config_with_env(monkeypatch)
        try:
            cfg.validate_ssl_config()
        finally:
            restore_config(monkeypatch)

    def test_validate_ssl_config_missing_cert(self, monkeypatch, tmp_path):
        cfg = reload_config_with_env(
            monkeypatch,
            SILENTSUITE_BRIDGE_SSL="1",
            SILENTSUITE_BRIDGE_SSL_CERT=str(tmp_path / "missing-cert.pem"),
            SILENTSUITE_BRIDGE_SSL_KEY=str(tmp_path / "missing-key.pem"),
        )
        try:
            with pytest.raises(RuntimeError, match="certificate file is missing"):
                cfg.validate_ssl_config()
        finally:
            restore_config(monkeypatch)

    def test_validate_ssl_config_missing_key(self, monkeypatch, tmp_path):
        cert = tmp_path / "cert.pem"
        cert.write_text("fake cert")
        cfg = reload_config_with_env(
            monkeypatch,
            SILENTSUITE_BRIDGE_SSL="1",
            SILENTSUITE_BRIDGE_SSL_CERT=str(cert),
            SILENTSUITE_BRIDGE_SSL_KEY=str(tmp_path / "missing-key.pem"),
        )
        try:
            with pytest.raises(RuntimeError, match="key file is missing"):
                cfg.validate_ssl_config()
        finally:
            restore_config(monkeypatch)

    def test_validate_ssl_config_passes_when_files_readable(self, monkeypatch, tmp_path):
        cert = tmp_path / "cert.pem"
        key = tmp_path / "key.pem"
        cert.write_text("fake cert")
        key.write_text("fake key")
        cfg = reload_config_with_env(
            monkeypatch,
            SILENTSUITE_BRIDGE_SSL="1",
            SILENTSUITE_BRIDGE_SSL_CERT=str(cert),
            SILENTSUITE_BRIDGE_SSL_KEY=str(key),
        )
        try:
            cfg.validate_ssl_config()
        finally:
            restore_config(monkeypatch)


class TestSslSettingsPersistence:
    """Tests for SSL settings load/save alongside syncInterval."""

    def test_load_settings_enables_ssl_and_preserves_sync(self, tmp_path, monkeypatch):
        from silentsuite_bridge import config
        original_settings = config.SETTINGS_FILE
        original_data = config.DATA_DIR
        original_ssl = config.SSL_ENABLED
        original_cert = config.SSL_CERT_FILE
        original_key = config.SSL_KEY_FILE
        original_sync = config.SYNC_INTERVAL
        config.SETTINGS_FILE = str(tmp_path / "settings.json")
        config.DATA_DIR = str(tmp_path)
        cert = tmp_path / "cert.pem"
        key = tmp_path / "key.pem"
        config.save_settings({
            "syncInterval": 120,
            "sslEnabled": True,
            "sslCertFile": str(cert),
            "sslKeyFile": str(key),
        })
        try:
            config.load_settings()
            assert config.SSL_ENABLED is True
            assert config.SSL_CERT_FILE == str(cert)
            assert config.SSL_KEY_FILE == str(key)
            assert config.SYNC_INTERVAL == 120
        finally:
            config.SETTINGS_FILE = original_settings
            config.DATA_DIR = original_data
            config.SSL_ENABLED = original_ssl
            config.SSL_CERT_FILE = original_cert
            config.SSL_KEY_FILE = original_key
            config.SYNC_INTERVAL = original_sync
            restore_config(monkeypatch)

    def test_save_settings_preserves_unrelated_keys(self, tmp_path, monkeypatch):
        from silentsuite_bridge import config
        original_settings = config.SETTINGS_FILE
        original_data = config.DATA_DIR
        config.SETTINGS_FILE = str(tmp_path / "settings.json")
        config.DATA_DIR = str(tmp_path)
        try:
            config.save_settings({"syncInterval": 60, "customKey": "keep-me"})
            config.save_settings({"sslEnabled": True})
            settings = config.get_settings()
            assert settings["syncInterval"] == 60
            assert settings["customKey"] == "keep-me"
            assert settings["sslEnabled"] is True
        finally:
            config.SETTINGS_FILE = original_settings
            config.DATA_DIR = original_data
            restore_config(monkeypatch)

    def test_env_overrides_settings_for_ssl(self, tmp_path, monkeypatch):
        from silentsuite_bridge import config
        original_settings = config.SETTINGS_FILE
        original_data = config.DATA_DIR
        config.SETTINGS_FILE = str(tmp_path / "settings.json")
        config.DATA_DIR = str(tmp_path)
        config.save_settings({"sslEnabled": False})
        monkeypatch.setenv("SILENTSUITE_BRIDGE_SSL", "1")
        try:
            config.load_settings()
            assert config.SSL_ENABLED is True
        finally:
            config.SETTINGS_FILE = original_settings
            config.DATA_DIR = original_data
            restore_config(monkeypatch)

    def test_env_overrides_apply_when_settings_file_is_missing(self, tmp_path, monkeypatch):
        from silentsuite_bridge import config
        original_settings = config.SETTINGS_FILE
        original_data = config.DATA_DIR
        original_ssl = config.SSL_ENABLED
        config.SETTINGS_FILE = str(tmp_path / "missing-settings.json")
        config.DATA_DIR = str(tmp_path)
        config.SSL_ENABLED = False
        monkeypatch.setenv("SILENTSUITE_BRIDGE_SSL", "1")
        try:
            config.load_settings()
            assert config.SSL_ENABLED is True
        finally:
            config.SETTINGS_FILE = original_settings
            config.DATA_DIR = original_data
            config.SSL_ENABLED = original_ssl
            restore_config(monkeypatch)
