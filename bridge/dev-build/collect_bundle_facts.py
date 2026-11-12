"""Collect text facts about a built SilentSuite Bridge desktop bundle (#171, S2-C).

Facts only. It does not decide licensing, does not launch the bundled app, and
never uploads or copies the bundle. Everything unknown is reported, not guessed:
files or modules without an owning installed distribution go to
``unmapped_files`` / ``unmapped_modules``.

Library use (tested in bridge/tests/test_desktop_dev_licence_gate.py):
    collect(bundle_root, modules, search_path) -> facts dict, schema_version 1

CLI (run by .github/workflows/test-bridge-desktop-dev.yml with the build
interpreter, after the desktop spec built into --dist/--workpath):
    python collect_bundle_facts.py --dist DIR --workpath DIR --out FILE
Exit 0 when the facts file was written, 2 for unreadable or invalid input,
including module evidence that does not contain the app's own package.

Sources of each observation:
- bundle files: a walk of the onedir bundle, SHA256 of each file;
- owners: installed distributions' RECORD (by path under ``_internal/``, then,
  with build evidence, by the file's build source path, then by RECORD SHA256
  for non-empty files) and ``top_level.txt``;
- licence and notice texts: the owning distribution's own files, full text and
  SHA256 of the raw bytes (every RECORD entry under ``<dist-info>/licenses/``,
  RECORD entries with licence/notice names, plus License-File headers);
  ``dist_info_files`` lists every RECORD entry of the dist-info directory;
- modules and scripts: the PYMODULE[-N] / PYSOURCE[-N] entries of PyInstaller's
  ``Analysis-00.toc`` in --workpath (-N is the bytecode optimization level);
- per-module TOC sources (``module_sources``, unmapped modules only): each
  distinct source file with its exact typecode, as a path class (repo,
  site-packages, stdlib or other), a relative path (none for other), SHA256 and
  size; absolute build paths are compared in memory and never written;
- platform label (``platform``): ``linux-x86_64`` / ``windows-x86_64``;
- per-file origin (``file_origins``): the build source path from the same TOC,
  classified by location: wheel, the bundle's own bootloader executable,
  PyInstaller-generated (under --workpath), interpreter runtime (under
  sys.base_prefix), a Linux dpkg package (owner, version, copyright file), or
  unknown; an in-bundle link is ``bundle-link`` (with its target's origin) only
  when its SYMLINK TOC entry and the actual bundle symlink name the same relative
  target and that target is an existing file inside the bundle, else unknown;
- wheel tags and build tag: each distribution's own WHEEL file;
- Qt version and build string: the build interpreter's PySide6.QtCore, in a
  subprocess (only QtCore; no window, web engine or bundled app is started);
- WebEngine/Chromium versions: the build interpreter's PySide6.QtWebEngineCore
  qWebEngineVersion(), qWebEngineChromiumVersion() and
  qWebEngineChromiumSecurityPatchVersion(), in a separate subprocess that creates
  no application, profile, page or window; failures are recorded, never fatal.
"""

from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import importlib.metadata
import json
import os
import posixpath
import re
import platform
import subprocess
import sys
import sysconfig
from pathlib import Path, PurePosixPath

