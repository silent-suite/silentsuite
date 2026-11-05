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
import re
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
        # Qt Charts / Data Visualization / Graphs are unused and not shipped
        # (s2-delivery-plan-v9 section 3; tests/test_desktop_frozen.py).
        "PySide6.QtCharts",
        "PySide6.QtDataVisualization",
        "PySide6.QtGraphs",
        "PySide6.QtGraphsWidgets",
        # Qt Quick 3D is GPL-only and not shipped (P2); the only PySide6 binding
        # among the P2 families. Qt 3D (PySide6.Qt3D*) is a different module.
        "PySide6.QtQuick3D",
    ],
    noarchive=False,
    optimize=1,
)

# The PySide6 QML helper collects those families' libraries, QML plugins and
# QML data separately from the bindings, so drop every binary or data entry
# whose destination has a path segment naming one of them. The lookahead keeps
# unrelated names such as QtGraphicalEffects. The P2 rules below extend the
# same filter.
EXCLUDED_QT_FAMILY = re.compile(r"^(lib)?Qt6?(Charts|DataVisualization|Graphs)(?![a-z])")

# P2: the GPL-only Qt Quick 3D (every Quick3D* module, Physics included, plus
# Quick3DSpatialAudio, which links Quick3DPrivate), Qt Quick Timeline, Qt Virtual
# Keyboard and Qt Wayland Compositor families. Their libraries, frameworks and
# qml/QtQuick3D tree carry the family name in a path segment. Qt 3D (Qt63D*,
# qml/Qt3D), QuickTest, Qt SpatialAudio and the rest of Qt Quick do not match.
P2_QT_FAMILY = re.compile(r"^(lib)?Qt6?(Quick3D|QuickTimeline|VirtualKeyboard|WaylandCompositor)(?![a-z])")
# QML module directories whose names are not library names. The compositor's
# QtShell and TextureSharingExtension modules live under QtWayland/Compositor and
# link the compositor; Wayland client content (qml/QtWayland/Client/...,
# platforms/qwayland, the client shell, decoration and graphics plugins) stays.
P2_QML_DIRS = {("QtQuick", "Timeline"), ("QtQuick", "VirtualKeyboard"), ("QtWayland", "Compositor")}
# The two family plugins installed outside those directories
# (platforminputcontexts/ and qmltooling/).
P2_PLUGIN_FILE = re.compile(r"^(lib)?(qtvirtualkeyboardplugin|qmldbg_quick3dprofiler)\.(so|dll|dylib)$")


def _excluded_qt_family(destination):
    parts = destination.replace("\\", "/").split("/")
    if any(EXCLUDED_QT_FAMILY.match(part) or P2_QT_FAMILY.match(part) for part in parts):
        return True
    if P2_PLUGIN_FILE.match(parts[-1]):
        return True
    return any(pair in P2_QML_DIRS for pair in zip(parts, parts[1:]))


a.binaries = [entry for entry in a.binaries if not _excluded_qt_family(entry[0])]
a.datas = [entry for entry in a.datas if not _excluded_qt_family(entry[0])]

# W1 (Windows only): drop exactly these 44 + 2 bundled DLLs, matched on the
# destination basename (case-insensitive, as Windows file names are).
#  - W1a: Windows API-set forwarders and ucrtbase.dll; the system copies are
#    used on the Qt 6.12 GUI's supported Windows 10 (1809+) and 11 x86_64.
#  - W1b: OpenSSL 3, which Qt's TLS plugin loads only at runtime; without it
#    Qt selects schannel. python3.dll, python310.dll, OpenSSL 1.1, VCRUNTIME and
#    MSVCP runtimes, Qt and its TLS plugins are not matched and stay.
if sys.platform == "win32":
    W1A_SYSTEM_DLLS = (
        "api-ms-win-core-console-l1-1-0.dll", "api-ms-win-core-datetime-l1-1-0.dll",
        "api-ms-win-core-debug-l1-1-0.dll", "api-ms-win-core-errorhandling-l1-1-0.dll",
        "api-ms-win-core-fibers-l1-1-0.dll", "api-ms-win-core-fibers-l1-1-1.dll",
        "api-ms-win-core-file-l1-1-0.dll", "api-ms-win-core-file-l1-2-0.dll",
        "api-ms-win-core-file-l2-1-0.dll", "api-ms-win-core-handle-l1-1-0.dll",
        "api-ms-win-core-heap-l1-1-0.dll", "api-ms-win-core-interlocked-l1-1-0.dll",
        "api-ms-win-core-kernel32-legacy-l1-1-1.dll", "api-ms-win-core-libraryloader-l1-1-0.dll",
        "api-ms-win-core-localization-l1-2-0.dll", "api-ms-win-core-memory-l1-1-0.dll",
        "api-ms-win-core-namedpipe-l1-1-0.dll", "api-ms-win-core-processenvironment-l1-1-0.dll",
        "api-ms-win-core-processthreads-l1-1-0.dll", "api-ms-win-core-processthreads-l1-1-1.dll",
        "api-ms-win-core-profile-l1-1-0.dll", "api-ms-win-core-rtlsupport-l1-1-0.dll",
        "api-ms-win-core-string-l1-1-0.dll", "api-ms-win-core-synch-l1-1-0.dll",
        "api-ms-win-core-synch-l1-2-0.dll", "api-ms-win-core-sysinfo-l1-1-0.dll",
        "api-ms-win-core-sysinfo-l1-2-0.dll", "api-ms-win-core-timezone-l1-1-0.dll",
        "api-ms-win-core-util-l1-1-0.dll", "api-ms-win-crt-conio-l1-1-0.dll",
        "api-ms-win-crt-convert-l1-1-0.dll", "api-ms-win-crt-environment-l1-1-0.dll",
        "api-ms-win-crt-filesystem-l1-1-0.dll", "api-ms-win-crt-heap-l1-1-0.dll",
        "api-ms-win-crt-locale-l1-1-0.dll", "api-ms-win-crt-math-l1-1-0.dll",
        "api-ms-win-crt-private-l1-1-0.dll", "api-ms-win-crt-process-l1-1-0.dll",
        "api-ms-win-crt-runtime-l1-1-0.dll", "api-ms-win-crt-stdio-l1-1-0.dll",
        "api-ms-win-crt-string-l1-1-0.dll", "api-ms-win-crt-time-l1-1-0.dll",
        "api-ms-win-crt-utility-l1-1-0.dll", "ucrtbase.dll",
    )
    W1B_OPENSSL3_DLLS = ("libcrypto-3-x64.dll", "libssl-3-x64.dll")
    W1_EXCLUDED_DLLS = {name.lower() for name in W1A_SYSTEM_DLLS + W1B_OPENSSL3_DLLS}
    a.binaries = [entry for entry in a.binaries
                  if entry[0].replace("\\", "/").rsplit("/", 1)[-1].lower() not in W1_EXCLUDED_DLLS]

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
