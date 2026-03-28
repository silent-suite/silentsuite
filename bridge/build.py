#!/usr/bin/env python3
"""
SilentSuite Bridge — Local build helper.

Runs PyInstaller with the correct arguments for the current platform.

Usage:
    cd bridge/
    python build.py [--clean] [--debug] [--no-upx]

The resulting binary will be at:
    dist/silentsuite-bridge          (Linux / macOS)
    dist/silentsuite-bridge.exe      (Windows)

It will be renamed to the release asset name, e.g.:
    dist/silentsuite-bridge-linux-x86_64
"""

import argparse
import hashlib
import platform
import shutil
import subprocess
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

def get_os_label() -> str:
    s = platform.system().lower()
    if s == "linux":
        return "linux"
    elif s == "darwin":
        return "macos"
    elif s == "windows":
        return "windows"
    else:
        raise RuntimeError(f"Unsupported OS: {s}")


def get_arch_label() -> str:
    m = platform.machine().lower()
    if m in ("x86_64", "amd64"):
        return "x86_64"
    elif m in ("aarch64", "arm64"):
        return "arm64"
    else:
        raise RuntimeError(f"Unsupported arch: {m}")


def get_asset_name() -> str:
    os_label = get_os_label()
    arch_label = get_arch_label()
    suffix = ".exe" if os_label == "windows" else ""
    return f"silentsuite-bridge-{os_label}-{arch_label}{suffix}"


def get_exe_suffix() -> str:
    return ".exe" if platform.system().lower() == "windows" else ""


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def run_pyinstaller(clean: bool, debug: bool, no_upx: bool) -> None:
    script_dir = Path(__file__).parent.resolve()
    spec_file = script_dir / "silentsuite-bridge.spec"

    if not spec_file.exists():
        print(f"[error] Spec file not found: {spec_file}", file=sys.stderr)
        sys.exit(1)

    cmd = [
        sys.executable, "-m", "PyInstaller",
        str(spec_file),
        "--distpath", str(script_dir / "dist"),
        "--workpath", str(script_dir / "build"),
        "--noconfirm",
    ]

    if clean:
        cmd.append("--clean")
    if debug:
        cmd.extend(["--log-level", "DEBUG"])
    if no_upx:
        cmd.append("--noupx")

    print(f"[build] Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=str(script_dir))
    if result.returncode != 0:
        print("[error] PyInstaller failed.", file=sys.stderr)
        sys.exit(result.returncode)


def rename_binary(dist_dir: Path) -> Path:
    suffix = get_exe_suffix()
    src = dist_dir / f"silentsuite-bridge{suffix}"
    asset_name = get_asset_name()
    dst = dist_dir / asset_name

    if not src.exists():
        print(f"[error] Expected binary not found: {src}", file=sys.stderr)
        sys.exit(1)

    shutil.move(str(src), str(dst))
    print(f"[build] Renamed: {src.name} → {dst.name}")
    return dst


def compute_sha256(binary: Path) -> None:
    sha = hashlib.sha256()
    with binary.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            sha.update(chunk)
    digest = sha.hexdigest()
    checksum_file = binary.with_suffix(binary.suffix + ".sha256")
    checksum_file.write_text(f"{digest}  {binary.name}\n")
    print(f"[build] SHA256: {digest}")
    print(f"[build] Written: {checksum_file.name}")


def smoke_test(binary: Path) -> None:
    print(f"[build] Smoke test: {binary} --version")
    result = subprocess.run([str(binary), "--version"], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[error] Smoke test failed!\nstdout: {result.stdout}\nstderr: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    print(f"[build] {result.stdout.strip()}")
    print("[build] Smoke test passed ✓")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Build SilentSuite Bridge binary")
    parser.add_argument("--clean", action="store_true", help="Pass --clean to PyInstaller")
    parser.add_argument("--debug", action="store_true", help="Enable PyInstaller DEBUG logging")
    parser.add_argument("--no-upx", action="store_true", help="Disable UPX compression")
    parser.add_argument("--no-rename", action="store_true", help="Skip renaming to release asset name")
    parser.add_argument("--no-smoke", action="store_true", help="Skip smoke test")
    args = parser.parse_args()

    os_label = get_os_label()
    arch_label = get_arch_label()
    asset_name = get_asset_name()

    print(f"[build] Platform: {os_label}/{arch_label}")
    print(f"[build] Asset name: {asset_name}")
    print()

    dist_dir = Path(__file__).parent / "dist"

    # Build
    run_pyinstaller(clean=args.clean, debug=args.debug, no_upx=args.no_upx)

    # Rename
    if not args.no_rename:
        binary = rename_binary(dist_dir)
    else:
        suffix = get_exe_suffix()
        binary = dist_dir / f"silentsuite-bridge{suffix}"

    # Smoke test
    if not args.no_smoke:
        smoke_test(binary)

    # Checksum
    compute_sha256(binary)

    print()
    print(f"[build] Done! Binary at: {binary}")


if __name__ == "__main__":
    main()
