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


# --- C3: in-bundle links and the WebEngine/Chromium observation (tests first) ------
#
# PyInstaller 6.22.3 records a preserved symbolic link as (dest, rel_link, 'SYMLINK'),
# where rel_link is relative to dirname(dest) and points at another collected
# destination (building/datastruct.py:416-454), and COLLECT then creates
# os.symlink(rel_link, dest) inside the bundle (building/api.py:1207-1213).
# So a link origin is source-backed only when BOTH the TOC entry is SYMLINK and
# the bundle file is a real symlink to that same relative target, which resolves
# to an existing file inside the bundle. Facts fields defined here:
#   file_origins[link] = {class: "bundle-link", source: <relative target>,
#                         target: <bundle path>, target_origin: <the target's origin>}
#   observations.webengine = {source, returncode, value: {qWebEngineVersion,
#       qWebEngineChromiumVersion, qWebEngineChromiumSecurityPatchVersion} | null,
#       error | stderr_tail}   (diagnostic, never fatal)

ENTRY_SCRIPT = ("entrypoint_desktop", "/build/bridge/entrypoint_desktop.py", "PYSOURCE")
BASE_PURE = [("encodings", "/py/lib/encodings/__init__.py", "PYMODULE"),
             (BRIDGE_PKG, "/build/bridge/src/silentsuite_bridge/__init__.py", "PYMODULE")]
NSS_PACKAGE = "libsynthetic-nss3:amd64"  # synthetic; not a real Debian package
QTCORE_PROBE_SOURCE = "build interpreter subprocess: PySide6.QtCore.qVersion() and QLibraryInfo.build()"
SYNTHETIC_QTCORE = (
    "def qVersion():\n    return '0.0.0-synthetic-qtcore'\n\n\n"
    "class QLibraryInfo:\n    @staticmethod\n    def build():\n        return 'synthetic QtCore build'\n"
)
WEBENGINE_SENTINELS = {
    "qWebEngineVersion": "9.9.9-synthetic-webengine",
    "qWebEngineChromiumVersion": "999.0.0.1-synthetic",
    "qWebEngineChromiumSecurityPatchVersion": "999.0.0.2-synthetic",
}


def _synthetic_webengine(names):
    return "".join(f"def {name}():\n    return {WEBENGINE_SENTINELS[name]!r}\n\n\n" for name in names)


def _real_probe_cli(collector, monkeypatch, tmp_path, webengine_source):
    """CLI run whose probes use the real subprocess against a synthetic PySide6 on the child path."""
    package = tmp_path / "fakepkgs" / "PySide6"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "QtCore.py").write_text(SYNTHETIC_QTCORE, encoding="utf-8")
    if webengine_source is not None:
        (package / "QtWebEngineCore.py").write_text(webengine_source, encoding="utf-8")
    monkeypatch.setenv("PYTHONPATH", str(tmp_path / "fakepkgs"))  # child processes only
    _bundle_with(tmp_path, {})
    workpath = tmp_path / "work"
    _analysis_toc(workpath, scripts=[ENTRY_SCRIPT], pure=BASE_PURE)
    return _run_cli(collector, tmp_path, workpath)


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="in-bundle symlinks are a Linux observation here")
def test_cli_resolves_in_bundle_symlink_to_its_classified_target(collector, monkeypatch, tmp_path):
    os_source = tmp_path / "system" / "nss" / "libfreebl3.so"
    os_source.parent.mkdir(parents=True)
    os_source.write_bytes(b"synthetic nss placeholder")
    workpath = tmp_path / "work"
    _analysis_toc(workpath, scripts=[ENTRY_SCRIPT], pure=BASE_PURE, binaries=[
        ("nss/libfreebl3.so", str(os_source), "BINARY"),
        ("libfreebl3.so", "nss/libfreebl3.so", "SYMLINK"),  # rel_link relative to dirname(dest)
    ])
    bundle = _bundle_with(tmp_path, {"nss/libfreebl3.so": b"synthetic nss placeholder"})
    os.symlink("nss/libfreebl3.so", bundle / "_internal" / "libfreebl3.so")  # as COLLECT creates it
    _controlled_subprocess(monkeypatch, collector, dpkg_owners={str(os_source): (NSS_PACKAGE, "2:3.98-synthetic")})
    code, facts = _run_cli(collector, tmp_path, workpath)
    assert code == 0 and facts is not None, f"the collector did not write facts (exit {code})"
    origins = facts["file_origins"]
    target = origins["_internal/nss/libfreebl3.so"]
    assert target.get("class") == "os-package" and target.get("package") == NSS_PACKAGE, target
    link = origins.get("_internal/libfreebl3.so") or {}
    assert {k: link.get(k) for k in ("class", "source", "target")} == {
        "class": "bundle-link", "source": "nss/libfreebl3.so", "target": "_internal/nss/libfreebl3.so",
    }, f"the in-bundle link was not resolved to its target: {link!r}"
    assert link.get("target_origin") == target, link
    assert "_internal/libfreebl3.so" in facts["unmapped_files"]  # unmapped keeps its meaning (no wheel owner)


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="in-bundle symlinks are a Linux observation here")
def test_cli_keeps_unproved_relative_sources_and_escaping_links_unknown(collector, monkeypatch, tmp_path):
    # Preservation: none of these is a source-backed in-bundle link.
    workpath = tmp_path / "work"
    _analysis_toc(workpath, scripts=[ENTRY_SCRIPT], pure=BASE_PURE, binaries=[
        ("escape.so", "../../outside.so", "SYMLINK"),  # real symlink, but its target leaves the bundle
        ("claimed.so", "nss/real.so", "SYMLINK"),      # TOC says link, bundle file is a regular file
        ("relative.so", "nss/real.so", "BINARY"),      # relative source without any link evidence
    ])
    bundle = _bundle_with(tmp_path, {
        "nss/real.so": b"synthetic real placeholder",
        "claimed.so": b"synthetic regular placeholder",
        "relative.so": b"synthetic regular placeholder",
    })
    (tmp_path / "dist" / "outside.so").write_bytes(b"outside the bundle")
    os.symlink("../../outside.so", bundle / "_internal" / "escape.so")
    _controlled_subprocess(monkeypatch, collector)
    code, facts = _run_cli(collector, tmp_path, workpath)
    assert code == 0 and facts is not None, f"the collector did not write facts (exit {code})"
    origins = facts["file_origins"]
    expected = {"_internal/escape.so": "../../outside.so", "_internal/claimed.so": "nss/real.so",
                "_internal/relative.so": "nss/real.so"}
    for path, source in expected.items():
        got = origins.get(path) or {}
        assert {k: got.get(k) for k in ("class", "source")} == {"class": "unknown", "source": source}, f"{path}: {got!r}"
    assert set(expected) <= set(facts["unmapped_files"])


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="in-bundle symlinks are a Linux observation here")
def test_cli_reports_dangling_in_bundle_symlink_as_unknown(collector, monkeypatch, tmp_path):
    workpath = tmp_path / "work"
    _analysis_toc(workpath, scripts=[ENTRY_SCRIPT], pure=BASE_PURE, binaries=[
        ("libdangling.so", "nss/missing.so", "SYMLINK"),
    ])
    bundle = _bundle_with(tmp_path, {})
    os.symlink("nss/missing.so", bundle / "_internal" / "libdangling.so")
    _controlled_subprocess(monkeypatch, collector)
    code, facts = _run_cli(collector, tmp_path, workpath)
    assert code == 0 and facts is not None, f"a dangling in-bundle link made the collector fail (exit {code})"
    got = facts["file_origins"].get("_internal/libdangling.so") or {}
    assert {k: got.get(k) for k in ("class", "source")} == {"class": "unknown", "source": "nss/missing.so"}, got
    assert "_internal/libdangling.so" in facts["unmapped_files"]


