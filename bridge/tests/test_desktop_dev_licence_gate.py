"""S2 (#171) bundle-facts collector and licence/notice/source gate: logic contracts.

Contract (s2-delivery-plan-v8, section 5). The future helpers are plain scripts:
- bridge/dev-build/collect_bundle_facts.py
    collect(bundle_root, modules, search_path) -> facts dict (schema_version 1)
    CLI: --dist DIR --workpath DIR --out FILE  (exit 0 written, 2 unreadable input)
- bridge/dev-build/licence_gate.py
    check(facts, policy, archive_root, source_dir) -> list of failure strings
    CLI: --facts F --policy P --archive-root DIR --source-dir DIR (exit 0 pass, 1 fail, 2 unreadable)

Every fixture here is SYNTHETIC. A passing synthetic "complete" bundle proves
only the checker logic. It certifies nothing about real Qt/PySide6 or other
vendor contents, notices or source availability; those come only from the real
collector run and a reviewed policy.

Missing helpers are one explicit RED case; the cases needing them are NOT
REACHED (fixture setup errors), never import or collection errors.
Runs only where SILENTSUITE_REQUIRE_DESKTOP_DEV=1 (test-bridge-desktop-dev.yml).
"""

import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path

import pytest

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
DEV_BUILD = BRIDGE_ROOT / "dev-build"
COLLECTOR = DEV_BUILD / "collect_bundle_facts.py"
GATE = DEV_BUILD / "licence_gate.py"
REQUIRE_ENV = "SILENTSUITE_REQUIRE_DESKTOP_DEV"

DIST = "fakeqt"  # synthetic distribution; not a real package
DIST_VERSION = "6.12.0"
QT_LIBRARY = "Qt6Fake.dll"
LICENCE_TEXT = "SYNTHETIC LGPL TEXT FOR GATE LOGIC TESTS ONLY\n"
PROMINENT = "uses Qt and PySide6 under the GNU LGPL"


def _require():
    if os.environ.get(REQUIRE_ENV) != "1":
        pytest.skip("dev build contracts run only in test-bridge-desktop-dev.yml")


def _sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode("utf-8")).hexdigest()


def _load_helper(path, name):
    if not path.is_file():
        pytest.fail(f"NOT REACHED: {path.relative_to(BRIDGE_ROOT)} does not exist yet")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def collector():
    _require()
    return _load_helper(COLLECTOR, "collect_bundle_facts")


@pytest.fixture(scope="module")
def gate():
    _require()
    return _load_helper(GATE, "licence_gate")


def _site(root):
    """A synthetic installed distribution: dist-info with METADATA, RECORD and LICENSE."""
    site = root / "site"
    package = site / DIST
    info = site / f"{DIST}-{DIST_VERSION}.dist-info"
    package.mkdir(parents=True)
    info.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / QT_LIBRARY).write_bytes(b"synthetic-qt-library")
    (info / "LICENSE").write_text(LICENCE_TEXT, encoding="utf-8")
    (info / "METADATA").write_text(
        f"Metadata-Version: 2.1\nName: {DIST}\nVersion: {DIST_VERSION}\nLicense: LGPL-3.0-only\n"
        "Classifier: License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)\n",
        encoding="utf-8",
    )
    (info / "RECORD").write_text(
        f"{DIST}/__init__.py,,\n{DIST}/{QT_LIBRARY},,\n{info.name}/LICENSE,,\n{info.name}/METADATA,,\n{info.name}/RECORD,,\n",
        encoding="utf-8",
    )
    return site


def _bundle(root):
    """A synthetic onedir bundle: one mapped Qt library and one runtime file."""
    bundle = root / "bundle"
    (bundle / "_internal" / DIST).mkdir(parents=True)
    (bundle / "_internal" / DIST / QT_LIBRARY).write_bytes(b"synthetic-qt-library")
    (bundle / "_internal" / "python310.dll").write_bytes(b"synthetic-runtime")
    return bundle


