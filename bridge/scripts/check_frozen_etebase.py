"""Check that a frozen Bridge binary carries the etebase native module this build tested.

Usage: python scripts/check_frozen_etebase.py <frozen-binary>

Run in the release build environment after PyInstaller. It reads the binary's
PyInstaller archive and asserts that the bundled etebase extension is byte-for-byte
the one installed here (which the SDK continuity lanes exercise), and on Windows that
python3.dll, which abi3 extensions link against, is bundled too. Loading the module
inside the binary is checked separately by running it with --list-accounts.
"""

import hashlib
import sys
from pathlib import Path

import etebase.etebase_python as native
from PyInstaller.archive.readers import CArchiveReader


def main(binary: str) -> None:
    archive = CArchiveReader(binary)
    bundled = [name for name in archive.toc if Path(name).name.startswith("etebase_python.")]
    if len(bundled) != 1:
        sys.exit(f"ERROR: expected one bundled etebase extension, found {bundled}")
    installed = Path(native.__file__)
    frozen_sha = hashlib.sha256(archive.extract(bundled[0])).hexdigest()
    installed_sha = hashlib.sha256(installed.read_bytes()).hexdigest()
    print(f"bundled {bundled[0]} sha256 {frozen_sha}")
    print(f"installed {installed} sha256 {installed_sha}")
    if frozen_sha != installed_sha:
        sys.exit("ERROR: the bundled etebase extension is not the installed one")
    if sys.platform == "win32" and not any(Path(name).name.lower() == "python3.dll" for name in archive.toc):
        sys.exit("ERROR: python3.dll (needed by the abi3 etebase extension) is not bundled")
    print("frozen etebase extension check passed")


if __name__ == "__main__":
    main(sys.argv[1])
