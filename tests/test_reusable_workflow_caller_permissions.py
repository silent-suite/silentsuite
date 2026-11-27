"""Reusable-workflow caller/callee permission-subset contract.

GitHub evaluates a caller job's `permissions` against the permissions requested
by the jobs of the local reusable workflow it invokes. A callee job may never
request more than the caller job's token holds. When a caller job omits
`permissions` it inherits the repository default grant, which is read-only for
this repository, so any callee job that asks for `packages: write` or even
`actions: read` makes the whole run fail startup validation in seconds with
zero jobs created and no deployment attempted.

`actionlint` cannot catch this. It validates one workflow file at a time
against the workflow schema and expression grammar; a caller job without a
`permissions:` key is perfectly valid YAML and a perfectly valid workflow, and
actionlint does not resolve `uses: ./.github/workflows/*.yml` to the callee's
job-level permission requests. The mismatch only exists across two files, so it
is invisible to a per-file linter and only surfaces at dispatch time. This
contract closes that gap for every checked-in local reusable caller in the
repository.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_DIR = ROOT / ".github" / "workflows"

# GitHub permission levels, ordered. "none" satisfies nothing but itself.
LEVELS = {"none": 0, "read": 1, "write": 2}


def load(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def normalize(permissions) -> dict[str, str]:
    """Return an explicit scope->level map for a `permissions:` value."""
    if permissions is None:
        return {}
    if isinstance(permissions, str):
        if permissions in {"read-all", "write-all"}:
            return {"__all__": permissions.split("-")[0]}
        raise AssertionError(f"unsupported permissions shorthand: {permissions!r}")
    if not isinstance(permissions, dict):
        raise AssertionError(f"unsupported permissions value: {permissions!r}")
    return {str(scope): str(level) for scope, level in permissions.items()}


def granted(caller: dict[str, str], scope: str) -> str:
    if "__all__" in caller:
        return caller["__all__"]
    return caller.get(scope, "none")


def local_callee(job: dict) -> str | None:
    uses = job.get("uses")
    if isinstance(uses, str) and uses.startswith("./.github/workflows/"):
        return uses.split("@")[0]
    return None


class PermissionGraphError(Exception):
    """A reusable-workflow call graph that cannot be resolved, so it fails closed."""


def resolve(callee: str) -> Path:
    """Resolve a `./.github/workflows/...` reference against the current ROOT."""
    return ROOT / callee


def declared_permissions(job: dict, workflow_level: dict[str, str]) -> dict[str, str] | None:
    """The exact token a job receives, or None when it merely inherits the caller's.

    A job-level map wins; otherwise a workflow-level map applies to every job of
    the file. With neither, the job runs on whatever token the caller passes
    down, which is a pass-through rather than a ceiling of its own.
    """
    if "permissions" in job:
        return normalize(job["permissions"])
    if workflow_level:
        return dict(workflow_level)
    return None


def reusable_jobs(document: dict):
    """Yield `(job_name, job, callee_reference)` for every local reusable call."""
    for name, job in (document.get("jobs") or {}).items():
        if not isinstance(job, dict):
            continue
        callee = local_callee(job)
        if callee is not None:
            yield name, job, callee


def required_permissions(workflow_path: Path, seen: frozenset[str] = frozenset()) -> dict[str, str]:
    """The permissions this reusable workflow demands of the caller invoking it.

    A plain job demands its own explicit map, or the workflow-level map it
    inherits. A job that itself calls a nested local reusable workflow demands
    its own explicit/workflow-level map when it has one — that map, not the
    deeper requirement, is the exact token GitHub hands the nested workflow —
    and otherwise passes the nested requirement straight through. Whether an
    intermediate map actually covers what it forwards to is a separate ceiling
    check, in `violations`.
    """
    key = str(workflow_path)
    if key in seen:
        raise PermissionGraphError(f"reusable workflow call cycle at {workflow_path.name}")
    document = load(workflow_path)
    required: dict[str, str] = {}
    workflow_level = normalize(document.get("permissions"))
    for name, job in (document.get("jobs") or {}).items():
        if not isinstance(job, dict):
            continue
        declared = declared_permissions(job, workflow_level)
        nested = local_callee(job)
        if nested is not None and declared is None:
            nested_path = resolve(nested)
            if not nested_path.is_file():
                raise PermissionGraphError(
                    f"{workflow_path.name}:{name} calls missing workflow {nested}"
                )
            wanted = required_permissions(nested_path, seen | {key})
        else:
            wanted = declared or {}
        for scope, level in wanted.items():
            if LEVELS.get(level, 0) > LEVELS.get(required.get(scope, "none"), 0):
                required[scope] = level
    return required


def violations(
    workflow_path: Path,
    seen: frozenset[str] = frozenset(),
    trail: str = "",
) -> list[str]:
    """Fail-closed subset check for every reusable caller job, at every depth.

    Recursion is what makes this a ceiling check rather than a union check: an
    intermediate caller job with an explicit `permissions` map caps the token
    the workflows below it receive, so it is validated against its own callee's
    requirement exactly as the top-level job is, and reported with its full
    call path.
    """
    key = str(workflow_path)
    label = f"{trail}{workflow_path.name}"
    if key in seen:
        return [f"{label} closes a reusable workflow call cycle"]
    document = load(workflow_path)
    problems: list[str] = []
    workflow_level = normalize(document.get("permissions"))
    for name, job, callee in reusable_jobs(document):
        where = f"{label}:{name}"
        callee_path = resolve(callee)
        if not callee_path.is_file():
            problems.append(f"{where} calls missing workflow {callee}")
            continue
        caller = declared_permissions(job, workflow_level)
        if caller is None and not trail:
            problems.append(
                f"{where} calls {callee} without explicit caller permissions; "
                "it would inherit the read-only default token and fail startup validation"
            )
        elif caller is not None:
            try:
                needed = required_permissions(callee_path, seen | {key})
            except PermissionGraphError as error:
                problems.append(f"{where} -> {error}")
                needed = {}
            for scope, level in needed.items():
                if LEVELS.get(level, 0) > LEVELS.get(granted(caller, scope), 0):
                    problems.append(
                        f"{where} grants {scope}: {granted(caller, scope)} "
                        f"but {callee} requires {scope}: {level}"
                    )
        problems.extend(violations(callee_path, seen | {key}, trail=f"{where} -> "))
    # Preserve first-seen order while dropping repeats from diamond call graphs.
    return list(dict.fromkeys(problems))


def reusable_callers() -> list[Path]:
    candidates = {
        path
        for suffix in ("*.yml", "*.yaml")
        for path in WORKFLOW_DIR.glob(suffix)
    }
    return sorted(
        path
        for path in candidates
        if any(
            local_callee(job) is not None
            for job in (load(path).get("jobs") or {}).values()
            if isinstance(job, dict)
        )
    )


def test_repository_has_reusable_callers_to_validate() -> None:
    callers = {path.name for path in reusable_callers()}
    assert "release-controller.yml" in callers


@pytest.mark.parametrize("workflow", reusable_callers(), ids=lambda path: path.name)
def test_every_local_reusable_caller_job_grants_what_its_callee_requires(workflow: Path) -> None:
    assert violations(workflow) == []


# --- Sabotage controls: the checker must fail closed on synthetic mutations ---


def write_pair(tmp_path: Path, caller: str, callee: str, monkeypatch) -> Path:
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "callee.yml").write_text(callee, encoding="utf-8")
    caller_path = workflows / "caller.yml"
    caller_path.write_text(caller, encoding="utf-8")
    monkeypatch.setitem(globals(), "ROOT", tmp_path)
    return caller_path


CALLEE = """
on:
  workflow_call:
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - run: 'true'
"""


def caller_with(permissions: str) -> str:
    return f"""