def _facts():
    return {
        "schema_version": 1,
        "bundle_files": [
            {"path": f"_internal/{DIST}/{QT_LIBRARY}", "sha256": _sha(b"synthetic-qt-library"), "size": 20},
            {"path": "_internal/python310.dll", "sha256": _sha(b"synthetic-runtime"), "size": 17},
        ],
        "distributions": [{
            "name": DIST, "version": DIST_VERSION, "license": "LGPL-3.0-only", "license_expression": None,
            "license_classifiers": ["License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)"],
            "license_files": [{"path": "LICENSE", "sha256": _sha(LICENCE_TEXT), "text": LICENCE_TEXT}],
            "bundle_files": [f"_internal/{DIST}/{QT_LIBRARY}"], "modules": [DIST],
        }],
        "stdlib_modules": ["json"],
        "unmapped_modules": [],
        "unmapped_files": ["_internal/python310.dll"],
        "qt_libraries": [f"_internal/{DIST}/{QT_LIBRARY}"],
    }


SOURCE_BYTES = b"synthetic source archive"


def _policy():
    return {
        "schema_version": 1,
        "allowed_licences": ["LGPL-3.0-only", "PSF-2.0"],
        "licence_texts": {"LGPL-3.0-only": "NOTICES/LGPL-3.0.txt", "PSF-2.0": "NOTICES/PSF-2.0.txt"},
        "distributions": {DIST: {"version": DIST_VERSION, "licence": "LGPL-3.0-only"}},
        "runtime_files": [{"pattern": "_internal/python3*.dll", "owner": "CPython", "licence": "PSF-2.0"}],
        "qt_libraries": {QT_LIBRARY: "LGPL-3.0-only"},
        "required_notices": ["NOTICES/LGPL-3.0.txt", "NOTICES/GPL-3.0.txt", "NOTICES/AGPL-3.0.txt"],
        "prominent_notice": {"file": "README-dev-build.txt", "must_contain": PROMINENT},
        "source_archives": [{"name": DIST, "version": DIST_VERSION, "file": f"{DIST}-{DIST_VERSION}-src.tar.xz",
                             "sha256": _sha(SOURCE_BYTES)}],
        "relinking": {"admitted": True, "instructions": "NOTICES/RELINKING.txt",
                      "determination": "NOTICES/INSTALLATION-INFORMATION.txt"},
    }


def _archive(root):
    """A synthetic archive root and source directory matching _facts/_policy."""
    archive = root / "archive"
    notices = archive / "NOTICES"
    (notices / DIST).mkdir(parents=True)
    for name in ("LGPL-3.0.txt", "GPL-3.0.txt", "AGPL-3.0.txt", "PSF-2.0.txt", "RELINKING.txt",
                 "INSTALLATION-INFORMATION.txt"):
        (notices / name).write_text(f"synthetic {name}\n", encoding="utf-8")
    (notices / DIST / "LICENSE").write_text(LICENCE_TEXT, encoding="utf-8")
    (archive / "README-dev-build.txt").write_text(f"Experimental. This build {PROMINENT}.\n", encoding="utf-8")
    sources = root / "sources"
    sources.mkdir()
    (sources / f"{DIST}-{DIST_VERSION}-src.tar.xz").write_bytes(SOURCE_BYTES)
    return archive, sources


# --- control and RED -------------------------------------------------------------


def test_control_synthetic_distribution_is_discoverable(tmp_path):
    # Fixture control: the synthetic site directory is a valid installed
    # distribution for importlib.metadata. Not a collector or gate result.
    _require()
    found = {d.metadata["Name"]: d for d in importlib.metadata.distributions(path=[str(_site(tmp_path))])}
    assert set(found) == {DIST} and found[DIST].version == DIST_VERSION
    assert any(str(f).endswith(QT_LIBRARY) for f in found[DIST].files)


def test_collector_and_licence_gate_helpers_exist():
    _require()
    missing = [str(p.relative_to(BRIDGE_ROOT)) for p in (COLLECTOR, GATE) if not p.is_file()]
    assert not missing, f"dev-build helpers are missing: {missing}"


# --- collector logic (NOT REACHED until the collector exists) ---------------------


