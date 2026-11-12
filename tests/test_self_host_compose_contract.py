"""Compose compatibility contracts for self-hosted installations.

The self-host Compose file is operator-facing state: existing installations have
containers, named volumes, and a generated override bound to the identifiers in
it. These tests pin the identifiers that cannot change without breaking those
installations, and pin the image selector to the managed immutable value so a
stale digest or a mutable tag can never be reintroduced as source.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
SELF_HOST = ROOT / "self-host"
COMPOSE = SELF_HOST / "docker-compose.yml"
INSTALLER = SELF_HOST / "install.sh"
ENV_EXAMPLE = SELF_HOST / ".env.example"
EFFECTIVE_CHECK = ROOT / "scripts" / "self-host-compose-effective-check.sh"
SELF_HOSTING = SELF_HOST / "SELF-HOSTING.md"

POSTGRES_IMAGE = "postgres@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7"
MANAGED_IMAGE = "${SILENTSUITE_SERVER_IMAGE:?Set by the verified SilentSuite installer or updater}"
IMAGE_REPOSITORY = "ghcr.io/silent-suite/silentsuite-server"

REQUIRED_SERVER_ENVIRONMENT = {
    "SUPER_USER",
    "SUPER_PASS",
    "ETEBASE_DISABLE_SIGNUP",
    "ETEBASE_BOOTSTRAP_ADMIN_TOKEN",
    "ETEBASE_DISABLE_DJANGO_ADMIN",
    "TRUSTED_PROXY_IPS",
    "ETEBASE_MAX_AUTH_REQUEST_BYTES",
    "ETEBASE_MAX_REQUEST_BYTES",
}

# Operator-adjustable request-body limits and their documented defaults (bytes).
REQUEST_LIMIT_DEFAULTS = {
    "ETEBASE_MAX_AUTH_REQUEST_BYTES": "65536",
    "ETEBASE_MAX_REQUEST_BYTES": "67108864",
}
CONFIGURATION_DOCS = {
    "docs": ROOT / "docs" / "self-hosting" / "configuration.md",
    "apps-docs": ROOT / "apps" / "docs" / "self-hosting" / "configuration.md",
}


class StrictLoader(yaml.BaseLoader):
    """BaseLoader that refuses duplicate keys and YAML merge keys."""


def _construct_mapping(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        if key_node.tag == "tag:yaml.org,2002:merge":
            raise AssertionError("YAML merge keys are not supported by Compose here")
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise AssertionError(f"duplicate Compose key: {key!r}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


StrictLoader.add_constructor("tag:yaml.org,2002:map", _construct_mapping)


def parse(text: str) -> dict:
    return yaml.load(text, Loader=StrictLoader)


COMPOSE_SOURCE = COMPOSE.read_text(encoding="utf-8")
COMPOSE_DOCUMENT = parse(COMPOSE_SOURCE)


def generated_override(proxy_network: str = "npm_proxy") -> str:
    """The override install.sh writes when the operator names a proxy network."""

    installer = INSTALLER.read_text(encoding="utf-8")
    match = re.search(
        r"cat > docker-compose\.override\.yml <<OVERRIDE\n(?P<body>.*?)\nOVERRIDE\n",
        installer,
        re.DOTALL,
    )
    assert match, "install.sh should still generate docker-compose.override.yml"
    return match.group("body").replace("$PROXY_NETWORK", proxy_network)


def merge(base: dict, override: dict) -> dict:
    """Compose's merge semantics for the shapes these two files use."""

    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = merge(merged[key], value)
        else:
            merged[key] = value
    return merged


# ── Identities existing installations depend on ───────────────────────


def test_service_identities_are_unchanged():
    assert set(COMPOSE_DOCUMENT["services"]) == {"postgres", "server"}
    assert COMPOSE_DOCUMENT["services"]["server"]["container_name"] == "silentsuite-server"
    assert COMPOSE_DOCUMENT["services"]["postgres"]["container_name"] == "silentsuite-postgres"


def test_named_volume_identities_are_unchanged():
    assert set(COMPOSE_DOCUMENT["volumes"]) == {"pgdata", "server_data"}
    assert "pgdata:/var/lib/postgresql/data" in COMPOSE_DOCUMENT["services"]["postgres"]["volumes"]
    assert "server_data:/data" in COMPOSE_DOCUMENT["services"]["server"]["volumes"]


def test_advertised_security_controls_stay_plumbed_through():
    environment = COMPOSE_DOCUMENT["services"]["server"]["environment"]
    assert REQUIRED_SERVER_ENVIRONMENT <= set(environment)
    assert environment["ETEBASE_DISABLE_DJANGO_ADMIN"] == "${ETEBASE_DISABLE_DJANGO_ADMIN:-true}"
    assert environment["ETEBASE_BOOTSTRAP_ADMIN_TOKEN"] == "${ETEBASE_BOOTSTRAP_ADMIN_TOKEN:-}"
    assert environment["TRUSTED_PROXY_IPS"] == "${TRUSTED_PROXY_IPS:-127.0.0.1}"


