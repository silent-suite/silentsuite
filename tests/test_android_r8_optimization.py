"""Static contracts for basic (non-full-mode) R8 optimisation of the Android app.

Both minified build types select AGP's optimising default rules, so the debug
APK exercised by instrumentation and the release artifacts are optimised alike.
The surrounding R8 policy (compat mode, no obfuscation, the broad app keep, no
resource shrinking, debug-only test rules) stays as it was, and CI inspects the
effective release configuration that R8 actually merged.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
APP_BUILD_GRADLE = ROOT / "android/app/build.gradle"
GRADLE_PROPERTIES = ROOT / "android/gradle.properties"
APP_RULES = ROOT / "android/app/proguard-rules.txt"
DEBUG_TEST_RULES = ROOT / "android/app/proguard-debug-test-rules.pro"
ANDROID_CI_WORKFLOW = ROOT / ".github/workflows/build-android.yml"

APP_KEEP = "-keep,includedescriptorclasses class io.silentsuite.sync.** { *; }"
INSPECTION_STEP = "Inspect effective release R8 configuration"
RELEASE_BUILD_STEP = "Build debug APK and unsigned release APK/AAB"
EFFECTIVE_REPORTS = ("configuration.txt", "seeds.txt", "usage.txt")
REPORT_DIR = "app/build/outputs/mapping/release"
EVIDENCE_DIR = "build/privacy-evidence/r8-release"


def gradle_block(text: str, keyword: str) -> str:
    match = re.search(rf"^\s*{re.escape(keyword)}\s*\{{", text, flags=re.MULTILINE)
    assert match is not None, f"missing Gradle block: {keyword}"
    depth = 0
    for index in range(match.end() - 1, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[match.end() : index]
    raise AssertionError(f"unterminated Gradle block: {keyword}")


def build_type_block(build_type: str) -> str:
    build_types = gradle_block(APP_BUILD_GRADLE.read_text(encoding="utf-8"), "buildTypes")
    return gradle_block(build_types, build_type)


def active_directives(path: Path) -> list[str]:
    """Non-empty lines with trailing `#` comments and surrounding whitespace removed."""

    lines = (line.split("#", 1)[0].strip() for line in path.read_text(encoding="utf-8").splitlines())
    return [line for line in lines if line]


def build_pr_steps() -> dict[str, dict[str, object]]:
    workflow = yaml.load(ANDROID_CI_WORKFLOW.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
    return {step["name"]: step for step in workflow["jobs"]["build-pr"]["steps"]}


def inspection_step() -> dict[str, object]:
    steps = build_pr_steps()
    assert INSPECTION_STEP in steps, f"build-pr has no {INSPECTION_STEP!r} step"
    return steps[INSPECTION_STEP]


# --- The change: optimising default rules in both minified build types ---


@pytest.mark.parametrize("build_type", ["debug", "release"])
def test_build_type_selects_r8_optimizing_default_rules(build_type):
    block = build_type_block(build_type)
    assert "getDefaultProguardFile('proguard-android-optimize.txt')" in block, (
        f"{build_type} must select proguard-android-optimize.txt (basic R8 optimisation)"
    )
    assert "proguard-android.txt" not in block


# --- Preserved R8 policy ---


@pytest.mark.parametrize("build_type", ["debug", "release"])
def test_build_type_stays_minified_with_app_test_rules(build_type):
    block = build_type_block(build_type)
    assert re.search(r"^\s*minifyEnabled\s+true\s*$", block, flags=re.MULTILINE)
    assert "testProguardFile 'proguard-rules.txt'" in block
    assert "'proguard-rules.txt'" in block.split("testProguardFile", 1)[0]


def test_debug_test_rules_apply_to_debug_only():
    assert "'proguard-debug-test-rules.pro'" in build_type_block("debug")
    assert "proguard-debug-test-rules.pro" not in build_type_block("release")


def test_r8_full_mode_stays_disabled():
    assert "android.enableR8.fullMode=false" in active_directives(GRADLE_PROPERTIES)


def test_app_rules_keep_obfuscation_off_and_the_broad_app_keep():
    directives = active_directives(APP_RULES)
    assert "-dontobfuscate" in directives
    assert APP_KEEP in directives


@pytest.mark.parametrize("rules", [APP_RULES, DEBUG_TEST_RULES], ids=lambda path: path.name)
def test_app_rules_do_not_disable_optimisation(rules):
    assert not any(
        directive.split()[0] == "-dontoptimize" for directive in active_directives(rules)
    ), f"{rules.name} must not cancel R8 optimisation"


def test_resource_shrinking_stays_off():
    assert "shrinkResources" not in APP_BUILD_GRADLE.read_text(encoding="utf-8")


# --- CI inspection of the effective (merged) release configuration ---


def test_build_pr_inspects_effective_release_r8_configuration():
    step = inspection_step()
    ordered = list(build_pr_steps())
    position = ordered.index(INSPECTION_STEP)
    # It reads what the release build just produced and stages it into the
    # privacy evidence that the existing tracker upload publishes.
    assert ordered.index(RELEASE_BUILD_STEP) < position
    assert position < ordered.index("Upload tracker verification evidence")
    run = step["run"]
    assert "set -euo pipefail" in run
    assert REPORT_DIR in run
    for report in EFFECTIVE_REPORTS:
        assert report in run, f"the inspection must require {report}"
    assert "test -s" in run
    assert "-dontoptimize" in run
    assert EVIDENCE_DIR in run


def write_reports(directory: Path, configuration: str, omit: str | None = None) -> None:
    reports = directory / REPORT_DIR
    reports.mkdir(parents=True)
    contents = {
        "configuration.txt": configuration,
        "seeds.txt": "com.etebase.client.Client\n",
        "usage.txt": "com.example.Unused\n",
    }
    for name, text in contents.items():
        if name != omit:
            (reports / name).write_text(text, encoding="utf-8")


def run_inspection(directory: Path) -> subprocess.CompletedProcess:
    run = inspection_step()["run"]
    assert "${{" not in run, "the inspection must not interpolate workflow expressions"
    bash = shutil.which("bash")
    assert bash is not None, "bash is required to exercise the inspection step"
    return subprocess.run([bash, "-c", run], cwd=directory, capture_output=True, text=True)


def test_release_r8_inspection_step_fails_closed(tmp_path):
    accepted = tmp_path / "accepted"
    write_reports(
        accepted,
        "# proguard-android.txt once carried -dontoptimize\n-keep class a.B { *; }\n",
    )
    result = run_inspection(accepted)
    assert result.returncode == 0, result.stderr
    for report in EFFECTIVE_REPORTS:
        assert (accepted / EVIDENCE_DIR / report).is_file(), report

    global_dontoptimize = tmp_path / "global-dontoptimize"
    write_reports(global_dontoptimize, "-keep class a.B { *; }\n  -dontoptimize\n")
    assert run_inspection(global_dontoptimize).returncode != 0

    for report in EFFECTIVE_REPORTS:
        missing = tmp_path / f"missing-{report}"
        write_reports(missing, "-keep class a.B { *; }\n", omit=report)
        assert run_inspection(missing).returncode != 0, f"missing {report} was accepted"
