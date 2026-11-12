"""Q7 relinking control for the SilentSuite Bridge desktop dev build (#171).

Shows, per platform, that a user can rebuild one Qt library L from the held Qt
6.12.0 source with a real source change and run the frozen app with it in
place of the bundled copy. Used by .github/workflows/test-bridge-desktop-relink.yml;
nothing here uploads, signs or publishes anything, and the modified L never
leaves the job.

L is the platform integration the frozen startup path loads under the existing
checks: libQt6XcbQpa.so.6 on linux-x86_64 (xcb under Xvfb), qwindows.dll on
windows-x86_64. The source change is a load-time constructor that, when
SILENTSUITE_RELINK_WITNESS names a file, appends "<platform> <nonce>" to it; the
nonce is generated per run and compiled into L.

Subcommands (each exits 0 on success, 1 on a failed check, 2 on unusable input):
  extract   verify the held source archive's SHA256 and extract only qtbase/
  copy      tar.gz round trip of the build output into a new directory
  patch     append the witness constructor to L's source file
  configdiff compare the build's generated Qt config headers with the publisher SDK's
  swap      replace L in a copied bundle; record original, modified and wheel hashes
  witness   launch the bundle with the witness file set; record the witness lines and
            the OS loaded-module record for L (Linux /proc/<pid>/maps, Windows the
            process module list), then terminate the launched process
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

WITNESS_ENV = "SILENTSUITE_RELINK_WITNESS"
SOURCE_ROOT = "qt-everywhere-src-6.12.0"
LIBRARIES = {
    # platform: (bundle path of L, qtbase source file that receives the constructor, build target)
    "linux-x86_64": ("_internal/PySide6/Qt/lib/libQt6XcbQpa.so.6",
                     "src/plugins/platforms/xcb/qxcbintegration.cpp", "XcbQpaPrivate"),
    "windows-x86_64": ("_internal/PySide6/plugins/platforms/qwindows.dll",
                       "src/plugins/platforms/windows/qwindowsintegration.cpp", "QWindowsIntegrationPlugin"),
}
CONFIG_HEADERS = ("QtCore/qtcore-config.h", "QtCore/6.12.0/QtCore/private/qtcore-config_p.h",
                  "QtGui/qtgui-config.h", "QtGui/6.12.0/QtGui/private/qtgui-config_p.h")
NONCE = re.compile(r"^[0-9a-f]{32}$")
STARTUP_SECONDS = 120
LOAD_SECONDS = 60
STOP_SECONDS = 30


class InputError(Exception):
    pass


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _write(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _platform(value: str) -> tuple[str, str, str]:
    if value not in LIBRARIES:
        raise InputError(f"unknown platform {value!r}")
    return LIBRARIES[value]


# --- safe tar extraction ---------------------------------------------------------


def _inside(dest: Path, name: str) -> bool:
    target = os.path.realpath(os.path.join(dest, name))
    base = os.path.realpath(dest)
    return target == base or target.startswith(base + os.sep)


def _extract_member(tar: tarfile.TarFile, member: tarfile.TarInfo, dest: Path) -> None:
    """The tarfile 'data' filter where this Python has it; else the same checks done here
    (Windows runners ship CPython 3.10.11, which predates the filter backport)."""
    if hasattr(tarfile, "data_filter"):
        tar.extract(member, dest, filter="data")
        return
    name = member.name
    if os.path.isabs(name) or name.startswith(("/", "\\")) or ".." in Path(name).parts or ":" in name:
        raise InputError(f"unsafe member path {name!r}")
    if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
        raise InputError(f"special member {name!r}")
    if not _inside(dest, name):
        raise InputError(f"member {name!r} leaves the destination")
    if member.issym() and (os.path.isabs(member.linkname)
                           or not _inside(dest, os.path.join(os.path.dirname(name), member.linkname))):
        raise InputError(f"link {name!r} points outside the destination")
    if member.islnk() and not _inside(dest, member.linkname):
        raise InputError(f"hard link {name!r} points outside the destination")
    member.mode = (member.mode or 0o644) & 0o755
    tar.extract(member, dest, set_attrs=not member.issym())


# --- extract -----------------------------------------------------------------


def extract(archive: Path, expected: str, dest: Path) -> dict:
    actual = _sha(archive)
    if actual != expected:
        raise InputError(f"source archive SHA256 {actual} is not the held {expected}")
    prefix = f"{SOURCE_ROOT}/qtbase/"
    count, refused = 0, []
    filter_errors = (tarfile.FilterError, InputError) if hasattr(tarfile, "FilterError") else (InputError,)
    with tarfile.open(archive, "r:xz") as tar:
        for member in tar:
            if not member.name.startswith(prefix):
                continue
            try:
                _extract_member(tar, member, dest)
                count += 1
            except filter_errors as exc:  # recorded; a needed member makes the build fail
                refused.append({"member": member.name, "reason": str(exc)[:200]})
    if count == 0:
        raise InputError(f"no {prefix} members in the archive")
    return {"archive": archive.name, "sha256": actual, "bytes": archive.stat().st_size, "members": count,
            "extracted": prefix, "refused_by_data_filter": refused}


# --- copy --------------------------------------------------------------------


def copy(source: Path, dest: Path) -> dict:
    """A tar.gz round trip of ``source`` into ``dest`` (links kept, data filter on extraction)."""
    if not source.is_dir() or dest.exists():
        raise InputError("copy needs an existing source directory and a new destination")
    archive = dest.parent / (dest.name + ".tgz")
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(source, arcname=source.name)
    dest.mkdir(parents=True)
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            _extract_member(tar, member, dest)
    record = {"archive_sha256": _sha(archive), "archive_bytes": archive.stat().st_size, "copy": source.name}
    archive.unlink()
    record["ok"] = (dest / source.name).is_dir()
    return record


# --- patch -------------------------------------------------------------------


def witness_source(platform: str, nonce: str) -> str:
    return f"""
