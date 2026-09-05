"""Production CLI journey for #658: ``--install-autostart`` then a clean-shell restart.

Standalone on purpose: it imports nothing from ``silentsuite_bridge`` at module
level and the child probe touches only APIs that exist on the pre-fix base
(``config.LISTEN_ADDRESS`` / ``LISTEN_PORT`` / ``SERVER_HOSTS`` /
``is_dashboard_enabled`` / ``SETTINGS_FILE`` / ``_extract_host`` and
``build_radicale_configuration``). It therefore collects and runs unchanged
against base source: the ``remote-with-persisted-permission`` case fails
there with an assertion mismatch (observed bind is loopback, expected the
explicit remote bind) and passes with the fix.

Service managers are stubbed with no-op shell scripts on PATH; nothing real
is written outside ``tmp_path``. Windows is skipped because the real registry
would be written; Windows semantics are covered by unit tests.
"""

import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path

import pytest

BRIDGE_ROOT = Path(__file__).resolve().parents[1]

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

# Base-compatible probe: no reference to helpers introduced by the fix.
CLEAN_SHELL_PROBE = """
import json
from silentsuite_bridge import config
from silentsuite_bridge.__main__ import build_radicale_configuration
radicale = build_radicale_configuration()
hosts = radicale.get("server", "hosts")
if isinstance(hosts, str):
    parsed = []
    for spec in hosts.split(","):
        spec = spec.strip()
        parsed.append([config._extract_host(spec), int(spec.rsplit(":", 1)[1])])
    hosts = parsed
else:
    hosts = [[host, int(port)] for host, port in hosts]
print(json.dumps({
    "address": config.LISTEN_ADDRESS,
    "port": config.LISTEN_PORT,
    "hosts": config.SERVER_HOSTS,
    "dashboard": config.is_dashboard_enabled(),
    "settings": config.SETTINGS_FILE,
    "radicale_hosts": hosts,
    "web": radicale.get("web", "type"),
}))
"""

DECOY_ENV = {
    "SILENTSUITE_SERVER_URL": "https://user:tok-c3f1e9-svr@example.invalid/tok-c3f1e9-path",
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
    log_file = tmp_path / "tok-c3f1e9-log" / "bridge.log"
    log_file.parent.mkdir()
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

    # On base source these are the assertions that fail: the clean-shell
    # process observes the loopback defaults instead of the installed profile.
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
        assert "tok-c3f1e9" not in text
        assert "example.invalid" not in text
