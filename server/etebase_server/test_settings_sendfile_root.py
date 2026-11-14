"""SENDFILE_ROOT must follow the final MEDIA_ROOT.

Chunk downloads are served only from inside SENDFILE_ROOT. When MEDIA_ROOT was
moved after SENDFILE_ROOT had been fixed (DJANGO_MEDIA_ROOT, or an
`etebase_server_settings` module), uploads landed in the new media root while
downloads of the same files returned 404.

Settings are evaluated once per process, so each case loads the real settings
module in a fresh interpreter, writes a synthetic file under the resulting
MEDIA_ROOT and passes it to the real `sendfile()`. Every path the subprocess
touches (secret file, media roots, settings module) is under a pytest
temporary directory.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
TIMEOUT_S = 60

# Environment keys that would redirect settings away from the temporary roots.
_SCRUBBED_ENV = (
    "DJANGO_MEDIA_ROOT",
    "DJANGO_STATIC_ROOT",
    "DJANGO_SETTINGS_MODULE",
    "ETEBASE_EASY_CONFIG_PATH",
    "ETEBASE_DB_PATH",
    "PYTHONPATH",
)

_PROBE = """
import json, os
import django
django.setup()
from django.conf import settings
from etebase_server.fastapi.exceptions import HttpError
from etebase_server.fastapi.sendfile.utils import sendfile

path = os.path.join(settings.MEDIA_ROOT, "synthetic-chunk.bin")
with open(path, "wb") as f:
    f.write(b"synthetic")
try:
    status = sendfile(path).status_code
except HttpError as exc:
    status = exc.status_code
print(json.dumps({
    "media_root": os.path.realpath(settings.MEDIA_ROOT),
    "sendfile_root": os.path.realpath(settings.SENDFILE_ROOT),
    "status": status,
}))
"""


@pytest.fixture
def roots(tmp_path) -> dict:
    paths = {
        "base": tmp_path,
        "ini_media": tmp_path / "ini-media",
        "env_media": tmp_path / "env-media",
        "module_media": tmp_path / "module-media",
        "module_dir": tmp_path / "settings-module",
        "cwd": tmp_path / "cwd",
    }
    for key in ("ini_media", "env_media", "module_media", "module_dir", "cwd"):
        paths[key].mkdir()
    return paths


def _write_ini(roots: dict, media_root: Path | None = None) -> Path:
    lines = ["[global]", f"secret_file = {roots['base'] / 'secret.txt'}"]
    if media_root is not None:
        lines.append(f"media_root = {media_root}")
    ini = roots["base"] / "etebase-server.ini"
    ini.write_text("\n".join(lines) + "\n")
    return ini


def _write_settings_module(roots: dict, body: str) -> None:
    (roots["module_dir"] / "etebase_server_settings.py").write_text(body)


def _load(roots: dict, ini: Path, extra_env: dict | None = None, with_module: bool = False) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in _SCRUBBED_ENV}
    env["DJANGO_SETTINGS_MODULE"] = "etebase_server.settings"
    env["ETEBASE_EASY_CONFIG_PATH"] = str(ini)
    env["ETEBASE_DB_PATH"] = str(roots["base"] / "unused.sqlite3")
    python_path = [str(SERVER_DIR)]
    if with_module:
        python_path.insert(0, str(roots["module_dir"]))
    env["PYTHONPATH"] = os.pathsep.join(python_path)
    env.update(extra_env or {})
    completed = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=str(roots["cwd"]),
        env=env,
        capture_output=True,
        text=True,
        timeout=TIMEOUT_S,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr[-4000:]
    return json.loads(completed.stdout.strip().splitlines()[-1])


def test_ini_media_root_is_served(roots):
    result = _load(roots, _write_ini(roots, media_root=roots["ini_media"]))

    media = os.path.realpath(roots["ini_media"])
    assert result == {"media_root": media, "sendfile_root": media, "status": 200}


def test_django_media_root_override_is_served(roots):
    ini = _write_ini(roots)

    result = _load(roots, ini, extra_env={"DJANGO_MEDIA_ROOT": str(roots["env_media"])})

    media = os.path.realpath(roots["env_media"])
    assert result == {"media_root": media, "sendfile_root": media, "status": 200}


def test_settings_module_media_root_is_served(roots):
    _write_settings_module(roots, f"MEDIA_ROOT = {str(roots['module_media'])!r}\n")

    result = _load(roots, _write_ini(roots), with_module=True)

    media = os.path.realpath(roots["module_media"])
    assert result == {"media_root": media, "sendfile_root": media, "status": 200}


def test_settings_module_explicit_sendfile_root_is_kept(roots):
    _write_settings_module(
        roots,
        f"MEDIA_ROOT = {str(roots['module_media'])!r}\nSENDFILE_ROOT = {str(roots['base'])!r}\n",
    )

    result = _load(roots, _write_ini(roots), with_module=True)

    assert result == {
        "media_root": os.path.realpath(roots["module_media"]),
        "sendfile_root": os.path.realpath(roots["base"]),
        "status": 200,
    }
