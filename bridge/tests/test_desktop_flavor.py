"""T2/T4 entrypoint contract (#171): desktop flavor refuses the binary updater.

The CLI updater replaces ``sys.executable`` with the CLI release asset
(update/replace.py, update/platform.py). An installed desktop bundle must
therefore refuse ``--check-update`` and ``--self-update`` before the updater
is imported or called, while the default CLI flavor keeps its updater.

No Qt is needed: the refusal happens before any GUI work.
"""

import sys

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import update as update_package

DESKTOP_UPDATE_REFUSAL = "is updated by installing the new desktop package"


class _UpdaterCalled(Exception):
    pass


def _trap_updater(monkeypatch):
    calls = []

    def record(name):
        def called(*_args, **_kwargs):
            calls.append(name)
            raise _UpdaterCalled(name)
        return called

    monkeypatch.setattr(update_package, "check_for_update", record("check_for_update"))
    monkeypatch.setattr(update_package, "perform_update", record("perform_update"))
    return calls


def _run_main(monkeypatch, argv, **kwargs):
    monkeypatch.setattr(sys, "argv", argv)
    try:
        bridge_main.main(**kwargs)
    except SystemExit as exc:
        return exc.code
    except TypeError as exc:
        at_call = exc.__traceback__ is not None and exc.__traceback__.tb_next is None
        if kwargs and at_call and "flavor" in str(exc):
            pytest.fail("desktop entrypoint missing: main() does not accept flavor='desktop'")
        raise
    return None


@pytest.mark.parametrize("flag", ["--check-update", "--self-update"])
def test_desktop_flavor_refuses_the_binary_updater_before_calling_it(monkeypatch, capsys, flag):
    calls = _trap_updater(monkeypatch)

    code = _run_main(monkeypatch, ["silentsuite-bridge", flag], flavor="desktop")
    captured = capsys.readouterr()

    assert calls == []
    assert code == 1
    assert DESKTOP_UPDATE_REFUSAL in captured.err


@pytest.mark.parametrize("flag,expected", [("--check-update", "check_for_update"), ("--self-update", "perform_update")])
def test_cli_flavor_still_reaches_the_updater(monkeypatch, capsys, flag, expected):
    # Control: the default (CLI) entrypoint keeps today's updater behaviour.
    calls = _trap_updater(monkeypatch)

    code = _run_main(monkeypatch, ["silentsuite-bridge", flag])
    captured = capsys.readouterr()

    assert calls == [expected]
    assert code == 1
    assert DESKTOP_UPDATE_REFUSAL not in captured.err
