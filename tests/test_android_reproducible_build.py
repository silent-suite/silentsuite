"""Focused contracts for the Android reproducible-build normalisation.

F-Droid publishes the developer-signed APK only if it can rebuild the same
bytes from this source on its own machine. The 0.5.4-beta attempt failed that
check after the release was already cut: BoringSSL had compiled 201
environment-specific __FILE__ paths into libconscrypt_jni.so, the Etebase
libraries carried CARGO_HOME/OUT_DIR paths and path-derived ThinLTO
identifiers, and classes.dex differed by a single MethodParameters attribute
between Temurin and Debian's OpenJDK.

These tests hold the fixes in place and, more importantly, hold the *failure*
behaviour in place: the normalisation must be provably applied, and the
pre-signing gate must not be able to degrade into comparing a build with
itself, which would pass forever while proving nothing.
"""

from __future__ import annotations

import hashlib
import importlib.util
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "android/scripts/reproducible-build-contract.sh"
CONSCRYPT_SCRIPT = ROOT / "android/scripts/build-conscrypt-android-r28.sh"
ETEBASE_SCRIPT = ROOT / "android/scripts/build-etebase-client-16kb.sh"
COMPARISON = ROOT / "scripts/verify-android-build-reproducibility.py"
BOUNDARY_CHECKER = ROOT / "scripts/check-android-signing-boundary.py"
ROOT_GRADLE = ROOT / "android/build.gradle"
RELEASE_WORKFLOW = ROOT / ".github/workflows/release-android.yml"
CI_WORKFLOW = ROOT / ".github/workflows/build-android.yml"

PINNED_JDK_RELEASE = "jdk-17.0.20.1+1"
PINNED_JDK_JAVA_VERSION = "17.0.20.1"
PINNED_JDK_IMPLEMENTOR_VERSION = "Temurin-17.0.20.1+1"
PINNED_RUST_TOOLCHAIN = "1.98.0"
CANONICAL_ROOT = "/tmp/silentsuite-reproducible-build"
VIRTUAL_ROOT = "/silentsuite-build"
REBUILD_JOB = "rebuild-fdroid-environment"
GATE_JOB = "reproducibility-gate"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def workflow(path: Path) -> dict:
    return yaml.safe_load(read(path))


def steps(job: dict) -> dict[str, dict]:
    return {step["name"]: step for step in job["steps"]}


def load_boundary_checker():
    spec = importlib.util.spec_from_file_location("boundary_checker", BOUNDARY_CHECKER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def heredoc_blocks(script: str, marker: str = "PY") -> list[str]:
    """Every `python3 - ... <<'PY' … PY` body embedded in a build script."""

    blocks: list[str] = []
    current: list[str] | None = None
    for line in script.splitlines():
        if current is None:
            if line.rstrip().endswith(f"<<'{marker}'"):
                current = []
            continue
        if line.strip() == marker:
            blocks.append("\n".join(current))
            current = None
        else:
            current.append(line)
    assert current is None, "unterminated heredoc in build script"
    return blocks


def block_containing(script: str, needle: str) -> str:
    matching = [block for block in heredoc_blocks(script) if needle in block]
    assert len(matching) == 1, f"expected exactly one embedded block containing {needle!r}"
    return matching[0]


def run_block(block: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", block, *arguments],
        capture_output=True,
        text=True,
        check=False,
    )


def source_contract(snippet: str, env: dict[str, str] | None = None):
    script = f"set -euo pipefail\nsource {CONTRACT}\n{snippet}\n"
    return subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        check=False,
        env={"PATH": "/usr/bin:/bin", "HOME": "/home/probe", **(env or {})},
    )


# ── the pinned contract ──────────────────────────────────────────────────


