"""Tests for bridge startup account decisions."""

import logging
import sys
import threading
from contextlib import contextmanager
from importlib.metadata import version
from unittest.mock import MagicMock

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config, privacy_logging
from silentsuite_bridge.radicale.application import Application as BridgeApplication


def test_startup_does_not_delete_cache_for_logged_out_accounts(monkeypatch):
    from silentsuite_bridge import local_cache, web
    from silentsuite_bridge.radicale import creds, storage

    credentials = MagicMock()
    credentials.list_users.return_value = []
    monkeypatch.setattr(creds, "Credentials", lambda: credentials)
    monkeypatch.setattr(
        local_cache,
        "clear_unconfigured_cached_users",
        MagicMock(side_effect=AssertionError("startup must retain logged-out cache")),
    )
    monkeypatch.setattr(storage, "start_sync_thread", MagicMock())
    monkeypatch.setattr(web, "update_status", MagicMock())

    bridge_main._start_sync_threads()


def test_initial_status_check_reports_partial_account_failure(monkeypatch):
    from silentsuite_bridge import web
    from silentsuite_bridge.radicale import creds, etesync_cache

    credentials = MagicMock()
    credentials.list_users.return_value = ["good@example.com", "bad@example.com"]
    monkeypatch.setattr(creds, "Credentials", lambda: credentials)

    @contextmanager
    def account_session(user):
        if user == "bad@example.com":
            raise RuntimeError("failed")
        etesync = MagicMock()
        etesync.list.return_value = []
        yield etesync, False

    monkeypatch.setattr(etesync_cache, "etesync_for_user", account_session)
    update_status = MagicMock()
    monkeypatch.setattr(web, "update_status", update_status)
    monkeypatch.setattr(web, "log_sync_event", MagicMock())

    bridge_main._initial_status_check()

    assert any(
        call.args == ("error",)
        and call.kwargs.get("scope") == "all configured accounts"
        and "1 account" in call.kwargs.get("error", "")
        for call in update_status.call_args_list
    )


def test_radicale_runtime_is_pinned_to_the_server_adapter_contract():
    assert version("Radicale") == "3.2.3"


def test_debug_logging_does_not_enable_peewee_bound_parameter_diagnostics(monkeypatch):
    """SQL DEBUG records include usernames, sync tokens, and other bound values."""
    peewee_logger = logging.getLogger("peewee")
    monkeypatch.setattr(config, "LOG_LEVEL", "DEBUG")
    monkeypatch.setattr(config, "LOG_FILE", None)
    monkeypatch.setattr(logging, "basicConfig", MagicMock())
    monkeypatch.setattr(peewee_logger, "level", logging.DEBUG)

    bridge_main.configure_logging()

    assert peewee_logger.level >= logging.WARNING


def test_bounded_failure_logging_drops_exception_text_and_traceback(caplog):
    private_value = "private.person@example.invalid"
    logger = logging.getLogger("silentsuite-bridge.test-bounded-failure")

    with caplog.at_level(logging.ERROR, logger=logger.name):
        try:
            raise RuntimeError(private_value)
        except RuntimeError as error:
            privacy_logging.log_bounded_failure(
                logger,
                logging.ERROR,
                "Bridge operation failed",
                error,
            )

    assert caplog.messages == ["Bridge operation failed (RuntimeError)"]
    assert private_value not in caplog.text


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


def test_headless_zero_account_startup_resumes_cleanup_before_exit(monkeypatch):
    from silentsuite_bridge import accounts

    calls = []
    monkeypatch.setattr(
        accounts,
        "resume_pending_cache_cleanups",
        lambda: calls.append("resume"),
    )
    monkeypatch.setattr(
        bridge_main,
        "check_credentials",
        lambda open_browser=True: calls.append("check") or False,
    )

    assert bridge_main._prepare_server_start(open_browser=False) is False
    assert calls == ["resume", "check"]


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


