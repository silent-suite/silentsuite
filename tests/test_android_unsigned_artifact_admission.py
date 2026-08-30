"""Behavioural contract for the candidate/trusted artifact boundary.

The signing job runs on a fresh runner and never checks out or executes
candidate code. What it does consume is candidate *data*: an APK, an AAB and
their evidence, produced by candidate Gradle on a different machine. This is
the only thing that crosses, so every case here hands
`scripts/admit-unsigned-android-artifact.sh` a real directory in a real
adversarial shape and asserts it refuses before the keystore would be decoded.

The static half additionally pins how `scripts/sign-android-release.sh` reaches
its tools: by absolute path under a verified root, never through PATH, because
PATH is exactly what a compromised producer would aim at if it could.
"""

from __future__ import annotations

import hashlib
import os
import re
import shlex
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
ADMIT = ROOT / "scripts" / "admit-unsigned-android-artifact.sh"
SIGNER = ROOT / "scripts" / "sign-android-release.sh"
ANDROID_RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release-android.yml"

SOURCE_SHA = "a" * 40
OTHER_SHA = "b" * 40

PAYLOAD = {
    "app-release-unsigned.apk": b"unsigned-apk-bytes",
    "app-release.aab": b"unsigned-aab-bytes",
    "mapping.txt": b"com.example -> a:\n",
    "native-debug-symbols.zip": b"symbols-zip-bytes",
    "release-runtime-dependencies.txt": b"+--- androidx.core:core\n",
    "tracker-scan-summary.json": b'{"trackers": []}\n',
}


def build_artifact(directory: Path, *, payload: dict[str, bytes] | None = None,
                   source_sha: str = SOURCE_SHA, checksums: str | None = None) -> Path:
    """A well-formed producer handoff, which each case then damages."""

    payload = PAYLOAD if payload is None else payload
    directory.mkdir(parents=True, exist_ok=True)
    for name, data in payload.items():
        (directory / name).write_bytes(data)
        (directory / name).chmod(0o644)
    (directory / "source-sha").write_text(f"{source_sha}\n", encoding="utf-8")
    if checksums is None:
        checksums = "".join(
            f"{hashlib.sha256(data).hexdigest()}  {name}\n"
            for name, data in payload.items()
        )
    (directory / "SHA256SUMS").write_text(checksums, encoding="utf-8")
    (directory / "SHA256SUMS").chmod(0o644)
    (directory / "source-sha").chmod(0o644)
    return directory


def admit(directory: Path, *, source_sha: str = SOURCE_SHA) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(ADMIT), "--directory", str(directory), "--source-sha", source_sha],
        capture_output=True,
        text=True,
        env={**os.environ},
    )


@pytest.fixture
def artifact(tmp_path: Path) -> Path:
    return build_artifact(tmp_path / "unsigned")


# ── The one shape that is admitted ────────────────────────────────────


def test_a_well_formed_handoff_is_admitted(artifact: Path):
    result = admit(artifact)

    assert result.returncode == 0, result.stderr
    assert f"Unsigned build admitted for {SOURCE_SHA}" in result.stdout
    assert "6 payload files" in result.stdout


# ── Substitution and confusion ────────────────────────────────────────


def test_a_handoff_built_from_another_commit_is_refused(tmp_path: Path):
    directory = build_artifact(tmp_path / "unsigned", source_sha=OTHER_SHA)

    result = admit(directory)

    assert result.returncode != 0
    assert f"records source {OTHER_SHA}, not the admitted {SOURCE_SHA}" in result.stderr


@pytest.mark.parametrize("missing", sorted(PAYLOAD))
def test_a_missing_payload_file_is_refused(tmp_path: Path, missing: str):
    directory = build_artifact(tmp_path / "unsigned")
    (directory / missing).unlink()

    result = admit(directory)

    assert result.returncode != 0
    assert "is not the closed inventory" in result.stderr


