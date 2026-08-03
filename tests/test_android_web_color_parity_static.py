"""Exact static contracts for the Android/web color-parity boundary."""

from hashlib import sha256
from pathlib import Path
import json
import re
import subprocess
import xml.etree.ElementTree as ET
import yaml


ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android/app/src/main/res"
WEB = ROOT / "apps/web/app/globals.css"

WEB_ROLES = {
    "semantic_background": ("#FCFDFF", "#0A1018"),
    "semantic_surface": ("#F3F5F9", "#111B27"),
    "semantic_on_surface": ("#111B27", "#D9DFE8"),
    "semantic_primary": ("#10B981", "#34D399"),
    "semantic_secondary_action": ("#059669", "#10B981"),
    "semantic_on_surface_variant": ("#475569", "#A3B3C9"),
    "semantic_outline": ("#C8D2DE", "#253549"),
}
STATE_ROLES = {
    "semantic_on_primary": ("#0A1018", "#0A1018"),
    "semantic_success": ("#047857", "#34D399"),
    "semantic_on_success": ("#FFFFFF", "#0A1018"),
    "semantic_warning": ("#B45309", "#FBBF24"),
    "semantic_on_warning": ("#FFFFFF", "#0A1018"),
    "semantic_error": ("#B91C1C", "#FCA5A5"),
    "semantic_on_error": ("#FFFFFF", "#0A1018"),
    "semantic_focus": ("#047857", "#10B981"),
    "semantic_selected_container": ("#1F10B981", "#2934D399"),
    "semantic_disabled_content": ("#A3A7AD", "#595F67"),
    "semantic_disabled_container": ("#E0E2E5", "#232931"),
}
MATERIAL_SUPPORTING_ROLES = {
    "semantic_surface_variant": ("#E7EBF0", "#1B2838"),
    "semantic_outline_variant": ("#DCE3EB", "#35465A"),
    "semantic_primary_container": ("#D1FAE5", "#064E3B"),
    "semantic_on_primary_container": ("#064E3B", "#D1FAE5"),
    "semantic_secondary_action": ("#059669", "#10B981"),
    "semantic_on_secondary": ("#FFFFFF", "#0A1018"),
    "semantic_secondary_container": ("#D1FAE5", "#064E3B"),
    "semantic_on_secondary_container": ("#064E3B", "#D1FAE5"),
    "semantic_error": ("#B91C1C", "#FCA5A5"),
    "semantic_on_error": ("#FFFFFF", "#0A1018"),
    "semantic_error_container": ("#FEE2E2", "#7F1D1D"),
    "semantic_on_error_container": ("#7F1D1D", "#FEE2E2"),
    "semantic_inverse_surface": ("#1B2838", "#D9DFE8"),
    "semantic_inverse_on_surface": ("#FFFFFF", "#111B27"),
    "semantic_inverse_primary": ("#34D399", "#059669"),
    "semantic_system_bar": ("#0A1018", "#0A1018"),
    "semantic_on_system_bar": ("#FFFFFF", "#FFFFFF"),
}
ALIASES = {
    "errorColor": "semantic_error", "nav_header_email": "semantic_primary",
    "nav_header_subtitle": "semantic_on_surface_variant", "infoColor": "semantic_surface_variant",
    "light_green500": "semantic_primary", "light_green700": "semantic_secondary_action",
    "orange400": "semantic_primary", "orangeA700": "semantic_primary",
    "primaryColor": "semantic_primary", "primaryLightColor": "semantic_primary_container",
    "primaryDarkColor": "semantic_system_bar", "secondaryColor": "semantic_secondary_action",
    "secondaryLightColor": "semantic_secondary_container", "secondaryDarkColor": "semantic_secondary_action",
    "primaryTextColor": "semantic_on_primary", "preference_fallback_accent_color": "semantic_primary",
}
IMMUTABLE_HASHES = {
    "drawable/ic_silentsuite_arrows_on_light.xml": "628894800a83fe637dad241616917e88c0e393dbebbb3e18a72c0158bddc784b",
    "drawable/ic_silentsuite_arrows_on_navy.xml": "7276913ebc7372a2488105beb4a61699bb696d5645e1b9ccd66b4f5fc15e9972",
    "values/ic_launcher_background.xml": "06eaa9032eea6ea92c0110c66cf58c748b723899d5b9037d559a7119b6fd01a5",
}
HASH_LOCKED_XML = frozenset(IMMUTABLE_HASHES)
HEX_LITERAL = re.compile(r"#[0-9A-Fa-f]{3,8}\b")
COLOR_REFERENCE = re.compile(r"^@color/([A-Za-z0-9_]+)$")
RAW_PALETTE = frozenset({
    "navy900", "navy800", "navy700", "navy600", "navy100",
    "teal500", "teal400", "teal600", "teal700", "grey200", "grey700",
    "white", "offwhite",
})
SEMANTIC_RESOURCES = frozenset({
    "semantic_background", "semantic_surface", "semantic_on_surface",
    "semantic_on_surface_variant", "semantic_outline", "semantic_surface_variant",
    "semantic_outline_variant", "semantic_primary", "semantic_secondary_action",
    "semantic_on_primary", "semantic_primary_container", "semantic_on_primary_container",
    "semantic_on_secondary", "semantic_secondary_container", "semantic_on_secondary_container",
    "semantic_success", "semantic_on_success", "semantic_warning", "semantic_on_warning",
    "semantic_error", "semantic_on_error", "semantic_error_container",
    "semantic_on_error_container", "semantic_focus", "semantic_selected_container",
    "semantic_disabled_content", "semantic_disabled_container", "semantic_inverse_surface",
    "semantic_inverse_on_surface", "semantic_inverse_primary", "semantic_system_bar",
    "semantic_on_system_bar",
})
LOGO_VECTORS = frozenset({
    "drawable/ic_silentsuite_arrows_on_light.xml",
    "drawable/ic_silentsuite_arrows_on_navy.xml",
})
TRANSPARENT_ALLOWLIST = frozenset({
    ("drawable/bg_setup_step_upcoming.xml", "solid", "{http://schemas.android.com/apk/res/android}color"),
    ("drawable/nav_account_row_background.xml", "item", "{http://schemas.android.com/apk/res/android}drawable"),
    ("values/styles.xml", "item", "text"),
    ("layout/account_list.xml", "ListView", "{http://schemas.android.com/apk/res/android}divider"),
    ("layout/account_list.xml", "ListView", "{http://schemas.android.com/apk/res/android}background"),
    ("layout/account_list.xml", "ListView", "{http://schemas.android.com/apk/res/android}cacheColorHint"),
})
DISABLED_CONTRAST_EXCEPTIONS = {
    "semantic_disabled_content": "disabled text is intentionally exempt from active-text contrast",
    "semantic_disabled_container": "disabled fills are intentionally exempt from active-control contrast",
}


