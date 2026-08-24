"""Static contracts for Android release artifact naming and native symbols."""

import importlib.util
import re
import zipfile
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
ANDROID_BUILD_WORKFLOW = ROOT / ".github/workflows/build-android.yml"
APP_BUILD_GRADLE = ROOT / "android/app/build.gradle"
SYMBOLS_VERIFIER = ROOT / "android/scripts/verify-native-debug-symbols.py"
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


def test_release_build_type_emits_native_debug_symbol_zip():
    build_types = gradle_block(
        APP_BUILD_GRADLE.read_text(encoding="utf-8"), "buildTypes"
    )
    release = gradle_block(build_types, "release")
    ndk = gradle_block(release, "ndk")
    assert re.search(r"debugSymbolLevel\s+'SYMBOL_TABLE'", ndk)


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


def write_bundle(path: Path, pairs) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for abi, library in pairs:
            archive.writestr(f"base/lib/{abi}/{library}", b"elf")


def write_symbols(path: Path, entries) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, payload in entries:
            archive.writestr(name, payload)


FULL_BUNDLE = [
    (abi, library) for abi in EXPECTED_ABIS for library in REQUIRED_NATIVE_LIBS
]
GOOD_SYMBOL_ENTRIES = [
    ("arm64-v8a/libetebase_android.so.sym", b"symtab"),
    ("x86_64/libetebase_android.so.sym", b"symtab"),
]


def test_symbols_verifier_accepts_expected_inventory(tmp_path):
    module = load_symbols_verifier()
    bundle = tmp_path / "app-release.aab"
    symbols = tmp_path / "native-debug-symbols.zip"
    write_bundle(bundle, FULL_BUNDLE)
    write_symbols(symbols, GOOD_SYMBOL_ENTRIES)
    assert (
        module.collect_errors(
            bundle, symbols, set(REQUIRED_NATIVE_LIBS), set(REQUIRED_SYMBOL_PAIRS)
        )
        == []
    )


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
