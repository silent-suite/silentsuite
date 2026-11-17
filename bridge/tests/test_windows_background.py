"""Windows --background mode: the bridge must outlive the terminal that started it."""

import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config, windows_background as wb

BINARY = ["C:\\Users\\Test User\\AppData\\Local\\SilentSuite\\silentsuite-bridge.exe"]


def _installer_fixture_diagnostics(root, result):
    def as_text(value):
        return value.decode("utf-8", "replace") if isinstance(value, bytes) else value or ""

    parts = [f"PowerShell exit: {result.returncode}",
             "stdout:\n" + as_text(result.stdout), "stderr:\n" + as_text(result.stderr)]
    paths = [root / "result.json", root / "install.log", root / "steps.log"]
    paths.extend(sorted(root.glob("process-*.log")))
    for path in paths:
        try:
            content = path.read_text(encoding="utf-8-sig", errors="replace") if path.exists() else "<not written>"
        except OSError as exc:
            content = f"<could not read: {exc}>"
        parts.append(path.name + ":\n" + content)
    return "\n\n".join(parts)


@pytest.mark.skipif(sys.platform != "win32", reason="requires native Windows executable handles")
@pytest.mark.parametrize("mode", ["success", "swap-failed", "backup-failed", "start-failed", "stop-failed", "restore-failed",
                                  "fresh-slow", "upgrade-slow", "cleanup-failed"])
def test_windows_installer_replaces_only_its_running_target(tmp_path, mode):
    fixture = Path(__file__).with_name("windows_installer_fixture.ps1")
    installer = Path(__file__).resolve().parents[1] / "install.ps1"
    # A pwsh parent exports its module path; the child uses Windows PowerShell 5.1.
    env = {key: value for key, value in os.environ.items() if key.upper() != "PSMODULEPATH"}
    env.update(TEMP=str(tmp_path), TMP=str(tmp_path), CI="1")
    env["PSModulePath"] = str(Path(os.environ["SystemRoot"]) / "System32" / "WindowsPowerShell" / "v1.0" / "Modules")
    command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
               "-File", str(fixture), "-Installer", str(installer), "-Root", str(tmp_path), "-Mode", mode]
    try:
        result = subprocess.run(command, env=env, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=120)
    except subprocess.TimeoutExpired as exc:
        result = subprocess.CompletedProcess(command, -1, exc.stdout, exc.stderr)
    diagnostics = _installer_fixture_diagnostics(tmp_path, result)
    try:
        assert result.returncode == 0
        receipt = json.loads((tmp_path / "result.json").read_text(encoding="utf-8-sig"))
        assert receipt["OtherAlive"], ("a different installation must remain running", receipt)
        assert receipt["Failed"] == (mode not in {"success", "fresh-slow", "cleanup-failed"}), receipt
        if mode in {"success", "cleanup-failed"}:
            assert not receipt["Failed"], "upgrade failed while the installed executable was running"
            assert receipt["OldExited"] and receipt["InstalledNew"] and receipt["TargetRunning"], receipt
            if mode == "cleanup-failed":
                assert receipt["Injected"] and receipt["OldBackupRetained"], receipt
                assert "backup could not be removed" in result.stdout
        elif mode == "fresh-slow":
            assert not receipt["HadOld"] and receipt["InstalledNew"] and receipt["TargetRunning"], receipt
            assert "dashboard did not respond yet" in result.stdout
        elif mode == "restore-failed":
            assert receipt["RestoreFailures"] >= 2, receipt
            assert receipt["OldBackupRetained"], "failed restoration must retain the previous executable"
        else:
            if mode in {"swap-failed", "backup-failed"}:
                assert receipt["Injected"] and receipt["OldExited"], receipt
            elif mode == "stop-failed":
                assert not receipt["OldExited"], receipt
            assert receipt["InstalledOld"], "a failed replacement must leave the previous bytes installed"
            assert receipt["TargetRunning"], "restore the previously running bridge after rollback"
    except (AssertionError, ValueError, OSError, KeyError) as exc:
        # Explicit text avoids pytest abbreviating the receipt dictionary.
        print(diagnostics, flush=True)
        raise AssertionError(f"Windows installer mode {mode}: {exc}\n\n{diagnostics}") from None


class FakeProcess:
    def __init__(self, exit_after_polls=None, code=3):
        self.pid = 4242
        self._polls = 0
        self._exit_after = exit_after_polls
        self._code = code

    def poll(self):
        self._polls += 1
        if self._exit_after is not None and self._polls > self._exit_after:
            return self._code
        return None


