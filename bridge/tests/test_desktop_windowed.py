"""T4 (#171), source level: the desktop app without stdio, and where its logs go.

A windowed desktop executable runs with ``sys.stdin``, ``sys.stdout`` and
``sys.stderr`` set to None and has no terminal. Contract (implementation-plan
v2 section 7 and T4):
- ``main(flavor="desktop")`` still shows its own registry-confirmed dashboard,
  closes normally and cleans up (lock, listener, registry), with stdio None;
- with no ``SILENTSUITE_LOG_FILE`` set, desktop logging reaches a file under
  DATA_DIR, so a windowed user has a log at all;
- an explicit ``SILENTSUITE_LOG_FILE`` (today's override) is still honoured;
- the desktop journey never runs the CLI ``run_server`` path.

This simulates Python's windowed stdio in a source checkout. It is not a
frozen executable, native bootloader, installer or clean-machine result.

Three journeys, each a fresh child (``tests/desktop_smoke/windowed_probe.py``):
ordinary stdio (positive control), stdio None, and stdio None with an
explicit log file. The log witness is one fixed synthetic line written
through the product's own logger; no account, page or PIM data is logged.
The product's own no-account start-up line is checked as well.

Needs PySide6 and a display: skipped in ordinary headless suites, required
(SILENTSUITE_REQUIRE_DESKTOP_NATIVE=1) in the native CI job.
"""

import importlib.util
import json
import os
import secrets
import socket
import subprocess
import sys
from pathlib import Path

import pytest

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
PROBE = Path(__file__).resolve().parent / "desktop_smoke" / "windowed_probe.py"
REQUIRE_ENV = "SILENTSUITE_REQUIRE_DESKTOP_NATIVE"
PRODUCT_LOG_LINE = "No users configured; starting bridge dashboard setup"
CHILD_TIMEOUT = 150
MAX_SCAN_BYTES = 16 * 1024 * 1024


def _native_required():
    if importlib.util.find_spec("PySide6") is None:
        if os.environ.get(REQUIRE_ENV) == "1":
            pytest.fail("prerequisite missing (not RED): PySide6 is not installed in the required native job")
        pytest.skip("optional native desktop test: PySide6 is not installed")


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _journey(tmp_path_factory, name, windowed, explicit_log=False):
    _native_required()
    root = tmp_path_factory.mktemp(name)
    data, home = root / "data", root / "home"
    data.mkdir()
    home.mkdir()
    port = _free_port()
    witness = "t4-windowed-witness-" + secrets.token_hex(8)
    env = {k: v for k, v in os.environ.items() if not k.startswith("SILENTSUITE_")}
    pythonpath = str(BRIDGE_ROOT / "src")
    if env.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + env["PYTHONPATH"]
    env.update({
        "SILENTSUITE_DATA_DIR": str(data),
        "SILENTSUITE_LISTEN_ADDRESS": "127.0.0.1",
        "SILENTSUITE_LISTEN_PORT": str(port),
        "PYTHONPATH": pythonpath,
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    explicit_path = root / "explicit" / "bridge.log"
    if explicit_log:
        explicit_path.parent.mkdir()
        env["SILENTSUITE_LOG_FILE"] = str(explicit_path)
    if sys.platform != "win32":
        env.update({"HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
                    "XDG_DATA_HOME": str(home / ".local" / "share")})
    out = root / "result.json"
    argv = [sys.executable, str(PROBE), "--out", str(out), "--witness", witness]
    if windowed:
        argv.append("--windowed")
    try:
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=CHILD_TIMEOUT, env=env)
    except subprocess.TimeoutExpired:
        pytest.fail(f"fixture timeout (not RED): {name} exceeded {CHILD_TIMEOUT}s")
    result = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    describe = (
        f"{name}: rc={completed.returncode} stage={result.get('stage')!r} entry_error={result.get('entry_error')!r} "
        f"observed={result.get('observed')!r} prereq={result.get('prereq')!r}\n"
        f"child stderr (C-level output survives stdio None):\n{completed.stderr[-3000:]}"
    )
    if completed.returncode != 0 or result.get("stage") != "done":
        pytest.fail(f"fixture did not complete (not RED): {describe}")
    if result.get("entry_error") is not None:
        pytest.fail(f"desktop entrypoint raised (not RED): {describe}")
    return {"result": result, "describe": describe, "port": port, "data": data,
            "witness": witness, "explicit_path": explicit_path}


def _files_containing(directory, needles):
    """Paths under ``directory`` whose bytes contain every needle (bounded scan)."""
    hits, scanned = [], 0
    for path in sorted(Path(directory).rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        size = path.stat().st_size
        if scanned + size > MAX_SCAN_BYTES:
            break
        scanned += size
        data = path.read_bytes()
        if all(needle.encode("utf-8") in data for needle in needles):
            hits.append(path.relative_to(directory).as_posix())
    return hits


def _assert_journey_completed(journey):
    result = journey["result"]
    observed = result["observed"]
    assert not observed.get("window_deadline_missed"), f"no own dashboard window: {journey['describe']}"
    assert observed.get("requested_url") == observed.get("registry_dashboard_url"), journey["describe"]
    assert observed.get("requested_url") == f"http://127.0.0.1:{journey['port']}/", journey["describe"]
    assert observed.get("view_url") == f"http://127.0.0.1:{journey['port']}/.web", journey["describe"]
    assert result["exit_code"] in (None, 0), journey["describe"]
    assert result["lock_free_after"] is True, journey["describe"]
    assert result["listener_closed_after"] is True, journey["describe"]
    assert result["registry_stopped_after"] is True, journey["describe"]
    assert result["run_server_calls"] == 0, f"the desktop journey ran the CLI server path: {journey['describe']}"


@pytest.fixture(scope="module")
def ordinary(tmp_path_factory):
    return _journey(tmp_path_factory, "t4-ordinary", windowed=False)


@pytest.fixture(scope="module")
def windowed(tmp_path_factory):
    return _journey(tmp_path_factory, "t4-windowed", windowed=True)


@pytest.fixture(scope="module")
def windowed_explicit(tmp_path_factory):
    return _journey(tmp_path_factory, "t4-windowed-explicit", windowed=True, explicit_log=True)


def test_ordinary_stdio_desktop_journey_completes(ordinary):
    # Positive control: Qt, display and fixture work with normal stdio.
    assert ordinary["result"]["observed"].get("stdio_none_during_run") is False
    _assert_journey_completed(ordinary)


def test_windowed_stdio_desktop_journey_completes(windowed):
    # stdio really was None while the product ran, and the journey still completed.
    assert windowed["result"]["observed"].get("stdio_none_during_run") is True, windowed["describe"]
    _assert_journey_completed(windowed)


def test_windowed_desktop_logs_reach_the_data_directory_by_default(windowed):
    hits = _files_containing(windowed["data"], [windowed["witness"], PRODUCT_LOG_LINE])
    assert hits, (
        "with no SILENTSUITE_LOG_FILE and no stdio, neither the witness line nor the product's own "
        f"start-up line reached any file under DATA_DIR; root handlers were "
        f"{windowed['result']['observed'].get('root_handler_kinds')!r}"
    )


def test_windowed_desktop_honours_an_explicit_log_file(windowed_explicit):
    # Control: today's explicit override keeps working without stdio.
    _assert_journey_completed(windowed_explicit)
    path = windowed_explicit["explicit_path"]
    text = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
    assert windowed_explicit["witness"] in text and PRODUCT_LOG_LINE in text, windowed_explicit["describe"]
