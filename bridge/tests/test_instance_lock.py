"""T1a (#171): one Bridge server per data directory.

Contract under test (implementation-plan-v2 §5 plus the v3 amendment):
a headless server start checks ``<DATA_DIR>/instance.lock`` with the existing
cross-process lock primitive (``config._try_lock_fd``) before any readiness
work. When another process holds that lock, ``main()`` exits 1 promptly with
one fixed message and never reaches ``_prepare_server_start`` (credential
check, listener report, dashboard opener), sync workers or serving. An unheld
data directory starts as before and leaves the lock free on normal return,
and a lock held for a different data directory does not interfere.

The lock is held by a separate Python process that takes the real OS lock
through ``config._try_lock_fd``; nothing about the lock is stubbed. Only the
expensive startup stages after the lock boundary are replaced by recorders,
so no listener is bound, no browser is opened, no account or network is used.
"""

import os
import queue
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
INSTANCE_LOCK_NAME = "instance.lock"
ALREADY_RUNNING_MESSAGE = "Error: another SilentSuite Bridge is already running for this data directory."
PROCESS_TIMEOUT = 30.0
PROMPT_EXIT_SECONDS = 10.0

# Child process: open <data_dir>/instance.lock and try the production lock.
#   hold  -> print HELD, keep the lock until a line arrives on stdin, then RELEASED
#   probe -> print FREE (and unlock) or BUSY, then exit
LOCK_CHILD = """
import os
import sys
from silentsuite_bridge import config

data_dir, mode = sys.argv[1], sys.argv[2]
fd = os.open(os.path.join(data_dir, "instance.lock"), os.O_RDWR | os.O_CREAT, 0o600)
try:
    if not config._try_lock_fd(fd):
        print("BUSY", flush=True)
        sys.exit(0)
    if mode == "probe":
        config._unlock_fd(fd)
        print("FREE", flush=True)
        sys.exit(0)
    print("HELD", flush=True)
    sys.stdin.readline()
    config._unlock_fd(fd)
    print("RELEASED", flush=True)
finally:
    os.close(fd)
"""

_ISOLATED_ENV_PREFIX = "SILENTSUITE_"


def _child_env(data_dir):
    env = {k: v for k, v in os.environ.items() if not k.startswith(_ISOLATED_ENV_PREFIX)}
    pythonpath = str(BRIDGE_ROOT / "src")
    if env.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + env["PYTHONPATH"]
    env.update({
        "SILENTSUITE_DATA_DIR": str(data_dir),
        "PYTHONPATH": pythonpath,
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    return env


def _spawn_lock_child(data_dir, mode):
    return subprocess.Popen(
        [sys.executable, "-c", LOCK_CHILD, str(data_dir), mode],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=_child_env(data_dir),
    )


def _readline_with_timeout(process, timeout):
    """Read one stdout line without risking an unbounded block (pipes cannot be polled on Windows)."""
    lines = queue.Queue()
    reader = threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True)
    reader.start()
    try:
        return lines.get(timeout=timeout)
    except queue.Empty:
        return None


def _reap(process):
    try:
        process.wait(timeout=PROCESS_TIMEOUT)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=PROCESS_TIMEOUT)


def probe_instance_lock(data_dir):
    """Ask an independent process whether the instance lock is FREE or BUSY right now."""
    process = _spawn_lock_child(data_dir, "probe")
    try:
        stdout, stderr = process.communicate(timeout=PROCESS_TIMEOUT)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=PROCESS_TIMEOUT)
        raise AssertionError("lock probe process did not finish (fixture failure, not RED)")
    state = stdout.strip()
    assert process.returncode == 0 and state in {"FREE", "BUSY"}, (
        f"lock probe fixture failed (not RED): rc={process.returncode} out={stdout!r} err={stderr!r}"
    )
    return state


class _Holder:
    def __init__(self, process):
        self.process = process

    def is_alive(self):
        return self.process.poll() is None


