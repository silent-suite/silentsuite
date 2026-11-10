"""Contracts for the immutable build materials of the self-host server image.

The reviewers' remaining materials finding was that the image was reproducible
in name only: mutable `FROM` tags, `apk add` against live Alpine repositories,
and pip requirements with no hashes. These tests pin what replaced that.

Two halves. The static half reads Dockerfile.server and server/requirements.txt
and is offline. The registry half re-derives the pinned base index and both
runnable platform descriptors from Docker Hub, and re-derives every wheel hash
from PyPI; it skips when the network is unavailable and is required in CI by
setting SILENTSUITE_REQUIRE_REGISTRY_CONTRACT=1.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "Dockerfile.server"
REQUIREMENTS = ROOT / "server" / "requirements.txt"
LOCK_SCRIPT = ROOT / "scripts" / "lock-server-requirements.py"

BASE_IMAGE = "python:3.12-alpine"
BASE_INDEX_DIGEST = "sha256:e064671ca452259bab50e8e2c7bd896e39e9a343bb06ca25234adf6fe18d0fc7"
BASE_CHILDREN = {
    ("linux", "amd64", None): "sha256:a61cbd76a882645de7f91423329fe43a67eed60d7da24f9e5331414bb3618b20",
    ("linux", "arm64", "v8"): "sha256:218ad6ba54faeb7f1089f391c597a80c9d69ca88e561f71ebd77fb452d39249b",
}
OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json"
REGISTRY = "https://registry-1.docker.io"
AUTH = "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/python:pull"

# The three environments that install server/requirements.txt. The two release
# ones are Alpine; the third is the glibc runner that lints and tests the server.
RELEASE_ENVIRONMENTS = ("musllinux-x86_64", "musllinux-aarch64")
CI_ENVIRONMENT = "manylinux-x86_64"
ALL_ENVIRONMENTS = (*RELEASE_ENVIRONMENTS, CI_ENVIRONMENT)

# Distributions with compiled extensions: each needs one wheel per environment,
# so each must carry at least three recorded hashes.
NATIVE_DISTRIBUTIONS = {
    "cffi",
    "httptools",
    "msgpack",
    "psycopg2-binary",
    "pydantic-core",
    "pynacl",
    "pyyaml",
    "uvloop",
    "watchfiles",
    "websockets",
}
PIN = re.compile(r"^(?P<name>[A-Za-z0-9._-]+)(?:\[[a-z0-9,._-]+\])?==(?P<version>[^\s\\]+) \\$")
HASH = re.compile(r"^ {4}--hash=sha256:(?P<digest>[0-9a-f]{64})( \\)?$")


def normalise(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_requirements() -> dict[str, list[str]]:
    """name -> recorded hashes, refusing any line shape the lock does not use."""

    pins: dict[str, list[str]] = {}
    current: str | None = None
    for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        if line.startswith("    #"):
            continue
        match = PIN.match(line)
        if match:
            current = normalise(match.group("name"))
            assert current not in pins, f"{current} is pinned twice"
            pins[current] = []
            continue
        hashed = HASH.match(line)
        assert hashed, f"unrecognised requirements line: {line!r}"
        assert current, "a hash appeared before any pin"
        pins[current].append(hashed.group("digest"))
    return pins


# ── Static: the Dockerfile ────────────────────────────────────────────


def test_both_stages_pin_the_same_approved_base_index():
    """Two stages resolving two base generations is the drift being removed."""

    froms = re.findall(r"^FROM (\S+)", DOCKERFILE.read_text(encoding="utf-8"), re.MULTILINE)
    assert len(froms) == 2, froms
    assert froms == [f"{BASE_IMAGE}@{BASE_INDEX_DIGEST}"] * 2


def test_the_image_installs_no_alpine_package():
    """No apk means no live repository resolution in the release image at all."""

    text = DOCKERFILE.read_text(encoding="utf-8")
    assert not re.search(r"^\s*RUN\b.*\bapk\b", text, re.MULTILINE)
    assert "apk add" not in text


def test_pip_installs_only_hash_locked_wheels():
    text = DOCKERFILE.read_text(encoding="utf-8")
    install = [line for line in text.splitlines() if "pip install" in line]
    assert len(install) == 1, install
    assert "--require-hashes" in install[0]
    assert "--only-binary=:all:" in install[0]
    assert "-r /requirements.txt" in install[0]


def test_the_build_revision_label_is_still_stamped():
    text = DOCKERFILE.read_text(encoding="utf-8")
    assert "ARG VCS_REF" in text
    assert "LABEL org.opencontainers.image.revision=$VCS_REF" in text


# ── Static: the hash lock ─────────────────────────────────────────────


def test_every_requirement_is_pinned_and_hashed():
    pins = parse_requirements()
    assert pins, "the requirements file records no pins"
    for name, digests in sorted(pins.items()):
        assert digests, f"{name} has no recorded hash"


def test_every_native_distribution_records_a_wheel_per_environment():
    pins = parse_requirements()
    missing = sorted(NATIVE_DISTRIBUTIONS - set(pins))
    assert missing == [], f"native distributions vanished from the lock: {missing}"
    for name in sorted(NATIVE_DISTRIBUTIONS):
        assert len(pins[name]) >= len(ALL_ENVIRONMENTS), (
            f"{name} compiles native code, so it needs a wheel hash for each of "
            f"{ALL_ENVIRONMENTS}; only {len(pins[name])} recorded"
        )


def test_no_hash_is_recorded_twice():
    digests = [digest for digests in parse_requirements().values() for digest in digests]
    assert len(digests) == len(set(digests))


def lock_header() -> str:
    """The comment block above the first pin, with wrapping normalised away."""

    header = REQUIREMENTS.read_text(encoding="utf-8").split("aiofiles")[0]
    return " ".join(header.replace("#", " ").split())


def test_the_lock_documents_how_to_regenerate_it():
    header = lock_header()
    assert "scripts/lock-server-requirements.py" in header
    assert "--require-hashes --only-binary=:all:" in header
    assert "Nothing else is listed: no sdist, no architecture beyond those three" in header
    assert "no unportable `linux_*` wheel" in header


def test_the_lock_documents_which_environment_each_hash_serves():
    """A reader must be able to tell why a glibc hash sits in an Alpine lock."""

    header = lock_header()
    for environment in ("musllinux x86_64", "musllinux aarch64", "manylinux x86_64"):
        assert environment in header, f"the lock does not name {environment}"
    assert "pip's supported tags on musl never include manylinux" in header
    assert "structurally incapable of selecting it" in header


def test_the_glibc_ci_job_installs_the_same_lock_under_the_same_rules():
    workflow = (ROOT / ".github/workflows/ci-server.yml").read_text(encoding="utf-8")
    install = [line for line in workflow.splitlines() if "-r requirements.txt" in line]
    assert len(install) == 1, install
    assert "--require-hashes" in install[0]
    assert "--only-binary=:all:" in install[0]


def test_the_server_test_job_runs_the_interpreter_the_lock_was_built_for():
    """A cp310 runner would ask for bytes the lock deliberately does not record."""

    workflow = (ROOT / ".github/workflows/ci-server.yml").read_text(encoding="utf-8")
    job = workflow.split("  test-server:", 1)[1].split("\n  self-host-contracts:", 1)[0]
    assert 'python-version: "3.12"' in job
    assert 'python-version: "3.10"' not in job
    assert "Set up Python 3.12" in job
    # The compiled files say which interpreter they were resolved for.
    for compiled in ("requirements.txt", "requirements-dev.txt"):
        text = (ROOT / "server" / compiled).read_text(encoding="utf-8")
        assert "Python 3.12" in text.split("aiofiles")[0] or "Python 3.12" in text[:600]


# Offline counterpart to the resolution probes below: the generator's admission
# rule itself, checked against the shapes it must never let into the lock.
UNACCEPTABLE_WHEELS = [
    ("cffi-2.0.0.tar.gz", "an sdist"),
    ("cffi-2.0.0-cp310-cp310-manylinux_2_17_x86_64.whl", "the cp310 glibc wheel that broke CI"),
    ("cffi-2.0.0-cp310-cp310-musllinux_1_2_x86_64.whl", "a cp310 musl wheel"),
    ("cffi-2.0.0-cp313-cp313-musllinux_1_2_x86_64.whl", "a newer interpreter"),
    ("cffi-2.0.0-cp312-cp312-manylinux_2_17_aarch64.whl", "glibc aarch64, which nothing here installs"),
    ("cffi-2.0.0-cp312-cp312-linux_x86_64.whl", "an unportable linux_* wheel"),
    ("cffi-2.0.0-cp312-cp312-win_amd64.whl", "a Windows wheel"),
    ("cffi-2.0.0-cp312-cp312-macosx_11_0_arm64.whl", "a macOS wheel"),
    (
        "x-1-cp312-cp312-manylinux_2_17_x86_64.musllinux_1_2_x86_64.whl",
        "a tag set that mixes libc families",
    ),
]
ACCEPTABLE_WHEELS = [
    ("aiofiles-25.1.0-py3-none-any.whl", "pure"),
    ("cffi-2.0.0-cp312-cp312-musllinux_1_2_x86_64.whl", "musllinux-x86_64"),
    ("cffi-2.0.0-cp312-cp312-musllinux_1_2_aarch64.whl", "musllinux-aarch64"),
    ("cffi-2.0.0-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.whl", "manylinux-x86_64"),
    ("pynacl-1.6.2-cp38-abi3-manylinux_2_34_x86_64.whl", "manylinux-x86_64"),
    ("pynacl-1.6.2-cp38-abi3-musllinux_1_2_x86_64.whl", "musllinux-x86_64"),
]


@pytest.mark.parametrize(("filename", "why"), UNACCEPTABLE_WHEELS, ids=lambda value: value[:40])
def test_the_lock_generator_refuses_everything_outside_the_three_environments(filename, why):
    import importlib.util

    spec = importlib.util.spec_from_file_location("lock_server_requirements", LOCK_SCRIPT)
    lock = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lock)
    assert lock.classify(filename) is None, f"the lock would have admitted {why}"


@pytest.mark.parametrize(("filename", "category"), ACCEPTABLE_WHEELS, ids=lambda value: value[:40])
def test_the_lock_generator_admits_exactly_the_three_environments(filename, category):
    import importlib.util

    spec = importlib.util.spec_from_file_location("lock_server_requirements", LOCK_SCRIPT)
    lock = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lock)
    assert lock.classify(filename) == category


def test_the_lock_generator_retries_transient_pypi_resets(monkeypatch):
    import importlib.util
    import urllib.error

    spec = importlib.util.spec_from_file_location("lock_server_requirements_retry", LOCK_SCRIPT)
    lock = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lock)
    attempts = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self):
            return b'{"urls": []}'

    def reset_then_succeed(_request, timeout):
        attempts.append(timeout)
        if len(attempts) < 3:
            raise urllib.error.URLError(ConnectionResetError(104, "reset by peer"))
        return Response()

    monkeypatch.setattr(lock.urllib.request, "urlopen", reset_then_succeed)
    monkeypatch.setattr(lock.time, "sleep", lambda _seconds: None)
    assert lock.pypi_json("example", "1.0") == {"urls": []}
    assert attempts == [60, 60, 60]


def test_the_native_import_check_covers_every_native_distribution():
    checker = (ROOT / "scripts" / "check-server-image-dependencies.py").read_text(encoding="utf-8")
    for name in sorted(NATIVE_DISTRIBUTIONS):
        assert f'"{name}"' in checker, f"{name} is not import-checked inside the image"


def test_ci_proves_the_native_imports_on_both_architectures():
    workflow = (ROOT / ".github/workflows/ci-server.yml").read_text(encoding="utf-8")
    assert "check-server-image-dependencies.py" in workflow
    assert "ubuntu-24.04-arm" in workflow


# ── Registry: the live base index ─────────────────────────────────────


def registry_get(path: str, accept: str) -> tuple[dict, str]:
    token_request = urllib.request.Request(AUTH)
    with urllib.request.urlopen(token_request, timeout=30) as response:
        token = json.loads(response.read().decode("utf-8"))["token"]
    request = urllib.request.Request(f"{REGISTRY}{path}")
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", accept)
    with urllib.request.urlopen(request, timeout=60) as response:
        return (
            json.loads(response.read().decode("utf-8")),
            response.headers.get("Docker-Content-Digest", ""),
        )


def require_network(error: Exception) -> None:
    if os.environ.get("SILENTSUITE_REQUIRE_REGISTRY_CONTRACT") == "1":
        raise AssertionError(f"the registry contract is required in CI: {error}")
    pytest.skip(f"registry unreachable: {error}")


@pytest.fixture(scope="module")
def base_index():
    try:
        return registry_get(
            f"/v2/library/python/manifests/{BASE_INDEX_DIGEST}", OCI_INDEX_MEDIA_TYPE
        )
    except (urllib.error.URLError, OSError) as error:  # pragma: no cover - network shape
        require_network(error)


def test_the_pinned_base_reference_is_the_index_it_names(base_index):
    document, content_digest = base_index
    assert content_digest == BASE_INDEX_DIGEST
    assert document["mediaType"] == OCI_INDEX_MEDIA_TYPE


def test_both_release_platforms_resolve_to_the_reviewed_child_descriptors(base_index):
    """Attestation manifests are classified apart from runnable ones.

    The upstream index carries one `unknown/unknown` attestation manifest per
    architecture. They are evidence about a runnable child, not something a
    runtime can select, so they must never be counted as a platform.
    """

    document, _ = base_index
    runnable: dict[tuple[str, str, str | None], str] = {}
    attestations: dict[str, str] = {}
    for descriptor in document["manifests"]:
        platform = descriptor.get("platform", {})
        annotations = descriptor.get("annotations") or {}
        if platform.get("os") == "unknown" or platform.get("architecture") == "unknown":
            assert annotations.get("vnd.docker.reference.type") == "attestation-manifest"
            attestations[descriptor["digest"]] = annotations["vnd.docker.reference.digest"]
            continue
        runnable[
            (platform["os"], platform["architecture"], platform.get("variant"))
        ] = descriptor["digest"]

    for key, digest in BASE_CHILDREN.items():
        assert runnable.get(key) == digest, f"{key} resolved to {runnable.get(key)}"
    for attested in attestations.values():
        assert attested in runnable.values(), (
            "an attestation manifest points at something that is not a runnable child"
        )


def test_both_reviewed_children_are_single_platform_manifests(base_index):
    _, _ = base_index
    for (operating_system, architecture, variant), digest in BASE_CHILDREN.items():
        try:
            document, content_digest = registry_get(
                f"/v2/library/python/manifests/{digest}",
                "application/vnd.oci.image.manifest.v1+json",
            )
        except (urllib.error.URLError, OSError) as error:  # pragma: no cover
            require_network(error)
        assert content_digest == digest
        assert document["mediaType"] == "application/vnd.oci.image.manifest.v1+json"
        assert "manifests" not in document, (
            f"{architecture} child is an index, not the platform manifest the build records"
        )


# ── Registry: environment separation of the hash lock ────────────────


def load_lock_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location("lock_server_requirements", LOCK_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MANYLINUX_PLATFORMS = [f"manylinux_2_{minor}_x86_64" for minor in range(39, 4, -1)] + [
    "manylinux2014_x86_64",
    "manylinux2010_x86_64",
    "manylinux1_x86_64",
]
COMPATIBILITY_SETS: dict[str, list[str]] = {
    # The glibc CI runner: ubuntu-latest, CPython 3.12, x86_64.
    "manylinux-x86_64": MANYLINUX_PLATFORMS,
    # The two Alpine release images.
    "musllinux-x86_64": ["musllinux_1_2_x86_64", "musllinux_1_1_x86_64", "musllinux_1_0_x86_64"],
    "musllinux-aarch64": [
        "musllinux_1_2_aarch64",
        "musllinux_1_1_aarch64",
        "musllinux_1_0_aarch64",
    ],
}


@pytest.fixture(scope="module")
def resolved_sets() -> dict[str, list[str]]:
    """Resolve the lock the way each environment's pip actually would.

    `pip download --platform` builds the supported-tag list from the platforms
    given rather than from this machine, so one x86_64 glibc host can stand in
    for all three environments — and, crucially, cannot cheat: an environment
    that had no recorded wheel would fail hash checking here.

    The wheels are downloaded into a directory that is removed as soon as the
    module finishes: only their names are needed, and three full dependency
    sets are not worth leaving behind in pytest's retained temporary roots.
    """

    selections: dict[str, list[str]] = {}
    with tempfile.TemporaryDirectory(prefix="silentsuite-lock-probe-") as raw:
        root = Path(raw)
        for name, platforms in COMPATIBILITY_SETS.items():
            destination = root / name
            destination.mkdir()
            selections[name] = _resolve(name, platforms, destination)
    return selections


def _resolve(name: str, platforms: list[str], destination: Path) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "pip",
        "download",
        "--disable-pip-version-check",
        "--quiet",
        "--only-binary=:all:",
        "--require-hashes",
        "--python-version",
        "312",
        "--implementation",
        "cp",
        "--abi",
        "cp312",
    ]
    for platform in (*platforms, "any"):
        command += ["--platform", platform]
    command += ["-r", str(REQUIREMENTS), "-d", str(destination)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        combined = result.stdout + result.stderr
        if "Could not fetch URL" in combined or "Network is unreachable" in combined:
            require_network(RuntimeError(combined.strip()[:400]))
        raise AssertionError(f"{name} did not resolve:\n{combined}")
    return sorted(path.name for path in destination.iterdir())


def test_every_environment_resolves_the_whole_lock_under_hash_checking(resolved_sets):
    expected = len(parse_requirements())
    for name, wheels in sorted(resolved_sets.items()):
        assert len(wheels) == expected, f"{name} resolved {len(wheels)} of {expected} pins"


@pytest.mark.parametrize("environment", RELEASE_ENVIRONMENTS)
def test_the_alpine_release_images_can_only_select_musllinux_or_pure(
    resolved_sets, environment
):
    """The load-bearing claim: a glibc hash in the lock cannot reach the image."""

    lock = load_lock_module()
    for wheel in resolved_sets[environment]:
        category = lock.classify(wheel)
        assert category in (lock.PURE, environment), (
            f"{environment} selected {wheel}, classified {category}"
        )
    assert not [wheel for wheel in resolved_sets[environment] if "manylinux" in wheel]


def test_the_glibc_ci_runner_selects_the_reviewed_manylinux_wheels(resolved_sets):
    lock = load_lock_module()
    for wheel in resolved_sets[CI_ENVIRONMENT]:
        category = lock.classify(wheel)
        assert category in (lock.PURE, CI_ENVIRONMENT), (
            f"{CI_ENVIRONMENT} selected {wheel}, classified {category}"
        )
    assert not [wheel for wheel in resolved_sets[CI_ENVIRONMENT] if "musllinux" in wheel]


def test_every_native_distribution_gets_a_platform_wheel_in_every_environment(resolved_sets):
    for environment, wheels in sorted(resolved_sets.items()):
        platform_wheels = {
            normalise(wheel.split("-")[0]) for wheel in wheels if "none-any" not in wheel
        }
        missing = sorted(NATIVE_DISTRIBUTIONS - platform_wheels)
        # websockets ships a pure wheel too, so it may legitimately resolve to it.
        missing = [name for name in missing if name != "websockets"]
        assert missing == [], f"{environment} built {missing} from something unpinned"


def test_the_recorded_hashes_partition_into_exactly_the_three_environments():
    """No cp310, no sdist, no aarch64 glibc, no unportable linux_* wheel."""

    result = subprocess.run(
        [sys.executable, str(LOCK_SCRIPT), "--report"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 and "urlopen error" in result.stderr:  # pragma: no cover
        require_network(RuntimeError(result.stderr.strip()))
    assert result.returncode == 0, result.stdout + result.stderr
    classified = json.loads(result.stdout)
    lock = load_lock_module()

    recorded = {digest for digests in parse_requirements().values() for digest in digests}
    reported = {wheel["sha256"] for wheels in classified.values() for wheel in wheels}
    assert recorded == reported, "the lock and its classification disagree"

    allowed = {"pure", *ALL_ENVIRONMENTS}
    for requirement, wheels in sorted(classified.items()):
        for wheel in wheels:
            assert wheel["category"] in allowed, f"{requirement}: {wheel}"
            assert wheel["filename"].endswith(".whl"), f"{requirement} records an sdist"
            if wheel["category"] == CI_ENVIRONMENT:
                assert "manylinux" in wheel["filename"]
                assert "aarch64" not in wheel["filename"]
            if wheel["category"] in RELEASE_ENVIRONMENTS:
                assert "musllinux" in wheel["filename"]
            # Round-trip the classification rather than re-deriving a looser
            # one here: a wheel is recorded only if `classify` names it, so a
            # cp310 build, an aarch64 glibc wheel or a bare `linux_x86_64` one
            # would classify as None and could never appear.
            assert lock.classify(wheel["filename"]) == wheel["category"], wheel
            interpreter, abi = wheel["filename"][:-4].split("-")[-3:-1]
            assert (interpreter, abi) in {("py3", "none"), ("py2.py3", "none"), ("cp312", "cp312")} or (
                abi == "abi3" and interpreter.startswith("cp3") and int(interpreter[3:]) <= 12
            ), f"{requirement} records an unreviewed interpreter/ABI tag {interpreter}-{abi}"


def test_the_recorded_wheel_hashes_are_the_published_ones():
    """The lock is exactly what the generator would write from PyPI today."""

    result = subprocess.run(
        [sys.executable, str(LOCK_SCRIPT), "--check"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 and "urlopen error" in result.stderr:  # pragma: no cover
        require_network(RuntimeError(result.stderr.strip()))
    assert result.returncode == 0, result.stdout + result.stderr