def test_request_limits_plumbed_with_documented_defaults():
    environment = COMPOSE_DOCUMENT["services"]["server"]["environment"]
    for name, default in REQUEST_LIMIT_DEFAULTS.items():
        assert environment.get(name) == f"${{{name}:-{default}}}", name


def test_env_example_documents_request_limits():
    text = ENV_EXAMPLE.read_text(encoding="utf-8")
    for name, default in REQUEST_LIMIT_DEFAULTS.items():
        assert re.search(rf"^{name}={default}$", text, re.MULTILINE), name


def _request_limit_rows(text: str) -> list[str]:
    """Only the newly added limit rows; the mirrors differ elsewhere (link labels)."""
    return [line for line in text.splitlines() if line.startswith("| `ETEBASE_MAX_")]


@pytest.mark.parametrize("mirror", [pytest.param("docs", id="docs"), pytest.param("apps-docs", id="apps-docs")])
def test_configuration_docs_document_request_limits(mirror):
    text = CONFIGURATION_DOCS[mirror].read_text(encoding="utf-8")
    rows = _request_limit_rows(text)
    for name, default in REQUEST_LIMIT_DEFAULTS.items():
        assert any(row.startswith(f"| `{name}` | No | `{default}` |") for row in rows), name
    recreate = [line for line in text.splitlines() if line.startswith("After changing a server runtime setting")]
    assert len(recreate) == 1
    for name in REQUEST_LIMIT_DEFAULTS:
        assert f"`{name}`" in recreate[0], name
    # Recovery guidance distinguishes the msgpack and billing JSON 413 responses.
    assert "request_too_large" in text
    assert "Request body too large" in text


def test_request_limit_doc_rows_match_across_mirrors():
    rows = {mirror: _request_limit_rows(path.read_text(encoding="utf-8")) for mirror, path in CONFIGURATION_DOCS.items()}
    assert rows["docs"], "the request-limit rows are missing"
    assert rows["docs"] == rows["apps-docs"]


def test_server_port_stays_bound_to_host_loopback():
    assert COMPOSE_DOCUMENT["services"]["server"]["ports"] == ["127.0.0.1:${SERVER_PORT:-3735}:3735"]


# ── Managed image identity ────────────────────────────────────────────


def test_server_image_is_the_required_managed_interpolation():
    assert COMPOSE_DOCUMENT["services"]["server"]["image"] == MANAGED_IMAGE


def test_managed_image_has_no_default_so_an_unset_value_fails_loudly():
    image = COMPOSE_DOCUMENT["services"]["server"]["image"]
    assert image.startswith("${SILENTSUITE_SERVER_IMAGE:?"), "a :- default would silently run the wrong image"
    assert ":-" not in image


def test_no_tracked_self_host_file_hard_codes_a_server_image_digest():
    offenders = []
    for path in sorted(SELF_HOST.iterdir()):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(rf"{re.escape(IMAGE_REPOSITORY)}@sha256:[0-9a-f]{{64}}", text):
            offenders.append(f"{path.name}: {match.group(0)[:80]}")
    assert offenders == [], "the server image digest is release data, not source"


def test_no_tracked_self_host_file_makes_a_mutable_tag_the_runtime_authority():
    offenders = []
    for path in sorted(SELF_HOST.iterdir()):
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if re.search(rf"{re.escape(IMAGE_REPOSITORY)}:[A-Za-z0-9._-]+", line):
                offenders.append(f"{path.name}: {line.strip()[:100]}")
    assert offenders == [], "the server image must always be selected by digest"


def test_postgres_runs_an_immutable_index_digest_not_a_tag():
    """A tag is a name, not an identity.

    The database container holds the password and every account and sync row, so
    a republished upstream tag must not be able to change what runs under an
    unchanged SilentSuite release.
    """

    image = COMPOSE_DOCUMENT["services"]["postgres"]["image"]
    assert image == POSTGRES_IMAGE
    assert "@sha256:" in image and ":16.9-alpine" not in image
    assert "${" not in image, "the database identity is fixed source, not release or env data"


@pytest.mark.parametrize("service", ["postgres", "server"])
def test_no_service_can_be_started_from_a_mutable_tag(service):
    image = COMPOSE_DOCUMENT["services"][service]["image"]
    assert "@sha256:" in image or image.startswith("${SILENTSUITE_SERVER_IMAGE"), image


def test_no_tracked_self_host_surface_starts_postgres_from_a_tag():
    """Including CI: the smoke fixture must exercise the operator's database."""

    for path in (COMPOSE, ROOT / "scripts" / "self-host-image-smoke.sh"):
        text = path.read_text(encoding="utf-8")
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            assert "postgres:16" not in stripped, f"{path.name}: {stripped}"
    smoke = (ROOT / "scripts" / "self-host-image-smoke.sh").read_text(encoding="utf-8")
    assert POSTGRES_IMAGE in smoke


