#!/usr/bin/env python3
"""Fail closed when the release control plane or Android signing escapes it.

Two boundaries, one checker, because they are the same boundary seen from two
sides:

  * release authority is defined only by workflow code loaded from the protected
    default branch — a repository_dispatch controller and the local reusable
    workflows it calls — and never by the tag being released;
  * Android signing material lives in exactly one job of that control plane,
    which holds no repository write, no release API and no workflow token.

Everything here is structural. It parses the workflows rather than grepping
them, reviews the load-bearing jobs against exact literals, and pins the whole
of each one with a semantic digest so that any edit which is not re-reviewed
fails the check.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import yaml
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode
from yaml.resolver import BaseResolver
from yaml.tokens import AliasToken, AnchorToken, TagToken


SIGNING_SECRETS = {
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
}
WORKFLOW_DIR = Path(".github/workflows")
# The signing lane. Reachable only through workflow_call from the controller.
ROOT_WORKFLOW = WORKFLOW_DIR / "release-android.yml"
# Unprivileged Android CI. It keeps the same structural policy job and Conscrypt
# producer, and must never regain a release-producing job.
ANDROID_CI_WORKFLOW = WORKFLOW_DIR / "build-android.yml"
ANDROID_SIBLING_WORKFLOW = Path("android/.github/workflows/build.yml")
# The dispatch-only rehearsal for the release lane's reproducibility gate. It
# runs the same two builds and the same comparison, holds no signing capability
# whatsoever, and must never become a second way to produce a release artifact.
DRILL_WORKFLOW = WORKFLOW_DIR / "android-reproducibility-drill.yml"
CONSCRYPT_BUILD_SCRIPT = Path("android/scripts/build-conscrypt-android-r28.sh")

CONTROLLER_WORKFLOW = WORKFLOW_DIR / "release-controller.yml"
BRIDGE_WORKFLOW = WORKFLOW_DIR / "release-bridge.yml"
SERVER_WORKFLOW = WORKFLOW_DIR / "release-server-image.yml"
READINESS_WORKFLOW = WORKFLOW_DIR / "release-readiness.yml"
COMPONENT_WORKFLOWS = (ROOT_WORKFLOW, BRIDGE_WORKFLOW, SERVER_WORKFLOW, READINESS_WORKFLOW)
CONTROL_PLANE = (CONTROLLER_WORKFLOW, *COMPONENT_WORKFLOWS)
# The hosted-production lane. It predates and is independent of the release
# control plane, is dispatch-only, and binds its own protected environment on
# every job. Named here so the "no other privileged manual lane" rule below has
# exactly one reviewed exemption rather than a silent hole.
PRODUCTION_WORKFLOW = WORKFLOW_DIR / "deploy-server.yml"
PRODUCTION_ENVIRONMENT = "server-production"

DISPATCH_EVENT_TYPE = "silentsuite_release"
ALLOWED_JOB = "sign-release"
UNSIGNED_JOB = "build-unsigned-release"
POLICY_JOB = "signing-policy"
REVALIDATION_JOB = "revalidate-signing"
CONSCRYPT_JOB = "conscrypt-r28"
ATTACHMENT_JOB = "attach-release-assets"
ADMISSION_JOB = "admit"
# The two halves of the pre-signing reproducibility contract: an independent
# rebuild in an environment representative of F-Droid's, and the byte
# comparison that `sign-release` cannot start without.
INDEPENDENT_REBUILD_JOB = "rebuild-fdroid-environment"
REPRODUCIBILITY_GATE_JOB = "reproducibility-gate"
DRILL_SOURCE_JOB = "validate-source"
DRILL_UBUNTU_JOB = "build-unsigned-ubuntu"
DRILL_COMPARISON_JOB = "drill-comparison"
DRILL_SOURCE_REF = "${{ inputs.source_sha }}"
DRILL_UBUNTU_ARTIFACT = "silentsuite-android-drill-ubuntu-${{ inputs.source_sha }}"
DRILL_REBUILD_ARTIFACT = "silentsuite-android-drill-rebuild-${{ inputs.source_sha }}"
# The build steps the drill exists to rehearse. A drill that runs different
# steps than the gate it stands in for proves nothing about that gate, so these
# are compared as exact text against the release lane's.
DRILL_SHARED_REBUILD_STEPS = (
    "Install the Debian build environment",
    "Install the Android SDK, NDK r28 and CMake",
    "Install rustup",
    "Provision the pinned reproducible JDK",
    "Build 16 KB-aligned Etebase client AAR",
    "Build Conscrypt with Android NDK r28",
    "Build the unsigned release APK",
    "Stage the independently rebuilt APK",
)
ENVIRONMENT_NAME = "android-release"

IDENTITY_HELPER = Path("scripts/verify-release-identity.sh")
ATTACHMENT_HELPER = Path("scripts/attach-umbrella-release-assets.sh")
READINESS_HELPER = Path("scripts/verify-umbrella-release-readiness.py")
BRIDGE_STAGING_HELPER = Path("scripts/stage-bridge-release-assets.sh")
KEYSTORE_HELPER = Path("scripts/verify-android-release-keystore.sh")
ARTIFACT_ADMISSION_HELPER = Path("scripts/admit-unsigned-android-artifact.sh")
SIGNING_HELPER = Path("scripts/sign-android-release.sh")
REPRODUCIBILITY_HELPER = Path("scripts/verify-android-build-reproducibility.py")
# The developer upload certificate the signed build must produce. It is pinned
# here as well as in the helper so that changing which key the project ships
# under cannot pass as a routine script edit.
EXPECTED_UPLOAD_CERT_SHA256 = (
    "8035a4ff1511e2045c579c905d26e93af6009b239e741ef78542ae04e7a7ca79"
)
RELEASE_ASSET_ARTIFACT = "silentsuite-android-release-assets-${{ inputs.source_sha }}"
UNSIGNED_ARTIFACT = "silentsuite-android-unsigned-${{ inputs.source_sha }}"
FDROID_REBUILD_ARTIFACT = "silentsuite-android-fdroid-rebuild-${{ inputs.source_sha }}"
CONSCRYPT_ARTIFACT = "conscrypt-r28-${{ inputs.source_sha }}"
CONTAINER_DIGEST_PIN = re.compile(r"@sha256:[0-9a-f]{64}$")

# The server lane's irreversible act and the check that must immediately precede
# it. `publish_alias` returns early when the alias already exists, so verifying
# an existing alias — which mutates nothing — is deliberately not gated.
ALIAS_MERGE_STEP = "Merge verified children into the release index"
ALIAS_WRITE = "docker buildx imagetools create"
ALIAS_REVALIDATION = 'revalidate_identity "$reference"'
ALIAS_REVALIDATION_HELPER = "trusted/scripts/verify-release-identity.sh"

# Every repository script whose bytes decide whether a release is admitted,
# verified, published or attached. Inside the control plane each one may be
# executed only through a checkout of the protected controller revision.
TRUSTED_HELPERS = (
    "verify-release-identity.sh",
    "verify-android-release-keystore.sh",
    "admit-unsigned-android-artifact.sh",
    "sign-android-release.sh",
    "attach-umbrella-release-assets.sh",
    "verify-umbrella-release-readiness.py",
    "check-android-signing-boundary.py",
    "verify-server-image-release.sh",
    "stage-bridge-release-assets.sh",
    "build-self-host-bundle.py",
    "verify-self-host-bundle.py",
    "self-host-image-smoke.sh",
    # The gate that decides whether a build may be signed at all. Its bytes
    # must come from the protected revision, never from the tree being released.
    "verify-android-build-reproducibility.py",
)
TRUSTED_REF = "${{ github.sha }}"

# Anything that can reach the release API or a repository write. None of these
# may appear in a job that also holds signing material.
RELEASE_WRITE_MARKERS = (
    "attach-umbrella-release-assets.sh",
    "softprops/action-gh-release",
    "gh release",
    "api.github.com",
    "uploads.github.com",
    "${{ secrets.GITHUB_TOKEN }}",
)
SHA_PIN = re.compile(r"^[0-9a-f]{40}$")
UNSAFE_SECRET_EXPRESSION = re.compile(
    r"\bsecrets\s*\[|\bsecrets\s*\.\s*\*|\btojson\s*\(\s*secrets\s*\)",
    re.IGNORECASE,
)
CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
SETUP_PYTHON_ACTION = "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97"
PIP_INSTALL_POLICY_DEPENDENCY = (
    "printf '%s\\n' 'PyYAML==6.0.3 "
    "--hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc' "
    '> "$RUNNER_TEMP/android-signing-policy-requirements.txt"\n'
    "python -m pip install --disable-pip-version-check --only-binary=:all: "
    '--require-hashes -r "$RUNNER_TEMP/android-signing-policy-requirements.txt"\n'
)
# The release lane's copy pins the policy source to the protected controller
# revision; the CI copy has no admitted commit to distinguish itself from.
EXPECTED_POLICY_JOB: dict[str, Any] = {
    "name": "Enforce Android signing boundary",
    "runs-on": "ubuntu-latest",
    "permissions": {"contents": "read"},
    "steps": [
        {
            "name": "Set up Python",
            "uses": SETUP_PYTHON_ACTION,
            "with": {"python-version": "3.12"},
        },
        {
            "name": "Install signing policy dependency",
            "run": PIP_INSTALL_POLICY_DEPENDENCY,
        },
        {
            "name": "Checkout policy source",
            "uses": CHECKOUT_ACTION,
            "with": {
                "ref": TRUSTED_REF,
                "clean": "true",
                "persist-credentials": "false",
            },
        },
        {
            "name": "Enforce Android signing boundary",
            "run": 'python "$GITHUB_WORKSPACE/scripts/check-android-signing-boundary.py"',
        },
    ],
}
EXPECTED_CI_POLICY_JOB: dict[str, Any] = {
    "name": "Enforce Android signing boundary",
    "runs-on": "ubuntu-latest",
    "permissions": {"contents": "read"},
    "steps": [
        {
            "name": "Set up Python",
            "uses": SETUP_PYTHON_ACTION,
            "with": {"python-version": "3.12"},
        },
        {
            "name": "Install signing policy dependency",
            "run": PIP_INSTALL_POLICY_DEPENDENCY,
        },
        {
            "name": "Checkout policy source",
            "uses": CHECKOUT_ACTION,
            "with": {"clean": "true", "persist-credentials": "false"},
        },
        {
            "name": "Enforce Android signing boundary",
            "run": 'python "$GITHUB_WORKSPACE/scripts/check-android-signing-boundary.py"',
        },
    ],
}
EXPECTED_RELEASE_STEP_ENVIRONMENTS: dict[str, dict[str, str]] = {
    "Decode release keystore": {
        "KEYSTORE_BASE64": "${{ secrets.ANDROID_KEYSTORE_BASE64 }}",
    },
    "Verify the release keystore before signing": {
        "KSTOREPWD": "${{ secrets.ANDROID_KEYSTORE_PASSWORD }}",
        "KEY_ALIAS": "${{ secrets.ANDROID_KEY_ALIAS }}",
    },
    "Sign the admitted APK and AAB": {
        "KSTOREPWD": "${{ secrets.ANDROID_KEYSTORE_PASSWORD }}",
        "KEY_ALIAS": "${{ secrets.ANDROID_KEY_ALIAS }}",
    },
}
# Steps in the signed job that carry a non-secret environment. Naming them keeps
# the "a step environment is reviewed or absent" rule intact now that the
# admitted tag reaches the job as an input rather than as github.ref_name.
EXPECTED_RELEASE_PLAIN_STEP_ENVIRONMENTS: dict[str, dict[str, str]] = {
    "Stage the closed release-asset set": {"RELEASE_TAG": "${{ inputs.release_tag }}"},
    "Admit the unsigned build": {"SOURCE_SHA": "${{ inputs.source_sha }}"},
    "Fetch the pinned bundletool": {
        "BUNDLETOOL_VERSION": "1.18.1",
        "BUNDLETOOL_SHA256": "675786493983787ffa11550bdb7c0715679a44e1643f3ff980a529e9c822595c",
    },
}
EXPECTED_BUILD_TOOLS_INSTALL_STEP = {
    "name": "Install the exact Android signing tools",
    "run": """set -euo pipefail
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
[ -f "$SDKMANAGER" ] && [ -x "$SDKMANAGER" ] \\
  || { echo "fixed Android sdkmanager is missing or not executable" >&2; exit 1; }