@pytest.mark.parametrize("outcome", [None, RuntimeError("boom"), KeyboardInterrupt()])
def test_server_application_injection_restores_upstream_application(monkeypatch, outcome):
    from radicale import server as radicale_server
    from radicale.app import Application as RadicaleApplication

    def serve(_configuration):
        assert radicale_server.Application is BridgeApplication
        if outcome is not None:
            raise outcome

    monkeypatch.setattr(radicale_server, "serve", serve)
    if isinstance(outcome, BaseException):
        with pytest.raises(type(outcome)):
            bridge_main._serve_radicale_with_bridge_application(object())
    else:
        bridge_main._serve_radicale_with_bridge_application(object())
    assert radicale_server.Application is RadicaleApplication


def test_server_application_injection_rejects_nested_entry(monkeypatch):
    from radicale import server as radicale_server

    def serve(_configuration):
        with pytest.raises(RuntimeError, match="already active"):
            bridge_main._serve_radicale_with_bridge_application(object())

    monkeypatch.setattr(radicale_server, "serve", serve)
    bridge_main._serve_radicale_with_bridge_application(object())


def test_server_application_injection_rejects_real_two_thread_contention(monkeypatch):
    from radicale import server as radicale_server
    from radicale.app import Application as RadicaleApplication

    entered_serve = threading.Event()
    release_serve = threading.Event()
    serve_barrier = threading.Barrier(2)
    holder_errors = []

    def serve(_configuration):
        assert radicale_server.Application is BridgeApplication
        entered_serve.set()
        serve_barrier.wait()
        assert release_serve.wait(timeout=5)

    def hold_server():
        try:
            bridge_main._serve_radicale_with_bridge_application(object())
        except BaseException as exc:  # pragma: no cover - asserted from the parent thread
            holder_errors.append(exc)

    monkeypatch.setattr(radicale_server, "serve", serve)
    holder = threading.Thread(target=hold_server)
    holder.start()
    assert entered_serve.wait(timeout=5)
    serve_barrier.wait()

    try:
        with pytest.raises(RuntimeError, match="already active"):
            bridge_main._serve_radicale_with_bridge_application(object())
    finally:
        release_serve.set()

    holder.join(timeout=5)
    assert not holder.is_alive()
    assert holder_errors == []
    assert radicale_server.Application is RadicaleApplication

    serve_after_release = MagicMock()
    monkeypatch.setattr(radicale_server, "serve", serve_after_release)
    bridge_main._serve_radicale_with_bridge_application(object())
    serve_after_release.assert_called_once()
    assert radicale_server.Application is RadicaleApplication


def test_server_application_injection_rejects_unexpected_entry_state(monkeypatch):
    from radicale import server as radicale_server

    unexpected = object()
    monkeypatch.setattr(radicale_server, "Application", unexpected)
    with pytest.raises(RuntimeError, match="Unexpected Radicale"):
        bridge_main._serve_radicale_with_bridge_application(object())
    assert radicale_server.Application is unexpected


def test_server_application_injection_does_not_overwrite_third_party_replacement(monkeypatch):
    from radicale import server as radicale_server

    replacement = object()
    monkeypatch.setattr(radicale_server, "Application", radicale_server.Application)

    def serve(_configuration):
        radicale_server.Application = replacement

    monkeypatch.setattr(radicale_server, "serve", serve)
    bridge_main._serve_radicale_with_bridge_application(object())
    assert radicale_server.Application is replacement


def test_real_radicale_serve_constructs_bridge_application_before_no_bind_error(monkeypatch):
    from radicale import server as radicale_server

    from silentsuite_bridge.radicale import application as bridge_application

    constructed = MagicMock()

    class SpyApplication(BridgeApplication):
        def __init__(self, *args, **kwargs):
            constructed(*args, **kwargs)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(bridge_application, "Application", SpyApplication)
    monkeypatch.setattr(radicale_server.socket, "getaddrinfo", lambda *_args: [])
    configuration = bridge_main.build_radicale_configuration()

    with pytest.raises(RuntimeError, match="No servers started"):
        bridge_main._serve_radicale_with_bridge_application(configuration)

    constructed.assert_called_once()


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