def test_collector_maps_files_and_modules_and_keeps_licence_texts(collector, tmp_path):
    site, bundle = _site(tmp_path), _bundle(tmp_path)
    facts = collector.collect(bundle, [DIST, "json", "mystery_module"], [str(site)])
    assert facts["schema_version"] == 1
    files = {entry["path"]: entry for entry in facts["bundle_files"]}
    assert files[f"_internal/{DIST}/{QT_LIBRARY}"]["sha256"] == _sha(b"synthetic-qt-library")
    dists = {entry["name"]: entry for entry in facts["distributions"]}
    assert dists[DIST]["version"] == DIST_VERSION
    assert dists[DIST]["license_files"] == [{"path": "LICENSE", "sha256": _sha(LICENCE_TEXT), "text": LICENCE_TEXT}]
    assert f"_internal/{DIST}/{QT_LIBRARY}" in dists[DIST]["bundle_files"]
    assert facts["unmapped_files"] == ["_internal/python310.dll"]  # reported, never guessed
    assert facts["unmapped_modules"] == ["mystery_module"]
    assert "json" in facts["stdlib_modules"]
    assert facts["qt_libraries"] == [f"_internal/{DIST}/{QT_LIBRARY}"]


# --- gate logic (NOT REACHED until the gate exists) -------------------------------


def test_gate_passes_only_a_complete_synthetic_fixture(gate, tmp_path):
    archive, sources = _archive(tmp_path)
    assert gate.check(_facts(), _policy(), archive, sources) == []


def _mutations():
    def drop_notice(facts, policy, archive, sources):
        (archive / "NOTICES" / "GPL-3.0.txt").unlink()

    def altered_preserved_text(facts, policy, archive, sources):
        (archive / "NOTICES" / DIST / "LICENSE").write_text("same filename, different text\n", encoding="utf-8")

    def filename_only_facts(facts, policy, archive, sources):
        facts["distributions"][0]["license_files"] = [{"path": "LICENSE"}]

    def unmapped_file(facts, policy, archive, sources):
        facts["unmapped_files"].append("_internal/libunknown.so")

    def unmapped_module(facts, policy, archive, sources):
        facts["unmapped_modules"].append("mystery_module")

    def unknown_distribution(facts, policy, archive, sources):
        del policy["distributions"][DIST]

    def version_mismatch(facts, policy, archive, sources):
        policy["distributions"][DIST]["version"] = "6.11.0"

    def licence_not_allowed(facts, policy, archive, sources):
        policy["distributions"][DIST]["licence"] = "GPL-3.0-only"

    def qt_library_unreviewed(facts, policy, archive, sources):
        policy["qt_libraries"] = {}

    def missing_source(facts, policy, archive, sources):
        (sources / f"{DIST}-{DIST_VERSION}-src.tar.xz").unlink()

    def source_mismatch(facts, policy, archive, sources):
        (sources / f"{DIST}-{DIST_VERSION}-src.tar.xz").write_bytes(b"different bytes")

    def relinking_not_admitted(facts, policy, archive, sources):
        policy["relinking"]["admitted"] = False

    def relinking_text_missing(facts, policy, archive, sources):
        (archive / "NOTICES" / "INSTALLATION-INFORMATION.txt").unlink()

    def no_prominent_notice(facts, policy, archive, sources):
        (archive / "README-dev-build.txt").write_text("Experimental.\n", encoding="utf-8")

    def wrong_schema(facts, policy, archive, sources):
        facts["schema_version"] = 2

    return [drop_notice, altered_preserved_text, filename_only_facts, unmapped_file, unmapped_module,
            unknown_distribution, version_mismatch, licence_not_allowed, qt_library_unreviewed, missing_source,
            source_mismatch, relinking_not_admitted, relinking_text_missing, no_prominent_notice, wrong_schema]


@pytest.mark.parametrize("mutate", _mutations(), ids=lambda f: f.__name__)
def test_gate_fails_closed_on_each_missing_or_mismatched_requirement(gate, tmp_path, mutate):
    facts, policy = json.loads(json.dumps(_facts())), json.loads(json.dumps(_policy()))
    archive, sources = _archive(tmp_path)
    mutate(facts, policy, archive, sources)
    failures = gate.check(facts, policy, archive, sources)
    assert isinstance(failures, list) and failures, f"{mutate.__name__} was not refused"
