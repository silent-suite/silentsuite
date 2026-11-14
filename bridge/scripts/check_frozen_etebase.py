"""Check that a frozen Bridge binary carries the etebase native module this build tested.

Usage: python scripts/check_frozen_etebase.py <frozen-binary>

Run in the release build environment after PyInstaller. It reads the binary's
PyInstaller archive and asserts that the bundled etebase extension is the one
installed here (which the SDK continuity lanes exercise), and on Windows that
python3.dll, which abi3 extensions link against, is bundled too. Loading the module
inside the binary is checked separately by running it with --list-accounts.

On Linux and Windows PyInstaller bundles the file unchanged, so the whole file must
match. On macOS it rewrites load paths and re-signs the copy it bundles, so there the
machine code (the __TEXT,__text section) must match instead.
"""

import hashlib
import struct
import sys
from pathlib import Path

import etebase.etebase_python as native
from PyInstaller.archive.readers import CArchiveReader


def macho_text(data: bytes) -> bytes:
    """The __TEXT,__text section of a thin 64-bit Mach-O."""
    magic, _, _, _, ncmds = struct.unpack_from("<IiiII", data, 0)
    if magic != 0xFEEDFACF:
        sys.exit(f"ERROR: not a thin 64-bit Mach-O (magic {magic:#x})")
    offset = 32
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", data, offset)
        if cmd == 0x19:  # LC_SEGMENT_64
            nsects = struct.unpack_from("<I", data, offset + 64)[0]
            for index in range(nsects):
                section = offset + 72 + index * 80
                name, segment = data[section : section + 16], data[section + 16 : section + 32]
                if name.rstrip(b"\0") == b"__text" and segment.rstrip(b"\0") == b"__TEXT":
                    length = struct.unpack_from("<Q", data, section + 40)[0]
                    start = struct.unpack_from("<I", data, section + 48)[0]
                    return data[start : start + length]
        offset += size
    sys.exit("ERROR: no __TEXT,__text section")


def fingerprint(data: bytes) -> str:
    return hashlib.sha256(macho_text(data) if sys.platform == "darwin" else data).hexdigest()


def main(binary: str) -> None:
    archive = CArchiveReader(binary)
    bundled = [name for name in archive.toc if Path(name).name.startswith("etebase_python.")]
    if len(bundled) != 1:
        sys.exit(f"ERROR: expected one bundled etebase extension, found {bundled}")
    installed = Path(native.__file__)
    what = "__TEXT,__text sha256" if sys.platform == "darwin" else "sha256"
    frozen_sha = fingerprint(archive.extract(bundled[0]))
    installed_sha = fingerprint(installed.read_bytes())
    print(f"bundled {bundled[0]} {what} {frozen_sha}")
    print(f"installed {installed} {what} {installed_sha}")
    if frozen_sha != installed_sha:
        sys.exit("ERROR: the bundled etebase extension is not the installed one")
    if sys.platform == "win32" and not any(Path(name).name.lower() == "python3.dll" for name in archive.toc):
        sys.exit("ERROR: python3.dll (needed by the abi3 etebase extension) is not bundled")
    print("frozen etebase extension check passed")


if __name__ == "__main__":
    main(sys.argv[1])