def test_cli_qtcore_observation_is_unchanged_with_a_synthetic_pyside6(collector, monkeypatch, tmp_path):
    # Preservation: the existing QtCore probe, through the real subprocess.
    code, facts = _real_probe_cli(collector, monkeypatch, tmp_path, _synthetic_webengine(WEBENGINE_SENTINELS))
    assert code == 0 and facts is not None
    assert facts["observations"]["qt"] == {
        "source": QTCORE_PROBE_SOURCE, "returncode": 0,
        "value": {"qVersion": "0.0.0-synthetic-qtcore", "build": "synthetic QtCore build"},
    }


def test_cli_observes_webengine_versions_through_the_real_probe(collector, monkeypatch, tmp_path):
    code, facts = _real_probe_cli(collector, monkeypatch, tmp_path, _synthetic_webengine(WEBENGINE_SENTINELS))
    assert code == 0 and facts is not None
    observation = facts["observations"].get("webengine")
    assert isinstance(observation, dict), "no observations.webengine is reported"
    assert observation.get("returncode") == 0 and isinstance(observation.get("source"), str), observation
    assert observation.get("value") == WEBENGINE_SENTINELS, observation


def test_cli_reports_a_missing_webengine_function_without_failing(collector, monkeypatch, tmp_path):
    partial = _synthetic_webengine(["qWebEngineVersion", "qWebEngineChromiumVersion"])
    code, facts = _real_probe_cli(collector, monkeypatch, tmp_path, partial)
    assert code == 0 and facts is not None, f"a missing WebEngine function made the collector fail (exit {code})"
    observation = facts["observations"].get("webengine")
    assert isinstance(observation, dict), "no observations.webengine is reported"
    assert observation.get("value") is None, f"a partial WebEngine API produced a value: {observation!r}"
    assert "error" in observation or "stderr_tail" in observation, observation


def test_cli_reports_a_missing_webengine_module_without_failing(collector, monkeypatch, tmp_path):
    code, facts = _real_probe_cli(collector, monkeypatch, tmp_path, None)
    assert code == 0 and facts is not None, f"a missing WebEngine module made the collector fail (exit {code})"
    observation = facts["observations"].get("webengine")
    assert isinstance(observation, dict), "no observations.webengine is reported"
    assert observation.get("value") is None, observation
    assert "error" in observation or "stderr_tail" in observation, observation
    assert facts["observations"]["qt"]["value"] == {"qVersion": "0.0.0-synthetic-qtcore", "build": "synthetic QtCore build"}


# --- C3 review correction (post-p2-component-review-answer.md finding 4; tests first) ---
#
# On Linux a backslash is an ordinary filename character, not a directory separator.
# A TOC rel_link "nss/real.so" and an on-disk link to "nss\real.so" therefore name two
# different files. That link is malformed evidence: COLLECT writes os.symlink(rel_link,
# dest) verbatim, so the spellings would agree. It must stay unknown and must not
# inherit the origin of the slash-named file, which it does not reach.
TOC_LINK_TARGET = "nss/real.so"
ACTUAL_LINK_TARGET = "nss\\real.so"


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="in-bundle symlinks are a Linux observation here")
def test_cli_keeps_link_unknown_when_its_backslash_target_differs_from_the_toc(collector, monkeypatch, tmp_path):
    os_source = tmp_path / "system" / "nss" / "real.so"
    os_source.parent.mkdir(parents=True)
    os_source.write_bytes(b"synthetic slash-named placeholder")
    workpath = tmp_path / "work"
    _analysis_toc(workpath, scripts=[ENTRY_SCRIPT], pure=BASE_PURE, binaries=[
        (TOC_LINK_TARGET, str(os_source), "BINARY"),
        ("libmalformed.so", TOC_LINK_TARGET, "SYMLINK"),  # the TOC claims the slash-named target
    ])
    bundle = _bundle_with(tmp_path, {
        TOC_LINK_TARGET: b"synthetic slash-named placeholder",
        ACTUAL_LINK_TARGET: b"synthetic backslash-named placeholder",  # one file directly in _internal/
    })
    internal = bundle / "_internal"
    link = internal / "libmalformed.so"
    link.symlink_to(ACTUAL_LINK_TARGET)  # what the bundle actually holds
    slash_file, backslash_file = internal / "nss" / "real.so", internal / ACTUAL_LINK_TARGET
    # Prerequisites (not RED if they fail): two distinct regular files, a link whose
    # literal target keeps the backslash and differs from the TOC spelling, and which
    # reaches only the backslash-named file.
    for path in (slash_file, backslash_file):
        if not path.is_file() or path.is_symlink():
            pytest.fail(f"prerequisite failed (not RED): {path.name!r} is not a regular in-bundle file")
    if backslash_file.parent != internal or slash_file.samefile(backslash_file):
        pytest.fail("prerequisite failed (not RED): the slash- and backslash-named files are not distinct")
    if slash_file.read_bytes() == backslash_file.read_bytes():
        pytest.fail("prerequisite failed (not RED): the two files have identical bytes")
    if os.readlink(link) != ACTUAL_LINK_TARGET or ACTUAL_LINK_TARGET == TOC_LINK_TARGET:
        pytest.fail(f"prerequisite failed (not RED): readlink gave {os.readlink(link)!r}")
    if not link.samefile(backslash_file) or link.samefile(slash_file):
        pytest.fail("prerequisite failed (not RED): the link does not reach only the backslash-named file")
    _controlled_subprocess(monkeypatch, collector, dpkg_owners={str(os_source): (NSS_PACKAGE, "2:3.98-synthetic")})
    code, facts = _run_cli(collector, tmp_path, workpath)
    if code != 0 or facts is None:
        pytest.fail(f"prerequisite failed (not RED): the collector did not write facts (exit {code})")
    origins = facts["file_origins"]
    slash_origin = origins.get("_internal/nss/real.so") or {}
    if slash_origin.get("class") != "os-package" or slash_origin.get("package") != NSS_PACKAGE:
        pytest.fail(f"prerequisite failed (not RED): the slash-named file has no trusted origin: {slash_origin!r}")
    if "_internal/" + ACTUAL_LINK_TARGET not in origins:
        pytest.fail("prerequisite failed (not RED): the collector did not observe the backslash-named file")
    got = origins.get("_internal/libmalformed.so") or {}
    assert {k: got.get(k) for k in ("class", "source")} == {"class": "unknown", "source": TOC_LINK_TARGET} \
        and "target" not in got and "target_origin" not in got, (
        f"a link to {ACTUAL_LINK_TARGET!r} was attributed through the TOC spelling {TOC_LINK_TARGET!r}: {got!r}")
    assert "_internal/libmalformed.so" in facts["unmapped_files"]