def test_contract_pins_an_exact_compiler_toolchain_and_canonical_root():
    contract = read(CONTRACT)

    assert f'SILENTSUITE_RELEASE_JDK_RELEASE="{PINNED_JDK_RELEASE}"' in contract
    assert f'SILENTSUITE_RELEASE_JDK_JAVA_VERSION="{PINNED_JDK_JAVA_VERSION}"' in contract
    assert (
        f'SILENTSUITE_RELEASE_JDK_IMPLEMENTOR_VERSION="{PINNED_JDK_IMPLEMENTOR_VERSION}"'
        in contract
    )
    assert f'SILENTSUITE_RELEASE_RUST_TOOLCHAIN="{PINNED_RUST_TOOLCHAIN}"' in contract
    assert f'SILENTSUITE_CANONICAL_ROOT="{CANONICAL_ROOT}"' in contract
    assert (
        'SILENTSUITE_REPRODUCIBLE_ROOT="${SILENTSUITE_REPRODUCIBLE_ROOT:-'
        '$SILENTSUITE_CANONICAL_ROOT}"' in contract
    )
    assert f'SILENTSUITE_VIRTUAL_ROOT="{VIRTUAL_ROOT}"' in contract

    # `stable` moves; a release that used it could not be rebuilt a week later.
    executable = "\n".join(
        line for line in contract.splitlines() if not line.lstrip().startswith("#")
    )
    assert "rustup default stable" not in executable
    assert 'rustup toolchain install --profile minimal --no-self-update "$SILENTSUITE_RELEASE_RUST_TOOLCHAIN"' in contract

    # Every download that becomes compiler input is checksum-pinned.
    checksums = re.findall(r'SILENTSUITE_RELEASE_JDK_SHA256_[A-Z0-9]+="([0-9a-f]+)"', contract)
    assert len(checksums) == 2
    assert all(len(value) == 64 for value in checksums)
    assert "sha256sum --check --strict" in contract


def test_gradle_and_shell_contracts_pin_the_same_compiler():
    gradle = read(ROOT_GRADLE)

    assert f"ext.reproducibleJdkRelease = '{PINNED_JDK_RELEASE}'" in gradle
    assert f"ext.reproducibleJdkJavaVersion = '{PINNED_JDK_JAVA_VERSION}'" in gradle
    assert (
        f"ext.reproducibleJdkImplementorVersion = '{PINNED_JDK_IMPLEMENTOR_VERSION}'" in gradle
    )
    assert f"ext.reproducibleBuildRoot = '{CANONICAL_ROOT}'" in gradle


def test_release_java_compilation_forks_to_the_pinned_jdk_and_fails_closed():
    gradle = read(ROOT_GRADLE)

    # Bound to the compile task, not to the requested task name. `gradle build`,
    # `gradle assemble` and the abbreviation `aR` all reach the same
    # JavaCompile, and an external recipe may spell any of them.
    assert "tasks.withType(JavaCompile).configureEach { compileTask ->" in gradle
    assert "!compileTask.name.toLowerCase().contains('release')" in gradle
    assert "compileTask.options.fork = true" in gradle
    assert (
        "compileTask.options.forkOptions.javaHome = rootProject.ext.reproducibleJdkHome" in gradle
    )
    # Verified when a release class file is about to be compiled, so a missing
    # or wrong-vendor JDK fails the build rather than silently changing bytes.
    assert "compileTask.doFirst {" in gradle
    assert "verifyReproducibleJdk(rootProject.ext.reproducibleJdkHome)" in gradle
    assert 'throw new GradleException("Missing pinned release JDK' in gradle
    assert "IMPLEMENTOR_VERSION: rootProject.ext.reproducibleJdkImplementorVersion" in gradle
    assert "JAVA_VERSION: rootProject.ext.reproducibleJdkJavaVersion" in gradle
    # The superseded heuristic must not come back.
    assert "gradle.startParameter.taskNames" not in gradle


@pytest.mark.parametrize(
    "variable", ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CFLAGS", "CXXFLAGS", "JAVA_TOOL_OPTIONS"]
)
def test_ambient_toolchain_flags_fail_the_build_closed(variable: str):
    result = source_contract("ss_require_clean_toolchain_env", {variable: "-O0"})

    assert result.returncode != 0
    assert f"{variable} is set in the environment" in result.stderr


def test_a_clean_environment_passes_the_ambient_flag_check():
    result = source_contract("ss_require_clean_toolchain_env && echo clean")

    assert result.returncode == 0, result.stderr
    assert "clean" in result.stdout


