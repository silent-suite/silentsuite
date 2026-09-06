"""Regression tests for autostart artifacts and the persisted network profile (#658).

Covers the generated systemd/launchd/Windows entries (quoting and escaping),
consistency with the self-update restart contract (#704), honest exit codes
when the service manager does not confirm a start, and a real CLI journey:
``silentsuite-bridge --install-autostart`` followed by a clean-environment
process that must observe the persisted bind.
"""

import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from silentsuite_bridge import autostart, config
from silentsuite_bridge.update import restart as update_restart
from tests.settings_lock_holder import hold_settings_lock

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
NETWORK_ENV = tuple(config.NETWORK_PROFILE_ENV.values())
OTHER_ENV = (
    "SILENTSUITE_DATA_DIR",
    "XDG_DATA_HOME",
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
BINARY = "/opt/Silent Suite/silentsuite-bridge"


class FakeServiceManager:
    """Record service-manager invocations; fail the configured actions.

    ``failing`` holds argv tokens that exit non-zero; ``missing`` holds tool
    names that raise FileNotFoundError as if the manager were not installed.
    """

    def __init__(self, failing=()):
        self.calls = []
        self.failing = set(failing)
        self.missing = set()

    def __call__(self, argv, **kwargs):
        argv = list(argv)
        self.calls.append(argv)
        if argv[0] in self.missing:
            raise FileNotFoundError(argv[0])
        returncode = 1 if any(token in argv for token in self.failing) else 0
        stdout = b"Linger=yes" if argv[0] == "loginctl" else b""
        return subprocess.CompletedProcess(argv, returncode, stdout=stdout, stderr=b"")

    def actions(self):
        return [" ".join(call[:3]) for call in self.calls]


@pytest.fixture
def env(tmp_path, monkeypatch):
    for variable in NETWORK_ENV + OTHER_ENV:
        monkeypatch.delenv(variable, raising=False)
    for name in RESOLVED_GLOBALS:
        monkeypatch.setattr(config, name, getattr(config, name))
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    data_dir = tmp_path / "data"
    monkeypatch.setattr(config, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(config, "SETTINGS_FILE", str(data_dir / "settings.json"))
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(config, "get_platform", lambda: "linux")
    monkeypatch.setattr(autostart, "_get_binary_path", lambda: [BINARY])
    manager = FakeServiceManager()
    monkeypatch.setattr(autostart.subprocess, "run", manager)
    config.load_settings()
    return SimpleNamespace(
        home=home,
        data_dir=data_dir,
        settings=data_dir / "settings.json",
        unit=home / ".config" / "systemd" / "user" / autostart.SYSTEMD_UNIT,
        plist=home / "Library" / "LaunchAgents" / f"{autostart.LAUNCHD_LABEL}.plist",
        manager=manager,
        monkeypatch=monkeypatch,
    )


def set_env(env, **values):
    for variable, value in values.items():
        env.monkeypatch.setenv(variable, value)
    config.load_settings()


def read_settings(path):
    return json.loads(path.read_text(encoding="utf-8"))


def data_dir_entries(directory):
    """Names in the data directory except the writer lock file, which is kept by design."""
    lock_name = os.path.basename(config.settings_lock_path())
    return sorted(p.name for p in directory.iterdir() if p.name != lock_name)


# --- Generated artifacts ---------------------------------------------------


def test_systemd_exec_start_quotes_and_escapes_every_argument():
    line = autostart._systemd_exec_start(['/opt/My Apps/silent$uite-bridge', "-m", 'x"y\\z', "100%"])

    assert line == '"/opt/My Apps/silent$$uite-bridge" "-m" "x\\"y\\\\z" "100%%"'


def test_systemd_service_uses_quoted_exec_start_and_restart_contract_unit_name():
    unit = autostart.render_systemd_service([BINARY])

    assert 'ExecStart="/opt/Silent Suite/silentsuite-bridge"\n' in unit
    assert "Restart=on-failure" in unit
    assert autostart.SYSTEMD_UNIT == "silentsuite-bridge.service"
    assert autostart.SYSTEMD_UNIT in Path(update_restart.__file__).read_text(encoding="utf-8")


def test_launchd_plist_is_xml_safe_and_matches_self_update_restart_contract():
    args = ["/Applications/Silent & Suite/<bridge>", "--no-tray"]
    log_dir = "/Users/First Last/Library/Logs/SilentSuiteBridge"

    payload = plistlib.loads(autostart.render_launchd_plist(args, log_dir))

    assert payload["Label"] == "io.silentsuite.bridge" == autostart.LAUNCHD_LABEL
    assert payload["ProgramArguments"] == args
    assert payload["RunAtLoad"] is True
    assert payload["KeepAlive"] == {"NetworkState": True}
    assert payload["StandardOutPath"] == f"{log_dir}/bridge.log"
    assert payload["StandardErrorPath"] == f"{log_dir}/bridge.error.log"

    restart_source = Path(update_restart.__file__).read_text(encoding="utf-8")
    assert "~/Library/LaunchAgents/io.silentsuite.bridge.plist" in restart_source
    assert autostart._launchd_plist_path() == os.path.expanduser("~/Library/LaunchAgents/io.silentsuite.bridge.plist")


def test_windows_run_command_quotes_paths_with_spaces_only_when_needed():
    spaced = r"C:\Users\First Last\AppData\Local\SilentSuite\silentsuite-bridge.exe"
    plain = r"C:\Tools\silentsuite-bridge.exe"

    assert autostart.render_windows_command([spaced]) == f'"{spaced}"'
    assert autostart.render_windows_command([plain]) == plain
    assert autostart.render_windows_command([plain, "-m", "silentsuite_bridge"]) == f"{plain} -m silentsuite_bridge"


# --- install/remove semantics ---------------------------------------------


def test_install_autostart_rejects_custom_data_dir_before_any_write(env, capsys):
    set_env(env, SILENTSUITE_DATA_DIR=str(env.home / "private-data"), SILENTSUITE_LISTEN_PORT="45123")

    assert autostart.install_autostart() == 1

    captured = capsys.readouterr()
    assert "SILENTSUITE_DATA_DIR" in captured.err
    assert "Nothing was changed" in captured.err
    assert str(env.home / "private-data") not in captured.err
    assert not env.settings.exists()
    assert not env.unit.exists()
    assert env.manager.calls == []


def test_install_autostart_rejects_xdg_data_home_override_on_linux_before_any_write(env, capsys):
    # A shell-only XDG_DATA_HOME relocates settings.json for the installing
    # process; the clean-environment restart would read the default directory
    # and lose the profile, so the override is refused like SILENTSUITE_DATA_DIR.
    relocated = env.home / "xdg-private"
    set_env(env, XDG_DATA_HOME=str(relocated), SILENTSUITE_LISTEN_PORT="45123")

    assert autostart.install_autostart() == 1

    captured = capsys.readouterr()
    assert "XDG_DATA_HOME" in captured.err
    assert "Nothing was changed" in captured.err
    assert str(relocated) not in captured.err
    assert not env.settings.exists()
    assert not env.unit.exists()
    assert not relocated.exists()
    assert env.manager.calls == []


def test_install_autostart_reports_both_location_overrides_together(env, capsys):
    set_env(env, XDG_DATA_HOME=str(env.home / "xdg-private"), SILENTSUITE_DATA_DIR=str(env.home / "private-data"))

    assert autostart.install_autostart() == 1

    err = capsys.readouterr().err
    assert "SILENTSUITE_DATA_DIR and XDG_DATA_HOME" in err
    assert autostart.unsupported_location_overrides("linux", {"XDG_DATA_HOME": ""}) == ["XDG_DATA_HOME"]
    assert autostart.unsupported_location_overrides("linux", {}) == []


@pytest.mark.parametrize("platform", ["macos", "windows"])
def test_xdg_data_home_is_not_a_location_override_off_linux(env, capsys, platform):
    env.monkeypatch.setattr(config, "get_platform", lambda: platform)
    env.monkeypatch.setattr(autostart, f"install_autostart_{platform}", lambda: 0)
    set_env(env, XDG_DATA_HOME=str(env.home / "xdg-ignored"), SILENTSUITE_LISTEN_PORT="45123")

    assert autostart.unsupported_location_overrides(platform) == []
    assert autostart.install_autostart() == 0
    assert read_settings(env.settings) == {"network": {"listenPort": 45123}}
    assert "XDG_DATA_HOME" not in capsys.readouterr().err


def test_install_autostart_persists_profile_then_installs_unit(env, capsys):
    set_env(env, SILENTSUITE_LISTEN_ADDRESS="::1", SILENTSUITE_LISTEN_PORT="45123")

    assert autostart.install_autostart() == 0

    assert read_settings(env.settings) == {"network": {"listenAddress": "::1", "listenPort": 45123}}
    unit = env.unit.read_text(encoding="utf-8")
    assert 'ExecStart="/opt/Silent Suite/silentsuite-bridge"' in unit
    assert "SILENTSUITE_" not in unit
    assert env.manager.actions()[:3] == [
        "systemctl --user daemon-reload",
        "systemctl --user enable",
        "systemctl --user start",
    ]
    out = capsys.readouterr().out
    assert "Persisted explicit network settings to settings.json: listenAddress, listenPort" in out
    assert "systemd accepted the enable/start request" in out


def test_install_autostart_without_environment_writes_no_network_profile(env, capsys):
    assert autostart.install_autostart() == 0

    assert not env.settings.exists()
    assert env.unit.exists()
    assert "default loopback bind (127.0.0.1:37358)" in capsys.readouterr().out


def test_install_autostart_does_not_claim_running_when_start_fails(env, capsys):
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")
    env.manager.failing = {"start"}

    assert autostart.install_autostart() == 1

    out = capsys.readouterr().out
    assert "not confirmed running" in out
    assert "accepted" not in out
    assert "systemctl --user status silentsuite-bridge" in out
    # The validated profile and unit are in place; only the start was not confirmed.
    assert read_settings(env.settings) == {"network": {"listenPort": 45123}}
    assert env.unit.exists()
    assert not any(call[0] == "sudo" for call in env.manager.calls)


def test_install_autostart_denies_remote_bind_before_any_write(env, capsys):
    set_env(env, SILENTSUITE_LISTEN_ADDRESS="203.0.113.7")

    assert autostart.install_autostart() == 1

    captured = capsys.readouterr()
    assert "SILENTSUITE_ALLOW_REMOTE=1" in captured.err
    assert "203.0.113.7" not in captured.err
    assert not env.settings.exists()
    assert not env.unit.exists()
    assert env.manager.calls == []


def test_install_autostart_rejects_invalid_persisted_profile_and_preserves_settings(env, capsys):
    env.data_dir.mkdir()
    env.settings.write_text(
        json.dumps({"syncInterval": 120, "network": {"sessionToken": "private-token-value"}}),
        encoding="utf-8",
    )
    original = env.settings.read_text(encoding="utf-8")
    config.load_settings()

    assert autostart.install_autostart() == 1

    captured = capsys.readouterr()
    assert "unsupported key" in captured.err
    assert "private-token-value" not in captured.err
    assert "sessionToken" not in captured.err
    assert env.settings.read_text(encoding="utf-8") == original
    assert not env.unit.exists()


def test_remove_autostart_retains_profile_and_reinstall_merges(env, capsys):
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")
    assert autostart.install_autostart() == 0

    assert autostart.remove_autostart() == 0
    out = capsys.readouterr().out
    assert "Auto-start removed." in out
    assert "was kept" in out
    assert not env.unit.exists()
    assert read_settings(env.settings) == {"network": {"listenPort": 45123}}

    env.monkeypatch.delenv("SILENTSUITE_LISTEN_PORT")
    set_env(env, SILENTSUITE_LISTEN_ADDRESS="::1")
    assert autostart.install_autostart() == 0
    assert read_settings(env.settings) == {"network": {"listenAddress": "::1", "listenPort": 45123}}
    assert env.unit.exists()


def test_remove_autostart_when_not_installed_is_idempotent(env, capsys):
    assert autostart.remove_autostart() == 0
    assert "Auto-start was not installed." in capsys.readouterr().out
    assert env.manager.calls == []


def test_install_autostart_refuses_malformed_settings_file_without_overwriting(env, capsys):
    env.data_dir.mkdir()
    env.settings.write_text("{tok-c3f1e9 not json", encoding="utf-8")
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")

    assert autostart.install_autostart() == 1

    captured = capsys.readouterr()
    assert "settings.json" in captured.err
    assert "nothing was changed" in captured.err
    assert "tok-c3f1e9" not in captured.err
    assert env.settings.read_text(encoding="utf-8") == "{tok-c3f1e9 not json"
    assert not env.unit.exists()
    assert env.manager.calls == []


def test_install_autostart_settings_write_failure_keeps_original_and_writes_no_unit(env, capsys):
    env.data_dir.mkdir()
    env.settings.write_text(json.dumps({"syncInterval": 120}), encoding="utf-8")
    original = env.settings.read_text(encoding="utf-8")
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")

    def refuse_replace(src, dst):
        raise OSError("disk full")

    env.monkeypatch.setattr(config.os, "replace", refuse_replace)

    assert autostart.install_autostart() == 1

    assert "left unchanged" in capsys.readouterr().err
    assert env.settings.read_text(encoding="utf-8") == original
    assert data_dir_entries(env.data_dir) == ["settings.json"]
    assert not env.unit.exists()
    assert env.manager.calls == []


def test_install_autostart_reports_unconfirmed_durability_when_directory_sync_fails(env, capsys):
    env.data_dir.mkdir()
    env.settings.write_text(json.dumps({"syncInterval": 120}), encoding="utf-8")
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")

    def refuse_directory_sync(directory):
        raise OSError("EIO")

    env.monkeypatch.setattr(config, "_fsync_directory", refuse_directory_sync)

    assert autostart.install_autostart() == 1

    captured = capsys.readouterr()
    # Honest post-replace semantics: the file was replaced, so the message must
    # neither claim it was left unchanged nor claim the profile is durable.
    assert "not confirmed durable" in captured.err
    assert "left unchanged" not in captured.err
    assert "Persisted explicit network settings" not in captured.out
    assert read_settings(env.settings) == {"syncInterval": 120, "network": {"listenPort": 45123}}
    assert data_dir_entries(env.data_dir) == ["settings.json"]
    assert not env.unit.exists()
    assert env.manager.calls == []


def test_install_autostart_fails_closed_when_another_process_holds_the_settings_lock(env, capsys):
    env.data_dir.mkdir()
    env.settings.write_text(json.dumps({"syncInterval": 120}), encoding="utf-8")
    original = env.settings.read_text(encoding="utf-8")
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")
    env.monkeypatch.setattr(config, "SETTINGS_LOCK_TIMEOUT", 0.2)

    # A dashboard process is mid-write and holds the real settings lock.
    with hold_settings_lock(env.data_dir, {"syncInterval": 60}) as dashboard:
        assert autostart.install_autostart() == 1

        captured = capsys.readouterr()
        assert "another bridge process is updating settings.json" in captured.err
        assert "left unchanged" in captured.err
        assert "Persisted explicit network settings" not in captured.out
        assert env.settings.read_text(encoding="utf-8") == original
        assert not env.unit.exists()
        assert env.manager.calls == []

        assert dashboard.written == {"syncInterval": 60}

    # The holder's write landed intact; a retry then installs normally.
    assert read_settings(env.settings) == {"syncInterval": 60}
    assert autostart.install_autostart() == 0
    assert read_settings(env.settings) == {"syncInterval": 60, "network": {"listenPort": 45123}}
    assert env.unit.exists()
    assert data_dir_entries(env.data_dir) == ["settings.json"]


def test_remove_autostart_stays_usable_when_settings_file_is_malformed(env, capsys):
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")
    assert autostart.install_autostart() == 0
    env.settings.write_text("{tok-c3f1e9 not json", encoding="utf-8")
    config.load_settings()
    capsys.readouterr()

    # Startup fails closed on the unreadable file (no silent loopback fallback) ...
    assert config.NETWORK_PROFILE_ERROR is not None
    assert "settings.json" in config.NETWORK_PROFILE_ERROR
    assert "tok-c3f1e9" not in config.NETWORK_PROFILE_ERROR
    with pytest.raises(config.NetworkProfileError, match="settings.json"):
        config.validate_network_config()

    # ... while removal neither validates nor writes settings.
    assert autostart.remove_autostart() == 0

    captured = capsys.readouterr()
    assert "Auto-start removed." in captured.out
    assert "tok-c3f1e9" not in captured.out + captured.err
    assert env.settings.read_text(encoding="utf-8") == "{tok-c3f1e9 not json"
    assert not env.unit.exists()


# --- Honest removal status --------------------------------------------------


@pytest.mark.parametrize("failing_action", ["stop", "disable"])
def test_linux_remove_keeps_unit_and_fails_when_stop_or_disable_not_confirmed(env, capsys, failing_action):
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")
    assert autostart.install_autostart() == 0
    capsys.readouterr()
    env.manager.calls.clear()
    env.manager.failing = {failing_action}

    assert autostart.remove_autostart() == 1

    captured = capsys.readouterr()
    assert "Auto-start removed" not in captured.out
    assert "was not removed" in captured.err
    assert "may still be running" in captured.err
    assert env.unit.exists()
    assert read_settings(env.settings) == {"network": {"listenPort": 45123}}
    actions = env.manager.actions()
    assert actions[:2] == ["systemctl --user stop", "systemctl --user disable"]
    assert "systemctl --user daemon-reload" not in actions

    # Retry after the manager recovers completes the removal.
    env.manager.failing = set()
    env.manager.calls.clear()
    assert autostart.remove_autostart() == 0
    assert "Auto-start removed." in capsys.readouterr().out
    assert not env.unit.exists()
    assert env.manager.actions() == [
        "systemctl --user stop",
        "systemctl --user disable",
        "systemctl --user daemon-reload",
    ]


def test_linux_remove_reports_missing_service_manager_without_claiming_removal(env, capsys):
    assert autostart.install_autostart() == 0
    capsys.readouterr()
    env.manager.missing = {"systemctl"}

    assert autostart.remove_autostart() == 1

    captured = capsys.readouterr()
    assert "Auto-start removed" not in captured.out
    assert "systemctl is not available" in captured.out
    assert "was not removed" in captured.err
    assert env.unit.exists()


def test_linux_remove_reports_daemon_reload_failure_after_deleting_unit(env, capsys):
    assert autostart.install_autostart() == 0
    capsys.readouterr()
    env.manager.failing = {"daemon-reload"}

    assert autostart.remove_autostart() == 1

    captured = capsys.readouterr()
    assert "Auto-start removed." not in captured.out
    assert "did not confirm the reload" in captured.err
    assert not env.unit.exists()


def test_macos_remove_keeps_plist_and_fails_when_unload_not_confirmed(env, capsys):
    env.monkeypatch.setattr(config, "get_platform", lambda: "macos")
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")
    assert autostart.install_autostart() == 0
    capsys.readouterr()
    env.manager.failing = {"unload"}

    assert autostart.remove_autostart() == 1

    captured = capsys.readouterr()
    assert "Auto-start removed" not in captured.out
    assert "was not removed" in captured.err
    assert "launchctl list io.silentsuite.bridge" in captured.err
    assert env.plist.exists()
    assert read_settings(env.settings) == {"network": {"listenPort": 45123}}

    env.manager.failing = set()
    assert autostart.remove_autostart() == 0
    assert not env.plist.exists()


def test_macos_remove_reports_missing_launchctl(env, capsys):
    env.monkeypatch.setattr(config, "get_platform", lambda: "macos")
    assert autostart.install_autostart() == 0
    capsys.readouterr()
    env.manager.missing = {"launchctl"}

    assert autostart.remove_autostart() == 1

    assert env.plist.exists()
    assert "Auto-start removed" not in capsys.readouterr().out


def test_remove_autostart_never_starts_listener_or_writes_settings_with_corrupt_profile(env, capsys):
    assert autostart.install_autostart() == 0
    env.data_dir.mkdir(exist_ok=True)
    env.settings.write_text(json.dumps({"network": {"sessionToken": "private-token-value"}}), encoding="utf-8")
    original = env.settings.read_text(encoding="utf-8")
    config.load_settings()
    assert config.NETWORK_PROFILE_ERROR is not None
    capsys.readouterr()

    assert autostart.remove_autostart() == 0

    captured = capsys.readouterr()
    assert "Auto-start removed." in captured.out
    assert "private-token-value" not in captured.out + captured.err
    assert env.settings.read_text(encoding="utf-8") == original
    assert not env.unit.exists()


def test_windows_remove_source_documents_that_running_process_is_not_stopped():
    source = Path(autostart.__file__).read_text(encoding="utf-8")
    body = source[source.index("def remove_autostart_windows"):source.index("# --- Public API ---")]

    assert "already running is not stopped" in body
    assert "was not stopped" in body


@pytest.mark.skipif(sys.platform != "win32", reason="real registry round-trip runs natively on Windows only")
def test_windows_install_and_remove_round_trip_against_isolated_registry_key(env, capsys):
    """Execute the real winreg install/remove path against a throwaway HKCU key.

    The production Run key is never opened: ``_windows_registry_key`` is
    pointed at a uniquely named key created for this test and deleted in
    ``finally``, so the runner's sign-in startup list stays untouched.
    """
    import uuid
    import winreg

    env.monkeypatch.setattr(config, "get_platform", lambda: "windows")
    parent_key = rf"Software\SilentSuiteBridgeTest-{uuid.uuid4().hex}"
    run_key = parent_key + r"\Run"
    winreg.CloseKey(winreg.CreateKey(winreg.HKEY_CURRENT_USER, run_key))
    env.monkeypatch.setattr(autostart, "_windows_registry_key", lambda: run_key)
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")

    def read_run_value():
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, run_key) as key:
            return winreg.QueryValueEx(key, autostart.WINDOWS_RUN_VALUE)

    try:
        assert autostart.install_autostart() == 0
        value, kind = read_run_value()
        assert value == autostart.render_windows_command([BINARY])
        assert kind == winreg.REG_SZ
        assert read_settings(env.settings) == {"network": {"listenPort": 45123}}
        assert "next sign-in" in capsys.readouterr().out

        assert autostart.remove_autostart() == 0
        out = capsys.readouterr().out
        assert "no longer start at sign-in" in out
        assert "was not stopped" in out
        assert "was kept" in out
        with pytest.raises(FileNotFoundError):
            read_run_value()
        assert read_settings(env.settings) == {"network": {"listenPort": 45123}}

        # Removing again is idempotent and never fails on a missing value.
        assert autostart.remove_autostart() == 0
        assert "Auto-start was not installed." in capsys.readouterr().out
    finally:
        for key_path in (run_key, parent_key):
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
            except OSError:
                pass


def test_macos_install_writes_escaped_plist_and_reports_load_failure(env, capsys):
    env.monkeypatch.setattr(config, "get_platform", lambda: "macos")
    env.monkeypatch.setattr(autostart, "_get_binary_path", lambda: ["/Applications/Silent & Suite/bridge"])
    env.manager.failing = {"load"}
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")

    assert autostart.install_autostart() == 1

    payload = plistlib.loads(env.plist.read_bytes())
    assert payload["ProgramArguments"] == ["/Applications/Silent & Suite/bridge"]
    assert payload["Label"] == autostart.LAUNCHD_LABEL
    assert read_settings(env.settings) == {"network": {"listenPort": 45123}}
    out = capsys.readouterr().out
    assert "launchctl load failed" in out
    assert "not confirmed running" in out
    # Compare the plist path as a path: expanduser keeps the literal "/Library/..."
    # suffix, which differs from the fixture's native separators when this test
    # runs on Windows.
    assert [call[:2] + [Path(call[2])] for call in env.manager.calls] == [["launchctl", "load", env.plist]]


def test_macos_install_success_does_not_claim_the_bridge_is_running(env, capsys):
    env.monkeypatch.setattr(config, "get_platform", lambda: "macos")

    assert autostart.install_autostart() == 0

    out = capsys.readouterr().out
    assert "Agent loaded" in out
    assert "launchctl list io.silentsuite.bridge" in out
    assert "is running" not in out


def test_macos_remove_retains_profile(env, capsys):
    env.monkeypatch.setattr(config, "get_platform", lambda: "macos")
    set_env(env, SILENTSUITE_LISTEN_PORT="45123")
    assert autostart.install_autostart() == 0

    assert autostart.remove_autostart() == 0

    assert not env.plist.exists()
    assert read_settings(env.settings) == {"network": {"listenPort": 45123}}
    assert "was kept" in capsys.readouterr().out


# The production CLI journey (install -> clean-shell restart) lives in
# test_autostart_clean_shell_cli.py so it also collects and runs against the
# pre-fix base source as a behavioural RED proof.
