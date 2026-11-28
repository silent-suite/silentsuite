"""A port that is taken or not allowed gets a plain explanation, not a crash."""

import errno
import logging
import socket

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config
from silentsuite_bridge.radicale.server import get_registry


def _use_port(monkeypatch, port):
    hosts = f"127.0.0.1:{port}"
    monkeypatch.setattr(config, "LISTEN_PORT", port)
    monkeypatch.setattr(config, "DEFAULT_SERVER_HOSTS", hosts)
    monkeypatch.setattr(config, "SERVER_HOSTS", hosts)
    monkeypatch.setattr(config, "ALLOW_REMOTE", False)
    monkeypatch.setattr(config, "SSL_ENABLED", False)


def _stub_startup(monkeypatch):
    monkeypatch.setattr(bridge_main, "_start_sync_threads", lambda: None)
    monkeypatch.setattr(bridge_main, "start_tray", lambda: None)


def _failed_registry(*failures):
    registry = get_registry()
    registry.reset()
    for code, port in failures:
        registry.record_failed(OSError(code, "bind failed"), port)
    return registry


def test_port_in_use_explains_and_exits_without_traceback(monkeypatch, capsys, caplog):
    blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    port = blocker.getsockname()[1]
    try:
        _use_port(monkeypatch, port)
        _stub_startup(monkeypatch)
        monkeypatch.setattr(bridge_main, "address_detail_enabled", lambda: True)

        with caplog.at_level(logging.ERROR, logger="silentsuite-bridge"):
            with pytest.raises(SystemExit) as exc:
                bridge_main.run_server()
    finally:
        blocker.close()

    out, err = capsys.readouterr()
    assert exc.value.code == 1
    assert f"The bridge could not start: port {port} is already in use." in out
    assert "Another bridge may already be running" in out
    assert "systemctl --user status silentsuite-bridge" in out
    assert "SILENTSUITE_LISTEN_PORT" in out
    assert "Traceback" not in out + err
    assert "Bridge crashed" not in caplog.text
    assert "Bridge could not start: listening port already in use" in caplog.text


def test_permission_denied_explains_privileged_port(monkeypatch, capsys):
    _use_port(monkeypatch, 80)
    monkeypatch.setattr(bridge_main, "address_detail_enabled", lambda: True)
    registry = _failed_registry((errno.EACCES, 80))

    reason = bridge_main._explain_bind_failure(registry)

    out = capsys.readouterr().out
    assert reason == "not allowed to use the listening port"
    assert "The bridge could not start: it is not allowed to use port 80." in out
    assert "Ports below 1024 need extra permission" in out
    assert "SILENTSUITE_LISTEN_PORT=37358" in out
    assert "systemctl" not in out


def test_windows_in_use_code_is_recognised(monkeypatch, capsys):
    _use_port(monkeypatch, config.DEFAULT_LISTEN_PORT)
    monkeypatch.setattr(bridge_main, "address_detail_enabled", lambda: True)
    registry = _failed_registry((10048, config.DEFAULT_LISTEN_PORT))

    assert bridge_main._explain_bind_failure(registry) == "listening port already in use"
    out = capsys.readouterr().out
    assert "port 37358 is already in use" in out
    assert "SILENTSUITE_LISTEN_PORT=37359" in out


def test_port_is_withheld_on_a_non_interactive_channel(monkeypatch, capsys):
    _use_port(monkeypatch, 45123)
    monkeypatch.setattr(bridge_main, "address_detail_enabled", lambda: False)
    registry = _failed_registry((errno.EADDRINUSE, 45123))

    bridge_main._explain_bind_failure(registry)

    out = capsys.readouterr().out
    assert "The bridge could not start: its port is already in use." in out
    assert "45123" not in out


def test_custom_server_hosts_points_to_that_setting(monkeypatch, capsys):
    _use_port(monkeypatch, 45123)
    monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:45123,[::1]:45123")
    monkeypatch.setattr(bridge_main, "address_detail_enabled", lambda: True)
    registry = _failed_registry((errno.EADDRINUSE, 45123))

    bridge_main._explain_bind_failure(registry)

    out = capsys.readouterr().out
    assert "change it in SILENTSUITE_SERVER_HOSTS" in out
    assert "SILENTSUITE_LISTEN_PORT" not in out


def test_other_failures_keep_the_crash_report(monkeypatch, capsys, caplog):
    _use_port(monkeypatch, 45123)
    _stub_startup(monkeypatch)
    _failed_registry((errno.ENOENT, 45123))

    def fail_serve(_configuration, shutdown_socket=None):
        raise RuntimeError("No servers started")

    monkeypatch.setattr(bridge_main, "_serve_radicale_with_bridge_application", fail_serve)

    with caplog.at_level(logging.ERROR, logger="silentsuite-bridge"):
        with pytest.raises(SystemExit) as exc:
            bridge_main.run_server()

    assert exc.value.code == 1
    assert "Bridge crashed (RuntimeError)" in caplog.text
    assert "could not start" not in capsys.readouterr().out


def test_no_explanation_when_another_listener_bound(monkeypatch, capsys):
    _use_port(monkeypatch, 45123)
    registry = _failed_registry((errno.EADDRINUSE, 45123))
    registry.record_bound(("127.0.0.1", 45124), socket.AF_INET, ssl=False)

    assert bridge_main._explain_bind_failure(registry) is None
    assert capsys.readouterr().out == ""
