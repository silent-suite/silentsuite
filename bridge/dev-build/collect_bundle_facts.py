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
Exit 0 when the facts file was written, 2 for unreadable or invalid input.

Sources of each observation:
- bundle files: a walk of the onedir bundle, SHA256 of each file;
- owners: installed distributions' RECORD (by path under ``_internal/``, else
  by RECORD SHA256 for non-empty files) and ``top_level.txt``;
- licence and notice texts: the owning distribution's own files, full text and
  SHA256 (RECORD entries with licence/notice names, plus License-File headers);
- modules: the PYMODULE entries of PyInstaller's ``Analysis-00.toc`` in --workpath;
- wheel tags and build tag: each distribution's own WHEEL file;
- Qt version and build string: the build interpreter's PySide6.QtCore, in a
  subprocess (only QtCore; no window, web engine or bundled app is started).
"""

from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import importlib.metadata
import json
import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

SCHEMA_VERSION = 1
CONTENTS_DIR = "_internal"  # PyInstaller 6 onedir contents directory (spec default)
LICENCE_NAME = re.compile(r"^(licen[cs]e|copying|notice|copyright)|third[_-]?party|3rd[_-]?party", re.IGNORECASE)
NOT_TEXT_SUFFIXES = (".py", ".pyc", ".pyd", ".so", ".dll", ".dylib", ".exe")
NATIVE_LIBRARY = re.compile(r"\.(dll|dylib|exe)$|\.so(\.\d+)*$", re.IGNORECASE)
QT_LIBRARY_NAME = re.compile(r"^(lib)?Qt6|^QtWebEngineProcess", re.IGNORECASE)
QT_PLUGIN_DIRS = ("PySide6/Qt/plugins/", "PySide6/plugins/")
QT_PROBE = (
    "import json; from PySide6 import QtCore; "
    "print(json.dumps({'qVersion': QtCore.qVersion(), 'build': QtCore.QLibraryInfo.build()}))"
)


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
            entry["sha256"] = _sha256_file(path)
            entry["size"] = path.stat().st_size
            entries.append(entry)
    return entries


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


def _licence_files(dist, files, info_dir) -> tuple[list[dict], list[str]]:
    found: dict[str, dict] = {}

    def add(display: str, data: bytes) -> None:
        try:
            text = data.decode("utf-8")
            found[display] = {"path": display, "sha256": hashlib.sha256(data).hexdigest(), "text": text}
        except UnicodeDecodeError:
            found[display] = {"path": display, "sha256": hashlib.sha256(data).hexdigest(), "text": None,
                              "undecodable": True}

    for entry in files:
        posix = PurePosixPath(str(entry))
        if not LICENCE_NAME.search(posix.name) or posix.name.lower().endswith(NOT_TEXT_SUFFIXES):
            continue
        display = "/".join(posix.parts[1:]) if info_dir and posix.parts[0] == info_dir else posix.as_posix()
        try:
            add(display, Path(entry.locate()).read_bytes())
        except OSError:
            found[display] = {"path": display, "sha256": None, "text": None, "unreadable": True}

    missing = []
    for declared in dist.metadata.get_all("License-File") or []:
        if declared in found or f"licenses/{declared}" in found:
            continue
        for candidate in (f"licenses/{declared}", declared):
            text = dist.read_text(candidate)
            if text is not None:
                add(candidate, text.encode("utf-8"))
                break
        else:
            missing.append(declared)
    return [found[key] for key in sorted(found)], missing


def _wheel(dist) -> dict | None:
    text = dist.read_text("WHEEL")
    if text is None:
        return None
    tags = [line.split(":", 1)[1].strip() for line in text.splitlines() if line.startswith("Tag:")]
    builds = [line.split(":", 1)[1].strip() for line in text.splitlines() if line.startswith("Build:")]
    return {"tags": tags, "build": builds[0] if builds else None}


def collect(bundle_root, modules, search_path=None) -> dict:
    """Facts for ``bundle_root`` (the onedir folder) given its bundled ``modules``."""
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
        for top in _top_level_names(dist, files):
            tops.setdefault(top, set()).add(key)

    bundle_files = _bundle_files(bundle_root)
    owned: dict[str, list[str]] = {}
    file_owners = {}
    unmapped_files = []
    ambiguous_files = []
    for entry in bundle_files:
        relative = entry["path"]
        inner = relative[len(CONTENTS_DIR) + 1:] if relative.startswith(CONTENTS_DIR + "/") else relative
        owners = sorted(set(by_path.get(inner, [])))
        match = "record-path"
        if not owners and entry.get("sha256") and entry.get("size"):
            owners = sorted(by_hash.get(_record_hash(entry["sha256"]), set()))
            match = "record-hash"
        if len(owners) == 1:
            owned.setdefault(owners[0], []).append(relative)
            file_owners[relative] = {"distribution": distributions[owners[0]].metadata["Name"], "match": match}
        else:
            unmapped_files.append(relative)
            if owners:
                ambiguous_files.append({"path": relative, "candidates": owners, "match": match})

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

    dist_facts = []
    for key in sorted(set(owned) | set(owned_modules)):
        dist = distributions[key]
        metadata = dist.metadata
        files = records[key]
        licence_files, missing = _licence_files(dist, files, _dist_info_dir(files))
        dist_facts.append({
            "name": metadata["Name"],
            "version": dist.version,
            "license": metadata.get("License"),
            "license_expression": metadata.get("License-Expression"),
            "license_classifiers": [c for c in metadata.get_all("Classifier") or [] if c.startswith("License ::")],
            "license_files": licence_files,
            "declared_license_files_missing": missing,
            "record_present": bool(files),
            "wheel": _wheel(dist),
            "bundle_files": sorted(owned.get(key, [])),
            "modules": sorted(owned_modules.get(key, [])),
        })

    qt_libraries = []
    for entry in bundle_files:
        relative = entry["path"]
        inner = relative[len(CONTENTS_DIR) + 1:] if relative.startswith(CONTENTS_DIR + "/") else relative
        name = PurePosixPath(relative).name
        if NATIVE_LIBRARY.search(name) and (QT_LIBRARY_NAME.search(name) or inner.startswith(QT_PLUGIN_DIRS)):
            qt_libraries.append(relative)

    return {
        "schema_version": SCHEMA_VERSION,
        "bundle_files": bundle_files,
        "distributions": dist_facts,
        "file_owners": file_owners,
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


def _analysis_modules(workpath: Path, bundle_name: str) -> tuple[list[str], list[str], dict]:
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
    for name, _source, typecode in _toc_entries(parsed):
        if typecode == "PYMODULE":
            modules.add(name)
        elif typecode == "PYSOURCE":
            scripts.add(name)
    if not modules:
        raise InputError("Analysis-00.toc lists no PYMODULE entries")
    source = {"path": tocs[0].relative_to(workpath).as_posix(), "sha256": _sha256_file(tocs[0]),
              "bundle": bundle_name}
    return sorted(modules), sorted(scripts), source


def _qt_observation() -> dict:
    observation = {"source": "build interpreter subprocess: PySide6.QtCore.qVersion() and QLibraryInfo.build()"}
    try:
        done = subprocess.run([sys.executable, "-c", QT_PROBE], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        observation.update({"value": None, "error": type(exc).__name__})
        return observation
    observation["returncode"] = done.returncode
    if done.returncode == 0:
        try:
            observation["value"] = json.loads(done.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            observation.update({"value": None, "error": "unparsable probe output"})
    else:
        observation.update({"value": None, "stderr_tail": done.stderr[-1000:]})
    return observation


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
        modules, scripts, toc = _analysis_modules(args.workpath, bundle.name)
        facts = collect(bundle, modules)
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
        "python": {"version": sys.version.split()[0], "implementation": sys.implementation.name,
                   "platform": sys.platform},
        "pyinstaller": _tool_version("pyinstaller"),
        "qt": _qt_observation(),
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
