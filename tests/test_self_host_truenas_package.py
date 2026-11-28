"""Static contract for the TrueNAS community-train app in self-host/truenas/silentsuite.

Behaviour (TLS signup, throttle, log privacy, persistence, host-path rules) is proven at
runtime by .github/workflows/ci-truenas-candidate.yml; this file pins the source facts
that the runtime checks rely on.
"""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "self-host" / "truenas" / "silentsuite"
TEMPLATE = (APP / "templates" / "docker-compose.yaml").read_text(encoding="utf-8")
ROUTER = (APP / "templates" / "macros" / "router.conf").read_text(encoding="utf-8")
WRAPPER = (APP / "templates" / "macros" / "server-start.sh").read_text(encoding="utf-8")
VALUES = yaml.safe_load((APP / "ix_values.yaml").read_text(encoding="utf-8"))
QUESTIONS = yaml.safe_load((APP / "questions.yaml").read_text(encoding="utf-8"))
METADATA = yaml.safe_load((APP / "app.yaml").read_text(encoding="utf-8"))


def question(*path):
    items = QUESTIONS["questions"]
    node = None
    for name in path:
        node = next(item for item in items if item["variable"] == name)
        items = node["schema"].get("attrs", [])
    return node["schema"]


def test_the_catalog_identity_matches_the_directory():
    assert METADATA["name"] == APP.name == "silentsuite"
    assert METADATA["train"] == "community"


def test_web_and_server_are_one_published_release():
    server = VALUES["images"]["image"]
    web = VALUES["images"]["web_image"]
    assert server["repository"] == "ghcr.io/silent-suite/silentsuite-server"
    assert web["repository"] == "ghcr.io/silent-suite/silentsuite-web-selfhost"
    server_tag, web_tag = server["tag"].split("@")[0], web["tag"].split("@")[0]
    assert server_tag == web_tag
    assert re.fullmatch(r"v\d+\.\d+\.\d+-beta(\.\d+)?", server_tag)
    assert METADATA["app_version"] == server_tag
    # The render refuses a mixed pair, so a store-side bot bump of one image fails CI there.
    assert 'values.images.image.tag.split("@")[0] != values.images.web_image.tag.split("@")[0]' in TEMPLATE


def test_every_image_is_pinned_by_digest():
    for name, image in VALUES["images"].items():
        assert re.fullmatch(r"[^@\s]+@sha256:[0-9a-f]{64}", image["tag"]), name


def test_installation_password_follows_the_server_owner_login_rule():
    schema = question("silentsuite", "installation_password")
    assert schema["private"] is True and schema["required"] is True
    assert schema["min_length"] == 32 and schema["max_length"] == 256
    assert schema["default"] == ""


def test_database_password_is_private_immutable_and_checked_at_install():
    schema = question("silentsuite", "db_password")
    assert schema["private"] is True and schema["required"] is True
    assert schema["immutable"] is True
    assert schema["default"] == ""
    assert "db_password != db_password.strip()" in TEMPLATE
    # A fixed message: the refused value is never echoed.
    assert "must_match_regex" not in TEMPLATE


def test_signup_needs_https_or_an_explicit_https_proxy():
    assert question("network", "certificate_id")["null"] is True
    assert question("network", "behind_https_proxy")["default"] is False
    assert "not values.network.certificate_id and not values.network.behind_https_proxy" in TEMPLATE


def test_server_hardening_settings():
    for line in (
        'add_env("ETEBASE_DISABLE_DJANGO_ADMIN", "true")',
        'add_env("ETEBASE_SECURE_SSL_REDIRECT", "false")',
        'add_env("CORS_ALLOWED_ORIGINS", "")',
        'add_env("ETEBASE_EASY_CONFIG_PATH", "/run/silentsuite/etebase-server.ini")',
    ):
        assert line in TEMPLATE
    assert 'add_storage("/run/silentsuite", {"type": "tmpfs"' in TEMPLATE


def test_only_the_router_publishes_a_port():
    assert TEMPLATE.count(".add_port(") == 1
    assert "router.add_port(values.network.web_port" in TEMPLATE


def test_router_keeps_requests_out_of_logs_and_guards_owner_login():
    assert "access_log off;" in ROUTER
    assert "error_log /dev/null;" in ROUTER
    assert "location /admin/ {\n            return 404;" in ROUTER
    assert re.search(r"location /api/v1/owner/ \{\s+limit_req zone=owner_login", ROUTER)


def test_wrapper_inspects_data_before_touching_it():
    checks = WRAPPER.index("os.lstat(path)")
    assert checks < WRAPPER.index("config.write(handle)")
    assert checks < WRAPPER.index("os.chmod(path, 0o600)")
    assert checks < WRAPPER.index("os.O_EXCL | os.O_NOFOLLOW")
    assert "--no-access-log" in WRAPPER


def test_no_container_can_be_attached_to_outside_networks():
    # Only the router's published port is the way in; no backend joins another network.
    network = next(q for q in QUESTIONS["questions"] if q["variable"] == "network")
    assert "networks" not in [attr["variable"] for attr in network["schema"]["attrs"]]


def test_the_two_https_modes_are_exclusive():
    assert "values.network.certificate_id and values.network.behind_https_proxy" in TEMPLATE