def test_prefix_maps_are_emitted_most_specific_first():
    # Ordering is load-bearing and silent when wrong: clang keeps the first
    # matching -ffile-prefix-map, and on F-Droid's builder the NDK lives under
    # $HOME, so a $HOME rule matching first would rewrite NDK header paths onto
    # a different virtual prefix than a runner whose SDK sits in /usr/local.
    result = source_contract(
        'ss_prefix_map_pairs "/home/probe/android-sdk/ndk/28" "/home/probe/.cargo" '
        f'"{CANONICAL_ROOT}/etebase/etebase-java"'
    )

    assert result.returncode == 0, result.stderr
    real_paths = [line.split("=", 1)[0] for line in result.stdout.strip().splitlines()]
    assert real_paths == [
        f"{CANONICAL_ROOT}/etebase/etebase-java",
        "/home/probe/.cargo",
        "/home/probe/android-sdk/ndk/28",
        CANONICAL_ROOT,
        "/home/probe",
    ]
    # Every more specific path precedes any prefix of it.
    for index, path in enumerate(real_paths):
        for later in real_paths[index + 1 :]:
            assert not path.startswith(later + "/") or real_paths.index(later) > index


# ── Conscrypt: C/C++ source-path normalisation ───────────────────────────


def conscrypt_gradle_fixture(directory: Path, *, with_anchor: bool = True) -> Path:
    (directory / "build.gradle").write_text('version = "2.6-SNAPSHOT"\n', encoding="utf-8")
    android = directory / "android"
    android.mkdir()
    flags = "cFlags '-fvisibility=hidden'," if with_anchor else "cFlags '-DSOMETHING_ELSE',"
    (android / "build.gradle").write_text(
        "    androidNdkVersion = '27.3.13750724'\n"
        "    externalNativeBuild {\n"
        "        cmake {\n"
        "            arguments '-DCMAKE_SHARED_LINKER_FLAGS=-z max-page-size=16384 "
        "-z common-page-size=16384'\n"
        f"                {flags}\n"
        "        }\n"
        "    }\n",
        encoding="utf-8",
    )
    return android / "build.gradle"


def test_conscrypt_build_injects_file_prefix_maps_into_c_and_cxx_flags(tmp_path: Path):
    patch = block_containing(read(CONSCRYPT_SCRIPT), "cFlags '-fvisibility=hidden',")
    android_gradle = conscrypt_gradle_fixture(tmp_path)

    result = run_block(
        patch,
        str(tmp_path),
        "2.6.3",
        "28.2.13676358",
        f"{CANONICAL_ROOT}={VIRTUAL_ROOT}",
        f"/opt/ndk={VIRTUAL_ROOT}/ndk",
    )

    assert result.returncode == 0, result.stderr
    patched = android_gradle.read_text(encoding="utf-8")
    # Both languages: conscrypt_jni is C++ and BoringSSL is mostly C, and only
    # the C flags existed upstream.
    assert f"cppFlags '-ffile-prefix-map={CANONICAL_ROOT}={VIRTUAL_ROOT}'" in patched
    assert f"cFlags '-ffile-prefix-map={CANONICAL_ROOT}={VIRTUAL_ROOT}'" in patched
    assert f"-ffile-prefix-map=/opt/ndk={VIRTUAL_ROOT}/ndk" in patched
    assert "'-fvisibility=hidden'," in patched
    assert "androidNdkVersion = '28.2.13676358'" in patched


def test_conscrypt_build_fails_closed_when_the_upstream_flag_anchor_moves(tmp_path: Path):
    patch = block_containing(read(CONSCRYPT_SCRIPT), "cFlags '-fvisibility=hidden',")
    conscrypt_gradle_fixture(tmp_path, with_anchor=False)

    result = run_block(
        patch, str(tmp_path), "2.6.3", "28.2.13676358", f"{CANONICAL_ROOT}={VIRTUAL_ROOT}"
    )

    assert result.returncode != 0
    assert "expected exactly one upstream flag declaration" in result.stderr


def test_conscrypt_build_fails_closed_without_any_prefix_map(tmp_path: Path):
    patch = block_containing(read(CONSCRYPT_SCRIPT), "cFlags '-fvisibility=hidden',")
    conscrypt_gradle_fixture(tmp_path)

    result = run_block(patch, str(tmp_path), "2.6.3", "28.2.13676358")

    assert result.returncode != 0
    assert "produced no prefix maps" in result.stderr