def test_an_unexpected_extra_file_is_refused(artifact: Path):
    (artifact / "surprise.sh").write_text("#!/bin/sh\n", encoding="utf-8")

    result = admit(artifact)

    assert result.returncode != 0
    assert "is not the closed inventory" in result.stderr
    assert "surprise.sh" in result.stderr


def test_a_nested_directory_is_refused(artifact: Path):
    """`find -mindepth 1` sees the whole tree, not just its top level."""

    (artifact / "nested").mkdir()
    (artifact / "nested" / "payload.so").write_bytes(b"x")

    result = admit(artifact)

    assert result.returncode != 0
    assert "is not the closed inventory" in result.stderr


def test_a_symlinked_payload_is_refused(artifact: Path):
    """A link would let a later read escape the artifact directory."""

    target = artifact.parent / "outside.apk"
    target.write_bytes(b"outside")
    (artifact / "app-release-unsigned.apk").unlink()
    (artifact / "app-release-unsigned.apk").symlink_to(target)

    result = admit(artifact)

    assert result.returncode != 0
    assert "is a symbolic link" in result.stderr


def test_an_executable_payload_is_refused(artifact: Path):
    """Nothing here is meant to run, so nothing here may be executable."""

    (artifact / "mapping.txt").chmod(0o755)

    result = admit(artifact)

    assert result.returncode != 0
    assert "expected exactly 644" in result.stderr


@pytest.mark.parametrize("mode", [0o600, 0o640, 0o664, 0o755])
def test_every_noncanonical_input_mode_is_refused(artifact: Path, mode: int):
    target = artifact / "mapping.txt"
    target.chmod(mode)

    result = admit(artifact)

    assert result.returncode != 0
    assert "expected exactly 644" in result.stderr


@pytest.mark.parametrize("empty", sorted(PAYLOAD))
def test_an_empty_payload_file_is_refused(tmp_path: Path, empty: str):
    payload = dict(PAYLOAD)
    payload[empty] = b""
    directory = build_artifact(tmp_path / "unsigned", payload=payload)

    result = admit(directory)

    assert result.returncode != 0
    assert "is empty" in result.stderr


# ── Checksum integrity ────────────────────────────────────────────────


def test_a_tampered_payload_is_refused(artifact: Path):
    (artifact / "app-release.aab").write_bytes(b"swapped-aab-bytes")

    result = admit(artifact)

    assert result.returncode != 0
    assert "do not match the checksums the producer recorded" in result.stderr


def test_a_manifest_that_omits_a_payload_file_is_refused(tmp_path: Path):
    partial = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n"
        for name, data in PAYLOAD.items()
        if name != "mapping.txt"
    )
    directory = build_artifact(tmp_path / "unsigned", checksums=partial)

    result = admit(directory)

    assert result.returncode != 0
    assert "does not cover exactly the payload files" in result.stderr


def test_a_manifest_naming_a_file_outside_the_inventory_is_refused(tmp_path: Path):
    extra = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in PAYLOAD.items()
    ) + f"{'0' * 64}  ../escape.apk\n"
    directory = build_artifact(tmp_path / "unsigned", checksums=extra)

    result = admit(directory)

    assert result.returncode != 0
    assert "does not cover exactly the payload files" in result.stderr


def test_a_manifest_with_duplicate_records_is_refused(tmp_path: Path):
    doubled = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in PAYLOAD.items()
    )
    doubled += f"{hashlib.sha256(PAYLOAD['mapping.txt']).hexdigest()}  mapping.txt\n"
    directory = build_artifact(tmp_path / "unsigned", checksums=doubled)

    result = admit(directory)

    assert result.returncode != 0
    # A repeated record makes the manifest's name list differ from the payload's,
    # so it is caught by the coverage comparison before the record-count check.
    assert "SHA256SUMS" in result.stderr
    assert "Refusing the unsigned build" in result.stderr


def test_a_missing_directory_is_refused(tmp_path: Path):
    result = admit(tmp_path / "absent")

    assert result.returncode != 0
    assert "does not exist" in result.stderr


