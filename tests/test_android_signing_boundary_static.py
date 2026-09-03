"""Adversarial policy contracts for the release control plane and signing boundary.

Every test here mutates a throwaway copy of the repository's workflows and
helpers and asserts the checker refuses it. The mutations are written as the
attacks they are: define release authority from the tag, run admission or
attachment code out of the candidate checkout, hand the signing job a second
credential, or quietly widen the umbrella lock.
"""

from pathlib import Path
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "check-android-signing-boundary.py"
CONTROLLER = Path(".github/workflows/release-controller.yml")
ROOT_WORKFLOW = Path(".github/workflows/release-android.yml")
CI_WORKFLOW = Path(".github/workflows/build-android.yml")
BRIDGE_WORKFLOW = Path(".github/workflows/release-bridge.yml")
BRIDGE_BUILD_WORKFLOW = Path(".github/workflows/build-bridge.yml")
SERVER_WORKFLOW = Path(".github/workflows/release-server-image.yml")
READINESS_WORKFLOW = Path(".github/workflows/release-readiness.yml")
SIBLING_WORKFLOW = Path("android/.github/workflows/build.yml")
CONSCRYPT_BUILD_SCRIPT = Path("android/scripts/build-conscrypt-android-r28.sh")
IDENTITY_HELPER = Path("scripts/verify-release-identity.sh")
ATTACHMENT_HELPER = Path("scripts/attach-umbrella-release-assets.sh")
READINESS_HELPER = Path("scripts/verify-umbrella-release-readiness.py")
BRIDGE_STAGING_HELPER = Path("scripts/stage-bridge-release-assets.sh")
KEYSTORE_HELPER = Path("scripts/verify-android-release-keystore.sh")
ARTIFACT_ADMISSION_HELPER = Path("scripts/admit-unsigned-android-artifact.sh")
SIGNING_HELPER = Path("scripts/sign-android-release.sh")
REPRODUCIBILITY_HELPER = Path("scripts/verify-android-build-reproducibility.py")

RELEASE_NEEDS = (
    "    needs:\n"
    "      [signing-policy, conscrypt-r28, revalidate-signing, build-unsigned-release,\n"
    "       reproducibility-gate]\n"
)
RELEASE_CHECKOUT = (
    "      - name: Check out the trusted controller revision\n"
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
    "        with:\n"
    "          ref: ${{ github.sha }}\n"
    "          clean: true\n"
    "          persist-credentials: false\n"
)
# The same trusted checkout text appears in `revalidate-signing` and
# `attach-release-assets`. Only the signing job follows it with the JDK setup,
# so this is the anchor that addresses it unambiguously.
SIGN_JOB_CHECKOUT = RELEASE_CHECKOUT + "\n      - name: Set up JDK 17\n"
RELEASE_JOB_HEAD = "    steps:\n" + SIGN_JOB_CHECKOUT
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
    (root / CONSCRYPT_BUILD_SCRIPT).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / CONSCRYPT_BUILD_SCRIPT, root / CONSCRYPT_BUILD_SCRIPT)
    # The control plane executes these with network and API access, so the
    # policy pins their bytes; the fixture must carry them for the digest
    # checks to be real.
    for helper in (
        IDENTITY_HELPER,
        ATTACHMENT_HELPER,
        READINESS_HELPER,
        BRIDGE_STAGING_HELPER,
        KEYSTORE_HELPER,
        ARTIFACT_ADMISSION_HELPER,
        SIGNING_HELPER,
        REPRODUCIBILITY_HELPER,
    ):
        (root / helper).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / helper, root / helper)
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
    assert needle in result.stdout, result.stdout


def test_repository_workflows_satisfy_the_release_and_signing_boundary() -> None:
    result = run_checker(ROOT)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "boundary check passed" in result.stdout


def test_aab_integrity_cannot_remove_explicit_keystore_trust(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate_last(
        root / SIGNING_HELPER,
        '-keystore "$KEYSTORE_PATH" -storepass:env KSTOREPWD',
        '-keystore "$KEYSTORE_PATH"',
    )
    assert_rejected(run_checker(root), '"$JARSIGNER" -verify -strict')


def test_aab_integrity_verification_cannot_be_removed(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SIGNING_HELPER,
        'if ! "$JARSIGNER" -verify -strict',
        'if ! /bin/true',
    )
    assert_rejected(
        run_checker(root),
        'must contain \'"$JARSIGNER" -verify -strict',
    )


def test_aab_integrity_cannot_fall_back_to_plain_verify(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SIGNING_HELPER,
        '"$JARSIGNER" -verify -strict \\',
        '"$JARSIGNER" -verify "$SIGNED_AAB"; /bin/true \\',
    )
    assert_rejected(run_checker(root), "must not use unparsed plain AAB verification")


def test_aab_integrity_cannot_remove_verified_result_check(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SIGNING_HELPER,
        "grep -Fxq 'jar verified.' \"$JARSIGNER_VERIFY_LOG\"",
        "/bin/true",
    )
    assert_rejected(run_checker(root), "grep -Fxq")


def test_aab_certificate_pin_extraction_cannot_be_removed(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SIGNING_HELPER,
        '-printcert -jarfile "$SIGNED_AAB"',
        '-printcert -file "$SIGNED_AAB"',
    )
    assert_rejected(
        run_checker(root),
        'must contain \'-printcert -jarfile "$SIGNED_AAB"\'',
    )


def test_the_unmutated_fixture_is_clean(tmp_path: Path) -> None:
    """Every rejection below must be caused by its own mutation, not the copy."""

    assert run_checker(fixture_root(tmp_path)).returncode == 0


# ── Release authority: the controller, and only the controller ────────


def test_a_tag_push_trigger_anywhere_is_rejected(tmp_path: Path) -> None:
    """The premise of the whole design: no workflow code is loaded from a tag."""

    root = fixture_root(tmp_path)
    mutate(
        root / CI_WORKFLOW,
        "on:\n  push:\n    branches: [main]\n",
        "on:\n  push:\n    branches: [main]\n    tags:\n      - 'v*'\n",
    )
    assert_rejected(run_checker(root), "declares a tag-push trigger")


def test_a_tag_push_trigger_on_a_component_lane_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SERVER_WORKFLOW,
        "on:\n  workflow_call:\n",
        "on:\n  push:\n    tags:\n      - 'v*'\n  workflow_call:\n",
    )
    result = run_checker(root)
    assert_rejected(result, "declares a tag-push trigger")
    assert "must declare exactly one trigger, workflow_call" in result.stdout


def test_a_second_repository_dispatch_control_plane_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    (root / ".github/workflows/rogue.yml").write_text(
        """name: rogue control plane
on:
  repository_dispatch:
    types: [silentsuite_release]
permissions: {}
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - run: 'true'
""",
        encoding="utf-8",
    )
    assert_rejected(run_checker(root), "must not define a second release control plane")


def test_widening_the_dispatch_event_type_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "    types: [silentsuite_release]\n",
        "    types: [silentsuite_release, anything]\n",
    )
    assert_rejected(run_checker(root), "must accept exactly the silentsuite_release event type")


def test_adding_a_dispatch_trigger_to_the_controller_is_rejected(tmp_path: Path) -> None:
    """workflow_dispatch would let a selected ref supply the controller itself."""

    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "on:\n  repository_dispatch:\n",
        "on:\n  workflow_dispatch:\n  repository_dispatch:\n",
    )
    assert_rejected(
        run_checker(root), "must declare exactly one trigger, repository_dispatch"
    )


