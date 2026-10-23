"""Pinned web base and native smoke dependency materials, checked once in CI."""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BASE_DIGEST = "sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914"
BASE = f"node:22-alpine@{BASE_DIGEST}"
PY_YAML_HASHES = {
    "x86_64": "ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc",
    "aarch64": "9149cad251584d5fb4981be1ecde53a1ca46c891a79788c0df828d2f166bda28",
}
INDEX_TYPE = "application/vnd.oci.image.index.v1+json"
IMAGE_TYPE = "application/vnd.oci.image.manifest.v1+json"


def test_all_three_web_stages_pin_one_base_generation():
    text = (ROOT / "Dockerfile.web").read_text(encoding="utf-8")
    assert re.findall(r"^FROM (\S+)", text, re.MULTILINE) == [BASE] * 3
    assert "LABEL org.opencontainers.image.revision=$VCS_REF" in text
    assert "ENV SILENTSUITE_PUBLIC_BUILD_SHA=$VCS_REF" in text


def test_smoke_and_candidate_setup_lock_both_cp312_wheels():
    for relative in ("scripts/umbrel-candidate-smoke.sh", ".github/workflows/ci-umbrel-candidate.yml"):
        text = (ROOT / relative).read_text(encoding="utf-8")
        assert "PyYAML==6.0.3" in text
        assert "--require-hashes" in text and "--only-binary=:all:" in text
        assert all(f"--hash=sha256:{value}" in text for value in PY_YAML_HASHES.values())
    smoke = (ROOT / "scripts/umbrel-candidate-smoke.sh").read_text(encoding="utf-8")
    assert "python3.12 -m venv" in smoke
    assert "python-version: '3.12'" in (ROOT / ".github/workflows/ci-umbrel-candidate.yml").read_text(encoding="utf-8")


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        redirected = super().redirect_request(request, response, code, message, headers, newurl)
        if urllib.parse.urlsplit(request.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
            redirected.remove_header("Authorization")
        return redirected


def fetch(url, token=None, accept=None):
    request = urllib.request.Request(url)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    if accept:
        request.add_header("Accept", accept)
    with urllib.request.build_opener(SafeRedirect).open(request, timeout=60) as response:
        raw = response.read(2_000_001)
        assert len(raw) <= 2_000_000, "unexpectedly large registry metadata"
        return raw, response.headers.get("Docker-Content-Digest")


def verified_json(raw, digest, size=None):
    assert f"sha256:{hashlib.sha256(raw).hexdigest()}" == digest, "registry bytes differ from digest"
    if size is not None:
        assert len(raw) == size, "descriptor size differs from served bytes"
    return json.loads(raw)


def test_live_pinned_node_index_children_configs_and_pyyaml_hashes():
    try:
        raw, _ = fetch("https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull")
        token = json.loads(raw)["token"]
        base = "https://registry-1.docker.io/v2/library/node"
        raw, header = fetch(f"{base}/manifests/{BASE_DIGEST}", token, INDEX_TYPE)
        assert header == BASE_DIGEST
        index = verified_json(raw, BASE_DIGEST)
        assert index["mediaType"] == INDEX_TYPE
        children = []
        for architecture in ("amd64", "arm64"):
            matching = [
                child for child in index["manifests"]
                if child.get("platform", {}).get("os") == "linux"
                and child["platform"].get("architecture") == architecture
            ]
            assert len(matching) == 1, f"missing or duplicate {architecture} platform"
            descriptor = matching[0]
            assert descriptor["mediaType"] == IMAGE_TYPE
            if architecture == "arm64":
                assert descriptor["platform"].get("variant") in (None, "v8")
            children.append(descriptor["digest"])
            raw, header = fetch(f"{base}/manifests/{descriptor['digest']}", token, IMAGE_TYPE)
            assert header == descriptor["digest"]
            child = verified_json(raw, descriptor["digest"], descriptor["size"])
            assert child["mediaType"] == IMAGE_TYPE and "manifests" not in child
            config_descriptor = child["config"]
            raw, _ = fetch(f"{base}/blobs/{config_descriptor['digest']}", token)
            config = verified_json(raw, config_descriptor["digest"], config_descriptor["size"])
            assert (config["os"], config["architecture"]) == ("linux", architecture)
        assert len(set(children)) == 2

        raw, _ = fetch("https://pypi.org/pypi/PyYAML/6.0.3/json")
        releases = json.loads(raw)["urls"]
        for architecture, expected in PY_YAML_HASHES.items():
            matching = [
                release for release in releases
                if release["filename"].startswith("pyyaml-6.0.3-cp312-cp312-manylinux")
                and release["filename"].endswith(f"_{architecture}.whl")
            ]
            assert len(matching) == 1
            assert matching[0]["digests"]["sha256"] == expected
    except (urllib.error.URLError, OSError) as error:
        if os.environ.get("SILENTSUITE_REQUIRE_REGISTRY_CONTRACT") == "1":
            pytest.fail(f"required live web materials check unavailable: {error}")
        pytest.skip(f"live web materials unavailable: {error}")


@pytest.mark.parametrize("size,digest", [(3, "sha256:" + "0" * 64), (1, "sha256:" + hashlib.sha256(b"{}").hexdigest())])
def test_materials_verifier_rejects_wrong_bytes_or_size(size, digest):
    with pytest.raises(AssertionError):
        verified_json(b"{}", digest, size)


def test_ci_runs_web_materials_once_under_required_live_contract():
    text = (ROOT / ".github/workflows/ci-server.yml").read_text(encoding="utf-8")
    assert "--ignore=tests/test_self_host_web_image_materials.py" in text
    assert text.count("python -m pytest tests/test_self_host_web_image_materials.py -q") == 1
    live = text.split("- name: Verify the pinned base image and the hash lock against live indexes", 1)[1].split("\n  self-host-backup-behaviour:", 1)[0]
    assert "SILENTSUITE_REQUIRE_REGISTRY_CONTRACT: '1'" in live
    assert "python -m pytest tests/test_self_host_web_image_materials.py -q" in live
