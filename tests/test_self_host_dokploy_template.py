"""Contract for the SilentSuite Dokploy blueprint (self-host/dokploy/silentsuite).

Re-implements the Dokploy/templates rules (CONTRIBUTING.md, AGENTS.md, build-scripts validators at
60ee1e7) plus this package's security and derivation rules. No network, no Docker.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
BLUEPRINT = ROOT / "self-host/dokploy/silentsuite"
UMBREL_DATA = ROOT / "self-host/umbrel/silentsuite/data"
RENDER = ROOT / "scripts/dokploy-template-render.py"
SECRETS = {
    "SILENTSUITE_INSTALLATION_PASSWORD": 32,
    "SILENTSUITE_REGISTRATION_SIGNING": 64,
    "SILENTSUITE_DB_PASSWORD": 64,
}
DIGEST_IMAGE = re.compile(r"^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$")

spec = importlib.util.spec_from_file_location("dokploy_render", RENDER)
render_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render_module)


def compose_text():
    return (BLUEPRINT / "docker-compose.yml").read_text(encoding="utf-8")


def compose():
    return yaml.safe_load(compose_text())


def template():
    return tomllib.loads((BLUEPRINT / "template.toml").read_text(encoding="utf-8"))


def meta():
    return json.loads((BLUEPRINT / "meta.json").read_text(encoding="utf-8"))


def mounts():
    return {mount["filePath"]: mount["content"] for mount in template()["config"]["mounts"]}


def run_render(*arguments):
    return subprocess.run([sys.executable, str(RENDER), *arguments], capture_output=True, text=True, check=False)


class UpstreamRules(unittest.TestCase):
    """What Dokploy/templates enforces or requires of every blueprint."""

    def test_blueprint_layout(self):
        names = sorted(path.name for path in BLUEPRINT.iterdir())
        self.assertEqual(names, ["docker-compose.yml", "meta.json", "silentsuite.svg", "template.toml"])

    def test_compose_has_no_forbidden_keys(self):
        document = compose()
        self.assertNotIn("version", document)
        self.assertNotIn("networks", document)
        for name, service in document["services"].items():
            for key in ("container_name", "networks", "network_mode", "ports", "build"):
                self.assertNotIn(key, service, f"{name}: {key}")
            self.assertRegex(name, r"^silentsuite(-[a-z]+)?$")
            self.assertIn(service.get("restart"), ("unless-stopped", "no"), name)

    def test_router_restarts_when_its_upstreams_are_recreated(self):
        depends = compose()["services"]["silentsuite"]["depends_on"]
        self.assertEqual(set(depends), {"silentsuite-web", "silentsuite-server"})
        self.assertTrue(all(entry.get("restart") is True for entry in depends.values()))

    def test_only_the_one_shot_initializer_does_not_restart(self):
        restarts = {name: service["restart"] for name, service in compose()["services"].items()}
        self.assertEqual([name for name, value in restarts.items() if value == "no"], ["silentsuite-init"])

    def test_meta_fields(self):
        document = meta()
        self.assertEqual(document["id"], BLUEPRINT.name)
        for field in ("name", "version", "description", "logo", "links", "tags"):
            self.assertTrue(document[field], field)
        self.assertTrue((BLUEPRINT / document["logo"]).is_file())
        self.assertEqual(set(document["links"]), {"github", "website", "docs"})
        self.assertTrue(all(tag == tag.lower() for tag in document["tags"]))

    def test_template_structure(self):
        document = template()
        self.assertEqual(set(document), {"variables", "config"})
        self.assertEqual(set(document["config"]), {"env", "domains", "mounts"})
        self.assertTrue(all(isinstance(line, str) for line in document["config"]["env"]))
        self.assertEqual(document["config"]["domains"], [{"serviceName": "silentsuite", "port": 8080, "host": "${main_domain}"}])
        self.assertEqual(document["variables"]["main_domain"], "${domain}")

    def test_logo_is_plain_svg(self):
        text = (BLUEPRINT / "silentsuite.svg").read_text(encoding="utf-8")
        self.assertTrue(text.lstrip().startswith("<svg"))
        for marker in ("<script", "href=", "onload", "<foreignObject"):
            self.assertNotIn(marker, text)


class Pins(unittest.TestCase):
    def test_every_image_is_digest_pinned(self):
        for name, service in compose()["services"].items():
            self.assertRegex(service["image"], DIGEST_IMAGE, name)

    def test_application_images_match_meta_version(self):
        services = compose()["services"]
        version = meta()["version"]
        self.assertEqual(services["silentsuite-web"]["image"].split("@")[0],
                         f"ghcr.io/silent-suite/silentsuite-web-selfhost:{version}")
        self.assertEqual(services["silentsuite-server"]["image"].split("@")[0],
                         f"ghcr.io/silent-suite/silentsuite-server:{version}")
        self.assertEqual(services["silentsuite-init"]["image"], services["silentsuite-server"]["image"])

    def test_infrastructure_images_follow_the_umbrel_package(self):
        umbrel = yaml.safe_load((ROOT / "self-host/umbrel/silentsuite/docker-compose.yml").read_text(encoding="utf-8"))
        services = compose()["services"]
        self.assertEqual(services["silentsuite"]["image"], umbrel["services"]["router"]["image"])
        self.assertEqual(services["silentsuite-postgres"]["image"], umbrel["services"]["postgres"]["image"])
        self.assertTrue(services["silentsuite-postgres"]["image"].startswith("postgres:16."))


class Secrets(unittest.TestCase):
    def test_variables_use_crypto_hash_helper(self):
        variables = template()["variables"]
        lengths = {"installation_password": 32, "registration_signing": 64, "db_password": 64}
        for name, length in lengths.items():
            match = re.fullmatch(r"\$\{hash:(\d+)\}", variables[name])
            self.assertIsNotNone(match, name)
            self.assertGreaterEqual(int(match.group(1)), length, name)
        self.assertEqual(set(variables), {"main_domain", *lengths})

    def test_env_maps_each_secret_to_its_own_variable(self):
        env = dict(line.split("=", 1) for line in template()["config"]["env"])
        self.assertEqual(env, {
            "SILENTSUITE_INSTALLATION_PASSWORD": "${installation_password}",
            "SILENTSUITE_REGISTRATION_SIGNING": "${registration_signing}",
            "SILENTSUITE_DB_PASSWORD": "${db_password}",
        })

    def test_compose_admits_secrets_only_when_set_and_non_empty(self):
        references = re.findall(r"\$\{([^}]*)\}", compose_text())
        self.assertTrue(references)
        for reference in references:
            name, separator, _ = reference.partition(":?")
            self.assertEqual(separator, ":?", reference)
            self.assertIn(name, SECRETS)
        server = compose()["services"]["silentsuite-server"]["environment"]
        self.assertTrue(server["ETEBASE_OWNER_PASSWORD"].startswith("${SILENTSUITE_INSTALLATION_PASSWORD:?"))
        self.assertTrue(server["ETEBASE_REGISTRATION_TOKEN"].startswith("${SILENTSUITE_REGISTRATION_SIGNING:?"))

    def test_server_keeps_the_umbrel_security_settings(self):
        server = compose()["services"]["silentsuite-server"]["environment"]
        self.assertEqual(server["ETEBASE_DISABLE_DJANGO_ADMIN"], "true")
        self.assertEqual(server["CORS_ALLOWED_ORIGINS"], "")
        self.assertEqual(server["ETEBASE_SECURE_SSL_REDIRECT"], "false")
        self.assertNotIn("TRUSTED_PROXY_IPS", server)
        self.assertNotIn("SUPER_PASS", server)


class Mounts(unittest.TestCase):
    def test_template_is_generated_from_the_umbrel_files(self):
        self.assertEqual((BLUEPRINT / "template.toml").read_text(encoding="utf-8"), render_module.build_template())

    def test_startup_wrapper_is_the_umbrel_wrapper(self):
        self.assertEqual(mounts()["/silentsuite/server-start.sh"],
                         (UMBREL_DATA / "bootstrap/server-start.sh").read_text(encoding="utf-8"))

    def test_only_names_change_in_router_and_init(self):
        router = mounts()["/silentsuite/router.conf"]
        self.assertEqual(sorted(set(re.findall(r"proxy_pass http://([^;]+);", router))),
                         ["silentsuite-server:3735", "silentsuite-web:3000"])
        self.assertIn("host = silentsuite-postgres\n", mounts()["/silentsuite/init.sh"])
        for content in mounts().values():
            self.assertNotRegex(content, r"silentsuite_[a-z]+_1")

    def test_no_dokploy_placeholder_in_mounts(self):
        variables = {"APP_NAME", *template()["variables"]}
        for path, content in mounts().items():
            for name in re.findall(r"\$\{([^}]+)\}", path + content):
                self.assertFalse(render_module.dokploy_name(name, variables), f"{path}: {name}")
            self.assertEqual(render_module.process_value(content, {"APP_NAME": "x", "db_password": "y"}, "h"), content)

    def test_mount_paths_match_compose_binds(self):
        binds = set()
        for service in compose()["services"].values():
            for volume in service.get("volumes", []):
                if volume.startswith("../files/"):
                    source, _, _ = volume.partition(":")
                    binds.add("/" + source.removeprefix("../files/"))
                    self.assertTrue(volume.endswith(":ro"), volume)
        self.assertEqual(binds, set(mounts()))

    def test_initializer_makes_no_network_calls(self):
        script = mounts()["/silentsuite/init.sh"]
        for tool in ("curl", "wget", "nc ", "python", "http", "apk ", "pip"):
            self.assertNotIn(tool, script)


class Rendering(unittest.TestCase):
    def render(self, *extra):
        directory = Path(tempfile.mkdtemp()) / "app"
        result = run_render("render", str(directory), *extra)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        return directory

    def test_render_matches_dokploy_layout(self):
        directory = self.render()
        env_file = directory / "code/.env"
        self.assertEqual(env_file.stat().st_mode & 0o777, 0o600)
        env = dict(line.split("=", 1) for line in env_file.read_text(encoding="utf-8").splitlines())
        self.assertEqual(env.pop("APP_NAME"), "silentsuite-ci")
        self.assertEqual(env.pop("COMPOSE_PROJECT_NAME"), "silentsuite-ci")
        self.assertEqual(set(env), set(SECRETS))
        self.assertEqual(len(set(env.values())), 3)
        for name, length in SECRETS.items():
            self.assertRegex(env[name], rf"^[0-9a-f]{{{length}}}$")
        for path, content in mounts().items():
            self.assertEqual((directory / "files" / path.lstrip("/")).read_text(encoding="utf-8"), content)
        rendered = yaml.safe_load((directory / "code/docker-compose.yml").read_text(encoding="utf-8"))
        self.assertEqual(rendered["services"]["silentsuite"]["networks"], ["default", "dokploy-network"])
        self.assertNotIn("networks", rendered["services"]["silentsuite-server"])

    def test_isolated_render_keeps_initializer_valid(self):
        directory = self.render("--isolated", "--isolated-volumes", "--app-name", "silentsuite-iso")
        rendered = yaml.safe_load((directory / "code/docker-compose.yml").read_text(encoding="utf-8"))
        for name, service in rendered["services"].items():
            self.assertEqual(service["networks"], ["silentsuite-iso"], name)
            self.assertNotIn("network_mode", service, name)
        self.assertEqual(set(rendered["volumes"]), {f"{name}-silentsuite-iso" for name in compose()["volumes"]})

    def test_missing_and_empty_secrets_render_without_values(self):
        for flag in ("--omit", "--empty"):
            directory = self.render(flag, "SILENTSUITE_INSTALLATION_PASSWORD")
            env = dict(line.split("=", 1) for line in (directory / "code/.env").read_text(encoding="utf-8").splitlines())
            self.assertEqual(env.get("SILENTSUITE_INSTALLATION_PASSWORD", ""), "")

    def test_carry_from_reuses_earlier_secrets(self):
        first = self.render()
        second = self.render("--carry-from", str(first / "code/.env"))
        self.assertEqual((first / "code/.env").read_text(), (second / "code/.env").read_text())

    def test_readme_recipes_are_fail_closed_scripts(self):
        readme = (ROOT / "self-host/dokploy/README.md").read_text(encoding="utf-8")
        recipes = re.findall(r"```sh\n# recipe: ([a-z-]+)\n(.*?)```", readme, re.S)
        self.assertEqual([name for name, _ in recipes], ["logical-backup", "logical-restore", "volume-backup", "volume-restore"])
        for name, body in recipes:
            lines = body.splitlines()
            self.assertTrue(lines[0].startswith("app=") and lines[1].startswith("backup=") and lines[2].startswith("code="), name)
            self.assertEqual(lines[3], "set -eu", name)
            self.assertNotRegex(body, r"-v [\"']?[a-z<$]*_silentsuite-", name)  # no typed volume names
            if name.endswith("backup"):
                self.assertIn('mkdir -m 700 "$backup"', body)
                self.assertIn("umask 077", body)
            else:
                guard = body.index("refusing")
                self.assertLess(guard, body.index("down --volumes"), name)

    def test_import_payload_is_the_template_site_format(self):
        result = run_render("import")
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(base64.b64decode(result.stdout.strip()))
        self.assertEqual(document, {
            "compose": compose_text(),
            "config": (BLUEPRINT / "template.toml").read_text(encoding="utf-8"),
        })


if __name__ == "__main__":
    unittest.main()
