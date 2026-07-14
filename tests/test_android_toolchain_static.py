"""Static contracts for the root Android build toolchain.

The Android subprojects share this root build. Their standalone wrappers are
intentionally independent and must not be upgraded as part of the root build.
"""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_root_android_toolchain_versions_are_pinned_consistently():
    build = read("android/build.gradle")
    wrapper = read("android/gradle/wrapper/gradle-wrapper.properties")

    assert re.findall(r"(?:ext\.)?gradle_version\s*=\s*'([^']+)'", build) == ["8.11.1", "8.11.1"]
    assert re.findall(r"(?:ext\.)?kotlin_version\s*=\s*'([^']+)'", build) == ["2.2.20", "2.2.20"]
    assert 'classpath "com.android.tools.build:gradle:$gradle_version"' in build
    assert 'classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlin_version"' in build
    assert "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-all.zip" in wrapper


def test_root_android_platform_and_jvm_contracts_remain_unchanged():
    build = read("android/build.gradle")
    app = read("android/app/build.gradle")
    cert4android = read("android/cert4android/build.gradle")
    ical4android = read("android/ical4android/build.gradle")
    vcard4android = read("android/vcard4android/build.gradle")

    assert "compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)" in build
    assert "kotlinOptions" not in build
    assert "kotlinOptions" not in app
    assert "compilerOptions.freeCompilerArgs.addAll(" in app
    for compiler_arg in (
        "-Xno-param-assertions",
        "-Xno-call-assertions",
        "-Xno-receiver-assertions",
    ):
        assert compiler_arg in app
    assert "compileSdkVersion = 36" in build
    assert "minSdkVersion 21" in app
    assert "targetSdkVersion 35" in app
    assert "JavaVersion.VERSION_17" in app
    assert "minSdkVersion 14" in cert4android
    assert "minSdkVersion 21" in ical4android
    assert "minSdkVersion 16" in vcard4android
    for library in (cert4android, ical4android, vcard4android):
        assert "sourceCompatibility JavaVersion.VERSION_17" in library


def test_nested_standalone_wrapper_versions_are_not_root_toolchain_inputs():
    expected_urls = {
        "android/vcard4android/gradle/wrapper/gradle-wrapper.properties": "gradle-6.6.1-all.zip",
        "android/ical4android/gradle/wrapper/gradle-wrapper.properties": "gradle-6.6.1-all.zip",
        "android/cert4android/gradle/wrapper/gradle-wrapper.properties": "gradle-6.3-all.zip",
    }

    for path, distribution in expected_urls.items():
        assert distribution in read(path), path
