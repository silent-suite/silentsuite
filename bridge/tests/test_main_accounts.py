"""CLI tests for bridge account-management commands."""

import sys

import pytest

from silentsuite_bridge import __main__ as main_module
from silentsuite_bridge import accounts, config


def _run_main(argv, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", *argv])
    monkeypatch.setattr(main_module, "configure_logging", lambda: None)
    monkeypatch.setattr(config, "ensure_data_dir", lambda: None)
    with pytest.raises(SystemExit) as exc:
        main_module.main()
    return exc.value.code


def test_list_accounts_prints_all_accounts(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    accounts.store_authenticated_account(
        "alice@example.com", "password", "alice-session", "https://server-a.test",
    )
    accounts.store_authenticated_account(
        "bob@example.com", "password", "bob-session", "https://server-b.test",
    )

    code = _run_main(["--list-accounts"], monkeypatch)

    out = capsys.readouterr().out
    assert code == 0
    assert "alice@example.com (https://server-a.test)" in out
    assert "bob@example.com (https://server-b.test)" in out


def test_logout_requires_account_argument(monkeypatch, capsys):
    code = _run_main(["--logout"], monkeypatch)

    assert code == 1
    assert "--logout requires an account argument" in capsys.readouterr().out


def test_account_actions_cannot_be_combined(monkeypatch, capsys):
    code = _run_main(["--list-accounts", "--logout", "alice@example.com"], monkeypatch)

    assert code == 1
    assert "account action flags cannot be combined" in capsys.readouterr().out