@pytest.mark.parametrize("sha", ["", "abc", "A" * 40, "g" * 40, "a" * 39])
def test_a_malformed_admitted_sha_is_refused(artifact: Path, sha: str):
    result = admit(artifact, source_sha=sha)

    assert result.returncode != 0
    assert "40-hex commit id" in result.stderr or "required" in result.stderr


# ── The signing helper's tool resolution ──────────────────────────────


def executable_text(path: Path) -> str:
    return "\n".join(
        line for line in path.read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("#")
    )


def test_the_signer_resolves_every_tool_by_absolute_path():
    """A poisoned producer cannot reach a job it never shares, but the signer
    still refuses to take a tool from PATH — the boundary is stated in code."""

    code = executable_text(SIGNER)
    for fixed in (
        'BUILD_TOOLS="${ANDROID_HOME}/build-tools/${BUILD_TOOLS_VERSION}"',
        'ZIPALIGN="${BUILD_TOOLS}/zipalign"',
        'APKSIGNER="${BUILD_TOOLS}/apksigner"',
        'JARSIGNER="${JAVA_HOME}/bin/jarsigner"',
        'KEYTOOL="${JAVA_HOME}/bin/keytool"',
    ):
        assert fixed in code, fixed
    assert "$(command -v" not in code, "no tool may be resolved through PATH"
    # setup-java may expose in-root symlinks. Canonical containment accepts
    # those while rejecting a link that escapes either trusted root.
    assert 'canonical="$(readlink -f -- "$tool")"' in code
    assert '"$root"/*)' in code
    assert "resolves outside its trusted root" in code


def test_the_signer_keeps_the_password_out_of_every_argument_vector():
    code = executable_text(SIGNER)
    assert '--ks-pass "env:KSTOREPWD"' in code
    assert '--key-pass "env:KSTOREPWD"' in code
    assert "-storepass:env KSTOREPWD" in code
    assert "-storepass " not in code, "a literal password argument would land in `ps`"
    # bundletool has no env form, so the file is private and removed.
    assert 'umask 077; printf \'%s\' "$KSTOREPWD" > "$PASSWORD_FILE"' in code
    assert 'rm -f "$PASSWORD_FILE"' in code


def test_the_signer_aligns_before_it_signs():
    """zipalign after apksigner would invalidate the signature it just made."""

    code = executable_text(SIGNER)
    assert '"$ZIPALIGN" -p' not in code
    assert '"$ZIPALIGN" -c -p' not in code
    align = code.index('"$ZIPALIGN" -P 16 -f 4')
    sign = code.index('"$APKSIGNER" sign')
    assert align < sign
    assert '"$ZIPALIGN" -c -P 16 4' in code, "the alignment must be verified, not assumed"


def test_the_signer_proves_the_pinned_certificate_on_both_outputs():
    code = executable_text(SIGNER)
    assert "8035a4ff1511e2045c579c905d26e93af6009b239e741ef78542ae04e7a7ca79" in code
    assert 'require_pinned_certificate "APK"' in code
    assert 'require_pinned_certificate "AAB"' in code
    assert '"$APKSIGNER" verify --print-certs' in code
    assert "-printcert -jarfile" in code
    assert '"$JARSIGNER" -verify -strict' in code
    assert '-keystore "$KEYSTORE_PATH" -storepass:env KSTOREPWD' in code
    assert "grep -Fxq 'jar verified.' \"$JARSIGNER_VERIFY_LOG\"" in code
    assert '"$JARSIGNER" -verify "$SIGNED_AAB"' not in code
    assert "failed cryptographic integrity verification" in code
    assert 'head -c 4096 "$JARSIGNER_VERIFY_LOG"' in code
    assert "-J-Duser.language=en" in code, "keytool labels must not be locale-dependent"


def test_the_signer_validates_its_inputs_before_using_them():
    code = executable_text(SIGNER)
    assert "^[0-9a-f]{64}$" in code, "the expected fingerprint is validated"
    assert "^[0-9]+\\.[0-9]+\\.[0-9]+$" in code, "the build-tools version is validated"
    assert "EXPECTED_CERT_SHA256:-" not in code, (
        "an ambient variable must not relax the pinned certificate"
    )