on:
  workflow_dispatch:
jobs:
  deploy:
{permissions}    uses: ./.github/workflows/callee.yml
"""


@pytest.mark.parametrize(
    "permissions",
    [
        pytest.param("", id="permissions-removed"),
        pytest.param("    permissions:\n      contents: read\n", id="packages-scope-removed"),
        pytest.param(
            "    permissions:\n      contents: read\n      packages: read\n",
            id="packages-reduced-to-read",
        ),
        pytest.param(
            "    permissions:\n      contents: read\n      packages: none\n",
            id="packages-reduced-to-none",
        ),
        pytest.param("    permissions: read-all\n", id="read-all-is-not-enough"),
    ],
)
def test_checker_rejects_insufficient_caller_permissions(tmp_path, monkeypatch, permissions) -> None:
    caller = write_pair(tmp_path, caller_with(permissions), CALLEE, monkeypatch)
    problems = violations(caller)
    assert problems != []
    assert all("missing workflow" not in problem for problem in problems)
    assert any("packages" in problem or "explicit caller permissions" in problem for problem in problems)


def test_checker_accepts_the_exact_minimum_grant(tmp_path, monkeypatch) -> None:
    caller = write_pair(
        tmp_path,
        caller_with("    permissions:\n      contents: read\n      packages: write\n"),
        CALLEE,
        monkeypatch,
    )
    assert violations(caller) == []


def test_checker_follows_nested_reusable_calls(tmp_path, monkeypatch) -> None:
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "inner.yml").write_text(CALLEE, encoding="utf-8")
    (workflows / "callee.yml").write_text(
        """