def test_the_pinned_postgres_digest_is_traceable_to_its_source_tag():
    """The digest is unreadable on its own; the source comment is the provenance."""

    source = COMPOSE_SOURCE
    assert "docker.io/library/postgres:16.9-alpine" in source
    for child in (
        "sha256:b441677c946de564fe88ae4245ba80fe84a69485b22bf560e9c7c3710cd5e21d",
        "sha256:a833a42d2f60170d90d8fb46b99e80f29b083a173c85ffd1e7e366730dc5529c",
    ):
        assert child in source, "both platform children stay recorded beside the index digest"


def test_env_example_documents_the_managed_image_variable():
    text = ENV_EXAMPLE.read_text(encoding="utf-8")
    assert re.search(r"^SILENTSUITE_SERVER_IMAGE=$", text, re.MULTILINE)
    assert "linux/amd64" in text and "linux/arm64" in text


def test_installer_writes_the_immutable_index_digest_into_env():
    installer = INSTALLER.read_text(encoding="utf-8")
    assert 'SERVER_IMAGE="${IMAGE_REPOSITORY}@${INDEX_DIGEST}"' in installer
    assert "SILENTSUITE_SERVER_IMAGE=$SERVER_IMAGE" in installer
    assert f'IMAGE_REPOSITORY="{IMAGE_REPOSITORY}"' in installer


# ── Override compatibility ────────────────────────────────────────────


def test_generated_override_still_targets_the_existing_service_and_networks():
    override = parse(generated_override())
    assert set(override["services"]) <= set(COMPOSE_DOCUMENT["services"])
    assert set(override["services"]) == {"server"}
    assert override["services"]["server"]["networks"] == ["silentsuite", "proxy"]
    assert "image" not in override["services"]["server"], "the override must not re-pin the image"
    assert override["networks"]["proxy"]["external"] == "true"
    assert override["networks"]["proxy"]["name"] == "npm_proxy"


def test_existing_override_merges_without_losing_the_managed_image():
    merged = merge(COMPOSE_DOCUMENT, parse(generated_override()))
    assert set(merged["services"]) == {"postgres", "server"}
    assert merged["services"]["server"]["image"] == MANAGED_IMAGE
    assert merged["services"]["server"]["container_name"] == "silentsuite-server"
    assert merged["services"]["server"]["networks"] == ["silentsuite", "proxy"]
    assert set(merged["volumes"]) == {"pgdata", "server_data"}
    assert set(merged["networks"]) == {"silentsuite", "proxy"}


@pytest.mark.parametrize("service", ["server", "postgres"])
def test_both_services_stay_on_the_internal_network(service):
    assert COMPOSE_DOCUMENT["services"][service]["networks"] == ["silentsuite"]


# ── Effective-configuration check (executed by CI, which has Compose) ──


def test_effective_config_check_uses_the_installer_generated_override():
    installer_body = re.search(
        r"cat > docker-compose\.override\.yml <<OVERRIDE\n(?P<body>.*?)\nOVERRIDE\n",
        INSTALLER.read_text(encoding="utf-8"),
        re.DOTALL,
    ).group("body")
    checker_body = re.search(
        r'cat > "\$WORKDIR/docker-compose\.override\.yml" <<OVERRIDE\n(?P<body>.*?)\nOVERRIDE\n',
        EFFECTIVE_CHECK.read_text(encoding="utf-8"),
        re.DOTALL,
    ).group("body")
    assert checker_body == installer_body, (
        "the effective-config check must render the same override the installer writes"
    )


def test_effective_config_check_asserts_the_compatibility_identities():
    source = EFFECTIVE_CHECK.read_text(encoding="utf-8")
    assert 'config --format json' in source
    for required in (
        '{"server", "postgres"}',
        '{"pgdata", "server_data"}',
        '"silentsuite-server"',
        '"silentsuite-postgres"',
        '("server_data", "/data")',
        '("pgdata", "/var/lib/postgresql/data")',
        '{"silentsuite", "proxy"}',
        '"127.0.0.1"',
        "An unset server image must fail closed",
    ):
        assert required in source, f"effective-config check does not assert {required}"
    # Rendering only: nothing may be pulled, started, pushed, or published.
    for forbidden in ("docker compose up", "docker compose pull", "docker push", "docker pull"):
        assert forbidden not in source, f"the effective-config check must not run {forbidden}"


def test_effective_config_check_uses_only_placeholder_values():
    source = EFFECTIVE_CHECK.read_text(encoding="utf-8")
    assert "placeholder-value-not-a-secret" in source
    assert "sha256:" + "0" * 64 in source


def test_the_guide_does_not_offer_an_unsafe_cross_version_upgrade_procedure():
    """Cross-version upgrading is deferred; the guide must say so, not improvise."""

    guide = SELF_HOSTING.read_text(encoding="utf-8")
    upgrade_section = guide.split("## Upgrading to a new version", 1)[1].split("\n## ", 1)[0]
    assert "not supplied yet" in upgrade_section
    assert "Re-running `install.sh` is **not** the upgrade path" in upgrade_section
    assert "--stage-only" in upgrade_section, "staging a release stays a safe, non-mutating action"
    for unsafe in ("docker volume rm", "docker compose down", "manage.py migrate", "curl -fsSL"):
        assert unsafe not in upgrade_section, f"the deferred upgrade section must not script {unsafe!r}"