def colors(qualifier: str) -> dict[str, str]:
    root = ET.parse(RES / qualifier / "colors.xml").getroot()
    return {entry.attrib["name"]: (entry.text or "").strip().upper() for entry in root.findall("color")}


def styles(qualifier: str) -> dict[str, dict[str, str]]:
    root = ET.parse(RES / qualifier / "themes.xml").getroot()
    return {style.attrib["name"]: {item.attrib["name"]: (item.text or "").strip() for item in style.findall("item")} for style in root.findall("style")}


def resource_styles(qualifier: str) -> dict[str, dict[str, str]]:
    root = ET.parse(RES / qualifier / "styles.xml").getroot()
    return {style.attrib["name"]: {item.attrib["name"]: (item.text or "").strip() for item in style.findall("item")} for style in root.findall("style")}


def source(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def java_method_body(text: str, signature: str) -> str:
    start = text.index(signature)
    opening = text.index("{", start)
    depth = 0
    for index in range(opening, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[opening + 1:index]
    raise AssertionError(f"unterminated Java method: {signature}")


def xml_files() -> list[Path]:
    files = sorted(RES.rglob("*.xml"))
    assert len(files) == 183, f"expected 183 Android resource XML files, found {len(files)}"
    return files


def local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1]


def location(path: Path, element: ET.Element, attribute: str, value: str) -> str:
    return f"{path.relative_to(RES).as_posix()}:{local_name(element.tag)}:{local_name(attribute)}={value}"


def opaque_rgb(value: str) -> tuple[float, float, float]:
    assert re.fullmatch(r"#[0-9A-F]{6}", value), value
    return tuple(int(value[index:index + 2], 16) / 255 for index in (1, 3, 5))


def relative_luminance(value: str) -> float:
    def linear(channel: float) -> float:
        return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4

    red, green, blue = (linear(channel) for channel in opaque_rgb(value))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(foreground: str, background: str) -> float:
    lighter, darker = sorted((relative_luminance(foreground), relative_luminance(background)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def test_web_roles_and_android_semantics_are_exact_in_day_and_night():
    web = WEB.read_text(encoding="utf-8")
    for value in {value for pair in WEB_ROLES.values() for value in pair}:
        rgb = " ".join(str(int(value[index:index + 2], 16)) for index in (1, 3, 5))
        assert rgb in web, value
    day, night = colors("values"), colors("values-night")
    for roles in (WEB_ROLES, MATERIAL_SUPPORTING_ROLES, STATE_ROLES):
        for name, (light, dark) in roles.items():
            assert day.get(name) == light, (name, day.get(name), light)
            assert night.get(name) == dark, (name, night.get(name), dark)


def test_material3_used_roles_and_closed_aliases_are_explicit():
    required = {
        "android:colorBackground": "semantic_background",
        "colorOnBackground": "semantic_on_surface", "colorSurface": "semantic_surface",
        "colorOnSurface": "semantic_on_surface", "colorSurfaceVariant": "semantic_surface_variant",
        "colorOnSurfaceVariant": "semantic_on_surface_variant", "colorOutline": "semantic_outline",
        "colorOutlineVariant": "semantic_outline_variant", "colorPrimary": "semantic_primary",
        "colorOnPrimary": "semantic_on_primary", "colorPrimaryContainer": "semantic_primary_container",
        "colorOnPrimaryContainer": "semantic_on_primary_container", "colorSecondary": "semantic_secondary_action",
        "colorOnSecondary": "semantic_on_secondary", "colorSecondaryContainer": "semantic_secondary_container",
        "colorOnSecondaryContainer": "semantic_on_secondary_container", "colorError": "semantic_error",
        "colorOnError": "semantic_on_error", "colorErrorContainer": "semantic_error_container",
        "colorOnErrorContainer": "semantic_on_error_container", "colorSurfaceInverse": "semantic_inverse_surface",
        "colorOnSurfaceInverse": "semantic_inverse_on_surface", "colorPrimaryInverse": "semantic_inverse_primary",
    }
    for qualifier in ("values", "values-night"):
        for theme in ("AppTheme.Material3", "AppTheme.Material3.NoActionBar"):
            actual = styles(qualifier)[theme]
            assert "colorBackground" not in actual
            for attr, role in required.items():
                assert actual.get(attr) == f"@color/{role}", (qualifier, theme, attr, actual.get(attr))
            assert actual.get("materialAlertDialogTheme") == "@style/AppTheme.Dialog.Alert"
            assert actual.get("alertDialogTheme") == "@style/AppTheme.Dialog.Alert"
    for qualifier in ("values", "values-night"):
        declared = colors(qualifier)
        assert {name: declared.get(name) for name in ALIASES} == {name: f"@COLOR/{role.upper()}" for name, role in ALIASES.items()}
    resources = "\n".join(path.read_text(encoding="utf-8") for path in RES.rglob("*.xml"))
    assert "colorInverseSurface" not in resources
    assert "colorInverseOnSurface" not in resources
    assert "colorInversePrimary" not in resources


def test_text_input_refresh_and_system_bar_mechanics_are_bounded():
    for path in (RES / "color/login_input_stroke.xml", RES / "color-night/login_input_stroke.xml"):
        text = path.read_text(encoding="utf-8")
        assert "state_error" not in text
        assert 'state_focused="true"' in text and 'state_hovered="true"' in text and 'state_enabled="true"' in text
        assert "@color/semantic_focus" in text and "@color/semantic_outline" in text and "@color/semantic_disabled_content" in text
    for path in ("values/styles.xml", "values-night/styles.xml"):
        assert "<item name=\"boxStrokeErrorColor\">@color/semantic_error</item>" in source(f"android/app/src/main/res/{path}")
    expected_text_input = {
        "boxBackgroundColor": "@color/semantic_surface",
        "shapeAppearance": "@style/ShapeAppearance.AppTheme.Material3.Standard",
        "boxStrokeColor": "@color/login_input_stroke",
        "boxStrokeErrorColor": "@color/semantic_error",
        "boxStrokeWidthFocused": "2dp",
    }
    for qualifier in ("values", "values-night"):
        assert resource_styles(qualifier)["Widget.AppTheme.Material3.TextInputLayout"] == expected_text_input
    assert 'app:boxStrokeErrorColor="@color/semantic_error"' in source("android/app/src/main/res/layout/login_encryption_details.xml")
    for path in ("android/app/src/main/java/io/silentsuite/sync/ui/AccountActivity.kt", "android/app/src/main/java/io/silentsuite/sync/ui/etebase/ListEntriesFragment.kt"):
        body = source(path)
        assert "setColorSchemeResources(" in body
        assert "R.color.semantic_primary" in body
        assert "ContextCompat.getColor" not in body.split("setColorSchemeResources(", 1)[1].split(")", 1)[0]
    base = source("android/app/src/main/java/io/silentsuite/sync/ui/BaseActivity.kt")
    for token in ("Build.VERSION.SDK_INT >= 35", "WindowInsetsCompat.Type.statusBars()", "WindowInsetsCompat.Type.navigationBars()", "setStatusBarContrastEnforced(false)", "setNavigationBarContrastEnforced(false)"):
        assert token in base
    for token in (
        "insets.top > 0", "insets.left > 0", "insets.right > 0", "insets.bottom > 0",
        "android.view.Gravity.LEFT", "android.view.Gravity.RIGHT", "android.view.Gravity.NO_GRAVITY",
        "FrameLayout.LayoutParams(insets.left, -1, edge)",
        "FrameLayout.LayoutParams(insets.right, -1, edge)",
        "FrameLayout.LayoutParams(0, 0, edge)",
    ):
        assert token in base
    assert "Gravity.START" not in base and "Gravity.END" not in base
    status_edges, navigation_edges = base.split("val edge = if (statusBar) {", 1)[1].split("return when (edge)", 1)[0].split("} else {", 1)
    assert status_edges.index("insets.top > 0") < status_edges.index("insets.left > 0") < status_edges.index("insets.right > 0") < status_edges.index("insets.bottom > 0")
    assert navigation_edges.index("insets.bottom > 0") < navigation_edges.index("insets.left > 0") < navigation_edges.index("insets.right > 0") < navigation_edges.index("insets.top > 0")


def test_every_android_resource_xml_obeys_the_closed_color_contract():
    allowed_hex_files = {"values/colors.xml", "values-night/colors.xml", "values/ic_launcher_background.xml"}
    alias_declarations = {"values/colors.xml", "values-night/colors.xml"}
    found_transparent = set()
    found_alias_declarations = {name: set() for name in ALIASES}

    day_names = set(colors("values"))
    night_names = set(colors("values-night"))
    assert day_names == RAW_PALETTE | SEMANTIC_RESOURCES | set(ALIASES)
    assert night_names == SEMANTIC_RESOURCES | set(ALIASES)

    for path in xml_files():
        relative = path.relative_to(RES).as_posix()
        root = ET.parse(path).getroot()
        for element in root.iter():
            values = [*element.attrib.items()]
            if (element.text or "").strip():
                values.append(("text", element.text.strip()))
            for attribute, value in values:
                where = location(path, element, attribute, value)
                assert not (HEX_LITERAL.search(value) and relative not in allowed_hex_files), where
                assert value.lower() not in {"@android:color/white", "@android:color/black"}, where
                assert not value.startswith("/semantic_"), where
                assert not value.startswith("@color@color/"), where

                if value == "@android:color/transparent":
                    key = (relative, local_name(element.tag), attribute)
                    assert key in TRANSPARENT_ALLOWLIST, where
                    found_transparent.add(key)

                reference = COLOR_REFERENCE.fullmatch(value)
                if reference:
                    name = reference.group(1)
                    assert not (name in RAW_PALETTE and relative not in LOGO_VECTORS), where
                    assert name not in ALIASES, where

            if local_name(element.tag) == "color" and element.attrib.get("name") in ALIASES:
                name = element.attrib["name"]
                assert relative in alias_declarations, location(path, element, "name", name)
                found_alias_declarations[name].add(relative)

    assert found_transparent == TRANSPARENT_ALLOWLIST, (found_transparent, TRANSPARENT_ALLOWLIST)
    assert all(locations == alias_declarations for locations in found_alias_declarations.values()), found_alias_declarations


def test_theme_color_resources_resolve_in_both_day_and_night_and_meet_contrast_contract():
    day, night = colors("values"), colors("values-night")
    theme_references = {}
    for qualifier in ("values", "values-night"):
        references = {
            match.group(1)
            for match in re.finditer(r"@color/([A-Za-z0-9_]+)", (RES / qualifier / "themes.xml").read_text(encoding="utf-8"))
        }
        theme_references[qualifier] = references
        for name in references:
            assert name in day, (qualifier, name, "missing day color")
            assert name in night, (qualifier, name, "missing night color")
    assert theme_references["values"] == theme_references["values-night"]

    for qualifier, declared in (("values", day), ("values-night", night)):
        for fill, on_color in (
            ("semantic_primary", "semantic_on_primary"),
            ("semantic_success", "semantic_on_success"),
            ("semantic_warning", "semantic_on_warning"),
            ("semantic_error", "semantic_on_error"),
        ):
            ratio = contrast_ratio(declared[fill], declared[on_color])
            assert ratio >= 4.5, (qualifier, fill, on_color, ratio)
        for background in ("semantic_background", "semantic_surface"):
            ratio = contrast_ratio(declared["semantic_focus"], declared[background])
            assert ratio >= 3, (qualifier, "semantic_focus", background, ratio)

    # Disabled content and fills intentionally preserve the reviewed disabled-state exception.
    assert set(DISABLED_CONTRAST_EXCEPTIONS) == {"semantic_disabled_content", "semantic_disabled_container"}


def test_context_aware_vector_roles_and_tint_consumers_are_exact():
    system_bar_icons = {
        "ic_delete_light": (
            "menu/fragment_edit_collection.xml",
            "menu/activity_edit_collection.xml",
        ),
        "ic_edit_light": (
            "menu/fragment_view_collection.xml",
            "menu/activity_view_collection.xml",
        ),
        "ic_email_light": (
            "menu/collection_item_fragment.xml",
            "menu/activity_journal_item.xml",
        ),
        "ic_help_light": ("menu/activity_login.xml",),
        "ic_members_light": (
            "menu/fragment_view_collection.xml",
            "menu/activity_view_collection.xml",
        ),
        "ic_restore_light": (
            "menu/collection_item_fragment.xml",
            "menu/activity_journal_item.xml",
        ),
        "ic_save_light": (
            "menu/fragment_edit_collection.xml",
            "menu/activity_create_collection.xml",
            "menu/activity_edit_collection.xml",
        ),
        "ic_share_light": ("menu/activity_debug_info.xml",),
        "ic_sync_light": (
            "menu/activity_account.xml",
            "menu/activity_accounts_drawer.xml",
        ),
    }
    surface_icons = {
        "ic_event_light": ("res/layout/activity_account.xml",),
        "ic_people_light": ("res/layout/activity_account.xml", "res/menu/activity_accounts_drawer.xml"),
        "ic_task_light": ("res/layout/activity_account.xml",),
        "ic_file_white": ("java/io/silentsuite/sync/ui/importlocal/ImportActivity.kt",),
        "ic_menu_light": ("java/io/silentsuite/sync/ui/AccountActivity.kt",),
    }

    for icon, consumers in system_bar_icons.items():
        vector = ET.parse(RES / f"drawable/{icon}.xml").getroot()
        assert {path.attrib.get("{http://schemas.android.com/apk/res/android}fillColor") for path in vector.findall("path")} == {"@color/semantic_on_system_bar"}, icon
        for consumer in consumers:
            assert f"@drawable/{icon}" in source(f"android/app/src/main/res/{consumer}"), (icon, consumer)

    for icon, consumers in surface_icons.items():
        vector = ET.parse(RES / f"drawable/{icon}.xml").getroot()
        assert {path.attrib.get("{http://schemas.android.com/apk/res/android}fillColor") for path in vector.findall("path")} == {"@color/semantic_on_surface"}, icon
        for consumer in consumers:
            assert icon in source(f"android/app/src/main/{consumer}"), (icon, consumer)

    account_vector = ET.parse(RES / "drawable/ic_account_circle_white.xml").getroot()
    assert {path.attrib.get("{http://schemas.android.com/apk/res/android}fillColor") for path in account_vector.findall("path")} == {"@color/semantic_on_surface"}
    account_item = source("android/app/src/main/res/layout/account_list_item.xml")
    assert 'android:background="@drawable/ic_account_circle_white"' in account_item
    assert 'android:backgroundTint="@color/semantic_on_primary"' in account_item
    assert 'card_view:cardBackgroundColor="@color/semantic_primary"' in account_item
    assert 'android:textColor="@color/semantic_on_primary"' in account_item

    import_item = source("android/app/src/main/res/layout/import_actions_list_item.xml")
    assert 'android:id="@+id/action_icon"' in import_item
    assert 'app:tint="@color/semantic_on_surface"' in import_item
    assert 'android:tint="@color/semantic_on_surface"' not in import_item
    assert "R.drawable.ic_file_white" in source("android/app/src/main/java/io/silentsuite/sync/ui/importlocal/ImportActivity.kt")
    assert "R.drawable.ic_account_circle_white" in source("android/app/src/main/java/io/silentsuite/sync/ui/importlocal/ImportActivity.kt")


def test_immutable_assets_and_runtime_ledger_ownership_are_exact():
    for relative, expected in IMMUTABLE_HASHES.items():
        assert sha256((RES / relative).read_bytes()).hexdigest() == expected
    ledger = json.loads(source("android/scripts/focused-runtime-ledger-v1.json"))
    methods = ledger["tests"] if "tests" in ledger else ledger
    rendered = json.dumps(methods)
    for method in ("dayNightRolesRecreateDeterministically", "systemBarProtectionMatchesApiAndInsets", "repeatedInsetDispatchIsIdempotentAndDoesNotMoveContent"):
        assert method in rendered
    runner = source("android/scripts/run-focused-runtime-tests.sh")
    for count in ("84", "82", "40"):
        assert count in runner


def test_credential_free_evidence_and_runtime_routes_are_explicit():
    runtime = source("android/app/src/androidTest/java/io/silentsuite/sync/ui/ColorParityRuntimeTest.kt")
    for method in (
        "dayNightRolesRecreateDeterministically",
        "systemBarProtectionMatchesApiAndInsets",
        "repeatedInsetDispatchIsIdempotentAndDoesNotMoveContent",
    ):
        assert f"@Test fun {method}" in runtime
    assert "AppCompatDelegate.setDefaultNightMode" in runtime
    assert "scenario.recreate()" in runtime
    assert "STATUS_BAR_SCRIM_TAG" in runtime and "NAVIGATION_BAR_SCRIM_TAG" in runtime
    for token in (
        "private fun expectedScrimBounds", "insets.left > 0", "insets.right > 0",
        "Rect(0, 0, insets.left, decor.height)",
        "Rect(decor.width - insets.right, 0, decor.width, decor.height)", "else -> Rect()",
    ):
        assert token in runtime

    screenshots = source("android/app/src/androidTest/java/io/silentsuite/screenshots/StoreScreenshotsTest.java")
    parity_body = java_method_body(screenshots, "public void testParityEvidence()")
    assert "AppSettingsActivity.Companion.newIntent(targetContext)" in parity_body
    assert "settings_category_appearance" in screenshots
    assert parity_body.count("scenario.recreate();") == 2
    for ready, light, dark in (
        ("waitForAbout", "parity-m3-about-light", "parity-m3-about-dark"),
        ("waitForGlobalSettings", "parity-legacy-app-settings-light", "parity-legacy-app-settings-dark"),
    ):
        assert f'{ready}(scenario);\n                capture("{light}");' in parity_body
        dark_route = (
            "AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES);\n"
            "                scenario.recreate();\n"
            f"                {ready}(scenario);\n"
            f'                capture("{dark}");'
        )
        assert dark_route in parity_body
    assert parity_body.count("AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO);") == 2

    workflow = source(".github/workflows/build-android.yml")
    parity_job = yaml.safe_load(workflow)["jobs"]["color-parity-evidence"]
    parity_step = next(step for step in parity_job["steps"] if step.get("id") == "parity-evidence")
    parity_command = parity_step["with"]["script"]
    assert parity_command == "bash android/scripts/run-color-parity-evidence.sh"
    subprocess.run(["/usr/bin/dash", "-n", "-c", parity_command], check=True)
    parity_script = source("android/scripts/run-color-parity-evidence.sh")
    subprocess.run(["bash", "-n", "android/scripts/run-color-parity-evidence.sh"], cwd=ROOT, check=True)
    assert parity_script.startswith("#!/usr/bin/env bash\nset -euo pipefail\n")
    assert 'evidence_nonce="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-color-parity}"' in parity_script
    assert '[[ "$evidence_nonce" =~ ^[A-Za-z0-9._-]+$ ]]' in parity_script
    assert 'remote_evidence_dir="/sdcard/Android/data/io.silentsuite.android/files/color-parity-evidence/$evidence_nonce"' in parity_script
    assert 'local_evidence_dir="build/color-parity-evidence"' in parity_script
    instrumentation = "./gradlew app:connectedDebugAndroidTest"
    assert "adb shell rm -rf" not in parity_script
    assert parity_script.count("set +e") == 1
    assert parity_script.index("set +e") < parity_script.index(instrumentation)
    assert parity_script.index("instrumentation_status=$?") > parity_script.index(instrumentation)
    assert parity_script.index("set -e\n", parity_script.index("instrumentation_status=$?")) > parity_script.index("instrumentation_status=$?")
    for name in (
        "parity-m3-about-light.png", "parity-m3-about-dark.png",
        "parity-legacy-app-settings-light.png", "parity-legacy-app-settings-dark.png",
    ):
        assert name in parity_script
    assert 'if ! adb pull "$remote_evidence_dir/$name" "$local_evidence_dir/$name"; then' in parity_script
    assert '[[ ! -s "$local_evidence_dir/$name" ]]' in parity_script
    assert "missing_evidence=1" in parity_script
    metadata = parity_script.index("parity-metadata.json")
    instrumentation_failure = parity_script.index('if [[ "$instrumentation_status" -ne 0 ]]; then')
    missing_failure = parity_script.index('if [[ "$missing_evidence" -ne 0 ]]; then')
    assert metadata < instrumentation_failure < missing_failure
    assert 'exit "$instrumentation_status"' in parity_script
    assert 'exit 1' in parity_script[missing_failure:]
    parity_upload = next(step for step in parity_job["steps"] if step.get("name") == "Upload color parity evidence")
    assert parity_upload["if"] == "always()"
    assert parity_upload["with"]["name"] == "android-color-parity-evidence-${{ github.sha }}"

    focused_job = yaml.safe_load(workflow)["jobs"]["account-recreation-runtime"]
    focused_step = next(step for step in focused_job["steps"] if step.get("id") == "focused-runtime")
    focused_command = focused_step["with"]["script"]
    assert focused_command == 'bash android/scripts/run-focused-runtime-with-navigation.sh "${{ matrix.api-level }}" "${{ matrix.shard }}" "${{ matrix.navigation-mode }}"'
    subprocess.run(["/usr/bin/dash", "-n", "-c", focused_command], check=True)
    focused_script = source("android/scripts/run-focused-runtime-with-navigation.sh")
    subprocess.run(["bash", "-n", "android/scripts/run-focused-runtime-with-navigation.sh"], cwd=ROOT, check=True)
    runner = 'exec bash "$(dirname "$0")/run-focused-runtime-tests.sh" "$api_level" "$shard"'

    assert focused_step["uses"].startswith("ReactiveCircus/android-emulator-runner@")
    assert focused_script.startswith("#!/usr/bin/env bash\nset -euo pipefail\n")
    assert 'navigation_mode="$3"' in focused_script
    assert 'if [[ -n "$navigation_mode" ]]; then' in focused_script
    for command in (
        "adb shell cmd overlay enable com.android.internal.systemui.navbar.gestural",
        "adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton",
        "adb shell settings get secure navigation_mode",
    ):
        assert command in focused_script
        assert focused_script.index(command) < focused_script.index(runner)
    assert focused_script.rstrip().endswith(runner)
    assert all(step.get("name") != "Configure required system navigation mode" for step in focused_job["steps"])
    assert "expected_sizes={'21:mixed':1,'21:remaining':83,'35:all':84,'36:account-dashboard':27,'36:first-run-setup':17,'36:status-routes':40}" in workflow
    runner_source = source("android/scripts/run-focused-runtime-tests.sh")
    assert '"21:remaining": 82' in runner_source
