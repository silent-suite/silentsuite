# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the SilentSuite Bridge desktop app (#171).
#
# A windowed onedir build (a .app on macOS) of entrypoint_desktop.py, with
# PySide6/Qt WebEngine collected by PyInstaller's own PySide6 hooks: the
# QtWebEngineProcess helper, its resources and locales. No Chromium flag or
# sandbox setting is added here.
#
# Separate from silentsuite-bridge.spec (the one-file CLI), which is unchanged.
# Unlike that spec this one never writes into the source tree: it does not
# stamp _version.py (the package falls back to its built-in version string),
# and it does not sign, notarize or install anything.
#
# Usage (from bridge/):
#   python -m PyInstaller silentsuite-bridge-desktop.spec --noconfirm --clean \
#       --distpath <dist> --workpath <work>
#
# Output in <dist>:
#   Linux:   silentsuite-bridge-desktop/silentsuite-bridge-desktop (+ _internal/)
#   Windows: SilentSuite Bridge/SilentSuite Bridge.exe (+ _internal/)
#   macOS:   SilentSuite Bridge.app (Contents/MacOS/SilentSuite Bridge)

import importlib.util
import sys
from pathlib import Path

from PyInstaller.utils.hooks import copy_metadata

# Install names the desktop start-at-login and installer paths expect.
if sys.platform.startswith("linux"):
    APP_NAME = "silentsuite-bridge-desktop"
else:
    APP_NAME = "SilentSuite Bridge"
BUNDLE_IDENTIFIER = "io.silentsuite.bridge.desktop"  # desktop_autostart.DESKTOP_LAUNCHD_LABEL

SPEC_DIR = Path(SPECPATH)  # noqa: F821 (provided by PyInstaller)


def safe_copy_metadata(package_name):
    """Return copy_metadata result, or empty list if package not installed."""
    try:
        return copy_metadata(package_name)
    except Exception:
        return []


# Same etebase and Radicale collection as silentsuite-bridge.spec.
def find_etebase_binaries():
    """Return (binaries, datas) tuples for the etebase native extension."""
    binaries = []
    datas = []
    spec = importlib.util.find_spec("etebase")
    if spec is None or not spec.submodule_search_locations:
        return binaries, datas
    pkg_dir = Path(spec.submodule_search_locations[0])
    for pattern in ["*.so", "*.pyd", "*.dylib", "*.dll"]:
        for p in pkg_dir.glob(pattern):
            binaries.append((str(p), "etebase"))
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
    for subdir in ["web", "templates", "static"]:
        d = pkg_dir / subdir
        if d.exists():
            datas.append((str(d), f"radicale/{subdir}"))
    return datas


etebase_binaries, etebase_datas = find_etebase_binaries()
radicale_datas = find_radicale_data()

a = Analysis(  # noqa: F821
    [str(SPEC_DIR / "entrypoint_desktop.py")],
    pathex=[str(SPEC_DIR / "src")],
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

        # Radicale core modules (plugins are referenced by string in config)
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
        "silentsuite_bridge.radicale.application",
        "silentsuite_bridge.radicale.auth",
        "silentsuite_bridge.radicale.storage",
        "silentsuite_bridge.radicale.rights",
        "silentsuite_bridge.radicale.creds",
        "silentsuite_bridge.radicale.etesync_cache",
        "silentsuite_bridge.radicale.server",
        "silentsuite_bridge.web",

        # Bridge modules, including the lazily imported desktop modules
        "silentsuite_bridge",
        "silentsuite_bridge.__main__",
        "silentsuite_bridge.accounts",
        "silentsuite_bridge.auth_browser",
        "silentsuite_bridge.auth_cli",
        "silentsuite_bridge.autostart",
        "silentsuite_bridge.config",
        "silentsuite_bridge.desktop",
        "silentsuite_bridge.desktop_autostart",
        "silentsuite_bridge.desktop_ipc",
        "silentsuite_bridge.instance",
        "silentsuite_bridge.local_cache",
        "silentsuite_bridge.local_cache.db",
        "silentsuite_bridge.local_cache.models",
        "silentsuite_bridge.operator_output",
        "silentsuite_bridge.privacy_logging",

        # Qt modules the desktop imports inside functions
        "PySide6.QtCore",
        "PySide6.QtGui",
        "PySide6.QtNetwork",
        "PySide6.QtWidgets",
        "PySide6.QtWebEngineCore",
        "PySide6.QtWebEngineWidgets",

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
        # The desktop app has no tray; tray.py handles ImportError at runtime
        "pystray",
        "PIL",
        # One Qt binding only: PyInstaller refuses to collect several
        "PyQt5",
        "PyQt6",
        "PySide2",
    ],
    noarchive=False,
    optimize=1,
)

pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # onedir: binaries and data go into COLLECT
    name=APP_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # never compress Qt/Chromium binaries
    console=False,  # windowed; the desktop flavor logs to its data directory
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name=APP_NAME,
)

if sys.platform == "darwin":
    app = BUNDLE(  # noqa: F821
        coll,
        name=f"{APP_NAME}.app",
        icon=None,
        bundle_identifier=BUNDLE_IDENTIFIER,
        info_plist={
            "NSHighResolutionCapable": True,
        },
    )