class FakePopen:
    def __init__(self, process=None, refuse_breakaway=False):
        self.calls = []
        self.process = process or FakeProcess()
        self.refuse_breakaway = refuse_breakaway

    def __call__(self, args, creationflags=0, **kwargs):
        self.calls.append((args, creationflags, kwargs))
        if self.refuse_breakaway and creationflags & wb.CREATE_BREAKAWAY_FROM_JOB:
            raise PermissionError(5, "Access is denied")
        return self.process


@pytest.fixture
def bg(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.delenv("SILENTSUITE_LOG_FILE", raising=False)
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--background"])
    return tmp_path


def answers_after(n):
    state = {"calls": 0}

    def probe(_address, _port):
        state["calls"] += 1
        return state["calls"] > n

    return probe


def test_background_starts_windowless_detached_copy_and_returns(bg, capsys):
    popen = FakePopen()

    rc = wb.start_background(BINARY, popen=popen, listener_answers=answers_after(2), sleep=lambda _s: None)

    assert rc == 0
    assert len(popen.calls) == 1
    args, flags, kwargs = popen.calls[0]
    assert args == BINARY + [wb.CHILD_FLAG]
    assert flags & wb.CREATE_NO_WINDOW
    assert flags & wb.CREATE_NEW_PROCESS_GROUP
    assert flags & wb.CREATE_BREAKAWAY_FROM_JOB
    for stream in ("stdin", "stdout", "stderr"):
        assert kwargs[stream] == subprocess.DEVNULL
    assert kwargs["env"]["SILENTSUITE_LOG_FILE"] == os.path.join(str(bg), "bridge.log")
    out = capsys.readouterr().out
    assert "Closing this window does not stop it" in out
    assert "Process ID: 4242" in out


def test_background_keeps_an_explicit_log_file_and_passes_no_tray(bg, monkeypatch):
    monkeypatch.setenv("SILENTSUITE_LOG_FILE", "D:\\logs\\bridge.log")
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--background", "--no-tray"])
    popen = FakePopen()

    wb.start_background(BINARY, popen=popen, listener_answers=answers_after(1), sleep=lambda _s: None)

    args, _flags, kwargs = popen.calls[0]
    assert args == BINARY + [wb.CHILD_FLAG, "--no-tray"]
    assert kwargs["env"]["SILENTSUITE_LOG_FILE"] == "D:\\logs\\bridge.log"


def test_background_retries_without_breakaway_when_the_job_refuses_it(bg):
    popen = FakePopen(refuse_breakaway=True)

    rc = wb.start_background(BINARY, popen=popen, listener_answers=answers_after(1), sleep=lambda _s: None)

    assert rc == 0
    assert len(popen.calls) == 2
    second_flags = popen.calls[1][1]
    assert not second_flags & wb.CREATE_BREAKAWAY_FROM_JOB
    assert second_flags & wb.CREATE_NO_WINDOW


def test_background_does_not_start_a_second_copy(bg, capsys):
    popen = FakePopen()

    rc = wb.start_background(BINARY, popen=popen, listener_answers=lambda _a, _p: True)

    assert rc == 0
    assert popen.calls == []
    assert "already running" in capsys.readouterr().out


def test_background_reports_a_copy_that_exits_right_away(bg, capsys):
    popen = FakePopen(process=FakeProcess(exit_after_polls=0, code=3))

    rc = wb.start_background(BINARY, popen=popen, listener_answers=lambda _a, _p: False, sleep=lambda _s: None)

    assert rc == 1
    err = capsys.readouterr().err
    assert "exit code 3" in err
    assert os.path.join(str(bg), "bridge.log") in err


def test_background_returns_at_the_deadline_while_the_copy_still_runs(bg, capsys):
    popen = FakePopen()
    now = {"t": 0.0}

    def clock():
        now["t"] += 1.0
        return now["t"]

    rc = wb.start_background(
        BINARY, popen=popen, listener_answers=lambda _a, _p: False, sleep=lambda _s: None, clock=clock, timeout=5
    )

    assert rc == 0
    assert "not answering yet" in capsys.readouterr().out


def test_background_probes_loopback_for_a_wildcard_bind(bg, monkeypatch):
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "0.0.0.0")
    assert wb._probe_address() == ("127.0.0.1", 37358)
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "::")
    assert wb._probe_address() == ("::1", 37358)


