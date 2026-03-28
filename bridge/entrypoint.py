"""PyInstaller entry point for SilentSuite Bridge.

This wrapper avoids 'attempted relative import' errors by importing
the package from the top level rather than running __main__.py directly.
"""
from silentsuite_bridge.__main__ import main

if __name__ == "__main__":
    main()
