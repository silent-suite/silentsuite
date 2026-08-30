"""Contracts for safe calendar invitation attachment sharing."""

from pathlib import Path
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
INVITATION_SOURCE = ROOT / (
    "android/app/src/main/java/io/silentsuite/sync/utils/EventEmailInvitation.kt"
)
PROVIDER_PATHS = ROOT / "android/app/src/main/res/xml/log_paths.xml"


def test_calendar_invitation_cache_directory_is_narrowly_authorized():
    paths = ET.parse(PROVIDER_PATHS).getroot()
    cache_paths = {
        entry.attrib["name"]: entry.attrib["path"]
        for entry in paths.findall("cache-path")
    }

    assert cache_paths["calendar-invitations"] == "calendar-invitations/"
    assert "." not in cache_paths.values()


def test_attachment_failures_are_non_fatal_to_calendar_sync():
    source = INVITATION_SOURCE.read_text(encoding="utf-8")

    assert 'File(context.cacheDir, "calendar-invitations")' in source
    assert "catch (e: IOException)" in source
    assert "catch (e: IllegalArgumentException)" in source