# --- Policy candidate v9 schema: gate rules and collector evidence (tests first) ------
#
# The reviewed private candidate (policy-candidate-v9, plan gate GREEN at 20e7e721)
# proposes keys the fixed synthetic contract above does not use. The gate must enforce
# each one and fail closed:
#   policy.json {"platforms": {label: "notices/policy-<label>.json"}} selects one platform
#       policy (paths relative to the directory holding notices/); the platform policy's
#       "platform" must equal facts["platform"]; "admitted" present and not true fails.
#   required_statements [{file, must_contain, sha256?, must_not_contain?: [str]}]: the
#       file exists with that SHA256, contains must_contain and none of must_not_contain.
#   elections [{expression, elected, file, platforms, text}]: elected is one alternative
#       of expression, this policy's platform is listed, and the text is present.
#   runtime_modules [{module, owner, licence, typecode?, toc_sources_exactly?}]: an
#       unmapped module needs a rule by exact name; with typecode/toc_sources_exactly the
#       facts' module_sources for it must be exactly those sources, each with that typecode.
#   licence_text_files {licence: [files]}: every text a used licence needs is present.
# Each platform policy is evaluated alone: nothing from one platform's policy or run may
# be required of, or satisfy, the other's (the v2 generator's shared REQUIRED_NOTICES list
# leaked a Linux-only append into Windows; the gate keeps no state between checks).
# The collector adds facts["platform"] ("linux-x86_64" / "windows-x86_64") and
# facts["module_sources"] {unmapped module: [{typecode, source}]}, with source records of
# the C5 shape (kind, path_class repo|site-packages|stdlib|other, relative_path, sha256,
# bytes) and never an absolute build path.
# All names, texts and hashes are SYNTHETIC; nothing here certifies real contents.

LINUX, WINDOWS = "linux-x86_64", "windows-x86_64"
FREETYPE_CREDIT = "based in part on the work of the FreeType Team"
PLACEHOLDERS = ["<year>", "<owner>", "[yyyy]", "[name of copyright owner]"]
KHRONOS_CARRIER = "NOTICES/shared/carriers/opengl/NOTICE-MIT-Khronos-old.txt"
KHRONOS_LINE = "Copyright (c) 2013-2018 The Khronos Group Inc."
KHRONOS_TEXT = f"{KHRONOS_LINE}\nSYNTHETIC MIT-Khronos-old body for gate logic tests only\n"
KDE_CARRIER = "NOTICES/shared/carriers/ibus/NOTICE-BSD-3-Clause-KDE.txt"
KDE_LINE = "Copyright © 2011-2018 The KDE community"
KDE_TEXT = f"{KDE_LINE}\nSYNTHETIC BSD-3-Clause body for gate logic tests only\n"
DBUS_ELECTION = {"expression": "AFL-2.1 OR GPL-2.0-or-later", "elected": "GPL-2.0-or-later",
                 "file": "qtbase/src/dbus/dbus_minimal_p.h", "platforms": [LINUX], "text": "NOTICES/GPL-2.0.txt"}
TESTS_SOURCE = {"bytes": 0, "kind": "file", "path_class": "repo", "relative_path": "bridge/tests/__init__.py",
                "sha256": _sha(b"")}
BRIDGE_SOURCE = {"bytes": 11, "kind": "file", "path_class": "repo",
                 "relative_path": "bridge/src/silentsuite_bridge/__init__.py", "sha256": _sha(b"synthetic\n\n")}


def _v9_facts(platform):
    facts = _facts()
    facts["platform"] = platform
    facts["unmapped_modules"] = [BRIDGE_PKG, "tests"]
    facts["module_sources"] = {
        BRIDGE_PKG: [{"typecode": "PYMODULE-1", "source": dict(BRIDGE_SOURCE)}],
        "tests": [{"typecode": "PYMODULE-1", "source": dict(TESTS_SOURCE)}],
    }
    return facts


def _statement(file, must, data=None, must_not=()):
    entry = {"file": file, "must_contain": must, "basis": "synthetic"}
    if data is not None:
        entry["sha256"] = _sha(data)
        entry["must_not_contain"] = list(must_not)
    return entry


def _v9_policy(platform):
    policy = _policy()
    policy.update({"platform": platform, "admitted": True, "private_candidate": True})
    policy["allowed_licences"] = policy["allowed_licences"] + ["AGPL-3.0-only"]
    policy["licence_texts"]["AGPL-3.0-only"] = "NOTICES/AGPL-3.0.txt"
    policy["licence_text_files"] = {"LGPL-3.0-only": ["NOTICES/LGPL-3.0.txt", f"NOTICES/{DIST}/LICENSE"]}
    policy["runtime_modules"] = [
        {"module": BRIDGE_PKG, "owner": "SilentSuite Bridge", "licence": "AGPL-3.0-only"},
        {"module": "tests", "owner": "SilentSuite Bridge application (repository)", "licence": "AGPL-3.0-only",
         "typecode": "PYMODULE-1", "toc_sources_exactly": [dict(TESTS_SOURCE)]},
    ]
    statements = [
        _statement("README-dev-build.txt", FREETYPE_CREDIT),
        _statement(KHRONOS_CARRIER, KHRONOS_LINE, KHRONOS_TEXT, ["<year>", "<owner>"]),
    ]
    if platform == LINUX:  # the KDE ibus carrier and the dbus election are Linux only
        statements.append(_statement(KDE_CARRIER, KDE_LINE, KDE_TEXT, PLACEHOLDERS))
        policy["elections"] = [dict(DBUS_ELECTION)]
        policy["required_notices"] = policy["required_notices"] + [KDE_CARRIER, "NOTICES/GPL-2.0.txt"]
    policy["required_notices"] = policy["required_notices"] + [KHRONOS_CARRIER]
    policy["required_statements"] = statements
    return policy