def test_adding_a_dispatch_trigger_to_a_component_lane_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(root / BRIDGE_WORKFLOW, "on:\n  workflow_call:\n", "on:\n  workflow_dispatch:\n  workflow_call:\n")
    assert_rejected(run_checker(root), "must declare exactly one trigger, workflow_call")


def test_a_component_lane_with_default_write_permissions_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(root / READINESS_WORKFLOW, "permissions: {}\n", "permissions:\n  contents: write\n")
    assert_rejected(run_checker(root), "must grant no default permissions")


def test_calling_a_component_lane_from_another_repository_is_rejected(tmp_path: Path) -> None:
    """`uses: ./…` is what binds the called definition to this revision."""

    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "    uses: ./.github/workflows/release-android.yml\n",
        "    uses: attacker/repo/.github/workflows/release-android.yml@0123456789012345678901234567890123456789\n",
    )
    assert_rejected(run_checker(root), "must call ./.github/workflows/release-android.yml")


def test_widening_a_caller_permission_ceiling_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "  bridge:\n    name: Bridge\n    needs: admit\n    permissions:\n      contents: write\n",
        "  bridge:\n    name: Bridge\n    needs: admit\n    permissions:\n      contents: write\n      packages: write\n",
    )
    assert_rejected(run_checker(root), "job bridge must declare exactly")


def test_removing_an_android_callable_secret_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      ANDROID_KEY_ALIAS:\n"
        "        description: Alias of the Android release signing key.\n"
        "        required: true\n",
        "",
    )
    assert_rejected(run_checker(root), "must declare exactly the three Android signing secrets")


def test_removing_an_android_caller_secret_grant_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "      ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}\n",
        "",
    )
    assert_rejected(run_checker(root), "job android must grant exactly the three Android signing secrets")


def test_adding_a_fourth_android_callable_secret_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    secrets:\n",
        "    secrets:\n"
        "      EXTRA_SIGNING_SECRET:\n"
        "        description: Must never be admitted.\n"
        "        required: true\n",
    )
    assert_rejected(run_checker(root), "must declare exactly the three Android signing secrets")


def test_mapping_an_android_grant_from_the_wrong_secret_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "      ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}\n",
        "      ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}\n",
    )
    assert_rejected(run_checker(root), "job android must grant exactly the three Android signing secrets")


def test_mapping_an_android_grant_under_the_wrong_name_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "      ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}\n",
        "      ANDROID_KEY_NAME: ${{ secrets.ANDROID_KEY_ALIAS }}\n",
    )
    assert_rejected(run_checker(root), "job android must grant exactly the three Android signing secrets")


def test_adding_a_fourth_android_caller_grant_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "    secrets:\n      ANDROID_KEYSTORE_BASE64:",
        "    secrets:\n"
        "      EXTRA_SIGNING_SECRET: ${{ secrets.EXTRA_SIGNING_SECRET }}\n"
        "      ANDROID_KEYSTORE_BASE64:",
    )
    assert_rejected(run_checker(root), "job android must grant exactly the three Android signing secrets")


def test_exposing_android_signing_secrets_to_another_lane_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "    uses: ./.github/workflows/release-bridge.yml\n",
        "    uses: ./.github/workflows/release-bridge.yml\n"
        "    secrets:\n"
        "      ANDROID_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "job bridge must not receive any secrets" in result.stdout
    assert "job bridge references Android signing secrets" in result.stdout


def test_a_component_lane_running_without_admission_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "  server:\n    name: Self-host server image\n    needs: admit\n",
        "  server:\n    name: Self-host server image\n",
    )
    assert_rejected(run_checker(root), "job server can run unadmitted")


def test_feeding_a_component_lane_the_raw_payload_instead_of_the_admitted_pair(
    tmp_path: Path,
) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "      release_tag: ${{ needs.admit.outputs.tag }}\n"
        "      source_sha: ${{ needs.admit.outputs.commit }}\n",
        "      release_tag: ${{ github.event.client_payload.release_tag }}\n"
        "      source_sha: ${{ github.event.client_payload.source_sha }}\n",
    )
    assert_rejected(run_checker(root), "must pass exactly the admitted tag and commit")


def test_interpolating_the_dispatch_payload_into_a_script_is_rejected(tmp_path: Path) -> None:
    """Payload text must reach a shell through the environment, never inline."""

    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "      - name: Validate the dispatch payload\n",
        "      - name: Echo the payload\n"
        "        run: echo ${{ github.event.client_payload.release_tag }}\n"
        "\n      - name: Validate the dispatch payload\n",
    )
    assert_rejected(run_checker(root), "interpolates the dispatch payload into a script")


def test_granting_the_admission_job_write_permission_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "  admit:\n    name: Admit the release source\n    runs-on: ubuntu-24.04\n"
        "    timeout-minutes: 15\n    permissions:\n      contents: read\n",
        "  admit:\n    name: Admit the release source\n    runs-on: ubuntu-24.04\n"
        "    timeout-minutes: 15\n    permissions:\n      contents: write\n",
    )
    assert_rejected(run_checker(root), "admit must declare exactly contents: read")


def test_admitting_from_a_ref_other_than_the_controller_revision_is_rejected(
    tmp_path: Path,
) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "      - name: Check out the protected controller revision\n"
        "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
        "        with:\n"
        "          ref: ${{ github.sha }}\n",
        "      - name: Check out the protected controller revision\n"
        "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
        "        with:\n"
        "          ref: ${{ github.event.client_payload.source_sha }}\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "must check out exactly the protected controller revision" in result.stdout


def test_neutering_the_admission_command_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "            --stage controller-admission \\\n",
        "            --stage controller-admission || true \\\n",
    )
    assert_rejected(run_checker(root), "admit must match its exact reviewed digest")


def test_dropping_the_local_ancestry_re_derivation_is_rejected(tmp_path: Path) -> None:
    """The compare API is one answer; the object graph is the second."""

    root = fixture_root(tmp_path)
    mutate(root / CONTROLLER, "            --git-ancestry . \\\n", "")
    assert_rejected(run_checker(root), "admit must match its exact reviewed digest")


def test_a_shallow_admission_checkout_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(root / CONTROLLER, "          fetch-depth: 0\n", "          fetch-depth: 1\n")
    assert_rejected(run_checker(root), "admit must match its exact reviewed digest")


def test_readiness_that_does_not_wait_for_every_component_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "    needs: [admit, android, bridge, server]\n",
        "    needs: [admit, android]\n",
    )
    assert_rejected(run_checker(root), "readiness must wait for every component lane")


def test_readiness_caller_draft_visibility_ceiling_is_exact(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "  readiness:\n    name: Umbrella draft readiness\n    needs: [admit, android, bridge, server]\n    permissions:\n      contents: write\n",
        "  readiness:\n    name: Umbrella draft readiness\n    needs: [admit, android, bridge, server]\n    permissions:\n      contents: read\n",
    )
    assert_rejected(run_checker(root), "job readiness must declare exactly {'contents': 'write'}")


def test_called_readiness_draft_visibility_ceiling_is_exact(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / READINESS_WORKFLOW,
        "    permissions:\n      contents: write\n",
        "    permissions:\n      contents: read\n",
    )
    assert_rejected(run_checker(root), "readiness permissions must be exactly contents: write")