on:
  workflow_call:
jobs:
  forward:
    uses: ./.github/workflows/inner.yml
""",
        encoding="utf-8",
    )
    caller = workflows / "caller.yml"
    caller.write_text(caller_with("    permissions:\n      contents: read\n"), encoding="utf-8")
    monkeypatch.setitem(globals(), "ROOT", tmp_path)
    problems = violations(caller)
    assert any("packages" in problem for problem in problems), problems


def test_checker_reports_a_missing_callee_instead_of_passing(tmp_path, monkeypatch) -> None:
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    caller = workflows / "caller.yml"
    caller.write_text(
        caller_with("    permissions:\n      contents: read\n      packages: write\n"),
        encoding="utf-8",
    )
    monkeypatch.setitem(globals(), "ROOT", tmp_path)
    assert violations(caller) != []


# --- Nested chains: every intermediate caller job has its own ceiling ---


def write_chain(tmp_path: Path, monkeypatch, caller: str, middle: str, inner: str) -> Path:
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "inner.yml").write_text(inner, encoding="utf-8")
    (workflows / "callee.yml").write_text(middle, encoding="utf-8")
    caller_path = workflows / "caller.yml"
    caller_path.write_text(caller, encoding="utf-8")
    monkeypatch.setitem(globals(), "ROOT", tmp_path)
    return caller_path


def middle_with(permissions: str) -> str:
    return f"""
on:
  workflow_call:
jobs:
  forward:
{permissions}    uses: ./.github/workflows/inner.yml
"""


def test_checker_rejects_an_intermediate_ceiling_below_the_deep_requirement(
    tmp_path, monkeypatch
) -> None:
    """packages: write -> packages: read -> packages: write must not pass.

    The top-level grant is sufficient, so a checker that only unions the deepest
    requirements sees no problem. GitHub does not: the intermediate reusable
    caller job's explicit map is the exact token the inner workflow receives, so
    the run still fails startup validation.
    """
    caller = write_chain(
        tmp_path,
        monkeypatch,
        caller_with("    permissions:\n      contents: read\n      packages: write\n"),
        middle_with("    permissions:\n      contents: read\n      packages: read\n"),
        CALLEE,
    )
    problems = violations(caller)
    assert problems != [], "intermediate ceiling below the inner requirement was accepted"
    assert any(
        "callee.yml:forward" in problem and "packages" in problem for problem in problems
    ), problems
    assert any("caller.yml:deploy" in problem for problem in problems), problems


def test_checker_rejects_an_intermediate_caller_without_explicit_permissions_under_a_map(
    tmp_path, monkeypatch
) -> None:
    caller = write_chain(
        tmp_path,
        monkeypatch,
        caller_with("    permissions:\n      contents: read\n      packages: write\n"),
        """
on:
  workflow_call:
permissions:
  contents: read
jobs:
  forward:
    uses: ./.github/workflows/inner.yml