def make_aar(path: Path, payloads: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in payloads.items():
            archive.writestr(name, data)
    return path


def test_conscrypt_leak_scan_rejects_a_library_that_names_the_build_machine(tmp_path: Path):
    scan = block_containing(read(CONSCRYPT_SCRIPT), "embed host-specific build paths")
    aar = make_aar(
        tmp_path / "leaky.aar",
        {"jni/arm64-v8a/libconscrypt_jni.so": b"\x7fELF/home/runner/work/boringssl/crypto/x.c"},
    )

    result = run_block(scan, str(aar), VIRTUAL_ROOT, CANONICAL_ROOT, "/opt/ndk", "/home/runner")

    assert result.returncode != 0
    assert "embed host-specific build paths" in result.stderr
    assert "/home/runner" in result.stderr


def test_conscrypt_leak_scan_requires_proof_the_prefix_map_took_effect(tmp_path: Path):
    scan = block_containing(read(CONSCRYPT_SCRIPT), "embed host-specific build paths")
    aar = make_aar(
        tmp_path / "unmapped.aar",
        {"jni/arm64-v8a/libconscrypt_jni.so": b"\x7fELF no source paths at all"},
    )

    result = run_block(scan, str(aar), VIRTUAL_ROOT, CANONICAL_ROOT, "/opt/ndk", "/home/runner")

    assert result.returncode != 0
    assert "-ffile-prefix-map did not reach the native compile" in result.stderr


def test_conscrypt_leak_scan_accepts_a_fully_normalised_library(tmp_path: Path):
    scan = block_containing(read(CONSCRYPT_SCRIPT), "embed host-specific build paths")
    aar = make_aar(
        tmp_path / "clean.aar",
        {
            "jni/arm64-v8a/libconscrypt_jni.so": (
                f"\x7fELF{VIRTUAL_ROOT}/boringssl/crypto/x.c".encode()
            )
        },
    )

    result = run_block(scan, str(aar), VIRTUAL_ROOT, CANONICAL_ROOT, "/opt/ndk", "/home/runner")

    assert result.returncode == 0, result.stderr
    assert "Normalised source paths" in result.stdout


def test_conscrypt_build_runs_under_the_pinned_toolchain_and_canonical_root():
    script = read(CONSCRYPT_SCRIPT)

    assert 'source "$SCRIPT_DIR/reproducible-build-contract.sh"' in script
    assert "ss_require_clean_toolchain_env" in script
    assert 'workspace="$(ss_reproducible_workspace conscrypt)"' in script
    assert 'JAVA_HOME="$(ss_provision_release_jdk)"' in script
    # The pre-normalisation script derived its workspace from the runner's
    # temporary directory, which is exactly the path that differed.
    assert "RUNNER_TEMP" not in script


# ── Etebase: Rust/Cargo path and toolchain normalisation ─────────────────


def test_etebase_build_pins_the_rust_toolchain_and_remaps_every_host_path():
    script = read(ETEBASE_SCRIPT)

    assert 'source "$SCRIPT_DIR/reproducible-build-contract.sh"' in script
    assert "ss_require_clean_toolchain_env" in script
    assert 'ss_provision_rust_toolchain "${TARGETS[@]}"' in script
    assert 'cargo "+$SILENTSUITE_RELEASE_RUST_TOOLCHAIN" build --target "$target" --release --locked' in script
    assert "cargo build --target" not in script

    # ThinLTO hashes real object-file paths into module identifiers, and no
    # flag rewrites those, so the build root itself has to be canonical.
    assert 'BUILD_DIR="$(ss_reproducible_workspace etebase)"' in script
    assert "RUNNER_TEMP" not in script

    assert 'export CARGO_ENCODED_RUSTFLAGS="$encoded"' in script
    assert "--remap-path-prefix=${PREFIX_MAPS[$index]}" in script
    assert "-ffile-prefix-map=$pair" in script
    assert 'ss_prefix_map_pairs "$NDK_DIR" "$CARGO_HOME" "$ETEBASE_SOURCE"' in script
    # The cc crate reads the hyphenated target spelling, which is not a shell
    # identifier and therefore cannot be `export`ed.
    assert '"CFLAGS_$target=${CC_PREFIX_FLAGS[*]}"' in script
    assert '"TARGET_CFLAGS=${CC_PREFIX_FLAGS[*]}"' in script


def test_etebase_rustflags_are_reversed_because_rustc_keeps_the_last_match():
    script = read(ETEBASE_SCRIPT)
    reversal = "for (( index = ${#PREFIX_MAPS[@]} - 1; index >= 0; index-- )); do"

    assert reversal in script
    # clang keeps the first match, so its list must not be reversed.
    clang_loop = script.index('CC_PREFIX_FLAGS+=("-ffile-prefix-map=$pair")')
    assert clang_loop < script.index(reversal)


def test_etebase_leak_scan_rejects_cargo_home_and_accepts_normalised_paths(tmp_path: Path):
    scan = block_containing(read(ETEBASE_SCRIPT), "embed host-specific build paths")
    native = tmp_path / "jni" / "arm64-v8a"
    native.mkdir(parents=True)
    library = native / "libetebase_android.so"

    library.write_bytes(b"\x7fELF/home/vagrant/.cargo/registry/src/crate/lib.rs")
    leaked = run_block(
        scan, str(tmp_path), VIRTUAL_ROOT, "/home/vagrant/.cargo", "/opt/ndk",
        CANONICAL_ROOT, "/home/vagrant",
    )
    assert leaked.returncode != 0
    assert "/home/vagrant/.cargo" in leaked.stderr

    library.write_bytes(f"\x7fELF{VIRTUAL_ROOT}/cargo/registry/src/crate/lib.rs".encode())
    clean = run_block(
        scan, str(tmp_path), VIRTUAL_ROOT, "/home/vagrant/.cargo", "/opt/ndk",
        CANONICAL_ROOT, "/home/vagrant",
    )
    assert clean.returncode == 0, clean.stderr


# ── the byte comparison itself ───────────────────────────────────────────


def build_apk(path: Path, entries: list[tuple[str, bytes]]) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return path


BASE_ENTRIES = [
    ("AndroidManifest.xml", b"manifest"),
    ("classes.dex", b"dex-payload"),
    ("lib/arm64-v8a/libetebase_android.so", b"\x7fELFetebase"),
]


def compare_apks(reference: Path, candidate: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(COMPARISON), "--reference", str(reference), "--candidate", str(candidate)],
        capture_output=True,
        text=True,
        check=False,
    )


