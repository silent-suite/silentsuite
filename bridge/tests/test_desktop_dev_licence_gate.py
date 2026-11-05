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
import pprint
import subprocess
import sys
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


# --- C2: collector evidence corrections (tests first) ------------------------------
#
# Interfaces exercised (all existing): collect(bundle_root, modules, search_path)
# and the CLI main(["--dist", D, "--workpath", W, "--out", F]) -> exit code.
# New facts fields defined here for the C2 implementation:
#   distributions[*].dist_info_files  [{path (relative to the .dist-info dir), sha256}]
#   file_origins{bundle path: {class, source, ...}}  class is one of
#       wheel | interpreter-runtime | pyinstaller-generated | pyinstaller-bootloader
#       | os-package (Linux dpkg: package, version, copyright, copyright_missing) | unknown
# Bundle files are metadata fixtures only and are never executed. Subprocess and
# dpkg observations are replaced by a controlled stand-in; nothing on the host
# is queried or changed.

BRIDGE_PKG = "silentsuite_bridge"
BUNDLE_NAME = "silentsuite-bridge-desktop"
OS_PACKAGE = "libsynthetic-os1:amd64"  # synthetic; not a real Debian package


def _dist(site, name, version, package_files, info_files, metadata_extra=""):
    """A synthetic installed distribution under ``site``; info_files are raw bytes."""
    info = site / f"{name}-{version}.dist-info"
    info.mkdir(parents=True, exist_ok=True)
    (info / "METADATA").write_bytes(
        f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n{metadata_extra}".encode("utf-8"))
    for relative, data in package_files.items():
        target = site / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    for relative, data in info_files.items():
        target = info / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    entries = list(package_files) + [f"{info.name}/{relative}" for relative in info_files]
    entries += [f"{info.name}/METADATA", f"{info.name}/RECORD"]
    (info / "RECORD").write_text("".join(f"{entry},,\n" for entry in entries), encoding="utf-8")
    return info


def _bundle_with(root, files):
    """dist/<BUNDLE_NAME>/ with its never-executed executable, _internal/ and the given files."""
    bundle = root / "dist" / BUNDLE_NAME
    (bundle / "_internal").mkdir(parents=True)
    suffix = ".exe" if sys.platform == "win32" else ""
    (bundle / f"{BUNDLE_NAME}{suffix}").write_bytes(b"synthetic bootloader placeholder; never executed")
    for relative, data in files.items():
        target = bundle / "_internal" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return bundle


def _analysis_toc(workpath, scripts=(), pure=(), binaries=(), datas=()):
    """Write a real-shaped */Analysis-00.toc: a pprint'ed tuple of input lists and TOC lists."""
    spec_work = workpath / BUNDLE_NAME
    spec_work.mkdir(parents=True, exist_ok=True)
    guts = (
        ["/build/bridge/entrypoint_desktop.py"],
        ["/build/bridge/src"],
        ["PySide6.QtCore", "PySide6.QtWebEngineCore", "radicale"],
        [],
        list(scripts),
        list(pure),
        list(binaries),
        [],
        list(datas),
    )
    (spec_work / "Analysis-00.toc").write_text(pprint.pformat(guts), encoding="utf-8")
    return spec_work


def _controlled_subprocess(monkeypatch, collector, dpkg_owners=None):
    """Replace the collector's subprocess use with fixed answers; record every call."""
    dpkg_owners = dpkg_owners or {}
    calls = []

    def run(argv, **kwargs):
        calls.append(list(argv))
        if list(argv[:2]) == [sys.executable, "-c"]:
            return subprocess.CompletedProcess(argv, 0, '{"qVersion": "0.0-synthetic", "build": "synthetic"}\n', "")
        if argv and argv[0] == "dpkg-query":
            target = argv[-1]
            if "-S" in argv:
                if target in dpkg_owners:
                    return subprocess.CompletedProcess(argv, 0, f"{dpkg_owners[target][0]}: {target}\n", "")
                return subprocess.CompletedProcess(argv, 1, "", f"dpkg-query: no path found matching pattern {target}\n")
            if "-W" in argv:
                for package, version in dpkg_owners.values():
                    if target == package:
                        return subprocess.CompletedProcess(argv, 0, version, "")
                return subprocess.CompletedProcess(argv, 1, "", "dpkg-query: no packages found\n")
        return subprocess.CompletedProcess(argv, 127, "", "not a controlled command in this test\n")

    controlled = type("ControlledSubprocess", (), {"run": staticmethod(run),
                                                   "TimeoutExpired": subprocess.TimeoutExpired})
    monkeypatch.setattr(collector, "subprocess", controlled)
    return calls


class _SysView:
    """The real sys module, except for a controlled interpreter prefix."""

    def __init__(self, base_prefix):
        self.base_prefix = base_prefix

    def __getattr__(self, name):
        return getattr(sys, name)


def _run_cli(collector, root, workpath):
    out = root / "out" / "facts.json"
    code = collector.main(["--dist", str(root / "dist"), "--workpath", str(workpath), "--out", str(out)])
    return code, (json.loads(out.read_text(encoding="utf-8")) if out.is_file() else None)


def _module_fixture(collector, monkeypatch, tmp_path, module_typecode, script_typecode, include_bridge=True):
    site = tmp_path / "site"
    _dist(site, DIST, DIST_VERSION, {f"{DIST}/__init__.py": b"", f"{DIST}/{QT_LIBRARY}": b"synthetic-qt-library"},
          {"LICENSE": LICENCE_TEXT.encode("utf-8")})
    monkeypatch.syspath_prepend(str(site))
    _bundle_with(tmp_path, {f"{DIST}/{QT_LIBRARY}": b"synthetic-qt-library"})
    # Base-library stdlib modules stay unsuffixed, as observed in the real facts.
    pure = [("encodings", "/py/lib/encodings/__init__.py", "PYMODULE"), (DIST, str(site / DIST / "__init__.py"), module_typecode)]
    if include_bridge:
        pure.append((BRIDGE_PKG, "/build/bridge/src/silentsuite_bridge/__init__.py", module_typecode))
    scripts = [("pyi_rth_pyside6", "/py/PyInstaller/hooks/rthooks/pyi_rth_pyside6.py", "PYSOURCE"),
               ("entrypoint_desktop", "/build/bridge/entrypoint_desktop.py", script_typecode)]
    workpath = tmp_path / "work"
    _analysis_toc(workpath, scripts=scripts, pure=pure)
    _controlled_subprocess(monkeypatch, collector)
    return _run_cli(collector, tmp_path, workpath)


@pytest.mark.parametrize(
    "module_typecode,script_typecode",
    [("PYMODULE", "PYSOURCE"), ("PYMODULE-1", "PYSOURCE-1"), ("PYMODULE-2", "PYSOURCE-2")],
    ids=["unoptimised-control", "optimize-1", "optimize-2"],
)
def test_cli_reads_modules_and_scripts_at_every_optimisation_level(collector, monkeypatch, tmp_path,
                                                                    module_typecode, script_typecode):
    # PyInstaller 6.22.3 build_main.py:806,874 writes PYSOURCE-N / PYMODULE-N for optimize=N.
    code, facts = _module_fixture(collector, monkeypatch, tmp_path, module_typecode, script_typecode)
    assert code == 0 and facts is not None, f"the collector did not write facts (exit {code})"
    assert facts["module_owners"].get(DIST) == [DIST], f"{module_typecode} module not observed: {facts['module_owners']}"
    observed = set(facts["module_owners"]) | set(facts["unmapped_modules"]) | set(facts["stdlib_modules"])
    assert BRIDGE_PKG in observed, f"{module_typecode} entry package not observed"
    assert "encodings" in facts["stdlib_modules"]
    scripts = facts["observations"]["scripts"]
    assert "pyi_rth_pyside6" in scripts and "entrypoint_desktop" in scripts, f"{script_typecode} script missing: {scripts}"


def test_cli_writes_facts_for_complete_module_evidence(collector, monkeypatch, tmp_path):
    # Positive control for the guard below: the entry package is present.
    code, facts = _module_fixture(collector, monkeypatch, tmp_path, "PYMODULE", "PYSOURCE")
    assert code == 0 and facts is not None
    assert BRIDGE_PKG in set(facts["module_owners"]) | set(facts["unmapped_modules"])


def test_cli_refuses_module_evidence_without_the_entry_package(collector, monkeypatch, tmp_path):
    code, facts = _module_fixture(collector, monkeypatch, tmp_path, "PYMODULE", "PYSOURCE", include_bridge=False)
    assert code == 2, f"incomplete module evidence (no {BRIDGE_PKG}) was accepted with exit {code}"
    assert facts is None, "facts were written for incomplete module evidence"


def test_collector_captures_every_dist_info_licences_file_and_lists_dist_info(collector, tmp_path):
    site = tmp_path / "site"
    texts = {"licenses/LGPL-3.0-only.txt": b"SYNTHETIC LGPL-3.0-ONLY TEXT\n",
             "licenses/LicenseRef-Qt-Commercial.txt": b"SYNTHETIC COMMERCIAL TEXT\n"}
    info = _dist(site, "fakeqtlic", "6.12.0", {"fakeqtlic/QtLic.dll": b"synthetic-lib"}, texts)
    bundle = _bundle_with(tmp_path, {"fakeqtlic/QtLic.dll": b"synthetic-lib"})
    facts = collector.collect(bundle, [], [str(site)])
    dist = {d["name"]: d for d in facts["distributions"]}["fakeqtlic"]
    captured = {entry["path"]: entry for entry in dist["license_files"]}
    for relative, data in texts.items():
        assert relative in captured, f"{relative} under .dist-info/licenses/ was not captured: {sorted(captured)}"
        assert captured[relative]["sha256"] == _sha(data) and captured[relative]["text"] == data.decode("utf-8")
    expected_listing = sorted(
        [{"path": p.relative_to(info).as_posix(), "sha256": _sha(p.read_bytes())} for p in info.rglob("*") if p.is_file()],
        key=lambda entry: entry["path"],
    )
    assert dist.get("dist_info_files") == expected_listing, "the full .dist-info listing is not reported"


def test_collector_preserves_declared_licence_bytes(collector, tmp_path):
    site = tmp_path / "site"
    raw = b"SYNTHETIC LEGAL TERMS\r\nSECOND LINE\r\n"
    _dist(site, "fakelegal", "1.0", {"fakelegal/data.bin": b"synthetic"}, {"LEGAL-TERMS": raw},
          metadata_extra="License-File: LEGAL-TERMS\n")
    bundle = _bundle_with(tmp_path, {"fakelegal/data.bin": b"synthetic"})
    facts = collector.collect(bundle, [], [str(site)])
    dist = {d["name"]: d for d in facts["distributions"]}["fakelegal"]
    entry = {e["path"]: e for e in dist["license_files"]}.get("LEGAL-TERMS")
    assert entry is not None, dist["license_files"]
    assert entry["sha256"] == _sha(raw), "declared licence bytes were normalised (CRLF lost)"
    assert entry["text"] == raw.decode("utf-8")


def test_collector_reports_undecodable_declared_licence_instead_of_raising(collector, tmp_path):
    site = tmp_path / "site"
    raw = b"\xff\xfe\x00not utf-8\x80"
    _dist(site, "fakebinlegal", "1.0", {"fakebinlegal/data.bin": b"synthetic"}, {"LEGAL.bin": raw},
          metadata_extra="License-File: LEGAL.bin\n")
    bundle = _bundle_with(tmp_path, {"fakebinlegal/data.bin": b"synthetic"})
    try:
        facts = collector.collect(bundle, [], [str(site)])
    except UnicodeDecodeError as exc:
        pytest.fail(f"an undecodable declared licence file raised instead of being reported: {exc!r}")
    dist = {d["name"]: d for d in facts["distributions"]}["fakebinlegal"]
    entry = {e["path"]: e for e in dist["license_files"]}.get("LEGAL.bin")
    assert entry == {"path": "LEGAL.bin", "sha256": _sha(raw), "text": None, "undecodable": True}, entry


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="dpkg ownership is a Linux observation")
def test_cli_classifies_each_bundled_file_by_its_build_source(collector, monkeypatch, tmp_path):
    prefix = tmp_path / "prefix"  # the controlled interpreter prefix
    site = prefix / "lib" / "site-packages"  # a wheel inside the prefix: the wheel must win
    _dist(site, DIST, DIST_VERSION, {f"{DIST}/__init__.py": b"", f"{DIST}/{QT_LIBRARY}": b"synthetic-qt-library"},
          {"LICENSE": LICENCE_TEXT.encode("utf-8")})
    monkeypatch.syspath_prepend(str(site))
    sources = {
        "runtime": prefix / "lib" / "libruntime.so.1",
        "os": tmp_path / "system" / "libos.so.1",
        "mystery": tmp_path / "elsewhere" / "mystery.so",
    }
    for path in sources.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic native placeholder")
    workpath = tmp_path / "work"
    spec_work = _analysis_toc(
        workpath,
        scripts=[("entrypoint_desktop", "/build/bridge/entrypoint_desktop.py", "PYSOURCE")],
        pure=[("encodings", "/py/lib/encodings/__init__.py", "PYMODULE"),
              (BRIDGE_PKG, "/build/bridge/src/silentsuite_bridge/__init__.py", "PYMODULE")],
        binaries=[(f"{DIST}/{QT_LIBRARY}", str(site / DIST / QT_LIBRARY), "BINARY"),
                  ("libruntime.so.1", str(sources["runtime"]), "BINARY"),
                  ("libos.so.1", str(sources["os"]), "BINARY"),
                  ("mystery.so", str(sources["mystery"]), "BINARY")],
        datas=[("base_library.zip", str(workpath / BUNDLE_NAME / "base_library.zip"), "DATA")],
    )
    (spec_work / "base_library.zip").write_bytes(b"synthetic generated archive")
    _bundle_with(tmp_path, {
        f"{DIST}/{QT_LIBRARY}": b"synthetic-qt-library",
        "libruntime.so.1": b"synthetic native placeholder",
        "libos.so.1": b"synthetic native placeholder",
        "mystery.so": b"synthetic native placeholder",
        "base_library.zip": b"synthetic generated archive",
        "orphan.dat": b"no build evidence",
    })
    monkeypatch.setattr(collector, "sys", _SysView(str(prefix)))
    _controlled_subprocess(monkeypatch, collector, dpkg_owners={str(sources["os"]): (OS_PACKAGE, "1.2-3")})
    code, facts = _run_cli(collector, tmp_path, workpath)
    assert code == 0 and facts is not None, f"the collector did not write facts (exit {code})"
    assert "file_origins" in facts, "no per-file build-source origins are reported"
    origins = facts["file_origins"]
    exe = BUNDLE_NAME
    expected = {
        f"_internal/{DIST}/{QT_LIBRARY}": {"class": "wheel", "distribution": DIST},
        "_internal/libruntime.so.1": {"class": "interpreter-runtime", "source": str(sources["runtime"])},
        "_internal/base_library.zip": {"class": "pyinstaller-generated"},
        exe: {"class": "pyinstaller-bootloader"},
        "_internal/libos.so.1": {"class": "os-package", "source": str(sources["os"]), "package": OS_PACKAGE,
                                 "version": "1.2-3", "copyright_missing": True},
        "_internal/mystery.so": {"class": "unknown", "source": str(sources["mystery"])},
        "_internal/orphan.dat": {"class": "unknown", "source": None},
    }
    for path, fields in expected.items():
        got = origins.get(path) or {}
        assert {k: got.get(k) for k in fields} == fields, f"{path}: {got!r}"
    # Unknown stays unknown: no owner by name, and still unmapped.
    assert {"_internal/mystery.so", "_internal/orphan.dat"} <= set(facts["unmapped_files"])


def test_collect_without_build_evidence_leaves_runtime_files_unknown(collector, tmp_path):
    # Library use has no TOC, so no trusted origin: python310.dll stays unknown and unmapped.
    site, bundle = _site(tmp_path), _bundle(tmp_path)
    facts = collector.collect(bundle, [DIST], [str(site)])
    assert facts["unmapped_files"] == ["_internal/python310.dll"]
    assert "file_origins" in facts, "no per-file origins are reported"
    assert facts["file_origins"]["_internal/python310.dll"] == {"class": "unknown", "source": None}
    assert facts["file_origins"][f"_internal/{DIST}/{QT_LIBRARY}"]["class"] == "wheel"
