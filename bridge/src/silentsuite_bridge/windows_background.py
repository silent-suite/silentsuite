"""Run the bridge on Windows without a console window.

The Windows release binary is a console program, so a bridge started from a
terminal (or from the sign-in Run entry) stops when that window is closed.
``--background`` starts a second copy of the bridge with no window, its own
process group and, where the surrounding job allows it, outside the
terminal's job object, then returns. The background copy logs to
``bridge.log`` in the data directory unless SILENTSUITE_LOG_FILE is set.

Usage:
    silentsuite-bridge --background
"""

import os
import socket
import subprocess
import sys
import time

from . import config
from .operator_output import ADDRESS_WITHHELD_NOTE, address_detail_enabled

BACKGROUND_FLAG = "--background"
# Internal: marks the windowless copy so it runs the server instead of
# spawning again. Not listed in --help.
CHILD_FLAG = "--background-child"

# Win32 process creation flags (values from the Windows SDK; subprocess only
# exposes some of them, and not on other platforms).
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
CREATE_NO_WINDOW = 0x08000000

_START_TIMEOUT = 30.0
_POLL_SECONDS = 0.25
LOG_FILE_NAME = "bridge.log"


def child_argv(binary_args, argv=None) -> list[str]:
    argv = sys.argv if argv is None else argv
    args = list(binary_args) + [CHILD_FLAG]
    if "--no-tray" in argv:
        args.append("--no-tray")
    return args


def default_log_file() -> str:
    return os.path.join(config.DATA_DIR, LOG_FILE_NAME)


def _probe_address() -> tuple[str, int]:
    address = config.LISTEN_ADDRESS
    if address in ("0.0.0.0", ""):
        address = "127.0.0.1"
    elif address == "::":
        address = "::1"
    return address, int(config.LISTEN_PORT)


def _listener_answers(address: str, port: int) -> bool:
    try:
        with socket.create_connection((address, port), timeout=1.0):
            return True
    except OSError:
        return False


def _spawn(args, env, popen):
    base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    kwargs = dict(
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    try:
        return popen(args, creationflags=base | CREATE_BREAKAWAY_FROM_JOB, **kwargs)
    except PermissionError:
        # The terminal's job does not allow breakaway. The windowless copy
        # still has its own console, so closing the terminal window does not
        # signal it.
        return popen(args, creationflags=base, **kwargs)


def _dashboard_text(address: str, port: int) -> str:
    if not address_detail_enabled():
        return ADDRESS_WITHHELD_NOTE
    host = f"[{address}]" if ":" in address else address
    scheme = "https" if config.SSL_ENABLED else "http"
    return f"Dashboard: {scheme}://{host}:{port}/"


def start_background(
    binary_args,
    popen=subprocess.Popen,
    listener_answers=_listener_answers,
    sleep=time.sleep,
    clock=time.monotonic,
    timeout=_START_TIMEOUT,
) -> int:
    """Start a windowless bridge and wait (bounded) until it answers.

    Returns 0 when a bridge answers on the configured listener (including one
    that was already running) or the new process is still running at the
    deadline; 1 when the new process exited or could not be started.
    """
    address, port = _probe_address()
    if listener_answers(address, port):
        print("A bridge is already running; no second copy was started.")
        print(_dashboard_text(address, port))
        return 0

    env = dict(os.environ)
    log_file = env.get("SILENTSUITE_LOG_FILE") or default_log_file()
    env["SILENTSUITE_LOG_FILE"] = log_file

    try:
        process = _spawn(child_argv(binary_args), env, popen)
    except OSError:
        print("Error: could not start the bridge in the background.", file=sys.stderr)
        return 1

    deadline = clock() + timeout
    while True:
        code = process.poll()
        if code is not None:
            print(
                f"Error: the background bridge stopped right after starting (exit code {code}).",
                file=sys.stderr,
            )
            print(f"Check the log: {log_file}", file=sys.stderr)
            return 1
        if listener_answers(address, port):
            print("The bridge is running in the background. Closing this window does not stop it.")
            break
        if clock() >= deadline:
            print("The bridge started in the background but is not answering yet.")
            break
        sleep(_POLL_SECONDS)

    print(f"Process ID: {process.pid}")
    print(_dashboard_text(address, port))
    print(f"Log: {log_file}")
    print("To stop it, use Quit in the tray icon menu or end silentsuite-bridge.exe in Task Manager.")
    return 0