def test_identical_builds_satisfy_the_comparison_contract(tmp_path: Path):
    reference = build_apk(tmp_path / "a.apk", BASE_ENTRIES)
    candidate = build_apk(tmp_path / "b.apk", BASE_ENTRIES)

    result = compare_apks(reference, candidate)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "3/3 matched" in result.stdout


def test_a_single_differing_entry_fails_the_comparison_and_is_named(tmp_path: Path):
    # This is the 0.5.4-beta failure in miniature: everything matched except
    # classes.dex, and "everything else matched" is still a failed publication.
    reference = build_apk(tmp_path / "a.apk", BASE_ENTRIES)
    divergent = [(name, data + b"!" if name == "classes.dex" else data) for name, data in BASE_ENTRIES]
    candidate = build_apk(tmp_path / "b.apk", divergent)

    result = compare_apks(reference, candidate)

    assert result.returncode == 1
    assert "2/3 matched" in result.stdout
    assert "classes.dex" in result.stdout


def test_comparison_excludes_signature_material_like_apksigcopier(tmp_path: Path):
    signed = build_apk(
        tmp_path / "signed.apk",
        BASE_ENTRIES
        + [
            ("META-INF/MANIFEST.MF", b"manifest-digest"),
            ("META-INF/CERT.SF", b"signature-file"),
            ("META-INF/CERT.RSA", b"pkcs7"),
        ],
    )
    unsigned = build_apk(tmp_path / "unsigned.apk", BASE_ENTRIES)

    result = compare_apks(signed, unsigned)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "3/3 matched" in result.stdout


def test_comparison_recognises_a_v2_only_signing_block(tmp_path: Path):
    # A v2/v3-signed APK carries no META-INF signature entry. Missing that
    # would leave the whole-file digest compared across a signing block the
    # rebuild cannot contain, failing a byte-identical pair.
    reference = build_apk(tmp_path / "v2.apk", BASE_ENTRIES)
    reference.write_bytes(reference.read_bytes() + b"APK Sig Block 42")
    candidate = build_apk(tmp_path / "unsigned.apk", BASE_ENTRIES)

    result = compare_apks(reference, candidate)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "3/3 matched" in result.stdout


def test_comparison_requires_container_equality_between_two_unsigned_builds(tmp_path: Path):
    reference = build_apk(tmp_path / "a.apk", BASE_ENTRIES)
    candidate = build_apk(tmp_path / "b.apk", list(reversed(BASE_ENTRIES)))

    result = compare_apks(reference, candidate)

    assert result.returncode == 1
    assert "archive entry order differs" in result.stdout


