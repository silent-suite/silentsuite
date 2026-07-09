"""CLI tests for bridge account-management commands."""

import datetime as dt
import os
import shutil
import stat
import subprocess
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


def _openssl_available() -> bool:
    return shutil.which("openssl") is not None


@pytest.mark.skipif(not _openssl_available(), reason="openssl not available")
def test_generate_localhost_certificate_creates_san_cert(tmp_path):
    """Real OpenSSL generation: cert exists, has 398-day validity, and SANs."""
    cert_path = str(tmp_path / "localhost-cert.pem")
    key_path = str(tmp_path / "localhost-key.pem")

    main_module._generate_localhost_certificate(cert_path, key_path)

    assert os.path.isfile(cert_path)
    assert os.path.isfile(key_path)

    # Parse the cert for SAN entries and validity.
    result = subprocess.run(
        ["openssl", "x509", "-in", cert_path, "-noout", "-text"],
        capture_output=True, text=True, check=True,
    )
    text = result.stdout
    assert "Subject Alternative Name" in text
    assert "localhost" in text
    assert "127.0.0.1" in text
    # IPv6 ::1 may be present or fall back to DNS+IPv4; accept either.
    assert "::1" in text or "IPv6" not in text

    # Verify validity period <= 398 days.
    dates = subprocess.run(
        ["openssl", "x509", "-in", cert_path, "-noout", "-dates"],
        capture_output=True, text=True, check=True,
    ).stdout
    parsed = {}
    for line in dates.splitlines():
        key, value = line.split("=", 1)
        parsed[key] = dt.datetime.strptime(value, "%b %d %H:%M:%S %Y %Z")
    assert (parsed["notAfter"] - parsed["notBefore"]).days <= 398


@pytest.mark.skipif(not _openssl_available(), reason="openssl not available")
def test_generated_key_has_posix_0600_mode(tmp_path):
    """POSIX-only: generated private key is hardened to 0600 best-effort."""
    if os.name == "nt":
        pytest.skip("POSIX key-mode test only runs on non-Windows")
    cert_path = str(tmp_path / "localhost-cert.pem")
    key_path = str(tmp_path / "localhost-key.pem")

    main_module._generate_localhost_certificate(cert_path, key_path)

    mode = stat.S_IMODE(os.stat(key_path).st_mode)
    assert mode == 0o600


def test_setup_macos_apple_accounts_success_non_darwin(tmp_path, monkeypatch, capsys):
    """On non-Darwin, setup generates cert material but does not persist sslEnabled."""
    cert_path = str(tmp_path / "cert.pem")
    key_path = str(tmp_path / "key.pem")
    settings_path = tmp_path / "settings.json"
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "SETTINGS_FILE", str(settings_path))
    monkeypatch.setattr(config, "SSL_CERT_FILE", cert_path)
    monkeypatch.setattr(config, "SSL_KEY_FILE", key_path)
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(main_module, "_generate_localhost_certificate", lambda c, k: None)
    monkeypatch.setattr(main_module, "_cert_and_key_readable", lambda c, k: False)

    code = main_module.setup_macos_apple_accounts()

    out = capsys.readouterr().out
    assert code == 0
    assert cert_path in out
    assert key_path in out
    assert "Advanced" in out
    assert "Use SSL" in out
    assert "Keychain" in out or "Always Trust" in out
    assert "restart" in out.lower() or "Restart" in out
    # Non-Darwin must not silently persist sslEnabled=true.
    assert config.SSL_ENABLED is False
    assert not settings_path.exists()


def test_setup_macos_apple_accounts_failure_exits_nonzero(monkeypatch, capsys):
    """When cert generation fails, setup exits nonzero with actionable text."""
    monkeypatch.setattr(config, "SSL_CERT_FILE", "/tmp/x-cert.pem")
    monkeypatch.setattr(config, "SSL_KEY_FILE", "/tmp/x-key.pem")
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(
        main_module,
        "_generate_localhost_certificate",
        lambda c, k: (_ for _ in ()).throw(RuntimeError("openssl missing")),
    )
    monkeypatch.setattr(main_module, "_cert_and_key_readable", lambda c, k: False)

    code = main_module.setup_macos_apple_accounts()

    out = capsys.readouterr().out
    assert code == 1
    assert "openssl missing" in out
    assert "Traceback" not in out


