"""CLI tests: unknown options are refused instead of starting the bridge."""

import inspect
import re
import sys

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import windows_background

KNOWN = bridge_main._FLAG_OPTIONS | bridge_main._VALUE_OPTIONS


def _run_main(argv, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", *argv])

    def _no_start(*_args, **_kwargs):
        raise AssertionError("an unknown option must not start the bridge")

    monkeypatch.setattr(bridge_main, "configure_logging", _no_start)
    monkeypatch.setattr(bridge_main, "run_server", _no_start)
    with pytest.raises(SystemExit) as exc:
        bridge_main.main()
    return exc.value.code


@pytest.mark.parametrize(
    "argv, shown",
    [
        (["--foo"], "--foo"),
        (["--lgout"], "--lgout"),
        (["--no-tray", "--lgout", "alice@example.com"], "--lgout"),
        (["--server=https://example.test"], "--server"),
        (["--server", "https://example.test", "--foo"], "--foo"),
        (["--logout", "--foo"], "--foo"),
        (["login"], "login"),
        (["-x"], "-x"),
    ],
)
def test_unknown_option_exits_2_without_starting(argv, shown, monkeypatch, capsys):
    code = _run_main(argv, monkeypatch)

    captured = capsys.readouterr()
    assert code == 2
    assert captured.err == f"Unknown option {shown}. Run silentsuite-bridge --help.\n"
    assert captured.out == ""


@pytest.mark.parametrize(
    "argv",
    [
        [],
        *[[flag] for flag in sorted(bridge_main._FLAG_OPTIONS)],
        ["--server", "https://example.test"],
        ["--server", "https://example.test", "--login"],
        ["--logout", "alice@example.com"],
        ["--remove-account", "alice@example.com"],
        ["--setup-macos-apple-accounts", "--dns-san", "bridge.local",
         "--ip-san", "192.0.2.10", "--replace-existing"],
        # Missing values stay with each option's own error message.
        ["--logout"],
        ["--server"],
        # Installer, service and Run-entry shapes.
        ["--no-tray"],
        ["--background"],
        windows_background.child_argv([], argv=["silentsuite-bridge", "--background", "--no-tray"]),
        # Arguments the OS or a frozen runtime may add.
        ["-psn_0_12345"],
        ["--multiprocessing-fork", "parent_pid=1", "pipe_handle=2"],
    ],
)
def test_accepted_arguments(argv):
    assert bridge_main._unknown_option(argv) is None


def test_every_option_main_reads_is_known():
    literals = set(re.findall(r'"(--?[a-z][a-z-]*)"', inspect.getsource(bridge_main.main)))
    literals |= {windows_background.BACKGROUND_FLAG, windows_background.CHILD_FLAG}

    assert literals - KNOWN == set()


def test_every_option_in_help_is_known(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--help"])
    with pytest.raises(SystemExit):
        bridge_main.main()

    shown = set(re.findall(r"(?<![\w-])--[a-z][a-z-]*", capsys.readouterr().out))
    assert shown
    assert shown - KNOWN == set()
