"""Tests for bridge startup account decisions."""

import logging
import sys

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config


def test_check_credentials_allows_no_accounts_when_dashboard_enabled(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "is_dashboard_enabled", lambda: True)

    assert bridge_main.check_credentials(open_browser=False) is True

    output = capsys.readouterr().out
    assert "No account configured yet" in output
    assert "http://127.0.0.1:37358/" in output


def test_check_credentials_blocks_no_accounts_when_dashboard_disabled(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(config, "is_dashboard_enabled", lambda: False)

    assert bridge_main.check_credentials(open_browser=False) is False

    output = capsys.readouterr().out
    assert "dashboard is disabled" in output
    assert "--login" in output
    assert "--manual-login" in output


def test_check_credentials_prints_https_dashboard_url_when_ssl_enabled(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", True)
    monkeypatch.setattr(config, "is_dashboard_enabled", lambda: True)

    assert bridge_main.check_credentials(open_browser=False) is True

    output = capsys.readouterr().out
    assert "https://127.0.0.1:37358/" in output
    assert "http://127.0.0.1:37358/" not in output


def test_dashboard_url_uses_http_when_ssl_disabled(monkeypatch):
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    assert bridge_main._dashboard_url() == "http://127.0.0.1:37358/"


def test_dashboard_url_uses_https_when_ssl_enabled(monkeypatch):
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", True)
    assert bridge_main._dashboard_url() == "https://127.0.0.1:37358/"


def test_build_radicale_configuration_preserves_http_when_ssl_disabled(monkeypatch):
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:37358")
    monkeypatch.setattr(config, "is_dashboard_enabled", lambda: True)

    cfg = bridge_main.build_radicale_configuration()
    assert cfg.get("server", "ssl") is False
    assert bridge_main.effective_dav_scheme() == "http"


def test_build_radicale_configuration_feeds_ssl_when_enabled(monkeypatch, tmp_path):
    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    cert.write_text("fake cert")
    key.write_text("fake key")
    monkeypatch.setattr(config, "SSL_ENABLED", True)
    monkeypatch.setattr(config, "SSL_CERT_FILE", str(cert))
    monkeypatch.setattr(config, "SSL_KEY_FILE", str(key))
    monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:37358")
    monkeypatch.setattr(config, "is_dashboard_enabled", lambda: True)

    cfg = bridge_main.build_radicale_configuration()
    assert cfg.get("server", "ssl") is True
    assert cfg.get("server", "certificate") == str(cert)
    assert cfg.get("server", "key") == str(key)
    assert bridge_main.effective_dav_scheme() == "https"


def test_radicale_ssl_schema_validation_reports_missing_keys():
    with pytest.raises(RuntimeError, match="certificate, key"):
        bridge_main._verify_radicale_ssl_schema({"server": {"ssl": {}}})


def test_missing_cert_raises_clean_runtime_error(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "SSL_ENABLED", True)
    monkeypatch.setattr(config, "SSL_CERT_FILE", str(tmp_path / "missing-cert.pem"))
    monkeypatch.setattr(config, "SSL_KEY_FILE", str(tmp_path / "missing-key.pem"))
    with pytest.raises(RuntimeError, match="certificate file is missing"):
        config.validate_ssl_config()


def test_missing_key_raises_clean_runtime_error(monkeypatch, tmp_path):
    cert = tmp_path / "cert.pem"
    cert.write_text("fake cert")
    monkeypatch.setattr(config, "SSL_ENABLED", True)
    monkeypatch.setattr(config, "SSL_CERT_FILE", str(cert))
    monkeypatch.setattr(config, "SSL_KEY_FILE", str(tmp_path / "missing-key.pem"))
    with pytest.raises(RuntimeError, match="key file is missing"):
        config.validate_ssl_config()


def test_main_missing_ssl_file_exits_cleanly_without_traceback(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge"])
    monkeypatch.setattr(bridge_main, "configure_logging", lambda: None)
    monkeypatch.setattr(config, "SSL_ENABLED", True)
    monkeypatch.setattr(config, "SSL_CERT_FILE", str(tmp_path / "missing-cert.pem"))
    monkeypatch.setattr(config, "SSL_KEY_FILE", str(tmp_path / "missing-key.pem"))

    with pytest.raises(SystemExit) as exc:
        bridge_main.main()

    captured = capsys.readouterr()
    assert exc.value.code == 1
    assert "Traceback" not in captured.out
    assert "Traceback" not in captured.err


def _run_server_until_keyboard_interrupt(monkeypatch):
    from radicale import server as radicale_server

    def stop_server(_configuration):
        raise KeyboardInterrupt

    monkeypatch.setattr(bridge_main, "_initial_status_check", lambda: None)
    monkeypatch.setattr(bridge_main, "_start_sync_threads", lambda: None)
    monkeypatch.setattr(bridge_main, "start_tray", lambda: None)
    monkeypatch.setattr(radicale_server, "serve", stop_server)
    bridge_main.run_server()


def test_remote_bind_warning_mentions_plaintext_when_ssl_disabled(monkeypatch, caplog):
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "0.0.0.0")
    monkeypatch.setattr(config, "SERVER_HOSTS", "0.0.0.0:37358")
    monkeypatch.setattr(config, "ALLOW_REMOTE", True)
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    with caplog.at_level(logging.WARNING, logger="silentsuite-bridge"):
        _run_server_until_keyboard_interrupt(monkeypatch)

    text = caplog.text
    assert "DAV traffic is plaintext HTTP unless protected by your own proxy/VPN" in text
    assert "Bridge dashboard disabled while remote bind is configured" in text


def test_remote_bind_warning_avoids_plaintext_claim_when_ssl_enabled(monkeypatch, caplog, tmp_path):
    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    cert.write_text("fake cert")
    key.write_text("fake key")
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "0.0.0.0")
    monkeypatch.setattr(config, "SERVER_HOSTS", "0.0.0.0:37358")
    monkeypatch.setattr(config, "ALLOW_REMOTE", True)
    monkeypatch.setattr(config, "SSL_ENABLED", True)
    monkeypatch.setattr(config, "SSL_CERT_FILE", str(cert))
    monkeypatch.setattr(config, "SSL_KEY_FILE", str(key))

    with caplog.at_level(logging.WARNING, logger="silentsuite-bridge"):
        _run_server_until_keyboard_interrupt(monkeypatch)

    text = caplog.text
    assert "exposes decrypted DAV data over the network" in text
    assert "without an intentional network/security design" in text
    assert "plaintext HTTP" not in text
