"""Executable policy contracts for the Android release signing boundary."""

from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts/check-android-signing-boundary.py"
WORKFLOW = Path(".github/workflows/build-android.yml")


def run_checker(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECKER), "--root", str(root)],
        capture_output=True,
        check=False,
        text=True,
    )


def fixture_root(tmp_path: Path) -> Path:
    target = tmp_path / "repo"
    shutil.copytree(ROOT / ".github", target / ".github")
    return target


def mutate(root: Path, old: str, new: str) -> None:
    path = root / WORKFLOW
    body = path.read_text(encoding="utf-8")
    assert old in body
    path.write_text(body.replace(old, new, 1), encoding="utf-8")


def test_current_android_signing_boundary_passes():
    result = run_checker(ROOT)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "Android signing boundary check passed" in result.stdout


def test_signing_reference_outside_release_job_fails(tmp_path):
    root = fixture_root(tmp_path)
    mutate(
        root,
        "  build-pr:\n",
        "  signing-leak:\n"
        "    runs-on: ubuntu-latest\n"
        "    env:\n"
        "      LEAK: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n"
        "    steps:\n"
        "      - run: test -n \"$LEAK\"\n\n"
        "  build-pr:\n",
    )

    result = run_checker(root)

    assert result.returncode == 1
    assert "job signing-leak references Android signing secrets" in result.stdout


def test_release_job_without_environment_fails(tmp_path):
    root = fixture_root(tmp_path)
    mutate(root, "    environment: android-release\n", "")

    result = run_checker(root)

    assert result.returncode == 1
    assert "must bind the android-release environment" in result.stdout


def test_release_job_without_exact_tag_guard_fails(tmp_path):
    root = fixture_root(tmp_path)
    mutate(
        root,
        "    if: startsWith(github.ref, 'refs/tags/v')\n",
        "    if: github.event_name == 'push'\n",
    )

    result = run_checker(root)

    assert result.returncode == 1
    assert "must use the exact version-tag guard" in result.stdout


def test_mutable_action_reference_fails(tmp_path):
    root = fixture_root(tmp_path)
    mutate(
        root,
        "uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4",
        "uses: actions/checkout@v4",
    )

    result = run_checker(root)

    assert result.returncode == 1
    assert "action must be pinned to a full commit SHA" in result.stdout


def test_contents_write_outside_release_job_fails(tmp_path):
    root = fixture_root(tmp_path)
    mutate(
        root,
        "  build-pr:\n",
        "  publishing-leak:\n"
        "    runs-on: ubuntu-latest\n"
        "    permissions:\n"
        "      contents: write\n"
        "    steps:\n"
        "      - run: true\n\n"
        "  build-pr:\n",
    )

    result = run_checker(root)

    assert result.returncode == 1
    assert "contents: write outside the Android release job" in result.stdout