def signer_preflight(tmp_path: Path, *, escaping_zipalign: bool = False):
    android_home = tmp_path / "android-sdk"
    build_tools = android_home / "build-tools" / "36.0.0"
    java_home = tmp_path / "jdk"
    build_tools.mkdir(parents=True)
    (java_home / "bin").mkdir(parents=True)

    for directory, names in (
        (build_tools, ("zipalign.real", "apksigner")),
        (java_home / "bin", ("jarsigner.real", "keytool", "java")),
    ):
        for name in names:
            path = directory / name
            path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            path.chmod(0o755)
    (build_tools / "zipalign").symlink_to(
        "/bin/true" if escaping_zipalign else "zipalign.real"
    )
    (java_home / "bin" / "jarsigner").symlink_to("jarsigner.real")
    bundletool = tmp_path / "bundletool.jar"
    bundletool.write_bytes(b"pinned test placeholder")

    return subprocess.run(
        ["bash", str(SIGNER)],
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "ANDROID_HOME": str(android_home),
            "JAVA_HOME": str(java_home),
            "UNSIGNED_DIR": str(tmp_path / "unsigned"),
            "OUTPUT_DIR": str(tmp_path / "signed"),
            "KEYSTORE_PATH": str(tmp_path / "release.jks"),
            "KSTOREPWD": "test-password",
            "KEY_ALIAS": "test-alias",
            "BUNDLETOOL_JAR": str(bundletool),
        },
    )


def test_in_root_tool_symlinks_are_accepted(tmp_path: Path):
    result = signer_preflight(tmp_path)
    assert result.returncode != 0
    assert "admitted input app-release-unsigned.apk is missing" in result.stderr
    assert "resolves outside its trusted root" not in result.stderr


def test_a_tool_symlink_escaping_its_fixed_root_is_rejected(tmp_path: Path):
    result = signer_preflight(tmp_path, escaping_zipalign=True)
    assert result.returncode != 0
    assert "zipalign resolves outside its trusted root" in result.stderr


