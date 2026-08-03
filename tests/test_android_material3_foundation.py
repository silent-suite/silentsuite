"""Static/resource contracts for the incremental Material 3 Views foundation."""

from pathlib import Path
import re
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android/app/src/main/res"


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def resource_entries(path: Path, tag: str) -> dict[str, str]:
    root = ET.parse(path).getroot()
    return {entry.attrib["name"]: (entry.text or "").strip() for entry in root.findall(tag)}


def styles(path: Path) -> dict[str, dict[str, str]]:
    root = ET.parse(path).getroot()
    return {
        style.attrib["name"]: {
            item.attrib["name"]: (item.text or "").strip()
            for item in style.findall("item")
        }
        for style in root.findall("style")
    }


def test_material_113_and_product_floor_are_shared_by_app_and_cert4android():
    root_build = read("android/build.gradle")
    app_build = read("android/app/build.gradle")
    cert_build = read("android/cert4android/build.gradle")

    expected_cohort = {
        "core": "1.15.0",
        "appcompat": "1.7.1",
        "fragment": "1.8.5",
        "lifecycle": "2.8.7",
        "preference": "1.2.1",
        "material": "1.13.0",
        "testCore": "1.6.1",
        "testRunner": "1.6.2",
        "testRules": "1.6.1",
        "testExtJunit": "1.2.1",
        "espresso": "3.6.1",
        "uiAutomator": "2.3.0",
    }
    for role, version in expected_cohort.items():
        assert re.search(rf"{role}:\s*'{re.escape(version)}'", root_build)
    assert "desugarJdkLibsVersion = '2.1.5'" in root_build
    assert "1.14." not in root_build
    for build in (app_build, cert_build):
        assert 'implementation "com.google.android.material:material:${androidX.material}"' in build
    assert "minSdkVersion 21" in app_build
    assert "minSdkVersion 21" in cert_build
    # vcard4android is intentionally API 16, so its androidTest cohort must
    # remain independent from the API-19 AndroidX Test 1.6/3.6 lane.
    assert "vcardAndroidTestVersions = [runner: '1.5.2', rules: '1.5.0']" in root_build
    assert "API " + "14" not in cert_build
    assert "API-" + "14" not in root_build
    assert "androidx.multidex:multidex" not in cert_build


def test_api21_foundation_keeps_api23_system_bar_flags_out_of_base_resources_and_vcard_tests_compatible():
    light_themes = read("android/app/src/main/res/values/themes.xml")
    dark_themes = read("android/app/src/main/res/values-night/themes.xml")
    vcard_build = read("android/vcard4android/build.gradle")

    # Base resources are selected on API 21. BaseActivity applies readable system
    # bars at runtime, so API-23-only window flags must not live in these files.
    assert "android:windowLightStatusBar" not in light_themes
    assert "android:windowLightStatusBar" not in dark_themes
    assert "android:windowLightNavigationBar" not in light_themes
    assert "android:windowLightNavigationBar" not in dark_themes

    # vcard4android intentionally preserves its API-16 library contract. Its
    # instrumentation dependencies therefore cannot share the API-19 test lane.
    assert "minSdkVersion 16" in vcard_build
    assert "androidx.test:runner:1.5.2" in vcard_build
    assert "androidx.test:rules:1.5.0" in vcard_build


def test_foundation_resource_files_are_well_formed_and_keep_responsibilities_separate():
    color_files = (RES / "values/colors.xml", RES / "values-night/colors.xml")
    theme_files = (RES / "values/themes.xml", RES / "values-night/themes.xml")
    for path in (*color_files, *theme_files, RES / "values/styles.xml", RES / "values-night/styles.xml"):
        assert path.exists(), path
        ET.parse(path)

    for path in (RES / "values/styles.xml", RES / "values-night/styles.xml"):
        assert not ET.parse(path).getroot().findall("color"), path


