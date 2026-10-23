#!/usr/bin/env python3
"""Report whether one umbrella draft release is complete enough to publish.

Three component workflows append to a single draft and none of them can see
what the others produced, so "the Android lane succeeded" has never meant "the
release is publishable". This is the gate that says so, and it is read-only by
construction: it issues GET requests and nothing else. It cannot publish a
release, create one, or touch an asset — publication stays a deliberate human
act, and this only tells the human whether the draft is worth publishing.

What it proves, all fail-closed:

  1. the live tag still resolves to the admitted commit and both tag rulesets
     are still active, by running the same trusted verifier the mutation lanes
     use;
  2. exactly one release claims the tag, found by paging the release list to
     exhaustion rather than trusting the first few hundred entries;
  3. that release is still a draft, names the exact tag, and targets the
     admitted commit;
  4. its asset set is exactly the published umbrella inventory — every required
     Android, Bridge and self-host asset present, no sibling omitted, nothing
     unexpected added;
  5. every checksum sidecar matches the bytes of the asset it covers, the
     bridge SHA256SUMS.txt is exactly the concatenation of the per-binary
     sidecars, and the self-host manifest and archive match the release
     identity.

Usage:
  scripts/verify-umbrella-release-readiness.py --tag vX.Y.Z --commit <40-hex>

Requires GITHUB_REPOSITORY. GITHUB_TOKEN is required to read a draft release.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from selfhost_release_contract import (  # noqa: E402
    MANIFEST_NAME,
    ContractError,
    ReleaseIdentity,
    assert_archive_members_safe,
    assert_bundle_inventory,
    assert_manifest_matches,
    bundle_basename,
    parse_checksum_file,
    parse_manifest,
)
from umbrella_release_contract import (  # noqa: E402
    BRIDGE_CHECKSUM_MANIFEST,
    BRIDGE_PLATFORMS,
    checksum_pairs,
    components,
    expected_assets,
)

from umbrel_release_contract import MANIFEST_NAME as UMBREL_MANIFEST, verify as verify_umbrel_images  # noqa: E402

SCRIPT_DIR = Path(__file__).resolve().parent
IDENTITY_SCRIPT = SCRIPT_DIR / "verify-release-identity.sh"
# Two orders of magnitude beyond this repository's release count. Reaching it
# means the listing is not converging, which is a refusal rather than a guess.
MAX_PAGES = 200
PROTECTED_BRANCH = "main"


class ReadinessError(RuntimeError):
    """The draft is not ready to publish."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Asset downloads answer 302 to a signed URL that must not carry our token."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        raise _Redirected(newurl)


class _Redirected(Exception):
    def __init__(self, location: str) -> None:
        super().__init__(location)
        self.location = location


def _api_base() -> str:
    return os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")


def _request(url: str, accept: str) -> urllib.request.Request:
    request = urllib.request.Request(url)
    request.add_header("Accept", accept)
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    return request


