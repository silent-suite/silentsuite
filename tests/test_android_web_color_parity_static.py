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
WEB_ROLE_VARIABLES = {
    "semantic_background": "background",
    "semantic_surface": "surface",
    "semantic_on_surface": "foreground",
    "semantic_primary": "primary",
    "semantic_secondary_action": "primary-hover",
    "semantic_on_surface_variant": "muted",
    "semantic_outline": "border",
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
    "semantic_action_text": ("#047857", "#34D399"),
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
HEX_VALUE = re.compile(r"^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")
COLOR_REFERENCE = re.compile(r"^@color/([A-Za-z0-9_]+)$")
THEME_COLOR_REFERENCE = re.compile(r"^\?(?:android:)?attr/[A-Za-z0-9_]+$")
RAW_PALETTE = frozenset({
    "navy900", "navy800", "navy700", "navy600", "navy100",
    "teal500", "teal400", "teal600", "teal700", "grey200", "grey700",
    "white", "offwhite",
})
SEMANTIC_RESOURCES = frozenset({
    "semantic_background", "semantic_surface", "semantic_on_surface",
    "semantic_on_surface_variant", "semantic_outline", "semantic_surface_variant",
    "semantic_outline_variant", "semantic_primary", "semantic_secondary_action", "semantic_action_text",
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


def valid_color_slot_value(value: str) -> bool:
    return bool(
        COLOR_REFERENCE.fullmatch(value)
        or value == "@android:color/transparent"
        or THEME_COLOR_REFERENCE.fullmatch(value)
        or (HEX_VALUE.fullmatch(value) and value.upper() != "#00000000")
    )


def _skip_string(css: str, start: int) -> int:
    """Return the index just past the string token that starts at start."""
    quote = css[start]
    index = start + 1
    while index < len(css):
        char = css[index]
        if char == "\\":
            index += 2
        elif char == quote:
            return index + 1
        else:
            index += 1
    return len(css)


def _skip_escape(css: str, start: int) -> int:
    """start points at a backslash; return the index just past the escape."""
    n = len(css)
    index = start + 1
    if index >= n:
        return n
    if css[index] in "0123456789abcdefABCDEF":
        while index < n and index - start - 1 < 6 and css[index] in "0123456789abcdefABCDEF":
            index += 1
        if index < n and css[index] in " \t\r\n\f":
            index += 1
    else:
        index += 1
    return index


def _decode_css_identifier(raw: str) -> str:
    """Decode CSS identifier escapes (hex and simple) to their logical codepoints."""
    decoded: list[str] = []
    index = 0
    while index < len(raw):
        char = raw[index]
        if char != "\\":
            decoded.append(char)
            index += 1
            continue
        index += 1
        if index >= len(raw):
            break
        codepoint = 0
        hex_digits = 0
        while index < len(raw) and hex_digits < 6 and raw[index] in "0123456789abcdefABCDEF":
            codepoint = codepoint * 16 + int(raw[index], 16)
            hex_digits += 1
            index += 1
        if hex_digits:
            if index < len(raw) and raw[index] in " \t\r\n\f":
                index += 1
            if codepoint == 0 or 0xD800 <= codepoint <= 0xDFFF or codepoint > 0x10FFFF:
                codepoint = 0xFFFD
            decoded.append(chr(codepoint))
        else:
            decoded.append(raw[index])
            index += 1
    return "".join(decoded)


def _strip_comments(css: str) -> str:
    """Replace CSS comments with a single space, leaving strings and escapes intact."""
    out: list[str] = []
    index = 0
    while index < len(css):
        char = css[index]
        if char in "\"'":
            quote = char
            out.append(char)
            index += 1
            while index < len(css):
                current = css[index]
                if current == "\\":
                    out.append(current)
                    index += 1
                    if index < len(css):
                        out.append(css[index])
                        index += 1
                elif current == quote:
                    out.append(current)
                    index += 1
                    break
                else:
                    out.append(current)
                    index += 1
            continue
        if char == "/" and index + 1 < len(css) and css[index + 1] == "*":
            end = css.find("*/", index + 2)
            if end == -1:
                out.append(" ")
                return "".join(out)
            out.append(" ")
            index = end + 2
            continue
        if char == "\\":
            out.append(char)
            index += 1
            if index < len(css):
                out.append(css[index])
                index += 1
            continue
        out.append(char)
        index += 1
    return "".join(out)


def _top_level_blocks(css: str) -> list[tuple[str, str]]:
    """Split comment-stripped CSS into top-level (selector, body) blocks.

    Brace scanning is string/escape aware so a brace hidden inside a string or
    an escape cannot terminate a block early.
    """
    blocks: list[tuple[str, str]] = []
    statement_start = 0
    block_start = 0
    selector = ""
    depth = 0
    index = 0
    while index < len(css):
        char = css[index]
        if char in "\"'":
            index = _skip_string(css, index)
        elif char == "\\":
            index = _skip_escape(css, index)
        elif char == ";" and depth == 0:
            statement_start = index + 1
            index += 1
        elif char == "{":
            if depth == 0:
                selector = css[statement_start:index].strip()
                block_start = index + 1
            depth += 1
            index += 1
        elif char == "}":
            assert depth > 0, ("unexpected closing brace", index)
            depth -= 1
            if depth == 0:
                blocks.append((selector, css[block_start:index]))
                statement_start = index + 1
            index += 1
        else:
            index += 1
    assert depth == 0, "unterminated CSS block"
    return blocks


def _find_matching_close(css: str, open_index: int) -> int:
    """open_index points at '{'; return the index of its matching '}'."""
    depth = 1
    index = open_index + 1
    while index < len(css):
        char = css[index]
        if char in "\"'":
            index = _skip_string(css, index)
        elif char == "\\":
            index = _skip_escape(css, index)
        elif char == "{":
            depth += 1
            index += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
            index += 1
        else:
            index += 1
    raise AssertionError("unterminated nested CSS block")


def _scan_statement_end(css: str, start: int) -> int:
    """Scan from start (string/escape aware) until ';', '{', or '}'."""
    index = start
    while index < len(css):
        char = css[index]
        if char in "\"'":
            index = _skip_string(css, index)
        elif char == "\\":
            index = _skip_escape(css, index)
        elif char in ";{}":
            return index
        else:
            index += 1
    return len(css)


def _read_ident(css: str, start: int) -> tuple[str, int]:
    """Read a maximal CSS identifier starting at start; return (raw, index_after)."""
    index = start
    first = True
    while index < len(css):
        char = css[index]
        if char == "\\":
            index = _skip_escape(css, index)
            first = False
        elif first:
            if char == "-":
                nxt = css[index + 1] if index + 1 < len(css) else ""
                if nxt == "" or nxt == "-" or nxt == "_" or nxt == "\\" or nxt >= "\x80" or nxt.isalpha():
                    index += 1
                    first = False
                else:
                    break
            elif char == "_" or char.isalpha() or char >= "\x80":
                index += 1
                first = False
            else:
                break
        elif char == "_" or char == "-" or char.isalnum() or char >= "\x80":
            index += 1
        else:
            break
    return css[start:index], index


def _parse_body(body: str) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Parse a comment-stripped rule body into (declarations, nested_blocks).

    Declarations are (decoded_name, value); nested_blocks are (selector, body).
    Nested rule/at-rule blocks are descended into by the caller.
    """
    declarations: list[tuple[str, str]] = []
    nested: list[tuple[str, str]] = []
    index = 0
    while index < len(body):
        char = body[index]
        if char in " \t\r\n\f;":
            index += 1
            continue
        statement_start = index
        if char == "{":
            close = _find_matching_close(body, index)
            nested.append((body[statement_start:index].strip(), body[index + 1:close]))
            index = close + 1
            continue
        if char == "@":
            end = _scan_statement_end(body, index)
            if end < len(body) and body[end] == "{":
                close = _find_matching_close(body, end)
                nested.append((body[statement_start:end].strip(), body[end + 1:close]))
                index = close + 1
            else:
                index = end + 1
            continue
        if char == "\\" or char == "-" or char == "_" or char.isalpha() or char >= "\x80":
            raw, after = _read_ident(body, index)
            if after == index:
                index += 1
                continue
            colon = after
            while colon < len(body) and body[colon] in " \t\r\n\f":
                colon += 1
            if colon < len(body) and body[colon] == ":":
                value_end = _scan_statement_end(body, colon + 1)
                if value_end < len(body) and body[value_end] == "{":
                    close = _find_matching_close(body, value_end)
                    nested.append((body[statement_start:value_end].strip(), body[value_end + 1:close]))
                    index = close + 1
                else:
                    declarations.append((_decode_css_identifier(raw), body[colon + 1:value_end].strip()))
                    index = value_end + 1 if value_end < len(body) else value_end
                continue
            end = _scan_statement_end(body, index)
            if end < len(body) and body[end] == "{":
                close = _find_matching_close(body, end)
                nested.append((body[statement_start:end].strip(), body[end + 1:close]))
                index = close + 1
            else:
                index = end + 1 if end < len(body) else len(body)
            continue
        index += 1
    return declarations, nested


def web_role_variable_values(css: str) -> tuple[dict[str, str], dict[str, str]]:
    """Parse the two canonical token blocks and reject any competing declaration.

    The brace scanner is string/escape aware and declaration names are decoded
    with CSS escape rules, so escaped names that normalize to a monitored
    variable (e.g. -\\-background, --back\\67 round) still fail closed.
    """
    css = _strip_comments(css)
    top_level_blocks = _top_level_blocks(css)
    monitored = {f"--{variable}" for variable in WEB_ROLE_VARIABLES.values()}

    light_block = None
    dark_block = None
    for actual_selector, body in top_level_blocks:
        if actual_selector == ":root":
            assert light_block is None, "duplicate :root block"
            light_block = body
        elif actual_selector == ".dark":
            assert dark_block is None, "duplicate .dark block"
            dark_block = body
    assert light_block is not None, "missing canonical :root block"
    assert dark_block is not None, "missing canonical .dark block"

    def canonical_dict(block: str) -> dict[str, str]:
        pairs, _nested = _parse_body(block)
        names = [name for name, _value in pairs]
        assert len(names) == len(set(names)), ("duplicate declaration in canonical block", names)
        return {
            name[len("--"):] if name.startswith("--") else name: " ".join(value.split())
            for name, value in pairs
        }

    light = canonical_dict(light_block)
    dark = canonical_dict(dark_block)

    monitored_counts: dict[str, int] = {}

    def walk(block: str) -> None:
        declarations, nested_blocks = _parse_body(block)
        for name, _value in declarations:
            if name in monitored:
                monitored_counts[name] = monitored_counts.get(name, 0) + 1
        for _selector, nested_body in nested_blocks:
            walk(nested_body)

    for _selector, body in top_level_blocks:
        walk(body)

    for name in monitored:
        assert monitored_counts.get(name) == 2, (name, monitored_counts.get(name))

    for variable, (light_hex, dark_hex) in (
        (WEB_ROLE_VARIABLES[role], WEB_ROLES[role]) for role in WEB_ROLE_VARIABLES
    ):
        expected_light = " ".join(str(int(light_hex[index:index + 2], 16)) for index in (1, 3, 5))
        expected_dark = " ".join(str(int(dark_hex[index:index + 2], 16)) for index in (1, 3, 5))
        assert light.get(variable) == expected_light, (variable, "light", light.get(variable))
        assert dark.get(variable) == expected_dark, (variable, "dark", dark.get(variable))

    return light, dark


def test_web_roles_and_android_semantics_are_exact_in_day_and_night():
    web = WEB.read_text(encoding="utf-8")
    light_variables, dark_variables = web_role_variable_values(web)
    for role, variable in WEB_ROLE_VARIABLES.items():
        light, dark = WEB_ROLES[role]
        expected_light = " ".join(str(int(light[index:index + 2], 16)) for index in (1, 3, 5))
        expected_dark = " ".join(str(int(dark[index:index + 2], 16)) for index in (1, 3, 5))
        assert light_variables.get(variable) == expected_light, (role, variable, "light")
        assert dark_variables.get(variable) == expected_dark, (role, variable, "dark")
    workflow = source(".github/workflows/build-android.yml")
    assert workflow.count("- 'apps/web/app/globals.css'") == 2
    day, night = colors("values"), colors("values-night")
    for roles in (WEB_ROLES, MATERIAL_SUPPORTING_ROLES, STATE_ROLES):
        for name, (light, dark) in roles.items():
            assert day.get(name) == light, (name, day.get(name), light)
            assert night.get(name) == dark, (name, night.get(name), dark)


def test_web_role_parser_accepts_formatting_but_rejects_effective_overrides():
    web = WEB.read_text(encoding="utf-8")
    base = web_role_variable_values(web)
    reformatted = web.replace(":root {", "  :root{").replace(".dark {", "\n  .dark{")
    assert web_role_variable_values(reformatted) == base

    harmless = (
        'html:root { content: "}"; }',
        'html:root { content: "{"; }',
        "html:root { --sx-color-primary: rgb(var(--primary)); }",
    )
    for block in harmless:
        assert web_role_variable_values(f"{web}\n{block}\n") == base, block

    overrides = (
        ":root{--background: 0 0 0;}",
        ":root, html { --background: 0 0 0; }",
        ".dark { --primary: 0 0 0; }",
        "html:root { --background: 0 0 0; }",
        "html:root { -\\-background: 0 0 0; }",
        "html:root { --back\\67 round: 0 0 0; }",
        "html:root { --\\62 ackground: 0 0 0; }",
        ":ro\\6ft { --background: 0 0 0; }",
        'html:root { content: "}"; --background: 0 0 0; }',
        'html:root { content: "{"; --background: 0 0 0; }',
        "html:root { --background: 0 0 \\}; }",
        "html:root { --background: 0 0 0\\7d; }",
        "html:root { & { -\\-background: 0 0 0; } }",
        "@media (prefers-color-scheme: dark) { html:root { --background: 0 0 0; } }",
    )
    for override in overrides:
        try:
            web_role_variable_values(f"{web}\n{override}\n")
        except AssertionError:
            continue
        raise AssertionError(f"effective web-token override was accepted: {override}")


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
        dialog = resource_styles(qualifier)["AppTheme.Dialog.Alert"]
        for attr, role in {
            "colorOnPrimary": "semantic_on_primary",
            "colorOnSecondary": "semantic_on_secondary",
            "colorError": "semantic_error",
            "colorOnError": "semantic_on_error",
            "colorErrorContainer": "semantic_error_container",
            "colorOnErrorContainer": "semantic_on_error_container",
        }.items():
            assert dialog.get(attr) == f"@color/{role}", (qualifier, attr, dialog.get(attr))
        assert resource_styles(qualifier)["AppTheme.Dialog.Button"]["android:textColor"] == "@color/button_secondary_text"
    resources = "\n".join(path.read_text(encoding="utf-8") for path in RES.rglob("*.xml"))
    assert "colorInverseSurface" not in resources
    assert "colorInverseOnSurface" not in resources
    assert "colorInversePrimary" not in resources


def test_text_input_refresh_and_system_bar_mechanics_are_bounded():
    for path in (RES / "color/login_input_stroke.xml", RES / "color-night/login_input_stroke.xml"):
        text = path.read_text(encoding="utf-8")
        assert "state_error" not in text
        assert 'state_focused="true"' in text and 'state_hovered="true"' in text and 'state_enabled="true"' in text
        assert "@color/semantic_focus" in text and "@color/semantic_on_surface_variant" in text and "@color/semantic_disabled_content" in text
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
        "statusBarScrims: Map<Int, View>", "navigationBarScrims: Map<Int, View>",
        "FrameLayout.LayoutParams(-1, insets.top, gravity)",
        "FrameLayout.LayoutParams(-1, insets.bottom, gravity)",
        "FrameLayout.LayoutParams(insets.left, -1, gravity)",
        "FrameLayout.LayoutParams(insets.right, -1, gravity)",
        "FrameLayout.LayoutParams(0, 0, Gravity.NO_GRAVITY)",
        "statusBarScrims.forEach", "navigationBarScrims.forEach",
    ):
        assert token in base
    assert "Gravity.START" not in base and "Gravity.END" not in base
    for gravity, suffix in (("TOP", "top"), ("BOTTOM", "bottom"), ("LEFT", "left"), ("RIGHT", "right")):
        assert f'Gravity.{gravity} to "{suffix}"' in base
    assert "ViewCompat.onApplyWindowInsets(view, insets)" in base
    assert "applyContentInsets()" in base
    assert "override fun onContentChanged()" in base
    assert "override fun onPostCreate(savedInstanceState: Bundle?)" in base
    assert "WindowInsetsCompat.Type.displayCutout()" in base
    assert "insets.inset(safeDrawing)" in base


def test_every_android_resource_xml_obeys_the_closed_color_contract():
    allowed_hex_files = {"values/colors.xml", "values-night/colors.xml", "values/ic_launcher_background.xml"}
    alias_declarations = {"values/colors.xml", "values-night/colors.xml"}
    found_transparent = set()
    found_alias_declarations = {name: set() for name in ALIASES}

    day_names = set(colors("values"))
    night_names = set(colors("values-night"))
    file_color_names = {
        path.stem
        for directory in (RES / "color", RES / "color-night")
        if directory.exists()
        for path in directory.glob("*.xml")
    }
    declared_color_names = {
        element.attrib["name"]
        for path in xml_files()
        for element in ET.parse(path).getroot().iter()
        if local_name(element.tag) == "color" and "name" in element.attrib
    }
    available_color_names = day_names | night_names | file_color_names | declared_color_names
    assert day_names == RAW_PALETTE | SEMANTIC_RESOURCES | set(ALIASES)
    assert night_names == SEMANTIC_RESOURCES | set(ALIASES)
    for malformed in (
        "@color/semantic_primary/extra",
        "@color /semantic_primary",
        "@android:color/not_real",
        "garbage",
        "#123456789",
        "#00000000",
    ):
        assert not valid_color_slot_value(malformed), malformed

    for path in xml_files():
        relative = path.relative_to(RES).as_posix()
        root = ET.parse(path).getroot()
        for element in root.iter():
            values = [*element.attrib.items()]
            if (element.text or "").strip():
                values.append(("text", element.text.strip()))
            for attribute, value in values:
                where = location(path, element, attribute, value)
                if "#" in value:
                    assert HEX_VALUE.fullmatch(value), where
                    assert relative in allowed_hex_files, where
                    assert value.upper() != "#00000000", where
                assert value.lower() not in {"@android:color/white", "@android:color/black"}, where
                assert not value.startswith("/semantic_"), where
                assert not value.startswith("@color@color/"), where

                reference = COLOR_REFERENCE.fullmatch(value)
                if value.startswith("@color"):
                    assert reference is not None, where
                    assert reference.group(1) in available_color_names, where
                if value.startswith("@android:color"):
                    assert value == "@android:color/transparent", where
                if local_name(element.tag) == "color" and attribute == "text":
                    assert HEX_VALUE.fullmatch(value) or reference is not None, where
                slot = local_name(attribute)
                if local_name(element.tag) == "item" and attribute == "text":
                    slot = element.attrib.get("name", "")
                if "color" in slot.lower() or "tint" in slot.lower():
                    assert valid_color_slot_value(value), where

                if value == "@android:color/transparent":
                    key = (relative, local_name(element.tag), attribute)
                    assert key in TRANSPARENT_ALLOWLIST, where
                    found_transparent.add(key)

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
            action_ratio = contrast_ratio(declared["semantic_action_text"], declared[background])
            assert action_ratio >= 4.5, (qualifier, "semantic_action_text", background, action_ratio)
            control_ratio = contrast_ratio(declared["semantic_on_surface_variant"], declared[background])
            assert control_ratio >= 3, (qualifier, "semantic_on_surface_variant", background, control_ratio)
            for icon_role in ("semantic_warning", "semantic_error"):
                icon_ratio = contrast_ratio(declared[icon_role], declared[background])
                assert icon_ratio >= 3, (qualifier, icon_role, background, icon_ratio)

    for selector in ("buttontext.xml", "button_secondary_text.xml"):
        assert "@color/semantic_action_text" in source(f"android/app/src/main/res/color/{selector}")
    for layout in (
        "nav_header_accounts.xml",
        "contact_info_item_group.xml",
        "activity_post_login_setup.xml",
    ):
        assert "@color/semantic_action_text" in source(f"android/app/src/main/res/layout/{layout}")
    for layout in ("account_collection_item.xml", "activity_account.xml"):
        root = ET.parse(RES / "layout" / layout).getroot()
        text_colors = {
            element.attrib.get("{http://schemas.android.com/apk/res/android}textColor")
            for element in root.iter()
        }
        assert "@color/semantic_outline" not in text_colors
        assert "@color/semantic_on_surface_variant" in source(f"android/app/src/main/res/layout/{layout}")
    assert resource_styles("values")["login_link"]["android:textColor"] == "@color/semantic_action_text"
    for vector in ("action_add", "ic_calendar_outline", "ic_check", "ic_contacts_outline", "ic_tasks_outline"):
        assert "@color/semantic_action_text" in source(f"android/app/src/main/res/drawable/{vector}.xml")
    # Persistent icon vectors must not root-multiply alpha after semantic tints/filters.
    # Dashboard status icons, collection indicators, and action glyphs are color-filtered
    # or tinted at runtime; residual android:alpha="0.54" drops effective contrast below 3:1.
    for path in sorted((ROOT / "android/app/src/main/res/drawable").glob("*.xml")):
        body = path.read_text(encoding="utf-8")
        assert "android:alpha" not in body, path.as_posix()
    for vector in ("action_change", "action_delete", "ic_error_dark", "ic_members_dark", "ic_readonly_dark"):
        assert "android:alpha" not in source(f"android/app/src/main/res/drawable/{vector}.xml")
    # Dashboard status tone foregrounds must use accessible action/variant roles, not
    # outline/primary, because they are painted over surface by setColorFilter + setTextColor.
    account_activity = source("android/app/src/main/java/io/silentsuite/sync/ui/AccountActivity.kt")
    assert "R.color.semantic_on_surface_variant" in account_activity
    assert "R.color.semantic_action_text" in account_activity
    assert "AccountDashboardTone.NEUTRAL -> R.color.semantic_on_surface_variant" in account_activity
    assert "AccountDashboardTone.PRIMARY -> R.color.semantic_action_text" in account_activity
    assert "R.color.semantic_outline" not in account_activity
    assert "AccountDashboardTone.PRIMARY -> R.color.semantic_primary" not in account_activity
    styles = resource_styles("values")
    for style in (
        "Widget.AppTheme.Material3.Card",
        "Widget.AppTheme.Dashboard.ServiceCard",
        "Widget.AppTheme.Dashboard.CollectionCard",
    ):
        assert styles[style]["strokeColor"] == "@color/semantic_on_surface_variant"
    assert styles["Widget.AppTheme.Dashboard.CollectionToolbar"]["navigationIconTint"] == "@color/semantic_action_text"
    assert "@color/semantic_on_surface_variant" in source("android/app/src/main/res/drawable/bg_setup_step_upcoming.xml")

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
    assert "fun systemBarProtectionMatchesApiAndInsets() =" not in runtime
    assert "fun repeatedInsetDispatchIsIdempotentAndDoesNotMoveContent() =" not in runtime
    assert "AppCompatDelegate.setDefaultNightMode" in runtime
    assert "runOnMainSync { AppCompatDelegate.setDefaultNightMode(mode) }" in runtime
    assert "scenario.recreate()" in runtime
    assert "assertRoles(it, dayRoles)" in runtime and "assertRoles(it, nightRoles)" in runtime
    for role in SEMANTIC_RESOURCES:
        assert runtime.count(f"R.color.{role}") >= 2, role
    assert "STATUS_BAR_SCRIM_TAG" in runtime and "NAVIGATION_BAR_SCRIM_TAG" in runtime
    for token in (
        "private fun expectedScrimBounds", "private fun assertScrimSet",
        "Rect(0, 0, insets.left, decor.height)",
        "Rect(decor.width - insets.right, 0, decor.width, decor.height)",
        "isStatusBarContrastEnforced", "isNavigationBarContrastEnforced",
        "SYSTEM_UI_FLAG_LIGHT_STATUS_BAR", "SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR",
    ):
        assert token in runtime
    base_activity = source("android/app/src/main/java/io/silentsuite/sync/ui/BaseActivity.kt")
    assert "statusBarScrims: Map<Int, View>" in base_activity
    assert "navigationBarScrims: Map<Int, View>" in base_activity
    assert "private fun assertContentInsets" in runtime
    assert "content.paddingBounds()" in runtime
    for suffix in ("top", "bottom", "left", "right"):
        assert f'Gravity.{suffix.upper()} to "{suffix}"' in base_activity

    screenshots = source("android/app/src/androidTest/java/io/silentsuite/screenshots/StoreScreenshotsTest.java")
    assert "requireSafeScreenshotDir" in screenshots
    assert 'nonce.matches("[A-Za-z0-9._-]+")' in screenshots
    assert '".".equals(nonce)' in screenshots and '"..".equals(nonce)' in screenshots
    assert 'executeShellCommand("mkdir -p " + screenshotDir)' not in screenshots
    assert 'executeShellCommand("mkdir -p " + DEFAULT_CAPTURE_DIR)' in screenshots
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
            "setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_YES);\n"
            "                scenario.recreate();\n"
            f"                {ready}(scenario);\n"
            f'                capture("{dark}");'
        )
        assert dark_route in parity_body
    assert parity_body.count("setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_NO);") == 2
    assert "runOnMainSync" in screenshots

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
    assert "-Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true" in parity_script
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
        "adb shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.gestural",
        "adb shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton",
        "adb shell settings get secure navigation_mode",
    ):
        assert command in focused_script
        assert focused_script.index(command) < focused_script.index(runner)
    assert "for _ in {1..10}; do" in focused_script
    assert focused_script.rstrip().endswith(runner)
    assert all(step.get("name") != "Configure required system navigation mode" for step in focused_job["steps"])
    assert "expected_sizes={'21:mixed':1,'21:remaining':83,'35:all':84,'36:account-dashboard':27,'36:first-run-setup':17,'36:status-routes':40}" in workflow
    runner_source = source("android/scripts/run-focused-runtime-tests.sh")
    assert '"21:remaining": 82' in runner_source