def _v9_archive(root, platform):
    archive, sources = _archive(root)
    (archive / "README-dev-build.txt").write_text(
        f"Experimental. This build {PROMINENT}.\nThis software is {FREETYPE_CREDIT}.\n", encoding="utf-8")
    carrier = archive / KHRONOS_CARRIER
    carrier.parent.mkdir(parents=True)
    carrier.write_text(KHRONOS_TEXT, encoding="utf-8")
    if platform == LINUX:
        kde = archive / KDE_CARRIER
        kde.parent.mkdir(parents=True)
        kde.write_text(KDE_TEXT, encoding="utf-8")
        (archive / "NOTICES" / "GPL-2.0.txt").write_text("synthetic GPL-2.0.txt\n", encoding="utf-8")
    return archive, sources


def _v9_case(tmp_path, platform):
    archive, sources = _v9_archive(tmp_path / platform, platform)
    return json.loads(json.dumps(_v9_facts(platform))), json.loads(json.dumps(_v9_policy(platform))), archive, sources


@pytest.mark.parametrize("platform", [LINUX, WINDOWS])
def test_v9_gate_passes_a_complete_platform_fixture(gate, tmp_path, platform):
    facts, policy, archive, sources = _v9_case(tmp_path, platform)
    assert gate.check(facts, policy, archive, sources) == []


def test_v9_gate_keeps_platform_policies_separate_across_checks(gate, tmp_path):
    # Windows has no KDE carrier, GPL-2.0 text or dbus election; checking Linux first
    # (or in between) must not make Windows require them, and no input is mutated.
    linux, windows = _v9_case(tmp_path, LINUX), _v9_case(tmp_path, WINDOWS)
    before = json.dumps([linux[:2], windows[:2]], sort_keys=True)
    results = [gate.check(*linux), gate.check(*windows), gate.check(*linux), gate.check(*windows)]
    assert results == [[], [], [], []]
    assert json.dumps([linux[:2], windows[:2]], sort_keys=True) == before, "the gate mutated its inputs"
    assert not (windows[2] / KDE_CARRIER).exists(), "fixture control: the Windows archive has no KDE carrier"


def _v9_mutations():
    def statement_file_missing(facts, policy, archive, sources):
        (archive / KHRONOS_CARRIER).unlink()

    def statement_sha256_mismatch(facts, policy, archive, sources):
        (archive / KHRONOS_CARRIER).write_text(KHRONOS_TEXT + "appended\n", encoding="utf-8")

    def statement_must_contain_absent(facts, policy, archive, sources):
        text = KHRONOS_TEXT.replace(KHRONOS_LINE, "Copyright (c) The Khronos Group Inc.")
        (archive / KHRONOS_CARRIER).write_text(text, encoding="utf-8")
        policy["required_statements"][1]["sha256"] = _sha(text)  # the hash alone must not satisfy it

    def statement_placeholder_present(facts, policy, archive, sources):
        text = KHRONOS_TEXT + "Copyright <year> <owner>\n"
        (archive / KHRONOS_CARRIER).write_text(text, encoding="utf-8")
        policy["required_statements"][1]["sha256"] = _sha(text)

    def statement_without_must_contain(facts, policy, archive, sources):
        del policy["required_statements"][1]["must_contain"]

    def statement_must_not_contain_not_a_list(facts, policy, archive, sources):
        policy["required_statements"][1]["must_not_contain"] = "<year>"

    def statement_path_escapes_archive(facts, policy, archive, sources):
        outside = archive.parent / "outside.txt"
        outside.write_text(KHRONOS_TEXT, encoding="utf-8")
        policy["required_statements"][1]["file"] = "../outside.txt"

    def freetype_credit_missing(facts, policy, archive, sources):
        (archive / "README-dev-build.txt").write_text(f"Experimental. This build {PROMINENT}.\n", encoding="utf-8")

    def policy_not_admitted(facts, policy, archive, sources):
        policy["admitted"] = False

    def facts_from_another_platform(facts, policy, archive, sources):
        facts["platform"] = WINDOWS if policy["platform"] == LINUX else LINUX

    def facts_without_platform(facts, policy, archive, sources):
        del facts["platform"]

    def licence_text_file_missing(facts, policy, archive, sources):
        policy["licence_text_files"]["LGPL-3.0-only"].append("NOTICES/absent.txt")

    def module_without_rule(facts, policy, archive, sources):
        facts["unmapped_modules"].append("tests.helpers")  # an extra descendant needs its own rule

    def module_rule_licence_not_allowed(facts, policy, archive, sources):
        policy["runtime_modules"][0]["licence"] = "GPL-3.0-only"

    def module_typecode_unoptimised(facts, policy, archive, sources):
        facts["module_sources"]["tests"][0]["typecode"] = "PYMODULE"

    def module_typecode_optimize_2(facts, policy, archive, sources):
        facts["module_sources"]["tests"][0]["typecode"] = "PYMODULE-2"

    def module_source_hash_differs(facts, policy, archive, sources):
        facts["module_sources"]["tests"][0]["source"]["sha256"] = _sha(b"not empty")

    def module_source_not_from_repo(facts, policy, archive, sources):
        facts["module_sources"]["tests"][0]["source"].update(path_class="site-packages", relative_path="tests/__init__.py")

    def module_source_conflicting(facts, policy, archive, sources):
        facts["module_sources"]["tests"].append({"typecode": "PYMODULE-1", "source": dict(TESTS_SOURCE)})

    def module_source_evidence_missing(facts, policy, archive, sources):
        del facts["module_sources"]["tests"]

    return [statement_file_missing, statement_sha256_mismatch, statement_must_contain_absent,
            statement_placeholder_present, statement_without_must_contain, statement_must_not_contain_not_a_list,
            statement_path_escapes_archive, freetype_credit_missing, policy_not_admitted,
            facts_from_another_platform, facts_without_platform, licence_text_file_missing, module_without_rule,
            module_rule_licence_not_allowed, module_typecode_unoptimised, module_typecode_optimize_2,
            module_source_hash_differs, module_source_not_from_repo, module_source_conflicting,
            module_source_evidence_missing]