def api_get(path: str) -> object:
    url = f"{_api_base()}{path}"
    try:
        with urllib.request.urlopen(_request(url, "application/vnd.github+json"), timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise ReadinessError(f"GET {path} answered HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise ReadinessError(f"GET {path} failed: {error.reason}") from error


def api_get_all(path: str) -> list[dict]:
    """Page a list endpoint to exhaustion; a truncated list could hide a twin."""

    collected: list[dict] = []
    for page in range(1, MAX_PAGES + 1):
        batch = api_get(f"{path}?per_page=100&page={page}")
        if not isinstance(batch, list):
            raise ReadinessError(f"GET {path} did not return a list")
        collected.extend(item for item in batch if isinstance(item, dict))
        if len(batch) < 100:
            return collected
    raise ReadinessError(f"GET {path} did not terminate within {MAX_PAGES} pages")


def download_asset(asset_id: int, destination: Path) -> None:
    url = f"{_api_base()}/repos/{os.environ['GITHUB_REPOSITORY']}/releases/assets/{asset_id}"
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(_request(url, "application/octet-stream"), timeout=300) as response:
            destination.write_bytes(response.read())
            return
    except _Redirected as redirect:
        location = redirect.location
    except urllib.error.HTTPError as error:
        raise ReadinessError(f"asset {asset_id} answered HTTP {error.code}") from error
    # The signed URL authenticates itself; sending our token to it would fail.
    plain = urllib.request.Request(location)
    with urllib.request.urlopen(plain, timeout=300) as response:
        destination.write_bytes(response.read())


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def verify_identity(tag: str, commit: str) -> None:
    result = subprocess.run(
        [
            "bash",
            str(IDENTITY_SCRIPT),
            "--tag",
            tag,
            "--commit",
            commit,
            "--stage",
            "umbrella-readiness",
        ],
        capture_output=True,
        text=True,
    )
    sys.stdout.write(result.stdout)
    if result.returncode != 0:
        raise ReadinessError(f"live release identity rejected:\n{result.stderr.strip()}")


def resolve_release(tag: str, commit: str) -> dict:
    repository = os.environ["GITHUB_REPOSITORY"]
    matches = [
        release
        for release in api_get_all(f"/repos/{repository}/releases")
        if release.get("tag_name") == tag
    ]
    if len(matches) != 1:
        raise ReadinessError(f"{len(matches)} releases claim {tag}; exactly one is required")
    release = matches[0]
    if release.get("draft") is not True:
        raise ReadinessError(
            f"release {release.get('id')} for {tag} is already published; readiness is a pre-publication gate"
        )
    target = release.get("target_commitish")
    if target not in (commit, PROTECTED_BRANCH):
        raise ReadinessError(
            f"release {release.get('id')} targets {target!r}, not the admitted {commit}"
        )
    return release


def verify_inventory(tag: str, assets: list[dict]) -> dict[str, dict]:
    by_name: dict[str, dict] = {}
    for asset in assets:
        name = asset.get("name")
        if name in by_name:
            raise ReadinessError(f"two assets are both named {name!r}")
        by_name[str(name)] = asset

    expected = set(expected_assets(tag))
    actual = set(by_name)
    problems: list[str] = []
    for component, names in components(tag).items():
        missing = sorted(set(names) - actual)
        if missing:
            problems.append(f"{component} is missing {missing}")
    unexpected = sorted(actual - expected)
    if unexpected:
        problems.append(f"the draft carries unexpected assets {unexpected}")
    for name, asset in sorted(by_name.items()):
        if asset.get("state") != "uploaded":
            problems.append(f"{name} is in state {asset.get('state')!r}")
    if problems:
        raise ReadinessError("; ".join(problems))
    return by_name


def verify_bytes(tag: str, commit: str, by_name: dict[str, dict], workdir: Path) -> None:
    payloads: dict[str, bytes] = {}
    for name, asset in sorted(by_name.items()):
        destination = workdir / name
        download_asset(int(asset["id"]), destination)
        payload = destination.read_bytes()
        if len(payload) != int(asset.get("size", -1)):
            raise ReadinessError(
                f"{name} is {len(payload)} bytes, the release reports {asset.get('size')}"
            )
        payloads[name] = payload

    for sidecar, covered in checksum_pairs(tag):
        recorded = parse_checksum_file(payloads[sidecar].decode("utf-8"), covered)
        actual = sha256_bytes(payloads[covered])
        if recorded != actual:
            raise ReadinessError(f"{sidecar} records {recorded}, {covered} hashes to {actual}")

    # stage-bridge-release-assets.sh concatenates the sidecars in C-locale
    # filename order, so the manifest is reproduced the same way here.
    combined = b"".join(
        payloads[name]
        for name in sorted(
            f"silentsuite-bridge-{platform}.sha256" for platform in BRIDGE_PLATFORMS
        )
    )
    if payloads[BRIDGE_CHECKSUM_MANIFEST] != combined:
        raise ReadinessError(
            f"{BRIDGE_CHECKSUM_MANIFEST} is not the concatenation of the per-binary sidecars"
        )

    manifest = parse_manifest(payloads[MANIFEST_NAME].decode("utf-8"))
    identity = ReleaseIdentity(
        tag=tag,
        source_commit=commit,
        index_digest=manifest["indexDigest"],
        amd64_digest=manifest["amd64Digest"],
        arm64_digest=manifest["arm64Digest"],
    )
    assert_manifest_matches(manifest, identity)
    verify_umbrel_images(payloads[UMBREL_MANIFEST].decode("utf-8"), tag, commit, payloads[MANIFEST_NAME].decode("utf-8"))

    archive = workdir / bundle_basename(tag)
    names = assert_archive_members_safe(archive, tag)
    assert_bundle_inventory(names, tag)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True)
    arguments = parser.parse_args()

    if not os.environ.get("GITHUB_REPOSITORY"):
        raise ReadinessError("GITHUB_REPOSITORY must be set")

    verify_identity(arguments.tag, arguments.commit)

    release = resolve_release(arguments.tag, arguments.commit)
    release_id = release["id"]
    print(f"draft release {release_id} claims {arguments.tag} at {release.get('target_commitish')!r}")

    assets = api_get_all(
        f"/repos/{os.environ['GITHUB_REPOSITORY']}/releases/{release_id}/assets"
    )
    by_name = verify_inventory(arguments.tag, assets)
    print(f"asset inventory complete: {len(by_name)} assets")

    with tempfile.TemporaryDirectory() as raw:
        verify_bytes(arguments.tag, arguments.commit, by_name, Path(raw))
    print("every checksum sidecar, the bridge manifest, and the self-host bundle verified")

    print("")
    print(f"READY: draft {release_id} for {arguments.tag} is complete at {arguments.commit}.")
    print("Publication remains a manual, human action; this gate never publishes.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ReadinessError, ContractError) as error:
        print(f"NOT READY: {error}", file=sys.stderr)
        sys.exit(1)
