# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec file for SilentSuite Bridge
# Produces a single-file executable that bundles all dependencies including
# the etebase native library (Rust-compiled .so/.dylib/.pyd).
#
# Usage:
#   pyinstaller bridge/silentsuite-bridge.spec
#
# Or via the helper:
#   cd bridge && python build.py

import os
import sys
import glob
from pathlib import Path
import importlib.util

from PyInstaller.utils.hooks import copy_metadata


def safe_copy_metadata(package_name):
    """Return copy_metadata result, or empty list if package not installed."""
    try:
        return copy_metadata(package_name)
    except Exception:
        return []

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def find_etebase_binaries():
    """Return (binaries, datas) tuples for the etebase native extension."""
    binaries = []
    datas = []

    spec = importlib.util.find_spec("etebase")
    if spec is None or not spec.submodule_search_locations:
        return binaries, datas

    pkg_dir = Path(spec.submodule_search_locations[0])

    # The native extension can be named etebase.cpython-*.so / .pyd / .dylib
    for pattern in ["*.so", "*.pyd", "*.dylib", "*.dll"]:
        for p in pkg_dir.glob(pattern):
            binaries.append((str(p), "etebase"))

    # Include any .py stubs / __init__ in the package
    for p in pkg_dir.glob("*.py"):
        datas.append((str(p), "etebase"))

    return binaries, datas


def find_radicale_data():
    """Include Radicale's web static files (templates, static assets)."""
    datas = []
    spec = importlib.util.find_spec("radicale")
    if spec is None or not spec.submodule_search_locations:
        return datas

    pkg_dir = Path(spec.submodule_search_locations[0])

    # Radicale ships a small web interface
    for subdir in ["web", "templates", "static"]:
        d = pkg_dir / subdir
        if d.exists():
            datas.append((str(d), f"radicale/{subdir}"))

    return datas


# ---------------------------------------------------------------------------
# Collect
# ---------------------------------------------------------------------------

etebase_binaries, etebase_datas = find_etebase_binaries()
radicale_datas = find_radicale_data()

# Tray/PIL excluded — requires Xlib/display, incompatible with headless CI.
# tray.py handles ImportError gracefully at runtime.

# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

a = Analysis(
    # Entry point — wrapper script that imports the package properly
    ["entrypoint.py"],
    pathex=[
        "src",
    ],
    binaries=etebase_binaries,
    datas=[
        *etebase_datas,
        *radicale_datas,
        *safe_copy_metadata("vobject"),
        *safe_copy_metadata("radicale"),
        *safe_copy_metadata("etebase"),
        *safe_copy_metadata("requests"),
        *safe_copy_metadata("peewee"),
        *safe_copy_metadata("msgpack"),
        *safe_copy_metadata("appdirs"),
        # Radicale transitive deps that call importlib.metadata at runtime
        *safe_copy_metadata("python-dateutil"),
        *safe_copy_metadata("defusedxml"),
        *safe_copy_metadata("passlib"),
        *safe_copy_metadata("pika"),
    ],
    hiddenimports=[
        # etebase — the Rust extension exposes submodules dynamically
        "etebase",
        "etebase._etebase",

        # Radicale core modules
        "radicale",
        "radicale.app",
        "radicale.app.base",
        "radicale.app.delete",
        "radicale.app.get",
        "radicale.app.head",
        "radicale.app.mkcalendar",
        "radicale.app.mkcol",
        "radicale.app.move",
        "radicale.app.options",
        "radicale.app.post",
        "radicale.app.propfind",
        "radicale.app.proppatch",
        "radicale.app.put",
        "radicale.app.report",
        "radicale.auth",
        "radicale.auth.none",
        "radicale.auth.htpasswd",
        "radicale.config",
        "radicale.hook",
        "radicale.hook.none",
        "radicale.httputils",
        "radicale.types",
        "radicale.utils",
        "radicale.item",
        "radicale.item.filter",
        "radicale.log",
        "radicale.pathutils",
        "radicale.rights",
        "radicale.rights.owner_only",
        "radicale.rights.owner_write",
        "radicale.rights.authenticated",
        "radicale.server",
        "radicale.storage",
        "radicale.storage.multifilesystem",
        "radicale.web",
        "radicale.web.internal",
        "radicale.xmlutils",

        # SilentSuite Bridge — Radicale plugins (referenced by string in config)
        "silentsuite_bridge.radicale",
        "silentsuite_bridge.radicale.auth",
        "silentsuite_bridge.radicale.storage",
        "silentsuite_bridge.radicale.creds",
        "silentsuite_bridge.radicale.etesync_cache",
        "silentsuite_bridge.web",
        "silentsuite_bridge.web.__init__",

        # Bridge modules
        "silentsuite_bridge",
        "silentsuite_bridge.__main__",
        "silentsuite_bridge.auth_browser",
        "silentsuite_bridge.auth_cli",
        "silentsuite_bridge.autostart",
        "silentsuite_bridge.config",
        "silentsuite_bridge.tray",
        "silentsuite_bridge.local_cache",
        "silentsuite_bridge.local_cache.db",
        "silentsuite_bridge.local_cache.models",

        # Dependencies
        "vobject",
        "vobject.icalendar",
        "vobject.vcard",
        "vobject.recurrence",
        "vobject.base",
        "vobject.behavior",
        "msgpack",
        "msgpack._cmsgpack",
        "peewee",
        "playhouse",
        "playhouse.sqlite_ext",
        "appdirs",
        "requests",
        "requests.adapters",
        "requests.auth",
        "requests.packages",
        "urllib3",
        "certifi",
        "charset_normalizer",
        "idna",

        # jaraco namespace packages — required by pkg_resources at runtime
        "jaraco",
        "jaraco.text",
        "jaraco.functools",
        "jaraco.context",

        # pkg_resources / importlib
        "pkg_resources",
        "importlib_resources",

        # stdlib modules that sometimes get missed
        "xml.etree.ElementTree",
        "email.mime.text",
        "email.mime.multipart",
        "http.server",
        "http.client",
        "wsgiref.simple_server",
        "wsgiref.handlers",
        "wsgiref.util",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Unnecessary large packages
        "tkinter",
        "matplotlib",
        "numpy",
        "scipy",
        "pandas",
        "IPython",
        "jupyter",
        "notebook",
        "pytest",
        "pip",
        # Headless-incompatible — tray.py handles ImportError at runtime
        "pystray",
        "PIL",
    ],
    noarchive=False,
    optimize=1,
)

# ---------------------------------------------------------------------------
# PYZ archive
# ---------------------------------------------------------------------------

pyz = PYZ(a.pure)

# ---------------------------------------------------------------------------
# EXE — single-file executable
# ---------------------------------------------------------------------------

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="silentsuite-bridge",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,      # CLI daemon — keep console
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,  # Use host arch; override with --target-arch on cross-compile
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