@pytest.mark.parametrize("platform", [LINUX, WINDOWS])
@pytest.mark.parametrize("mutate", _v9_mutations(), ids=lambda f: f.__name__)
def test_v9_gate_fails_closed_on_each_rule(gate, tmp_path, mutate, platform):
    facts, policy, archive, sources = _v9_case(tmp_path, platform)
    mutate(facts, policy, archive, sources)
    failures = gate.check(facts, policy, archive, sources)
    assert isinstance(failures, list) and failures, f"{platform}: {mutate.__name__} was not refused"


def _linux_mutations():
    def kde_carrier_missing(facts, policy, archive, sources):
        (archive / KDE_CARRIER).unlink()

    def kde_placeholder_present(facts, policy, archive, sources):
        text = KDE_TEXT + "Copyright [yyyy] [name of copyright owner]\n"
        (archive / KDE_CARRIER).write_text(text, encoding="utf-8")
        policy["required_statements"][2]["sha256"] = _sha(text)

    def election_text_missing(facts, policy, archive, sources):
        (archive / "NOTICES" / "GPL-2.0.txt").unlink()
        policy["required_notices"].remove("NOTICES/GPL-2.0.txt")  # the election alone must require it

    def election_not_an_alternative(facts, policy, archive, sources):
        policy["elections"][0]["elected"] = "GPL-3.0-only"

    def election_without_text(facts, policy, archive, sources):
        del policy["elections"][0]["text"]

    def election_for_another_platform(facts, policy, archive, sources):
        policy["elections"][0]["platforms"] = [WINDOWS]

    return [kde_carrier_missing, kde_placeholder_present, election_text_missing, election_not_an_alternative,
            election_without_text, election_for_another_platform]


@pytest.mark.parametrize("mutate", _linux_mutations(), ids=lambda f: f.__name__)
def test_v9_gate_fails_closed_on_each_linux_only_rule(gate, tmp_path, mutate):
    facts, policy, archive, sources = _v9_case(tmp_path, LINUX)
    mutate(facts, policy, archive, sources)
    failures = gate.check(facts, policy, archive, sources)
    assert isinstance(failures, list) and failures, f"{mutate.__name__} was not refused"


def test_v9_gate_refuses_a_linux_only_election_leaked_into_windows(gate, tmp_path):
    # The v2 shared-list bug, as the gate sees it: a Linux-only row in the Windows policy.
    facts, policy, archive, sources = _v9_case(tmp_path, WINDOWS)
    (archive / "NOTICES" / "GPL-2.0.txt").write_text("synthetic GPL-2.0.txt\n", encoding="utf-8")
    policy["elections"] = [dict(DBUS_ELECTION)]
    assert gate.check(facts, policy, archive, sources), "a Linux-only election was accepted for Windows"


def _write_policy_tree(root, policies):
    """bridge/dev-build-shaped policy files: notices/policy.json naming each platform file."""
    notices = root / "policy" / "notices"
    notices.mkdir(parents=True)
    index = {"schema_version": 1, "admitted": True, "platforms": {}}
    for platform, policy in policies.items():
        name = f"notices/policy-{platform}.json"
        (notices.parent / name).write_text(json.dumps(policy), encoding="utf-8")
        index["platforms"][platform] = name
    (notices / "policy.json").write_text(json.dumps(index), encoding="utf-8")
    return notices / "policy.json"


def _run_gate_cli(gate, facts, policy_path, archive, sources):
    facts_path = archive.parent / "facts.json"
    facts_path.write_text(json.dumps(facts), encoding="utf-8")
    return gate.main(["--facts", str(facts_path), "--policy", str(policy_path),
                      "--archive-root", str(archive), "--source-dir", str(sources)])


@pytest.mark.parametrize("platform", [LINUX, WINDOWS])
def test_v9_gate_cli_selects_the_policy_for_the_facts_platform(gate, tmp_path, platform):
    facts, _, archive, sources = _v9_case(tmp_path, platform)
    index = _write_policy_tree(tmp_path, {LINUX: _v9_policy(LINUX), WINDOWS: _v9_policy(WINDOWS)})
    assert _run_gate_cli(gate, facts, index, archive, sources) == 0


def test_v9_gate_cli_fails_for_a_platform_the_index_does_not_name(gate, tmp_path):
    facts, _, archive, sources = _v9_case(tmp_path, WINDOWS)
    index = _write_policy_tree(tmp_path, {LINUX: _v9_policy(LINUX)})
    assert _run_gate_cli(gate, facts, index, archive, sources) == 1


def test_v9_gate_cli_fails_when_the_index_is_not_admitted(gate, tmp_path):
    facts, _, archive, sources = _v9_case(tmp_path, LINUX)
    index = _write_policy_tree(tmp_path, {LINUX: _v9_policy(LINUX)})
    data = json.loads(index.read_text(encoding="utf-8"))
    data["admitted"] = False
    index.write_text(json.dumps(data), encoding="utf-8")
    assert _run_gate_cli(gate, facts, index, archive, sources) == 1


def test_v9_gate_cli_reports_unreadable_input(gate, tmp_path):
    facts, _, archive, sources = _v9_case(tmp_path, LINUX)
    broken = tmp_path / "broken-policy.json"
    broken.write_text("{not json", encoding="utf-8")
    assert _run_gate_cli(gate, facts, broken, archive, sources) == 2


# Collector evidence for the module rules: platform label and per-module TOC sources.
REPO_TESTS_INIT = BRIDGE_ROOT / "tests" / "__init__.py"


def _module_source_fixture(collector, monkeypatch, tmp_path, pure):
    _bundle_with(tmp_path, {})
    workpath = tmp_path / "work"
    _analysis_toc(workpath, scripts=[ENTRY_SCRIPT], pure=BASE_PURE + list(pure))
    _controlled_subprocess(monkeypatch, collector)
    return _run_cli(collector, tmp_path, workpath)


def test_cli_records_the_platform_label(collector, monkeypatch, tmp_path):
    code, facts = _module_source_fixture(collector, monkeypatch, tmp_path, [])
    assert code == 0 and facts is not None, f"the collector did not write facts (exit {code})"
    machine = "x86_64" if __import__("platform").machine().lower() in ("x86_64", "amd64") else None
    if machine is None:
        pytest.skip("platform label contract is defined for x86_64 runners only")
    expected = {"linux": LINUX, "win32": WINDOWS}.get(sys.platform)
    assert facts.get("platform") == expected


