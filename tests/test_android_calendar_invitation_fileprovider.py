"""Contracts for safe calendar invitation attachment sharing."""

from pathlib import Path
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
PROVIDER_PATHS = ROOT / "android/app/src/main/res/xml/log_paths.xml"


def test_calendar_invitation_cache_directory_is_narrowly_authorized():
    paths = ET.parse(PROVIDER_PATHS).getroot()
    cache_paths = {
        entry.attrib["name"]: entry.attrib["path"]
        for entry in paths.findall("cache-path")
    }

    assert all(entry.tag == "cache-path" for entry in paths)
    assert cache_paths == {
        "debug-info": "debug-info/",
        "calendar-invitations": "calendar-invitations/",
    }
    for path in cache_paths.values():
        assert path not in {"", ".", "./", "/"}
        assert ".." not in Path(path).parts