""",
        CALLEE,
    )
    problems = violations(caller)
    assert any("callee.yml:forward" in problem and "packages" in problem for problem in problems), problems


def test_checker_accepts_a_fully_sufficient_nested_chain(tmp_path, monkeypatch) -> None:
    minimum = "    permissions:\n      contents: read\n      packages: write\n"
    caller = write_chain(
        tmp_path, monkeypatch, caller_with(minimum), middle_with(minimum), CALLEE
    )
    assert violations(caller) == []


def test_checker_fails_closed_on_a_reusable_call_cycle(tmp_path, monkeypatch) -> None:
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "callee.yml").write_text(
        """
on:
  workflow_call:
jobs:
  forward:
    uses: ./.github/workflows/inner.yml
""",
        encoding="utf-8",
    )
    (workflows / "inner.yml").write_text(
        """
on:
  workflow_call:
jobs:
  back:
    uses: ./.github/workflows/callee.yml
""",
        encoding="utf-8",
    )
    caller = workflows / "caller.yml"
    caller.write_text(
        caller_with("    permissions:\n      contents: read\n      packages: write\n"),
        encoding="utf-8",
    )
    monkeypatch.setitem(globals(), "ROOT", tmp_path)
    problems = violations(caller)
    assert any("cycle" in problem for problem in problems), problems


def test_checker_fails_closed_on_a_missing_nested_callee(tmp_path, monkeypatch) -> None:
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "callee.yml").write_text(
        """
on:
  workflow_call:
jobs:
  forward:
    uses: ./.github/workflows/absent.yml
""",
        encoding="utf-8",
    )
    caller = workflows / "caller.yml"
    caller.write_text(
        caller_with("    permissions:\n      contents: read\n      packages: write\n"),
        encoding="utf-8",
    )
    monkeypatch.setitem(globals(), "ROOT", tmp_path)
    problems = violations(caller)
    assert any("absent.yml" in problem for problem in problems), problems


# --- Discovery covers both YAML extensions, without duplicates ---


def test_discovery_covers_yaml_extension_callers(tmp_path, monkeypatch) -> None:
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "callee.yml").write_text(CALLEE, encoding="utf-8")
    (workflows / "caller.yaml").write_text(
        caller_with("    permissions:\n      contents: read\n      packages: write\n"),
        encoding="utf-8",
    )
    monkeypatch.setitem(globals(), "ROOT", tmp_path)
    monkeypatch.setitem(globals(), "WORKFLOW_DIR", workflows)
    discovered = reusable_callers()
    assert [path.name for path in discovered] == ["caller.yaml"]
    assert len(discovered) == len(set(discovered))


def test_discovery_of_the_real_workflow_directory_has_no_duplicates() -> None:
    discovered = reusable_callers()
    assert len(discovered) == len(set(discovered))


# --- The CI trigger must actually run this contract when it can regress ---


def workflow_triggers(document: dict) -> dict:
    # `yaml.safe_load` parses the bare key `on` as the boolean True.
    triggers = document.get("on", document.get(True))
    assert isinstance(triggers, dict), f"unexpected trigger form: {triggers!r}"
    return triggers


@pytest.mark.parametrize("event", ["push", "pull_request"])
def test_ci_runs_this_contract_whenever_any_workflow_or_the_test_changes(event: str) -> None:
    """Path-filter drift would silently stop enforcing the subset contract.

    Any checked-in workflow can become a local reusable caller or callee, so
    `.github/workflows/**` is the only truthful repository-wide guarantee.
    """
    triggers = workflow_triggers(load(WORKFLOW_DIR / "ci-server.yml"))
    paths = triggers[event]["paths"]
    assert ".github/workflows/**" in paths
    assert "tests/test_reusable_workflow_caller_permissions.py" in paths
    assert len(paths) == len(set(paths))
    assert not [
        path
        for path in paths
        if path.startswith(".github/workflows/") and path != ".github/workflows/**"
    ], "the wildcard already covers these; remove the redundant entries"


def test_ci_invokes_this_test_file_by_path() -> None:
    text = (WORKFLOW_DIR / "ci-server.yml").read_text(encoding="utf-8")
    assert "tests/test_reusable_workflow_caller_permissions.py" in text
