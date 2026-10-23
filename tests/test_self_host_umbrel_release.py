"""Effective Umbrel stack contracts exercised without starting containers."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
PACKAGE = ROOT / "self-host" / "umbrel" / "silentsuite"
RENDERER = ROOT / "scripts" / "umbrel-candidate-effective-compose.py"
SOURCE_SHA = "a" * 40
WEB_IMAGE = f"127.0.0.1:5000/silentsuite-web:dev-{SOURCE_SHA}"
SERVER_IMAGE = f"127.0.0.1:5000/silentsuite-server:dev-{SOURCE_SHA}"
EXPECTED_IMAGES = {"web": WEB_IMAGE, "init": SERVER_IMAGE, "server": SERVER_IMAGE}
POISONED_IMAGES = {
    service: f"example.invalid/poison-{service}:old@sha256:{number * 64}"
    for service, number in (("web", "1"), ("init", "2"), ("server", "3"))
}


@pytest.fixture
def candidate(tmp_path):
    package = tmp_path / "candidate"
    shutil.copytree(PACKAGE, package, symlinks=True)
    # Referenced hostile inputs exist, so rejection cannot be a missing-file error.
    (package / "candidate.env").write_text("FIXTURE_ONLY=value\n", encoding="utf-8")
    (package / "compose-base.yml").write_text(
        "services:\n  web:\n    image: example.invalid/base:fixture\n",
        encoding="utf-8",
    )
    document = yaml.safe_load((package / "docker-compose.yml").read_text(encoding="utf-8"))
    return package, document


def render(candidate, mode="smoke"):
    package, document = candidate
    source = package / "docker-compose.yml"
    source.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
    original = source.read_bytes()
    destination = package.parent / "effective.yml"
    environment = {
        "PATH": os.environ.get("PATH", os.defpath),
        "APP_DATA_DIR": str(package),
        "APP_PASSWORD": "4" * 64,
        "APP_SILENTSUITE_REGISTRATION_SIGNING": "5" * 64,
        "APP_SILENTSUITE_DB_PASSWORD": "6" * 64,
        "APP_SILENTSUITE_WEB_IMAGE": WEB_IMAGE,
        "APP_SILENTSUITE_SERVER_IMAGE": SERVER_IMAGE,
    }
    # Exercise the explicit interface shared by smoke and archive producers.
    result = subprocess.run(
        [
            sys.executable, str(RENDERER), str(source), str(destination), "18080",
            "--web-image", WEB_IMAGE, "--server-image", SERVER_IMAGE,
            "--app-data-dir", str(package), "--mode", mode,
        ],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert "ModuleNotFoundError" not in result.stderr, result.stderr
    assert "ImportError" not in result.stderr, result.stderr
    assert "unrecognized arguments" not in result.stderr, result.stderr
    assert source.read_bytes() == original, "renderer modified the candidate package"
    return result, destination


def test_valid_canonical_package_preserves_the_smoke_stack(candidate):
    result, destination = render(candidate)
    assert result.returncode == 0, result.stderr
    services = yaml.safe_load(destination.read_text(encoding="utf-8"))["services"]
    assert set(services) == {"router", "web", "init", "server", "postgres"}
    assert services["router"]["ports"] == ["127.0.0.1:18080:8080"]
    assert all(
        service["container_name"] == f"silentsuite_{name}_1"
        for name, service in services.items()
    )
    assert all("ports" not in services[name] for name in services if name != "router")
    assert services["init"]["user"] == "0:0"
    assert services["init"]["network_mode"] == "none"
    assert services["init"]["restart"] == "no"
    assert services["server"]["volumes"] == candidate[1]["services"]["server"]["volumes"]
    assert services["postgres"]["image"] == candidate[1]["services"]["postgres"]["image"]


@pytest.mark.parametrize("literal_pins", [False, True], ids=["canonical", "poisoned-pins"])
@pytest.mark.parametrize("mode", ["smoke", "archive"])
def test_smoke_uses_exact_just_built_image_pair(candidate, literal_pins, mode):
    if literal_pins:
        for service, image in POISONED_IMAGES.items():
            candidate[1]["services"][service]["image"] = image
    result, destination = render(candidate, mode)
    assert result.returncode == 0, result.stderr
    services = yaml.safe_load(destination.read_text(encoding="utf-8"))["services"]
    actual = {service: services[service]["image"] for service in EXPECTED_IMAGES}
    assert actual == EXPECTED_IMAGES, (
        "smoke must use its supplied just-built images, never canonical selectors; "
        f"got {actual}"
    )
    assert services["init"]["image"] == services["server"]["image"]
    rendered = destination.read_text(encoding="utf-8")
    assert all(image not in rendered for image in POISONED_IMAGES.values())


@pytest.mark.parametrize(
    "service,patch",
    [
        pytest.param("server", {"volumes": ["/:/data:ro"]}, id="host-root-bind"),
        pytest.param(
            "server",
            {"volumes": ["/var/run/docker.sock:/var/run/docker.sock"]},
            id="docker-socket-bind",
        ),
        pytest.param(
            "server",
            {"volumes": [{"type": "bind", "source": "/run/docker.sock", "target": "/socket"}]},
            id="docker-socket-long-bind",
        ),
        pytest.param("web", {"privileged": True}, id="privileged"),
        pytest.param("web", {"network_mode": "host"}, id="host-network"),
        pytest.param("web", {"pid": "host"}, id="host-pid"),
        pytest.param("web", {"ipc": "host"}, id="host-ipc"),
        pytest.param("web", {"uts": "host"}, id="host-uts"),
        pytest.param("web", {"userns_mode": "host"}, id="host-userns"),
        pytest.param("web", {"env_file": ["candidate.env"]}, id="environment-file"),
        pytest.param("web", {"devices": ["/dev/kmsg:/dev/kmsg"]}, id="device"),
        pytest.param("web", {"cap_add": ["SYS_ADMIN"]}, id="added-capability"),
        pytest.param("web", {"build": {"context": "."}}, id="candidate-build"),
        pytest.param(
            "web",
            {"extends": {"file": "compose-base.yml", "service": "web"}},
            id="compose-extends",
        ),
        pytest.param(None, {"include": ["compose-base.yml"]}, id="compose-include"),
        pytest.param(
            None,
            {"networks": {"default": {"external": True, "name": "outside"}}},
            id="external-network",
        ),
    ],
)
@pytest.mark.parametrize("mode", ["smoke", "archive"])
def test_renderer_rejects_candidate_host_access(candidate, service, patch, mode):
    document = candidate[1]
    target = document if service is None else document["services"][service]
    target.update(patch)
    result, destination = render(candidate, mode)
    assert result.returncode != 0, f"unsafe Compose input was accepted: {patch}"
    assert not destination.exists(), "rejected input must not produce runnable Compose"


@pytest.mark.parametrize(
    "source",
    [
        "${APP_DATA_DIR}/data/../../outside",
        "${APP_DATA_DIR}/data/../private",
        "${APP_DATA_DIR}/data-other/server",
    ],
    ids=["parent-escape", "outside-data-root", "data-prefix-lookalike"],
)
@pytest.mark.parametrize("mode", ["smoke", "archive"])
def test_renderer_rejects_bind_path_escape(candidate, source, mode):
    package, document = candidate
    host_path = Path(source.replace("${APP_DATA_DIR}", str(package)))
    host_path.mkdir(parents=True, exist_ok=True)
    document["services"]["server"]["volumes"][0] = f"{source}:/data"
    result, destination = render(candidate, mode)
    assert result.returncode != 0, f"escaping bind source was accepted: {source}"
    assert not destination.exists()


@pytest.mark.parametrize("kind", ["directory", "bootstrap-file"])
@pytest.mark.parametrize("mode", ["smoke", "archive"])
def test_renderer_rejects_bind_source_symlink_escape(candidate, kind, mode):
    package, _ = candidate
    outside = package.parent / "outside"
    outside.mkdir()
    if kind == "directory":
        link = package / "data" / "server"
        shutil.rmtree(link)
        link.symlink_to(outside, target_is_directory=True)
    else:
        target = outside / "init.sh"
        target.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        link = package / "data" / "bootstrap" / "init.sh"
        link.unlink()
        link.symlink_to(target)
    result, destination = render(candidate, mode)
    assert result.returncode != 0, f"escaping {kind} symlink was accepted"
    assert not destination.exists()


def test_archive_preserves_umbrel_wiring_and_has_no_smoke_publication(candidate):
    result, destination = render(candidate, "archive")
    assert result.returncode == 0, result.stderr
    document = yaml.safe_load(destination.read_text(encoding="utf-8"))
    original = candidate[1]
    assert set(document["services"]) == set(original["services"])
    assert document["services"]["app_proxy"] == original["services"]["app_proxy"]
    for name, service in document["services"].items():
        assert "ports" not in service and "container_name" not in service
        if name not in EXPECTED_IMAGES:
            assert service == original["services"][name]


@pytest.mark.parametrize("mode", ["smoke", "archive"])
@pytest.mark.parametrize("service", ["web", "server", "init", "postgres"])
def test_renderer_rejects_extra_environment_interpolation(candidate, mode, service):
    candidate[1]["services"][service].setdefault("environment", {})["RUNNER_SECRET"] = "${GITHUB_TOKEN}"
    result, destination = render(candidate, mode)
    assert result.returncode != 0, "runner environment interpolation was accepted"
    assert not destination.exists()


def test_candidate_workflow_uses_native_images_and_shared_archive_renderer():
    document = yaml.load(
        (ROOT / ".github/workflows/ci-umbrel-candidate.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    assert document["permissions"] == {"contents": "read"}
    job = document["jobs"]["candidate"]
    assert {(entry["platform"], entry["runner"]) for entry in job["strategy"]["matrix"]["include"]} == {
        ("linux/amd64", "ubuntu-24.04"), ("linux/arm64", "ubuntu-24.04-arm"),
    }
    steps = {step["name"]: step for step in job["steps"]}
    for name in ("Build owner-enabled self-host web image", "Build server image"):
        settings = steps[name]["with"]
        assert settings["platforms"] == "${{ matrix.platform }}"
        assert settings["load"] == "true" and settings["push"] == "false"
    args = steps["Build owner-enabled self-host web image"]["with"]["build-args"].splitlines()
    for setting in (
        "NEXT_PUBLIC_SELF_HOSTED=true", "NEXT_PUBLIC_ETEBASE_SERVER_URL=",
        "NEXT_PUBLIC_OWNER_REGISTRATION=true", "NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED=false",
        "NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=false", "NEXT_PUBLIC_LOCAL_CACHE_ENABLED=false",
    ):
        assert setting in args
    assembly = steps["Assemble development package archive"]["run"]
    assert "umbrel-candidate-effective-compose.py" in assembly and "--mode archive" in assembly
    assert '--web-image "$WEB_IMAGE" --server-image "$SERVER_IMAGE"' in assembly
    assert "sed " not in assembly
    assert '"platform": env["PLATFORM"]' in assembly
    assert '"id": env["WEB_ID"]' in assembly and '"id": env["SERVER_ID"]' in assembly
    assert "sha256sum --check SHA256SUMS" in assembly
    upload = steps["Upload development candidate archive"]["with"]
    assert upload["name"].endswith("-${{ matrix.arch }}")
    assert upload["include-hidden-files"] == "true"
    assert "env -i" in steps["Effective-stack smoke test"]["run"]


@pytest.mark.parametrize("outcome", ["failure", "signal"])
def test_smoke_removes_credentials_and_cleans_only_its_fixture(tmp_path, outcome):
    runner = tmp_path / "runner"
    runner.mkdir()
    tools = tmp_path / "tools"
    tools.mkdir()
    caller_config = tmp_path / "caller-docker"
    caller_config.mkdir()
    credential = caller_config / "config.json"
    credential.write_text('{"auths":{"ghcr.io":{"auth":"fixture-canary"}}}', encoding="utf-8")
    log = tmp_path / "docker-calls.jsonl"

    def executable(name, body):
        path = tools / name
        path.write_text(f"#!{sys.executable}\n" + body, encoding="utf-8")
        path.chmod(0o755)

    # Replace external tools, not application modules; execute the real renderer.
    executable("python3.12", f"""
