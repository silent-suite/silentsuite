#!/usr/bin/env python3
"""Fail closed when Android signing escapes the protected release job."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


SIGNING_SECRETS = {
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
}
ALLOWED_WORKFLOW = "build-android.yml"
ALLOWED_JOB = "build-release"
TAG_GUARD = "if: startsWith(github.ref, 'refs/tags/v')"
ENVIRONMENT_GUARD = "environment: android-release"
SHA_PIN = re.compile(r"^[0-9a-f]{40}$")
JOB_HEADER = re.compile(r"^  ([A-Za-z0-9_-]+):\s*$")
USES_LINE = re.compile(r"^\s*-?\s*uses:\s*([^\s#]+)")
SECRET_REFERENCE = re.compile(r"secrets\.([A-Z0-9_]+)")


def job_sections(workflow: str) -> dict[str, str]:
    """Return top-level job bodies from a GitHub Actions workflow."""
    lines = workflow.splitlines()
    try:
        jobs_index = next(i for i, line in enumerate(lines) if line == "jobs:")
    except StopIteration:
        return {}

    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in lines[jobs_index + 1 :]:
        if line and not line.startswith(" "):
            break
        match = JOB_HEADER.match(line)
        if match:
            current = match.group(1)
            sections[current] = [line]
        elif current is not None:
            sections[current].append(line)
    return {name: "\n".join(body) for name, body in sections.items()}


def signing_references(body: str) -> set[str]:
    return SIGNING_SECRETS & set(SECRET_REFERENCE.findall(body))


def action_ref(target: str) -> str | None:
    if target.startswith("./"):
        return None
    if "@" not in target:
        return ""
    return target.rsplit("@", 1)[1]


def check(root: Path) -> list[str]:
    workflow_dir = root / ".github" / "workflows"
    violations: list[str] = []
    allowed_path = workflow_dir / ALLOWED_WORKFLOW

    if not allowed_path.is_file():
        return [f"missing required workflow: {allowed_path}"]

    workflow_paths = sorted((*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")))
    for path in workflow_paths:
        body = path.read_text(encoding="utf-8")
        sections = job_sections(body)
        for job, section in sections.items():
            references = signing_references(section)
            if references and (path.name != ALLOWED_WORKFLOW or job != ALLOWED_JOB):
                violations.append(
                    f"{path.relative_to(root)} job {job} references Android signing secrets: "
                    f"{', '.join(sorted(references))}"
                )
            if (
                path.name == ALLOWED_WORKFLOW
                and "contents: write" in section
                and job != ALLOWED_JOB
            ):
                violations.append(
                    f"{path.relative_to(root)} job {job} has contents: write outside the Android release job"
                )

    allowed_body = allowed_path.read_text(encoding="utf-8")
    sections = job_sections(allowed_body)
    release = sections.get(ALLOWED_JOB)
    if release is None:
        violations.append(f"{allowed_path.relative_to(root)} is missing job {ALLOWED_JOB}")
        return violations

    missing = SIGNING_SECRETS - signing_references(release)
    if missing:
        violations.append(f"{ALLOWED_JOB} is missing signing references: {', '.join(sorted(missing))}")
    if TAG_GUARD not in release:
        violations.append(f"{ALLOWED_JOB} must use the exact version-tag guard")
    if ENVIRONMENT_GUARD not in release:
        violations.append(f"{ALLOWED_JOB} must bind the android-release environment")
    if "permissions:\n      contents: write" not in release:
        violations.append(f"{ALLOWED_JOB} must declare only the required contents: write permission")

    for line_number, line in enumerate(allowed_body.splitlines(), start=1):
        match = USES_LINE.match(line)
        if not match:
            continue
        target = match.group(1)
        ref = action_ref(target)
        if ref is not None and not SHA_PIN.fullmatch(ref):
            violations.append(
                f"{allowed_path.relative_to(root)}:{line_number} action must be pinned to a full commit SHA: {target}"
            )

    return violations


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()

    violations = check(args.root.resolve())
    if violations:
        print("Android signing boundary check failed:")
        for violation in violations:
            print(f"- {violation}")
        return 1

    print("Android signing boundary check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
