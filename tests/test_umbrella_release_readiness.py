"""Behavioural contract for the umbrella readiness gate.

Three component lanes append to one draft and none of them can see the others,
so the last question before a human publishes — "is this draft actually the
release?" — has to be answered somewhere. This exercises that answer against a
live stand-in for the GitHub API: a complete draft, and then every way one can
be incomplete or wrong.

It also pins the property that makes the gate safe to run at all: it issues no
mutating request, so it can never publish what it is judging.
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from github_api_stub import GitHubStub, default_state

ROOT = Path(__file__).resolve().parents[1]
READINESS = ROOT / "scripts" / "verify-umbrella-release-readiness.py"
BUILD_BUNDLE = ROOT / "scripts" / "build-self-host-bundle.py"

sys.path.insert(0, str(ROOT / "scripts"))
from umbrel_release_contract import render as render_umbrel_images  # noqa: E402
from umbrella_release_contract import (  # noqa: E402
    BRIDGE_PLATFORMS,
    android_assets,
    bridge_assets,
    expected_assets,
    self_host_assets,
)

TAG = "v1.2.3"
COMMIT = "a" * 40
OTHER_COMMIT = "b" * 40
INDEX_DIGEST = "sha256:" + "1" * 64
AMD64_DIGEST = "sha256:" + "2" * 64
ARM64_DIGEST = "sha256:" + "3" * 64


def sidecar(name: str, payload: bytes) -> bytes:
    return f"{hashlib.sha256(payload).hexdigest()}  {name}\n".encode("utf-8")


@pytest.fixture(scope="module")
def complete_assets(tmp_path_factory) -> dict[str, bytes]:
    """Exactly the umbrella inventory, with real bundle bytes."""

    directory = tmp_path_factory.mktemp("bundle")
    subprocess.run(
        [
            sys.executable,
            str(BUILD_BUNDLE),
            "--tag",
            TAG,
            "--source-commit",
            COMMIT,
            "--index-digest",
            INDEX_DIGEST,
            "--amd64-digest",
            AMD64_DIGEST,
            "--arm64-digest",
            ARM64_DIGEST,
            "--self-host-dir",
            str(ROOT / "self-host"),
            "--output-dir",
            str(directory),
        ],
        check=True,
        capture_output=True,
    )

    paired = render_umbrel_images(
        TAG, COMMIT, (directory / "server-image.json").read_text(encoding="utf-8"),
        "sha256:" + "4" * 64, "sha256:" + "5" * 64, "sha256:" + "6" * 64,
    )
    (directory / "umbrel-images.json").write_text(paired, encoding="utf-8")
    payloads: dict[str, bytes] = {}
    for name in self_host_assets(TAG):
        payloads[name] = (directory / name).read_bytes()

    apk, installer, aab, bundle, symbols, symbols_sum = android_assets(TAG)
    payloads[apk] = b"android-apk-bytes"
    payloads[installer] = sidecar(apk, payloads[apk])
    payloads[aab] = b"android-aab-bytes"
    payloads[bundle] = sidecar(aab, payloads[aab])
    payloads[symbols] = b"android-symbol-bytes"
    payloads[symbols_sum] = sidecar(symbols, payloads[symbols])

    for platform in BRIDGE_PLATFORMS:
        binary = f"silentsuite-bridge-{platform}"
        payloads[binary] = f"bridge-{platform}".encode("utf-8")
        payloads[f"{binary}.sha256"] = sidecar(binary, payloads[binary])
    payloads["SHA256SUMS.txt"] = b"".join(
        payloads[name]
        for name in sorted(f"silentsuite-bridge-{p}.sha256" for p in BRIDGE_PLATFORMS)
    )

    assert set(payloads) == set(expected_assets(TAG))
    return payloads


@pytest.fixture
def stub():
    server = GitHubStub(default_state(TAG, COMMIT))
    try:
        yield server
    finally:
        server.close()


def publish_draft(
    stub: GitHubStub,
    payloads: dict[str, bytes],
    *,
    draft: bool = True,
    target: str | None = COMMIT,
    omit: set[str] | None = None,
    extra: dict[str, bytes] | None = None,
) -> dict:
    release = stub.add_release(TAG, draft=draft, target=target)
    for name, payload in sorted({**payloads, **(extra or {})}.items()):
        if omit and name in omit:
            continue
        stub.add_asset(release["id"], name, payload)
    return release


def readiness(
    stub: GitHubStub,
    *,
    tag: str = TAG,
    commit: str = COMMIT,
    token: str = "test-token",
):
    environment = {**os.environ, **stub.environment(), "GITHUB_TOKEN": token}
    environment.pop("GITHUB_REF", None)
    return subprocess.run(
        [sys.executable, str(READINESS), "--tag", tag, "--commit", commit],
        capture_output=True,
        text=True,
        env=environment,
    )


# ── The complete draft ────────────────────────────────────────────────


def test_a_complete_draft_is_reported_ready(stub, complete_assets):
    release = publish_draft(stub, complete_assets)

    result = readiness(stub)

    assert result.returncode == 0, result.stderr
    assert f"READY: draft {release['id']} for {TAG} is complete at {COMMIT}" in result.stdout
    assert "Publication remains a manual, human action" in result.stdout


def test_the_gate_issues_no_mutating_request(stub, complete_assets):
    """It judges the draft; it must have no way to publish it."""

    publish_draft(stub, complete_assets)
    before = copy.deepcopy(
        {key: stub.state[key] for key in ("releases", "assets", "asset_bytes")}
    )

    assert readiness(stub).returncode == 0
    assert [method for method, _ in stub.state["requests"] if method != "GET"] == []
    after = {key: stub.state[key] for key in ("releases", "assets", "asset_bytes")}
    assert after == before
    source = READINESS.read_text(encoding="utf-8")
    for mutation in ("POST", "PATCH", "DELETE", "PUT"):
        assert f'"{mutation}"' not in source
    assert "draft: false" not in source
    assert "make_latest" not in source


def test_draft_visibility_capability_is_required_by_the_model(stub, complete_assets):
    """Model the observed ceiling without treating the stub as permission proof."""

    publish_draft(stub, complete_assets)
    stub.state["draft_visible_tokens"] = {"write-capability-token"}

    hidden = readiness(stub, token="read-capability-token")
    visible = readiness(stub, token="write-capability-token")

    assert hidden.returncode != 0
    assert f"0 releases claim {TAG}" in hidden.stderr
    assert visible.returncode == 0, visible.stderr
    assert [method for method, _ in stub.state["requests"] if method != "GET"] == []


def test_the_matching_draft_is_found_beyond_the_first_three_pages(stub, complete_assets):
    for index in range(350):
        stub.add_release(f"v0.0.{index}", target=COMMIT)
    publish_draft(stub, complete_assets)

    assert readiness(stub).returncode == 0


def test_a_draft_targeting_the_default_branch_is_accepted(stub, complete_assets):
    publish_draft(stub, complete_assets, target="main")

    assert readiness(stub).returncode == 0


# ── Every way a draft is not ready ────────────────────────────────────


@pytest.mark.parametrize(
    ("component", "omitted"),
    [
        ("android", android_assets(TAG)[0]),
        ("android", android_assets(TAG)[5]),
        ("bridge", bridge_assets(TAG)[0]),
        ("bridge", "SHA256SUMS.txt"),
        ("self-host", self_host_assets(TAG)[0]),
        ("self-host", "server-image.json"),
        ("self-host", "umbrel-images.json"),
    ],
)
def test_a_missing_component_asset_blocks_publication(stub, complete_assets, component, omitted):
    publish_draft(stub, complete_assets, omit={omitted})

    result = readiness(stub)

    assert result.returncode != 0
    assert "NOT READY" in result.stderr
    assert f"{component} is missing" in result.stderr
    assert omitted in result.stderr


def test_an_unexpected_asset_blocks_publication(stub, complete_assets):
    publish_draft(stub, complete_assets, extra={"surprise.bin": b"unexpected"})

    result = readiness(stub)

    assert result.returncode != 0
    assert "unexpected assets ['surprise.bin']" in result.stderr


def test_a_published_release_is_not_a_readiness_subject(stub, complete_assets):
    publish_draft(stub, complete_assets, draft=False)

    result = readiness(stub)

    assert result.returncode != 0
    assert "already published; readiness is a pre-publication gate" in result.stderr


def test_a_draft_targeting_another_commit_blocks_publication(stub, complete_assets):
    publish_draft(stub, complete_assets, target=OTHER_COMMIT)

    result = readiness(stub)

    assert result.returncode != 0
    assert f"not the admitted {COMMIT}" in result.stderr


def test_two_releases_claiming_the_tag_block_publication(stub, complete_assets):
    publish_draft(stub, complete_assets)
    stub.add_release(TAG, target=COMMIT)

    result = readiness(stub)

    assert result.returncode != 0
    assert f"2 releases claim {TAG}" in result.stderr


def test_a_checksum_sidecar_that_does_not_cover_its_asset_blocks_publication(
    stub, complete_assets
):
    payloads = dict(complete_assets)
    apk, installer = android_assets(TAG)[0], android_assets(TAG)[1]
    payloads[installer] = sidecar(apk, b"different-bytes")
    publish_draft(stub, payloads)

    result = readiness(stub)

    assert result.returncode != 0
    assert f"{installer} records" in result.stderr


def test_a_bridge_manifest_that_is_not_the_concatenation_blocks_publication(
    stub, complete_assets
):
    payloads = dict(complete_assets)
    payloads["SHA256SUMS.txt"] = b"0" * 64 + b"  silentsuite-bridge-linux-x86_64\n"
    publish_draft(stub, payloads)

    result = readiness(stub)

    assert result.returncode != 0
    assert "SHA256SUMS.txt is not the concatenation" in result.stderr


def test_a_manifest_naming_another_commit_blocks_publication(stub, complete_assets):
    payloads = dict(complete_assets)
    manifest = json.loads(payloads["server-image.json"])
    manifest["sourceCommit"] = OTHER_COMMIT
    payloads["server-image.json"] = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    publish_draft(stub, payloads)

    result = readiness(stub)

    assert result.returncode != 0
    assert "sourceCommit" in result.stderr


def test_an_asset_still_uploading_blocks_publication(stub, complete_assets):
    release = publish_draft(stub, complete_assets)
    stub.state["assets"][release["id"]][0]["state"] = "starter"

    result = readiness(stub)

    assert result.returncode != 0
    assert "is in state 'starter'" in result.stderr


def test_a_moved_tag_blocks_publication(stub, complete_assets):
    publish_draft(stub, complete_assets)
    stub.state["tags"][TAG] = {"type": "commit", "sha": OTHER_COMMIT}

    result = readiness(stub)

    assert result.returncode != 0
    assert "live release identity rejected" in result.stderr


def test_a_disabled_tag_ruleset_blocks_publication(stub, complete_assets):
    publish_draft(stub, complete_assets)
    stub.state["rulesets"][0]["enforcement"] = "disabled"

    result = readiness(stub)

    assert result.returncode != 0
    assert "live release identity rejected" in result.stderr


# ── The inventory itself ──────────────────────────────────────────────


def test_the_inventory_is_the_union_of_three_disjoint_component_sets():
    android = set(android_assets(TAG))
    bridge = set(bridge_assets(TAG))
    self_host = set(self_host_assets(TAG))

    assert android & bridge == set()
    assert android & self_host == set()
    assert bridge & self_host == set()
    assert set(expected_assets(TAG)) == android | bridge | self_host
    assert len(expected_assets(TAG)) == 6 + 11 + 4


def test_the_inventory_refuses_a_tag_outside_the_release_grammar():
    module = importlib.util.spec_from_file_location(
        "umbrella_release_contract", ROOT / "scripts" / "umbrella_release_contract.py"
    )
    contract = importlib.util.module_from_spec(module)
    module.loader.exec_module(contract)
    for bad in ("nightly", "1.2.3", "v1.2", "v1.2.3-beta_1"):
        with pytest.raises(contract.InventoryError):
            contract.expected_assets(bad)


@pytest.mark.parametrize("field", ["sourceCommit", "platforms", "server", "buildArgs"])
def test_bad_paired_identity_blocks_readiness(stub, complete_assets, field):
    payloads = dict(complete_assets)
    document = json.loads(payloads["umbrel-images.json"])
    if field == "sourceCommit":
        document[field] = OTHER_COMMIT
    elif field == "platforms":
        document[field] = ["linux/amd64"]
    elif field == "server":
        document[field]["indexDigest"] = "sha256:" + "9" * 64
    else:
        document[field]["NEXT_PUBLIC_OWNER_REGISTRATION"] = "false"
    payloads["umbrel-images.json"] = json.dumps(document).encode("utf-8")
    publish_draft(stub, payloads)
    result = readiness(stub)
    assert result.returncode != 0
    assert "NOT READY" in result.stderr
    assert all(method == "GET" for method, _ in stub.state["requests"])
