"""Golden item-format corpus tests.

Consumes the shared ICS/VCF fixture corpus at packages/core/fixtures/item-format/
(the item-format contract test bed — see its README.md). The same files and
manifest expectations are consumed by the packages/core Vitest suite
(src/utils/item-format-fixtures.test.ts).

The bridge parses items with vobject (its production parser via Radicale), so
these tests assert that vobject recovers the same logical values the manifest
pins: CATEGORIES labels, TZID/timezone semantics, recurrence metadata, and
escaped text.
"""

import datetime
import json
from pathlib import Path

import pytest
import vobject


def _find_corpus_dir() -> Path:
    """Resolve the corpus repo-relatively so pytest works from bridge/ or repo root."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages" / "core" / "fixtures" / "item-format"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError(
        "packages/core/fixtures/item-format not found in any parent directory; "
        "the golden corpus tests require a full monorepo checkout"
    )


CORPUS_DIR = _find_corpus_dir()

with (CORPUS_DIR / "manifest.json").open(encoding="utf-8") as _f:
    MANIFEST = json.load(_f)

FIXTURES = MANIFEST["fixtures"]


def _read_fixture(rel_path: str) -> str:
    return (CORPUS_DIR / rel_path).read_text(encoding="utf-8")


def _local_stamp(dt: datetime.datetime) -> str:
    """Wall-clock time of an aware datetime, in iCalendar basic format."""
    return dt.strftime("%Y%m%dT%H%M%S")


def _tzid_param(prop) -> str:
    """TZID of a date-time property; vobject renames it after resolving the tz."""
    params = prop.params.get("TZID") or prop.params.get("X-VOBJ-ORIGINAL-TZID")
    assert params, f"property {prop.name} lost its TZID parameter"
    return params[0]


# ---------------------------------------------------------------------------
# Corpus completeness
# ---------------------------------------------------------------------------


def test_manifest_matches_files_on_disk():
    on_disk = sorted(
        f"{sub}/{p.name}"
        for sub in ("ics", "vcf")
        for p in (CORPUS_DIR / sub).iterdir()
        if p.suffix in (".ics", ".vcf")
    )
    in_manifest = sorted(fixture["path"] for fixture in FIXTURES)
    assert in_manifest == on_disk


def test_corpus_covers_contract_dimensions():
    covered = {tag for fixture in FIXTURES for tag in fixture["covers"]}
    for dimension in ("categories", "tzid", "rrule", "exdate", "escaping"):
        assert dimension in covered, f"corpus lost coverage of {dimension!r}"


# ---------------------------------------------------------------------------
# Expectation dispatch — every manifest key must be handled explicitly, and an
# unknown key fails the suite so corpus and consumers cannot drift silently.
# ---------------------------------------------------------------------------


def _assert_vevent(event, expected: dict) -> None:
    for key, value in expected.items():
        if key == "uid":
            assert event.uid.value == value
        elif key == "summary":
            assert event.summary.value == value
        elif key == "description":
            assert event.description.value == value
        elif key == "location":
            assert event.location.value == value
        elif key == "status":
            assert event.status.value == value
        elif key == "categories":
            assert event.categories.value == value
        elif key == "rrule":
            assert event.rrule.value == value
        elif key == "dtstartUtc":
            dt = event.dtstart.value
            assert dt.utcoffset() == datetime.timedelta(0)
            assert _local_stamp(dt) + "Z" == value
        elif key == "dtendUtc":
            dt = event.dtend.value
            assert dt.utcoffset() == datetime.timedelta(0)
            assert _local_stamp(dt) + "Z" == value
        elif key == "dtstartLocal":
            assert _local_stamp(event.dtstart.value) == value
        elif key == "dtendLocal":
            assert _local_stamp(event.dtend.value) == value
        elif key == "exdateLocal":
            assert [_local_stamp(dt) for dt in event.exdate.value] == value
        elif key == "tzid":
            assert _tzid_param(event.dtstart) == value
            assert _tzid_param(event.dtend) == value
            assert _tzid_param(event.exdate) == value
        elif key == "utcOffsetMinutes":
            offset = datetime.timedelta(minutes=value)
            assert event.dtstart.value.utcoffset() == offset
            assert event.dtend.value.utcoffset() == offset
        else:
            raise AssertionError(f"unhandled expected key {key!r} for a vevent fixture")


def _assert_vtodo(todo, expected: dict) -> None:
    for key, value in expected.items():
        if key == "uid":
            assert todo.uid.value == value
        elif key == "summary":
            assert todo.summary.value == value
        elif key == "description":
            assert todo.description.value == value
        elif key == "dueUtc":
            dt = todo.due.value
            assert dt.utcoffset() == datetime.timedelta(0)
            assert _local_stamp(dt) + "Z" == value
        elif key == "priority":
            assert int(todo.priority.value) == value
        elif key == "status":
            assert todo.status.value == value
        elif key == "percentComplete":
            assert int(todo.percent_complete.value) == value
        elif key == "categories":
            assert todo.categories.value == value
        else:
            raise AssertionError(f"unhandled expected key {key!r} for a vtodo fixture")


def _tel_props(card):
    return card.contents.get("tel", [])


def _assert_vcard(card, expected: dict, raw: str) -> None:
    for key, value in expected.items():
        if key == "uid":
            assert card.uid.value == value
        elif key == "fn":
            assert card.fn.value == value
        elif key == "n":
            name = card.n.value
            assert name.family == value["family"]
            assert name.given == value["given"]
            assert name.prefix == value.get("prefix", "")
            assert name.suffix == value.get("suffix", "")
        elif key == "org":
            # vobject exposes ORG as a list of organizational units
            assert card.org.value == [value]
        elif key == "title":
            assert card.title.value == value
        elif key == "note":
            assert card.note.value == value
        elif key == "categories":
            assert card.categories.value == value
        elif key == "email":
            parsed = [
                {"type": (prop.params.get("TYPE") or ["other"])[0].lower(), "value": prop.value}
                for prop in card.contents.get("email", [])
            ]
            for expected_email in value:
                assert expected_email in parsed
        elif key == "tel":
            parsed = [
                {"type": (prop.params.get("TYPE") or ["other"])[0].lower(), "value": prop.value}
                for prop in _tel_props(card)
            ]
            for expected_tel in value:
                assert expected_tel in parsed
        elif key == "telUri":
            # Pins the raw on-the-wire TEL;VALUE=uri form; vobject keeps the URI verbatim.
            assert f"TEL;VALUE=uri:{value}" in raw
            assert value in [prop.value for prop in _tel_props(card)]
        elif key == "telNumber":
            # The normalized number is the core parser's contract; the bridge
            # keeps the URI form, so the digits must survive inside it.
            assert any(value in prop.value for prop in _tel_props(card))
        elif key == "cellNumber":
            cells = [
                prop.value
                for prop in _tel_props(card)
                if "cell" in [t.lower() for t in prop.params.get("TYPE", [])]
            ]
            assert value in cells
        elif key == "favorite":
            props = [
                prop
                for name, values in card.contents.items()
                if name.split(".")[-1].lower() == "x-silentsuite-favorite"
                for prop in values
            ]
            assert any(prop.value == "1" for prop in props) is value
        else:
            raise AssertionError(f"unhandled expected key {key!r} for a vcard fixture")


@pytest.mark.parametrize(
    ("lines", "expected"),
    [
        ([], False),
        (["X-SILENTSUITE-FAVORITE:0"], False),
        (["X-SILENTSUITE-FAVORITE:true"], False),
        (["item1.X-SILENTSUITE-FAVORITE;TYPE=pref:1"], True),
        (["X-SILENTSUITE-FAVORITE:0", "x-silentsuite-favorite:1"], True),
        (["X-SILENTSUITE-FAVORITE:", " 1"], True),
    ],
)
def test_favorite_boolean_semantics_survive_vobject(lines, expected):
    raw = "\r\n".join(["BEGIN:VCARD", "VERSION:4.0", "UID:fav", "FN:Favorite", *lines, "END:VCARD"])
    serialized = vobject.readOne(raw).serialize()
    unfolded = serialized.replace("\r\n ", "").replace("\n ", "")
    values = []
    for line in unfolded.splitlines():
        name, separator, value = line.partition(":")
        normalized = name.split(";", 1)[0].split(".")[-1].upper()
        if separator and normalized == "X-SILENTSUITE-FAVORITE":
            values.append(value)
    assert any(value == "1" for value in values) is expected


# ---------------------------------------------------------------------------
# Fixture-driven parse tests
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda fixture: fixture["path"])
def test_fixture_parses_to_expected_contract_fields(fixture):
    raw = _read_fixture(fixture["path"])
    parsed = vobject.readOne(raw)

    kind = fixture["kind"]
    if kind == "vevent":
        _assert_vevent(parsed.vevent, fixture["expected"])
    elif kind == "vtodo":
        _assert_vtodo(parsed.vtodo, fixture["expected"])
    elif kind == "vcard":
        _assert_vcard(parsed, fixture["expected"], raw)
    else:
        raise AssertionError(f"unhandled fixture kind {kind!r}")


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda fixture: fixture["path"])
def test_fixture_survives_vobject_serialization(fixture):
    """The bridge round-trips items through vobject when syncing (storage.py),
    so serialization must not corrupt contract fields either."""
    raw = _read_fixture(fixture["path"])
    reparsed = vobject.readOne(vobject.readOne(raw).serialize())

    kind = fixture["kind"]
    if kind == "vevent":
        _assert_vevent(reparsed.vevent, fixture["expected"])
    elif kind == "vtodo":
        _assert_vtodo(reparsed.vtodo, fixture["expected"])
    elif kind == "vcard":
        # Raw-wire form assertions only apply to the original fixture bytes.
        expected = {k: v for k, v in fixture["expected"].items() if k != "telUri"}
        _assert_vcard(reparsed, expected, raw)