// SilentSuite Bridge #171 Q7 relinking control: a substantive source change.
// When {WITNESS_ENV} names a file, append one line with the platform and the
// per-run nonce compiled into this build when the library is loaded.
#include <cstdio>
#include <cstdlib>
namespace {{
struct SilentSuiteRelinkWitness
{{
    SilentSuiteRelinkWitness()
    {{
        const char *path = std::getenv("{WITNESS_ENV}");
        if (!path || !*path)
            return;
        if (std::FILE *file = std::fopen(path, "a")) {{
            std::fputs("{platform} {nonce}\\n", file);
            std::fclose(file);
        }}
    }}
}};
const SilentSuiteRelinkWitness silentSuiteRelinkWitness;
}} // namespace
"""


def patch(qtbase: Path, platform: str, nonce: str) -> dict:
    if not NONCE.match(nonce):
        raise InputError("the nonce must be 32 lowercase hex characters")
    _, source, target = _platform(platform)
    path = qtbase / source
    if not path.is_file():
        raise InputError(f"{source} is not in the extracted qtbase")
    before = _sha(path)
    text = witness_source(platform, nonce)
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    return {"file": f"qtbase/{source}", "sha256_before": before, "sha256_after": _sha(path),
            "appended": text, "build_target": target}


# --- configdiff --------------------------------------------------------------


def configdiff(sdk_include: Path, build_include: Path) -> dict:
    rows = []
    for header in CONFIG_HEADERS:
        sdk, ours = sdk_include / header, build_include / header
        if not sdk.is_file() or not ours.is_file():
            rows.append({"header": header, "sdk_present": sdk.is_file(), "build_present": ours.is_file()})
            continue
        left = set(sdk.read_text(encoding="utf-8").splitlines())
        right = set(ours.read_text(encoding="utf-8").splitlines())
        rows.append({"header": header, "identical": left == right, "sdk_sha256": _sha(sdk),
                     "build_sha256": _sha(ours), "only_sdk": sorted(left - right), "only_build": sorted(right - left)})
    return {"headers": rows, "all_identical": all(r.get("identical") for r in rows)}


# --- swap --------------------------------------------------------------------


def swap(bundle: Path, platform: str, modified: Path, wheel_member: Path) -> dict:
    relative, _, _ = _platform(platform)
    target = bundle / relative
    if not target.is_file() or target.is_symlink():
        raise InputError(f"{relative} is not a regular file in the bundle")
    if not modified.is_file() or not wheel_member.is_file():
        raise InputError("the modified library or the wheel member is missing")
    record = {"library": relative, "original_sha256": _sha(target), "modified_sha256": _sha(modified),
              "wheel_member_sha256": _sha(wheel_member), "modified_bytes": modified.stat().st_size}
    links = [p.relative_to(bundle).as_posix() for p in (bundle / "_internal").glob("*")
             if p.is_symlink() and p.resolve() == target.resolve()]
    record["bundle_links_to_library"] = sorted(links)
    if record["modified_sha256"] in (record["original_sha256"], record["wheel_member_sha256"]):
        record["ok"] = False
        record["error"] = "the modified library equals the original or the publisher's wheel member"
        return record
    mode = target.stat().st_mode
    shutil.copyfile(modified, target)
    os.chmod(target, mode)
    record["swapped_sha256"] = _sha(target)
    record["ok"] = record["swapped_sha256"] == record["modified_sha256"]
    return record


# --- witness -----------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _dashboard(port: int) -> int | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/.web", timeout=5) as response:
            return response.status
    except Exception:  # noqa: BLE001 - not up yet, any error is "not ready"
        return None


def _linux_modules(pid: int) -> list[str]:
    paths = set()
    with open(f"/proc/{pid}/maps", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            parts = line.split(None, 5)
            if len(parts) == 6 and parts[5].startswith("/"):
                paths.add(parts[5].strip())
    return sorted(paths)


def _windows_modules(pid: int) -> list[str]:
    import ctypes
    from ctypes import wintypes

    psapi, kernel32 = ctypes.WinDLL("psapi", use_last_error=True), ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    handle = kernel32.OpenProcess(0x0400 | 0x0010, False, pid)  # QUERY_INFORMATION | VM_READ
    if not handle:
        raise OSError(ctypes.get_last_error(), "OpenProcess failed")
    try:
        needed = wintypes.DWORD()
        modules = (wintypes.HMODULE * 4096)()
        if not psapi.EnumProcessModulesEx(handle, modules, ctypes.sizeof(modules), ctypes.byref(needed), 0x03):
            raise OSError(ctypes.get_last_error(), "EnumProcessModulesEx failed")
        count = min(needed.value // ctypes.sizeof(wintypes.HMODULE), len(modules))
        paths = []
        buffer = ctypes.create_unicode_buffer(32768)
        for index in range(count):
            if psapi.GetModuleFileNameExW(handle, modules[index], buffer, len(buffer)):
                paths.append(buffer.value)
        return sorted(set(paths))
    finally:
        kernel32.CloseHandle(handle)


def _descendants(pid: int) -> list[int]:
    """pid and every live descendant (a bootloader or helper may run code in a child)."""
    parents = {}
    if sys.platform == "win32":
        done = subprocess.run(["powershell", "-NoProfile", "-Command",
                               "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
                              capture_output=True, text=True, timeout=60)
        for line in done.stdout.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                parents[int(parts[0])] = int(parts[1])
    else:
        for stat in Path("/proc").glob("[0-9]*/stat"):
            try:
                fields = stat.read_text(encoding="utf-8", errors="replace").rsplit(")", 1)[1].split()
                parents[int(stat.parent.name)] = int(fields[1])
            except (OSError, IndexError, ValueError):
                continue
    found, frontier = [pid], [pid]
    while frontier:
        current = frontier.pop()
        children = [child for child, parent in parents.items() if parent == current and child not in found]
        found += children
        frontier += children
    return found


def _modules(pid: int) -> dict[int, list[str]]:
    result = {}
    for process in _descendants(pid):
        try:
            result[process] = _windows_modules(process) if sys.platform == "win32" else _linux_modules(process)
        except OSError:
            continue  # exited meanwhile or not readable
    return result


def _same(left: str, right: Path) -> bool:
    try:
        return os.path.normcase(os.path.realpath(left)) == os.path.normcase(os.path.realpath(str(right)))
    except OSError:
        return False


def witness(bundle: Path, platform: str, root: Path, expect_sha: str, nonce: str | None) -> dict:
    """nonce None: the negative control (unmodified bundle, no witness line expected)."""
    relative, _, _ = _platform(platform)
    library = bundle / relative
    exe = bundle / (bundle.name + (".exe" if sys.platform == "win32" else ""))
    if not exe.is_file() or not library.is_file():
        raise InputError("the bundle executable or L is missing")
    root.mkdir(parents=True, exist_ok=True)
    witness_file = root / "witness.txt"
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith("SILENTSUITE_")}
    for name in ("home", "tmp", "xdg-config", "xdg-data", "xdg-cache"):
        (root / name).mkdir(exist_ok=True)
    if sys.platform == "win32":
        env.update({"TMP": str(root / "tmp"), "TEMP": str(root / "tmp")})
    else:
        env.update({"HOME": str(root / "home"), "TMPDIR": str(root / "tmp"), "XDG_CONFIG_HOME": str(root / "xdg-config"),
                    "XDG_DATA_HOME": str(root / "xdg-data"), "XDG_CACHE_HOME": str(root / "xdg-cache")})
    env.update({"SILENTSUITE_DATA_DIR": str(root / "data"), "SILENTSUITE_LISTEN_ADDRESS": "127.0.0.1",
                "SILENTSUITE_LISTEN_PORT": str(port), WITNESS_ENV: str(witness_file)})
    record = {"mode": "negative-control" if nonce is None else "modified", "library": relative,
              "expected_sha256": expect_sha, "library_sha256_on_disk": _sha(library)}
    logs = [open(root / "app.stdout", "w", encoding="utf-8"), open(root / "app.stderr", "w", encoding="utf-8")]
    app = subprocess.Popen([str(exe)], cwd=str(root), env=env, stdout=logs[0], stderr=logs[1])
    try:
        deadline = time.monotonic() + STARTUP_SECONDS
        status = None
        while time.monotonic() < deadline and app.poll() is None and status != 200:
            status = _dashboard(port)
            if status != 200:
                time.sleep(0.5)
        record["dashboard_status"] = status
        loaded, processes = [], {}
        deadline = time.monotonic() + LOAD_SECONDS
        while app.poll() is None and time.monotonic() < deadline:
            processes = _modules(app.pid)
            loaded = sorted({p for paths in processes.values() for p in paths if _same(p, library)})
            if loaded:
                break
            time.sleep(1)
        record["exited_early"] = app.poll()
        record["processes_scanned"] = len(processes)
        record["processes_loading_library"] = sum(1 for paths in processes.values()
                                                  if any(_same(p, library) for p in paths))
        record["launched_process_loads_library"] = any(_same(p, library) for p in processes.get(app.pid, []))
        record["loaded_module_paths"] = sorted({Path(os.path.realpath(p)).relative_to(bundle.resolve()).as_posix()
                                                for p in loaded})
        record["loaded_sha256"] = sorted({_sha(Path(p)) for p in loaded})
        record["module_record"] = "/proc/<pid>/maps" if sys.platform != "win32" else "EnumProcessModulesEx"
        time.sleep(2)  # a constructor that ran has long since written its line
    finally:
        if app.poll() is None:
            app.terminate()
            try:
                app.wait(timeout=STOP_SECONDS)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait(timeout=STOP_SECONDS)
        for handle in logs:
            handle.close()
    lines = witness_file.read_text(encoding="utf-8").splitlines() if witness_file.is_file() else []
    record["witness_lines"] = lines
    record["stderr_tail"] = (root / "app.stderr").read_text(encoding="utf-8", errors="replace")[-2000:]
    checks = {
        "dashboard_served": record["dashboard_status"] == 200 and record["exited_early"] is None,
        "library_loaded_at_bundle_path": bool(loaded),
        "loaded_sha256_expected": bool(loaded) and set(record["loaded_sha256"]) == {expect_sha}
        and record["library_sha256_on_disk"] == expect_sha,
    }
    if nonce is None:
        checks["no_witness_line"] = lines == []
    else:  # every loading process (the app, possibly a helper) writes the same line
        checks["witness_line_for_this_run"] = bool(lines) and set(lines) == {f"{platform} {nonce}"}
    record["checks"] = checks
    record["ok"] = all(checks.values())
    return record


# --- CLI ---------------------------------------------------------------------


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("extract")
    p.add_argument("--archive", required=True, type=Path)
    p.add_argument("--sha256", required=True)
    p.add_argument("--dest", required=True, type=Path)
    p.add_argument("--receipt", required=True, type=Path)
    p = sub.add_parser("copy")
    p.add_argument("--source", required=True, type=Path)
    p.add_argument("--dest", required=True, type=Path)
    p.add_argument("--receipt", required=True, type=Path)
    p = sub.add_parser("patch")
    p.add_argument("--qtbase", required=True, type=Path)
    p.add_argument("--platform", required=True)
    p.add_argument("--nonce", required=True)
    p.add_argument("--receipt", required=True, type=Path)
    p = sub.add_parser("configdiff")
    p.add_argument("--sdk-include", required=True, type=Path)
    p.add_argument("--build-include", required=True, type=Path)
    p.add_argument("--receipt", required=True, type=Path)
    p = sub.add_parser("swap")
    p.add_argument("--bundle", required=True, type=Path)
    p.add_argument("--platform", required=True)
    p.add_argument("--modified", required=True, type=Path)
    p.add_argument("--wheel-member", required=True, type=Path)
    p.add_argument("--receipt", required=True, type=Path)
    p = sub.add_parser("witness")
    p.add_argument("--bundle", required=True, type=Path)
    p.add_argument("--platform", required=True)
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--expect-sha256", required=True)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--nonce")
    group.add_argument("--negative-control", action="store_true")
    p.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "extract":
            record = extract(args.archive, args.sha256, args.dest)
            record["ok"] = True
        elif args.command == "copy":
            record = copy(args.source, args.dest)
        elif args.command == "patch":
            record = patch(args.qtbase, args.platform, args.nonce)
            record["ok"] = True
        elif args.command == "configdiff":
            record = configdiff(args.sdk_include, args.build_include)
            record["ok"] = True  # evidence only; the startup and witness checks judge compatibility
        elif args.command == "swap":
            record = swap(args.bundle, args.platform, args.modified, args.wheel_member)
        else:
            record = witness(args.bundle, args.platform, args.root, args.expect_sha256,
                             None if args.negative_control else args.nonce)
    except (InputError, OSError, tarfile.TarError) as exc:
        print(f"relink_control {args.command}: {exc}", file=sys.stderr)
        return 2
    _write(args.receipt, record)
    print(json.dumps({k: v for k, v in record.items() if k not in ("appended", "stderr_tail")}, sort_keys=True)[:4000])
    return 0 if record.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
