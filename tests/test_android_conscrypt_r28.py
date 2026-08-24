from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/build-android.yml"
CERT4ANDROID_GRADLE = ROOT / "android/cert4android/build.gradle"
ROOT_GRADLE = ROOT / "android/build.gradle"
BUILD_SCRIPT = ROOT / "android/scripts/build-conscrypt-android-r28.sh"
VERIFIER = ROOT / "android/scripts/verify-native-16kb.py"
RUNTIME_TEST = ROOT / (
    "android/cert4android/src/androidTest/java/at/bitfire/cert4android/"
    "ConscryptProviderRuntimeTest.kt"
)
LOCAL_MAVEN_REPO = "build/conscrypt-m2"
LOCAL_AAR = (
    f"{LOCAL_MAVEN_REPO}/org/conscrypt/conscrypt-android/2.6.3-r28/"
    "conscrypt-android-2.6.3-r28.aar"
)
CONSCRYPT_COMMIT = "657e1c64c46961bcc48e7302e42ebc02d6632645"
BORINGSSL_COMMIT = "3adc3d1aba162a578e2547f329fcce8659b8e89c"
NDK_VERSION = "28.2.13676358"


def load_verifier():
    spec = importlib.util.spec_from_file_location("verify_native_16kb", VERIFIER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def workflow_jobs() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]


def test_conscrypt_builder_pins_source_boringssl_and_ndk_r28():
    source = BUILD_SCRIPT.read_text(encoding="utf-8")
    assert CONSCRYPT_COMMIT in source
    assert BORINGSSL_COMMIT in source
    assert NDK_VERSION in source
    assert "-z max-page-size=16384 -z common-page-size=16384" in source
    assert ":conscrypt-android:assembleRelease" in source
    assert LOCAL_AAR in source
    assert "org/conscrypt/conscrypt.properties" in source
    assert "org.conscrypt.boringssl.version" in source
    assert "org.conscrypt.version.patch" in source


def test_release_builds_fail_closed_without_rebuilt_conscrypt_aar():
    source = CERT4ANDROID_GRADLE.read_text(encoding="utf-8")
    root_source = ROOT_GRADLE.read_text(encoding="utf-8")
    assert "conscrypt: '2.6.3'" in source
    assert 'build/conscrypt-m2/org/conscrypt/conscrypt-android' in source
    assert "requireConscryptR28" in source
    assert 'implementation "org.conscrypt:conscrypt-android:${versions.conscrypt}-r28"' in source
    assert "org.conscrypt:conscrypt-android:${versions.conscrypt}" in source
    assert "Missing ${conscryptR28Artifact}" in source
    assert 'maven { url uri("$rootDir/build/conscrypt-m2")' in root_source
    assert 'includeModule("org.conscrypt", "conscrypt-android")' in root_source


def test_workflow_builds_conscrypt_once_without_secrets_and_reuses_exact_run_artifact():
    jobs = workflow_jobs()
    producer = jobs["conscrypt-r28"]
    assert producer["permissions"] == {"contents": "read"}
    assert producer["timeout-minutes"] == 30
    assert "environment" not in producer
    producer_steps = {step["name"]: step for step in producer["steps"]}
    build = producer_steps["Build Conscrypt with Android NDK r28"]["run"]
    assert "scripts/build-conscrypt-android-r28.sh" in build
    verify = producer_steps["Verify rebuilt Conscrypt AAR"]["run"]
    assert "--require-lib libconscrypt_jni.so" in verify
    assert "--require-android-ndk-major libconscrypt_jni.so=28" in verify
    upload = producer_steps["Upload rebuilt Conscrypt AAR"]["with"]
    assert upload["name"] == "conscrypt-r28-${{ github.sha }}"
    assert upload["path"] == f"android/{LOCAL_MAVEN_REPO}"
    assert upload["if-no-files-found"] == "error"

    for job_name in (
        "build-pr",
        "account-recreation-runtime",
        "color-parity-evidence",
        "build-release",
    ):
        job = jobs[job_name]
        needs = job["needs"] if isinstance(job["needs"], list) else [job["needs"]]
        assert "conscrypt-r28" in needs
        steps = {step["name"]: step for step in job["steps"]}
        download = steps["Download rebuilt Conscrypt AAR"]["with"]
        assert download["name"] == "conscrypt-r28-${{ github.sha }}"
        assert download["path"] == f"android/{LOCAL_MAVEN_REPO}"