# ── the pre-signing gate ─────────────────────────────────────────────────


def test_independent_rebuild_runs_in_a_different_pinned_environment():
    job = workflow(RELEASE_WORKFLOW)["jobs"][REBUILD_JOB]

    assert job["permissions"] == {"contents": "read"}
    assert "environment" not in job
    image = job["container"]["image"]
    assert image.startswith("debian:bookworm-slim@sha256:")
    assert re.search(r"@sha256:[0-9a-f]{64}$", image)

    # Different distribution, different HOME, different CARGO_HOME, and Gradle
    # running on Debian's OpenJDK rather than the pinned compiler — the axes
    # the contract has to survive.
    assert job["env"]["CARGO_HOME"] == "/opt/rust/cargo"
    assert job["env"]["ANDROID_HOME"] == "/opt/android-sdk"
    assert job["env"]["JAVA_HOME"] == "/usr/lib/jvm/java-17-openjdk-amd64"

    body = yaml.safe_dump(job)
    # `yes | sdkmanager` returns 141 under pipefail once sdkmanager stops
    # reading, which would fail this job on essentially every run.
    executed = "\n".join(
        line
        for step in job["steps"]
        for line in str(step.get("run", "")).splitlines()
        if not line.lstrip().startswith("#")
    )
    assert "yes |" not in executed
    assert "< /tmp/sdk-license-acceptance" in executed
    assert "scripts/reproducible-build-contract.sh provision-jdk" in body
    assert "scripts/build-conscrypt-android-r28.sh" in body
    assert "scripts/build-etebase-client-16kb.sh" in body
    assert "-PrequireReproducibleJdk=true" in body
    # Consuming the release lane's Conscrypt artifact would import the very
    # bytes this job exists to reproduce independently.
    assert "conscrypt-r28-${{ inputs.source_sha }}" not in body
    assert "silentsuite-android-fdroid-rebuild-${{ inputs.source_sha }}" in body


def test_gate_compares_two_independent_builds_and_blocks_signing():
    jobs = workflow(RELEASE_WORKFLOW)["jobs"]
    gate = jobs[GATE_JOB]

    assert gate["permissions"] == {"contents": "read"}
    assert gate["needs"] == ["build-unsigned-release", REBUILD_JOB]

    gate_steps = steps(gate)
    assert (
        gate_steps["Download the release lane's unsigned build"]["with"]["name"]
        == "silentsuite-android-unsigned-${{ inputs.source_sha }}"
    )
    assert (
        gate_steps["Download the independent rebuild"]["with"]["name"]
        == "silentsuite-android-fdroid-rebuild-${{ inputs.source_sha }}"
    )
    comparison = gate_steps["Compare both builds under the F-Droid byte contract"]["run"]
    # Out of the trusted checkout: the check that decides whether a release may
    # be signed must not be defined by the tree being released.
    assert '"$GITHUB_WORKSPACE/scripts/verify-android-build-reproducibility.py"' in comparison
    assert "--reference" in comparison and "--candidate" in comparison
    assert (
        gate_steps["Check out the trusted controller revision"]["with"]["ref"] == "${{ github.sha }}"
    )

    assert GATE_JOB in jobs["sign-release"]["needs"]


def test_release_and_ci_release_assemblies_use_the_pinned_compiler():
    release_steps = steps(workflow(RELEASE_WORKFLOW)["jobs"]["build-unsigned-release"])
    assert (
        release_steps["Provision the pinned reproducible JDK"]["run"].strip()
        == "scripts/reproducible-build-contract.sh provision-jdk"
    )
    assert "-PrequireReproducibleJdk=true" in release_steps["Build the unsigned release APK and AAB"]["run"]

    ci_steps = steps(workflow(CI_WORKFLOW)["jobs"]["build-pr"])
    assert (
        ci_steps["Provision the pinned reproducible JDK"]["run"].strip()
        == "scripts/reproducible-build-contract.sh provision-jdk"
    )
    assert "-PrequireReproducibleJdk=true" in ci_steps["Build debug APK and unsigned release APK/AAB"]["run"]


# ── the gate cannot be softened without failing the policy check ─────────


