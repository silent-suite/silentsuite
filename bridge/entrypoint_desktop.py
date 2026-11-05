"""PyInstaller entry point for the SilentSuite Bridge desktop app (#171).

Like entrypoint.py, this imports the package from the top level to avoid
relative-import errors. It runs the desktop flavor: with no arguments the
native window opens. main() reads ``--background`` and the other flags from
sys.argv, and refuses --check-update/--self-update in this flavor.
"""
from silentsuite_bridge.__main__ import main

if __name__ == "__main__":
    main(flavor="desktop")
