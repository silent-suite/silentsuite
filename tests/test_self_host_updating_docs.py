"""Contract for the published self-host "Updating" page.

The page is tracked and linked from the self-hosting index, so an operator who
follows the navigation reaches it. It must agree with what the
software actually does: digest-pinned Compose, a restart-only `update.sh`, an
installer that refuses an occupied target, and no cross-version procedure yet.
"""

from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

PAGES = {
    "apps/docs": ROOT / "apps" / "docs" / "self-hosting" / "updating.md",
}
INDEXES = {
    "apps/docs": ROOT / "apps" / "docs" / "self-hosting" / "index.md",
}

REQUIRED = (
    "SILENTSUITE_SERVER_IMAGE",
    "@sha256:",
    "no supported cross-version update procedure yet",
    "not the upgrade path",
    "--stage-only",
)

# Each of these is a procedure the software does not support, or an authority
# claim it contradicts. None may reappear on the page.
FORBIDDEN = (
    "install.sh | bash",
    "silentsuite-server:latest",
    ":latest",
    "image: ghcr.io/silent-suite/silentsuite-server:v",
    "pkgs/container/silentsuite-server",
    "SILENTSUITE_VERSION=",
)


@pytest.mark.parametrize("tree", sorted(PAGES))
def test_the_updating_page_is_tracked_and_linked(tree: str):
    assert PAGES[tree].is_file()
    assert "updating.md" in INDEXES[tree].read_text(encoding="utf-8")


@pytest.mark.parametrize("tree", sorted(PAGES))
@pytest.mark.parametrize("phrase", REQUIRED)
def test_the_updating_page_states_the_supported_behaviour(tree: str, phrase: str):
    assert phrase in PAGES[tree].read_text(encoding="utf-8")


@pytest.mark.parametrize("tree", sorted(PAGES))
@pytest.mark.parametrize("phrase", FORBIDDEN)
def test_the_updating_page_recommends_no_unsupported_procedure(tree: str, phrase: str):
    assert phrase not in PAGES[tree].read_text(encoding="utf-8")


@pytest.mark.parametrize("tree", sorted(PAGES))
def test_update_sh_is_described_as_a_restart_not_an_upgrade(tree: str):
    text = PAGES[tree].read_text(encoding="utf-8")
    assert "./update.sh" in text
    assert "does **not** change SilentSuite versions" in text


@pytest.mark.parametrize("tree", sorted(PAGES))
def test_the_data_safety_caveat_survives(tree: str):
    text = PAGES[tree].read_text(encoding="utf-8")
    assert "pgdata" in text and "server_data" in text
    assert "backup-and-restore.md" in text


def test_the_updating_page_warns_against_editing_the_digest():
    for tree, page in PAGES.items():
        assert "Do not edit the digest in `.env` by hand." in page.read_text(encoding="utf-8"), tree