def test_cli_records_repo_module_source_with_exact_typecode(collector, monkeypatch, tmp_path):
    if not REPO_TESTS_INIT.is_file() or REPO_TESTS_INIT.stat().st_size != 0:
        pytest.fail("prerequisite failed (not RED): bridge/tests/__init__.py is not the empty repo file")
    code, facts = _module_source_fixture(collector, monkeypatch, tmp_path,
                                         [("tests", str(REPO_TESTS_INIT), "PYMODULE-1")])
    assert code == 0 and facts is not None, f"the collector did not write facts (exit {code})"
    if "tests" not in facts["unmapped_modules"]:
        pytest.fail("prerequisite failed (not RED): 'tests' is not unmapped in this fixture")
    assert facts.get("module_sources", {}).get("tests") == [{"typecode": "PYMODULE-1", "source": TESTS_SOURCE}]


def test_cli_records_each_distinct_module_source_without_absolute_paths(collector, monkeypatch, tmp_path):
    first, second = tmp_path / "elsewhere" / "a" / "mystery.py", tmp_path / "elsewhere" / "b" / "mystery.py"
    for path in (first, second):
        path.parent.mkdir(parents=True)
        path.write_bytes(b"same synthetic bytes\n")
    code, facts = _module_source_fixture(collector, monkeypatch, tmp_path, [
        ("mystery", str(first), "PYMODULE"), ("mystery", str(second), "PYMODULE"),
        ("mystery", str(first), "PYMODULE"),  # a repeat of the same file is one source
        ("ghost", str(tmp_path / "missing.py"), "PYMODULE"),
    ])
    assert code == 0 and facts is not None, f"the collector did not write facts (exit {code})"
    other = {"bytes": 21, "kind": "file", "path_class": "other", "relative_path": None,
             "sha256": _sha(b"same synthetic bytes\n")}
    sources = facts.get("module_sources", {})
    assert sources.get("mystery") == [{"typecode": "PYMODULE", "source": other}] * 2, \
        "two distinct source files must stay two entries even when their redacted records match"
    assert sources.get("ghost") == [{"typecode": "PYMODULE",
                                     "source": {"kind": "absent-or-not-regular", "path_class": "other",
                                                "relative_path": None}}]
    assert str(tmp_path) not in json.dumps(sources), "an absolute build path was written"


# --- Archive texts: placeholders, SOURCE.txt and BUILD-INFO.json (tests first) --------
#
# bridge/dev-build/archive_texts.py, used by the package job's licence-gate/archive steps:
#   fill(root, sha)                         {{GIT_SHA}} in README-dev-build.txt,
#       NOTICES/RELINKING.txt and NOTICES/INSTALLATION-INFORMATION.txt; refuses a bad SHA,
#       a missing file, any other {{...}} placeholder or a left-over draft marker.
#   source_text(sha, policy, records, verification) -> SOURCE.txt text. Every policy
#       source archive needs a record (url) and a verification entry with the same SHA256;
#       the application git archive must be of this SHA; a signature entry must be verified.
#       It states how each archive was verified (owner decision 2026-11-12: HTTPS and
#       published checksums; signatures where the publisher provides one; full signature
#       checks before any real release).
#   build_info(sha, platform, bundle, extra) -> BUILD-INFO dict with every bundle file's
#       SHA256 (links as their literal target); verify(info, bundle) -> failure strings.
# Raises archive_texts.InputError for refusals. All values are SYNTHETIC.
ARCHIVE_TEXTS = DEV_BUILD / "archive_texts.py"
GIT_SHA = "0123456789abcdef0123456789abcdef01234567"
DOC_FILES = ("README-dev-build.txt", "NOTICES/RELINKING.txt", "NOTICES/INSTALLATION-INFORMATION.txt")


@pytest.fixture(scope="module")
def texts():
    _require()
    return _load_helper(ARCHIVE_TEXTS, "archive_texts")


def _docs(root):
    for name in DOC_FILES:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{name}\nCommit: {{{{GIT_SHA}}}}\nSee {{{{GIT_SHA}}}} again.\n", encoding="utf-8")
    return root


def test_fill_replaces_the_commit_placeholder_in_each_document(texts, tmp_path):
    root = _docs(tmp_path / "archive")
    texts.fill(root, GIT_SHA)
    for name in DOC_FILES:
        text = (root / name).read_text(encoding="utf-8")
        assert text.count(GIT_SHA) == 2 and "{{" not in text, name


@pytest.mark.parametrize("case", ["short-sha", "missing-file", "other-placeholder", "draft-marker"])
def test_fill_refuses_unfinished_documents(texts, tmp_path, case):
    root = _docs(tmp_path / "archive")
    sha = GIT_SHA
    if case == "short-sha":
        sha = GIT_SHA[:12]
    elif case == "missing-file":
        (root / DOC_FILES[1]).unlink()
    elif case == "other-placeholder":
        (root / DOC_FILES[0]).write_text("Commit: {{GIT_SHA}} built {{DATE}}\n", encoding="utf-8")
    else:
        (root / DOC_FILES[2]).write_text("[DRAFT - UNPUBLISHED, NOT ADMITTED. Remove this block.]\n{{GIT_SHA}}\n",
                                         encoding="utf-8")
    with pytest.raises(texts.InputError):
        texts.fill(root, sha)


SIGNED = "Python-3.10.22.tar.xz"


def _source_inputs():
    archives = [
        {"name": "qt-everywhere-src", "version": "6.12.0", "file": "qt-everywhere-src-6.12.0.tar.xz",
         "sha256": _sha(b"qt")},
        {"name": "cpython", "version": "3.10.22", "file": SIGNED, "sha256": _sha(b"python")},
    ]
    policy = {"platform": LINUX, "source_archives": archives}
    records = [
        {"file": archives[0]["file"], "sha256": archives[0]["sha256"], "kind": "source",
         "url": "https://download.qt.io/official_releases/qt/6.12/6.12.0/single/qt-everywhere-src-6.12.0.tar.xz"},
        {"file": SIGNED, "sha256": archives[1]["sha256"], "kind": "source",
         "url": "https://www.python.org/ftp/python/3.10.22/Python-3.10.22.tar.xz"},
    ]
    verification = {
        "artifact": f"bridge-desktop-dev-sources-{GIT_SHA}",
        "application": {"file": f"silentsuite-bridge-{GIT_SHA}.tar.gz", "sha256": _sha(b"app"), "git_sha": GIT_SHA},
        "archives": [
            {"file": archives[0]["file"], "sha256": archives[0]["sha256"], "signature": None},
            {"file": SIGNED, "sha256": archives[1]["sha256"],
             "signature": {"type": "sigstore", "identity": "release-manager@example.invalid",
                           "issuer": "https://issuer.example.invalid", "verified": True}},
        ],
    }
    return policy, records, verification