def test_setup_macos_apple_accounts_persists_ssl_settings_on_darwin(tmp_path, monkeypatch):
    cert_path = str(tmp_path / "cert.pem")
    key_path = str(tmp_path / "key.pem")
    settings_path = tmp_path / "settings.json"
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "SETTINGS_FILE", str(settings_path))
    monkeypatch.setattr(config, "SSL_CERT_FILE", cert_path)
    monkeypatch.setattr(config, "SSL_KEY_FILE", key_path)
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(main_module, "_open_certificate_for_trust", lambda c: True)

    def fake_gen(c, k):
        with open(c, "w") as f:
            f.write("new cert")
        with open(k, "w") as f:
            f.write("new key")

    monkeypatch.setattr(main_module, "_generate_localhost_certificate", fake_gen)

    code = main_module.setup_macos_apple_accounts()

    settings = config.get_settings()
    assert code == 0
    assert config.SSL_ENABLED is True
    assert settings["sslEnabled"] is True
    assert settings["sslCertFile"] == cert_path
    assert settings["sslKeyFile"] == key_path


def test_setup_reuses_existing_cert_and_key(tmp_path, monkeypatch, capsys):
    """When both cert and key are readable, setup reuses them without regenerating."""
    cert_path = str(tmp_path / "cert.pem")
    key_path = str(tmp_path / "key.pem")
    with open(cert_path, "w") as f:
        f.write("existing cert")
    with open(key_path, "w") as f:
        f.write("existing key")
    monkeypatch.setattr(config, "SSL_CERT_FILE", cert_path)
    monkeypatch.setattr(config, "SSL_KEY_FILE", key_path)
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(main_module, "_cert_and_key_match", lambda c, k: True)

    def fail_gen(c, k):
        raise AssertionError("should not regenerate when both files are readable")

    monkeypatch.setattr(main_module, "_generate_localhost_certificate", fail_gen)

    code = main_module.setup_macos_apple_accounts()

    out = capsys.readouterr().out
    assert code == 0
    assert "Reused" in out


def test_setup_regenerates_when_one_file_missing(tmp_path, monkeypatch):
    """When one of cert/key is missing, setup regenerates both together."""
    cert_path = str(tmp_path / "cert.pem")
    key_path = str(tmp_path / "key.pem")
    with open(cert_path, "w") as f:
        f.write("stale cert")
    # key missing
    monkeypatch.setattr(config, "SSL_CERT_FILE", cert_path)
    monkeypatch.setattr(config, "SSL_KEY_FILE", key_path)
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(sys, "platform", "linux")

    generated = {"called": False}

    def fake_gen(c, k):
        generated["called"] = True
        with open(c, "w") as f:
            f.write("new cert")
        with open(k, "w") as f:
            f.write("new key")

    monkeypatch.setattr(main_module, "_generate_localhost_certificate", fake_gen)

    main_module.setup_macos_apple_accounts()

    assert generated["called"] is True


def test_setup_regenerates_when_existing_cert_and_key_do_not_match(tmp_path, monkeypatch):
    cert_path = str(tmp_path / "cert.pem")
    key_path = str(tmp_path / "key.pem")
    with open(cert_path, "w") as f:
        f.write("stale cert")
    with open(key_path, "w") as f:
        f.write("stale key")
    monkeypatch.setattr(config, "SSL_CERT_FILE", cert_path)
    monkeypatch.setattr(config, "SSL_KEY_FILE", key_path)
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(main_module, "_cert_and_key_match", lambda c, k: False)

    generated = {"called": False}

    def fake_gen(c, k):
        generated["called"] = True
        with open(c, "w") as f:
            f.write("new cert")
        with open(k, "w") as f:
            f.write("new key")

    monkeypatch.setattr(main_module, "_generate_localhost_certificate", fake_gen)

    main_module.setup_macos_apple_accounts()

    assert generated["called"] is True


def test_setup_command_dispatched_via_run_main(monkeypatch, capsys):
    """`--setup-macos-apple-accounts` is dispatched by main() and exits 0."""
    monkeypatch.setattr(config, "SSL_CERT_FILE", "/tmp/x-cert.pem")
    monkeypatch.setattr(config, "SSL_KEY_FILE", "/tmp/x-key.pem")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:37358")
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(main_module, "_generate_localhost_certificate", lambda c, k: None)
    monkeypatch.setattr(main_module, "_cert_and_key_readable", lambda c, k: False)

    code = _run_main(["--setup-macos-apple-accounts"], monkeypatch)

    assert code == 0
    assert "Advanced" in capsys.readouterr().out