CANONICAL_ANDROID_HOME="$(readlink -f -- "$ANDROID_HOME")"
CANONICAL_SDKMANAGER="$(readlink -f -- "$SDKMANAGER")"
case "$CANONICAL_SDKMANAGER" in
  "$CANONICAL_ANDROID_HOME"/*) ;;
  *) echo "fixed Android sdkmanager resolves outside ANDROID_HOME" >&2; exit 1 ;;
esac
"$SDKMANAGER" "build-tools;36.0.0"
BUILD_TOOLS="$ANDROID_HOME/build-tools/36.0.0"
[ -d "$BUILD_TOOLS" ] \\
  || { echo "build-tools;36.0.0 was not installed at its exact path" >&2; exit 1; }
for tool in zipalign apksigner; do
  [ -f "$BUILD_TOOLS/$tool" ] && [ -x "$BUILD_TOOLS/$tool" ] \\
    || { echo "build-tools;36.0.0/$tool is missing or not executable" >&2; exit 1; }
done
""",
}
# The umbrella-draft attachment lock, shared by all three component lanes.
# Reviewed as an exact literal so a release cannot be quietly re-scoped: a
# different group would stop serializing against the sibling component lanes,
# cancel-in-progress would drop an attachment mid-upload, and anything other
# than queue: max lets the scheduler discard a pending attachment without
# failing anything.
UMBRELLA_GROUP = "umbrella-release-${{ github.event.client_payload.release_tag }}"
EXPECTED_RELEASE_CONCURRENCY: dict[str, Any] = {
    "group": UMBRELLA_GROUP,
    "cancel-in-progress": "false",
    "queue": "max",
}

# Every `secrets.NAME` the signed release job is allowed to name. The reviewed
# step environments below are the only place any of them may appear, so a new
# credential — a repository-settings reader, a release token, anything — cannot
# be introduced into the job that holds the decoded keystore.
#
# GITHUB_TOKEN is on this list only because the job revalidates the release
# identity immediately before each irreversible act, and that read needs an
# authenticated rate limit. It is admissible only inside the four reviewed
# revalidation steps below, which are compared as exact literals; `check`
# separately proves it appears nowhere else in the job, so candidate Gradle and
# candidate scripts cannot receive it. The job holds `contents: read`, so the
# token cannot write a release even if it escaped.
ALLOWED_RELEASE_SECRETS = set(SIGNING_SECRETS) | {"GITHUB_TOKEN"}
WORKFLOW_TOKEN = "${{ secrets.GITHUB_TOKEN }}"
SECRET_REFERENCE = re.compile(r"secrets\.\s*([A-Za-z_][A-Za-z0-9_-]*)")

# The signed job checks out the admitted commit and keeps no credential from it,
# then checks the protected controller revision out into a separate path so the
# verifier it runs is never candidate code. Reviewed as exact literals, in this
# order: dropping `persist-credentials: false` would hand a repository write
# token to Gradle and every build script it runs, beside the decoded keystore,
# and checking the trusted copy out first would let the candidate checkout's
# clean sweep remove it.
EXPECTED_RELEASE_CHECKOUTS: list[dict[str, Any]] = [
    {
        "name": "Check out the trusted controller revision",
        "uses": CHECKOUT_ACTION,
        "with": {"ref": TRUSTED_REF, "clean": "true", "persist-credentials": "false"},
    },
]

# One reviewed literal per irreversible boundary inside the signed job. Each runs
# the verifier out of the trusted checkout, carries the workflow token, and
# nothing else. `check` asserts they appear in this order and that each one
# immediately precedes the step it guards.
def _revalidation_step(name: str, stage: str) -> dict[str, Any]:
    return {
        "name": name,
        "env": {
            "GITHUB_TOKEN": WORKFLOW_TOKEN,
            "RELEASE_TAG": "${{ inputs.release_tag }}",
            "SOURCE_SHA": "${{ inputs.source_sha }}",
        },
        "run": (
            "set -euo pipefail\n"
            'bash "$GITHUB_WORKSPACE/scripts/verify-release-identity.sh" \\\n'
            '  --tag "$RELEASE_TAG" \\\n'
            '  --commit "$SOURCE_SHA" \\\n'
            f"  --stage {stage}\n"
        ),
    }


# The keystore must be proven readable, correctly aliased and bound to the
# reviewed certificate between decoding it and handing it to Gradle.
KEYSTORE_DECODE_STEP = "Decode release keystore"
KEYSTORE_VERIFY_STEP = "Verify the release keystore before signing"
KEYSTORE_CONSUMER_STEP = "Sign the admitted APK and AAB"

# revalidation step name -> the step name it must immediately precede.
RELEASE_MUTATION_BOUNDARIES: dict[str, str] = {
    "Revalidate the release identity before decoding signing material": "Decode release keystore",
    "Revalidate the release identity before publishing signed artifacts": (
        "Upload signed split evidence"
    ),
    "Revalidate the release identity before the attachment handoff": (
        "Publish the closed release-asset set to the attachment job"
    ),
}
EXPECTED_RELEASE_REVALIDATION_STEPS: dict[str, dict[str, Any]] = {
    "Revalidate the release identity before decoding signing material": _revalidation_step(
        "Revalidate the release identity before decoding signing material",
        "android-signing-material",
    ),
    "Revalidate the release identity before publishing signed artifacts": _revalidation_step(
        "Revalidate the release identity before publishing signed artifacts",
        "android-signed-artifact-egress",
    ),
    "Revalidate the release identity before the attachment handoff": _revalidation_step(
        "Revalidate the release identity before the attachment handoff",
        "android-attachment-handoff",
    ),
}

# The read-only job that revalidates the live tag, its commit and both tag
# rulesets in the last moment before signing material exists on any runner. It
# is a separate job so this entry check never shares a runner with candidate
# code. The signed job performs its own later trusted checks with the workflow
# token scoped only to those exact steps.
EXPECTED_REVALIDATION_JOB: dict[str, Any] = {
    "name": "Revalidate the release identity before signing",
    "needs": CONSCRYPT_JOB,
    "runs-on": "ubuntu-latest",
    "timeout-minutes": "10",
    "permissions": {"contents": "read"},
    "steps": [
        {
            "name": "Check out the trusted controller revision",
            "uses": CHECKOUT_ACTION,
            "with": {
                "ref": TRUSTED_REF,
                "clean": "true",
                "persist-credentials": "false",
            },
        },
        {
            "name": "Verify the live release identity and tag rulesets",
            "env": {
                "GITHUB_TOKEN": "${{ secrets.GITHUB_TOKEN }}",
                "RELEASE_TAG": "${{ inputs.release_tag }}",
                "SOURCE_SHA": "${{ inputs.source_sha }}",
            },
            "run": (
                "set -euo pipefail\n"
                'bash "$GITHUB_WORKSPACE/scripts/verify-release-identity.sh" \\\n'
                '  --tag "$RELEASE_TAG" \\\n'
                '  --commit "$SOURCE_SHA" \\\n'
                "  --stage android-signing\n"
            ),
        },
    ],
}

# The controller's admission job: the only place a dispatch payload becomes an
# admitted (tag, commit) pair, and the only privileged job that runs before any
# candidate code exists on a runner.
EXPECTED_CONTROLLER_ADMIT_PERMISSIONS = {"contents": "read"}
# The repository owner's numeric account id. `repository_dispatch` is available
# to any token with repository write access, so this comparison — not a ruleset
# field the lane cannot read — is what makes release initiation owner-only.
# Numeric because a login can be renamed and the name reused.
RELEASE_OWNER_ID = "265568982"
EXPECTED_OWNER_GATE_STEP: dict[str, Any] = {
    "name": "Require the release owner as dispatch sender",
    "shell": "bash",
    "env": {
        "SENDER_ID": "${{ github.event.sender.id }}",
        "OWNER_ID": RELEASE_OWNER_ID,
    },
    "run": (
        "set -euo pipefail\n"
        "if ! printf '%s' \"$SENDER_ID\" | grep -Eq '^[0-9]+$'; then\n"
        '  echo "Refusing release: the dispatch carried no numeric sender id" >&2\n'
        "  exit 1\n"
        "fi\n"
        'if [ "$SENDER_ID" != "$OWNER_ID" ]; then\n'
        '  echo "Refusing release: sender id ${SENDER_ID} is not the release owner" >&2\n'
        "  exit 1\n"
        "fi\n"
        'echo "Dispatch sender is the release owner (${OWNER_ID})"\n'
    ),
}
# Authorisation must never be derived from a mutable display name.
LOGIN_AUTHORISATION_MARKERS = (
    "github.actor",
    "github.triggering_actor",
    "github.event.sender.login",
)
EXPECTED_CONTROLLER_CALLERS: dict[str, dict[str, Any]] = {
    "android": {
        "uses": "./.github/workflows/release-android.yml",
        "permissions": {"contents": "write"},
    },
    "bridge": {
        "uses": "./.github/workflows/release-bridge.yml",
        "permissions": {"contents": "write"},
    },
    "server": {
        "uses": "./.github/workflows/release-server-image.yml",
        "permissions": {
            "contents": "write",
            "packages": "write",
            "id-token": "write",
            "attestations": "write",
        },
    },
    "readiness": {
        "uses": "./.github/workflows/release-readiness.yml",
        "permissions": {"contents": "write"},
    },
}
EXPECTED_CALLER_INPUTS = {
    "release_tag": "${{ needs.admit.outputs.tag }}",
    "source_sha": "${{ needs.admit.outputs.commit }}",
}
EXPECTED_ANDROID_CALLER_SECRETS = {
    name: f"${{{{ secrets.{name} }}}}" for name in SIGNING_SECRETS
}
EXPECTED_COMPONENT_INPUTS = {
    "release_tag": {
        "description": "The admitted immutable release tag.",
        "required": "true",
        "type": "string",
    },
    "source_sha": {
        "description": "The admitted 40-hex source commit.",
        "required": "true",
        "type": "string",
    },
}
EXPECTED_ANDROID_CALLABLE_SECRETS = {
    "ANDROID_KEYSTORE_BASE64": {
        "description": "Base64-encoded Android release keystore.",
        "required": "true",
    },
    "ANDROID_KEYSTORE_PASSWORD": {
        "description": "Password for the Android release keystore.",
        "required": "true",
    },
    "ANDROID_KEY_ALIAS": {
        "description": "Alias of the Android release signing key.",
        "required": "true",
    },
}

EXPECTED_SECRET_STEP_SHA256 = {
    "Decode release keystore": "d0893a6a12d2aa1b8add481df288b4f70e91d9eaa1d6c4f92c4b4ff696c538b7",
    "Verify the release keystore before signing": "f0e6e9ad363f19af8682bfa48c7d9f42cc89b8bd199b03cd57b2a3156d7ef881",
    "Sign the admitted APK and AAB": "70ee6491fc048b35aa47860c854ed590d732082ab72930cc02e3470d471545a8",
}
# Signing steps and the two reviewed plain-environment steps are the only steps
# in the release job permitted to carry an environment at all.
REVIEWED_RELEASE_STEP_ENVIRONMENTS: dict[str, dict[str, str]] = {
    **EXPECTED_RELEASE_STEP_ENVIRONMENTS,
    **EXPECTED_RELEASE_PLAIN_STEP_ENVIRONMENTS,
    **{name: step["env"] for name, step in EXPECTED_RELEASE_REVALIDATION_STEPS.items()},
}
# Covers the whole reviewed signing job: the explicit literal checks state the
# intent, this digest makes any other edit to the job fail closed as well.
EXPECTED_RELEASE_JOB_SHA256 = "97c4b717570a2e6e50156f1fc2e5589c88e6b6e7ac737259acd661957a2f0da4"
# The Android caller is the only controller job allowed to grant secrets. Pin
# its entire semantic job after reviewing the exact three-name capability map.
EXPECTED_CONTROLLER_ANDROID_JOB_SHA256 = "8caa709d1d1680daff0e2e53438072c113c265cfdd8fcb6064f9f2cc808df237"
# Drafts are invisible to the Actions integration at contents:read. These
# semantic pins make the exceptional write-capability caller and called job a
# closed specification rather than a general-purpose release writer.
EXPECTED_CONTROLLER_READINESS_JOB_SHA256 = "b1ebaab82df3634d071533f54a6ea43c510ad608b93ec940c9eeb17364f9f7f0"
EXPECTED_READINESS_WORKFLOW_SHA256 = "f3331dd191728bb497a0df8b88df9cc4426da9fba40b8d0a1c20b912f50c0d4f"
EXPECTED_READINESS_JOB_SHA256 = "debdf8eab733402d4ebb98b30ab5c3b5e93c7f78f14aa959669fe6308f9510bb"
EXPECTED_UNSIGNED_JOB_SHA256 = "97cfc880945b8d1cc0c60f877c271efdf63d4d9d4b9dffe4a29bf588b2182c29"
# Same treatment for the one job that can write a release. It carries the write
# credential, the attachment helper and the umbrella lock, so every byte of it
# is reviewed.
EXPECTED_ATTACHMENT_JOB_SHA256 = "a7ca21a04a0f403520773be23fb89aa9a39b6ebc91c74d970dc23f8312be5a0e"
# The reproducibility contract's two jobs, pinned like every other job whose
# removal or weakening would let an unreproducible build reach the keystore.
EXPECTED_REBUILD_JOB_SHA256 = "0ace4ed71ba7dc904ff984c8f56fd189a8d8a22d43e68c4c98d99ffec99319f8"
EXPECTED_DRILL_WORKFLOW_SHA256 = "1439bb21ca262db01194b61bb56429712a55dad955508c30846f4311ff6ed460"
EXPECTED_REPRODUCIBILITY_GATE_JOB_SHA256 = "9af962149c7ec149d87360d8cee00ff92261eb494bbc2a28d65ec2feedeaec19"
EXPECTED_CONTROLLER_ADMIT_SHA256 = "6423d79810b64d292382c9bccab15a7b0ed342a6ff6e7272972502a868a3d958"
# The helpers those jobs execute. Hashing the step is not enough: the step text
# is stable while the file it runs is what reaches the network and the API.
EXPECTED_IDENTITY_HELPER_SHA256 = "855c557e36e8fb55979e6877b02808d1ed0e40dafb9e8b7195e711f76d4b5da7"
EXPECTED_ATTACHMENT_HELPER_SHA256 = "f37f415e7ec9439fe2e16c7e68a32a7ff0f8927de77eb2266480549e93aca875"
EXPECTED_ARTIFACT_ADMISSION_SHA256 = "5c810ac880a6f91c334dc108c456927a70dbbbd6284016f14fd11a4ea01c4b4e"
EXPECTED_SIGNING_HELPER_SHA256 = "6e36285e5837ac13eb8ef20e1a34d07eb88b857c1acaffbaff6af458ed94ade5"
EXPECTED_REPRODUCIBILITY_HELPER_SHA256 = "f968f9cb21cbcab1bdb65d624727514579c3daca7b3b1722234383e08447c767"
EXPECTED_KEYSTORE_HELPER_SHA256 = "b9b0c8046a85209754c5e206b9cc1778036d2366d0709caf9a60fbf741f5c9b6"
EXPECTED_READINESS_HELPER_SHA256 = "c75ebfba772c4f7bd6559161f64df3127c9c390bf1e5a81e39236ba47cc6e26f"
EXPECTED_BRIDGE_STAGING_HELPER_SHA256 = "b9dd8980fa763c485caa5ac999b2ba9f9d187a9545e02e3cc580425fc223e0b6"
# The Conscrypt producer exists twice: unprivileged CI builds it from the
# triggering ref, the release lane builds it from the admitted commit. Both are
# pinned so neither can drift into an unreviewed native toolchain.
EXPECTED_CI_CONSCRYPT_JOB_SHA256 = "ed27963320252615ff159bbc388c858fdc872516fc0ea2aa5f50d905f4a5063b"
EXPECTED_RELEASE_CONSCRYPT_JOB_SHA256 = "e7d36401f4d350a09355af11917f22f1e66b7a466c87723b77aad77f978a455c"
EXPECTED_CONSCRYPT_BUILD_SCRIPT_SHA256 = (
    "2d51d2c55e5b0080ea7ec01651ad5e1d2687623c4fa49796bc8ca621b11c2125"
)
ALLOWED_RELEASE_JOB_KEYS = {
    "name",
    "needs",
    "if",
    "runs-on",
    "environment",
    "permissions",
    "steps",
}
ALLOWED_ATTACHMENT_JOB_KEYS = {
    "name",
    "needs",
    "if",
    "runs-on",
    "permissions",
    "concurrency",
    "env",
    "steps",
}
ALLOWED_RELEASE_STEP_KEYS = {"name", "uses", "with", "run", "env", "if"}
REQUIRED_TRIGGER_PATHS = {
    ".github/workflows/**",
    "android/.github/workflows/**",
    "runbooks/android-release.md",
    "scripts/check-android-signing-boundary.py",
    "tests/test_android_*.py",
}


class StrictBaseLoader(yaml.BaseLoader):
    """BaseLoader with parser-differential features rejected."""


def construct_unique_mapping(
    loader: StrictBaseLoader,
    node: MappingNode,
    deep: bool = False,
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in mapping
        except TypeError as exc:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                "found an unhashable key",
                key_node.start_mark,
            ) from exc
        if duplicate:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"found duplicate key {key!r}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


StrictBaseLoader.add_constructor(BaseResolver.DEFAULT_MAPPING_TAG, construct_unique_mapping)


def load_workflow(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
        if any(isinstance(token, (AnchorToken, AliasToken, TagToken)) for token in yaml.scan(text)):
            raise ValueError("YAML anchors, aliases, and explicit tags are not allowed")
        parsed = yaml.load(text, Loader=StrictBaseLoader)
    except ValueError:
        raise
    except yaml.YAMLError as exc:
        raise ValueError(f"invalid YAML: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("workflow root must be a mapping")
    return parsed


def walk(value: Any) -> Iterator[Any]:
    yield value
    if isinstance(value, Mapping):
        for key, item in value.items():
            yield from walk(key)
            yield from walk(item)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for item in value:
            yield from walk(item)


def strings(value: Any) -> Iterator[str]:
    for item in walk(value):
        if isinstance(item, str):
            yield item


def signing_references(value: Any) -> set[str]:
    body = "\n".join(strings(value)).casefold()
    return {name for name in SIGNING_SECRETS if name.casefold() in body}


def contains_unsafe_secret_expression(value: Any) -> bool:
    return any(UNSAFE_SECRET_EXPRESSION.search(item) for item in strings(value))


def contains_secret_inheritance(value: Any) -> bool:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key == "secrets" and item == "inherit":
                return True
            if contains_secret_inheritance(item):
                return True
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return any(contains_secret_inheritance(item) for item in value)
    return False


def environment_name(job: Mapping[str, Any]) -> str | None:
    value = job.get("environment")
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        name = value.get("name")
        return name if isinstance(name, str) else None
    return None


def permissions_read_only(value: Any) -> bool:
    if value == "read-all":
        return True
    return isinstance(value, Mapping) and all(level in {"read", "none"} for level in value.values())


def semantic_sha256(value: Any) -> str:
    payload = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def action_uses(value: Any) -> Iterator[str]:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key == "uses" and isinstance(item, str):
                yield item
            yield from action_uses(item)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for item in value:
            yield from action_uses(item)


def unpinned_action(target: str) -> bool:
    if target.startswith("./"):
        return False
    if "@" not in target:
        return True
    return not SHA_PIN.fullmatch(target.rsplit("@", 1)[1])


def as_mapping(value: Any, label: str, violations: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        violations.append(f"{label} must be a mapping")
        return {}
    return value


def triggers(workflow: Mapping[str, Any]) -> dict[str, Any]:
    events = workflow.get("on")
    return events if isinstance(events, Mapping) else {}


def trigger_paths(workflow: Mapping[str, Any], event: str) -> list[str]:
    config = triggers(workflow).get(event)
    if not isinstance(config, Mapping):
        return []
    paths = config.get("paths")
    if not isinstance(paths, Sequence) or isinstance(paths, (str, bytes)):
        return []
    return [item for item in paths if isinstance(item, str)]


def job_steps(job: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    steps = job.get("steps")
    if not isinstance(steps, list):
        return []
    return [step for step in steps if isinstance(step, Mapping)]


def checkout_refs(job: Mapping[str, Any]) -> list[tuple[str | None, str]]:
    """Every checkout in a job as (ref, path). `None` ref means the default."""

    found: list[tuple[str | None, str]] = []
    for step in job_steps(job):
        uses = step.get("uses")
        if not isinstance(uses, str) or not uses.startswith("actions/checkout@"):
            continue
        options = step.get("with") if isinstance(step.get("with"), Mapping) else {}
        ref = options.get("ref")
        path = options.get("path")
        found.append((ref if isinstance(ref, str) else None, path if isinstance(path, str) else "."))
    return found


def trusted_helper_references(job: Mapping[str, Any]) -> list[str]:
    """Every token in a job's run scripts that invokes a trusted helper."""

    pattern = re.compile(r"[^\s'\"]*scripts/(?:" + "|".join(re.escape(h) for h in TRUSTED_HELPERS) + r")")
    found: list[str] = []
    for step in job_steps(job):
        run = step.get("run")
        if not isinstance(run, str):
            continue
        for token in pattern.findall(run):
            # A command substitution keeps its `$(` in the matched token; the
            # path being invoked is what matters, so strip it before checking.
            found.append(token[2:] if token.startswith("$(") else token)
    return found


def check_trusted_helper_sources(
    relative: Path, job_name: str, job: Mapping[str, Any], violations: list[str]
) -> None:
    """No control-plane job may run a helper out of the candidate checkout."""

    references = trusted_helper_references(job)
    if not references:
        return
    checkouts = checkout_refs(job)
    trusted_paths = {path for ref, path in checkouts if ref == TRUSTED_REF}
    candidate_paths = {path for ref, path in checkouts if ref is not None and ref != TRUSTED_REF}
    if not trusted_paths:
        violations.append(
            f"{relative} job {job_name} runs {sorted(set(references))} without checking out the "
            f"protected controller revision (ref: {TRUSTED_REF})"
        )
        return
    if candidate_paths & trusted_paths:
        violations.append(
            f"{relative} job {job_name} checks the candidate and the controller out at the same "
            "path, so a helper's source is ambiguous"
        )
        return

    allowed: set[str] = set()
    for helper in TRUSTED_HELPERS:
        for path in trusted_paths:
            if path in {".", ""}:
                prefixes = ("", "./", "$GITHUB_WORKSPACE/", "${GITHUB_WORKSPACE}/")
            else:
                prefixes = (f"{path}/", f"./{path}/", f"$GITHUB_WORKSPACE/{path}/")
            allowed |= {f"{prefix}scripts/{helper}" for prefix in prefixes}

    for reference in references:
        if reference not in allowed:
            violations.append(
                f"{relative} job {job_name} runs '{reference}', which is not inside a checkout of "
                f"the protected controller revision ({sorted(trusted_paths)})"
            )


def check_reproducibility_contract(
    jobs: Mapping[str, Any], violations: list[str]
) -> None:
    """The pre-signing proof that this build is not machine-specific.

    F-Droid will not publish a developer-signed APK it cannot rebuild from the
    public source, and the only honest place to discover that is before the
    release is signed. Two jobs carry it: an independent rebuild in an
    environment deliberately unlike the release runner, and a byte comparison
    that `sign-release` depends on. Both are reviewed here so neither can be
    quietly softened into a self-comparison, which would pass forever and prove
    nothing.
    """

    rebuild = jobs.get(INDEPENDENT_REBUILD_JOB)
    if not isinstance(rebuild, Mapping):
        violations.append(f"{ROOT_WORKFLOW} must define the {INDEPENDENT_REBUILD_JOB} job")
    else:
        rebuild_body = "\n".join(strings(rebuild))
        if rebuild.get("permissions") != {"contents": "read"}:
            violations.append(
                f"{INDEPENDENT_REBUILD_JOB} permissions must be exactly contents: read"
            )
        if environment_name(rebuild) is not None:
            violations.append(f"{INDEPENDENT_REBUILD_JOB} must not bind a deployment environment")
        if signing_references(rebuild):
            violations.append(
                f"{INDEPENDENT_REBUILD_JOB} must never reference Android signing secrets"
            )
        if WORKFLOW_TOKEN in rebuild_body:
            violations.append(f"{INDEPENDENT_REBUILD_JOB} must not carry the workflow token")
        for marker in RELEASE_WRITE_MARKERS:
            if marker in rebuild_body:
                violations.append(
                    f"{INDEPENDENT_REBUILD_JOB} must not be able to write a release: {marker}"
                )

        # A second run on the same image proves only that the build is
        # deterministic on this runner. The container is what makes the rebuild
        # an independent environment, and its digest is what keeps it one.
        container = rebuild.get("container")
        image = container.get("image") if isinstance(container, Mapping) else container
        if not isinstance(image, str):
            violations.append(
                f"{INDEPENDENT_REBUILD_JOB} must run in a container image unlike the release "
                "runner; a same-image rebuild is a self-comparison"
            )
        elif not CONTAINER_DIGEST_PIN.search(image):
            violations.append(
                f"{INDEPENDENT_REBUILD_JOB} container image must be pinned by sha256 digest"
            )

        if [ref for ref, _ in checkout_refs(rebuild)] != ["${{ inputs.source_sha }}"]:
            violations.append(
                f"{INDEPENDENT_REBUILD_JOB} must check out exactly the admitted commit"
            )
        # Reusing the release lane's Conscrypt artifact would import the very
        # bytes the rebuild exists to reproduce independently.
        if CONSCRYPT_ARTIFACT in rebuild_body:
            violations.append(
                f"{INDEPENDENT_REBUILD_JOB} must build Conscrypt itself, not consume "
                f"{CONSCRYPT_ARTIFACT}"
            )
        for required in (
            "scripts/build-conscrypt-android-r28.sh",
            "scripts/build-etebase-client-16kb.sh",
            "-PrequireReproducibleJdk=true",
            FDROID_REBUILD_ARTIFACT,
        ):
            if required not in rebuild_body:
                violations.append(f"{INDEPENDENT_REBUILD_JOB} must contain {required!r}")
        if semantic_sha256(rebuild) != EXPECTED_REBUILD_JOB_SHA256:
            violations.append(
                f"{INDEPENDENT_REBUILD_JOB} must match the exact reviewed independent-rebuild "
                "specification"
            )

    gate = jobs.get(REPRODUCIBILITY_GATE_JOB)
    if not isinstance(gate, Mapping):
        violations.append(f"{ROOT_WORKFLOW} must define the {REPRODUCIBILITY_GATE_JOB} job")
        return

    gate_body = "\n".join(strings(gate))
    if gate.get("permissions") != {"contents": "read"}:
        violations.append(f"{REPRODUCIBILITY_GATE_JOB} permissions must be exactly contents: read")
    if environment_name(gate) is not None:
        violations.append(f"{REPRODUCIBILITY_GATE_JOB} must not bind a deployment environment")
    if signing_references(gate):
        violations.append(f"{REPRODUCIBILITY_GATE_JOB} must never reference Android signing secrets")
    if WORKFLOW_TOKEN in gate_body:
        violations.append(f"{REPRODUCIBILITY_GATE_JOB} must not carry the workflow token")
    for marker in RELEASE_WRITE_MARKERS:
        if marker in gate_body:
            violations.append(
                f"{REPRODUCIBILITY_GATE_JOB} must not be able to write a release: {marker}"
            )
    if gate.get("needs") != [UNSIGNED_JOB, INDEPENDENT_REBUILD_JOB]:
        violations.append(
            f"{REPRODUCIBILITY_GATE_JOB} must compare exactly {UNSIGNED_JOB} against "
            f"{INDEPENDENT_REBUILD_JOB}"
        )
    # Comparing one artifact with itself is the failure mode this whole gate
    # exists to prevent, so both inputs are named as literals.
    for required in (UNSIGNED_ARTIFACT, FDROID_REBUILD_ARTIFACT, str(REPRODUCIBILITY_HELPER)):
        if required not in gate_body:
            violations.append(f"{REPRODUCIBILITY_GATE_JOB} must contain {required!r}")
    if semantic_sha256(gate) != EXPECTED_REPRODUCIBILITY_GATE_JOB_SHA256:
        violations.append(
            f"{REPRODUCIBILITY_GATE_JOB} must match the exact reviewed gate specification"
        )


def check_reproducibility_drill(
    loaded: Mapping[Path, dict[str, Any]], violations: list[str]
) -> None:
    """The rehearsal must stay a rehearsal.

    The drill exists because the release lane's gate would otherwise first run
    on release day. It runs the same expensive builds against an exact commit,
    on demand. Everything reviewed here keeps it from becoming anything else: a
    second trigger into the release lane, a job that can hold signing material,
    or a producer whose artifacts a release run could consume.
    """

    workflow = loaded.get(DRILL_WORKFLOW)
    release = loaded.get(ROOT_WORKFLOW)
    if workflow is None:
        violations.append(f"missing reproducibility drill workflow: {DRILL_WORKFLOW}")
        return

    # Dispatch-only. push/pull_request would run a three-hour container build on
    # every change; repository_dispatch or workflow_call would make this a
    # second entry point into release-shaped work.
    declared_triggers = set(triggers(workflow))
    if declared_triggers != {"workflow_dispatch"}:
        violations.append(
            f"{DRILL_WORKFLOW} must be reachable only by workflow_dispatch; found "
            f"{sorted(declared_triggers)}"
        )
    dispatch = triggers(workflow).get("workflow_dispatch")
    inputs = dispatch.get("inputs") if isinstance(dispatch, Mapping) else None
    if not isinstance(inputs, Mapping) or set(inputs) != {"source_sha"}:
        violations.append(
            f"{DRILL_WORKFLOW} must take exactly one input, the exact commit to drill"
        )
    elif str((inputs.get("source_sha") or {}).get("required")).lower() != "true":
        violations.append(
            f"{DRILL_WORKFLOW} source_sha must be required; a defaulted ref could move "
            "between the two builds it compares"
        )

    if workflow.get("permissions") != {}:
        violations.append(f"{DRILL_WORKFLOW} must grant no default permissions")
    for inherited_key in ("defaults", "env"):
        if inherited_key in workflow:
            violations.append(f"{DRILL_WORKFLOW} must not define workflow-level {inherited_key}")

    body = "\n".join(strings(workflow))
    # It cannot request the signing secrets — they are workflow_call
    # capabilities only the controller grants — and it must not name any
    # credential at all, so this stays true by inspection rather than by luck.
    named_secrets = {name for item in strings(workflow) for name in SECRET_REFERENCE.findall(item)}
    if named_secrets:
        violations.append(
            f"{DRILL_WORKFLOW} must name no secret; found {', '.join(sorted(named_secrets))}"
        )
    for marker in RELEASE_WRITE_MARKERS:
        if marker in body:
            violations.append(f"{DRILL_WORKFLOW} must not be able to write a release: {marker}")
    # A drill artifact must never be mistakable for, or consumable by, a
    # release run.
    for release_artifact in (UNSIGNED_ARTIFACT, FDROID_REBUILD_ARTIFACT, RELEASE_ASSET_ARTIFACT):
        if release_artifact in body:
            violations.append(
                f"{DRILL_WORKFLOW} must not produce or consume the release lane artifact "
                f"{release_artifact}"
            )
    for target in action_uses(workflow):
        if target.startswith("./"):
            violations.append(f"{DRILL_WORKFLOW} must not invoke local actions")
        elif unpinned_action(target):
            violations.append(f"{DRILL_WORKFLOW} action must be SHA-pinned: {target}")

    jobs = workflow.get("jobs")
    if not isinstance(jobs, Mapping):
        violations.append(f"{DRILL_WORKFLOW} jobs must be a mapping")
        return
    expected_jobs = {DRILL_SOURCE_JOB, DRILL_UBUNTU_JOB, INDEPENDENT_REBUILD_JOB, DRILL_COMPARISON_JOB}
    if set(jobs) != expected_jobs:
        violations.append(
            f"{DRILL_WORKFLOW} must define exactly {sorted(expected_jobs)}; found {sorted(jobs)}"
        )

    for job_name, job in jobs.items():
        if not isinstance(job, Mapping):
            violations.append(f"{DRILL_WORKFLOW} job {job_name} must be a mapping")
            continue
        if job.get("permissions") != {"contents": "read"}:
            violations.append(
                f"{DRILL_WORKFLOW} job {job_name} permissions must be exactly contents: read"
            )
        if environment_name(job) is not None:
            violations.append(
                f"{DRILL_WORKFLOW} job {job_name} must not bind a deployment environment"
            )
        if signing_references(job):
            violations.append(
                f"{DRILL_WORKFLOW} job {job_name} must never reference Android signing secrets"
            )
        # Both builds must be bound to the one admitted commit. The comparison
        # runs the verifier out of the dispatched revision instead, which is
        # the same trusted-source rule the release lane's gate follows.
        expected_ref = TRUSTED_REF if job_name == DRILL_COMPARISON_JOB else DRILL_SOURCE_REF
        for ref, _ in checkout_refs(job):
            if ref != expected_ref:
                violations.append(
                    f"{DRILL_WORKFLOW} job {job_name} checks out {ref!r}, expected {expected_ref!r}"
                )
        for step in job_steps(job):
            uses = step.get("uses")
            if isinstance(uses, str) and uses.startswith("actions/checkout@"):
                options = step.get("with") if isinstance(step.get("with"), Mapping) else {}
                if str(options.get("persist-credentials")).lower() != "false":
                    violations.append(
                        f"{DRILL_WORKFLOW} job {job_name} must check out with "
                        "persist-credentials: false"
                    )

    comparison = jobs.get(DRILL_COMPARISON_JOB)
    if isinstance(comparison, Mapping):
        if comparison.get("needs") != [DRILL_UBUNTU_JOB, INDEPENDENT_REBUILD_JOB]:
            violations.append(
                f"{DRILL_WORKFLOW} {DRILL_COMPARISON_JOB} must compare exactly {DRILL_UBUNTU_JOB} "
                f"against {INDEPENDENT_REBUILD_JOB}"
            )
        comparison_body = "\n".join(strings(comparison))
        for required in (DRILL_UBUNTU_ARTIFACT, DRILL_REBUILD_ARTIFACT, str(REPRODUCIBILITY_HELPER)):
            if required not in comparison_body:
                violations.append(f"{DRILL_WORKFLOW} {DRILL_COMPARISON_JOB} must contain {required!r}")

    # Same image, same steps: a drill against a different container or a
    # different build sequence rehearses something other than the gate.
    drill_rebuild = jobs.get(INDEPENDENT_REBUILD_JOB)
    release_rebuild = ((release or {}).get("jobs") or {}).get(INDEPENDENT_REBUILD_JOB)
    if isinstance(drill_rebuild, Mapping) and isinstance(release_rebuild, Mapping):
        if drill_rebuild.get("container") != release_rebuild.get("container"):
            violations.append(
                f"{DRILL_WORKFLOW} {INDEPENDENT_REBUILD_JOB} must use the same digest-pinned "
                "container as the release lane"
            )
        if drill_rebuild.get("env") != release_rebuild.get("env"):
            violations.append(
                f"{DRILL_WORKFLOW} {INDEPENDENT_REBUILD_JOB} must use the same environment as the "
                "release lane"
            )
        drill_steps = {str(step.get("name")): step for step in job_steps(drill_rebuild)}
        release_steps = {str(step.get("name")): step for step in job_steps(release_rebuild)}
        for step_name in DRILL_SHARED_REBUILD_STEPS:
            if drill_steps.get(step_name) != release_steps.get(step_name):
                violations.append(
                    f"{DRILL_WORKFLOW} {INDEPENDENT_REBUILD_JOB} step {step_name!r} has drifted "
                    "from the release lane's; the drill would rehearse a different build"
                )

    if semantic_sha256(workflow) != EXPECTED_DRILL_WORKFLOW_SHA256:
        violations.append(f"{DRILL_WORKFLOW} must match its exact reviewed whole-workflow digest")


def check_control_plane(
    loaded: Mapping[Path, dict[str, Any]], violations: list[str]
) -> None:
    """The release authority: where it is loaded from, and what it may reach."""

    # 1. Nothing anywhere is triggered by a tag push. This is what makes "no
    #    tag-sourced workflow code can obtain a privilege" a structural fact
    #    rather than a per-job argument.
    for relative, workflow in loaded.items():
        push = triggers(workflow).get("push")
        if isinstance(push, Mapping) and "tags" in push:
            violations.append(
                f"{relative} declares a tag-push trigger; release authority must come from the "
                "protected default branch, never from a tag"
            )
        if "repository_dispatch" in triggers(workflow) and relative != CONTROLLER_WORKFLOW:
            violations.append(f"{relative} must not define a second release control plane")

    # 2. The controller is loaded from the default branch by construction, and
    #    it is the only workflow that may be.
    controller = loaded.get(CONTROLLER_WORKFLOW)
    if controller is None:
        violations.append(f"missing release controller: {CONTROLLER_WORKFLOW}")
        return
    controller_triggers = triggers(controller)
    if set(controller_triggers) != {"repository_dispatch"}:
        violations.append(
            f"{CONTROLLER_WORKFLOW} must declare exactly one trigger, repository_dispatch"
        )
    dispatch = controller_triggers.get("repository_dispatch")
    if not isinstance(dispatch, Mapping) or dispatch.get("types") != [DISPATCH_EVENT_TYPE]:
        violations.append(
            f"{CONTROLLER_WORKFLOW} must accept exactly the {DISPATCH_EVENT_TYPE} event type"
        )
    if controller.get("permissions") != {}:
        violations.append(f"{CONTROLLER_WORKFLOW} must grant no default permissions")
    outer = controller.get("concurrency")
    if not isinstance(outer, Mapping) or outer.get("cancel-in-progress") != "false":
        violations.append(
            f"{CONTROLLER_WORKFLOW} must serialize releases without cancelling one in flight"
        )

    controller_jobs = as_mapping(controller.get("jobs"), f"{CONTROLLER_WORKFLOW} jobs", violations)
    expected_jobs = {ADMISSION_JOB, *EXPECTED_CONTROLLER_CALLERS}
    if set(controller_jobs) != expected_jobs:
        violations.append(
            f"{CONTROLLER_WORKFLOW} jobs must be exactly {sorted(expected_jobs)}"
        )

    admit = controller_jobs.get(ADMISSION_JOB)
    if not isinstance(admit, Mapping):
        violations.append(f"{CONTROLLER_WORKFLOW} must define the {ADMISSION_JOB} job")
    else:
        # Owner-only initiation, decided before a payload is parsed, before a
        # candidate commit is named and before anything is checked out. It is a
        # failing step rather than a job-level `if:` on purpose: a skipped job
        # reports success, and a release that was refused must look refused.
        admit_steps = job_steps(admit)
        if not admit_steps or admit_steps[0] != EXPECTED_OWNER_GATE_STEP:
            violations.append(
                f"{ADMISSION_JOB} must begin with the exact reviewed owner-sender gate, "
                f"comparing github.event.sender.id against {RELEASE_OWNER_ID}"
            )
        if "if" in admit:
            violations.append(
                f"{ADMISSION_JOB} must not gate itself with a job-level condition; a skipped "
                "admission reports success"
            )
        for marker in LOGIN_AUTHORISATION_MARKERS:
            if marker in "\n".join(strings(admit)):
                violations.append(
                    f"{ADMISSION_JOB} must not authorise by {marker}; a login can be renamed "
                    "and reused, an account id cannot"
                )
        if admit.get("permissions") != EXPECTED_CONTROLLER_ADMIT_PERMISSIONS:
            violations.append(f"{ADMISSION_JOB} must declare exactly contents: read")
        if environment_name(admit) is not None:
            violations.append(f"{ADMISSION_JOB} must not bind any deployment environment")
        if signing_references(admit):
            violations.append(f"{ADMISSION_JOB} must never reference Android signing secrets")
        refs = checkout_refs(admit)
        if refs != [(TRUSTED_REF, ".")]:
            violations.append(
                f"{ADMISSION_JOB} must check out exactly the protected controller revision"
            )
        if semantic_sha256(admit) != EXPECTED_CONTROLLER_ADMIT_SHA256:
            violations.append(f"{ADMISSION_JOB} must match its exact reviewed digest")

    # 3. The payload is data, never code: it may only ever reach a script
    #    through the environment.
    for job_name, job in controller_jobs.items():
        if not isinstance(job, Mapping):
            continue
        for step in job_steps(job):
            run = step.get("run")
            if isinstance(run, str) and "client_payload" in run:
                violations.append(
                    f"{CONTROLLER_WORKFLOW} job {job_name} interpolates the dispatch payload into "
                    "a script; it must be passed through the environment"
                )

    # 4. Each component lane is called from this protected revision, with the
    #    admitted pair and under a declared permission ceiling. Android alone
    #    receives the exact named signing capabilities required by its called
    #    workflow; no sibling lane receives any secret.
    for job_name, expected in EXPECTED_CONTROLLER_CALLERS.items():
        job = controller_jobs.get(job_name)
        if not isinstance(job, Mapping):
            violations.append(f"{CONTROLLER_WORKFLOW} must define the {job_name} lane")
            continue
        if job.get("uses") != expected["uses"]:
            violations.append(
                f"{CONTROLLER_WORKFLOW} job {job_name} must call {expected['uses']} from this "
                "protected revision"
            )
        if job.get("permissions") != expected["permissions"]:
            violations.append(
                f"{CONTROLLER_WORKFLOW} job {job_name} must declare exactly "
                f"{expected['permissions']}"
            )
        if job.get("with") != EXPECTED_CALLER_INPUTS:
            violations.append(
                f"{CONTROLLER_WORKFLOW} job {job_name} must pass exactly the admitted tag and commit"
            )
        if job_name == "android":
            if job.get("secrets") != EXPECTED_ANDROID_CALLER_SECRETS:
                violations.append(
                    f"{CONTROLLER_WORKFLOW} job android must grant exactly the three Android "
                    "signing secrets, each from its same-name secrets context value"
                )
            if semantic_sha256(job) != EXPECTED_CONTROLLER_ANDROID_JOB_SHA256:
                violations.append(
                    f"{CONTROLLER_WORKFLOW} job android must match its exact reviewed whole-job digest"
                )
        elif "secrets" in job:
            violations.append(
                f"{CONTROLLER_WORKFLOW} job {job_name} must not receive any secrets"
            )
        needs = job.get("needs")
        needs = [needs] if isinstance(needs, str) else (needs or [])
        if ADMISSION_JOB not in needs:
            violations.append(f"{CONTROLLER_WORKFLOW} job {job_name} can run unadmitted")

    readiness = controller_jobs.get("readiness")
    if isinstance(readiness, Mapping):
        needs = readiness.get("needs")
        needs = [needs] if isinstance(needs, str) else (needs or [])
        if set(needs) != {ADMISSION_JOB, "android", "bridge", "server"}:
            violations.append(
                f"{CONTROLLER_WORKFLOW} readiness must wait for every component lane"
            )
        if semantic_sha256(readiness) != EXPECTED_CONTROLLER_READINESS_JOB_SHA256:
            violations.append(
                f"{CONTROLLER_WORKFLOW} readiness must match its exact reviewed whole-job digest"
            )

    # 5. Component workflows are reachable only by that call.
    for relative in COMPONENT_WORKFLOWS:
        workflow = loaded.get(relative)
        if workflow is None:
            violations.append(f"missing release component workflow: {relative}")
            continue
        component_triggers = triggers(workflow)
        if set(component_triggers) != {"workflow_call"}:
            violations.append(
                f"{relative} must declare exactly one trigger, workflow_call; any other trigger "
                "lets a selected ref supply its own definition of a privileged lane"
            )
        call = component_triggers.get("workflow_call")
        declared = call.get("inputs") if isinstance(call, Mapping) else None
        if declared != EXPECTED_COMPONENT_INPUTS:
            violations.append(f"{relative} must accept exactly the admitted tag and commit")
        declared_secrets = call.get("secrets") if isinstance(call, Mapping) else None
        if relative == ROOT_WORKFLOW:
            if declared_secrets != EXPECTED_ANDROID_CALLABLE_SECRETS:
                violations.append(
                    f"{relative} must declare exactly the three Android signing secrets as required"
                )
        elif declared_secrets is not None:
            violations.append(f"{relative} must not declare callable secrets")
        if workflow.get("permissions") != {}:
            violations.append(f"{relative} must grant no default permissions")

    # 5a. Draft visibility requires contents:write, but the readiness lane is
    # behaviorally read-only. Close the exceptional capability around one exact
    # workflow/job and reject recognizable release mutation routes explicitly,
    # so a failure explains the violated boundary before the digest pin does.
    readiness_workflow = loaded.get(READINESS_WORKFLOW)
    if readiness_workflow is not None:
        readiness_jobs = readiness_workflow.get("jobs") or {}
        readiness_job = readiness_jobs.get("readiness")
        if set(readiness_jobs) != {"readiness"}:
            violations.append(f"{READINESS_WORKFLOW} must define exactly the readiness job")
        if semantic_sha256(readiness_workflow) != EXPECTED_READINESS_WORKFLOW_SHA256:
            violations.append(
                f"{READINESS_WORKFLOW} must match its exact reviewed whole-workflow digest"
            )
        if isinstance(readiness_job, Mapping):
            if readiness_job.get("permissions") != {"contents": "write"}:
                violations.append(
                    f"{READINESS_WORKFLOW} readiness permissions must be exactly contents: write"
                )
            if environment_name(readiness_job) is not None:
                violations.append(f"{READINESS_WORKFLOW} readiness must not bind an environment")
            if semantic_sha256(readiness_job) != EXPECTED_READINESS_JOB_SHA256:
                violations.append(
                    f"{READINESS_WORKFLOW} readiness must match its exact reviewed whole-job digest"
                )

            body = "\n".join(strings(readiness_job))
            lowered = body.lower()
            named_secrets = set(SECRET_REFERENCE.findall(body))
            if named_secrets != {"GITHUB_TOKEN"} or UNSAFE_SECRET_EXPRESSION.search(body):
                violations.append(
                    f"{READINESS_WORKFLOW} readiness may reference only secrets.GITHUB_TOKEN"
                )
            helper_references = [
                reference
                for reference in trusted_helper_references(readiness_job)
                if reference.endswith(f"scripts/{READINESS_HELPER.name}")
            ]
            if helper_references != [f"scripts/{READINESS_HELPER.name}"]:
                violations.append(
                    f"{READINESS_WORKFLOW} readiness must invoke the trusted "
                    f"{READINESS_HELPER.name} exactly once"
                )
            forbidden_fragments = {
                "attach-umbrella-release-assets.sh": "release attachment helper",
                "gh release": "gh release",
                "uploads.github.com": "release upload URL",
                "upload_url": "release upload URL",
                "softprops/action-gh-release": "marketplace release action",
                "actions/upload-artifact": "artifact upload action",
                "actions/download-artifact": "artifact download action",
            }
            for fragment, description in forbidden_fragments.items():
                if fragment in lowered:
                    violations.append(
                        f"{READINESS_WORKFLOW} readiness must not use {description}"
                    )
            if re.search(r"\b(post|patch|put|delete)\b", lowered):
                violations.append(
                    f"{READINESS_WORKFLOW} readiness must not name an API mutation method"
                )
            if re.search(r"(^|[\n;&|])\s*(curl|wget|nc|ncat|socat)\b", lowered):
                violations.append(
                    f"{READINESS_WORKFLOW} readiness must not perform shell network access"
                )
            allowed_actions = {CHECKOUT_ACTION, SETUP_PYTHON_ACTION}
            for target in action_uses(readiness_job):
                if target.startswith("./"):
                    violations.append(f"{READINESS_WORKFLOW} readiness must not invoke local actions")
                elif target not in allowed_actions:
                    violations.append(
                        f"{READINESS_WORKFLOW} readiness action {target} is not one of the exact "
                        "reviewed setup actions"
                    )

    # 5b. Anything a component lane calls in turn is on the release path too.
    #     It may build the candidate, but it may not hold a write permission or
    #     bind an environment, and it must be a local workflow so that it
    #     resolves at this same protected revision.
    for relative in COMPONENT_WORKFLOWS:
        workflow = loaded.get(relative)
        if workflow is None:
            continue
        for job_name, job in (workflow.get("jobs") or {}).items():
            if not isinstance(job, Mapping):
                continue
            called_ref = job.get("uses")
            if not isinstance(called_ref, str):
                continue
            if not called_ref.startswith("./"):
                violations.append(
                    f"{relative} job {job_name} calls {called_ref}, which is not resolved at this "
                    "protected revision"
                )
                continue
            if not permissions_read_only(job.get("permissions")):
                violations.append(
                    f"{relative} job {job_name} delegates a build and must declare read-only "
                    "permissions"
                )
            called = loaded.get(Path(called_ref[2:]))
            if called is None:
                violations.append(f"{relative} job {job_name} calls a missing workflow {called_ref}")
                continue
            if called.get("permissions") != {}:
                violations.append(f"{called_ref} must grant no default permissions")
            for sub_name, sub_job in (called.get("jobs") or {}).items():
                if not isinstance(sub_job, Mapping):
                    continue
                if not permissions_read_only(sub_job.get("permissions")):
                    violations.append(
                        f"{called_ref} job {sub_name} is on the release path and must declare "
                        "read-only permissions"
                    )
                if environment_name(sub_job) is not None:
                    violations.append(
                        f"{called_ref} job {sub_name} is on the release path and must not bind a "
                        "deployment environment"
                    )

    # 5c. The registry alias write is the server lane's irreversible act, and
    #     there are two of them. The identity check has to sit immediately
    #     before the write itself — inside the helper that performs it — not
    #     once at the top of the step, or the second alias is written on an
    #     identity that was only confirmed before the first.
    server = loaded.get(SERVER_WORKFLOW)
    if server is not None:
        publish = (server.get("jobs") or {}).get("publish-index")
        merge = None
        if isinstance(publish, Mapping):
            for step in job_steps(publish):
                if step.get("name") == ALIAS_MERGE_STEP:
                    merge = step
        if merge is None:
            violations.append(f"{SERVER_WORKFLOW} must define the {ALIAS_MERGE_STEP!r} step")
        else:
            script = [line.strip() for line in str(merge.get("run", "")).splitlines()]
            writes = [index for index, line in enumerate(script) if line.startswith(ALIAS_WRITE)]
            if len(writes) != 1:
                violations.append(
                    f"{SERVER_WORKFLOW} must perform exactly one alias write, found {len(writes)}"
                )
            for index in writes:
                if script[index - 1 : index] != [ALIAS_REVALIDATION]:
                    violations.append(
                        f"{SERVER_WORKFLOW} must run {ALIAS_REVALIDATION} immediately before "
                        f"{ALIAS_WRITE}; found {script[index - 1: index]}"
                    )
            if ALIAS_REVALIDATION_HELPER not in str(merge.get("run", "")):
                violations.append(
                    f"{SERVER_WORKFLOW} must revalidate with the trusted verifier "
                    f"({ALIAS_REVALIDATION_HELPER})"
                )
            if merge.get("env", {}).get("GITHUB_TOKEN") != WORKFLOW_TOKEN:
                violations.append(
                    f"{SERVER_WORKFLOW} {ALIAS_MERGE_STEP!r} needs the workflow token for its "
                    "revalidation reads"
                )

    # 6. Trusted helpers execute from a checkout of this protected revision.
    for relative in CONTROL_PLANE:
        workflow = loaded.get(relative)
        if workflow is None:
            continue
        for job_name, job in (workflow.get("jobs") or {}).items():
            if isinstance(job, Mapping):
                check_trusted_helper_sources(relative, job_name, job, violations)

    # 7. Outside the control plane, the release helpers may only be named by a
    #    read-only job — a syntax check or a contract test, never a writer.
    for relative, workflow in loaded.items():
        if relative in CONTROL_PLANE:
            continue
        for job_name, job in (workflow.get("jobs") or {}).items():
            if not isinstance(job, Mapping):
                continue
            body = "\n".join(strings(job))
            named = [
                helper
                for helper in (ATTACHMENT_HELPER.name, IDENTITY_HELPER.name, READINESS_HELPER.name)
                if helper in body
            ]
            if named and not permissions_read_only(job.get("permissions")):
                violations.append(
                    f"{relative} job {job_name} names {sorted(named)} outside the release control "
                    "plane while holding a write permission"
                )

    # 8. The umbrella lock is one repository-wide domain, declared identically by
    #    all three attachment jobs.
    attachment_owners = []
    for relative in (ROOT_WORKFLOW, BRIDGE_WORKFLOW, SERVER_WORKFLOW):
        workflow = loaded.get(relative)
        if workflow is None:
            continue
        job = (workflow.get("jobs") or {}).get(ATTACHMENT_JOB)
        if not isinstance(job, Mapping):
            violations.append(f"{relative} must define the {ATTACHMENT_JOB} job")
            continue
        attachment_owners.append(relative)
        if job.get("concurrency") != EXPECTED_RELEASE_CONCURRENCY:
            violations.append(
                f"{relative} {ATTACHMENT_JOB} must declare exactly the reviewed umbrella-release "
                f"concurrency {EXPECTED_RELEASE_CONCURRENCY}"
            )
        if job.get("permissions") != {"contents": "write"}:
            violations.append(f"{relative} {ATTACHMENT_JOB} permissions must be exactly contents: write")
        if environment_name(job) is not None:
            violations.append(f"{relative} {ATTACHMENT_JOB} must not bind a deployment environment")
        if signing_references(job):
            violations.append(
                f"{relative} {ATTACHMENT_JOB} must never reference Android signing secrets; it "
                "holds the release write credential"
            )
        if ATTACHMENT_HELPER.name not in "\n".join(strings(job)):
            violations.append(f"{relative} {ATTACHMENT_JOB} must attach through {ATTACHMENT_HELPER}")
    if len(attachment_owners) != 3:
        violations.append("all three component lanes must own an umbrella attachment job")

    # 9. Only the reviewed production lane may combine a manual trigger with a
    #    protected environment; nothing else may bind server-production.
    for relative, workflow in loaded.items():
        for job_name, job in (workflow.get("jobs") or {}).items():
            if not isinstance(job, Mapping):
                continue
            if environment_name(job) == PRODUCTION_ENVIRONMENT and relative != PRODUCTION_WORKFLOW:
                violations.append(
                    f"{relative} job {job_name} binds {PRODUCTION_ENVIRONMENT}, which belongs "
                    f"exclusively to {PRODUCTION_WORKFLOW}"
                )
        if relative in CONTROL_PLANE and PRODUCTION_WORKFLOW.name in json.dumps(workflow):
            violations.append(f"{relative} must not reference the hosted-production workflow")


def check(root: Path) -> list[str]:
    workflow_dir = root / WORKFLOW_DIR
    violations: list[str] = []
    root_path = root / ROOT_WORKFLOW
    sibling_path = root / ANDROID_SIBLING_WORKFLOW

    if not root_path.is_file():
        return [f"missing required workflow: {ROOT_WORKFLOW}"]
    if not sibling_path.is_file():
        return [f"missing Android sibling workflow: {ANDROID_SIBLING_WORKFLOW}"]

    loaded: dict[Path, dict[str, Any]] = {}
    workflow_paths = sorted((*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")))
    for path in workflow_paths:
        relative = path.relative_to(root)
        try:
            workflow = load_workflow(path)
        except ValueError as exc:
            violations.append(f"{relative}: {exc}")
            continue
        loaded[relative] = workflow
        jobs = as_mapping(workflow.get("jobs"), f"{relative} jobs", violations)
        workflow_scope = {key: value for key, value in workflow.items() if key != "jobs"}
        # The Android workflow_call declaration contains secret *names* as its
        # least-privilege interface. It is reviewed exactly below and is not a
        # secret value reference or an exposure at workflow scope.
        if relative == ROOT_WORKFLOW:
            workflow_scope = dict(workflow_scope)
            root_triggers = dict(triggers(workflow_scope))
            root_call = root_triggers.get("workflow_call")
            if isinstance(root_call, Mapping):
                root_call = dict(root_call)
                root_call.pop("secrets", None)
                root_triggers["workflow_call"] = root_call
                workflow_scope["on"] = root_triggers

        scope_refs = signing_references(workflow_scope)
        if scope_refs:
            violations.append(
                f"{relative} references Android signing secrets outside a job: "
                f"{', '.join(sorted(scope_refs))}"
            )

        if contains_secret_inheritance(workflow):
            violations.append(f"{relative} must not use reusable-workflow secrets: inherit")
        if contains_unsafe_secret_expression(workflow):
            violations.append(f"{relative} must not use dynamic or whole-context secret expressions")

        for job_name, raw_job in jobs.items():
            if not isinstance(raw_job, Mapping):
                violations.append(f"{relative} job {job_name} must be a mapping")
                continue
            refs = signing_references(raw_job)
            env = environment_name(raw_job)
            is_allowed = (
                (relative == ROOT_WORKFLOW and job_name == ALLOWED_JOB)
                or (relative == CONTROLLER_WORKFLOW and job_name == "android")
            )
            if refs and not is_allowed:
                violations.append(
                    f"{relative} job {job_name} references Android signing secrets: "
                    f"{', '.join(sorted(refs))}"
                )
            if env and env.casefold() == ENVIRONMENT_NAME.casefold() and not is_allowed:
                violations.append(f"{relative} job {job_name} binds {ENVIRONMENT_NAME} outside {ALLOWED_JOB}")
            if env and "${{" in env and not is_allowed:
                violations.append(f"{relative} job {job_name} uses a dynamic environment outside {ALLOWED_JOB}")

    check_control_plane(loaded, violations)

    root_workflow = loaded.get(ROOT_WORKFLOW)
    if root_workflow is None:
        return violations
    jobs = as_mapping(root_workflow.get("jobs"), f"{ROOT_WORKFLOW} jobs", violations)
    policy = jobs.get(POLICY_JOB)
    if not isinstance(policy, Mapping):
        violations.append(f"{ROOT_WORKFLOW} is missing mapping job {POLICY_JOB}")
        return violations
    release = jobs.get(ALLOWED_JOB)
    if not isinstance(release, Mapping):
        violations.append(f"{ROOT_WORKFLOW} is missing mapping job {ALLOWED_JOB}")
        return violations

    # The Conscrypt producer, reviewed in both the release lane and CI.
    for relative, job_digest in (
        (ROOT_WORKFLOW, EXPECTED_RELEASE_CONSCRYPT_JOB_SHA256),
        (ANDROID_CI_WORKFLOW, EXPECTED_CI_CONSCRYPT_JOB_SHA256),
    ):
        workflow = loaded.get(relative)
        conscrypt_job = (workflow or {}).get("jobs", {}).get(CONSCRYPT_JOB)
        if not isinstance(conscrypt_job, Mapping):
            violations.append(f"{relative} is missing mapping job {CONSCRYPT_JOB}")
        elif semantic_sha256(conscrypt_job) != job_digest:
            violations.append(
                f"{relative} {CONSCRYPT_JOB} must match the exact reviewed producer specification"
            )

    check_reproducibility_contract(jobs, violations)
    check_reproducibility_drill(loaded, violations)

    conscrypt_script = root / CONSCRYPT_BUILD_SCRIPT
    if not conscrypt_script.is_file():
        violations.append(f"{CONSCRYPT_BUILD_SCRIPT} is missing")
    elif hashlib.sha256(conscrypt_script.read_bytes()).hexdigest() != EXPECTED_CONSCRYPT_BUILD_SCRIPT_SHA256:
        violations.append(f"{CONSCRYPT_BUILD_SCRIPT} must match its exact reviewed digest")

    # The helpers this control plane executes. Their bytes are what actually
    # admit a source commit, what writes a release asset, and what decides that
    # a draft is complete.
    for helper, expected_digest in (
        (IDENTITY_HELPER, EXPECTED_IDENTITY_HELPER_SHA256),
        (ATTACHMENT_HELPER, EXPECTED_ATTACHMENT_HELPER_SHA256),
        (READINESS_HELPER, EXPECTED_READINESS_HELPER_SHA256),
        (BRIDGE_STAGING_HELPER, EXPECTED_BRIDGE_STAGING_HELPER_SHA256),
        (KEYSTORE_HELPER, EXPECTED_KEYSTORE_HELPER_SHA256),
        (ARTIFACT_ADMISSION_HELPER, EXPECTED_ARTIFACT_ADMISSION_SHA256),
        (SIGNING_HELPER, EXPECTED_SIGNING_HELPER_SHA256),
        (REPRODUCIBILITY_HELPER, EXPECTED_REPRODUCIBILITY_HELPER_SHA256),
    ):
        path = root / helper
        if not path.is_file():
            violations.append(f"{helper} is missing")
        elif hashlib.sha256(path.read_bytes()).hexdigest() != expected_digest:
            violations.append(f"{helper} must match its exact reviewed digest")

    revalidation = jobs.get(REVALIDATION_JOB)
    if not isinstance(revalidation, Mapping):
        violations.append(f"{ROOT_WORKFLOW} must define the {REVALIDATION_JOB} job")
    elif revalidation != EXPECTED_REVALIDATION_JOB:
        violations.append(
            f"{REVALIDATION_JOB} must match the exact reviewed pre-signing revalidation job"
        )

    attachment = jobs.get(ATTACHMENT_JOB)
    if not isinstance(attachment, Mapping):
        violations.append(f"{ROOT_WORKFLOW} must define the {ATTACHMENT_JOB} job")
    else:
        unexpected_keys = set(attachment) - ALLOWED_ATTACHMENT_JOB_KEYS
        if unexpected_keys:
            violations.append(
                f"{ATTACHMENT_JOB} has unreviewed job keys: {', '.join(sorted(unexpected_keys))}"
            )
        if attachment.get("needs") != ALLOWED_JOB:
            violations.append(f"{ATTACHMENT_JOB} must require a successful {ALLOWED_JOB}")
        attachment_body = "\n".join(strings(attachment))
        if "softprops/action-gh-release" in attachment_body:
            violations.append(
                f"{ATTACHMENT_JOB} must not use a marketplace release action; it can overwrite "
                "assets on an already-published release"
            )
        if RELEASE_ASSET_ARTIFACT not in attachment_body:
            violations.append(
                f"{ATTACHMENT_JOB} must consume the closed release-asset artifact "
                f"{RELEASE_ASSET_ARTIFACT}"
            )
        if "--expected-commit" not in attachment_body:
            violations.append(
                f"{ATTACHMENT_JOB} must bind the attachment to the admitted commit"
            )
        for target in action_uses(attachment):
            if target.startswith("./"):
                violations.append(f"{ATTACHMENT_JOB} must not invoke local actions")
            elif unpinned_action(target):
                violations.append(f"{ATTACHMENT_JOB} action {target} must be SHA-pinned")
        if semantic_sha256(attachment) != EXPECTED_ATTACHMENT_JOB_SHA256:
            violations.append(
                f"{ATTACHMENT_JOB} must match the exact reviewed attachment-job specification"
            )

    # The load-bearing separation: nothing that can write a release may sit in a
    # job that also holds signing material, in this workflow or any other.
    for relative, workflow in loaded.items():
        for job_name, raw_job in (workflow.get("jobs") or {}).items():
            if not isinstance(raw_job, Mapping) or not signing_references(raw_job):
                continue
            if relative == CONTROLLER_WORKFLOW and job_name == "android":
                # A reusable-workflow call job does not run steps or receive
                # secret values itself. Its exact same-name grant is validated
                # above; the called environment-bound signing job receives it.
                continue
            scanned = dict(raw_job)
            if relative == ROOT_WORKFLOW and job_name == ALLOWED_JOB:
                # The reviewed revalidation steps legitimately carry the
                # read-only workflow token. They are dropped from this sweep
                # only when they are byte-identical to their reviewed literal;
                # a step that merely borrows the name stays in it.
                scanned["steps"] = [
                    step
                    for step in job_steps(raw_job)
                    if EXPECTED_RELEASE_REVALIDATION_STEPS.get(str(step.get("name"))) != step
                ]
            body = "\n".join(strings(scanned))
            reachable = [marker for marker in RELEASE_WRITE_MARKERS if marker in body]
            if reachable:
                violations.append(
                    f"{relative} job {job_name} holds signing material and can also write a "
                    f"release: {', '.join(sorted(reachable))}"
                )
            if not permissions_read_only(raw_job.get("permissions")):
                violations.append(
                    f"{relative} job {job_name} holds signing material and must declare "
                    "read-only permissions"
                )

    for relative in (ROOT_WORKFLOW, ANDROID_CI_WORKFLOW):
        workflow = loaded.get(relative)
        if workflow is None:
            continue
        top_permissions = workflow.get("permissions")
        if top_permissions is not None and not permissions_read_only(top_permissions):
            if not (relative == ROOT_WORKFLOW and top_permissions == {}):
                violations.append(
                    f"{relative} must not grant dynamic or write permissions at workflow scope"
                )
        for inherited_key in ("defaults", "env"):
            if inherited_key in workflow:
                violations.append(
                    f"{relative} must not define workflow-level {inherited_key} that can alter "
                    f"{POLICY_JOB}"
                )

    for job_name, raw_job in jobs.items():
        if not isinstance(raw_job, Mapping):
            continue
        permissions = raw_job.get("permissions")
        if job_name == ATTACHMENT_JOB:
            if permissions != {"contents": "write"}:
                violations.append(f"{ATTACHMENT_JOB} permissions must be exactly contents: write")
        elif permissions is None:
            violations.append(f"{ROOT_WORKFLOW} job {job_name} must declare explicit read-only permissions")
        elif not permissions_read_only(permissions):
            violations.append(
                f"{ROOT_WORKFLOW} job {job_name} has dynamic or write permissions outside "
                f"{ATTACHMENT_JOB}"
            )

    # Unprivileged Android CI keeps the same policy gate and may hold nothing else.
    ci_workflow = loaded.get(ANDROID_CI_WORKFLOW)
    if ci_workflow is None:
        violations.append(f"missing Android CI workflow: {ANDROID_CI_WORKFLOW}")
    else:
        ci_jobs = as_mapping(ci_workflow.get("jobs"), f"{ANDROID_CI_WORKFLOW} jobs", violations)
        if ci_jobs.get(POLICY_JOB) != EXPECTED_CI_POLICY_JOB:
            violations.append(
                f"{ANDROID_CI_WORKFLOW} {POLICY_JOB} must match the exact fail-closed job specification"
            )
        for job_name, raw_job in ci_jobs.items():
            if not isinstance(raw_job, Mapping):
                continue
            if not permissions_read_only(raw_job.get("permissions")):
                violations.append(
                    f"{ANDROID_CI_WORKFLOW} job {job_name} must declare read-only permissions"
                )
            if environment_name(raw_job) is not None:
                violations.append(
                    f"{ANDROID_CI_WORKFLOW} job {job_name} must not bind a deployment environment"
                )
        for event in ("push", "pull_request"):
            paths = trigger_paths(ci_workflow, event)
            missing_paths = REQUIRED_TRIGGER_PATHS - set(paths)
            if missing_paths:
                violations.append(
                    f"{ANDROID_CI_WORKFLOW} {event}.paths is missing: {', '.join(sorted(missing_paths))}"
                )
            if any(path.startswith("!") for path in paths):
                violations.append(
                    f"{ANDROID_CI_WORKFLOW} {event}.paths must not contain negative patterns"
                )

    if policy != EXPECTED_POLICY_JOB:
        violations.append(f"{POLICY_JOB} must match the exact fail-closed job specification")

    missing_refs = SIGNING_SECRETS - signing_references(release)
    if missing_refs:
        violations.append(f"{ALLOWED_JOB} is missing signing references: {', '.join(sorted(missing_refs))}")
    if "if" in release:
        violations.append(
            f"{ALLOWED_JOB} must not carry an event guard; this lane is reachable only through "
            "the protected controller"
        )
    if release.get("needs") != [
        POLICY_JOB,
        CONSCRYPT_JOB,
        REVALIDATION_JOB,
        UNSIGNED_JOB,
        REPRODUCIBILITY_GATE_JOB,
    ]:
        violations.append(
            f"{ALLOWED_JOB} must require successful {POLICY_JOB}, {CONSCRYPT_JOB}, "
            f"{REVALIDATION_JOB}, {UNSIGNED_JOB} and {REPRODUCIBILITY_GATE_JOB}"
        )
    if release.get("permissions") != {"contents": "read"}:
        violations.append(
            f"{ALLOWED_JOB} permissions must be exactly contents: read; the release write "
            f"belongs to {ATTACHMENT_JOB}"
        )
    release_steps_raw = release.get("steps")
    checkout_steps = [
        step
        for step in (release_steps_raw if isinstance(release_steps_raw, list) else [])
        if isinstance(step, Mapping) and str(step.get("uses", "")).startswith("actions/checkout@")
    ]
    if checkout_steps != EXPECTED_RELEASE_CHECKOUTS:
        violations.append(
            f"{ALLOWED_JOB} must check out the admitted commit and then the trusted controller "
            "revision, in that order, both with persist-credentials: false"
        )

    # Each irreversible boundary is guarded by the reviewed revalidation step
    # that immediately precedes it. Immediately: an inserted step between the
    # check and the act would reopen exactly the window this closes.
    release_step_list = job_steps(release)
    release_step_names = [str(step.get("name")) for step in release_step_list]
    for guard_name, guarded_name in RELEASE_MUTATION_BOUNDARIES.items():
        expected_step = EXPECTED_RELEASE_REVALIDATION_STEPS[guard_name]
        matching = [step for step in release_step_list if step.get("name") == guard_name]
        if len(matching) != 1 or matching[0] != expected_step:
            violations.append(
                f"{ALLOWED_JOB} must contain exactly one {guard_name!r} step matching its "
                "reviewed trusted-revalidation literal"
            )
            continue
        if guarded_name not in release_step_names:
            violations.append(f"{ALLOWED_JOB} is missing the guarded step {guarded_name!r}")
            continue
        guard_index = release_step_names.index(guard_name)
        if release_step_names[guard_index + 1 : guard_index + 2] != [guarded_name]:
            violations.append(
                f"{ALLOWED_JOB} must revalidate the release identity immediately before "
                f"{guarded_name!r}; {guard_name!r} is followed by "
                f"{release_step_names[guard_index + 1 : guard_index + 2]}"
            )

    # The unsigned producer runs candidate Gradle. It must therefore hold
    # nothing a compromise could take: no protected environment, no signing
    # secret, no workflow token, and no write permission. This is the half of
    # the split that makes the fresh-runner boundary meaningful.
    unsigned = jobs.get(UNSIGNED_JOB)
    if not isinstance(unsigned, Mapping):
        violations.append(f"{ROOT_WORKFLOW} must define the {UNSIGNED_JOB} job")
    else:
        if semantic_sha256(unsigned) != EXPECTED_UNSIGNED_JOB_SHA256:
            violations.append(
                f"{UNSIGNED_JOB} must match the exact reviewed producer specification"
            )
        if environment_name(unsigned) is not None:
            violations.append(f"{UNSIGNED_JOB} must not bind a deployment environment")
        if signing_references(unsigned):
            violations.append(f"{UNSIGNED_JOB} must never reference Android signing secrets")
        if unsigned.get("permissions") != {"contents": "read"}:
            violations.append(f"{UNSIGNED_JOB} permissions must be exactly contents: read")
        unsigned_body = "\n".join(strings(unsigned))
        if WORKFLOW_TOKEN in unsigned_body:
            violations.append(f"{UNSIGNED_JOB} must not carry the workflow token")
        for marker in RELEASE_WRITE_MARKERS:
            if marker in unsigned_body:
                violations.append(f"{UNSIGNED_JOB} must not be able to write a release: {marker}")
        if UNSIGNED_ARTIFACT not in unsigned_body:
            violations.append(f"{UNSIGNED_JOB} must publish {UNSIGNED_ARTIFACT}")
        if unsigned.get("needs") != [POLICY_JOB, CONSCRYPT_JOB]:
            violations.append(
                f"{UNSIGNED_JOB} must require successful {POLICY_JOB} and {CONSCRYPT_JOB}"
            )

    # The signing job must never see candidate code. Its only checkout is the
    # protected revision; no Gradle, no candidate script, no candidate path.
    release_body = "\n".join(strings(release))
    for candidate_marker in ("./gradlew", "gradlew", "inputs.source_sha }}\n          persist"):
        if candidate_marker in release_body:
            violations.append(
                f"{ALLOWED_JOB} must not execute candidate build tooling ({candidate_marker})"
            )
    if UNSIGNED_ARTIFACT not in release_body:
        violations.append(f"{ALLOWED_JOB} must consume {UNSIGNED_ARTIFACT}")
    if str(ARTIFACT_ADMISSION_HELPER) not in release_body:
        violations.append(
            f"{ALLOWED_JOB} must admit the unsigned build through {ARTIFACT_ADMISSION_HELPER}"
        )
    if str(SIGNING_HELPER) not in release_body:
        violations.append(f"{ALLOWED_JOB} must sign through {SIGNING_HELPER}")
    admit_index = (
        release_step_names.index("Admit the unsigned build")
        if "Admit the unsigned build" in release_step_names
        else -1
    )
    decode_index = (
        release_step_names.index(KEYSTORE_DECODE_STEP)
        if KEYSTORE_DECODE_STEP in release_step_names
        else -1
    )
    if admit_index < 0 or decode_index < 0 or admit_index > decode_index:
        violations.append(
            f"{ALLOWED_JOB} must admit the candidate artifact before the keystore is decoded"
        )

    # The signing helper resolves its tools by absolute path under a verified
    # root; a PATH lookup is what a poisoned producer would aim at.
    signing_helper_path = root / SIGNING_HELPER
    if signing_helper_path.is_file():
        signing_code = "\n".join(
            line
            for line in signing_helper_path.read_text(encoding="utf-8").splitlines()
            if not line.lstrip().startswith("#")
        )
        for required in (
            'ANDROID_HOME}/build-tools/${BUILD_TOOLS_VERSION}',
            'JAVA_HOME}/bin/jarsigner',
            "--ks-pass \"env:KSTOREPWD\"",
            "-storepass:env KSTOREPWD",
            EXPECTED_UPLOAD_CERT_SHA256,
            '"$ZIPALIGN" -P 16 -f 4',
            '"$ZIPALIGN" -c -P 16 4',
            'canonical="$(readlink -f -- "$tool")"',
            "resolves outside its trusted root",
            '"$JARSIGNER" -verify -strict \\\n'
            '  -keystore "$KEYSTORE_PATH" -storepass:env KSTOREPWD',
            "grep -Fxq 'jar verified.' \"$JARSIGNER_VERIFY_LOG\"",
            '-printcert -jarfile "$SIGNED_AAB"',
        ):
            if required not in signing_code:
                violations.append(f"{SIGNING_HELPER} must contain {required!r}")
        if "$(command -v" in signing_code:
            violations.append(f"{SIGNING_HELPER} must not resolve tools through PATH")
        if '"$ZIPALIGN" -p' in signing_code or '"$ZIPALIGN" -c -p' in signing_code:
            violations.append(f"{SIGNING_HELPER} must not use deprecated zipalign -p")
        if '"$JARSIGNER" -verify "$SIGNED_AAB"' in signing_code:
            violations.append(
                f"{SIGNING_HELPER} must not use unparsed plain AAB verification"
            )

    # The keystore preflight sits exactly between the decode and Gradle. A
    # verifier that ran earlier would check a file that did not exist yet; one
    # that ran later would be reporting on a store Gradle had already opened.
    if KEYSTORE_VERIFY_STEP in release_step_names:
        decode = release_step_names.index(KEYSTORE_DECODE_STEP) if KEYSTORE_DECODE_STEP in release_step_names else -1
        verify = release_step_names.index(KEYSTORE_VERIFY_STEP)
        consume = (
            release_step_names.index(KEYSTORE_CONSUMER_STEP)
            if KEYSTORE_CONSUMER_STEP in release_step_names
            else -1
        )
        if decode < 0 or verify != decode + 1:
            violations.append(
                f"{ALLOWED_JOB} must verify the keystore immediately after {KEYSTORE_DECODE_STEP!r}"
            )
        if consume < 0 or consume != verify + 1:
            violations.append(
                f"{ALLOWED_JOB} must run {KEYSTORE_CONSUMER_STEP!r} immediately after the "
                "keystore verification"
            )
        verify_step = next(
            step for step in release_step_list if step.get("name") == KEYSTORE_VERIFY_STEP
        )
        verify_body = "\n".join(strings(verify_step))
        if str(KEYSTORE_HELPER) not in verify_body:
            violations.append(f"{ALLOWED_JOB} must verify the keystore with {KEYSTORE_HELPER}")
        if '"$GITHUB_WORKSPACE/scripts/' not in verify_body:
            violations.append(
                f"{ALLOWED_JOB} must run the keystore verifier from the trusted controller "
                "checkout, not the candidate tree"
            )
    else:
        violations.append(f"{ALLOWED_JOB} must define the {KEYSTORE_VERIFY_STEP!r} step")

    # The reviewed certificate is pinned in both the helper and this policy, so
    # a change of signing identity cannot pass as an ordinary script edit.
    keystore_helper_path = root / KEYSTORE_HELPER
    if keystore_helper_path.is_file():
        keystore_source = keystore_helper_path.read_text(encoding="utf-8")
        # Argument-vector rules are about what the script *executes*. The
        # comments deliberately name the two constructs being avoided, so they
        # are stripped before the executable text is scanned.
        keystore_code = "\n".join(
            line for line in keystore_source.splitlines() if not line.lstrip().startswith("#")
        )
        if EXPECTED_UPLOAD_CERT_SHA256 not in keystore_source:
            violations.append(
                f"{KEYSTORE_HELPER} must pin the reviewed upload certificate "
                f"{EXPECTED_UPLOAD_CERT_SHA256}"
            )
        if "-storepass:env" not in keystore_code:
            violations.append(
                f"{KEYSTORE_HELPER} must take the store password through the environment, "
                "never as an argument"
            )
        # The alias must not reach *any* child process's argument vector, and
        # `ps` on a shared runner shows arguments. `keytool -alias` and
        # `awk -v alias=` are the two ways it previously could.
        for argv_leak in ("-alias ", "-v alias=", "-v ALIAS="):
            if argv_leak in keystore_code:
                violations.append(
                    f"{KEYSTORE_HELPER} must not pass the signing alias in a child argument "
                    f"vector ({argv_leak.strip()})"
                )
        if 'ENVIRON["KEY_ALIAS"]' not in keystore_code:
            violations.append(
                f"{KEYSTORE_HELPER} must read the alias from the environment, not an argument"
            )
        # keytool's labels are translated. Without a pinned locale the parser
        # silently matches nothing on a non-English runner.
        for flag in ("-J-Duser.language=en", "-J-Duser.country=US"):
            if flag not in keystore_code:
                violations.append(
                    f"{KEYSTORE_HELPER} must pin keytool's locale with {flag} so its labels "
                    "are machine-readable"
                )
        # The expected fingerprint is validated before it can reach a log line.
        if "^[0-9a-f]{64}$" not in keystore_code:
            violations.append(
                f"{KEYSTORE_HELPER} must validate the expected fingerprint as 64 hex characters"
            )
        # An override must not be reachable from the environment: an earlier
        # step in the signed job writes $GITHUB_ENV, so a variable is candidate
        # controllable while a reviewed step's `run` text is not.
        if "EXPECTED_CERT_SHA256:-" in keystore_code:
            violations.append(
                f"{KEYSTORE_HELPER} must not take the expected fingerprint from the "
                "environment; $GITHUB_ENV is writable by an earlier candidate step"
            )
        if "--expect-sha256" in verify_body:
            violations.append(
                f"{ALLOWED_JOB} must not override the reviewed upload certificate"
            )

    # The workflow token is admissible only inside those reviewed steps. Any
    # other appearance would put it in reach of candidate Gradle or a candidate
    # script running beside the decoded keystore.
    token_carriers = sorted(
        str(step.get("name"))
        for step in release_step_list
        if WORKFLOW_TOKEN in "\n".join(strings(step))
    )
    if token_carriers != sorted(EXPECTED_RELEASE_REVALIDATION_STEPS):
        violations.append(
            f"{ALLOWED_JOB} may name the workflow token only in its reviewed revalidation "
            f"steps; found it in {token_carriers}"
        )
    release_without_steps = {key: value for key, value in release.items() if key != "steps"}
    if WORKFLOW_TOKEN in "\n".join(strings(release_without_steps)):
        violations.append(f"{ALLOWED_JOB} must not carry the workflow token at job scope")

    named_secrets = {
        name for item in strings(release) for name in SECRET_REFERENCE.findall(item)
    }
    unreviewed_secrets = named_secrets - ALLOWED_RELEASE_SECRETS
    if unreviewed_secrets:
        violations.append(
            f"{ALLOWED_JOB} must not carry any credential beyond the reviewed signing "
            f"secrets: {', '.join(sorted(unreviewed_secrets))}"
        )
    if release.get("environment") != ENVIRONMENT_NAME:
        violations.append(f"{ALLOWED_JOB} must bind the {ENVIRONMENT_NAME} environment")
    if release.get("runs-on") != "ubuntu-latest":
        violations.append(f"{ALLOWED_JOB} must run exactly on GitHub-hosted ubuntu-latest")
    if "defaults" in release:
        violations.append(
            f"{ALLOWED_JOB} must not declare defaults; it has no candidate tree to run in"
        )
    # The umbrella lock belongs on the attachment job. Leaving it here would put
    # the signing job back in the shared write domain it no longer belongs to.
    if "concurrency" in release:
        violations.append(
            f"{ALLOWED_JOB} must not declare concurrency; the umbrella lock belongs to "
            f"{ATTACHMENT_JOB}"
        )
    if semantic_sha256(release) != EXPECTED_RELEASE_JOB_SHA256:
        violations.append(f"{ALLOWED_JOB} must match the exact reviewed release-job specification")
    for forbidden_key in ("container", "services", "strategy", "env", "continue-on-error"):
        if forbidden_key in release:
            violations.append(f"{ALLOWED_JOB} must not define job-level {forbidden_key}")
    unexpected_job_keys = set(release) - ALLOWED_RELEASE_JOB_KEYS
    if unexpected_job_keys:
        violations.append(
            f"{ALLOWED_JOB} has unreviewed job keys: {', '.join(sorted(unexpected_job_keys))}"
        )
    if "uses" in release:
        violations.append(f"{ALLOWED_JOB} must not delegate to a reusable workflow")
    if any(target.startswith("./") for target in action_uses(release)):
        violations.append(f"{ALLOWED_JOB} must not invoke local actions")

    release_steps = release.get("steps")
    if not isinstance(release_steps, list):
        violations.append(f"{ALLOWED_JOB} steps must be a sequence")
    else:
        install_steps = [
            step for step in release_steps
            if isinstance(step, Mapping)
            and step.get("name") == EXPECTED_BUILD_TOOLS_INSTALL_STEP["name"]
        ]
        if install_steps != [EXPECTED_BUILD_TOOLS_INSTALL_STEP]:
            violations.append(
                f"{ALLOWED_JOB} must install and check exact build-tools;36.0.0 "
                "with the reviewed fixed-path step"
            )
        elif release_step_names.index(EXPECTED_BUILD_TOOLS_INSTALL_STEP["name"]) > decode_index:
            violations.append(
                f"{ALLOWED_JOB} must install Android signing tools before decoding the keystore"
            )
        for step in release_steps:
            if not isinstance(step, Mapping):
                violations.append(f"{ALLOWED_JOB} steps must contain only mappings")
                continue
            step_name = step.get("name")
            unexpected_step_keys = set(step) - ALLOWED_RELEASE_STEP_KEYS
            if unexpected_step_keys:
                violations.append(
                    f"{ALLOWED_JOB} step {step_name!r} has unreviewed keys: "
                    f"{', '.join(sorted(unexpected_step_keys))}"
                )
            if ("run" in step) == ("uses" in step):
                violations.append(
                    f"{ALLOWED_JOB} step {step_name!r} must define exactly one of run or uses"
                )
            for forbidden_key in ("shell", "working-directory", "continue-on-error"):
                if forbidden_key in step:
                    violations.append(
                        f"{ALLOWED_JOB} step {step_name!r} must not define {forbidden_key}"
                    )
            if "env" in step:
                expected_env = REVIEWED_RELEASE_STEP_ENVIRONMENTS.get(str(step_name))
                if step.get("env") != expected_env:
                    violations.append(
                        f"{ALLOWED_JOB} step {step_name!r} must use its exact reviewed environment"
                    )

        for step_name, expected_env in EXPECTED_RELEASE_STEP_ENVIRONMENTS.items():
            matching_steps = [
                step
                for step in release_steps
                if isinstance(step, Mapping) and step.get("name") == step_name
            ]
            if len(matching_steps) != 1 or matching_steps[0].get("env") != expected_env:
                violations.append(
                    f"{ALLOWED_JOB} must contain exactly one {step_name!r} step with reviewed environment"
                )
            elif semantic_sha256(matching_steps[0]) != EXPECTED_SECRET_STEP_SHA256[step_name]:
                violations.append(
                    f"{ALLOWED_JOB} step {step_name!r} must match its exact reviewed execution"
                )
        release_without_step_env = dict(release)
        release_without_step_env["steps"] = [
            {key: value for key, value in step.items() if key != "env"}
            if isinstance(step, Mapping)
            else step
            for step in release_steps
        ]
        refs_outside_reviewed_env = signing_references(release_without_step_env)
        if refs_outside_reviewed_env:
            violations.append(
                f"{ALLOWED_JOB} references signing secrets outside reviewed step environments: "
                f"{', '.join(sorted(refs_outside_reviewed_env))}"
            )

    for relative in (ROOT_WORKFLOW, ANDROID_CI_WORKFLOW, ANDROID_SIBLING_WORKFLOW):
        path = root / relative
        try:
            workflow = load_workflow(path)
        except ValueError:
            continue
        for target in action_uses(workflow):
            if unpinned_action(target):
                violations.append(f"{relative} action must be pinned to a full commit SHA: {target}")

    return violations


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()

    violations = check(args.root.resolve())
    if violations:
        print("Release control-plane / Android signing boundary check failed:")
        for violation in sorted(set(violations)):
            print(f"- {violation}")
        return 1

    print("Release control-plane and Android signing boundary check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