def test_source_text_names_every_archive_and_how_it_was_verified(texts):
    policy, records, verification = _source_inputs()
    text = texts.source_text(GIT_SHA, policy, records, verification)
    assert GIT_SHA in text and verification["artifact"] in text
    assert verification["application"]["file"] in text and verification["application"]["sha256"] in text
    for archive, record in zip(policy["source_archives"], records):
        assert archive["file"] in text and archive["sha256"] in text and record["url"] in text
    assert "sigstore" in text.lower() and "release-manager@example.invalid" in text
    assert "no signature" in text.lower(), "unsigned archives must say no signature was checked"
    assert "before any real release" in text.lower()


def _source_mutations():
    def no_record(policy, records, verification):
        del records[0]

    def no_verification(policy, records, verification):
        del verification["archives"][0]

    def record_sha_differs(policy, records, verification):
        records[0]["sha256"] = _sha(b"other")

    def verification_sha_differs(policy, records, verification):
        verification["archives"][1]["sha256"] = _sha(b"other")

    def application_of_another_commit(policy, records, verification):
        verification["application"]["git_sha"] = "f" * 40

    def signature_not_verified(policy, records, verification):
        verification["archives"][1]["signature"]["verified"] = False

    def no_artifact_name(policy, records, verification):
        del verification["artifact"]

    return [no_record, no_verification, record_sha_differs, verification_sha_differs,
            application_of_another_commit, signature_not_verified, no_artifact_name]


@pytest.mark.parametrize("mutate", _source_mutations(), ids=lambda f: f.__name__)
def test_source_text_refuses_unverified_or_mismatched_sources(texts, mutate):
    policy, records, verification = _source_inputs()
    mutate(policy, records, verification)
    with pytest.raises(texts.InputError):
        texts.source_text(GIT_SHA, policy, records, verification)


def _program(root):
    bundle = root / "silentsuite-bridge-desktop"
    (bundle / "_internal" / "lib").mkdir(parents=True)
    (bundle / "silentsuite-bridge-desktop").write_bytes(b"synthetic executable")
    (bundle / "_internal" / "lib" / "libsynthetic.so.1").write_bytes(b"synthetic library")
    if sys.platform != "win32":
        (bundle / "_internal" / "libsynthetic.so.1").symlink_to("lib/libsynthetic.so.1")
    return bundle


def test_build_info_records_identity_and_every_bundle_file(texts, tmp_path):
    bundle = _program(tmp_path)
    info = texts.build_info(GIT_SHA, LINUX, bundle, {"run_id": "1", "run_attempt": "1"})
    assert info["git_sha"] == GIT_SHA and info["platform"] == LINUX and info["run_id"] == "1"
    files = {entry["path"]: entry for entry in info["bundle_files"]}
    assert files["_internal/lib/libsynthetic.so.1"]["sha256"] == _sha(b"synthetic library")
    assert files["silentsuite-bridge-desktop"]["sha256"] == _sha(b"synthetic executable")
    if sys.platform != "win32":
        assert files["_internal/libsynthetic.so.1"] == {"path": "_internal/libsynthetic.so.1",
                                                       "symlink": "lib/libsynthetic.so.1"}
    assert texts.verify(json.loads(json.dumps(info)), bundle) == []


@pytest.mark.parametrize("case", ["changed", "extra", "missing", "relinked"])
def test_verify_reports_bundle_drift(texts, tmp_path, case):
    bundle = _program(tmp_path)
    info = texts.build_info(GIT_SHA, LINUX, bundle, {})
    if case == "changed":
        (bundle / "_internal" / "lib" / "libsynthetic.so.1").write_bytes(b"modified library")
    elif case == "extra":
        (bundle / "_internal" / "added.txt").write_bytes(b"added")
    elif case == "missing":
        (bundle / "silentsuite-bridge-desktop").unlink()
    else:
        if sys.platform == "win32":
            pytest.skip("in-bundle symlinks are a Linux observation here")
        link = bundle / "_internal" / "libsynthetic.so.1"
        link.unlink()
        link.symlink_to("lib/../lib/libsynthetic.so.1")
    assert texts.verify(info, bundle), f"{case} was not reported"


# --- Source materials for the caller's source job (tests first) ---------------------
#
# bridge/dev-build/source_materials.py (network use only in its CLI fetch):
#   plan(records, platforms) -> rows to fetch: "shared" plus each platform's rows,
#       one per file; the same file name with two SHA256s, a non-HTTPS URL or a URL
#       that is a signature bundle rather than the file is refused (InputError).
#       A row may carry sigstore {bundle_url, identity, issuer}.
#   verify(rows, directory, application, artifact, sigstore_check) -> receipt for
#       archive_texts.source_text, or InputError on a missing file, a size or SHA256
#       mismatch, or a sigstore row whose check (sigstore_check(file, bundle, identity,
#       issuer) -> bool) does not pass. Rows without sigstore get signature None.
SOURCE_MATERIALS = DEV_BUILD / "source_materials.py"


@pytest.fixture(scope="module")
def materials():
    _require()
    return _load_helper(SOURCE_MATERIALS, "source_materials")


def _row(name, data, url=None, **extra):
    row = {"file": name, "sha256": _sha(data), "bytes": len(data), "kind": "source", "name": name,
           "version": "1", "url": url or f"https://example.invalid/{name}"}
    row.update(extra)
    return row


SIGSTORE = {"bundle_url": "https://example.invalid/py.tar.xz.sigstore", "identity": "rm@example.invalid",
            "issuer": "https://issuer.example.invalid"}


def _records():
    return {"shared": [_row("qt.tar.xz", b"qt"), _row("py.tar.xz", b"py", sigstore=dict(SIGSTORE))],
            LINUX: [_row("deb.tar.xz", b"deb"), _row("qt.tar.xz", b"qt")],
            WINDOWS: [_row("win.tar.gz", b"win")]}


def test_plan_merges_shared_and_platform_rows_once(materials):
    rows = materials.plan(_records(), [LINUX, WINDOWS])
    assert sorted(r["file"] for r in rows) == ["deb.tar.xz", "py.tar.xz", "qt.tar.xz", "win.tar.gz"]


