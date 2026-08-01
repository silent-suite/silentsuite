"""Tests for privacy-safe manual bridge login output."""

from types import SimpleNamespace

import pytest

from silentsuite_bridge import auth_cli, config


def test_manual_login_does_not_print_account_or_server_values(monkeypatch, capsys):
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
    assert "CalDAV/CardDAV account configured." in output
    assert "alice@example.com" not in output
    assert "stored-session" not in output


def test_manual_login_does_not_print_provider_exception(monkeypatch, capsys):
    private_value = "https://user:token@example.invalid/private/person"
    monkeypatch.setattr(config, "ensure_data_dir", lambda: None)
    monkeypatch.setattr(config, "ETEBASE_SERVER_URL", private_value)
    monkeypatch.setattr("builtins.input", lambda _prompt: "alice@example.com")
    monkeypatch.setattr(auth_cli.getpass, "getpass", lambda _prompt: "secret")
    monkeypatch.setattr(auth_cli, "Client", lambda *_args: object())
    monkeypatch.setattr(
        auth_cli.Account,
        "login",
        lambda *_args: (_ for _ in ()).throw(RuntimeError(private_value)),
    )

    try:
        auth_cli.manual_login()
    except SystemExit as error:
        assert error.code == 1

    output = capsys.readouterr().out
    assert "Error: Authentication failed." in output
    assert private_value not in output
    assert "alice@example.com" not in output


def test_manual_login_does_not_print_persistence_exception(monkeypatch, capsys):
    private_value = "/private/person/credentials.json?token=secret"
    etebase = SimpleNamespace(save=lambda _unused: "stored-session")
    monkeypatch.setattr(config, "ensure_data_dir", lambda: None)
    monkeypatch.setattr("builtins.input", lambda _prompt: "alice@example.com")
    monkeypatch.setattr(auth_cli.getpass, "getpass", lambda _prompt: "secret")
    monkeypatch.setattr(auth_cli, "Client", lambda *_args: object())
    monkeypatch.setattr(auth_cli.Account, "login", lambda *_args: etebase)
    monkeypatch.setattr(
        auth_cli,
        "store_authenticated_account",
        lambda *_args: (_ for _ in ()).throw(RuntimeError(private_value)),
    )

    with pytest.raises(SystemExit) as raised:
        auth_cli.manual_login()

    output = capsys.readouterr()
    assert raised.value.code == 1
    assert "Error: Could not save the authenticated account." in output.out
    assert private_value not in output.out
    assert private_value not in output.err
    assert "alice@example.com" not in output.out