def reviewed_jobs() -> dict:
    checker = load_boundary_checker()
    return checker, checker.load_workflow(RELEASE_WORKFLOW)["jobs"]


def test_signing_boundary_accepts_the_reviewed_reproducibility_contract():
    checker, jobs = reviewed_jobs()
    violations: list[str] = []

    checker.check_reproducibility_contract(jobs, violations)

    assert violations == []


def test_signing_boundary_rejects_a_rebuild_that_is_not_an_independent_environment():
    checker, jobs = reviewed_jobs()
    jobs = dict(jobs)
    jobs[REBUILD_JOB] = {k: v for k, v in jobs[REBUILD_JOB].items() if k != "container"}
    violations: list[str] = []

    checker.check_reproducibility_contract(jobs, violations)

    assert any("self-comparison" in violation for violation in violations)


def test_signing_boundary_rejects_a_rebuild_that_reuses_the_release_conscrypt_artifact():
    checker, jobs = reviewed_jobs()
    jobs = dict(jobs)
    rebuild = dict(jobs[REBUILD_JOB])
    rebuild["steps"] = list(rebuild["steps"]) + [
        {"name": "Shortcut", "run": "echo conscrypt-r28-${{ inputs.source_sha }}"}
    ]
    jobs[REBUILD_JOB] = rebuild
    violations: list[str] = []

    checker.check_reproducibility_contract(jobs, violations)

    assert any("must build Conscrypt itself" in violation for violation in violations)


def test_signing_boundary_rejects_a_gate_that_compares_a_build_with_itself():
    checker, jobs = reviewed_jobs()
    jobs = dict(jobs)
    gate = dict(jobs[GATE_JOB])
    gate["needs"] = ["build-unsigned-release", "build-unsigned-release"]
    jobs[GATE_JOB] = gate
    violations: list[str] = []

    checker.check_reproducibility_contract(jobs, violations)

    assert any("must compare exactly" in violation for violation in violations)


# ── the dispatch-only drill that rehearses the gate ──────────────────────


DRILL_WORKFLOW = ROOT / ".github/workflows/android-reproducibility-drill.yml"


def drill_state():
    checker = load_boundary_checker()
    loaded = {
        checker.ROOT_WORKFLOW: checker.load_workflow(RELEASE_WORKFLOW),
        checker.DRILL_WORKFLOW: checker.load_workflow(DRILL_WORKFLOW),
    }
    return checker, loaded


def drill_violations(mutate=None) -> list[str]:
    checker, loaded = drill_state()
    if mutate is not None:
        mutate(loaded[checker.DRILL_WORKFLOW])
    violations: list[str] = []
    checker.check_reproducibility_drill(loaded, violations)
    return violations


def test_drill_is_dispatch_only_and_bound_to_an_exact_commit():
    drill = workflow(DRILL_WORKFLOW)
    events = drill[True] if True in drill else drill["on"]

    # push/pull_request would run a three-hour container build on every change;
    # workflow_call or repository_dispatch would make this a second entry point
    # into release-shaped work.
    assert set(events) == {"workflow_dispatch"}
    source = events["workflow_dispatch"]["inputs"]["source_sha"]
    assert source["required"] is True
    assert "default" not in source

    validate = steps(drill["jobs"]["validate-source"])["Require an exact commit"]
    assert validate["env"] == {"SOURCE_SHA": "${{ inputs.source_sha }}"}
    assert '[ "${#SOURCE_SHA}" -eq 40 ]' in validate["run"]


def test_drill_holds_no_signing_capability_and_no_write():
    drill = workflow(DRILL_WORKFLOW)

    assert drill["permissions"] == {}
    for name, job in drill["jobs"].items():
        assert job["permissions"] == {"contents": "read"}, name
        assert "environment" not in job, name

    body = read(DRILL_WORKFLOW)
    assert "secrets." not in body
    assert "ANDROID_KEYSTORE" not in body
    assert "android-release" not in body
    assert "contents: write" not in body


def test_drill_artifacts_cannot_be_confused_with_a_release_run():
    body = read(DRILL_WORKFLOW)

    assert "silentsuite-android-drill-ubuntu-${{ inputs.source_sha }}" in body
    assert "silentsuite-android-drill-rebuild-${{ inputs.source_sha }}" in body
    assert "silentsuite-android-unsigned-${{ inputs.source_sha }}" not in body
    assert "silentsuite-android-fdroid-rebuild-${{ inputs.source_sha }}" not in body


