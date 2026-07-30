#!/usr/bin/env python3
"""Fail closed when Android signing escapes the protected release job."""

from __future__ import annotations

import argparse
import re
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import yaml
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode
from yaml.resolver import BaseResolver
from yaml.tokens import AliasToken, AnchorToken


SIGNING_SECRETS = {
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
}
ROOT_WORKFLOW = Path(".github/workflows/build-android.yml")
ANDROID_SIBLING_WORKFLOW = Path("android/.github/workflows/build.yml")
ALLOWED_JOB = "build-release"
POLICY_JOB = "signing-policy"
TAG_GUARD = "startsWith(github.ref, 'refs/tags/v')"
ENVIRONMENT_NAME = "android-release"
SHA_PIN = re.compile(r"^[0-9a-f]{40}$")
POLICY_COMMAND = re.compile(r"^\s*python(?:3)?\s+scripts/check-android-signing-boundary\.py\s*$")
UNSAFE_SECRET_EXPRESSION = re.compile(
    r"\bsecrets\s*\[|\btojson\s*\(\s*secrets\s*\)",
    re.IGNORECASE,
)
REQUIRED_TRIGGER_PATHS = {
    ".github/workflows/**",
    "android/.github/workflows/**",
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
        if any(isinstance(token, (AnchorToken, AliasToken)) for token in yaml.scan(text)):
            raise ValueError("YAML anchors and aliases are not allowed")
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
    body = "\n".join(strings(value))
    return {name for name in SIGNING_SECRETS if name in body}


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


def needs_job(value: Any, job_name: str) -> bool:
    if value == job_name:
        return True
    return (
        isinstance(value, Sequence)
        and not isinstance(value, (str, bytes))
        and job_name in value
    )


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


def trigger_paths(workflow: Mapping[str, Any], event: str) -> set[str]:
    events = workflow.get("on")
    if not isinstance(events, Mapping):
        return set()
    config = events.get(event)
    if not isinstance(config, Mapping):
        return set()
    paths = config.get("paths")
    if not isinstance(paths, Sequence) or isinstance(paths, (str, bytes)):
        return set()
    return {item for item in paths if isinstance(item, str)}


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
            if env == ENVIRONMENT_NAME and not is_allowed:
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

    top_permissions = root_workflow.get("permissions")
    if top_permissions is not None and not permissions_read_only(top_permissions):
        violations.append(f"{ROOT_WORKFLOW} must not grant dynamic or write permissions at workflow scope")

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

    if policy.get("permissions") != {"contents": "read"}:
        violations.append(f"{POLICY_JOB} permissions must be exactly contents: read")
    if "if" in policy:
        violations.append(f"{POLICY_JOB} must not be conditional")
    if "continue-on-error" in policy:
        violations.append(f"{POLICY_JOB} must not continue on error")
    policy_steps = policy.get("steps")
    if not isinstance(policy_steps, list):
        violations.append(f"{POLICY_JOB} steps must be a sequence")
    else:
        checker_steps = [
            step
            for step in policy_steps
            if isinstance(step, Mapping)
            and isinstance(step.get("run"), str)
            and POLICY_COMMAND.fullmatch(step["run"])
        ]
        if len(checker_steps) != 1:
            violations.append(f"{POLICY_JOB} must execute the exact signing-boundary checker command once")
        elif "if" in checker_steps[0] or "continue-on-error" in checker_steps[0]:
            violations.append(f"{POLICY_JOB} checker step must be unconditional and fail closed")

    missing_refs = SIGNING_SECRETS - signing_references(release)
    if missing_refs:
        violations.append(f"{ALLOWED_JOB} is missing signing references: {', '.join(sorted(missing_refs))}")
    if release.get("if") != TAG_GUARD:
        violations.append(f"{ALLOWED_JOB} must use the exact semantic version-tag guard")
    if not needs_job(release.get("needs"), POLICY_JOB):
        violations.append(f"{ALLOWED_JOB} must require successful {POLICY_JOB}")
    if environment_name(release) != ENVIRONMENT_NAME:
        violations.append(f"{ALLOWED_JOB} must bind the {ENVIRONMENT_NAME} environment")
    if "uses" in release:
        violations.append(f"{ALLOWED_JOB} must not delegate to a reusable workflow")

    if not isinstance(release.get("steps"), list):
        violations.append(f"{ALLOWED_JOB} steps must be a sequence")

    for event in ("push", "pull_request"):
        missing_paths = REQUIRED_TRIGGER_PATHS - trigger_paths(root_workflow, event)
        if missing_paths:
            violations.append(
                f"{ROOT_WORKFLOW} {event}.paths is missing: {', '.join(sorted(missing_paths))}"
            )

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