def test_final_apk_and_aab_gates_require_conscrypt_ndk_r28_identity():
    jobs = workflow_jobs()
    for job_name, step_name in (
        ("build-pr", "Verify unsigned release native libraries"),
        ("build-release", "Verify release native libraries"),
    ):
        run = {step["name"]: step for step in jobs[job_name]["steps"]}[step_name]["run"]
        assert "--require-lib libconscrypt_jni.so" in run
        assert "--require-android-ndk-major libconscrypt_jni.so=28" in run
        assert "--require-android-ndk-major libetebase_android.so=28" in run
        assert "app/build/outputs/bundle/release/*.aab" in run
        assert "app/build/outputs/apk/release/*.apk" in run


def test_conscrypt_provider_runs_on_api_floor_and_target_api():
    job = workflow_jobs()["conscrypt-runtime"]
    assert job["needs"] == "conscrypt-r28"
    assert job["permissions"] == {"contents": "read"}
    assert job["strategy"]["matrix"]["include"] == [
        {"api-level": "21", "arch": "x86"},
        {"api-level": "36", "arch": "x86_64"},
    ]
    steps = {step["name"]: step for step in job["steps"]}
    assert steps["Download rebuilt Conscrypt AAR"]["with"]["name"] == "conscrypt-r28-${{ github.sha }}"
    command = steps["Run Conscrypt certificate-service runtime tests"]["with"]["script"]
    assert "cert4android:connectedDebugAndroidTest" in command
    assert "at.bitfire.cert4android.ConscryptProviderRuntimeTest" in command
    assert "-PrequireConscryptR28=true" in command
    ledger = steps["Assert Conscrypt runtime methods executed"]["run"]
    assert "providerLoadsAndCreatesTlsContext" in ledger


def test_conscrypt_runtime_test_exercises_the_real_native_provider():
    source = RUNTIME_TEST.read_text(encoding="utf-8")
    assert "Conscrypt.newProvider()" in source
    assert "Conscrypt.version()" in source
    assert "SSLContext.getInstance(\"TLS\", provider)" in source
    assert "context.init(null, null, null)" in source
    assert "context.createSSLEngine()" in source
    assert "providerLoadsAndCreatesTlsContext" in source


def test_ndk_note_parser_accepts_r28_and_rejects_r27(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    verifier = load_verifier()
    elf = tmp_path / "libconscrypt_jni.so"
    elf.write_bytes(b"ELF fixture placeholder")

    monkeypatch.setattr(
        verifier.subprocess,
        "check_output",
        lambda command, text: "Owner Data size Description\nAndroid 0x84 NT_VERSION\nNDK: r28b (28.1.13356709)\n",
    )
    assert verifier.android_ndk_major(elf) == 28

    monkeypatch.setattr(
        verifier.subprocess,
        "check_output",
        lambda command, text: "Android NT_VERSION\nversion: r27d\n",
    )
    assert verifier.android_ndk_major(elf) == 27


def test_ndk_note_parser_fails_closed_when_android_identity_is_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    verifier = load_verifier()
    elf = tmp_path / "libconscrypt_jni.so"
    elf.write_bytes(b"ELF fixture placeholder")
    monkeypatch.setattr(verifier.subprocess, "check_output", lambda command, text: "GNU build-id only\n")
    assert verifier.android_ndk_major(elf) is None