def jdk_signing_fixture(tmp_path: Path, *, mode: str, expected: str | None = None):
    """Exercise the AAB checks with real JDK signing tools and inert SDK peers."""

    java = shutil.which("java")
    keytool_real = shutil.which("keytool")
    jarsigner_real = shutil.which("jarsigner")
    if not all((java, keytool_real, jarsigner_real)):
        pytest.skip("local JDK signing tools are unavailable")

    java_home = tmp_path / "jdk"
    bin_dir = java_home / "bin"
    bin_dir.mkdir(parents=True)
    argv_log = tmp_path / "jarsigner.argv"
    tamper_script = tmp_path / "tamper-signed-entry.py"
    tamper_script.write_text(
        "from pathlib import Path\n"
        "import os\n"
        "path = Path(os.environ['TAMPER_AAB'])\n"
        "data = bytearray(path.read_bytes())\n"
        "marker = b'minimal signed-entry fixture'\n"
        "offset = data.index(marker)\n"
        "data[offset] ^= 1\n"
        "path.write_bytes(data)\n",
        encoding="utf-8",
    )
    (bin_dir / "java").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (bin_dir / "java").chmod(0o755)
    (bin_dir / "keytool").write_text(
        "#!/bin/sh\n"
        + (
            'for arg in "$@"; do\n'
            '  if [ "$arg" = "-printcert" ]; then\n'
            "    printf 'SHA256: %s\\n' \"$FIXTURE_CERT\"; exit 0\n"
            "  fi\n"
            "done\n"
            if mode == "unsigned" else ""
        )
        + f'{shlex.quote(keytool_real)} "$@"\n'
        'status=$?\n'
        + (f'{shlex.quote(sys.executable)} {shlex.quote(str(tamper_script))}\n'
           if mode == "tampered" else "")
        + "exit $status\n",
        encoding="utf-8",
    )
    (bin_dir / "keytool").chmod(0o755)
    if mode == "unsigned":
        jarsigner_body = (
            "#!/bin/sh\n"
            'if [ "${1:-}" = "-keystore" ]; then\n'
            '  while [ "$#" -gt 0 ]; do\n'
            '    if [ "$1" = "-signedjar" ]; then cp "$3" "$2"; exit 0; fi\n'
            '    shift\n'
            "  done\n"
            "fi\n"
            f'printf "%s\\n" "$@" >> {shlex.quote(str(argv_log))}\n'
            f'exec {shlex.quote(jarsigner_real)} "$@"\n'
        )
        (bin_dir / "jarsigner").write_text(jarsigner_body, encoding="utf-8")
        (bin_dir / "jarsigner").chmod(0o755)
    else:
        (bin_dir / "jarsigner").write_text(
            "#!/bin/sh\n"
            f'printf "%s\\n" "$@" >> {shlex.quote(str(argv_log))}\n'
            f'exec {shlex.quote(jarsigner_real)} "$@"\n', encoding="utf-8"
        )
        (bin_dir / "jarsigner").chmod(0o755)

    android_home = tmp_path / "android-sdk"
    build_tools = android_home / "build-tools" / "36.0.0"
    build_tools.mkdir(parents=True)
    (build_tools / "zipalign").write_text(
        '#!/bin/sh\ncase "$1" in -c) exit 0;; *) cp "$5" "$6";; esac\n',
        encoding="utf-8",
    )
    (build_tools / "apksigner").write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "sign" ]; then\n'
        '  while [ "$1" != "--out" ]; do shift; done; cp "$3" "$2"\n'
        "else\n"
        "  printf 'Signer #1 certificate SHA-256 digest: %s\\n' \"$FIXTURE_CERT\"\n"
        "fi\n",
        encoding="utf-8",
    )
    for tool in (build_tools / "zipalign", build_tools / "apksigner"):
        tool.chmod(0o755)

    password = "temporary-fixture-password"
    alias = "fixture-key"
    keystore = tmp_path / "fixture.jks"
    fixture_env = {**os.environ, "KSTOREPWD": password}
    subprocess.run(
        [
            str(bin_dir / "keytool"), "-genkeypair", "-storetype", "JKS",
            "-keystore", str(keystore), "-storepass:env", "KSTOREPWD",
            "-keypass:env", "KSTOREPWD", "-alias", alias, "-keyalg", "RSA",
            "-keysize", "2048", "-validity", "2",
            "-dname", "CN=SilentSuite AAB integrity fixture",
        ],
        check=True, capture_output=True, text=True, env=fixture_env,
    )
    listed = subprocess.run(
        [
            str(bin_dir / "keytool"), "-J-Duser.language=en", "-J-Duser.country=US",
            "-list", "-v", "-keystore", str(keystore),
            "-storepass:env", "KSTOREPWD", "-alias", alias,
        ],
        check=True, capture_output=True, text=True, env=fixture_env,
    ).stdout
    match = re.search(r"SHA256:\s*((?:[0-9A-F]{2}:){31}[0-9A-F]{2})", listed)
    assert match, listed
    fingerprint = match.group(1).replace(":", "").lower()

    unsigned = tmp_path / "unsigned"
    unsigned.mkdir()
    (unsigned / "app-release-unsigned.apk").write_bytes(b"minimal apk fixture")
    with zipfile.ZipFile(unsigned / "app-release.aab", "w") as bundle:
        bundle.writestr("BundleConfig.pb", b"minimal signed-entry fixture")
    output = tmp_path / "signed"
    bundletool = tmp_path / "bundletool.jar"
    bundletool.write_bytes(b"inert fixture")
    result = subprocess.run(
        ["bash", str(SIGNER), "--expect-sha256", expected or fingerprint],
        capture_output=True,
        text=True,
        env={
            **fixture_env,
            "ANDROID_HOME": str(android_home), "JAVA_HOME": str(java_home),
            "UNSIGNED_DIR": str(unsigned), "OUTPUT_DIR": str(output),
            "KEYSTORE_PATH": str(keystore), "KEY_ALIAS": alias,
            "BUNDLETOOL_JAR": str(bundletool),
            "FIXTURE_CERT": expected or fingerprint,
            "TAMPER_AAB": str(output / "app-release.aab"),
        },
    )
    assert password not in result.stdout + result.stderr
    recorded_argv = argv_log.read_text(encoding="utf-8")
    assert password not in recorded_argv
    assert "-storepass:env\nKSTOREPWD" in recorded_argv
    return result