def test_semantic_light_and_dark_roles_have_parity_and_preserve_navy_emerald_brand():
    roles = {
        "semantic_background",
        "semantic_surface",
        "semantic_on_surface",
        "semantic_outline",
        "semantic_primary",
        "semantic_success",
        "semantic_warning",
        "semantic_error",
        "semantic_disabled_content",
        "semantic_focus",
        "semantic_system_bar",
    }
    light = resource_entries(RES / "values/colors.xml", "color")
    dark = resource_entries(RES / "values-night/colors.xml", "color")
    assert roles <= light.keys()
    assert roles <= dark.keys()
    assert light["navy900"].upper() == "#0A1018"
    assert light["teal400"].upper() == "#34D399"
    assert light["teal500"].upper() == "#10B981"
    assert light["semantic_system_bar"] == "#0A1018"
    assert dark["semantic_system_bar"] == "#0A1018"


def test_incremental_material3_themes_use_semantic_roles_and_readable_navy_system_bars():
    light = styles(RES / "values/themes.xml")
    dark = styles(RES / "values-night/themes.xml")
    for theme_set in (light, dark):
        assert "AppTheme.Material3" in theme_set
        assert "AppTheme.Material3.NoActionBar" in theme_set
        for theme_name in ("AppTheme.Material3", "AppTheme.Material3.NoActionBar"):
            material3 = theme_set[theme_name]
            for item, color in {
                "android:colorBackground": "@color/semantic_background",
                "colorSurface": "@color/semantic_surface",
                "colorOnSurface": "@color/semantic_on_surface",
                "colorPrimary": "@color/semantic_primary",
                "colorOnPrimary": "@color/semantic_on_primary",
                "android:statusBarColor": "@color/semantic_system_bar",
                "android:navigationBarColor": "@color/semantic_system_bar",
            }.items():
                assert material3.get(item) == color

    theme_root = ET.parse(RES / "values/themes.xml").getroot()
    parents = {style.attrib["name"]: style.attrib.get("parent") for style in theme_root.findall("style")}
    assert parents["AppTheme.Material3"] == "Theme.Material3.DayNight"
    assert parents["AppTheme.Material3.NoActionBar"] == "Theme.Material3.DayNight.NoActionBar"

    base_activity = read("android/app/src/main/java/io/silentsuite/sync/ui/BaseActivity.kt")
    assert "applyReadableSystemBars()" in base_activity
    assert "R.color.semantic_system_bar" in base_activity
    assert "holo_" not in base_activity


def test_foundation_dimensions_and_component_previews_use_accessible_semantic_tokens():
    dimens = resource_entries(RES / "values/dimen.xml", "dimen")
    assert {f"spacing_{value}": f"{value}dp" for value in range(0, 49, 8)}.items() <= dimens.items()
    assert dimens["shape_radius_standard"] == "12dp"
    assert dimens["touch_target_min"] == "48dp"
    assert dimens["elevation_resting"] == "0dp"
    assert dimens["elevation_raised"] == "2dp"

    previews = styles(RES / "values/styles.xml")
    for name in (
        "TextAppearance.AppTheme.Material3.Body",
        "TextAppearance.AppTheme.Material3.Title",
        "ShapeAppearance.AppTheme.Material3.Standard",
        "Widget.AppTheme.Material3.Button",
        "Widget.AppTheme.Material3.TextInputLayout",
    ):
        assert name in previews
    assert previews["ShapeAppearance.AppTheme.Material3.Standard"].get("cornerSize") == "@dimen/shape_radius_standard"
    assert previews["Widget.AppTheme.Material3.Button"].get("android:minHeight") == "@dimen/touch_target_min"


def test_updated_androidx_nullability_keeps_event_invitation_attachment_failure_safe():
    fragment = read("android/app/src/main/java/io/silentsuite/sync/ui/etebase/CollectionItemFragment.kt")
    invitation = read("android/app/src/main/java/io/silentsuite/sync/utils/EventEmailInvitation.kt")

    assert "fun createIntent(event: Event, icsContent: String): Intent?" in invitation
    assert "intent?.let(::startActivity)" in fragment
