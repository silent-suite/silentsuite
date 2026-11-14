"""sendfile 404 responses must not reveal server filesystem paths.

The paths still go to the server log so operators can diagnose a missing file.
"""

from __future__ import annotations

import logging

import pytest

from etebase_server.fastapi.exceptions import HttpError
from etebase_server.fastapi.sendfile.utils import sendfile


def _assert_generic_404(exc: HttpError, *paths: str) -> None:
    assert exc.status_code == 404
    body = repr(exc.as_dict)
    for path in paths:
        assert path not in body
    assert "/" not in exc.detail
    assert "\\" not in exc.detail


def test_missing_file_404_hides_path(settings, tmp_path, caplog):
    root = tmp_path / "media"
    root.mkdir()
    settings.SENDFILE_ROOT = str(root)
    missing = root / "chunks" / "missing-chunk.bin"

    with caplog.at_level(logging.WARNING, logger="etebase_server.fastapi.sendfile.utils"):
        with pytest.raises(HttpError) as excinfo:
            sendfile(str(missing))

    assert excinfo.value.code == "does_not_exist"
    _assert_generic_404(excinfo.value, str(tmp_path), str(missing))
    assert str(missing) in caplog.text


def test_path_outside_root_404_hides_paths(settings, tmp_path, caplog):
    root = tmp_path / "media"
    root.mkdir()
    settings.SENDFILE_ROOT = str(root)
    outside = tmp_path / "elsewhere" / "secret.bin"

    with caplog.at_level(logging.WARNING, logger="etebase_server.fastapi.sendfile.utils"):
        with pytest.raises(HttpError) as excinfo:
            sendfile(str(outside))

    assert excinfo.value.code == "generic"
    _assert_generic_404(excinfo.value, str(tmp_path), str(root), str(outside))
    assert str(outside) in caplog.text