def test_background_withholds_the_dashboard_address_from_non_interactive_output(bg, monkeypatch, capsys):
    monkeypatch.setattr(wb, "address_detail_enabled", lambda: False)

    wb.start_background(BINARY, popen=FakePopen(), listener_answers=answers_after(1), sleep=lambda _s: None)

    out = capsys.readouterr().out
    assert "37358" not in out
    assert wb.ADDRESS_WITHHELD_NOTE in out


def test_main_refuses_background_outside_windows(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--background"])
    monkeypatch.setattr(bridge_main, "configure_logging", lambda: None)
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "get_platform", lambda: "linux")
    monkeypatch.setattr(wb, "start_background", lambda *_a, **_k: pytest.fail("must not spawn"))

    with pytest.raises(SystemExit) as exc:
        bridge_main.main()

    assert exc.value.code == 1
    assert "only available on Windows" in capsys.readouterr().err


def test_main_hands_background_to_the_spawner_on_windows(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--background"])
    monkeypatch.setattr(bridge_main, "configure_logging", lambda: None)
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "get_platform", lambda: "windows")
    seen = []
    monkeypatch.setattr(wb, "start_background", lambda args: seen.append(args) or 0)
    monkeypatch.setattr(bridge_main, "_prepare_server_start", lambda: pytest.fail("parent must not serve"))

    with pytest.raises(SystemExit) as exc:
        bridge_main.main()

    assert exc.value.code == 0
    assert len(seen) == 1


def test_main_runs_the_server_in_the_background_copy(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", wb.CHILD_FLAG])
    monkeypatch.setattr(bridge_main, "configure_logging", lambda: None)
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "get_platform", lambda: "windows")
    monkeypatch.setattr(wb, "start_background", lambda *_a, **_k: pytest.fail("child must not spawn again"))
    monkeypatch.setattr(bridge_main, "_prepare_server_start", lambda: True)
    served = []
    monkeypatch.setattr(bridge_main, "run_server", lambda: served.append(True))

    bridge_main.main()

    assert served == [True]


# --- Native Windows check: the bridge survives the terminal's job being closed ---


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _kill_on_close_job():
    """A job like a terminal's: everything still in it dies when its handle closes."""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
        )]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimits),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    job = kernel32.CreateJobObjectW(None, None)
    assert job, ctypes.get_last_error()
    limits = ExtendedLimits()
    # KILL_ON_JOB_CLOSE | BREAKAWAY_OK
    limits.BasicLimitInformation.LimitFlags = 0x2000 | 0x0800
    ok = kernel32.SetInformationJobObject(
        wintypes.HANDLE(job), 9, ctypes.byref(limits), ctypes.sizeof(limits)
    )
    assert ok, ctypes.get_last_error()
    return kernel32, job


@pytest.mark.skipif(sys.platform != "win32", reason="native process/job check runs on Windows only")
def test_background_bridge_survives_closing_the_terminal_job(tmp_path):
    from ctypes import wintypes

    port = _free_port()
    noop_browser = tmp_path / "noop-browser.cmd"
    noop_browser.write_text("@exit /b 0\r\n", encoding="ascii")
    env = dict(os.environ)
    env.update(
        SILENTSUITE_DATA_DIR=str(tmp_path / "data"),
        SILENTSUITE_LISTEN_PORT=str(port),
        SILENTSUITE_LOG_FILE=str(tmp_path / "bridge.log"),
        # The zero-account dashboard opens a browser; keep CI from launching one.
        BROWSER=str(noop_browser),
    )
    kernel32, job = _kill_on_close_job()
    parent = subprocess.Popen(
        [sys.executable, "-m", "silentsuite_bridge", "--background", "--no-tray"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        creationflags=subprocess.CREATE_NEW_CONSOLE,
    )
    pid = None
    try:
        assert kernel32.AssignProcessToJobObject(wintypes.HANDLE(job), wintypes.HANDLE(int(parent._handle)))
        out, _ = parent.communicate(timeout=90)
        assert parent.returncode == 0, out
        assert "Closing this window does not stop it" in out, out
        pid = int(re.search(r"Process ID: (\d+)", out).group(1))

        # Closing the job is what a terminal does to the processes it started.
        kernel32.CloseHandle(wintypes.HANDLE(job))
        job = None
        time.sleep(3)

        with socket.create_connection(("127.0.0.1", port), timeout=5):
            pass
        assert (tmp_path / "bridge.log").exists()
    finally:
        if job is not None:
            kernel32.CloseHandle(wintypes.HANDLE(job))
        if parent.poll() is None:
            parent.kill()
        if pid is not None:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], check=False, capture_output=True)