def test_drill_rebuild_steps_are_byte_identical_to_the_release_lane():
    checker, loaded = drill_state()
    release = loaded[checker.ROOT_WORKFLOW]["jobs"][REBUILD_JOB]
    drill = loaded[checker.DRILL_WORKFLOW]["jobs"][REBUILD_JOB]

    assert drill["container"] == release["container"]
    assert drill["env"] == release["env"]

    release_steps = {str(s.get("name")): s for s in release["steps"]}
    drill_steps = {str(s.get("name")): s for s in drill["steps"]}
    for name in checker.DRILL_SHARED_REBUILD_STEPS:
        assert drill_steps[name] == release_steps[name], name


def test_drill_comparison_runs_the_trusted_verifier_on_both_builds():
    drill = workflow(DRILL_WORKFLOW)
    comparison = drill["jobs"]["drill-comparison"]

    assert comparison["needs"] == ["build-unsigned-ubuntu", REBUILD_JOB]
    comparison_steps = steps(comparison)
    assert (
        comparison_steps["Check out the dispatched revision"]["with"]["ref"] == "${{ github.sha }}"
    )
    run = comparison_steps["Compare both builds under the F-Droid byte contract"]["run"]
    assert '"$GITHUB_WORKSPACE/scripts/verify-android-build-reproducibility.py"' in run
    assert "ubuntu-build/app-release-unsigned.apk" in run
    assert "fdroid-rebuild/app-release-unsigned.apk" in run


def test_signing_boundary_accepts_the_reviewed_drill():
    assert drill_violations() == []


@pytest.mark.parametrize(
    ("mutation", "expected"),
    [
        (
            lambda drill: drill["on"].update({"pull_request": None}),
            "must be reachable only by workflow_dispatch",
        ),
        (
            lambda drill: drill["on"]["workflow_dispatch"]["inputs"]["source_sha"].update(
                {"required": "false"}
            ),
            "source_sha must be required",
        ),
        (
            lambda drill: drill["jobs"]["drill-comparison"].update(
                {"permissions": {"contents": "write"}}
            ),
            "permissions must be exactly contents: read",
        ),
        (
            lambda drill: drill["jobs"]["build-unsigned-ubuntu"]["steps"].append(
                {"name": "Leak", "run": "echo ${{ secrets.ANDROID_KEYSTORE_BASE64 }}"}
            ),
            "must never reference Android signing secrets",
        ),
        (
            lambda drill: drill["jobs"]["drill-comparison"]["steps"].append(
                {"name": "Reuse", "run": "echo silentsuite-android-unsigned-${{ inputs.source_sha }}"}
            ),
            "must not produce or consume the release lane artifact",
        ),
        (
            lambda drill: drill["jobs"][REBUILD_JOB]["steps"].__setitem__(
                0, {"name": "Install the Debian build environment", "run": "apt-get install -y curl"}
            ),
            "has drifted from the release lane's",
        ),
        (
            lambda drill: drill["jobs"]["build-unsigned-ubuntu"].update(
                {"environment": "android-release"}
            ),
            "must not bind a deployment environment",
        ),
    ],
    ids=(
        "extra-trigger",
        "optional-source",
        "write-permission",
        "signing-secret",
        "release-artifact",
        "drifted-step",
        "protected-environment",
    ),
)
def test_signing_boundary_fails_closed_on_a_weakened_drill(mutation, expected):
    violations = drill_violations(mutation)

    assert any(expected in violation for violation in violations), violations


def test_release_lane_stays_workflow_call_only():
    release = workflow(RELEASE_WORKFLOW)
    events = release[True] if True in release else release["on"]

    # The drill exists so this never has to gain a dispatch trigger.
    assert set(events) == {"workflow_call"}


def test_signing_boundary_pins_the_comparison_helper_bytes():
    checker = load_boundary_checker()

    assert "verify-android-build-reproducibility.py" in checker.TRUSTED_HELPERS
    assert (
        checker.EXPECTED_REPRODUCIBILITY_HELPER_SHA256
        == hashlib.sha256(COMPARISON.read_bytes()).hexdigest()
    )


def test_signing_boundary_still_passes_end_to_end():
    checker = load_boundary_checker()

    assert checker.check(ROOT) == []
