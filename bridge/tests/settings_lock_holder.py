"""Hold the real cross-process settings lock from a separate bridge process.

Used by the #658 lost-update regression tests. A child Python process runs the
production ``config.save_settings`` against the same data directory with its
strict read patched to pause: it therefore sits *inside* the locked
read/merge/replace window holding a snapshot taken before the parent writes.
The parent can then prove that its own writer waits (or fails closed within
the bounded wait) instead of interleaving with the child's stale snapshot.

Nothing is stubbed on the lock itself: the child takes the OS-level lock on
``settings.json.lock`` exactly as a dashboard process or ``--install-autostart``
would.
"""

import contextlib
import json
import os
import subprocess
import sys
from pathlib import Path

BRIDGE_ROOT = Path(__file__).resolve().parents[1]

# The child performs a production save_settings(payload). Its strict read is
# wrapped so that, once the lock is held and the snapshot taken, it reports
# the snapshot and blocks on stdin until the parent releases it.
HOLDER_SCRIPT = """
import json
import sys
from silentsuite_bridge import config

_strict_read = config.read_settings_strict


def read_then_wait():
    snapshot = _strict_read()
    print("LOCKED " + json.dumps(snapshot), flush=True)
    sys.stdin.readline()
    return snapshot


config.read_settings_strict = read_then_wait
config.save_settings(json.loads(sys.argv[1]))
print("WRITTEN " + json.dumps(config.read_settings_strict()), flush=True)
"""

_ISOLATED_ENV = (
    "SILENTSUITE_LISTEN_ADDRESS",
    "SILENTSUITE_LISTEN_PORT",
    "SILENTSUITE_SERVER_HOSTS",
    "SILENTSUITE_ALLOW_REMOTE",
    "SILENTSUITE_BRIDGE_SSL",
    "SILENTSUITE_SSL",
    "SILENTSUITE_BRIDGE_SSL_CERT",
    "SILENTSUITE_SSL_CERT",
    "SILENTSUITE_BRIDGE_SSL_KEY",
    "SILENTSUITE_SSL_KEY",
    "XDG_DATA_HOME",
)


class LockHolder:
    """Handle on the child: ``snapshot`` it read under the lock, ``release()`` to let it write."""

    def __init__(self, process):
        self.process = process
        self.snapshot = None
        self.result = None

    def _wait_for_lock(self):
        line = self.process.stdout.readline()
        if not line.startswith("LOCKED "):
            self.process.kill()
            _, stderr = self.process.communicate(timeout=30)
            raise AssertionError(f"lock holder did not take the settings lock: {line!r}\n{stderr}")
        self.snapshot = json.loads(line[len("LOCKED "):])

    def release(self):
        """Let the child finish its write; return the CompletedProcess-like outcome."""
        if self.result is None:
            stdout, stderr = self.process.communicate("go\n", timeout=60)
            self.result = subprocess.CompletedProcess(
                self.process.args, self.process.returncode, stdout=stdout, stderr=stderr
            )
        return self.result

    @property
    def written(self):
        """Settings the child observed after its own write (parsed from its final line)."""
        result = self.release()
        for line in result.stdout.splitlines():
            if line.startswith("WRITTEN "):
                return json.loads(line[len("WRITTEN "):])
        raise AssertionError(f"lock holder did not report a write:\n{result.stdout}\n{result.stderr}")


@contextlib.contextmanager
def hold_settings_lock(data_dir, payload):
    """Run a child bridge process that holds the settings lock mid-write of ``payload``.

    ``data_dir`` must be the directory the parent's ``config.SETTINGS_FILE``
    lives in; the child resolves the same settings.json through
    SILENTSUITE_DATA_DIR. Yields once the child reports it is inside the lock.
    On exit the child is always released and reaped.
    """
    env = {name: value for name, value in os.environ.items() if name not in _ISOLATED_ENV}
    pythonpath = str(BRIDGE_ROOT / "src")
    if env.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + env["PYTHONPATH"]
    env.update({
        "SILENTSUITE_DATA_DIR": str(data_dir),
        "PYTHONPATH": pythonpath,
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    process = subprocess.Popen(
        [sys.executable, "-c", HOLDER_SCRIPT, json.dumps(payload)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    holder = LockHolder(process)
    try:
        holder._wait_for_lock()
        yield holder
    finally:
        try:
            holder.release()
        except (subprocess.TimeoutExpired, OSError, ValueError):
            process.kill()
            process.wait(timeout=30)