SCHEMA_VERSION = 1
CONTENTS_DIR = "_internal"  # PyInstaller 6 onedir contents directory (spec default)
ENTRY_PACKAGE = "silentsuite_bridge"  # the desktop entry imports it; its absence means incomplete evidence
MODULE_TYPECODES = {"PYMODULE", "PYMODULE-1", "PYMODULE-2"}  # PyInstaller 6.22.3 build_main.py:874
SCRIPT_TYPECODES = {"PYSOURCE", "PYSOURCE-1", "PYSOURCE-2"}  # PyInstaller 6.22.3 build_main.py:806
LICENCE_NAME = re.compile(r"^(licen[cs]e|copying|notice|copyright)|third[_-]?party|3rd[_-]?party", re.IGNORECASE)
NOT_TEXT_SUFFIXES = (".py", ".pyc", ".pyd", ".so", ".dll", ".dylib", ".exe")
NATIVE_LIBRARY = re.compile(r"\.(dll|dylib|exe)$|\.so(\.\d+)*$", re.IGNORECASE)
QT_LIBRARY_NAME = re.compile(r"^(lib)?Qt6|^QtWebEngineProcess", re.IGNORECASE)
QT_PLUGIN_DIRS = ("PySide6/Qt/plugins/", "PySide6/plugins/")
QT_PROBE = (
    "import json; from PySide6 import QtCore; "
    "print(json.dumps({'qVersion': QtCore.qVersion(), 'build': QtCore.QLibraryInfo.build()}))"
)
# Documented PySide6.QtWebEngineCore global functions (qt-webengine-version-api-evidence.json).
WEBENGINE_FUNCTIONS = ("qWebEngineVersion", "qWebEngineChromiumVersion", "qWebEngineChromiumSecurityPatchVersion")
WEBENGINE_PROBE = (
    "import json; from PySide6 import QtWebEngineCore; "
    f"print(json.dumps({{name: getattr(QtWebEngineCore, name)() for name in {WEBENGINE_FUNCTIONS!r}}}))"
)
DPKG_DOC_ROOT = Path("/usr/share/doc")
REPO_ROOT = Path(__file__).resolve().parents[2]  # bridge/dev-build/ -> the repository checkout


class InputError(Exception):
    """Unreadable or invalid input; the CLI exits 2."""


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _record_hash(hex_digest: str) -> str:
    return "sha256=" + base64.urlsafe_b64encode(bytes.fromhex(hex_digest)).rstrip(b"=").decode("ascii")


def _real(path) -> str:
    return os.path.normcase(os.path.realpath(str(path)))


def _within(path, root) -> bool:
    path, root = _real(path), _real(root)
    try:
        return path != root and os.path.commonpath([path, root]) == root
    except ValueError:  # different drives on Windows
        return False


def _bundle_files(bundle_root: Path) -> list[dict]:
    root = bundle_root.resolve()
    entries = []
    for directory, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            entry = {"path": relative}
            if path.is_symlink():
                entry["symlink"] = os.readlink(path)
                target = path.resolve()
                if root not in target.parents:
                    entry.update({"sha256": None, "size": None, "symlink_outside_bundle": True})
                    entries.append(entry)
                    continue
                if not target.exists():  # an in-bundle link to nothing: observed, not hashed
                    entry.update({"sha256": None, "size": None, "symlink_dangling": True})
                    entries.append(entry)
                    continue
            entry["sha256"] = _sha256_file(path)
            entry["size"] = path.stat().st_size
            entries.append(entry)
    return entries


def _inner(relative: str) -> str:
    return relative[len(CONTENTS_DIR) + 1:] if relative.startswith(CONTENTS_DIR + "/") else relative


def _dist_info_dir(files) -> str | None:
    for entry in files:
        first = PurePosixPath(str(entry)).parts[0]
        if first.endswith(".dist-info"):
            return first
    return None


def _top_level_names(dist, files) -> set[str]:
    names = set()
    for entry in files:
        parts = PurePosixPath(str(entry)).parts
        if not parts or parts[0] in ("..", "__pycache__") or parts[0].endswith((".dist-info", ".egg-info", ".data")):
            continue
        names.add(parts[0] if len(parts) > 1 else parts[0].split(".", 1)[0])
    top_level = dist.read_text("top_level.txt")
    if top_level:
        names.update(line.strip() for line in top_level.splitlines() if line.strip())
    return names


def _text_record(display: str, data: bytes) -> dict:
    """A notice record from raw bytes; undecodable bytes are reported, not decoded."""
    try:
        return {"path": display, "sha256": hashlib.sha256(data).hexdigest(), "text": data.decode("utf-8")}
    except UnicodeDecodeError:
        return {"path": display, "sha256": hashlib.sha256(data).hexdigest(), "text": None, "undecodable": True}


