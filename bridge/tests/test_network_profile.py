"""Regression tests for the durable network profile (#658).

The listener profile must survive a clean-environment autostart restart while
staying closed-world: only explicitly configured values are persisted, the
environment keeps precedence, remote binds still need explicit permission, and
an invalid persisted profile fails closed without leaking supplied values.
"""

import json
import sys

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config

NETWORK_ENV = tuple(config.NETWORK_PROFILE_ENV.values())
OTHER_ENV = (
    "SILENTSUITE_DATA_DIR",
    "SILENTSUITE_BRIDGE_SSL",
    "SILENTSUITE_SSL",
    "SILENTSUITE_BRIDGE_SSL_CERT",
    "SILENTSUITE_SSL_CERT",
    "SILENTSUITE_BRIDGE_SSL_KEY",
    "SILENTSUITE_SSL_KEY",
)
RESOLVED_GLOBALS = (
    "LISTEN_ADDRESS",
    "LISTEN_PORT",
    "DEFAULT_SERVER_HOSTS",
    "SERVER_HOSTS",
    "ALLOW_REMOTE",
    "NETWORK_PROFILE_ERROR",
    "SSL_ENABLED",
    "SSL_CERT_FILE",
    "SSL_KEY_FILE",
    "SYNC_INTERVAL",
)
UNRELATED_SETTINGS = {"syncInterval": 120, "customKey": "keep-me"}


@pytest.fixture
def settings_file(tmp_path, monkeypatch):
    """Point config at an isolated settings.json with a clean network environment."""
    for variable in NETWORK_ENV + OTHER_ENV:
        monkeypatch.delenv(variable, raising=False)
    for name in RESOLVED_GLOBALS:
        monkeypatch.setattr(config, name, getattr(config, name))
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    path = tmp_path / "settings.json"
    monkeypatch.setattr(config, "SETTINGS_FILE", str(path))
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    config.load_settings()
    return path


def write_settings(path, payload):
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_settings(path):
    return json.loads(path.read_text(encoding="utf-8"))


def reload_with_env(monkeypatch, **env):
    for variable, value in env.items():
        monkeypatch.setenv(variable, value)
    config.load_settings()


def radicale_hosts(configuration):
    """Normalize Radicale's server.hosts (parsed tuples or raw string) to [[host, port], ...]."""
    hosts = configuration.get("server", "hosts")
    if isinstance(hosts, str):
        return [list(config._split_host_spec(spec.strip(), "hosts")) for spec in hosts.split(",")]
    return [[host, int(port)] for host, port in hosts]


