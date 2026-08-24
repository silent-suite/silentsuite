#!/usr/bin/env python3
"""Fail closed when Android signing escapes the protected release job."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import yaml
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode
from yaml.resolver import BaseResolver
from yaml.tokens import AliasToken, AnchorToken, TagToken


SIGNING_SECRETS = {
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
}
ROOT_WORKFLOW = Path(".github/workflows/build-android.yml")
ANDROID_SIBLING_WORKFLOW = Path("android/.github/workflows/build.yml")
CONSCRYPT_BUILD_SCRIPT = Path("android/scripts/build-conscrypt-android-r28.sh")
ALLOWED_JOB = "build-release"
POLICY_JOB = "signing-policy"
TAG_GUARD = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"
ENVIRONMENT_NAME = "android-release"
SHA_PIN = re.compile(r"^[0-9a-f]{40}$")
UNSAFE_SECRET_EXPRESSION = re.compile(
    r"\bsecrets\s*\[|\bsecrets\s*\.\s*\*|\btojson\s*\(\s*secrets\s*\)",
    re.IGNORECASE,
)
CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
SETUP_PYTHON_ACTION = "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97"
EXPECTED_POLICY_JOB: dict[str, Any] = {
    "name": "Enforce Android signing boundary",
    "runs-on": "ubuntu-latest",
    "permissions": {"contents": "read"},
    "steps": [
        {
            "name": "Set up Python",
            "uses": SETUP_PYTHON_ACTION,
            "with": {"python-version": "3.12"},
        },
        {
            "name": "Install signing policy dependency",
            "run": (
                "printf '%s\\n' 'PyYAML==6.0.3 "
                "--hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc' "
                '> "$RUNNER_TEMP/android-signing-policy-requirements.txt"\n'
                "python -m pip install --disable-pip-version-check --only-binary=:all: "
                '--require-hashes -r "$RUNNER_TEMP/android-signing-policy-requirements.txt"\n'
            ),
        },
        {
            "name": "Checkout policy source",
            "uses": CHECKOUT_ACTION,
            "with": {"clean": "true", "persist-credentials": "false"},
        },
        {
            "name": "Enforce Android signing boundary",
            "run": 'python "$GITHUB_WORKSPACE/scripts/check-android-signing-boundary.py"',
        },
    ],
}
EXPECTED_RELEASE_STEP_ENVIRONMENTS: dict[str, dict[str, str]] = {
    "Decode release keystore": {
        "KEYSTORE_BASE64": "${{ secrets.ANDROID_KEYSTORE_BASE64 }}",
    },
    "Build signed release APK and AAB": {
        "KSTOREPWD": "${{ secrets.ANDROID_KEYSTORE_PASSWORD }}",
        "KEY_ALIAS": "${{ secrets.ANDROID_KEY_ALIAS }}",
    },
    "Capture release dependency graph and generate signed-release splits": {
        "BUNDLETOOL_VERSION": "1.18.1",
        "BUNDLETOOL_SHA256": "675786493983787ffa11550bdb7c0715679a44e1643f3ff980a529e9c822595c",
        "KSTOREPWD": "${{ secrets.ANDROID_KEYSTORE_PASSWORD }}",
        "KEY_ALIAS": "${{ secrets.ANDROID_KEY_ALIAS }}",
    },
}
EXPECTED_SECRET_STEP_SHA256 = {
    "Decode release keystore": "44c1231395b5f7347980a05fa641b0e7d866451e10ddb88958e61459f649ffba",
    "Build signed release APK and AAB": "e9e02db295ff745dfe2ead024747b996b246ddb2fc2cc0f195ed2244b1a86776",
    "Capture release dependency graph and generate signed-release splits": (
        "69ded7eab4c4ff48deff2da950aacf8e627da05373ffa507f358fbcc986a7a6a"
    ),
}
EXPECTED_RELEASE_JOB_SHA256 = "e93b5f55523ad24dc208392f575a84b46e54576e5f2ab0921b61d68f13ff9a60"
EXPECTED_CONSCRYPT_JOB_SHA256 = "ed27963320252615ff159bbc388c858fdc872516fc0ea2aa5f50d905f4a5063b"
EXPECTED_CONSCRYPT_BUILD_SCRIPT_SHA256 = (
    "0ee234f2ced343c4167bd1efad134a77853f288eb9c5210c1e1173594a014b8b"
)
ALLOWED_RELEASE_JOB_KEYS = {
    "name",
    "needs",
    "if",
    "runs-on",
    "environment",
    "permissions",
    "defaults",
    "steps",
}
ALLOWED_RELEASE_STEP_KEYS = {"name", "uses", "with", "run", "env", "if"}
REQUIRED_TRIGGER_PATHS = {
    ".github/workflows/**",
    "android/.github/workflows/**",
    "runbooks/android-release.md",
    "scripts/check-android-signing-boundary.py",
    "tests/test_android_*.py",
}


class StrictBaseLoader(yaml.BaseLoader):
    """BaseLoader with parser-differential features rejected."""


def construct_unique_mapping(
    loader: StrictBaseLoader,
    node: MappingNode,
    deep: bool = False,
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in mapping
        except TypeError as exc:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                "found an unhashable key",
                key_node.start_mark,
            ) from exc
        if duplicate:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"found duplicate key {key!r}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


StrictBaseLoader.add_constructor(BaseResolver.DEFAULT_MAPPING_TAG, construct_unique_mapping)


def load_workflow(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
        if any(isinstance(token, (AnchorToken, AliasToken, TagToken)) for token in yaml.scan(text)):
            raise ValueError("YAML anchors, aliases, and explicit tags are not allowed")
        parsed = yaml.load(text, Loader=StrictBaseLoader)
    except ValueError:
        raise
    except yaml.YAMLError as exc:
        raise ValueError(f"invalid YAML: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("workflow root must be a mapping")
    return parsed


def walk(value: Any) -> Iterator[Any]:
    yield value
    if isinstance(value, Mapping):
        for key, item in value.items():
            yield from walk(key)
            yield from walk(item)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for item in value:
            yield from walk(item)


def strings(value: Any) -> Iterator[str]:
    for item in walk(value):
        if isinstance(item, str):
            yield item


def signing_references(value: Any) -> set[str]:
    body = "\n".join(strings(value)).casefold()
    return {name for name in SIGNING_SECRETS if name.casefold() in body}


def contains_unsafe_secret_expression(value: Any) -> bool:
    return any(UNSAFE_SECRET_EXPRESSION.search(item) for item in strings(value))


def contains_secret_inheritance(value: Any) -> bool:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key == "secrets" and item == "inherit":
                return True
            if contains_secret_inheritance(item):
                return True
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return any(contains_secret_inheritance(item) for item in value)
    return False


def environment_name(job: Mapping[str, Any]) -> str | None:
    value = job.get("environment")
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        name = value.get("name")
        return name if isinstance(name, str) else None
    return None


def permissions_read_only(value: Any) -> bool:
    if value == "read-all":
        return True
    return isinstance(value, Mapping) and all(level in {"read", "none"} for level in value.values())


def semantic_sha256(value: Any) -> str:
    payload = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def action_uses(value: Any) -> Iterator[str]:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key == "uses" and isinstance(item, str):
                yield item
            yield from action_uses(item)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for item in value:
            yield from action_uses(item)


def unpinned_action(target: str) -> bool:
    if target.startswith("./"):
        return False
    if "@" not in target:
        return True
    return not SHA_PIN.fullmatch(target.rsplit("@", 1)[1])


def as_mapping(value: Any, label: str, violations: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        violations.append(f"{label} must be a mapping")
        return {}
    return value


def trigger_paths(workflow: Mapping[str, Any], event: str) -> list[str]:
    events = workflow.get("on")
    if not isinstance(events, Mapping):
        return []
    config = events.get(event)
    if not isinstance(config, Mapping):
        return []
    paths = config.get("paths")
    if not isinstance(paths, Sequence) or isinstance(paths, (str, bytes)):
        return []
    return [item for item in paths if isinstance(item, str)]


def check(root: Path) -> list[str]:
    workflow_dir = root / ".github" / "workflows"
    violations: list[str] = []
    root_path = root / ROOT_WORKFLOW
    sibling_path = root / ANDROID_SIBLING_WORKFLOW

    if not root_path.is_file():
        return [f"missing required workflow: {ROOT_WORKFLOW}"]
    if not sibling_path.is_file():
        return [f"missing Android sibling workflow: {ANDROID_SIBLING_WORKFLOW}"]

    loaded: dict[Path, dict[str, Any]] = {}
    workflow_paths = sorted((*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")))
    for path in workflow_paths:
        relative = path.relative_to(root)
        try:
            workflow = load_workflow(path)
        except ValueError as exc:
            violations.append(f"{relative}: {exc}")
            continue
        loaded[relative] = workflow
        jobs = as_mapping(workflow.get("jobs"), f"{relative} jobs", violations)
        workflow_scope = {key: value for key, value in workflow.items() if key != "jobs"}

        scope_refs = signing_references(workflow_scope)
        if scope_refs:
            violations.append(
                f"{relative} references Android signing secrets outside a job: "
                f"{', '.join(sorted(scope_refs))}"
            )

        if contains_secret_inheritance(workflow):
            violations.append(f"{relative} must not use reusable-workflow secrets: inherit")
        if contains_unsafe_secret_expression(workflow):
            violations.append(f"{relative} must not use dynamic or whole-context secret expressions")

        for job_name, raw_job in jobs.items():
            if not isinstance(raw_job, Mapping):
                violations.append(f"{relative} job {job_name} must be a mapping")
                continue
            refs = signing_references(raw_job)
            env = environment_name(raw_job)
            is_allowed = relative == ROOT_WORKFLOW and job_name == ALLOWED_JOB
            if refs and not is_allowed:
                violations.append(
                    f"{relative} job {job_name} references Android signing secrets: "
                    f"{', '.join(sorted(refs))}"
                )
            if env and env.casefold() == ENVIRONMENT_NAME.casefold() and not is_allowed:
                violations.append(f"{relative} job {job_name} binds {ENVIRONMENT_NAME} outside {ALLOWED_JOB}")
            if env and "${{" in env and not is_allowed:
                violations.append(f"{relative} job {job_name} uses a dynamic environment outside {ALLOWED_JOB}")

    root_workflow = loaded.get(ROOT_WORKFLOW)
    if root_workflow is None:
        return violations
    jobs = as_mapping(root_workflow.get("jobs"), f"{ROOT_WORKFLOW} jobs", violations)
    policy = jobs.get(POLICY_JOB)
    if not isinstance(policy, Mapping):
        violations.append(f"{ROOT_WORKFLOW} is missing mapping job {POLICY_JOB}")
        return violations
    release = jobs.get(ALLOWED_JOB)
    if not isinstance(release, Mapping):
        violations.append(f"{ROOT_WORKFLOW} is missing mapping job {ALLOWED_JOB}")
        return violations
    conscrypt_job = jobs.get("conscrypt-r28")
    if not isinstance(conscrypt_job, Mapping):
        violations.append(f"{ROOT_WORKFLOW} is missing mapping job conscrypt-r28")
    elif semantic_sha256(conscrypt_job) != EXPECTED_CONSCRYPT_JOB_SHA256:
        violations.append("conscrypt-r28 must match the exact reviewed producer specification")

    conscrypt_script = root / CONSCRYPT_BUILD_SCRIPT
    if not conscrypt_script.is_file():
        violations.append(f"{CONSCRYPT_BUILD_SCRIPT} is missing")
    elif hashlib.sha256(conscrypt_script.read_bytes()).hexdigest() != EXPECTED_CONSCRYPT_BUILD_SCRIPT_SHA256:
        violations.append(f"{CONSCRYPT_BUILD_SCRIPT} must match its exact reviewed digest")

    top_permissions = root_workflow.get("permissions")
    if top_permissions is not None and not permissions_read_only(top_permissions):
        violations.append(f"{ROOT_WORKFLOW} must not grant dynamic or write permissions at workflow scope")
    for inherited_key in ("defaults", "env"):
        if inherited_key in root_workflow:
            violations.append(
                f"{ROOT_WORKFLOW} must not define workflow-level {inherited_key} that can alter {POLICY_JOB}"
            )

    for job_name, raw_job in jobs.items():
        if not isinstance(raw_job, Mapping):
            continue
        permissions = raw_job.get("permissions")
        if job_name == ALLOWED_JOB:
            if permissions != {"contents": "write"}:
                violations.append(f"{ALLOWED_JOB} permissions must be exactly contents: write")
        elif permissions is None:
            violations.append(f"{ROOT_WORKFLOW} job {job_name} must declare explicit read-only permissions")
        elif not permissions_read_only(permissions):
            violations.append(
                f"{ROOT_WORKFLOW} job {job_name} has dynamic or write permissions outside {ALLOWED_JOB}"
            )

    if policy != EXPECTED_POLICY_JOB:
        violations.append(f"{POLICY_JOB} must match the exact fail-closed job specification")

    missing_refs = SIGNING_SECRETS - signing_references(release)
    if missing_refs:
        violations.append(f"{ALLOWED_JOB} is missing signing references: {', '.join(sorted(missing_refs))}")
    if release.get("if") != TAG_GUARD:
        violations.append(f"{ALLOWED_JOB} must use the exact push-triggered version-tag guard")
    if release.get("needs") != [POLICY_JOB, "conscrypt-r28"]:
        violations.append(
            f"{ALLOWED_JOB} must require successful {POLICY_JOB} and conscrypt-r28"
        )
    if release.get("environment") != ENVIRONMENT_NAME:
        violations.append(f"{ALLOWED_JOB} must bind the {ENVIRONMENT_NAME} environment")
    if release.get("runs-on") != "ubuntu-latest":
        violations.append(f"{ALLOWED_JOB} must run exactly on GitHub-hosted ubuntu-latest")
    if release.get("defaults") != {"run": {"working-directory": "android"}}:
        violations.append(f"{ALLOWED_JOB} must use the exact Android working-directory defaults")
    if semantic_sha256(release) != EXPECTED_RELEASE_JOB_SHA256:
        violations.append(f"{ALLOWED_JOB} must match the exact reviewed release-job specification")
    for forbidden_key in ("container", "services", "strategy", "env", "continue-on-error"):
        if forbidden_key in release:
            violations.append(f"{ALLOWED_JOB} must not define job-level {forbidden_key}")
    unexpected_job_keys = set(release) - ALLOWED_RELEASE_JOB_KEYS
    if unexpected_job_keys:
        violations.append(
            f"{ALLOWED_JOB} has unreviewed job keys: {', '.join(sorted(unexpected_job_keys))}"
        )
    if "uses" in release:
        violations.append(f"{ALLOWED_JOB} must not delegate to a reusable workflow")
    if any(target.startswith("./") for target in action_uses(release)):
        violations.append(f"{ALLOWED_JOB} must not invoke local actions")

    release_steps = release.get("steps")
    if not isinstance(release_steps, list):
        violations.append(f"{ALLOWED_JOB} steps must be a sequence")
    else:
        for step in release_steps:
            if not isinstance(step, Mapping):
                violations.append(f"{ALLOWED_JOB} steps must contain only mappings")
                continue
            step_name = step.get("name")
            unexpected_step_keys = set(step) - ALLOWED_RELEASE_STEP_KEYS
            if unexpected_step_keys:
                violations.append(
                    f"{ALLOWED_JOB} step {step_name!r} has unreviewed keys: "
                    f"{', '.join(sorted(unexpected_step_keys))}"
                )
            if ("run" in step) == ("uses" in step):
                violations.append(
                    f"{ALLOWED_JOB} step {step_name!r} must define exactly one of run or uses"
                )
            for forbidden_key in ("shell", "working-directory", "continue-on-error"):
                if forbidden_key in step:
                    violations.append(
                        f"{ALLOWED_JOB} step {step_name!r} must not define {forbidden_key}"
                    )
            if "env" in step:
                expected_env = EXPECTED_RELEASE_STEP_ENVIRONMENTS.get(str(step_name))
                if step.get("env") != expected_env:
                    violations.append(
                        f"{ALLOWED_JOB} step {step_name!r} must use its exact reviewed environment"
                    )
        for step_name, expected_env in EXPECTED_RELEASE_STEP_ENVIRONMENTS.items():
            matching_steps = [
                step
                for step in release_steps
                if isinstance(step, Mapping) and step.get("name") == step_name
            ]
            if len(matching_steps) != 1 or matching_steps[0].get("env") != expected_env:
                violations.append(
                    f"{ALLOWED_JOB} must contain exactly one {step_name!r} step with reviewed environment"
                )
            elif semantic_sha256(matching_steps[0]) != EXPECTED_SECRET_STEP_SHA256[step_name]:
                violations.append(
                    f"{ALLOWED_JOB} step {step_name!r} must match its exact reviewed execution"
                )
        release_without_step_env = dict(release)
        release_without_step_env["steps"] = [
            {key: value for key, value in step.items() if key != "env"}
            if isinstance(step, Mapping)
            else step
            for step in release_steps
        ]
        refs_outside_reviewed_env = signing_references(release_without_step_env)
        if refs_outside_reviewed_env:
            violations.append(
                f"{ALLOWED_JOB} references signing secrets outside reviewed step environments: "
                f"{', '.join(sorted(refs_outside_reviewed_env))}"
            )

    for event in ("push", "pull_request"):
        paths = trigger_paths(root_workflow, event)
        missing_paths = REQUIRED_TRIGGER_PATHS - set(paths)
        if missing_paths:
            violations.append(
                f"{ROOT_WORKFLOW} {event}.paths is missing: {', '.join(sorted(missing_paths))}"
            )
        if any(path.startswith("!") for path in paths):
            violations.append(f"{ROOT_WORKFLOW} {event}.paths must not contain negative patterns")

    for relative in (ROOT_WORKFLOW, ANDROID_SIBLING_WORKFLOW):
        path = root / relative
        try:
            workflow = load_workflow(path)
        except ValueError:
            continue
        for target in action_uses(workflow):
            if unpinned_action(target):
                violations.append(f"{relative} action must be pinned to a full commit SHA: {target}")

    return violations


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()

    violations = check(args.root.resolve())
    if violations:
        print("Android signing boundary check failed:")
        for violation in sorted(set(violations)):
            print(f"- {violation}")
        return 1

    print("Android signing boundary check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