def _licence_files(dist, files, info_dir) -> tuple[list[dict], list[str]]:
    found: dict[str, dict] = {}

    def read(display: str, path) -> None:
        try:
            found[display] = _text_record(display, Path(path).read_bytes())
        except OSError:
            found[display] = {"path": display, "sha256": None, "text": None, "unreadable": True}

    for entry in files:
        posix = PurePosixPath(str(entry))
        in_info = bool(info_dir) and posix.parts[0] == info_dir
        in_licences = in_info and len(posix.parts) > 2 and posix.parts[1] == "licenses"
        named = bool(LICENCE_NAME.search(posix.name)) and not posix.name.lower().endswith(NOT_TEXT_SUFFIXES)
        if not (in_licences or named):
            continue
        read("/".join(posix.parts[1:]) if in_info else posix.as_posix(), entry.locate())

    missing = []
    for declared in dist.metadata.get_all("License-File") or []:
        if declared in found or f"licenses/{declared}" in found:
            continue
        for candidate in (f"licenses/{declared}", declared):
            # Raw bytes from the dist-info directory: no newline translation.
            path = Path(dist.locate_file(f"{info_dir}/{candidate}")) if info_dir else None
            if path is not None and path.is_file():
                read(candidate, path)
                break
        else:
            missing.append(declared)
    return [found[key] for key in sorted(found)], missing


def _dist_info_listing(files, info_dir) -> list[dict]:
    listing = []
    for entry in files:
        posix = PurePosixPath(str(entry))
        if not info_dir or posix.parts[0] != info_dir:
            continue
        relative = "/".join(posix.parts[1:])
        try:
            listing.append({"path": relative, "sha256": _sha256_file(Path(entry.locate()))})
        except OSError:
            listing.append({"path": relative, "sha256": None, "unreadable": True})
    return sorted(listing, key=lambda item: item["path"])


def _wheel(dist) -> dict | None:
    text = dist.read_text("WHEEL")
    if text is None:
        return None
    tags = [line.split(":", 1)[1].strip() for line in text.splitlines() if line.startswith("Tag:")]
    builds = [line.split(":", 1)[1].strip() for line in text.splitlines() if line.startswith("Build:")]
    return {"tags": tags, "build": builds[0] if builds else None}


def _run_query(argv) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None


def _dpkg_owner(source: str) -> dict | None:
    """The single dpkg package owning ``source`` (or its resolved path), with version and copyright."""
    queried = [source] + ([os.path.realpath(source)] if os.path.realpath(source) != source else [])
    for path in queried:
        done = _run_query(["dpkg-query", "-S", path])
        if done is None or done.returncode != 0:
            continue
        packages = set()
        for line in done.stdout.splitlines():
            if line.startswith("diversion ") or ": " not in line:
                continue
            owners, owned_path = line.split(": ", 1)
            if owned_path.strip() == path:
                packages.update(owner.strip() for owner in owners.split(","))
        if len(packages) != 1:
            return {"class": "unknown", "source": source, "dpkg_candidates": sorted(packages)} if packages else None
        package = packages.pop()
        version = _run_query(["dpkg-query", "-W", "-f=${Version}", package])
        origin = {"class": "os-package", "source": source, "dpkg_path": path, "package": package,
                  "version": version.stdout.strip() if version is not None and version.returncode == 0 else None}
        copyright_path = DPKG_DOC_ROOT / package.split(":", 1)[0] / "copyright"
        try:
            record = _text_record(str(copyright_path), copyright_path.read_bytes())
            origin.update({"copyright": record["text"], "copyright_sha256": record["sha256"],
                           "copyright_missing": False})
            if record.get("undecodable"):
                origin["copyright_undecodable"] = True
        except OSError:
            origin.update({"copyright": None, "copyright_missing": True})
        return origin
    return None


def _origin(relative: str, source: str | None, build: dict) -> dict:
    """Classify a non-wheel bundle file by where the build took it from; never by its name."""
    if relative == build["executable"]:
        return {"class": "pyinstaller-bootloader", "source": None}
    if not source:
        return {"class": "unknown", "source": None}
    if _within(source, build["workpath"]):
        return {"class": "pyinstaller-generated", "source": source}
    if _within(source, sys.base_prefix):
        return {"class": "interpreter-runtime", "source": source}
    if sys.platform.startswith("linux"):
        owner = _dpkg_owner(source)
        if owner is not None:
            return owner
    return {"class": "unknown", "source": source}


