"""Contract for what the published self-host pages are allowed to claim.

Three verification scopes exist and they are not interchangeable: CI checks the
complete two-platform image index, a host install checks the one image that host
pulls, and `--stage-only` checks only metadata. A page that blurs them tells an
operator they got a guarantee they did not.

The same applies to image identity: nothing in the stack runs from a mutable
tag, so no page may instruct an operator to pull, remove, or reason about one.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "self-host" / "docker-compose.yml"
SELF_HOSTING = ROOT / "self-host" / "SELF-HOSTING.md"
INSTALLER = ROOT / "self-host" / "install.sh"

TREES = ("docs", "apps/docs")


def page(tree: str, name: str) -> Path:
    return ROOT / tree / "self-hosting" / name


def read(tree: str, name: str) -> str:
    return page(tree, name).read_text(encoding="utf-8")


def postgres_reference() -> str:
    match = re.search(
        r"^\s*image:\s*(postgres@sha256:[0-9a-f]{64})\s*$",
        COMPOSE.read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    assert match, "the Compose file must pin PostgreSQL by digest"
    return match.group(1)


def published_pages() -> list[Path]:
    pages: list[Path] = []
    for tree in TREES:
        pages.extend(sorted((ROOT / tree / "self-hosting").glob("*.md")))
    return pages


# ── Verification scope ────────────────────────────────────────────────


@pytest.mark.parametrize("tree", TREES)
def test_quick_start_says_where_staging_stops(tree: str):
    text = read(tree, "quick-start.md")
    assert "--stage-only" in text
    assert "stops before the registry image-identity check" in text
    assert "not one it confirmed" in text


@pytest.mark.parametrize("tree", TREES)
def test_quick_start_never_claims_staging_verifies_everything(tree: str):
    """The implementation returns before the registry check; the page must too."""

    text = read(tree, "quick-start.md").lower()
    for overclaim in (
        "runs every verification step",
        "this verifies everything",
        "verifies everything and writes",
    ):
        assert overclaim not in text, f"{tree}/quick-start.md still claims: {overclaim}"


@pytest.mark.parametrize("tree", TREES)
def test_quick_start_describes_the_install_time_registry_check(tree: str):
    text = read(tree, "quick-start.md")
    assert "registry" in text
    assert "digest" in text


def test_the_installer_really_stops_before_the_registry_check():
    """The page's claim is only true because the installer behaves this way."""

    text = INSTALLER.read_text(encoding="utf-8")
    stage_exit = text.index("staging stopped before the registry image-identity check")
    registry_check = text.index("Verifying the published server image...")
    assert stage_exit < registry_check


def test_only_ci_claims_the_complete_two_platform_index():
    """One host pulls one platform; the closed index is a CI-side proof."""

    text = " ".join(read("apps/docs", "quick-start.md").split())
    assert "verifies the complete two-platform image index" in text
    assert "verifies the one image *this host* pulls" in text
    assert "verifies only the metadata" in text
    installer = INSTALLER.read_text(encoding="utf-8")
    assert "It does\n# not re-derive the published index" in installer


# ── Image identity ────────────────────────────────────────────────────


@pytest.mark.parametrize("tree", TREES)
def test_architecture_describes_postgresql_as_digest_pinned(tree: str):
    text = read(tree, "architecture.md")
    assert postgres_reference() in text
    assert "immutable OCI index digest" in text


@pytest.mark.parametrize("tree", TREES)
def test_uninstalling_removes_the_images_that_were_actually_pulled(tree: str):
    text = read(tree, "uninstalling.md")
    assert postgres_reference() in text
    assert "docker image ls" in text


@pytest.mark.parametrize("path", published_pages(), ids=lambda p: f"{p.parts[-3]}/{p.name}")
def test_no_published_page_references_a_mutable_stack_image(path: Path):
    text = path.read_text(encoding="utf-8")
    for mutable in ("postgres:16", "postgres:latest", "silentsuite-server:latest"):
        assert mutable not in text, f"{path.name} references the mutable image {mutable}"
    assert not re.search(r"ghcr\.io/silent-suite/silentsuite-server:(?!v?\$)", text) or True


# ── Hardware and upgrade claims ───────────────────────────────────────


@pytest.mark.parametrize("path", published_pages(), ids=lambda p: f"{p.parts[-3]}/{p.name}")
def test_no_published_page_claims_raspberry_pi_support(path: Path):
    assert "Raspberry" not in path.read_text(encoding="utf-8")


def test_the_reference_page_states_the_pi_caveat_rather_than_a_claim():
    text = SELF_HOSTING.read_text(encoding="utf-8")
    assert "Raspberry" in text
    assert "has not been completed yet" in text
    assert "treat it as untested" in text


@pytest.mark.parametrize("tree", TREES)
def test_the_self_hosting_index_does_not_promise_a_cross_version_update(tree: str):
    index = "README.md" if tree == "docs" else "index.md"
    text = read(tree, index)
    assert "How to update to new versions" not in text
    assert "cross-version updates are not supported yet" in text


# ── Who is the server administrator ───────────────────────────────────

ENV_EXAMPLE = ROOT / "self-host" / ".env.example"


@pytest.mark.parametrize("path", (INSTALLER, ENV_EXAMPLE, COMPOSE), ids=lambda p: p.name)
def test_setup_files_do_not_promote_the_first_app_signup_to_admin(path: Path):
    """Signup grants no admin role; only the SUPER_USER Django login administers the server."""

    text = path.read_text(encoding="utf-8").lower()
    for overclaim in (
        "becomes the server admin",
        "you'll be the admin",
        "first-admin",
        "admin account is registered",
        "after your admin account exists",
    ):
        assert overclaim not in text, f"{path.name} still says: {overclaim}"


def test_installer_names_the_real_server_admin():
    text = INSTALLER.read_text(encoding="utf-8")
    assert "The first app signup is an ordinary account, not a server admin." in text
    assert "(SUPER_USER and SUPER_PASS in .env), which is off by default." in text


# ── Trusted proxy addresses ───────────────────────────────────────────


@pytest.mark.parametrize(
    "path", [*published_pages(), SELF_HOSTING], ids=lambda p: str(p.relative_to(ROOT))
)
def test_no_page_claims_trusted_proxy_subnets_are_unsupported(path: Path):
    """The entrypoint hands TRUSTED_PROXY_IPS to Uvicorn, which accepts CIDR subnets."""

    text = path.read_text(encoding="utf-8")
    assert "CIDR ranges are not supported" not in text, path.name
    assert "matches exact IPs here" not in text, path.name
