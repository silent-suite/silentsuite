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
        run: python "$GITHUB_WORKSPACE/scripts/check-android-signing-boundary.py"

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


def mutate_last(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    before, separator, after = text.rpartition(old)
    assert separator
    path.write_text(before + new + after, encoding="utf-8")


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


def test_secret_name_comparison_is_case_insensitive(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: case bypass
on: pull_request
jobs:
  leak:
    runs-on: ubuntu-latest
    env:
      LEAK: ${{ secrets.android_keystore_base64 }}
    steps:
      - run: 'true'
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "job leak references Android signing secrets")


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


def test_secret_object_filter_serialization_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: object filter bypass
on: pull_request
jobs:
  leak:
    runs-on: ubuntu-latest
    env:
      ALL_SECRETS: ${{ toJSON(secrets.*) }}
      JOINED_SECRETS: ${{ join(secrets.*, ',') }}
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

    assert_rejected(run_checker(root), "YAML anchors, aliases, and explicit tags are not allowed")


def test_explicit_yaml_tags_are_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: tag bypass
on: pull_request
jobs: !!map
  safe:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
""",
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "YAML anchors, aliases, and explicit tags are not allowed")


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


def test_android_environment_comparison_is_case_insensitive(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ".github" / "workflows" / "ci.yml"
    workflow.write_text(
        """name: case bypass
on: pull_request
jobs:
  leak:
    runs-on: ubuntu-latest
    environment: ANDROID-RELEASE
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
        "    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')\n",
        "    if: ${{ true }}\n    env:\n      DOCUMENTED_GUARD: \"startsWith(github.ref, 'refs/tags/v')\"\n",
    )

    assert_rejected(run_checker(root), "must use the exact push-triggered version-tag guard")


def test_release_guard_requires_a_push_event(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    text = workflow.read_text(encoding="utf-8")
    workflow.write_text(
        text.replace(
            "    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')\n",
            "    if: startsWith(github.ref, 'refs/tags/v')\n",
        ),
        encoding="utf-8",
    )

    assert_rejected(run_checker(root), "must use the exact push-triggered version-tag guard")


def test_workflow_level_write_all_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(workflow, "jobs:\n", "permissions: write-all\n\njobs:\n")

    assert_rejected(run_checker(root), "must not grant dynamic or write permissions at workflow scope")


def test_workflow_level_run_defaults_are_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "jobs:\n",
        "defaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n\njobs:\n",
    )

    assert_rejected(run_checker(root), "must not define workflow-level defaults")


def test_workflow_level_environment_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "jobs:\n",
        "env:\n  PATH: attacker\n  BASH_ENV: attacker\n\njobs:\n",
    )

    assert_rejected(run_checker(root), "must not define workflow-level env")


def test_nonrelease_job_write_permission_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "  build-pr:\n    name: Build (unsigned, PR/main)\n    if: github.event_name == 'pull_request' || !startsWith(github.ref, 'refs/tags/v')\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n",
        "  build-pr:\n    name: Build (unsigned, PR/main)\n    if: github.event_name == 'pull_request' || !startsWith(github.ref, 'refs/tags/v')\n    runs-on: ubuntu-latest\n    permissions: write-all\n",
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


def test_release_needs_must_be_exact(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "    needs: signing-policy\n",
        "    needs: [signing-policy, attacker]\n",
    )

    assert_rejected(run_checker(root), "build-release must require successful signing-policy")


def test_policy_job_cannot_be_conditional(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "  signing-policy:\n    name: Enforce Android signing boundary\n",
        "  signing-policy:\n    name: Enforce Android signing boundary\n    if: ${{ false }}\n",
    )

    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_policy_checker_step_cannot_continue_on_error(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        POLICY_STEP,
        POLICY_STEP.rstrip() + "\n        continue-on-error: true\n\n",
    )

    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_misleading_checker_command_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "        run: python \"$GITHUB_WORKSPACE/scripts/check-android-signing-boundary.py\"\n",
        "        run: echo python \"$GITHUB_WORKSPACE/scripts/check-android-signing-boundary.py\"\n",
    )

    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_policy_checker_cannot_use_working_directory(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        POLICY_STEP,
        POLICY_STEP.rstrip() + "\n        working-directory: attacker\n\n",
    )

    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_policy_checker_cannot_use_custom_shell(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        POLICY_STEP,
        POLICY_STEP.rstrip() + "\n        shell: attacker-shell {0}\n\n",
    )

    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_policy_checker_cannot_override_path(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        POLICY_STEP,
        POLICY_STEP.rstrip() + "\n        env:\n          PATH: attacker\n\n",
    )

    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_policy_job_cannot_add_preceding_workspace_mutation(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        POLICY_STEP,
        "      - name: Replace checker\n        run: cp attacker.py scripts/check-android-signing-boundary.py\n\n"
        + POLICY_STEP,
    )

    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


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


def test_later_negative_path_pattern_cannot_disable_policy_trigger(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "      - 'android/.github/workflows/**'\n  workflow_dispatch:\n",
        "      - 'android/.github/workflows/**'\n      - '!.github/workflows/**'\n  workflow_dispatch:\n",
    )

    assert_rejected(run_checker(root), "pull_request.paths must not contain negative patterns")


def test_policy_dependency_hash_pin_is_immutable(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc",
        "0000000000000000000000000000000000000000000000000000000000000000",
    )

    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_release_job_must_use_github_hosted_runner(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: self-hosted\n    environment: android-release\n",
    )

    assert_rejected(run_checker(root), "must run exactly on GitHub-hosted ubuntu-latest")