import os
from pathlib import Path
import sys
if sys.argv[1:3] == ["-m", "venv"]:
    binary = Path(sys.argv[3]) / "bin"
    binary.mkdir(parents=True)
    for name, body in (
        ("pip", "import sys\\nsys.exit(0)\\n"),
        ("python", "import os, sys\\nos.execv(" + repr({sys.executable!r}) + ", [" + repr({sys.executable!r}) + "] + sys.argv[1:])\\n"),
    ):
        path = binary / name
        path.write_text("#!" + {sys.executable!r} + "\\n" + body)
        path.chmod(0o755)
else:
    os.execv({sys.executable!r}, [{sys.executable!r}] + sys.argv[1:])
""")
    executable("sudo", f"""
from pathlib import Path
import shutil
import sys
assert sys.argv[1:4] == ["rm", "-rf", "--"]
target = Path(sys.argv[4])
assert target.parent == Path({str(runner)!r}) and target.name.startswith("umbrel-candidate.")
shutil.rmtree(target)
""")
    executable("docker", f"""
import json
import os
from pathlib import Path
import signal
import sys
args = sys.argv[1:]
config = Path(os.environ["DOCKER_CONFIG"])
with Path({str(log)!r}).open("a") as output:
    output.write(json.dumps({{
        "args": args,
        "credentials": [key for key in ("GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "AWS_SECRET_ACCESS_KEY") if key in os.environ],
        "config": str(config),
        "config_files": [path.name for path in config.iterdir()],
    }}) + "\\n")
if args[:2] == ["image", "inspect"]:
    template, reference = args[3], args[4]
    if ".Os" in template:
        print("linux/amd64")
    elif "revision" in template:
        print({SOURCE_SHA!r})
    else:
        print("sha256:" + ("a" if reference in ({WEB_IMAGE!r}, "sha256:" + "a" * 64) else "b") * 64)
elif args[0] == "compose" and "up" in args:
    if {outcome!r} == "signal":
        os.kill(os.getppid(), signal.SIGTERM)
    sys.exit(42)
""")
    result = subprocess.run(
        ["bash", str(ROOT / "scripts/umbrel-candidate-smoke.sh"), WEB_IMAGE, SERVER_IMAGE,
         "--platform", "linux/amd64", "--expect-revision", SOURCE_SHA],
        env={
            "PATH": str(tools) + os.pathsep + os.environ.get("PATH", os.defpath),
            "RUNNER_TEMP": str(runner),
            "DOCKER_CONFIG": str(caller_config),
            "GITHUB_TOKEN": "fixture-canary",
            "ACTIONS_RUNTIME_TOKEN": "fixture-canary",
            "AWS_SECRET_ACCESS_KEY": "fixture-canary",
        },
        capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == (42 if outcome == "failure" else 130), result.stderr
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    assert any("up" in call["args"] for call in calls), "fixture never reached container launch"
    assert any("down" in call["args"] for call in calls), "cleanup did not stop the owned project"
    assert all(not call["credentials"] and not call["config_files"] for call in calls)
    assert all(Path(call["config"]).is_relative_to(runner) for call in calls)
    assert not list(runner.iterdir()), "owned fixture was not removed"
    assert credential.read_text() == '{"auths":{"ghcr.io":{"auth":"fixture-canary"}}}'
    assert "fixture-canary" not in result.stdout + result.stderr


def paired_identity_fixture():
    from selfhost_release_contract import ReleaseIdentity, render_manifest
    from umbrel_release_contract import render
    tag = "v1.2.3"
    source = "a" * 40
    server = render_manifest(ReleaseIdentity(
        tag, source, "sha256:" + "1" * 64, "sha256:" + "2" * 64, "sha256:" + "3" * 64,
    ))
    text = render(tag, source, server, "sha256:" + "4" * 64, "sha256:" + "5" * 64, "sha256:" + "6" * 64)
    return tag, source, server, text


@pytest.mark.parametrize(
    "baseline,backend,proxy,valid",
    [
        (True, "privacy fixture warning retained accept reject", "failure", True),
        (True, "privacy fixture warning retained reject", "failure", False),
        (True, "privacy fixture warning retained accept", "failure", False),
        (True, "privacy fixture warning retained accept reject", "", False),
        (False, "privacy fixture warning retained", "", True),
        (False, "privacy fixture warning retained accept", "", False),
        (False, "privacy fixture warning retained", "failure", False),
        (False, "", "", False),
    ],
)
def test_privacy_canary_requires_real_witnesses_and_retained_safe_diagnostics(baseline, backend, proxy, valid):
    import importlib.util
    spec = importlib.util.spec_from_file_location("privacy_canary", ROOT / "scripts/umbrel-candidate-privacy.py")
    privacy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(privacy)
    if valid:
        privacy.check_logs(baseline, backend, proxy, ["accept", "reject", "failure"])
    else:
        with pytest.raises(RuntimeError):
            privacy.check_logs(baseline, backend, proxy, ["accept", "reject", "failure"])


def test_native_smoke_runs_privacy_canary_against_the_actual_image_pair():
    smoke = (ROOT / "scripts/umbrel-candidate-smoke.sh").read_text(encoding="utf-8")
    assert 'python3.12 "$root/scripts/umbrel-candidate-privacy.py"' in smoke
    assert '--server-image "$server_id" --router-image "$router_id"' in smoke
    assert '--startup "$work/data/bootstrap/server-start.sh"' in smoke
    assert '--router-config "$work/data/router/default.conf"' in smoke


def test_paired_identity_binds_server_native_images_and_build_arguments():
    from umbrel_release_contract import BUILD_ARGS, verify
    tag, source, server, text = paired_identity_fixture()
    document = verify(text, tag, source, server)
    assert document["sourceCommit"] == document["web"]["expectedRevision"] == source
    assert document["server"]["indexDigest"] == json.loads(server)["indexDigest"]
    assert document["platforms"] == ["linux/amd64", "linux/arm64"]
    assert document["buildArgs"] == BUILD_ARGS


@pytest.mark.parametrize("mutation", [
    "source", "platform", "server", "repository", "arguments", "children", "revision", "controller",
])
def test_paired_identity_rejects_mismatches(mutation):
    from selfhost_release_contract import ContractError
    from umbrel_release_contract import verify
    tag, source, server, text = paired_identity_fixture()
    document = json.loads(text)
    if mutation == "source":
        document["sourceCommit"] = "b" * 40
    elif mutation == "platform":
        document["platforms"] = ["linux/arm64", "linux/amd64"]
    elif mutation == "server":
        document["server"]["indexDigest"] = "sha256:" + "9" * 64
    elif mutation == "repository":
        document["web"]["imageRepository"] = "ghcr.io/silent-suite/silentsuite-web"
    elif mutation == "arguments":
        document["buildArgs"]["NEXT_PUBLIC_ETEBASE_SERVER_URL"] = "https://server.silentsuite.io"
    elif mutation == "children":
        document["web"]["arm64Digest"] = document["web"]["amd64Digest"]
    elif mutation == "revision":
        document["web"]["expectedRevision"] = "b" * 40
    else:
        document["controllerCommit"] = "b" * 40
    with pytest.raises(ContractError):
        verify(json.dumps(document), tag, source, server)


def test_redispatch_after_controller_advance_is_identical_and_never_clobbers(tmp_path, monkeypatch):
    from selfhost_release_contract import ContractError
    from umbrel_release_contract import render, write_or_verify
    tag, source, server, first = paired_identity_fixture()
    path = tmp_path / "umbrel-images.json"
    write_or_verify(path, first, write=True)
    before = path.stat()
    monkeypatch.setenv("GITHUB_SHA", "b" * 40)
    monkeypatch.setenv("GITHUB_RUN_ID", "987")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")
    repeated = render(tag, source, server, "sha256:" + "4" * 64, "sha256:" + "5" * 64, "sha256:" + "6" * 64)
    assert repeated == first
    write_or_verify(path, repeated, write=True)
    assert path.stat().st_mtime_ns == before.st_mtime_ns
    changed = render(tag, source, server, "sha256:" + "9" * 64, "sha256:" + "5" * 64, "sha256:" + "6" * 64)
    with pytest.raises(ContractError, match="different bytes"):
        write_or_verify(path, changed, write=True)
    assert path.read_bytes() == first.encode("utf-8")


@pytest.mark.parametrize("mutation", ["none", "logout", "credentials", "dependency", "owner-flag"])
def test_publication_boundary_rejects_credential_and_admission_drift(mutation):
    import importlib.util
    spec = importlib.util.spec_from_file_location("paired_boundary", ROOT / "scripts/check-android-signing-boundary.py")
    boundary = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(boundary)
    document = yaml.load((ROOT / ".github/workflows/release-server-image.yml").read_text(), Loader=yaml.BaseLoader)
    web = document["jobs"]["build-web"]
    named = {step["name"]: step for step in web["steps"]}
    smoke = named["Pull pair and smoke without registry credentials"]
    if mutation == "logout":
        smoke["run"] = smoke["run"].replace("\ndocker logout ghcr.io", "\ntrue")
    elif mutation == "credentials":
        smoke["env"]["GITHUB_TOKEN"] = "${{ secrets.GITHUB_TOKEN }}"
    elif mutation == "dependency":
        document["jobs"]["publish-index"]["needs"] = ["build"]
    elif mutation == "owner-flag":
        build = named["Build and push owner-enabled web by digest"]["with"]
        build["build-args"] = build["build-args"].replace("NEXT_PUBLIC_OWNER_REGISTRATION=true", "NEXT_PUBLIC_OWNER_REGISTRATION=false")
    violations = []
    boundary.check_umbrel_publication(document, violations)
    assert bool(violations) == (mutation != "none"), violations
