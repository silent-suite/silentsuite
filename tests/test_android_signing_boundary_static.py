"""Adversarial policy contracts for the Android release signing boundary."""

from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "check-android-signing-boundary.py"
ROOT_WORKFLOW = Path(".github/workflows/build-android.yml")
SIBLING_WORKFLOW = Path("android/.github/workflows/build.yml")
POLICY_STEP = """      - name: Enforce Android signing boundary
        run: python scripts/check-android-signing-boundary.py

"""


def run_checker(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECKER), "--root", str(root)],
        check=False,
        capture_output=True,
        text=True,
    )


def fixture_root(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    shutil.copytree(ROOT / ".github", root / ".github")
    (root / SIBLING_WORKFLOW).parent.mkdir(parents=True)
    shutil.copy2(ROOT / SIBLING_WORKFLOW, root / SIBLING_WORKFLOW)
    return root


def mutate(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    assert old in text
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def assert_rejected(result: subprocess.CompletedProcess[str], needle: str) -> None:
    assert result.returncode == 1, result.stdout + result.stderr
    assert needle in result.stdout


def test_repository_workflows_satisfy_android_signing_boundary() -> None:
    result = run_checker(ROOT)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Android signing boundary check passed" in result.stdout


def test_quoted_job_with_bracket_secret_reference_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: bypass
on: pull_request
jobs:
  "quoted-leak":
    runs-on: ubuntu-latest
    env:
      LEAK: ${{ secrets['ANDROID_KEYSTORE_BASE64'] }}
    steps:
      - run: 'true'
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "job quoted-leak references Android signing secrets")


def test_computed_secret_index_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: dynamic bypass
on: pull_request
jobs:
  leak:
    runs-on: ubuntu-latest
    env:
      LEAK: ${{ secrets[format('ANDROID_{0}', 'KEYSTORE_BASE64')] }}
    steps:
      - run: 'true'
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "must not use dynamic or whole-context secret expressions")


def test_whole_secrets_context_serialization_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: whole context bypass
on: pull_request
jobs:
  leak:
    runs-on: ubuntu-latest
    env:
      ALL_SECRETS: ${{ toJSON(secrets) }}
    steps:
      - run: 'true'
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "must not use dynamic or whole-context secret expressions")


def test_workflow_scope_signing_reference_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: workflow scope bypass
on: pull_request
env:
  LEAK: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
jobs:
  harmless:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "references Android signing secrets outside a job")


def test_duplicate_yaml_keys_are_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: duplicate key bypass
on: pull_request
jobs:
  duplicate:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
  duplicate:
    runs-on: ubuntu-latest
    env:
      LEAK: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
    steps:
      - run: 'true'
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "found duplicate key 'duplicate'")


def test_yaml_anchors_and_aliases_are_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: anchor bypass
on: pull_request
defaults: &shared
  runs-on: ubuntu-latest
  steps:
    - run: 'true'
jobs:
  alias: *shared
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "YAML anchors and aliases are not allowed")


def test_reusable_workflow_secret_inheritance_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: reusable bypass
on: pull_request
jobs:
  delegate:
    uses: owner/repo/.github/workflows/release.yml@0123456789012345678901234567890123456789
    secrets: inherit
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "must not use reusable-workflow secrets: inherit")


def test_reusable_workflow_signing_secret_alias_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: reusable alias bypass
on: pull_request
jobs:
  delegate:
    uses: owner/repo/.github/workflows/release.yml@0123456789012345678901234567890123456789
    secrets:
      SIGNING_BLOB: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "job delegate references Android signing secrets")


def test_android_environment_in_another_workflow_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: environment bypass
on: pull_request
jobs:
  leak:
    runs-on: ubuntu-latest
    environment:
      name: android-release
    steps:
      - run: 'true'
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "binds android-release outside build-release")


def test_dynamic_environment_outside_release_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: dynamic environment bypass
on: pull_request
jobs:
  leak:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    steps:
      - run: 'true'
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "uses a dynamic environment outside build-release")