def _link_origin(entry: dict, link_source: str, entries_by_path: dict, file_origins: dict, root: Path) -> dict:
    """A source-backed in-bundle link, or unknown.

    PyInstaller 6.22.3 records a preserved link as (dest, rel_link, 'SYMLINK') with
    rel_link relative to dirname(dest) (building/datastruct.py:453-454), and COLLECT
    creates os.symlink(rel_link, dest) (building/api.py:1213). Both must agree under
    this platform's path rules, and the link must actually reach the existing regular
    in-bundle file whose origin it inherits. On POSIX a backslash is an ordinary
    filename character, so it is never treated as a separator here.
    """
    unknown = {"class": "unknown", "source": link_source}
    observed = entry.get("symlink")
    if observed is None or entry.get("symlink_outside_bundle") or entry.get("symlink_dangling"):
        return unknown
    wanted = link_source
    if os.sep == "\\":  # Windows only: backslash is a separator in both spellings
        observed, wanted = observed.replace("\\", "/"), wanted.replace("\\", "/")
    if observed != wanted or PurePosixPath(wanted).is_absolute():
        return unknown
    target = posixpath.normpath(posixpath.join(posixpath.dirname(entry["path"]), wanted))
    if target == ".." or target.startswith("../"):
        return unknown
    target_entry = entries_by_path.get(target)
    if target_entry is None or "symlink" in target_entry or target not in file_origins:
        return unknown
    try:  # the file the link really reaches must be that very target, not a same-named lookalike
        if not os.path.samefile(root / entry["path"], root / target):
            return unknown
    except OSError:
        return unknown
    return {"class": "bundle-link", "source": link_source, "target": target,
            "target_origin": dict(file_origins[target])}