@contextmanager
def hold_instance_lock(data_dir):
    """Run a separate process that holds ``<data_dir>/instance.lock`` until the block exits."""
    process = _spawn_lock_child(data_dir, "hold")
    try:
        line = _readline_with_timeout(process, PROCESS_TIMEOUT)
        if line is None or line.strip() != "HELD":
            process.kill()
            _, stderr = process.communicate(timeout=PROCESS_TIMEOUT)
            raise AssertionError(f"lock holder fixture did not take the instance lock (not RED): {line!r} {stderr!r}")
        yield _Holder(process)
    finally:
        if process.poll() is None:
            try:
                process.stdin.write("release\n")
                process.stdin.flush()
            except (OSError, ValueError):
                pass
        _reap(process)
        for stream in (process.stdin, process.stdout, process.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass


def _point_bridge_at(monkeypatch, data_dir):
    data_dir = str(data_dir)
    monkeypatch.setenv("SILENTSUITE_DATA_DIR", data_dir)
    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setattr(config, "SETTINGS_FILE", os.path.join(data_dir, "settings.json"))
    monkeypatch.setattr(config, "DATABASE_FILE", os.path.join(data_dir, "bridge_data.db"))
    monkeypatch.setattr(config, "CREDS_FILE", os.path.join(data_dir, "credentials.json"))
    monkeypatch.setattr(config, "HTPASSWD_FILE", os.path.join(data_dir, "htpasswd"))


def _run_headless_main(monkeypatch, data_dir):
    """Run the real ``main()`` as a headless server start; record every stage after the lock boundary."""
    calls = []
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--no-tray"])
    monkeypatch.setattr(bridge_main, "configure_logging", lambda: None)
    _point_bridge_at(monkeypatch, data_dir)
    monkeypatch.setattr(
        bridge_main,
        "_prepare_server_start",
        lambda open_browser=True: calls.append("_prepare_server_start") or True,
    )
    monkeypatch.setattr(bridge_main, "_start_sync_threads", lambda: calls.append("_start_sync_threads"))
    monkeypatch.setattr(bridge_main, "run_server", lambda: calls.append("run_server"))
    started = time.monotonic()
    try:
        bridge_main.main()
        exit_code = None
    except SystemExit as exc:
        exit_code = exc.code
    return exit_code, calls, time.monotonic() - started


def test_second_headless_start_with_held_instance_lock_exits_before_readiness(tmp_path, monkeypatch, capsys):
    data_dir = tmp_path / "held-data"
    data_dir.mkdir()

    with hold_instance_lock(data_dir) as holder:
        # Positive control: an independent process really sees the lock as taken on this OS.
        assert probe_instance_lock(data_dir) == "BUSY", "fixture control failed (not RED): lock not observed busy"

        exit_code, calls, elapsed = _run_headless_main(monkeypatch, data_dir)
        captured = capsys.readouterr()

        assert calls == [], f"second start reached readiness/serving while the instance lock was held: {calls}"
        assert exit_code == 1
        assert ALREADY_RUNNING_MESSAGE in captured.err
        assert str(data_dir) not in captured.out + captured.err
        assert elapsed < PROMPT_EXIT_SECONDS
        assert holder.is_alive(), "the first instance's lock holder must be untouched by the refused start"

    assert probe_instance_lock(data_dir) == "FREE", "fixture cleanup failed: holder did not release the lock"


def test_headless_start_with_unheld_data_dir_proceeds_and_leaves_lock_free(tmp_path, monkeypatch, capsys):
    data_dir = tmp_path / "free-data"
    data_dir.mkdir()
    assert probe_instance_lock(data_dir) == "FREE", "fixture control failed: fresh data dir not free"

    exit_code, calls, _ = _run_headless_main(monkeypatch, data_dir)
    captured = capsys.readouterr()

    assert exit_code is None
    assert calls == ["_prepare_server_start", "run_server"]
    assert ALREADY_RUNNING_MESSAGE not in captured.err
    # Normal return from the serving stage is a normal shutdown: the lock must not stay held.
    assert probe_instance_lock(data_dir) == "FREE"


def test_instance_lock_held_for_another_data_dir_does_not_block_start(tmp_path, monkeypatch, capsys):
    other_dir = tmp_path / "other-data"
    own_dir = tmp_path / "own-data"
    other_dir.mkdir()
    own_dir.mkdir()

    with hold_instance_lock(other_dir) as holder:
        assert probe_instance_lock(other_dir) == "BUSY", "fixture control failed (not RED): lock not observed busy"
        assert probe_instance_lock(own_dir) == "FREE", "fixture control failed: own data dir not free"

        exit_code, calls, _ = _run_headless_main(monkeypatch, own_dir)
        captured = capsys.readouterr()

        assert exit_code is None
        assert calls == ["_prepare_server_start", "run_server"]
        assert ALREADY_RUNNING_MESSAGE not in captured.err
        assert holder.is_alive()
        assert probe_instance_lock(other_dir) == "BUSY"
