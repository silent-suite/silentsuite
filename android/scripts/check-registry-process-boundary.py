#!/usr/bin/env python3
"""Exact result inventory for run-registry-process-boundary.sh.

Reads one raw `am instrument -w -r` transcript per step, fails closed on a missing, extra, failed,
crashed or duplicated step, and always writes a truthful inventory.json before exiting.
"""

import json
import pathlib
import re
import sys

TEST_CLASS = "io.silentsuite.sync.ui.setup.RegistryProcessBoundaryRuntimeTest"
EXPECTED_STEPS = (
    ("empty-write", "writerCommitsEmptyRegistryThroughProductionStore"),
    ("empty-read", "readerLoadsEmptyRegistryInFreshProcess"),
    ("populated-write", "writerCommitsEveryPhaseThroughProductionStore"),
    ("populated-read", "readerLoadsEveryPhaseInFreshProcess"),
    ("reinstall-write", "writerCommitsEveryPhaseThroughProductionStore"),
    ("reinstall-read", "readerLoadsEveryPhaseInFreshProcess"),
)
REINSTALL_FILES = ("reinstall-before.txt", "reinstall-install.txt", "reinstall-after.txt")
REINSTALL_EXIT = "reinstall-install.exit"
INVENTORY = "inventory.json"


def exit_problem(path):
    """The runner records each command's exit status; a timeout is a failure, never a pass."""
    if not path.is_file():
        return "missing command exit status"
    value = path.read_text(encoding="utf-8", errors="replace").strip()
    if value in ("124", "137"):
        return f"command timed out (exit {value})"
    return None if value == "0" else f"command exited {value!r}"


def step_problem(text, method):
    """Returns None when the transcript shows exactly this one method started and passed."""
    lines = [line.strip() for line in text.replace("\r", "").split("\n")]
    classes = {line.split("=", 1)[1] for line in lines if line.startswith("INSTRUMENTATION_STATUS: class=")}
    tests = {line.split("=", 1)[1] for line in lines if line.startswith("INSTRUMENTATION_STATUS: test=")}
    codes = [line.split(": ", 1)[1] for line in lines if line.startswith("INSTRUMENTATION_STATUS_CODE: ")]
    if any(marker in text for marker in ("INSTRUMENTATION_FAILED", "INSTRUMENTATION_ABORTED", "Process crashed", "FAILURES!!!")):
        return "instrumentation reported a failure or crash"
    if classes != {TEST_CLASS} or tests != {method}:
        return f"unexpected executed tests: {sorted(classes)} {sorted(tests)}"
    if codes != ["1", "0"]:
        return f"unexpected status codes: {codes}"
    if "INSTRUMENTATION_CODE: -1" not in lines or "OK (1 test)" not in lines:
        return "missing successful single-test completion"
    return None


def install_times(text):
    return dict(re.findall(r"^(firstInstallTime|lastUpdateTime)=(.+)$", text.replace("\r", ""), flags=re.M))


def reinstall_problem(before, install, after):
    """The reinstall must succeed in place: same first install, newer update, data kept."""
    if "Success" not in install:
        return "in-place reinstall did not report Success"
    old, new = install_times(before), install_times(after)
    if set(old) != {"firstInstallTime", "lastUpdateTime"} or set(new) != set(old):
        return "missing package install times"
    if old["firstInstallTime"] != new["firstInstallTime"]:
        return "package was not updated in place"
    if old["lastUpdateTime"] == new["lastUpdateTime"]:
        return "package update time did not change"
    return None


def evaluate(directory, api):
    directory = pathlib.Path(directory)
    steps = []
    for step, method in EXPECTED_STEPS:
        path = directory / f"{step}.txt"
        problem = exit_problem(directory / f"{step}.exit") or (
            "missing transcript" if not path.is_file() else step_problem(
                path.read_text(encoding="utf-8", errors="replace"), method))
        steps.append({"step": step, "test": f"{TEST_CLASS}#{method}", "outcome": "FAIL" if problem else "PASS",
                      "problem": problem})
    texts = [(directory / name).read_text(encoding="utf-8", errors="replace") if (directory / name).is_file() else ""
             for name in REINSTALL_FILES]
    reinstall = exit_problem(directory / REINSTALL_EXIT) or reinstall_problem(*texts)
    allowed = {f"{step}.{suffix}" for step, _ in EXPECTED_STEPS for suffix in ("txt", "exit")}
    allowed |= set(REINSTALL_FILES) | {REINSTALL_EXIT, INVENTORY}
    extra = sorted(path.name for path in directory.iterdir() if path.name not in allowed)
    passed = all(item["outcome"] == "PASS" for item in steps) and reinstall is None and not extra
    return {
        "api": int(api),
        "extraFiles": extra,
        "outcome": "PASS" if passed else "FAIL",
        "reinstall": {"outcome": "FAIL" if reinstall else "PASS", "problem": reinstall},
        "schema": 1,
        "steps": steps,
    }


def main(argv):
    if len(argv) != 3:
        raise SystemExit("usage: check-registry-process-boundary.py OUTPUT_DIR API_LEVEL")
    inventory = evaluate(argv[1], argv[2])
    (pathlib.Path(argv[1]) / INVENTORY).write_text(
        json.dumps(inventory, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps(inventory, sort_keys=True, indent=2))
    return 0 if inventory["outcome"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
