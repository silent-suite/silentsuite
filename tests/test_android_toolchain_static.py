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
    assert "minSdkVersion 29" in app
    assert "targetSdkVersion 36" in app
    assert "targetSdkVersion 35" not in app
    assert "JavaVersion.VERSION_17" in app
    assert "minSdkVersion 29" in cert4android
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


def test_root_gradle_distribution_is_checksum_pinned():
    wrapper = read("android/gradle/wrapper/gradle-wrapper.properties")

    # Official sha256 of gradle-8.13-all.zip from services.gradle.org.
    assert (
        "distributionSha256Sum=fba8464465835e74f7270bbf43d6d8a8d7709ab0a43ce1aa3323f73e9aa0c612"
        in wrapper.splitlines()
    )


def test_nested_standalone_wrapper_distributions_are_checksum_pinned():
    # CI never runs these standalone wrappers (every Gradle call goes through
    # android/gradlew), but a local run of one must still get the exact
    # distribution. Official sha256 values from services.gradle.org.
    expected = {
        "android/cert4android/gradle/wrapper/gradle-wrapper.properties": (
            "gradle-6.3-all.zip",
            "0f316a67b971b7b571dac7215dcf2591a30994b3450e0629925ffcfe2c68cc5c",
        ),
        "android/ical4android/gradle/wrapper/gradle-wrapper.properties": (
            "gradle-6.6.1-all.zip",
            "11657af6356b7587bfb37287b5992e94a9686d5c8a0a1b60b87b9928a2decde5",
        ),
        "android/vcard4android/gradle/wrapper/gradle-wrapper.properties": (
            "gradle-6.6.1-all.zip",
            "11657af6356b7587bfb37287b5992e94a9686d5c8a0a1b60b87b9928a2decde5",
        ),
    }

    for path, (distribution, sha256) in expected.items():
        lines = read(path).splitlines()
        assert f"distributionUrl=https\\://services.gradle.org/distributions/{distribution}" in lines, path
        assert f"distributionSha256Sum={sha256}" in lines, path


def test_jitpack_serves_only_the_module_missing_from_maven_central():
    build = read("android/build.gradle")

    assert build.count("https://jitpack.io") == 1
    jitpack = build[build.index("maven { url 'https://jitpack.io'"):]
    jitpack = jitpack[: jitpack.index("google()")]
    assert re.findall(r'include\w+\(([^)]*)\)', jitpack) == ['"com.github.cachapa", "ExpandableLayout"']


def test_android_ci_validates_every_gradle_wrapper_jar():
    workflow = read(".github/workflows/build-android.yml")

    assert (
        "uses: gradle/actions/wrapper-validation@8da46b539cd8fe6ab27ca75128919a18d757604c # v6.4.1"
        in workflow
    )
