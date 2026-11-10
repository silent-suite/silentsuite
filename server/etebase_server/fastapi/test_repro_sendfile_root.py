"""SELFHOST-05 reproduction attempt: DJANGO_MEDIA_ROOT outside the earlier SENDFILE_ROOT.

settings.py sets ``SENDFILE_ROOT = MEDIA_ROOT`` before applying ``DJANGO_MEDIA_ROOT``,
while an INI ``media_root`` is applied before that assignment. Settings are frozen
per process, so each case runs the real settings, models, storage and the real
``chunk_update`` / ``chunk_download`` routes in a fresh subprocess
(``repro_sendfile_probe.py``), with explicit timeouts.

Every runtime write is confined to pytest temporary directories:
  * ETEBASE_DB_PATH -> tmp sqlite (migrated once, then copied per case)
  * ETEBASE_EASY_CONFIG_PATH -> tmp INI whose [global] secret_file is a tmp path,
    so the default server/secret.txt is never created by these subprocesses
  * media (DJANGO_MEDIA_ROOT or INI media_root) -> tmp directory

Defect case: INI sets only secret_file (MEDIA_ROOT/SENDFILE_ROOT keep their code
defaults) and DJANGO_MEDIA_ROOT points at a tmp directory.
Control: INI sets media_root to a tmp directory and DJANGO_MEDIA_ROOT is unset.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[2]
PROBE_MODULE = "etebase_server.fastapi.repro_sendfile_probe"
RECEIPT_MARKER = "REPRO_SENDFILE_RECEIPT="
MIGRATE_TIMEOUT_S = 120
PROBE_TIMEOUT_S = 80
MODULE_BUDGET_S = 300
_timing = {"started": None}  # set when the module's first fixture runs, not at import


def _elapsed() -> float:
    return time.monotonic() - _timing["started"]

# Environment keys that would redirect settings away from the fixture's temp roots.
_SCRUBBED_ENV = (
    "DJANGO_MEDIA_ROOT",
    "DJANGO_STATIC_ROOT",
    "ETEBASE_EASY_CONFIG_PATH",
    "ETEBASE_DB_PATH",
    "ETEBASE_DEBUG",
    "DJANGO_SETTINGS_MODULE",
)


def _write_ini(path: Path, secret_file: Path, media_root: Path | None) -> Path:
    lines = ["[global]", f"secret_file = {secret_file}"]
    if media_root is not None:
        lines.append(f"media_root = {media_root}")
    path.write_text("\n".join(lines) + "\n")
    return path


def _run_probe(mode: str, env_overrides: dict[str, str], timeout: int) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in _SCRUBBED_ENV}
    env["DJANGO_SETTINGS_MODULE"] = "etebase_server.settings"
    env.update(env_overrides)
    # subprocess.run kills and reaps the child if the timeout expires.
    completed = subprocess.run(
        [sys.executable, "-m", PROBE_MODULE, mode],
        cwd=str(SERVER_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    receipts = [line[len(RECEIPT_MARKER):] for line in completed.stdout.splitlines() if line.startswith(RECEIPT_MARKER)]
    assert completed.returncode == 0 and len(receipts) == 1, (
        f"probe {mode} failed rc={completed.returncode}\nstdout:\n{completed.stdout[-4000:]}\nstderr:\n{completed.stderr[-4000:]}"
    )
    return json.loads(receipts[0])


@pytest.fixture(scope="module")
def roots(tmp_path_factory) -> dict[str, Path]:
    _timing["started"] = time.monotonic()
    # Receipt: no cwd-relative or system INI can leak into the subprocesses.
    assert not (SERVER_DIR / "etebase-server.ini").exists()
    assert not Path("/etc/etebase-server/etebase-server.ini").exists()

    base = tmp_path_factory.mktemp("selfhost05")
    paths = {
        "base": base,
        "secret": base / "secret.txt",
        "template_db": base / "template.sqlite3",
        "ini_secret_only": base / "secret-only.ini",
        "ini_media": base / "with-media.ini",
        "media_defect": base / "media-defect",
        "media_control": base / "media-control",
        "db_defect": base / "defect.sqlite3",
        "db_control": base / "control.sqlite3",
    }
    paths["media_defect"].mkdir()
    paths["media_control"].mkdir()
    _write_ini(paths["ini_secret_only"], paths["secret"], None)
    _write_ini(paths["ini_media"], paths["secret"], paths["media_control"])

    migrated = _run_probe(
        "migrate",
        {"ETEBASE_DB_PATH": str(paths["template_db"]), "ETEBASE_EASY_CONFIG_PATH": str(paths["ini_secret_only"])},
        MIGRATE_TIMEOUT_S,
    )
    assert os.path.realpath(migrated["db_name"]) == os.path.realpath(paths["template_db"])
    assert paths["template_db"].is_file() and paths["secret"].is_file()
    shutil.copyfile(paths["template_db"], paths["db_defect"])
    shutil.copyfile(paths["template_db"], paths["db_control"])
    return paths


def _assert_tmp_confined(receipt: dict, roots: dict[str, Path]) -> None:
    base = os.path.realpath(roots["base"])
    for key in ("secret_file", "db_name", "media_root"):
        assert os.path.commonpath([receipt[key], base]) == base, (key, receipt[key])


def test_selfhost05_control_ini_media_root_download_returns_uploaded_bytes(roots):
    receipt = _run_probe(
        "probe",
        {"ETEBASE_DB_PATH": str(roots["db_control"]), "ETEBASE_EASY_CONFIG_PATH": str(roots["ini_media"])},
        PROBE_TIMEOUT_S,
    )
    print("[SELFHOST-05 control] " + json.dumps(receipt, sort_keys=True))
    _assert_tmp_confined(receipt, roots)
    media = os.path.realpath(roots["media_control"])
    assert receipt["media_root"] == media and receipt["sendfile_root"] == media
    assert receipt["put_status"] == 201 and receipt["chunk_exists"] and receipt["chunk_under_media_root"]
    assert receipt["get_status"] == 200
    assert receipt["body_matches_upload"] is True
    assert _elapsed() < MODULE_BUDGET_S


def test_selfhost05_django_media_root_override_download_returns_uploaded_bytes(roots):
    receipt = _run_probe(
        "probe",
        {
            "ETEBASE_DB_PATH": str(roots["db_defect"]),
            "ETEBASE_EASY_CONFIG_PATH": str(roots["ini_secret_only"]),
            "DJANGO_MEDIA_ROOT": str(roots["media_defect"]),
        },
        PROBE_TIMEOUT_S,
    )
    print("[SELFHOST-05] " + json.dumps(receipt, sort_keys=True))

    # Preconditions (receipts) are verified before judging download behaviour.
    _assert_tmp_confined(receipt, roots)
    media = os.path.realpath(roots["media_defect"])
    assert receipt["media_root"] == media
    assert receipt["sendfile_root"] != receipt["media_root"]
    assert receipt["put_status"] == 201 and receipt["chunk_exists"] and receipt["chunk_under_media_root"]

    # Expected-correct, evaluated together so the status cannot mask the
    # body/path observation.
    detail = receipt["detail"] or ""
    observed = {
        "download_status_is_200": receipt["get_status"] == 200,
        "body_matches_and_no_path_disclosed": receipt["body_matches_upload"] is True
        and str(roots["base"]) not in detail
        and os.path.realpath(roots["base"]) not in detail,
    }
    assert observed == {"download_status_is_200": True, "body_matches_and_no_path_disclosed": True}, (observed, receipt)
    assert _elapsed() < MODULE_BUDGET_S