@pytest.mark.parametrize(
    ("extra_step", "message"),
    [
        ("      - run: curl -X POST https://api.github.com/repos/x/y/releases\n", "API mutation method"),
        ("      - run: gh release edit v1.2.3\n", "must not use gh release"),
        (
            "      - run: scripts/attach-umbrella-release-assets.sh --tag v1.2.3\n",
            "must not use release attachment helper",
        ),
        (
            "      - uses: actions/upload-artifact@0123456789012345678901234567890123456789\n",
            "must not use artifact upload action",
        ),
        ("      - uses: ./attacker-action\n", "must not invoke local actions"),
    ],
)
def test_readiness_rejects_mutation_routes(
    tmp_path: Path, extra_step: str, message: str
) -> None:
    root = fixture_root(tmp_path)
    workflow = root / READINESS_WORKFLOW
    workflow.write_text(workflow.read_text(encoding="utf-8") + extra_step, encoding="utf-8")
    assert_rejected(run_checker(root), message)


def test_readiness_rejects_any_unreviewed_extra_command(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / READINESS_WORKFLOW
    workflow.write_text(
        workflow.read_text(encoding="utf-8") + "      - run: printf 'extra step\\n'\n",
        encoding="utf-8",
    )
    assert_rejected(run_checker(root), "must match its exact reviewed whole-job digest")


def test_readiness_rejects_environment_and_extra_secrets(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / READINESS_WORKFLOW,
        "    timeout-minutes: 20\n",
        "    timeout-minutes: 20\n    environment: production\n    env:\n      TOKEN: ${{ secrets.RELEASE_TOKEN }}\n",
    )
    result = run_checker(root)
    assert_rejected(result, "readiness must not bind an environment")
    assert "may reference only secrets.GITHUB_TOKEN" in result.stdout


# ── Candidate-sourced helper bypass ───────────────────────────────────


def test_running_the_attachment_helper_from_the_candidate_checkout_is_rejected(
    tmp_path: Path,
) -> None:
    """The blocker the reviewers found: the candidate supplying its own helper."""

    root = fixture_root(tmp_path)
    mutate(
        root / SERVER_WORKFLOW,
        "          scripts/attach-umbrella-release-assets.sh \\\n",
        "          candidate/scripts/attach-umbrella-release-assets.sh \\\n",
    )
    assert_rejected(
        run_checker(root),
        "runs 'candidate/scripts/attach-umbrella-release-assets.sh', which is not inside a "
        "checkout of the protected controller revision",
    )


def test_running_the_registry_verifier_from_the_candidate_checkout_is_rejected(
    tmp_path: Path,
) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SERVER_WORKFLOW,
        "          trusted/scripts/verify-server-image-release.sh \\\n"
        '            --repository "$IMAGE_NAME" \\\n'
        '            --tag "$RELEASE_TAG" \\\n',
        "          candidate/scripts/verify-server-image-release.sh \\\n"
        '            --repository "$IMAGE_NAME" \\\n'
        '            --tag "$RELEASE_TAG" \\\n',
    )
    assert_rejected(
        run_checker(root),
        "runs 'candidate/scripts/verify-server-image-release.sh'",
    )


def test_dropping_the_trusted_checkout_from_a_helper_job_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SERVER_WORKFLOW,
        "      - name: Check out the trusted controller revision\n"
        "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
        "        with:\n"
        "          ref: ${{ github.sha }}\n"
        "          path: trusted\n"
        "          persist-credentials: false\n",
        "",
    )
    assert_rejected(
        run_checker(root), "without checking out the protected controller revision"
    )


def test_checking_the_candidate_out_over_the_trusted_helpers_is_rejected(
    tmp_path: Path,
) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SERVER_WORKFLOW,
        "          ref: ${{ github.sha }}\n          path: trusted\n",
        "          ref: ${{ github.sha }}\n          path: candidate\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "the candidate and the controller out at the same path" in result.stdout


def test_a_write_capable_job_outside_the_control_plane_naming_the_helper_is_rejected(
    tmp_path: Path,
) -> None:
    root = fixture_root(tmp_path)
    (root / ".github/workflows/rogue.yml").write_text(
        """name: rogue publisher
on: workflow_dispatch
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - run: bash scripts/attach-umbrella-release-assets.sh --tag v1.2.3
""",
        encoding="utf-8",
    )
    assert_rejected(
        run_checker(root),
        "outside the release control plane while holding a write permission",
    )


def test_mutating_the_identity_helper_bytes_is_rejected(tmp_path: Path) -> None:
    """The step text is stable; the file it runs is what admits a commit."""

    root = fixture_root(tmp_path)
    helper = root / IDENTITY_HELPER
    helper.write_text(helper.read_text(encoding="utf-8") + "\nexit 0\n", encoding="utf-8")
    assert_rejected(run_checker(root), f"{IDENTITY_HELPER} must match its exact reviewed digest")


def test_mutating_the_attachment_helper_bytes_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    helper = root / ATTACHMENT_HELPER
    helper.write_text(
        helper.read_text(encoding="utf-8") + "\ncurl -X DELETE https://elsewhere\n",
        encoding="utf-8",
    )
    assert_rejected(run_checker(root), f"{ATTACHMENT_HELPER} must match its exact reviewed digest")


def test_mutating_the_readiness_helper_bytes_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    helper = root / READINESS_HELPER
    helper.write_text(helper.read_text(encoding="utf-8") + "\n# unreviewed\n", encoding="utf-8")
    assert_rejected(run_checker(root), f"{READINESS_HELPER} must match its exact reviewed digest")


def test_mutating_the_bridge_staging_helper_bytes_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    helper = root / BRIDGE_STAGING_HELPER
    helper.write_text(helper.read_text(encoding="utf-8") + "\n# unreviewed\n", encoding="utf-8")
    assert_rejected(
        run_checker(root),
        f"{BRIDGE_STAGING_HELPER} must match its exact reviewed digest",
    )


def test_a_missing_helper_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    (root / ATTACHMENT_HELPER).unlink()
    assert_rejected(run_checker(root), f"{ATTACHMENT_HELPER} is missing")


# ── Conscrypt producer and policy gate ────────────────────────────────


def test_release_conscrypt_producer_job_is_immutable(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "          scripts/build-conscrypt-android-r28.sh\n",
        "          scripts/build-conscrypt-android-r28.sh --unreviewed\n",
    )
    assert_rejected(
        run_checker(root),
        f"{ROOT_WORKFLOW} conscrypt-r28 must match the exact reviewed producer specification",
    )


def test_ci_conscrypt_producer_job_is_immutable(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CI_WORKFLOW,
        "          scripts/build-conscrypt-android-r28.sh\n",
        "          scripts/build-conscrypt-android-r28.sh --unreviewed\n",
    )
    assert_rejected(
        run_checker(root),
        f"{CI_WORKFLOW} conscrypt-r28 must match the exact reviewed producer specification",
    )