def test_release_job_cannot_use_container(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    container: attacker/image:latest\n    environment: android-release\n",
    )

    assert_rejected(run_checker(root), "must not define job-level container")


def test_release_job_cannot_use_services(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    services:\n      attacker:\n        image: attacker/image:latest\n    environment: android-release\n",
    )

    assert_rejected(run_checker(root), "must not define job-level services")


def test_release_job_cannot_use_strategy(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        runner: [ubuntu-latest]\n    environment: android-release\n",
    )

    assert_rejected(run_checker(root), "must not define job-level strategy")


def test_release_job_cannot_define_environment(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    env:\n      BASH_ENV: attacker\n    environment: android-release\n",
    )

    assert_rejected(run_checker(root), "must not define job-level env")


def test_release_job_cannot_override_default_shell(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate_last(
        workflow,
        "      run:\n        working-directory: android\n",
        "      run:\n        working-directory: android\n        shell: bash -c 'exit 0' {0}\n",
    )

    assert_rejected(run_checker(root), "must use the exact Android working-directory defaults")


def test_release_job_cannot_continue_on_error(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    continue-on-error: true\n    environment: android-release\n",
    )

    assert_rejected(run_checker(root), "must not define job-level continue-on-error")


def test_release_job_environment_must_be_exact_scalar(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "    environment: android-release\n",
        "    environment:\n      name: android-release\n      url: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
    )

    result = run_checker(root)
    assert_rejected(result, "must bind the android-release environment")
    assert "references signing secrets outside reviewed step environments" in result.stdout


def test_release_job_rejects_unreviewed_job_keys(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    environment: android-release\n",
    )

    assert_rejected(run_checker(root), "has unreviewed job keys: timeout-minutes")


def test_release_step_cannot_override_shell(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "      - name: Decode release keystore\n        env:\n",
        "      - name: Decode release keystore\n        shell: bash -c 'exit 0' {0}\n        env:\n",
    )

    assert_rejected(run_checker(root), "step 'Decode release keystore' must not define shell")


def test_release_step_environment_is_exact(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "      - name: Decode release keystore\n        env:\n          KEYSTORE_BASE64:",
        "      - name: Decode release keystore\n        env:\n          PATH: attacker\n          KEYSTORE_BASE64:",
    )

    assert_rejected(run_checker(root), "must use its exact reviewed environment")


def test_secret_bearing_step_cannot_be_replaced_by_pinned_action(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        """      - name: Build signed release APK and AAB
        env:
          KSTOREPWD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
        run: |
          ./gradlew assembleRelease bundleRelease --no-daemon \\
            -PrequireEtebase16Kb=true \\
            -PsigningStoreLocation="$KEYSTORE_PATH" \\
            -PsigningKeyAlias="$KEY_ALIAS"
""",
        """      - name: Build signed release APK and AAB
        env:
          KSTOREPWD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
        uses: attacker/release-secret-recorder@0123456789012345678901234567890123456789
""",
    )

    assert_rejected(run_checker(root), "must match its exact reviewed execution")


def test_secret_bearing_step_command_is_immutable(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "            -PsigningKeyAlias=\"$KEY_ALIAS\"\n",
        "            -PsigningKeyAlias=\"$KEY_ALIAS\"\n          curl https://attacker.invalid/\n",
    )

    assert_rejected(run_checker(root), "must match its exact reviewed execution")


def test_earlier_release_step_cannot_poison_secret_execution_environment(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate_last(
        workflow,
        "      - name: Make gradlew executable\n        run: chmod +x gradlew\n",
        "      - name: Make gradlew executable\n        run: |\n          chmod +x gradlew\n          echo 'BASH_ENV=attacker' >> \"$GITHUB_ENV\"\n",
    )

    assert_rejected(run_checker(root), "must match the exact reviewed release-job specification")


def test_release_secret_cannot_move_into_action_input(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate_last(
        workflow,
        "      - name: Checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n\n      - name: Set up JDK 17\n",
        "      - name: Checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          token: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n\n      - name: Set up JDK 17\n",
    )

    assert_rejected(run_checker(root), "references signing secrets outside reviewed step environments")


def test_release_job_cannot_invoke_local_action(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "  build-release:\n    name: Build (signed, tag release)\n    needs: signing-policy\n    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')\n    runs-on: ubuntu-latest\n    environment: android-release\n    permissions:\n      contents: write\n    defaults:\n      run:\n        working-directory: android\n\n    steps:\n      - name: Checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n\n      - name: Set up JDK 17\n",
        "  build-release:\n    name: Build (signed, tag release)\n    needs: signing-policy\n    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')\n    runs-on: ubuntu-latest\n    environment: android-release\n    permissions:\n      contents: write\n    defaults:\n      run:\n        working-directory: android\n\n    steps:\n      - name: Checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n\n      - name: Local release action\n        uses: ./malicious-action\n\n      - name: Set up JDK 17\n",
    )

    assert_rejected(run_checker(root), "build-release must not invoke local actions")


def test_mutable_action_in_root_workflow_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    mutate(
        workflow,
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "actions/checkout@v7",
    )

    assert_rejected(run_checker(root), "action must be pinned to a full commit SHA: actions/checkout@v7")


def test_mutable_action_in_android_sibling_workflow_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / SIBLING_WORKFLOW
    mutate(
        workflow,
        "android-actions/setup-android@40fd30fb8d7440372e1316f5d1809ec01dcd3699",
        "android-actions/setup-android@v4",
    )

    assert_rejected(
        run_checker(root),
        "android/.github/workflows/build.yml action must be pinned to a full commit SHA",
    )
