"""Tests for bridge startup account decisions."""

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