def test_misleading_guard_text_does_not_replace_semantic_guard(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "    if: startsWith(github.ref, 'refs/tags/v')\n",
        "    if: ${{ true }}\n    env:\n      DOCUMENTED_GUARD: \"startsWith(github.ref, 'refs/tags/v')\"\n",
    )

    assert_rejected(run_checker(root), "must use the exact semantic version-tag guard")


def test_workflow_level_write_all_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(workflow, "jobs:\n", "permissions: write-all\n\njobs:\n")

    assert_rejected(run_checker(root), "must not grant dynamic or write permissions at workflow scope")


def test_nonrelease_job_write_permission_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "  build-pr:\n    name: Build (unsigned, PR/dev/main)\n    if: github.event_name == 'pull_request' || !startsWith(github.ref, 'refs/tags/v')\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n",
        "  build-pr:\n    name: Build (unsigned, PR/dev/main)\n    if: github.event_name == 'pull_request' || !startsWith(github.ref, 'refs/tags/v')\n    runs-on: ubuntu-latest\n    permissions: write-all\n",
    )

    assert_rejected(
        run_checker(root),
        "job build-pr has dynamic or write permissions outside build-release",
    )


def test_release_job_extra_write_permission_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "    permissions:\n      contents: write\n",
        "    permissions:\n      contents: write\n      packages: write\n",
    )

    assert_rejected(run_checker(root), "permissions must be exactly contents: write")


def test_release_requires_successful_policy_job(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(workflow, "    needs: signing-policy\n", "")

    assert_rejected(run_checker(root), "build-release must require successful signing-policy")


def test_policy_job_cannot_be_conditional(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "  signing-policy:\n    name: Enforce Android signing boundary\n",
        "  signing-policy:\n    name: Enforce Android signing boundary\n    if: ${{ false }}\n",
    )

    assert_rejected(run_checker(root), "signing-policy must not be conditional")


def test_policy_checker_step_cannot_continue_on_error(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        POLICY_STEP,
        POLICY_STEP.rstrip() + "\n        continue-on-error: true\n\n",
    )

    assert_rejected(run_checker(root), "checker step must be unconditional and fail closed")


def test_misleading_checker_command_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "        run: python scripts/check-android-signing-boundary.py\n",
        "        run: echo python scripts/check-android-signing-boundary.py\n",
    )

    assert_rejected(run_checker(root), "must execute the exact signing-boundary checker command once")


def test_all_root_workflow_changes_must_trigger_policy(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    text = workflow.read_text(encoding="utf-8")
    workflow.write_text(text.replace("      - '.github/workflows/**'\n", ""), encoding="utf-8")

    result = run_checker(root)
    assert_rejected(result, "pull_request.paths is missing: .github/workflows/**")
    assert "push.paths is missing: .github/workflows/**" in result.stdout


def test_android_sibling_workflow_changes_must_trigger_policy(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    text = workflow.read_text(encoding="utf-8")
    workflow.write_text(
        text.replace("      - 'android/.github/workflows/**'\n", ""),
        encoding="utf-8",
    )

    result = run_checker(root)
    assert_rejected(result, "pull_request.paths is missing: android/.github/workflows/**")
    assert "push.paths is missing: android/.github/workflows/**" in result.stdout


def test_mutable_action_in_root_workflow_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
        "actions/checkout@v4",
    )

    assert_rejected(run_checker(root), "action must be pinned to a full commit SHA: actions/checkout@v4")


def test_mutable_action_in_android_sibling_workflow_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / SIBLING_WORKFLOW
    mutate(
        workflow,
        "android-actions/setup-android@9fc6c4e9069bf8d3d10b2204b1fb8f6ef7065407",
        "android-actions/setup-android@v3",
    )

    assert_rejected(
        run_checker(root),
        "android/.github/workflows/build.yml action must be pinned to a full commit SHA",
    )