@pytest.mark.parametrize("case", ["conflicting-sha", "plain-http", "url-is-signature-bundle", "unknown-platform"])
def test_plan_refuses_ambiguous_or_unsafe_rows(materials, case):
    records, platforms = _records(), [LINUX, WINDOWS]
    if case == "conflicting-sha":
        records[WINDOWS].append(_row("qt.tar.xz", b"other qt"))
    elif case == "plain-http":
        records[LINUX][0]["url"] = "http://example.invalid/deb.tar.xz"
    elif case == "url-is-signature-bundle":
        records["shared"][1]["url"] = "https://example.invalid/py.tar.xz.sigstore"
    else:
        platforms = ["macos-arm64"]
    with pytest.raises(materials.InputError):
        materials.plan(records, platforms)


def _fetched(tmp_path, rows):
    directory = tmp_path / "sources"
    directory.mkdir()
    data = {"qt.tar.xz": b"qt", "py.tar.xz": b"py", "deb.tar.xz": b"deb", "win.tar.gz": b"win"}
    for row in rows:
        (directory / row["file"]).write_bytes(data[row["file"]])
    (directory / "py.tar.xz.sigstore").write_bytes(b"synthetic bundle")
    return directory


APPLICATION = {"file": f"silentsuite-bridge-{GIT_SHA}.tar.gz", "sha256": _sha(b"app"), "git_sha": GIT_SHA}
ARTIFACT = f"bridge-desktop-dev-sources-{GIT_SHA}"


def test_verify_writes_a_receipt_that_source_text_accepts(materials, texts, tmp_path):
    rows = materials.plan(_records(), [LINUX, WINDOWS])
    directory = _fetched(tmp_path, rows)
    calls = []

    def check(file, bundle, identity, issuer):
        calls.append((Path(file).name, Path(bundle).name, identity, issuer))
        return True

    receipt = materials.verify(rows, directory, APPLICATION, ARTIFACT, check)
    assert calls == [("py.tar.xz", "py.tar.xz.sigstore", SIGSTORE["identity"], SIGSTORE["issuer"])]
    signed = {a["file"]: a["signature"] for a in receipt["archives"]}
    assert signed["qt.tar.xz"] is None and signed["py.tar.xz"]["verified"] is True
    policy = {"platform": LINUX, "source_archives": [
        {"name": r["name"], "version": r["version"], "file": r["file"], "sha256": r["sha256"]} for r in rows]}
    text = texts.source_text(GIT_SHA, policy, rows, receipt)
    assert "sigstore" in text.lower() and ARTIFACT in text


@pytest.mark.parametrize("case", ["missing-file", "changed-bytes", "signature-fails", "bundle-missing"])
def test_verify_refuses_unverified_sources(materials, tmp_path, case):
    rows = materials.plan(_records(), [LINUX, WINDOWS])
    directory = _fetched(tmp_path, rows)
    result = True
    if case == "missing-file":
        (directory / "deb.tar.xz").unlink()
    elif case == "changed-bytes":
        (directory / "qt.tar.xz").write_bytes(b"qX")
    elif case == "signature-fails":
        result = False
    else:
        (directory / "py.tar.xz.sigstore").unlink()
    with pytest.raises(materials.InputError):
        materials.verify(rows, directory, APPLICATION, ARTIFACT, lambda *args: result)


# The package job does not hold the source archives; the source-materials job of the
# same run hashed them. check(..., source_receipt=receipt) replaces the file check with
# that receipt: every policy archive needs one entry with the same SHA256 (CLI:
# --source-receipt FILE instead of --source-dir).
def _receipt_for(policy):
    return {"artifact": ARTIFACT, "application": APPLICATION,
            "archives": [{"file": a["file"], "sha256": a["sha256"], "signature": None}
                         for a in policy["source_archives"]]}


def test_gate_accepts_a_matching_source_receipt_instead_of_files(gate, tmp_path):
    facts, policy, archive, sources = _v9_case(tmp_path, LINUX)
    (sources / f"{DIST}-{DIST_VERSION}-src.tar.xz").unlink()  # no files: the receipt stands in
    assert gate.check(facts, policy, archive, None, source_receipt=_receipt_for(policy)) == []


@pytest.mark.parametrize("case", ["entry-missing", "sha-differs", "no-archives"])
def test_gate_refuses_a_source_receipt_that_does_not_cover_the_policy(gate, tmp_path, case):
    facts, policy, archive, sources = _v9_case(tmp_path, LINUX)
    receipt = _receipt_for(policy)
    if case == "entry-missing":
        receipt["archives"] = []
    elif case == "sha-differs":
        receipt["archives"][0]["sha256"] = _sha(b"other")
    else:
        del receipt["archives"]
    assert gate.check(facts, policy, archive, None, source_receipt=receipt)


def test_gate_cli_uses_a_source_receipt(gate, tmp_path):
    facts, _, archive, sources = _v9_case(tmp_path, LINUX)
    index = _write_policy_tree(tmp_path, {LINUX: _v9_policy(LINUX)})
    receipt = tmp_path / "source-verification.json"
    receipt.write_text(json.dumps(_receipt_for(_v9_policy(LINUX))), encoding="utf-8")
    facts_path = archive.parent / "facts.json"
    facts_path.write_text(json.dumps(facts), encoding="utf-8")
    code = gate.main(["--facts", str(facts_path), "--policy", str(index), "--archive-root", str(archive),
                      "--source-receipt", str(receipt)])
    assert code == 0


# Review corrections at d39e3a9c (Codex R1, R2; reassessed Medium, fix).
def test_source_text_accepts_a_receipt_that_also_covers_the_other_platform(texts):
    # The source job verifies both platforms into one receipt; each package job writes
    # SOURCE.txt for its own policy and lists only that policy's archives.
    policy, records, verification = _source_inputs()
    verification["archives"].append({"file": "windows-only.tar.gz", "sha256": _sha(b"win"), "signature": None})
    text = texts.source_text(GIT_SHA, policy, records, verification)
    assert "windows-only.tar.gz" not in text


@pytest.mark.parametrize("where", ["direct", "indexed"])
def test_gate_cli_fails_an_empty_policy(gate, tmp_path, where):
    facts, _, archive, sources = _v9_case(tmp_path, LINUX)
    if where == "direct":
        policy_path = tmp_path / "empty-policy.json"
        policy_path.write_text("{}", encoding="utf-8")
    else:
        policy_path = _write_policy_tree(tmp_path, {LINUX: {}})
    assert _run_gate_cli(gate, facts, policy_path, archive, sources) == 1