def collect(bundle_root, modules, search_path=None, build=None) -> dict:
    """Facts for ``bundle_root`` (the onedir folder) given its bundled ``modules``.

    ``build`` (CLI only) carries the PyInstaller evidence: ``sources`` (bundle path
    under ``_internal/`` -> build source path), ``links`` (the SYMLINK subset:
    bundle path -> relative link target), ``workpath`` and ``executable``.
    Without it no file has a trusted origin, so every non-wheel file is unknown.
    """
    bundle_root = Path(bundle_root)
    if not bundle_root.is_dir():
        raise InputError("bundle root is not a directory")
    search_path = list(sys.path if search_path is None else search_path)

    distributions = {}
    duplicates = []
    for dist in importlib.metadata.distributions(path=search_path):
        name = dist.metadata["Name"]
        if not name:
            continue
        key = re.sub(r"[-_.]+", "-", name).lower()
        if key in distributions:
            duplicates.append(name)
            continue
        distributions[key] = dist

    by_path: dict[str, list[str]] = {}
    by_hash: dict[str, set[str]] = {}
    by_source: dict[str, set[str]] = {}
    tops: dict[str, set[str]] = {}
    records = {}
    for key, dist in distributions.items():
        files = list(dist.files or [])
        records[key] = files
        for entry in files:
            posix = PurePosixPath(str(entry)).as_posix()
            by_path.setdefault(posix, []).append(key)
            if entry.hash and entry.hash.mode == "sha256":
                by_hash.setdefault(f"sha256={entry.hash.value}", set()).add(key)
            if build is not None:
                by_source.setdefault(_real(entry.locate()), set()).add(key)
        for top in _top_level_names(dist, files):
            tops.setdefault(top, set()).add(key)

    sources = (build or {}).get("sources", {})
    links = (build or {}).get("links", {})
    bundle_files = _bundle_files(bundle_root)
    owned: dict[str, list[str]] = {}
    file_owners = {}
    file_origins = {}
    unmapped_files = []
    ambiguous_files = []
    pending_links = []
    for entry in bundle_files:
        relative = entry["path"]
        source = sources.get(_inner(relative))
        link_source = links.get(_inner(relative))
        owners = sorted(set(by_path.get(_inner(relative), [])))
        match = "record-path"
        if not owners and source and link_source is None:  # a link target is not a build path
            owners = sorted(by_source.get(_real(source), set()))
            match = "record-source"
        if not owners and entry.get("sha256") and entry.get("size"):
            owners = sorted(by_hash.get(_record_hash(entry["sha256"]), set()))
            match = "record-hash"
        if len(owners) == 1:
            owned.setdefault(owners[0], []).append(relative)
            name = distributions[owners[0]].metadata["Name"]
            file_owners[relative] = {"distribution": name, "match": match}
            file_origins[relative] = {"class": "wheel", "distribution": name, "match": match, "source": source}
            continue
        unmapped_files.append(relative)
        if owners:
            ambiguous_files.append({"path": relative, "candidates": owners, "match": match})
        if build is None:
            file_origins[relative] = {"class": "unknown", "source": None}
        elif link_source is not None:
            pending_links.append((entry, link_source))  # resolved once every target has its origin
        else:
            file_origins[relative] = _origin(relative, source, build)

    entries_by_path = {entry["path"]: entry for entry in bundle_files}
    resolved_root = bundle_root.resolve()  # the root _bundle_files made every entry path relative to
    for entry, link_source in pending_links:
        file_origins[entry["path"]] = _link_origin(entry, link_source, entries_by_path, file_origins, resolved_root)

    stdlib = getattr(sys, "stdlib_module_names", frozenset())
    module_owners = {}
    owned_modules: dict[str, list[str]] = {}
    stdlib_modules, unmapped_modules = [], []
    for module in sorted(set(modules)):
        top = module.split(".", 1)[0]
        owners = sorted(tops.get(top, set()))
        if owners:
            module_owners[module] = [distributions[key].metadata["Name"] for key in owners]
            for key in owners:
                owned_modules.setdefault(key, []).append(module)
        elif top in stdlib:
            stdlib_modules.append(module)
        else:
            unmapped_modules.append(module)

    module_entries = (build or {}).get("module_entries")
    module_sources = None
    if module_entries is not None:
        module_sources = {module: _module_source_records(module_entries.get(module, []))
                          for module in unmapped_modules}

    dist_facts = []
    for key in sorted(set(owned) | set(owned_modules)):
        dist = distributions[key]
        metadata = dist.metadata
        files = records[key]
        info_dir = _dist_info_dir(files)
        licence_files, missing = _licence_files(dist, files, info_dir)
        dist_facts.append({
            "name": metadata["Name"],
            "version": dist.version,
            "license": metadata.get("License"),
            "license_expression": metadata.get("License-Expression"),
            "license_classifiers": [c for c in metadata.get_all("Classifier") or [] if c.startswith("License ::")],
            "license_files": licence_files,
            "declared_license_files_missing": missing,
            "dist_info_files": _dist_info_listing(files, info_dir),
            "record_present": bool(files),
            "wheel": _wheel(dist),
            "bundle_files": sorted(owned.get(key, [])),
            "modules": sorted(owned_modules.get(key, [])),
        })

    qt_libraries = []
    for entry in bundle_files:
        relative = entry["path"]
        name = PurePosixPath(relative).name
        if NATIVE_LIBRARY.search(name) and (QT_LIBRARY_NAME.search(name) or _inner(relative).startswith(QT_PLUGIN_DIRS)):
            qt_libraries.append(relative)

    facts = {
        "schema_version": SCHEMA_VERSION,
        "bundle_files": bundle_files,
        "distributions": dist_facts,
        "file_owners": file_owners,
        "file_origins": file_origins,
        "module_owners": module_owners,
        "stdlib_modules": stdlib_modules,
        "unmapped_modules": unmapped_modules,
        "unmapped_files": unmapped_files,
        "ambiguous_files": ambiguous_files,
        "duplicate_distributions": sorted(duplicates),
        "distributions_without_licence_files": sorted(d["name"] for d in dist_facts if not d["license_files"]),
        "qt_libraries": qt_libraries,
        "stdlib_names_available": bool(stdlib),
    }
    if module_sources is not None:
        facts["module_sources"] = module_sources
    return facts


def _path_class(path: Path) -> tuple[str, str | None]:
    """A privacy-safe class and relative path for a build source (C5 shape); never an absolute path."""
    roots = [("repo", REPO_ROOT)]
    paths = sysconfig.get_paths()
    roots += [("site-packages", Path(paths[key]).resolve()) for key in ("purelib", "platlib")]
    roots.append(("stdlib", Path(paths["stdlib"]).resolve()))
    for label, root in roots:
        if root == path or root in path.parents:
            return label, path.relative_to(root).as_posix()
    return "other", None