def _string_values(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from _string_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from _string_values(item)
    elif isinstance(value, str):
        yield value
    else:
        yield json.dumps(value)


# --- Consumption and precedence -------------------------------------------


def test_persisted_profile_is_consumed_without_environment(settings_file):
    write_settings(settings_file, {"network": {"listenAddress": "::1", "listenPort": 45123}})

    config.load_settings()

    assert config.NETWORK_PROFILE_ERROR is None
    assert config.LISTEN_ADDRESS == "::1"
    assert config.LISTEN_PORT == 45123
    assert config.SERVER_HOSTS == "[::1]:45123"
    config.validate_network_config()
    assert config.is_dashboard_enabled() is True
    radicale = bridge_main.build_radicale_configuration()
    assert radicale_hosts(radicale) == [["::1", 45123]]
    assert radicale.get("web", "type") == "silentsuite_bridge.web"


def test_environment_overrides_persisted_profile_and_defaults_derive_from_both(settings_file, monkeypatch):
    write_settings(settings_file, {"network": {"listenAddress": "::1", "listenPort": 45123}})

    reload_with_env(monkeypatch, SILENTSUITE_LISTEN_PORT="45999")

    assert config.LISTEN_ADDRESS == "::1"
    assert config.LISTEN_PORT == 45999
    assert config.DEFAULT_SERVER_HOSTS == "[::1]:45999"
    assert config.SERVER_HOSTS == "[::1]:45999"


def test_persisted_server_hosts_apply_unless_environment_overrides(settings_file, monkeypatch):
    write_settings(settings_file, {"network": {"serverHosts": "localhost:45123,127.0.0.2:45124"}})

    config.load_settings()
    assert config.SERVER_HOSTS == "localhost:45123,127.0.0.2:45124"
    config.validate_network_config()

    reload_with_env(monkeypatch, SILENTSUITE_SERVER_HOSTS="127.0.0.1:45125")
    assert config.SERVER_HOSTS == "127.0.0.1:45125"


def test_persisted_allow_remote_is_overridden_by_explicit_environment_denial(settings_file, monkeypatch):
    write_settings(settings_file, {"network": {"listenAddress": "0.0.0.0", "allowRemote": True}})

    config.load_settings()
    assert config.ALLOW_REMOTE is True
    config.validate_network_config()

    reload_with_env(monkeypatch, SILENTSUITE_ALLOW_REMOTE="0")
    assert config.ALLOW_REMOTE is False
    with pytest.raises(RuntimeError, match="SILENTSUITE_ALLOW_REMOTE=1"):
        config.validate_network_config()


# --- Fresh installation: no default pinning --------------------------------


def test_fresh_install_without_environment_persists_nothing(settings_file):
    assert config.explicit_network_profile_from_env() == {}
    assert config.network_profile_for_autostart() == {}
    assert config.save_network_profile({}) is False
    assert not settings_file.exists()
    assert config.LISTEN_ADDRESS == config.DEFAULT_LISTEN_ADDRESS == "127.0.0.1"
    assert config.LISTEN_PORT == config.DEFAULT_LISTEN_PORT == 37358


def test_fresh_install_keeps_unrelated_settings_and_adds_no_network_key(settings_file):
    write_settings(settings_file, dict(UNRELATED_SETTINGS))
    config.load_settings()

    assert config.network_profile_for_autostart() == {}
    assert config.save_network_profile({}) is False
    assert read_settings(settings_file) == UNRELATED_SETTINGS


# --- Remote permission -----------------------------------------------------


def test_persisted_remote_bind_without_permission_fails_closed(settings_file):
    write_settings(settings_file, {"network": {"listenAddress": "0.0.0.0"}})

    config.load_settings()

    with pytest.raises(RuntimeError, match="SILENTSUITE_ALLOW_REMOTE=1") as excinfo:
        config.validate_network_config()
    assert "0.0.0.0" not in str(excinfo.value)
    with pytest.raises(RuntimeError):
        bridge_main.build_radicale_configuration()


def test_persisted_remote_bind_with_permission_disables_dashboard(settings_file):
    write_settings(settings_file, {"network": {"listenAddress": "0.0.0.0", "allowRemote": True}})

    config.load_settings()
    config.validate_network_config()

    assert config.is_remote_bind_configured() is True
    assert config.is_dashboard_enabled() is False
    assert bridge_main.build_radicale_configuration().get("web", "type") == "none"


def test_restart_profile_requires_persisted_permission_for_remote_bind():
    with pytest.raises(config.NetworkProfileError, match="without allowRemote permission") as excinfo:
        config.validate_restart_profile({"listenAddress": "203.0.113.7"})
    assert "203.0.113.7" not in str(excinfo.value)

    with pytest.raises(config.NetworkProfileError):
        config.validate_restart_profile({"serverHosts": "203.0.113.7:45123"})

    assert config.validate_restart_profile({"listenAddress": "203.0.113.7", "allowRemote": True}) == {
        "listenAddress": "203.0.113.7",
        "allowRemote": True,
    }


def test_remote_bind_environment_without_permission_fails_before_profile_write(settings_file, monkeypatch):
    reload_with_env(monkeypatch, SILENTSUITE_LISTEN_ADDRESS="203.0.113.7")

    with pytest.raises(RuntimeError, match="SILENTSUITE_ALLOW_REMOTE=1") as excinfo:
        config.network_profile_for_autostart()

    assert "203.0.113.7" not in str(excinfo.value)
    assert not settings_file.exists()


def test_remote_bind_reasons_name_settings_not_values(settings_file, monkeypatch):
    reload_with_env(
        monkeypatch,
        SILENTSUITE_LISTEN_ADDRESS="203.0.113.7",
        SILENTSUITE_SERVER_HOSTS="private-host.example.invalid:5232",
    )

    reasons = config.remote_bind_reasons()

    assert len(reasons) == 2
    assert any("SILENTSUITE_LISTEN_ADDRESS" in reason for reason in reasons)
    assert any("SILENTSUITE_SERVER_HOSTS" in reason for reason in reasons)
    joined = " ".join(reasons)
    assert "203.0.113.7" not in joined
    assert "private-host.example.invalid" not in joined


def test_remote_permission_is_persisted_with_the_bind(settings_file, monkeypatch):
    reload_with_env(monkeypatch, SILENTSUITE_LISTEN_ADDRESS="0.0.0.0", SILENTSUITE_ALLOW_REMOTE="1")

    profile = config.network_profile_for_autostart()

    assert profile == {"listenAddress": "0.0.0.0", "allowRemote": True}
    assert config.save_network_profile(profile) is True
    for variable in NETWORK_ENV:
        monkeypatch.delenv(variable, raising=False)
    config.load_settings()
    config.validate_network_config()
    assert config.ALLOW_REMOTE is True
    assert config.is_dashboard_enabled() is False


# --- Allowlist / no secrets -----------------------------------------------


def test_install_profile_persists_only_allowlisted_network_values(settings_file, monkeypatch):
    # Every decoy carries a unique secret token so leakage is detected by the
    # token, never by a digit or short flag value that legitimately occurs in
    # the persisted port (for example "1" inside 45123).
    decoys = {
        "SILENTSUITE_SERVER_URL": "https://user:tok-c3f1e9-svr@example.invalid/tok-c3f1e9-path",
        "SILENTSUITE_LOG_FILE": "/home/person/tok-c3f1e9-log/bridge.log",
        "SILENTSUITE_LOG_LEVEL": "DEBUG",
        "SILENTSUITE_DATABASE_FILE": "/home/person/tok-c3f1e9-db/bridge_data.db",
        "SILENTSUITE_BRIDGE_SSL_KEY": "/home/person/tok-c3f1e9-key/localhost-key.pem",
        "SILENTSUITE_BRIDGE_SSL": "1",
        "SILENTSUITE_SYNC_INTERVAL": "60",
        "SILENTSUITE_DASHBOARD_DUMP": "1",
        "SILENTSUITE_PRIVATE_ACCOUNT": "tok-c3f1e9-acct@example.invalid",
    }
    reload_with_env(
        monkeypatch,
        SILENTSUITE_LISTEN_ADDRESS="127.0.0.1",
        SILENTSUITE_LISTEN_PORT="45123",
        SILENTSUITE_ALLOW_REMOTE="0",
        **decoys,
    )

    profile = config.network_profile_for_autostart()
    assert profile == {"listenAddress": "127.0.0.1", "listenPort": 45123, "allowRemote": False}
    assert config.save_network_profile(profile) is True

    # Structured, exact: the file holds the allowlisted payload and nothing else.
    stored = read_settings(settings_file)
    assert stored == {"network": profile}
    assert set(stored["network"]) == {"listenAddress", "listenPort", "allowRemote"}
    for key in ("sslEnabled", "sslKeyFile", "syncInterval", "logFile", "serverUrl"):
        assert key not in stored
    text = settings_file.read_text(encoding="utf-8")
    assert "tok-c3f1e9" not in text
    assert "example.invalid" not in text
    for variable in decoys:
        assert variable not in text


def test_explicit_env_profile_never_defaults_absent_variables(settings_file, monkeypatch):
    reload_with_env(monkeypatch, SILENTSUITE_LISTEN_PORT="45123")

    assert config.explicit_network_profile_from_env() == {"listenPort": 45123}


# --- Invalid persisted profiles fail closed -------------------------------


INVALID_PROFILES = [
    pytest.param([], "must be a JSON object", id="not-an-object"),
    pytest.param("127.0.0.1:37358", "must be a JSON object", id="string"),
    pytest.param({"listenPort": "45123"}, "listenPort", id="port-string"),
    pytest.param({"listenPort": 70000}, "listenPort", id="port-range"),
    pytest.param({"listenPort": 0}, "listenPort", id="port-zero"),
    pytest.param({"listenPort": True}, "listenPort", id="port-bool"),
    pytest.param({"listenPort": 45123.0}, "listenPort", id="port-float"),
    pytest.param({"listenAddress": "127.0.0.1 --private-flag"}, "listenAddress", id="address-injection"),
    pytest.param({"listenAddress": ""}, "listenAddress", id="address-empty"),
    pytest.param({"listenAddress": 127}, "listenAddress", id="address-type"),
    pytest.param({"listenAddress": "*"}, "listenAddress", id="address-wildcard"),
    pytest.param({"serverHosts": "127.0.0.1"}, "serverHosts", id="hosts-missing-port"),
    pytest.param({"serverHosts": "[::1"}, "serverHosts", id="hosts-malformed-bracket"),
    pytest.param({"serverHosts": "127.0.0.1:0"}, "serverHosts", id="hosts-port-range"),
    pytest.param({"serverHosts": "127.0.0.1:45123,"}, "serverHosts", id="hosts-trailing-comma"),
    pytest.param({"serverHosts": ["127.0.0.1:45123"]}, "serverHosts", id="hosts-type"),
    pytest.param({"serverHosts": "bad host:45123"}, "serverHosts", id="hosts-invalid-host"),
    pytest.param({"allowRemote": "yes"}, "allowRemote", id="allow-remote-string"),
    pytest.param({"allowRemote": 1}, "allowRemote", id="allow-remote-int"),
    pytest.param({"logFile": "/private/person/secret.log"}, "unsupported key", id="unknown-key"),
    pytest.param(
        {"listenAddress": "127.0.0.1", "sessionToken": "private-token-value"},
        "unsupported key",
        id="unknown-key-with-valid-sibling",
    ),
    pytest.param({"listenaddress": "0.0.0.0"}, "unsupported key", id="unknown-key-case"),
]


@pytest.mark.parametrize(("profile", "expected"), INVALID_PROFILES)
def test_invalid_persisted_profile_fails_closed_without_leaking_values(settings_file, profile, expected):
    payload = dict(UNRELATED_SETTINGS)
    payload["network"] = profile
    write_settings(settings_file, payload)
    original_text = settings_file.read_text(encoding="utf-8")

    config.load_settings()

    assert config.NETWORK_PROFILE_ERROR is not None
    assert config.LISTEN_ADDRESS == "127.0.0.1"
    assert config.LISTEN_PORT == 37358
    assert config.SERVER_HOSTS == "127.0.0.1:37358"
    assert config.ALLOW_REMOTE is False
    assert config.SYNC_INTERVAL == 120

    with pytest.raises(config.NetworkProfileError, match=expected) as excinfo:
        config.validate_network_config()
    message = str(excinfo.value)
    for supplied in _string_values(profile):
        if supplied and supplied not in config.NETWORK_PROFILE_ENV:
            assert supplied not in message
    assert "private" not in message
    assert "token" not in message
    assert "secret" not in message

    with pytest.raises(config.NetworkProfileError):
        config.network_profile_for_autostart()
    with pytest.raises(RuntimeError):
        bridge_main.build_radicale_configuration()
    assert settings_file.read_text(encoding="utf-8") == original_text


def test_invalid_persisted_profile_exits_startup_cleanly_before_data_dir_writes(settings_file, monkeypatch, capsys):
    write_settings(settings_file, {"network": {"sessionToken": "private-token-value"}})
    config.load_settings()
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge"])
    monkeypatch.setattr(bridge_main, "configure_logging", lambda: None)
    monkeypatch.setattr(config, "ensure_data_dir", lambda: pytest.fail("must not touch the data dir"))

    with pytest.raises(SystemExit) as excinfo:
        bridge_main.main()

    captured = capsys.readouterr()
    assert excinfo.value.code == 1
    assert "Traceback" not in captured.err
    assert "unsupported key" in captured.err
    assert "private-token-value" not in captured.out + captured.err
    assert "sessionToken" not in captured.out + captured.err


@pytest.mark.parametrize("digits", ["9" * 6, "1" + "0" * 5000])
def test_oversized_numeric_port_strings_are_refused_without_value_error(settings_file, monkeypatch, digits):
    with pytest.raises(config.NetworkProfileError, match="SILENTSUITE_LISTEN_PORT"):
        config._parse_env_port(digits)
    with pytest.raises(config.NetworkProfileError, match="serverHosts"):
        config.validate_network_profile({"serverHosts": f"127.0.0.1:{digits}"})

    monkeypatch.setenv("SILENTSUITE_LISTEN_PORT", digits)
    config.load_settings()
    assert config.NETWORK_PROFILE_ERROR is not None
    assert config.LISTEN_PORT == 37358


def test_remove_autostart_runs_before_validation_with_corrupt_profile(settings_file, monkeypatch, capsys):
    from silentsuite_bridge import autostart

    write_settings(settings_file, {"syncInterval": 120, "network": {"sessionToken": "private-token-value"}})
    original = settings_file.read_text(encoding="utf-8")
    config.load_settings()
    assert config.NETWORK_PROFILE_ERROR is not None
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--remove-autostart"])
    monkeypatch.setattr(bridge_main, "configure_logging", lambda: None)
    monkeypatch.setattr(config, "ensure_data_dir", lambda: pytest.fail("must not touch the data dir"))
    monkeypatch.setattr(config, "validate_network_config", lambda: pytest.fail("removal must not validate"))
    monkeypatch.setattr(config, "validate_ssl_config", lambda: pytest.fail("removal must not validate"))
    monkeypatch.setattr(bridge_main, "run_server", lambda: pytest.fail("no listener may start"))
    calls = []
    monkeypatch.setattr(autostart, "remove_autostart", lambda: calls.append("removed") or 0)

    with pytest.raises(SystemExit) as excinfo:
        bridge_main.main()

    assert excinfo.value.code == 0
    assert calls == ["removed"]
    assert settings_file.read_text(encoding="utf-8") == original
    captured = capsys.readouterr()
    assert "private-token-value" not in captured.out + captured.err
    assert "Traceback" not in captured.err


def test_remove_autostart_exit_code_is_propagated_from_platform_removal(settings_file, monkeypatch):
    from silentsuite_bridge import autostart

    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--remove-autostart"])
    monkeypatch.setattr(bridge_main, "configure_logging", lambda: None)
    monkeypatch.setattr(autostart, "remove_autostart", lambda: 1)

    with pytest.raises(SystemExit) as excinfo:
        bridge_main.main()

    assert excinfo.value.code == 1


# --- Durable settings writes ----------------------------------------------


def test_save_network_profile_failure_preserves_original_file_and_leaves_no_temp(settings_file, monkeypatch):
    payload = dict(UNRELATED_SETTINGS)
    payload["network"] = {"listenPort": 45123}
    write_settings(settings_file, payload)
    original = settings_file.read_text(encoding="utf-8")

    def refuse_replace(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(config.os, "replace", refuse_replace)

    with pytest.raises(OSError):
        config.save_network_profile({"listenPort": 45999})

    assert settings_file.read_text(encoding="utf-8") == original
    assert sorted(p.name for p in settings_file.parent.iterdir()) == ["settings.json"]


def test_save_network_profile_replaces_atomically_and_keeps_unrelated_settings(settings_file):
    payload = dict(UNRELATED_SETTINGS)
    write_settings(settings_file, payload)

    assert config.save_network_profile({"listenPort": 45123}) is True

    assert read_settings(settings_file) == {**UNRELATED_SETTINGS, "network": {"listenPort": 45123}}
    assert sorted(p.name for p in settings_file.parent.iterdir()) == ["settings.json"]


@pytest.mark.parametrize("content", ["{not json", "[]", '"tok-c3f1e9-string"', "42"])
def test_malformed_settings_file_is_refused_not_discarded(settings_file, content):
    settings_file.write_text(content, encoding="utf-8")

    with pytest.raises(config.SettingsFileError) as excinfo:
        config.read_settings_strict()
    assert "tok-c3f1e9" not in str(excinfo.value)
    with pytest.raises(config.SettingsFileError):
        config.network_profile_for_autostart()
    with pytest.raises(config.SettingsFileError):
        config.save_network_profile({"listenPort": 45123})

    assert settings_file.read_text(encoding="utf-8") == content
    assert sorted(p.name for p in settings_file.parent.iterdir()) == ["settings.json"]


def test_malformed_environment_port_fails_closed_without_import_crash(settings_file, monkeypatch):
    monkeypatch.setenv("SILENTSUITE_LISTEN_PORT", "private-port")

    config._resolve_network({})
    config.load_settings()

    assert config.NETWORK_PROFILE_ERROR is not None
    assert config.LISTEN_PORT == 37358
    with pytest.raises(config.NetworkProfileError, match="SILENTSUITE_LISTEN_PORT") as excinfo:
        config.validate_network_config()
    assert "private-port" not in str(excinfo.value)
    with pytest.raises(config.NetworkProfileError):
        config.explicit_network_profile_from_env()


def test_install_profile_rejects_lenient_environment_values_before_writes(settings_file, monkeypatch):
    reload_with_env(monkeypatch, SILENTSUITE_SERVER_HOSTS="[::1")

    # Runtime stays tolerant for env-only use (existing behaviour) ...
    config.validate_network_config()
    # ... but nothing malformed may be persisted.
    with pytest.raises(config.NetworkProfileError, match="SILENTSUITE_SERVER_HOSTS") as excinfo:
        config.network_profile_for_autostart()
    assert "[::1" not in str(excinfo.value)
    assert not settings_file.exists()


@pytest.mark.parametrize("value", ["maybe", "2", "private-value"])
def test_install_profile_rejects_non_boolean_remote_permission(settings_file, monkeypatch, value):
    reload_with_env(monkeypatch, SILENTSUITE_ALLOW_REMOTE=value)

    with pytest.raises(config.NetworkProfileError, match="SILENTSUITE_ALLOW_REMOTE") as excinfo:
        config.explicit_network_profile_from_env()
    assert value not in str(excinfo.value)


# --- Reinstall / removal semantics ----------------------------------------


def test_reinstall_merges_explicit_environment_over_retained_profile(settings_file, monkeypatch):
    payload = dict(UNRELATED_SETTINGS)
    payload["network"] = {"listenAddress": "::1", "listenPort": 45123}
    write_settings(settings_file, payload)
    reload_with_env(monkeypatch, SILENTSUITE_LISTEN_PORT="45999")

    profile = config.network_profile_for_autostart()
    assert profile == {"listenAddress": "::1", "listenPort": 45999}
    assert config.save_network_profile(profile) is True

    stored = read_settings(settings_file)
    assert stored["network"] == profile
    assert stored["syncInterval"] == 120
    assert stored["customKey"] == "keep-me"


def test_reinstall_without_environment_retains_persisted_profile(settings_file):
    write_settings(settings_file, {"network": {"listenPort": 45123}})
    config.load_settings()

    profile = config.network_profile_for_autostart()

    assert profile == {"listenPort": 45123}
    assert config.save_network_profile(profile) is True
    assert read_settings(settings_file) == {"network": {"listenPort": 45123}}


def test_reinstall_cannot_widen_a_retained_bind_without_permission(settings_file, monkeypatch):
    write_settings(settings_file, {"network": {"listenPort": 45123}})
    reload_with_env(monkeypatch, SILENTSUITE_LISTEN_ADDRESS="0.0.0.0")

    with pytest.raises(RuntimeError, match="SILENTSUITE_ALLOW_REMOTE=1"):
        config.network_profile_for_autostart()
    assert read_settings(settings_file) == {"network": {"listenPort": 45123}}


def test_cli_install_autostart_denies_remote_bind_before_any_write(settings_file, monkeypatch, capsys):
    from silentsuite_bridge import autostart

    reload_with_env(monkeypatch, SILENTSUITE_LISTEN_ADDRESS="0.0.0.0")
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--install-autostart"])
    monkeypatch.setattr(bridge_main, "configure_logging", lambda: None)
    monkeypatch.setattr(autostart, "install_autostart", lambda: pytest.fail("autostart must not run"))
    monkeypatch.setattr(config, "ensure_data_dir", lambda: pytest.fail("must not touch the data dir"))

    with pytest.raises(SystemExit) as excinfo:
        bridge_main.main()

    assert excinfo.value.code == 1
    assert not settings_file.exists()
    err = capsys.readouterr().err
    assert "SILENTSUITE_ALLOW_REMOTE=1" in err
    assert "0.0.0.0" not in err
