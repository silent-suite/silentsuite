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

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
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
BINARY = "/opt/Silent Suite/silentsuite-bridge"


class FakeServiceManager:
    """Record service-manager invocations; fail the configured actions."""

    def __init__(self, failing=()):
        self.calls = []
        self.failing = set(failing)

    def __call__(self, argv, **kwargs):
        argv = list(argv)
        self.calls.append(argv)
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
    assert env.manager.actions() == ["launchctl load " + str(env.plist)]


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


# --- Production CLI journey: install -> clean-shell restart ---------------


CLI_CASES = [
    pytest.param(
        {"SILENTSUITE_LISTEN_ADDRESS": "::1", "SILENTSUITE_LISTEN_PORT": "45123"},
        {
            "exit": 0,
            "network": {"listenAddress": "::1", "listenPort": 45123},
            "address": "::1",
            "port": 45123,
            "radicale_hosts": [["::1", 45123]],
            "dashboard": True,
            "web": "silentsuite_bridge.web",
        },
        id="loopback-ipv6-custom-port",
    ),
    pytest.param(
        {"SILENTSUITE_LISTEN_ADDRESS": "0.0.0.0", "SILENTSUITE_ALLOW_REMOTE": "1"},
        {
            "exit": 0,
            "network": {"listenAddress": "0.0.0.0", "allowRemote": True},
            "address": "0.0.0.0",
            "port": 37358,
            "radicale_hosts": [["0.0.0.0", 37358]],
            "dashboard": False,
            "web": "none",
        },
        id="remote-with-persisted-permission",
    ),
    pytest.param(
        {"SILENTSUITE_LISTEN_ADDRESS": "0.0.0.0"},
        {"exit": 1},
        id="remote-without-permission-refused",
    ),
    pytest.param(
        {},
        {
            "exit": 0,
            "network": None,
            "address": "127.0.0.1",
            "port": 37358,
            "radicale_hosts": [["127.0.0.1", 37358]],
            "dashboard": True,
            "web": "silentsuite_bridge.web",
        },
        id="fresh-install-no-env-no-pinning",
    ),
]

CLEAN_SHELL_PROBE = """
import json
from silentsuite_bridge import config
from silentsuite_bridge.__main__ import build_radicale_configuration
radicale = build_radicale_configuration()
hosts = radicale.get("server", "hosts")
if isinstance(hosts, str):
    hosts = [list(config._split_host_spec(spec.strip(), "hosts")) for spec in hosts.split(",")]
else:
    hosts = [[host, int(port)] for host, port in hosts]
print(json.dumps({
    "address": config.LISTEN_ADDRESS,
    "port": config.LISTEN_PORT,
    "hosts": config.SERVER_HOSTS,
    "allow": config.ALLOW_REMOTE,
    "dashboard": config.is_dashboard_enabled(),
    "settings": config.SETTINGS_FILE,
    "radicale_hosts": hosts,
    "web": radicale.get("web", "type"),
}))
"""

DECOY_ENV = {
    "SILENTSUITE_SERVER_URL": "https://user:private-token@example.invalid/private",
    "SILENTSUITE_LOG_LEVEL": "INFO",
    "SILENTSUITE_SYNC_INTERVAL": "60",
}


def _clean_shell_env(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    for name in ("systemctl", "loginctl", "launchctl", "sudo"):
        tool = fake_bin / name
        tool.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        tool.chmod(0o755)
    home = tmp_path / "home"
    home.mkdir()
    pythonpath = str(BRIDGE_ROOT / "src")
    if os.environ.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + os.environ["PYTHONPATH"]
    env = {
        "HOME": str(home),
        "XDG_DATA_HOME": str(tmp_path / "xdg-data"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "PATH": str(fake_bin),
        "PYTHONPATH": pythonpath,
        "PYTHONDONTWRITEBYTECODE": "1",
        "TMPDIR": str(tmp_path),
    }
    for passthrough in ("SYSTEMROOT", "PYTHONHOME", "VIRTUAL_ENV", "LANG", "LC_ALL"):
        if passthrough in os.environ:
            env[passthrough] = os.environ[passthrough]
    return env, home


def _run(args, env, tmp_path):
    return subprocess.run(
        [sys.executable, *args],
        cwd=str(tmp_path),
        env=env,
        text=True,
        capture_output=True,
        timeout=120,
    )


@pytest.mark.skipif(sys.platform == "win32", reason="Windows autostart writes the real registry; covered by unit tests")
@pytest.mark.parametrize(("exported", "expected"), CLI_CASES)
def test_cli_install_autostart_then_clean_shell_restart_uses_same_profile(tmp_path, exported, expected):
    base_env, home = _clean_shell_env(tmp_path)
    log_file = tmp_path / "private-person-bridge.log"
    install_env = {**base_env, **DECOY_ENV, "SILENTSUITE_LOG_FILE": str(log_file), **exported}

    install = _run(["-m", "silentsuite_bridge", "--install-autostart"], install_env, tmp_path)
    assert install.returncode == expected["exit"], install.stdout + install.stderr
    assert "Traceback" not in install.stderr

    if sys.platform == "darwin":
        artifact = home / "Library" / "LaunchAgents" / "io.silentsuite.bridge.plist"
    else:
        artifact = home / ".config" / "systemd" / "user" / "silentsuite-bridge.service"

    if expected["exit"] != 0:
        assert "SILENTSUITE_ALLOW_REMOTE=1" in install.stderr
        assert "0.0.0.0" not in install.stderr
        assert not artifact.exists()
        data_root = tmp_path / "xdg-data"
        assert not data_root.exists() or not list(data_root.rglob("settings.json"))
        return

    assert artifact.exists()
    if sys.platform == "darwin":
        assert plistlib.loads(artifact.read_bytes())["Label"] == "io.silentsuite.bridge"
    else:
        assert "ExecStart=" in artifact.read_text(encoding="utf-8")

    # Clean shell: none of the SILENTSUITE_* variables are present any more.
    probe = _run(["-c", CLEAN_SHELL_PROBE], base_env, tmp_path)
    assert probe.returncode == 0, probe.stdout + probe.stderr
    observed = json.loads(probe.stdout.strip().splitlines()[-1])

    assert observed["address"] == expected["address"]
    assert observed["port"] == expected["port"]
    assert observed["radicale_hosts"] == expected["radicale_hosts"]
    assert observed["dashboard"] is expected["dashboard"]
    assert observed["web"] == expected["web"]

    settings_path = Path(observed["settings"])
    if expected["network"] is None:
        assert not settings_path.exists()
    else:
        text = settings_path.read_text(encoding="utf-8")
        assert json.loads(text) == {"network": expected["network"]}
        assert "private" not in text
        assert str(log_file) not in text
        assert "example.invalid" not in text