def _module_source_records(entries) -> list[dict]:
    """One record per distinct (typecode, real source file); a repeated TOC entry is one source."""
    seen = {}
    for typecode, source in entries:
        if source is None or source == "-":
            seen.setdefault((typecode, None), {"typecode": typecode, "source": {"kind": "namespace-or-no-source"}})
            continue
        path = Path(source).resolve()
        identity = (typecode, os.path.normcase(str(path)))  # in memory only
        if identity in seen:
            continue
        label, relative = _path_class(path)
        record = {"kind": "file", "path_class": label, "relative_path": relative}
        try:
            if not path.is_file():
                record["kind"] = "absent-or-not-regular"
            else:
                record["sha256"] = _sha256_file(path)
                record["bytes"] = path.stat().st_size
        except OSError:
            record = {"kind": "unhashable", "path_class": label, "relative_path": relative}
        seen[identity] = {"typecode": typecode, "source": record}
    return sorted(seen.values(), key=lambda item: json.dumps(item, sort_keys=True))


def _platform_label() -> str:
    machine = platform.machine().lower()
    machine = "x86_64" if machine in ("x86_64", "amd64") else machine
    system = {"linux": "linux", "win32": "windows", "darwin": "macos"}.get(sys.platform, sys.platform)
    return f"{system}-{machine}"


# --- CLI: real PyInstaller evidence ---------------------------------------------


def _single_bundle(dist_dir: Path) -> Path:
    if sys.platform == "darwin":
        raise InputError("macOS .app bundles are outside this collector's Linux/Windows scope")
    suffix = ".exe" if sys.platform == "win32" else ""
    if not dist_dir.is_dir():
        raise InputError("--dist is not a directory")
    found = [d for d in sorted(dist_dir.iterdir()) if d.is_dir() and (d / f"{d.name}{suffix}").is_file()]
    if len(found) != 1:
        raise InputError(f"--dist must contain exactly one onedir bundle; found {len(found)}")
    if not (found[0] / CONTENTS_DIR).is_dir():
        raise InputError(f"the bundle has no {CONTENTS_DIR}/ contents directory")
    return found[0]


