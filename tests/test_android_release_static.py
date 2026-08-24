"""Static contracts for Android release artifact naming and native symbols."""

import importlib.util
import re
import subprocess
import zipfile
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
ANDROID_BUILD_WORKFLOW = ROOT / ".github/workflows/build-android.yml"
APP_BUILD_GRADLE = ROOT / "android/app/build.gradle"
SYMBOLS_VERIFIER = ROOT / "android/scripts/verify-native-debug-symbols.py"
SYMBOLS_PACKAGER = ROOT / "android/scripts/package-native-debug-symbols.py"
ANDROID_RELEASE_RUNBOOK = ROOT / "runbooks/android-release.md"
SIGNING_CHECKER = ROOT / "scripts/check-android-signing-boundary.py"

REQUIRED_NATIVE_LIBS = ("libetebase_android.so", "libconscrypt_jni.so")
EXPECTED_ABIS = ("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
# Only the locally rebuilt 64-bit Etebase libraries retain symbol tables;
# Conscrypt and the upstream 32-bit Etebase copies ship pre-stripped.
REQUIRED_SYMBOL_PAIRS = {
    ("arm64-v8a", "libetebase_android.so"),
    ("x86_64", "libetebase_android.so"),
}
SYMBOLS_ZIP_BUILD_PATH = (
    "android/app/build/outputs/native-debug-symbols/release/native-debug-symbols.zip"
)


def job_steps(job: str) -> dict[str, dict[str, object]]:
    workflow = yaml.load(
        ANDROID_BUILD_WORKFLOW.read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    steps = workflow["jobs"][job]["steps"]
    return {step["name"]: step for step in steps}


def release_steps() -> dict[str, dict[str, object]]:
    return job_steps("build-release")


def checksum_outputs(run: str) -> dict[str, str]:
    lines = run.splitlines()
    outputs: dict[str, str] = {}
    for index, line in enumerate(lines):
        command = line.strip()
        if not command.startswith("sha256sum "):
            continue
        source_match = re.fullmatch(
            r'sha256sum "([^"\n]+)" ' + re.escape("\\"),
            command,
        )
        if source_match is None or index + 1 >= len(lines):
            raise ValueError(f"invalid sha256sum command: {command}")
        redirect = lines[index + 1].strip()
        target_match = re.fullmatch(r'> "([^"\n]+)"', redirect)
        if target_match is None:
            raise ValueError(f"invalid sha256sum redirect: {redirect}")
        outputs[source_match.group(1)] = target_match.group(1)
    return outputs


@pytest.mark.parametrize(
    "run",
    [
        'sha256sum "app.apk"\n# > "safe.sha256"',
        'sha256sum "app.apk" \\\nprintf "> \\\"safe.sha256\\\""',
        'sha256sum "app.apk" \\\n"safe.sha256"',
    ],
)
def test_checksum_output_parser_rejects_non_redirect_lookalikes(run: str):
    with pytest.raises(ValueError):
        checksum_outputs(run)


def test_android_release_checksum_generation_matches_uploads():
    steps = release_steps()
    tag = "${{ github.ref_name }}"
    apk = f"silentsuite-android-{tag}.apk"
    aab = f"silentsuite-android-{tag}.aab"
    symbols = f"silentsuite-android-{tag}-native-debug-symbols.zip"
    installer_checksum = f"silentsuite-android-{tag}-installer.sha256"
    bundle_checksum = f"silentsuite-android-{tag}-bundle.sha256"
    symbols_checksum = f"silentsuite-android-{tag}-native-debug-symbols.sha256"

    rename_run = steps["Rename Android artifacts for release"]["run"]
    assert checksum_outputs(rename_run) == {
        apk: installer_checksum,
        aab: bundle_checksum,
        symbols: symbols_checksum,
    }

    attach = steps["Attach Android artifacts to umbrella GitHub Release"]
    uploaded = attach["with"]["files"].splitlines()
    assert uploaded == [
        f"android/app/build/outputs/apk/release/{apk}",
        f"android/app/build/outputs/apk/release/{installer_checksum}",
        f"android/app/build/outputs/bundle/release/{aab}",
        f"android/app/build/outputs/bundle/release/{bundle_checksum}",
        f"android/app/build/outputs/native-debug-symbols/release/{symbols}",
        f"android/app/build/outputs/native-debug-symbols/release/{symbols_checksum}",
    ]
    assert attach["with"]["draft"] == "true"
    assert attach["with"]["fail_on_unmatched_files"] == "true"


def test_android_release_checksum_sidecars_do_not_match_orion_apk_filter():
    steps = release_steps()
    rename_run = steps["Rename Android artifacts for release"]["run"]
    sidecars = checksum_outputs(rename_run).values()

    def looks_installable(name: str) -> bool:
        lowered_name = name.lower()
        lowered_url = f"https://github.com/example/releases/{name}".lower()
        return (
            lowered_name.endswith(".apk")
            or ".apk" in lowered_url
            or lowered_name == "apk"
            or "apk" in lowered_name
        )

    assert all(not looks_installable(sidecar) for sidecar in sidecars)


def gradle_block(text: str, keyword: str) -> str:
    match = re.search(rf"^\s*{re.escape(keyword)}\s*\{{", text, flags=re.MULTILINE)
    assert match is not None, f"missing Gradle block: {keyword}"
    depth = 0
    for index in range(match.end() - 1, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[match.end() : index]
    raise AssertionError(f"unterminated Gradle block: {keyword}")


def test_release_build_type_does_not_claim_agp_emits_symbol_zip():
    """AGP 8.11.1 does not emit a native-debug-symbols.zip for this project's
    prebuilt-AAR-only native libraries, so the release build type must not keep
    the ineffective `ndk.debugSymbolLevel` config (nor any comment claiming it
    produces the ZIP).
    """
    build_types = gradle_block(
        APP_BUILD_GRADLE.read_text(encoding="utf-8"), "buildTypes"
    )
    release = gradle_block(build_types, "release")
    assert "debugSymbolLevel" not in release
    assert "native-debug-symbols" not in release


@pytest.mark.parametrize("job", ["build-pr", "build-release"])
def test_native_symbol_verification_gates_both_release_builds(job: str):
    run = job_steps(job)["Verify release native debug symbols"]["run"]
    assert "scripts/verify-native-debug-symbols.py" in run
    for library in REQUIRED_NATIVE_LIBS:
        assert f"--require-lib {library}" in run
    for abi, library in sorted(REQUIRED_SYMBOL_PAIRS):
        assert f"--require-symbol {abi}/{library}" in run
    assert "--bundle app/build/outputs/bundle/release/app-release.aab" in run
    assert (
        "--symbols app/build/outputs/native-debug-symbols/release/native-debug-symbols.zip"
        in run
    )


@pytest.mark.parametrize("job", ["build-pr", "build-release"])
def test_manual_symbol_packaging_precedes_verification(job: str):
    steps = job_steps(job)
    ordered = list(steps)
    package = steps["Package release native debug symbols"]["run"]
    assert "scripts/package-native-debug-symbols.py" in package
    assert "--etebase-aar app/libs/client-2.3.2-16kb.aar" in package
    assert (
        "--output app/build/outputs/native-debug-symbols/release/native-debug-symbols.zip"
        in package
    )
    assert ordered.index("Package release native debug symbols") < ordered.index(
        "Verify release native debug symbols"
    )


def test_release_symbols_upload_is_gated_by_verifier_and_release_attach():
    """upload-artifact's if-no-files-found: error only fires when zero path
    patterns match, so it cannot enforce one missing file in a multi-path
    upload. Presence of the symbols ZIP is enforced by the preceding
    'Verify release native debug symbols' step and, for release assets, by
    the attach step's fail_on_unmatched_files; if-no-files-found stays only
    as defense in depth.
    """
    steps = release_steps()
    ordered = list(steps)
    upload = steps["Upload signed release APK, AAB, and native debug symbols"]
    assert SYMBOLS_ZIP_BUILD_PATH in upload["with"]["path"].splitlines()
    assert upload["with"]["if-no-files-found"] == "error"
    assert ordered.index("Verify release native debug symbols") < ordered.index(
        "Upload signed release APK, AAB, and native debug symbols"
    )
    attach = steps["Attach Android artifacts to umbrella GitHub Release"]
    assert attach["with"]["fail_on_unmatched_files"] == "true"


def test_pr_build_uploads_generated_symbols_after_verification():
    steps = job_steps("build-pr")
    ordered = list(steps)
    step = steps["Upload unsigned release native debug symbols"]
    # Single-pattern upload, so if-no-files-found: error does cover this ZIP;
    # the verifier step above it remains the primary contract gate.
    assert step["with"]["path"] == SYMBOLS_ZIP_BUILD_PATH
    assert step["with"]["if-no-files-found"] == "error"
    assert ordered.index("Verify release native debug symbols") < ordered.index(
        "Upload unsigned release native debug symbols"
    )


def test_android_release_runbook_documents_play_symbol_upload():
    text = ANDROID_RELEASE_RUNBOOK.read_text(encoding="utf-8")
    assert "silentsuite-android-<tag>.aab" in text
    assert "silentsuite-android-<tag>-native-debug-symbols.zip" in text
    assert "Play Console" in text
    # Honest coverage: stripped dependencies have no extractable symbols.
    assert "pre-stripped" in text
    # Play acceptance stays a manual gate; CI cannot verify Play Console state.
    assert "missing-native-debug-symbols warning" in text
    assert "CI cannot verify Play Console state" in text
    # Manual packaging workflow (not AGP-generated) must be documented.
    assert "package-native-debug-symbols.py" in text
    assert "same rebuilt AAR" in text
    assert ".symtab" in text
    assert "SHA-256" in text


def test_release_job_hash_constant_matches_workflow():
    """Pin the checker's EXPECTED_RELEASE_JOB_SHA256 to the committed
    workflow, so editing the build-release job without refreshing the
    constant fails here with a direct message, not only in signing-policy.
    """
    spec = importlib.util.spec_from_file_location(
        "check_android_signing_boundary", SIGNING_CHECKER
    )
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    workflow = checker.load_workflow(ANDROID_BUILD_WORKFLOW)
    assert (
        checker.semantic_sha256(workflow["jobs"]["build-release"])
        == checker.EXPECTED_RELEASE_JOB_SHA256
    )


def load_symbols_verifier():
    spec = importlib.util.spec_from_file_location(
        "verify_native_debug_symbols", SYMBOLS_VERIFIER
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_bundle(path: Path, pairs, payloads=None) -> None:
    payload_map = dict(payloads or {})
    with zipfile.ZipFile(path, "w") as archive:
        for abi, library in pairs:
            payload = payload_map.get((abi, library), b"elf")
            archive.writestr(f"base/lib/{abi}/{library}", payload)


def write_symbols(path: Path, entries) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, payload in entries:
            archive.writestr(name, payload)


# Byte-identical symbol payloads keyed by (abi, library): the Symbol ZIP entries
# and the AAB-packaged libraries are the same ELF bytes, so the SHA-256 identity
# check expects them to match exactly.
ETEBASE_PAYLOADS = {
    ("arm64-v8a", "libetebase_android.so"): b"elf64-arm64-symtab",
    ("x86_64", "libetebase_android.so"): b"elf64-x86_64-symtab",
}


def full_bundle_payloads() -> dict:
    payloads = {}
    for abi in EXPECTED_ABIS:
        for library in REQUIRED_NATIVE_LIBS:
            payloads[(abi, library)] = ETEBASE_PAYLOADS.get((abi, library), b"elf")
    return payloads


FULL_BUNDLE = [
    (abi, library) for abi in EXPECTED_ABIS for library in REQUIRED_NATIVE_LIBS
]
GOOD_SYMBOL_ENTRIES = [
    (
        "arm64-v8a/libetebase_android.so",
        ETEBASE_PAYLOADS[("arm64-v8a", "libetebase_android.so")],
    ),
    (
        "x86_64/libetebase_android.so",
        ETEBASE_PAYLOADS[("x86_64", "libetebase_android.so")],
    ),
]


def test_symbols_verifier_accepts_expected_inventory(tmp_path):
    module = load_symbols_verifier()
    bundle = tmp_path / "app-release.aab"
    symbols = tmp_path / "native-debug-symbols.zip"
    write_bundle(bundle, FULL_BUNDLE, full_bundle_payloads())
    write_symbols(symbols, GOOD_SYMBOL_ENTRIES)
    assert (
        module.collect_errors(
            bundle, symbols, set(REQUIRED_NATIVE_LIBS), set(REQUIRED_SYMBOL_PAIRS)
        )
        == []
    )


def test_symbols_verifier_rejects_payload_divergence(tmp_path):
    """The symbol entry for a symbol-bearing library must be byte-identical to
    the copy packaged inside the same AAB; a divergent payload means the ZIP was
    built from a different source and must fail closed.
    """
    module = load_symbols_verifier()
    bundle = tmp_path / "app-release.aab"
    symbols = tmp_path / "native-debug-symbols.zip"
    payloads = full_bundle_payloads()
    write_bundle(bundle, FULL_BUNDLE, payloads)
    diverged = list(GOOD_SYMBOL_ENTRIES)
    diverged[0] = ("arm64-v8a/libetebase_android.so", b"elf64-arm64-OTHER")
    write_symbols(symbols, diverged)
    errors = module.collect_errors(
        bundle, symbols, set(REQUIRED_NATIVE_LIBS), set(REQUIRED_SYMBOL_PAIRS)
    )
    assert any("SHA-256 mismatch" in error for error in errors)


@pytest.mark.parametrize(
    ("name", "bundle_pairs", "symbol_zip_entries"),
    [
        ("missing-required-symbol", FULL_BUNDLE, GOOD_SYMBOL_ENTRIES[:1]),
        (
            "empty-required-symbol",
            FULL_BUNDLE,
            [GOOD_SYMBOL_ENTRIES[0], ("x86_64/libetebase_android.so.sym", b"")],
        ),
        (
            "symbol-for-unpackaged-library",
            FULL_BUNDLE,
            GOOD_SYMBOL_ENTRIES + [("x86/libunknown.so.sym", b"symtab")],
        ),
        (
            "malformed-symbol-entry",
            FULL_BUNDLE,
            GOOD_SYMBOL_ENTRIES + [("arm64-v8a/notes.txt", b"junk")],
        ),
        ("bundle-missing-required-library", FULL_BUNDLE[:-1], GOOD_SYMBOL_ENTRIES),
        (
            "bundle-unexpected-library",
            FULL_BUNDLE + [("x86", "libextra.so")],
            GOOD_SYMBOL_ENTRIES,
        ),
    ],
)
def test_symbols_verifier_fails_closed_on_defects(
    tmp_path, name, bundle_pairs, symbol_zip_entries
):
    module = load_symbols_verifier()
    bundle = tmp_path / f"{name}.aab"
    symbols = tmp_path / f"{name}.zip"
    write_bundle(bundle, bundle_pairs)
    write_symbols(symbols, symbol_zip_entries)
    errors = module.collect_errors(
        bundle, symbols, set(REQUIRED_NATIVE_LIBS), set(REQUIRED_SYMBOL_PAIRS)
    )
    assert errors, name


def test_symbols_verifier_fails_closed_when_zip_missing(tmp_path):
    module = load_symbols_verifier()
    bundle = tmp_path / "app-release.aab"
    write_bundle(bundle, FULL_BUNDLE)
    absent = tmp_path / "native-debug-symbols.zip"
    errors = module.collect_errors(
        bundle, absent, set(REQUIRED_NATIVE_LIBS), set(REQUIRED_SYMBOL_PAIRS)
    )
    assert errors == [f"missing archive: {absent}"]


def load_symbols_packager():
    spec = importlib.util.spec_from_file_location(
        "package_native_debug_symbols", SYMBOLS_PACKAGER
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_complete_etebase_aar(path: Path) -> None:
    """Write a rebuilt Etebase AAR with every `jni/<abi>/libetebase_android.so`
    entry present, as android/scripts/build-etebase-client-16kb.sh produces it.
    """
    with zipfile.ZipFile(path, "w") as archive:
        # The repacked AAR retains the upstream 32-bit copies too.
        archive.writestr("jni/armeabi-v7a/libetebase_android.so", b"elf32-armv7")
        archive.writestr("jni/x86/libetebase_android.so", b"elf32-x86")
        archive.writestr(
            "jni/arm64-v8a/libetebase_android.so",
            ETEBASE_PAYLOADS[("arm64-v8a", "libetebase_android.so")],
        )
        archive.writestr(
            "jni/x86_64/libetebase_android.so",
            ETEBASE_PAYLOADS[("x86_64", "libetebase_android.so")],
        )


def test_packager_emits_deterministic_symbol_zip(tmp_path, monkeypatch):
    packager = load_symbols_packager()
    monkeypatch.setattr(packager, "has_symtab", lambda elf: True)

    aar = tmp_path / "client-2.3.2-16kb.aar"
    build_complete_etebase_aar(aar)

    out_a = tmp_path / "a.zip"
    out_b = tmp_path / "b.zip"
    packager.write_symbols_zip(out_a, packager.read_aar_payloads(aar))
    packager.write_symbols_zip(out_b, packager.read_aar_payloads(aar))
    assert out_a.read_bytes() == out_b.read_bytes()

    # Exactly two entries, bare `.so` names, no Conscrypt, no 32-bit Etebase.
    with zipfile.ZipFile(out_a) as archive:
        names = archive.namelist()
    assert names == [
        "arm64-v8a/libetebase_android.so",
        "x86_64/libetebase_android.so",
    ]
    with zipfile.ZipFile(out_a) as archive:
        for info in archive.infolist():
            assert info.filename in names
            assert info.file_size > 0
            assert info.external_attr == 0o100644 << 16
            assert info.date_time == (1980, 1, 1, 0, 0, 0)
            payload = archive.read(info.filename)
            assert payload == ETEBASE_PAYLOADS[
                (info.filename.split("/")[0], info.filename.split("/")[1])
            ]


def test_packager_rejects_32bit_and_conscrypt_are_never_included():
    packager = load_symbols_packager()
    # The packaging script hard-codes its two symbol-bearing entries; verify its
    # declared inventory excludes Conscrypt and the 32-bit Etebase ABIs.
    assert packager.SYMBOL_ENTRIES == (
        ("arm64-v8a", "libetebase_android.so"),
        ("x86_64", "libetebase_android.so"),
    )


def test_packager_rejects_missing_source_entry(tmp_path):
    packager = load_symbols_packager()
    aar = tmp_path / "incomplete.aar"
    with zipfile.ZipFile(aar, "w") as archive:
        # Only one 64-bit library present; the x86_64 entry is missing.
        archive.writestr(
            "jni/arm64-v8a/libetebase_android.so",
            ETEBASE_PAYLOADS[("arm64-v8a", "libetebase_android.so")],
        )
    with pytest.raises(SystemExit):
        packager.read_aar_payloads(aar)


def test_packager_rejects_symbolless_payload(tmp_path, monkeypatch):
    packager = load_symbols_packager()
    monkeypatch.setattr(
        packager,
        "has_symtab",
        lambda elf: elf
        == ETEBASE_PAYLOADS[("arm64-v8a", "libetebase_android.so")],
    )
    aar = tmp_path / "stripped.aar"
    build_complete_etebase_aar(aar)
    payloads = packager.read_aar_payloads(aar)
    with pytest.raises(SystemExit):
        packager.validate_payloads(payloads, aar)


def test_packager_validate_payloads_accepts_complete(tmp_path, monkeypatch):
    packager = load_symbols_packager()
    monkeypatch.setattr(packager, "has_symtab", lambda elf: True)
    aar = tmp_path / "ok.aar"
    build_complete_etebase_aar(aar)
    payloads = packager.read_aar_payloads(aar)
    packager.validate_payloads(payloads, aar)  # must not raise


def _sections(name: str, type_: str) -> str:
    """Render a single `readelf -SW` section row in fixed-column layout."""
    return f"  [25] {name:<16} {type_:<16} 0000000000000000 000000 000000 00 0 0 0"


class _FakeCompleted:
    def __init__(self, stdout: str):
        self.stdout = stdout

    def returncode(self) -> int:
        return 0


def _fake_run(readelf_stdout: str):
    def fake_run(argv, **kwargs):
        assert argv[:1] == ["readelf"]
        return _FakeCompleted(readelf_stdout)

    return fake_run


def test_packager_has_symtab_accepts_readelf_symtab_row(monkeypatch):
    """A real `readelf -SW` row puts `.symtab` at field index 1 (the section
    number `[25]` occupies index 0); the section name must match exactly.
    """
    packager = load_symbols_packager()
    monkeypatch.setattr(
        packager.subprocess,
        "run",
        _fake_run(
            "There are 29 section headers...\n"
            + _sections(".symtab", "SYMTAB")
            + "\n"
            + _sections(".strtab", "STRTAB")
            + "\n"
        ),
    )
    assert packager.has_symtab(b"elf64") is True


@pytest.mark.parametrize(
    "stdout",
    [
        _sections(".symtab_shndx", "SYMTAB_SECTION_INDEX"),  # lookalike name
        _sections(".symtab", "PROGBITS"),  # wrong type
        "",  # empty output
        "There are no sections in this file.\n",
    ],
)
def test_packager_has_symtab_rejects_non_symtab(monkeypatch, stdout):
    packager = load_symbols_packager()
    monkeypatch.setattr(packager.subprocess, "run", _fake_run(stdout))
    assert packager.has_symtab(b"elf64") is False


def test_packager_has_symtab_rejects_readelf_failure(monkeypatch):
    packager = load_symbols_packager()

    def failing_run(argv, **kwargs):
        raise subprocess.CalledProcessError(1, argv)

    monkeypatch.setattr(packager.subprocess, "run", failing_run)
    assert packager.has_symtab(b"elf64") is False


def test_packager_rejects_duplicate_selected_aar_entry(tmp_path):
    packager = load_symbols_packager()
    aar = tmp_path / "duplicated.aar"
    with zipfile.ZipFile(aar, "w") as archive:
        payload = ETEBASE_PAYLOADS[("arm64-v8a", "libetebase_android.so")]
        archive.writestr("jni/arm64-v8a/libetebase_android.so", payload)
        archive.writestr("jni/arm64-v8a/libetebase_android.so", payload)
        archive.writestr(
            "jni/x86_64/libetebase_android.so",
            ETEBASE_PAYLOADS[("x86_64", "libetebase_android.so")],
        )
    with pytest.raises(SystemExit):
        packager.read_aar_payloads(aar)


def test_packager_write_symbols_zip_leaves_tmp_dir_clean(tmp_path):
    """`write_symbols_zip` must close the mkstemp fd and remove the temporary
    file, leaving only the final output alongside no stray `.tmp` siblings."""
    packager = load_symbols_packager()
    aar = tmp_path / "client-2.3.2-16kb.aar"
    build_complete_etebase_aar(aar)
    output = tmp_path / "native-debug-symbols.zip"
    packager.write_symbols_zip(output, packager.read_aar_payloads(aar))
    assert output.is_file()
    siblings = {p.name for p in tmp_path.iterdir()}
    assert not any(name.endswith(".tmp") for name in siblings)


def test_symbols_verifier_rejects_duplicate_aab_native_entry(tmp_path):
    module = load_symbols_verifier()
    bundle = tmp_path / "dup.aab"
    with zipfile.ZipFile(bundle, "w") as archive:
        payload = ETEBASE_PAYLOADS[("arm64-v8a", "libetebase_android.so")]
        archive.writestr("base/lib/arm64-v8a/libetebase_android.so", payload)
        archive.writestr("base/lib/arm64-v8a/libetebase_android.so", payload)
    errors = module.bundle_native_libs(bundle)[2]
    assert any("duplicate" in error for error in errors)
