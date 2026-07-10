"""Tests for scheme-aware manual bridge login output."""

from types import SimpleNamespace

from silentsuite_bridge import auth_cli, config


def test_manual_login_prints_https_ipv6_dav_url(monkeypatch, capsys):
    etebase = SimpleNamespace(save=lambda _unused: "stored-session")
    monkeypatch.setattr(config, "ensure_data_dir", lambda: None)
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "::1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", True)
    monkeypatch.setattr("builtins.input", lambda _prompt: "alice@example.com")
    monkeypatch.setattr(auth_cli.getpass, "getpass", lambda _prompt: "secret")
    monkeypatch.setattr(auth_cli, "Client", lambda *_args: object())
    monkeypatch.setattr(auth_cli.Account, "login", lambda *_args: etebase)
    monkeypatch.setattr(
        auth_cli,
        "store_authenticated_account",
        lambda *_args: SimpleNamespace(username="alice@example.com"),
    )

    auth_cli.manual_login()

    output = capsys.readouterr().out
    assert "CalDAV/CardDAV URL: https://[::1]:37358/alice@example.com/" in output
    assert "http://::1" not in output