def _toc_entries(value):
    """Yield (name, source, typecode) triples anywhere inside a parsed TOC structure."""
    if isinstance(value, (list, tuple)):
        if len(value) == 3 and all(isinstance(item, str) or item is None for item in value) \
                and isinstance(value[2], str) and value[2].isupper():
            yield value
            return
        for item in value:
            yield from _toc_entries(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _toc_entries(item)


def _analysis_evidence(workpath: Path, bundle_name: str) -> tuple[list[str], list[str], dict, dict, list[str], dict,
                                                                  dict]:
    if not workpath.is_dir():
        raise InputError("--workpath is not a directory")
    tocs = sorted(workpath.glob("*/Analysis-00.toc"))
    if len(tocs) != 1:
        raise InputError(f"--workpath must hold exactly one */Analysis-00.toc; found {len(tocs)}")
    try:
        text = tocs[0].read_text(encoding="utf-8")
        parsed = ast.literal_eval(text)
    except (OSError, UnicodeDecodeError, ValueError, SyntaxError) as exc:
        raise InputError(f"Analysis-00.toc is not a readable literal TOC ({type(exc).__name__})") from None
    modules, scripts = set(), set()
    module_entries: dict[str, list] = {}
    sources: dict[str, str | None] = {}
    links: dict[str, str] = {}
    conflicts = set()
    for name, source, typecode in _toc_entries(parsed):
        if typecode in MODULE_TYPECODES:
            modules.add(name)
            module_entries.setdefault(name, []).append((typecode, source))
        elif typecode in SCRIPT_TYPECODES:
            scripts.add(name)
        elif source and source != "-":
            # Collected file: name is its destination under _internal/.
            destination = PurePosixPath(name.replace("\\", "/")).as_posix()
            if destination in sources and sources[destination] != source:
                conflicts.add(destination)
            sources.setdefault(destination, source)
            if typecode == "SYMLINK":  # source is the relative link target, not a build path
                links.setdefault(destination, source)
    for destination in conflicts:
        sources[destination] = None  # two different build sources: origin unknown
        links.pop(destination, None)
    if not modules:
        raise InputError("Analysis-00.toc lists no PYMODULE entries")
    if not any(module == ENTRY_PACKAGE or module.startswith(ENTRY_PACKAGE + ".") for module in modules):
        raise InputError(f"Analysis-00.toc module evidence does not contain {ENTRY_PACKAGE}; incomplete")
    toc = {"path": tocs[0].relative_to(workpath).as_posix(), "sha256": _sha256_file(tocs[0]),
           "bundle": bundle_name}
    return sorted(modules), sorted(scripts), toc, sources, sorted(conflicts), links, module_entries


def _probe_observation(source: str, code: str, keys=None) -> dict:
    """Run ``code`` in the build interpreter and record its last JSON line, never failing.

    With ``keys``, the value must be a JSON object of exactly those string fields;
    anything else is reported as an error with value null.
    """
    observation = {"source": source}
    try:
        done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        observation.update({"value": None, "error": type(exc).__name__})
        return observation
    observation["returncode"] = done.returncode
    if done.returncode == 0:
        try:
            value = json.loads(done.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            observation.update({"value": None, "error": "unparsable probe output"})
            return observation
        if keys is not None and not (isinstance(value, dict) and set(value) == set(keys)
                                     and all(isinstance(value[key], str) for key in keys)):
            observation.update({"value": None, "error": "unexpected probe output"})
            return observation
        observation["value"] = value
    else:
        observation.update({"value": None, "stderr_tail": done.stderr[-1000:]})
    return observation


def _qt_observation() -> dict:
    return _probe_observation(
        "build interpreter subprocess: PySide6.QtCore.qVersion() and QLibraryInfo.build()", QT_PROBE)


def _webengine_observation() -> dict:
    # Imports only PySide6.QtWebEngineCore and calls its documented version functions;
    # no application, profile, page or window is created. A missing module or
    # function exits non-zero and is recorded as value null with stderr_tail.
    return _probe_observation(
        "build interpreter subprocess: PySide6.QtWebEngineCore " + ", ".join(f"{name}()" for name in WEBENGINE_FUNCTIONS),
        WEBENGINE_PROBE, WEBENGINE_FUNCTIONS)


def _tool_version(name: str):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Collect text facts about a built desktop bundle (no upload).")
    parser.add_argument("--dist", required=True, type=Path)
    parser.add_argument("--workpath", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        bundle = _single_bundle(args.dist)
        modules, scripts, toc, sources, conflicts, links, module_entries = _analysis_evidence(args.workpath,
                                                                                             bundle.name)
        executable = bundle.name + (".exe" if sys.platform == "win32" else "")
        build = {"sources": sources, "links": links, "workpath": args.workpath, "executable": executable,
                 "module_entries": module_entries}
        facts = collect(bundle, modules, build=build)
        facts["platform"] = _platform_label()
    except InputError as exc:
        print(f"collect_bundle_facts: invalid input: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"collect_bundle_facts: unreadable input ({type(exc).__name__})", file=sys.stderr)
        return 2
    facts["observations"] = {
        "bundle": bundle.name,
        "analysis_toc": toc,
        "scripts": scripts,
        "toc_source_conflicts": conflicts,
        "python": {"version": sys.version.split()[0], "implementation": sys.implementation.name,
                   "platform": sys.platform},
        "pyinstaller": _tool_version("pyinstaller"),
        "qt": _qt_observation(),
        "webengine": _webengine_observation(),
    }
    try:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.out.with_suffix(args.out.suffix + ".tmp")
        temporary.write_text(json.dumps(facts, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(temporary, args.out)
    except OSError as exc:
        print(f"collect_bundle_facts: cannot write --out ({type(exc).__name__})", file=sys.stderr)
        return 2
    print(f"collect_bundle_facts: {len(facts['bundle_files'])} files, {len(facts['distributions'])} owning "
          f"distributions, {len(facts['unmapped_files'])} unmapped files, "
          f"{len(facts['unmapped_modules'])} unmapped modules, {len(facts['qt_libraries'])} Qt libraries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