def test_valid_self_signed_pinned_aab_passes_integrity(tmp_path: Path):
    result = jdk_signing_fixture(tmp_path, mode="valid")
    assert result.returncode == 0, result.stdout + result.stderr


def test_byte_tampered_signed_aab_fails_integrity(tmp_path: Path):
    result = jdk_signing_fixture(tmp_path, mode="tampered")
    assert result.returncode != 0
    assert "failed cryptographic integrity verification" in result.stderr


def test_wrong_aab_signing_certificate_fails_the_pin(tmp_path: Path):
    result = jdk_signing_fixture(tmp_path, mode="valid", expected="0" * 64)
    assert result.returncode != 0
    assert "does not carry the reviewed upload key" in result.stderr


def test_unsigned_aab_fails_integrity(tmp_path: Path):
    result = jdk_signing_fixture(tmp_path, mode="unsigned")
    assert result.returncode != 0
    assert "failed cryptographic integrity verification" in result.stderr


def test_signer_end_to_end_with_generated_jks_when_exact_sdk_fixtures_exist(
    tmp_path: Path,
):
    """Runtime proof for the signing runner.

    A local developer machine is never mutated to satisfy this test. CI can
    point SILENTSUITE_SIGNING_E2E_FIXTURES at a directory containing a minimal
    valid app-release-unsigned.apk and app-release.aab, and BUNDLETOOL_JAR at
    the already checksum-verified jar. The test then generates its own JKS and
    exercises alignment, APK/AAB signing, certificate pinning, verification,
    and bundletool split generation through the real helper.
    """

    android_home = os.environ.get("ANDROID_HOME")
    java_home = os.environ.get("JAVA_HOME")
    fixtures_value = os.environ.get("SILENTSUITE_SIGNING_E2E_FIXTURES")
    bundletool_value = os.environ.get("BUNDLETOOL_JAR")
    if not all((android_home, java_home, fixtures_value, bundletool_value)):
        pytest.skip("exact SDK/JDK, bundletool, and valid signing fixtures are not configured")

    build_tools = Path(android_home) / "build-tools" / "36.0.0"
    keytool = Path(java_home) / "bin" / "keytool"
    required = (
        build_tools / "zipalign",
        build_tools / "apksigner",
        keytool,
        Path(java_home) / "bin" / "jarsigner",
        Path(java_home) / "bin" / "java",
        Path(bundletool_value),
    )
    if not all(path.is_file() and (path == Path(bundletool_value) or os.access(path, os.X_OK))
               for path in required):
        pytest.skip("exact build-tools;36.0.0 signing toolchain is unavailable")

    fixtures = Path(fixtures_value)
    fixture_apk = fixtures / "app-release-unsigned.apk"
    fixture_aab = fixtures / "app-release.aab"
    if not fixture_apk.is_file() or not fixture_aab.is_file():
        pytest.skip("minimal valid APK/AAB fixtures are unavailable")

    unsigned = tmp_path / "unsigned"
    unsigned.mkdir()
    shutil.copy2(fixture_apk, unsigned / fixture_apk.name)
    shutil.copy2(fixture_aab, unsigned / fixture_aab.name)
    keystore = tmp_path / "generated.jks"
    password = "temporary-test-password"
    alias = "temporary-test-key"
    subprocess.run(
        [
            str(keytool), "-genkeypair", "-storetype", "JKS",
            "-keystore", str(keystore), "-storepass:env", "KSTOREPWD",
            "-keypass:env", "KSTOREPWD", "-alias", alias, "-keyalg", "RSA",
            "-keysize", "2048", "-validity", "2",
            "-dname", "CN=SilentSuite signing test",
        ],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, "KSTOREPWD": password},
    )
    listed = subprocess.run(
        [
            str(keytool), "-J-Duser.language=en", "-J-Duser.country=US",
            "-list", "-v", "-keystore", str(keystore),
            "-storepass:env", "KSTOREPWD", "-alias", alias,
        ],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, "KSTOREPWD": password},
    ).stdout
    match = re.search(r"SHA256:\s*((?:[0-9A-F]{2}:){31}[0-9A-F]{2})", listed)
    assert match, listed
    fingerprint = match.group(1).replace(":", "").lower()

    output = tmp_path / "signed"
    result = subprocess.run(
        ["bash", str(SIGNER), "--expect-sha256", fingerprint],
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "ANDROID_HOME": android_home,
            "JAVA_HOME": java_home,
            "UNSIGNED_DIR": str(unsigned),
            "OUTPUT_DIR": str(output),
            "KEYSTORE_PATH": str(keystore),
            "KSTOREPWD": password,
            "KEY_ALIAS": alias,
            "BUNDLETOOL_JAR": bundletool_value,
        },
    )
    assert password not in result.stdout + result.stderr
    assert result.returncode == 0, result.stdout + result.stderr
    for name in ("app-release.apk", "app-release.aab", "signed-release.apks"):
        assert (output / name).is_file() and (output / name).stat().st_size > 0