def test_conscrypt_builder_script_is_digest_bound(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    script = root / CONSCRYPT_BUILD_SCRIPT
    script.write_text(script.read_text(encoding="utf-8") + "# unreviewed\n", encoding="utf-8")
    assert_rejected(run_checker(root), f"{CONSCRYPT_BUILD_SCRIPT} must match its exact reviewed digest")


def test_policy_job_cannot_be_conditional(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "  signing-policy:\n    name: Enforce Android signing boundary\n",
        "  signing-policy:\n    name: Enforce Android signing boundary\n    if: ${{ false }}\n",
    )
    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_policy_checker_step_cannot_continue_on_error(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        POLICY_STEP,
        POLICY_STEP.rstrip() + "\n        continue-on-error: true\n",
    )
    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_misleading_checker_command_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        '        run: python "$GITHUB_WORKSPACE/scripts/check-android-signing-boundary.py"\n',
        '        run: echo python "$GITHUB_WORKSPACE/scripts/check-android-signing-boundary.py"\n',
    )
    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_policy_checker_cannot_override_path(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        POLICY_STEP,
        POLICY_STEP.rstrip() + "\n        env:\n          PATH: attacker\n",
    )
    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_policy_source_must_come_from_the_controller_revision(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      - name: Checkout policy source\n"
        "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
        "        with:\n"
        "          ref: ${{ github.sha }}\n",
        "      - name: Checkout policy source\n"
        "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
        "        with:\n"
        "          ref: ${{ inputs.source_sha }}\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "signing-policy must match the exact fail-closed job specification" in result.stdout
    assert "without checking out the protected controller revision" in result.stdout


def test_policy_dependency_hash_pin_is_immutable(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc",
        "0000000000000000000000000000000000000000000000000000000000000000",
    )
    assert_rejected(run_checker(root), "signing-policy must match the exact fail-closed job specification")


def test_all_ci_workflow_changes_must_trigger_policy(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    workflow = root / CI_WORKFLOW
    workflow.write_text(
        workflow.read_text(encoding="utf-8").replace("      - '.github/workflows/**'\n", ""),
        encoding="utf-8",
    )
    result = run_checker(root)
    assert_rejected(result, "pull_request.paths is missing: .github/workflows/**")
    assert "push.paths is missing: .github/workflows/**" in result.stdout


def test_later_negative_path_pattern_cannot_disable_policy_trigger(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / CI_WORKFLOW,
        "      - 'android/.github/workflows/**'\n  workflow_dispatch:\n",
        "      - 'android/.github/workflows/**'\n      - '!.github/workflows/**'\n  workflow_dispatch:\n",
    )
    assert_rejected(run_checker(root), "pull_request.paths must not contain negative patterns")


def test_a_write_permission_in_android_ci_is_rejected(tmp_path: Path) -> None:
    """Unprivileged CI must never regain a release-producing capability."""

    root = fixture_root(tmp_path)
    mutate(
        root / CI_WORKFLOW,
        "  conscrypt-runtime:\n    name: Conscrypt runtime (API ${{ matrix.api-level }}, ${{ matrix.arch }})\n"
        "    needs: conscrypt-r28\n"
        "    if: github.event_name == 'pull_request' || !startsWith(github.ref, 'refs/tags/v')\n"
        "    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    permissions:\n      contents: read\n",
        "  conscrypt-runtime:\n    name: Conscrypt runtime (API ${{ matrix.api-level }}, ${{ matrix.arch }})\n"
        "    needs: conscrypt-r28\n"
        "    if: github.event_name == 'pull_request' || !startsWith(github.ref, 'refs/tags/v')\n"
        "    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    permissions:\n      contents: write\n",
    )
    assert_rejected(run_checker(root), "job conscrypt-runtime must declare read-only permissions")


# ── Secret exfiltration shapes ────────────────────────────────────────


def test_quoted_job_with_bracket_secret_reference_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    (root / ".github/workflows/ci.yml").write_text(
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
    (root / ".github/workflows/ci.yml").write_text(
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
    (root / ".github/workflows/ci.yml").write_text(
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
    (root / ".github/workflows/ci.yml").write_text(
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
    (root / ".github/workflows/ci.yml").write_text(
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
    (root / ".github/workflows/ci.yml").write_text(
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
    (root / ".github/workflows/ci.yml").write_text(
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
    (root / ".github/workflows/ci.yml").write_text(
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
    (root / ".github/workflows/ci.yml").write_text(
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
    (root / ".github/workflows/ci.yml").write_text(
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


def test_android_environment_in_another_workflow_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    (root / ".github/workflows/ci.yml").write_text(
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
    assert_rejected(run_checker(root), "binds android-release outside sign-release")


def test_android_environment_comparison_is_case_insensitive(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    (root / ".github/workflows/ci.yml").write_text(
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
    assert_rejected(run_checker(root), "binds android-release outside sign-release")


def test_dynamic_environment_outside_release_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    (root / ".github/workflows/ci.yml").write_text(
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
    assert_rejected(run_checker(root), "uses a dynamic environment outside sign-release")


def test_binding_the_production_environment_outside_its_lane_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    (root / ".github/workflows/ci.yml").write_text(
        """name: production bypass
on: pull_request
jobs:
  leak:
    runs-on: ubuntu-latest
    environment: server-production
    steps:
      - run: 'true'
""",
        encoding="utf-8",
    )
    assert_rejected(run_checker(root), "binds server-production, which belongs exclusively to")


# ── Signing job isolation ─────────────────────────────────────────────


def test_workflow_level_write_all_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(root / ROOT_WORKFLOW, "permissions: {}\n", "permissions: write-all\n")
    assert_rejected(run_checker(root), "must not grant dynamic or write permissions at workflow scope")


def test_workflow_level_run_defaults_are_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "jobs:\n",
        "defaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n\njobs:\n",
    )
    assert_rejected(run_checker(root), "must not define workflow-level defaults")


def test_workflow_level_environment_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(root / ROOT_WORKFLOW, "jobs:\n", "env:\n  PATH: attacker\n  BASH_ENV: attacker\n\njobs:\n")
    assert_rejected(run_checker(root), "must not define workflow-level env")


def test_release_requires_successful_policy_job(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(root / ROOT_WORKFLOW, RELEASE_NEEDS, "")
    assert_rejected(run_checker(root), "sign-release must require successful signing-policy")


def test_release_needs_must_be_exact(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        RELEASE_NEEDS,
        "    needs: [signing-policy, conscrypt-r28, revalidate-signing, attacker]\n",
    )
    assert_rejected(run_checker(root), "sign-release must require successful signing-policy")


def test_dropping_the_pre_signing_revalidation_is_rejected(tmp_path: Path) -> None:
    """A tag that moved during the unsigned build must not reach the keystore."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        RELEASE_NEEDS,
        "    needs: [signing-policy, conscrypt-r28, build-unsigned-release,\n"
        "       reproducibility-gate]\n",
    )
    assert_rejected(
        run_checker(root),
        "sign-release must require successful signing-policy, conscrypt-r28, "
        "revalidate-signing, build-unsigned-release and reproducibility-gate",
    )


def test_dropping_the_pre_signing_reproducibility_gate_is_rejected(tmp_path: Path) -> None:
    """An APK only this machine can build must not reach the keystore."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        RELEASE_NEEDS,
        "    needs: [signing-policy, conscrypt-r28, revalidate-signing,\n"
        "       build-unsigned-release]\n",
    )
    assert_rejected(
        run_checker(root),
        "sign-release must require successful signing-policy, conscrypt-r28, "
        "revalidate-signing, build-unsigned-release and reproducibility-gate",
    )


def test_revalidating_before_the_native_build_instead_of_after_is_rejected(tmp_path: Path) -> None:
    """A half-hour Conscrypt build between the check and the keystore is a gap."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "  revalidate-signing:\n    name: Revalidate the release identity before signing\n"
        "    needs: conscrypt-r28\n",
        "  revalidate-signing:\n    name: Revalidate the release identity before signing\n",
    )
    assert_rejected(
        run_checker(root),
        "revalidate-signing must match the exact reviewed pre-signing revalidation job",
    )


def test_neutering_the_pre_signing_revalidation_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "            --stage android-signing\n",
        "            --stage android-signing || true\n",
    )
    assert_rejected(
        run_checker(root),
        "revalidate-signing must match the exact reviewed pre-signing revalidation job",
    )


def test_a_reintroduced_event_guard_on_the_signing_job_is_rejected(tmp_path: Path) -> None:
    """This lane is unreachable except through the controller; a guard implies otherwise."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "  sign-release:\n    name: Sign (admitted release)\n",
        "  sign-release:\n    name: Sign (admitted release)\n"
        "    if: startsWith(github.ref, 'refs/tags/v')\n",
    )
    assert_rejected(run_checker(root), "sign-release must not carry an event guard")


def test_release_job_must_use_github_hosted_runner(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: self-hosted\n    environment: android-release\n",
    )
    assert_rejected(run_checker(root), "must run exactly on GitHub-hosted ubuntu-latest")


def test_release_job_cannot_use_container(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    container: attacker/image:latest\n    environment: android-release\n",
    )
    assert_rejected(run_checker(root), "must not define job-level container")


def test_release_job_cannot_use_services(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    services:\n      attacker:\n        image: attacker/image:latest\n"
        "    environment: android-release\n",
    )
    assert_rejected(run_checker(root), "must not define job-level services")


def test_release_job_cannot_use_strategy(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        runner: [ubuntu-latest]\n"
        "    environment: android-release\n",
    )
    assert_rejected(run_checker(root), "must not define job-level strategy")


def test_release_job_cannot_define_job_env(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    env:\n      BASH_ENV: attacker\n    environment: android-release\n",
    )
    assert_rejected(run_checker(root), "must not define job-level env")


def test_declaring_defaults_on_the_signing_job_is_rejected(tmp_path: Path) -> None:
    """It has no candidate tree, so an `android` working directory is a smell."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "  sign-release:\n    name: Sign (admitted release)\n",
        "  sign-release:\n    name: Sign (admitted release)\n"
        "    defaults:\n      run:\n        working-directory: android\n",
    )
    assert_rejected(run_checker(root), "sign-release must not declare defaults")


def test_release_job_cannot_continue_on_error(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    continue-on-error: true\n    environment: android-release\n",
    )
    assert_rejected(run_checker(root), "must not define job-level continue-on-error")


def test_release_job_environment_must_be_exact_scalar(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    environment: android-release\n",
        "    environment:\n      name: android-release\n      url: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
    )
    result = run_checker(root)
    assert_rejected(result, "must bind the android-release environment")
    assert "references signing secrets outside reviewed step environments" in result.stdout


def test_release_job_rejects_unreviewed_job_keys(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    runs-on: ubuntu-latest\n    environment: android-release\n",
        "    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    environment: android-release\n",
    )
    assert_rejected(run_checker(root), "has unreviewed job keys: timeout-minutes")


def test_release_step_cannot_override_shell(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      - name: Decode release keystore\n        env:\n",
        "      - name: Decode release keystore\n        shell: bash -c 'exit 0' {0}\n        env:\n",
    )
    assert_rejected(run_checker(root), "step 'Decode release keystore' must not define shell")


def test_release_step_environment_is_exact(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      - name: Decode release keystore\n        env:\n          KEYSTORE_BASE64:",
        "      - name: Decode release keystore\n        env:\n          PATH: attacker\n          KEYSTORE_BASE64:",
    )
    assert_rejected(run_checker(root), "must use its exact reviewed environment")


def test_an_unreviewed_plain_step_environment_is_rejected(tmp_path: Path) -> None:
    """Only the reviewed steps may carry an environment at all."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      - name: Fetch the pinned bundletool\n        env:\n",
        "      - name: Fetch the pinned bundletool\n        env:\n          BASH_ENV: attacker\n",
    )
    assert_rejected(run_checker(root), "must use its exact reviewed environment")


def test_secret_bearing_step_cannot_be_replaced_by_pinned_action(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        """      - name: Sign the admitted APK and AAB
        env:
          KSTOREPWD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
        run: |
""",
        """      - name: Sign the admitted APK and AAB
        env:
          KSTOREPWD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
        uses: attacker/release-secret-recorder@0123456789012345678901234567890123456789
        run: |
""",
    )
    assert_rejected(run_checker(root), "must match its exact reviewed execution")


def test_secret_bearing_step_command_is_immutable(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        '          bash "$GITHUB_WORKSPACE/scripts/sign-android-release.sh"\n',
        '          bash "$GITHUB_WORKSPACE/scripts/sign-android-release.sh"\n'
        "          curl https://attacker.invalid/\n",
    )
    assert_rejected(run_checker(root), "must match its exact reviewed execution")


def test_earlier_signing_step_cannot_poison_the_execution_environment(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate_last(
        root / ROOT_WORKFLOW,
        '          echo "$BUNDLETOOL_SHA256  $RUNNER_TEMP/bundletool.jar" | sha256sum --check --strict\n',
        '          echo "$BUNDLETOOL_SHA256  $RUNNER_TEMP/bundletool.jar" | sha256sum --check --strict\n'
        "          echo 'BASH_ENV=attacker' >> \"$GITHUB_ENV\"\n",
    )
    assert_rejected(run_checker(root), "must match the exact reviewed release-job specification")


def test_release_secret_cannot_move_into_action_input(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        SIGN_JOB_CHECKOUT,
        RELEASE_CHECKOUT.rstrip("\n")
        + "\n          token: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n"
        + "\n      - name: Set up JDK 17\n",
    )
    assert_rejected(run_checker(root), "references signing secrets outside reviewed step environments")


def test_release_job_cannot_invoke_local_action(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        RELEASE_JOB_HEAD,
        RELEASE_JOB_HEAD.replace(
            "      - name: Set up JDK 17\n",
            "      - name: Local release action\n        uses: ./malicious-action\n\n"
            "      - name: Set up JDK 17\n",
        ),
    )
    assert_rejected(run_checker(root), "sign-release must not invoke local actions")


def test_mutable_action_in_the_release_lane_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "actions/checkout@v7",
    )
    assert_rejected(run_checker(root), "action must be pinned to a full commit SHA: actions/checkout@v7")


def test_mutable_action_in_android_sibling_workflow_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SIBLING_WORKFLOW,
        "android-actions/setup-android@40fd30fb8d7440372e1316f5d1809ec01dcd3699",
        "android-actions/setup-android@v4",
    )
    assert_rejected(
        run_checker(root),
        "android/.github/workflows/build.yml action must be pinned to a full commit SHA",
    )


def test_a_foreign_credential_in_the_signing_job_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "          KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}\n"
        "        run: |\n"
        "          set -euo pipefail\n"
        '          UNSIGNED_DIR="$GITHUB_WORKSPACE/unsigned" \\',
        "          KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}\n"
        "          SETTINGS_READ: ${{ secrets.SOME_ADMIN_READ_TOKEN }}\n"
        "        run: |\n"
        "          set -euo pipefail\n"
        '          UNSIGNED_DIR="$GITHUB_WORKSPACE/unsigned" \\',
    )
    assert_rejected(
        run_checker(root),
        "sign-release must not carry any credential beyond the reviewed signing secrets",
    )


def test_the_workflow_token_in_the_signed_release_job_is_rejected(tmp_path: Path) -> None:
    """The keystore job holds one credential, and it is not the release token."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      - name: Cleanup keystore\n",
        "      - name: Read the release\n"
        "        run: |\n"
        '          curl -H "Authorization: Bearer ${{ secrets.GITHUB_TOKEN }}" "$URL"\n'
        "\n      - name: Cleanup keystore\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "holds signing material and can also write a release" in result.stdout


def test_moving_the_umbrella_lock_onto_the_signing_job_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    environment: android-release\n    permissions:\n      contents: read\n",
        "    environment: android-release\n    permissions:\n      contents: read\n"
        "    concurrency:\n      group: umbrella-release-${{ github.event.client_payload.release_tag }}\n"
        "      cancel-in-progress: false\n      queue: max\n",
    )
    assert_rejected(
        run_checker(root),
        "sign-release must not declare concurrency; the umbrella lock belongs to",
    )


def test_granting_the_signing_job_write_permission_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    environment: android-release\n    permissions:\n      contents: read\n",
        "    environment: android-release\n    permissions:\n      contents: write\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "sign-release permissions must be exactly contents: read" in result.stdout
    assert "holds signing material and must declare read-only permissions" in result.stdout


def test_persisting_the_checkout_credential_in_the_signing_job_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        SIGN_JOB_CHECKOUT,
        SIGN_JOB_CHECKOUT.replace("          persist-credentials: false\n", ""),
    )
    assert_rejected(
        run_checker(root),
        "sign-release must check out the admitted commit and then the trusted controller "
        "revision, in that order, both with persist-credentials: false",
    )


def test_checking_out_a_floating_ref_in_the_signing_job_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        SIGN_JOB_CHECKOUT,
        SIGN_JOB_CHECKOUT.replace("          ref: ${{ github.sha }}\n", "          ref: main\n"),
    )
    assert_rejected(
        run_checker(root),
        "sign-release must check out the admitted commit and then the trusted controller "
        "revision, in that order, both with persist-credentials: false",
    )


def test_reintroducing_a_release_action_beside_signing_material_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      - name: Cleanup keystore\n",
        "      - name: Attach Android artifacts to umbrella GitHub Release\n"
        "        uses: softprops/action-gh-release@3d0d9888cb7fd7b750713d6e236d1fcb99157228 # v3.0.2\n"
        "        with:\n"
        "          tag_name: ${{ inputs.release_tag }}\n"
        "          draft: true\n"
        "\n      - name: Cleanup keystore\n",
    )
    assert_rejected(
        run_checker(root),
        "holds signing material and can also write a release: softprops/action-gh-release",
    )


def test_calling_the_attachment_helper_beside_signing_material_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      - name: Cleanup keystore\n",
        "      - name: Attach directly\n"
        "        run: bash scripts/attach-umbrella-release-assets.sh --tag v1.2.3\n"
        "\n      - name: Cleanup keystore\n",
    )
    assert_rejected(
        run_checker(root),
        "holds signing material and can also write a release: attach-umbrella-release-assets.sh",
    )


def test_a_release_api_call_beside_signing_material_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      - name: Cleanup keystore\n",
        "      - name: Poke the API\n"
        "        run: |\n"
        "          curl -sS https://api.github.com/repos/o/r/releases\n"
        "\n      - name: Cleanup keystore\n",
    )
    assert_rejected(
        run_checker(root),
        "holds signing material and can also write a release: api.github.com",
    )


# ── Umbrella attachment lock ──────────────────────────────────────────


CONCURRENCY_BLOCK = (
    "    concurrency:\n"
    "      group: umbrella-release-${{ github.event.client_payload.release_tag }}\n"
    "      cancel-in-progress: false\n"
    "      queue: max\n"
)
CONCURRENCY_NEEDLE = "attach-release-assets must declare exactly the reviewed umbrella-release concurrency"


def test_removing_queue_max_from_the_attachment_lock_is_rejected(tmp_path: Path) -> None:
    """Without queue: max the scheduler may discard a pending attachment."""

    root = fixture_root(tmp_path)
    mutate(root / ROOT_WORKFLOW, CONCURRENCY_BLOCK, CONCURRENCY_BLOCK.replace("      queue: max\n", ""))
    assert_rejected(run_checker(root), CONCURRENCY_NEEDLE)


def test_changing_queue_max_to_single_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(root / ROOT_WORKFLOW, "      queue: max\n", "      queue: single\n")
    assert_rejected(run_checker(root), CONCURRENCY_NEEDLE)


def test_enabling_cancellation_on_the_attachment_lock_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      cancel-in-progress: false\n      queue: max\n",
        "      cancel-in-progress: true\n      queue: max\n",
    )
    assert_rejected(run_checker(root), CONCURRENCY_NEEDLE)


def test_changing_the_umbrella_group_is_rejected(tmp_path: Path) -> None:
    """A different group stops serializing against the sibling component lanes."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      group: umbrella-release-${{ github.event.client_payload.release_tag }}\n",
        "      group: android-release-${{ github.event.client_payload.release_tag }}\n",
    )
    assert_rejected(run_checker(root), CONCURRENCY_NEEDLE)


def test_desynchronising_a_sibling_lane_lock_is_rejected(tmp_path: Path) -> None:
    """All three components must share one repository-wide domain."""

    root = fixture_root(tmp_path)
    mutate(
        root / BRIDGE_WORKFLOW,
        "      group: umbrella-release-${{ github.event.client_payload.release_tag }}\n",
        "      group: bridge-release-${{ github.event.client_payload.release_tag }}\n",
    )
    assert_rejected(
        run_checker(root),
        "release-bridge.yml attach-release-assets must declare exactly the reviewed umbrella-release",
    )


def test_removing_the_attachment_lock_entirely_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(root / ROOT_WORKFLOW, CONCURRENCY_BLOCK, "")
    assert_rejected(run_checker(root), CONCURRENCY_NEEDLE)


def test_every_attachment_mutation_also_breaks_the_exact_job_digest(tmp_path: Path) -> None:
    """The literal checks state intent; the job digest is the backstop."""

    root = fixture_root(tmp_path)
    mutate(root / ROOT_WORKFLOW, "      queue: max\n", "      queue: single\n")
    result = run_checker(root)
    assert result.returncode == 1
    assert "must match the exact reviewed attachment-job specification" in result.stdout


def test_binding_the_attachment_job_to_the_signing_environment_is_rejected(tmp_path: Path) -> None:
    """The write job must not be able to request the signing environment."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "  attach-release-assets:\n    name: Attach Android assets to the draft release\n",
        "  attach-release-assets:\n    name: Attach Android assets to the draft release\n"
        "    environment: android-release\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "attach-release-assets must not bind a deployment environment" in result.stdout


def test_a_signing_secret_in_the_attachment_job_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n"
        "          RELEASE_TAG: ${{ inputs.release_tag }}\n"
        "          SOURCE_SHA: ${{ inputs.source_sha }}\n"
        "        run: |\n          set -euo pipefail\n"
        '          bash "$GITHUB_WORKSPACE/scripts/attach-umbrella-release-assets.sh" \\\n',
        "          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n"
        "          KSTOREPWD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}\n"
        "          RELEASE_TAG: ${{ inputs.release_tag }}\n"
        "          SOURCE_SHA: ${{ inputs.source_sha }}\n"
        "        run: |\n          set -euo pipefail\n"
        '          bash "$GITHUB_WORKSPACE/scripts/attach-umbrella-release-assets.sh" \\\n',
    )
    assert_rejected(
        run_checker(root),
        "attach-release-assets must never reference Android signing secrets",
    )


def test_swapping_the_attachment_helper_for_a_release_action_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      - name: Attach the Android assets to the shared draft release\n",
        "      - name: Attach with a marketplace action\n"
        "        uses: softprops/action-gh-release@3d0d9888cb7fd7b750713d6e236d1fcb99157228 # v3.0.2\n"
        "        with:\n"
        "          tag_name: ${{ inputs.release_tag }}\n"
        "          draft: true\n"
        "\n      - name: Attach the Android assets to the shared draft release\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "attach-release-assets must not use a marketplace release action" in result.stdout


def test_dropping_the_closed_asset_artifact_is_rejected(tmp_path: Path) -> None:
    """The attachment job must consume exactly what the signed job produced."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "          name: silentsuite-android-release-assets-${{ inputs.source_sha }}\n"
        "          path: release-assets\n",
        "          path: release-assets\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "attach-release-assets must consume the closed release-asset artifact" in result.stdout


def test_dropping_the_expected_commit_from_the_attachment_is_rejected(tmp_path: Path) -> None:
    """A draft that is not bound to the admitted commit is not this release."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        '            --expected-commit "$SOURCE_SHA" \\\n',
        "",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "attach-release-assets must bind the attachment to the admitted commit" in result.stdout


# ── Delegated builds stay on the unprivileged side of the line ────────


def test_a_write_permission_in_the_delegated_bridge_build_is_rejected(tmp_path: Path) -> None:
    """The build workflow is dispatchable, so it must never be able to release."""

    root = fixture_root(tmp_path)
    mutate(
        root / BRIDGE_BUILD_WORKFLOW,
        "    permissions:\n      contents: read\n",
        "    permissions:\n      contents: write\n",
    )
    assert_rejected(
        run_checker(root),
        "job build is on the release path and must declare read-only permissions",
    )


def test_an_environment_in_the_delegated_bridge_build_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / BRIDGE_BUILD_WORKFLOW,
        "    permissions:\n      contents: read\n",
        "    environment: android-release\n    permissions:\n      contents: read\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "must not bind a deployment environment" in result.stdout


def test_a_delegated_build_from_another_repository_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / BRIDGE_WORKFLOW,
        "    uses: ./.github/workflows/build-bridge.yml\n",
        "    uses: attacker/repo/.github/workflows/build.yml@0123456789012345678901234567890123456789\n",
    )
    assert_rejected(run_checker(root), "which is not resolved at this protected revision")


def test_widening_the_delegating_job_permissions_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / BRIDGE_WORKFLOW,
        "  build:\n    name: Build bridge binaries\n    permissions:\n      contents: read\n",
        "  build:\n    name: Build bridge binaries\n    permissions:\n      contents: write\n",
    )
    assert_rejected(
        run_checker(root),
        "job build delegates a build and must declare read-only permissions",
    )


def test_a_tag_trigger_on_the_delegated_bridge_build_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / BRIDGE_BUILD_WORKFLOW,
        "on:\n  workflow_call:\n",
        "on:\n  push:\n    tags:\n      - 'v*'\n  workflow_call:\n",
    )
    assert_rejected(run_checker(root), "declares a tag-push trigger")


# ── Owner-only release initiation ─────────────────────────────────────


OWNER_GATE = """      - name: Require the release owner as dispatch sender
        shell: bash
        env:
          SENDER_ID: ${{ github.event.sender.id }}
          OWNER_ID: '265568982'
"""


def test_removing_the_owner_sender_gate_is_rejected(tmp_path: Path) -> None:
    """Without it, any write collaborator could start a release."""

    root = fixture_root(tmp_path)
    workflow = root / CONTROLLER
    text = workflow.read_text(encoding="utf-8")
    start = text.index(OWNER_GATE)
    end = text.index("      - name: Check out the protected controller revision", start)
    workflow.write_text(text[:start] + text[end:], encoding="utf-8")
    assert_rejected(run_checker(root), "must begin with the exact reviewed owner-sender gate")


def test_changing_the_owner_account_id_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(root / CONTROLLER, "OWNER_ID: '265568982'", "OWNER_ID: '999999999'")
    assert_rejected(run_checker(root), "must begin with the exact reviewed owner-sender gate")


def test_authorising_by_actor_login_instead_of_account_id_is_rejected(tmp_path: Path) -> None:
    """A login can be renamed and the freed name re-registered."""

    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "          SENDER_ID: ${{ github.event.sender.id }}\n",
        "          SENDER_ID: ${{ github.actor }}\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "must not authorise by github.actor" in result.stdout
    assert "must begin with the exact reviewed owner-sender gate" in result.stdout


def test_moving_the_owner_gate_after_the_payload_is_read_is_rejected(tmp_path: Path) -> None:
    """A gate that runs after the payload has already consumed attacker input."""

    root = fixture_root(tmp_path)
    workflow = root / CONTROLLER
    text = workflow.read_text(encoding="utf-8")
    start = text.index(OWNER_GATE)
    end = text.index("      - name: Check out the protected controller revision", start)
    gate = text[start:end]
    text = text[:start] + text[end:]
    anchor = "      - name: Verify the live release identity and tag rulesets\n"
    workflow.write_text(text.replace(anchor, gate + anchor, 1), encoding="utf-8")
    assert_rejected(run_checker(root), "must begin with the exact reviewed owner-sender gate")


def test_turning_the_owner_gate_into_a_skipping_job_condition_is_rejected(tmp_path: Path) -> None:
    """A skipped admission job reports success; a refused release must fail."""

    root = fixture_root(tmp_path)
    mutate(
        root / CONTROLLER,
        "  admit:\n    name: Admit the release source\n",
        "  admit:\n    name: Admit the release source\n"
        "    if: github.event.sender.id == 265568982\n",
    )
    assert_rejected(run_checker(root), "must not gate itself with a job-level condition")


# ── Revalidation immediately before each irreversible act ─────────────


ANDROID_GUARDS = {
    "Revalidate the release identity before decoding signing material": "Decode release keystore",
    "Revalidate the release identity before publishing signed artifacts": (
        "Upload signed split evidence"
    ),
    "Revalidate the release identity before the attachment handoff": (
        "Publish the closed release-asset set to the attachment job"
    ),
}


def guard_block(text: str, guard: str) -> str:
    start = text.index(f"      - name: {guard}\n")
    end = text.index("      - name: ", start + 10)
    return text[start:end]


@pytest.mark.parametrize("guard", sorted(ANDROID_GUARDS), ids=lambda value: value[-24:])
def test_removing_an_android_revalidation_is_rejected(tmp_path: Path, guard: str) -> None:
    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    text = workflow.read_text(encoding="utf-8")
    workflow.write_text(text.replace(guard_block(text, guard), "", 1), encoding="utf-8")
    assert_rejected(
        run_checker(root),
        f"must contain exactly one {guard!r} step matching its reviewed "
        "trusted-revalidation literal",
    )


@pytest.mark.parametrize("guard", sorted(ANDROID_GUARDS), ids=lambda value: value[-24:])
def test_separating_a_revalidation_from_the_step_it_guards_is_rejected(
    tmp_path: Path, guard: str
) -> None:
    """The check must be immediately before the act, not merely somewhere above."""

    root = fixture_root(tmp_path)
    workflow = root / ROOT_WORKFLOW
    text = workflow.read_text(encoding="utf-8")
    guarded = ANDROID_GUARDS[guard]
    intruder = "      - name: Slip something in between\n        run: echo drift\n\n"
    workflow.write_text(
        text.replace(f"      - name: {guarded}\n", intruder + f"      - name: {guarded}\n", 1),
        encoding="utf-8",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "must revalidate the release identity immediately before" in result.stdout
    assert guarded in result.stdout


def test_pointing_a_revalidation_at_the_candidate_tree_is_rejected(tmp_path: Path) -> None:
    """The candidate must not supply the code that admits it."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        '          bash "$GITHUB_WORKSPACE/scripts/verify-release-identity.sh" \\\n'
        '            --tag "$RELEASE_TAG" \\\n'
        '            --commit "$SOURCE_SHA" \\\n'
        "            --stage android-signing-material\n",
        '          bash "$GITHUB_WORKSPACE/unsigned/verify-release-identity.sh" \\\n'
        '            --tag "$RELEASE_TAG" \\\n'
        '            --commit "$SOURCE_SHA" \\\n'
        "            --stage android-signing-material\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "matching its reviewed trusted-revalidation literal" in result.stdout


def test_removing_the_trusted_checkout_from_the_signing_job_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(root / ROOT_WORKFLOW, SIGN_JOB_CHECKOUT, "      - name: Set up JDK 17\n")
    result = run_checker(root)
    assert result.returncode == 1
    assert "must check out the admitted commit and then the trusted controller revision" in result.stdout


def test_adding_a_candidate_checkout_to_the_signing_job_is_rejected(tmp_path: Path) -> None:
    """The whole point of the split: no candidate byte on the signing runner."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        SIGN_JOB_CHECKOUT,
        RELEASE_CHECKOUT
        + "\n      - name: Checkout the candidate\n"
        "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n"
        "        with:\n"
        "          ref: ${{ inputs.source_sha }}\n"
        "          path: candidate\n"
        "          persist-credentials: false\n"
        + "\n      - name: Set up JDK 17\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "must check out the admitted commit and then the trusted controller revision" in result.stdout


def test_running_candidate_gradle_in_the_signing_job_is_rejected(tmp_path: Path) -> None:
    """Gradle is the candidate's own code; it must never share this runner."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      - name: Sign the admitted APK and AAB\n",
        "      - name: Rebuild with Gradle\n"
        "        run: ./gradlew assembleRelease\n"
        "\n      - name: Sign the admitted APK and AAB\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "must not execute candidate build tooling" in result.stdout


def test_drifting_the_exact_android_build_tools_install_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        '"$SDKMANAGER" "build-tools;36.0.0"\n',
        '"$SDKMANAGER" "build-tools;35.0.0"\n',
    )
    assert_rejected(
        run_checker(root),
        "must install and check exact build-tools;36.0.0 with the reviewed fixed-path step",
    )


def test_downgrading_native_library_alignment_to_deprecated_p_is_rejected(
    tmp_path: Path,
) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SIGNING_HELPER,
        '"$ZIPALIGN" -P 16 -f 4',
        '"$ZIPALIGN" -p -f 4',
    )
    assert_rejected(run_checker(root), "must not use deprecated zipalign -p")


def test_handing_the_workflow_token_to_an_unreviewed_step_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "      - name: Fetch the pinned bundletool\n        env:\n",
        "      - name: Fetch the pinned bundletool\n        env:\n"
        "          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "may name the workflow token only in its reviewed revalidation steps" in result.stdout


def test_a_token_at_signing_job_scope_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "    environment: android-release\n    permissions:\n      contents: read\n",
        "    environment: android-release\n    permissions:\n      contents: read\n"
        "    env:\n      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "must not define job-level env" in result.stdout


def test_a_step_that_only_borrows_a_revalidation_name_is_still_swept(tmp_path: Path) -> None:
    """The token carve-out applies to byte-identical reviewed steps only."""

    root = fixture_root(tmp_path)
    mutate(
        root / ROOT_WORKFLOW,
        "            --stage android-signing-material\n",
        "            --stage android-signing-material\n"
        '          curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/x\n',
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "holds signing material and can also write a release" in result.stdout
    assert "matching its reviewed trusted-revalidation literal" in result.stdout


# ── Server registry alias writes ──────────────────────────────────────


def test_removing_the_per_alias_revalidation_is_rejected(tmp_path: Path) -> None:
    """One check at the top of the step leaves the second alias write unguarded."""

    root = fixture_root(tmp_path)
    mutate(root / SERVER_WORKFLOW, '            revalidate_identity "$reference"\n', "")
    assert_rejected(
        run_checker(root),
        'must run revalidate_identity "$reference" immediately before '
        "docker buildx imagetools create",
    )


def test_separating_the_revalidation_from_the_alias_write_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SERVER_WORKFLOW,
        '            revalidate_identity "$reference"\n'
        "            docker buildx imagetools create \\\n",
        '            revalidate_identity "$reference"\n'
        '            echo "publishing ${reference}"\n'
        "            docker buildx imagetools create \\\n",
    )
    assert_rejected(run_checker(root), "immediately before docker buildx imagetools create")


def test_hoisting_the_alias_revalidation_out_of_the_writing_helper_is_rejected(
    tmp_path: Path,
) -> None:
    """Checking once before the loop is exactly the pattern being removed."""

    root = fixture_root(tmp_path)
    workflow = root / SERVER_WORKFLOW
    text = workflow.read_text(encoding="utf-8")
    text = text.replace('            revalidate_identity "$reference"\n', "", 1)
    text = text.replace(
        '          publish_alias "$RELEASE_TAG"\n',
        '          revalidate_identity "$RELEASE_TAG"\n          publish_alias "$RELEASE_TAG"\n',
        1,
    )
    workflow.write_text(text, encoding="utf-8")
    assert_rejected(run_checker(root), "immediately before docker buildx imagetools create")


def test_revalidating_the_alias_write_with_candidate_code_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SERVER_WORKFLOW,
        "            bash trusted/scripts/verify-release-identity.sh \\\n",
        "            bash candidate/scripts/verify-release-identity.sh \\\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "must revalidate with the trusted verifier" in result.stdout
    assert "is not inside a checkout of the protected controller revision" in result.stdout


def test_dropping_the_token_from_the_alias_step_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SERVER_WORKFLOW,
        "          ARM64_DIGEST: ${{ steps.digests.outputs.arm64 }}\n"
        "          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
        "          ARM64_DIGEST: ${{ steps.digests.outputs.arm64 }}\n",
    )
    assert_rejected(run_checker(root), "needs the workflow token for its revalidation reads")


def test_adding_a_second_unguarded_alias_write_is_rejected(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    mutate(
        root / SERVER_WORKFLOW,
        '          publish_alias "$COMMIT_REF"\n',
        '          publish_alias "$COMMIT_REF"\n'
        "          docker buildx imagetools create --tag \"${IMAGE_NAME}:extra\" \\\n"
        "            \"${IMAGE_NAME}@${AMD64_DIGEST}\"\n",
    )
    result = run_checker(root)
    assert result.returncode == 1
    assert "must perform exactly one alias write, found 2" in result.stdout