# ── Wiring ────────────────────────────────────────────────────────────


def android_jobs() -> dict:
    return yaml.load(
        ANDROID_RELEASE_WORKFLOW.read_text(encoding="utf-8"), Loader=yaml.BaseLoader
    )["jobs"]


def test_the_producer_publishes_exactly_the_admitted_inventory():
    """The names the producer stages are the names the admitter demands."""

    producer = android_jobs()["build-unsigned-release"]
    staged = next(
        s for s in producer["steps"] if s["name"] == "Stage the closed unsigned handoff"
    )["run"]
    for name in (*PAYLOAD, "source-sha", "SHA256SUMS"):
        assert name in staged, f"the producer never stages {name}"
    assert '[ -s "$payload" ]' in staged, "the producer must reject empty payloads"
    assert "chmod 0644 ./*" in staged, "the producer must normalize data-only modes"
    admitter = ADMIT.read_text(encoding="utf-8")
    for name in PAYLOAD:
        assert f'"{name}"' in admitter, f"the admitter does not require {name}"


def test_the_two_jobs_run_on_separate_runners_and_share_only_the_artifact():
    jobs = android_jobs()
    producer, signer = jobs["build-unsigned-release"], jobs["sign-release"]
    assert producer["runs-on"] == signer["runs-on"] == "ubuntu-latest"
    # No cache is shared into the signing job: a poisoned Gradle cache would be
    # candidate-controlled state crossing the boundary.
    signer_uses = [s.get("uses", "") for s in signer["steps"]]
    assert not any("actions/cache" in u for u in signer_uses)
    downloads = [
        s["with"]["name"] for s in signer["steps"] if "download-artifact" in s.get("uses", "")
    ]
    assert downloads == ["silentsuite-android-unsigned-${{ inputs.source_sha }}"]


def test_the_signing_job_installs_and_checks_the_exact_build_tools_before_secrets():
    signer = android_jobs()["sign-release"]
    names = [step["name"] for step in signer["steps"]]
    install = next(
        step for step in signer["steps"]
        if step["name"] == "Install the exact Android signing tools"
    )
    assert names.index(install["name"]) < names.index("Decode release keystore")
    assert install.get("env") is None
    run = install["run"]
    assert 'SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"' in run
    assert '"$SDKMANAGER" "build-tools;36.0.0"' in run
    assert 'BUILD_TOOLS="$ANDROID_HOME/build-tools/36.0.0"' in run
    assert "for tool in zipalign apksigner" in run
    assert "readlink -f" in run
    assert "sudo" not in run
