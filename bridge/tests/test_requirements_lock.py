"""requirements-lock.txt must stay in step with pyproject.toml.

Release builds install the bridge's dependencies only from requirements-lock.txt
(--require-hashes) and then the bridge itself with --no-deps, so a dependency
added to or changed in pyproject.toml without regenerating the lock would never
reach the release binary. These checks fail when the two drift apart.

To regenerate, run the uv command recorded at the top of requirements-lock.txt
from the bridge/ directory.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = BRIDGE_ROOT / "pyproject.toml"
LOCK = BRIDGE_ROOT / "requirements-lock.txt"
LOCK_INPUTS = BRIDGE_ROOT / "requirements-lock.in"
LOCK_OVERRIDES = BRIDGE_ROOT / "requirements-lock-overrides.txt"
ETEBASE_BUILD_LOCK = BRIDGE_ROOT / "requirements-etebase-build.txt"
ETEBASE_BUILD_INPUTS = BRIDGE_ROOT / "requirements-etebase-build.in"
# build-system.requires of etebase-py at the pinned commit c5afd1a546b8f030d1b97bcecfc5e8bf9799827b.
ETEBASE_BUILD_SYSTEM = {"setuptools", "wheel", "setuptools-rust"}
ETEBASE_BUILD_COMMAND = (
    "uv pip compile requirements-etebase-build.in --python-platform aarch64-apple-darwin "
    "--python-version 3.10 --only-binary :all: --generate-hashes -o requirements-etebase-build.txt"
)

PYPROJECT_SOURCE = "silentsuite-bridge (pyproject.toml)"
INPUTS_SOURCE = "-r requirements-lock.in"
COMPILE_COMMAND = (
    "uv pip compile pyproject.toml requirements-lock.in --extra dev --extra tray "
    "--overrides requirements-lock-overrides.txt --universal --python-version 3.10 "
    "--only-binary :all: --generate-hashes -o requirements-lock.txt"
)

# The five release lanes in .github/workflows/build-bridge.yml, all CPython 3.10.
RELEASE_LANES = {
    "linux-x86_64": {"sys_platform": "linux", "platform_system": "Linux", "platform_machine": "x86_64"},
    "linux-arm64": {"sys_platform": "linux", "platform_system": "Linux", "platform_machine": "aarch64"},
    "macos-x86_64": {"sys_platform": "darwin", "platform_system": "Darwin", "platform_machine": "x86_64"},
    "macos-arm64": {"sys_platform": "darwin", "platform_system": "Darwin", "platform_machine": "arm64"},
    "windows-x86_64": {"sys_platform": "win32", "platform_system": "Windows", "platform_machine": "AMD64"},
}


def lane_environment(lane: str) -> dict[str, str]:
    environment = default_environment()
    environment.update(
        {
            "implementation_name": "cpython",
            "platform_python_implementation": "CPython",
            "python_version": "3.10",
            "python_full_version": "3.10.11",
            "os_name": "nt" if lane.startswith("windows") else "posix",
        }
    )
    environment.update(RELEASE_LANES[lane])
    return environment


def parse_lock(path: Path = LOCK) -> list[dict]:
    """Return one entry per pinned line: name, version, marker, hashes, via sources."""
    entries: list[dict] = []
    current: dict | None = None
    in_via = False
    for raw in path.read_text(encoding="utf-8").replace("\\\n", " ").splitlines():
        line = raw.strip()
        if not line:
            continue
        if not raw.startswith((" ", "#")):
            requirement, _, options = line.partition("--hash=")
            requirement = Requirement(requirement.strip())
            (specifier,) = requirement.specifier
            assert specifier.operator == "==", line
            current = {
                "name": canonicalize_name(requirement.name),
                "version": specifier.version,
                "marker": requirement.marker,
                "hashes": ("--hash=" + options).split() if options else [],
                "via": set(),
            }
            entries.append(current)
            in_via = False
        elif current is not None and line.startswith("# via"):
            source = line[len("# via") :].strip()
            if source:
                current["via"].add(source)
                in_via = False
            else:
                in_via = True
        elif current is not None and in_via and line.startswith("#   "):
            current["via"].add(line[len("#   ") :].strip())
    return entries


def pyproject() -> dict:
    return tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))


def declared_inputs(data: dict) -> list[tuple[str, Requirement]]:
    """Every pyproject.toml requirement the lock is compiled from, with its section."""
    project = data["project"]
    declared = [("project", Requirement(item)) for item in project["dependencies"]]
    for extra in ("tray", "dev"):
        declared += [(f"extra {extra}", Requirement(item)) for item in project["optional-dependencies"][extra]]
    declared += [("build-system", Requirement(item)) for item in data["build-system"]["requires"]]
    return declared


def recorded_inputs() -> list[tuple[str, Requirement]]:
    """The "# compiled-from <section>: <requirement>" record in requirements-lock.in."""
    recorded = []
    for line in LOCK_INPUTS.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"# compiled-from ([a-z -]+): (.+)", line.strip())
        if match:
            recorded.append((match.group(1), Requirement(match.group(2))))
    return recorded


def requirement_lines(path: Path) -> list[Requirement]:
    return [
        Requirement(line.split("#", 1)[0].strip())
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.split("#", 1)[0].strip()
    ]


def same_requirements(left: list[tuple[str, Requirement]], right: list[tuple[str, Requirement]]) -> bool:
    # packaging compares Requirement objects by name, extras, specifier, URL and marker.
    unmatched = list(right)
    for item in left:
        if item not in unmatched:
            return False
        unmatched.remove(item)
    return not unmatched


def drift_problems(data: dict) -> list[str]:
    """Ways the lock no longer matches the given pyproject.toml contents."""
    problems = []
    entries = parse_lock()
    declared = declared_inputs(data)
    if not same_requirements(declared, recorded_inputs()):
        problems.append(
            "pyproject.toml no longer matches the requirements the lock was compiled from; "
            "regenerate requirements-lock.txt and update the compiled-from list in requirements-lock.in"
        )

    for section, requirement in declared:
        name = canonicalize_name(requirement.name)
        pins = [entry for entry in entries if entry["name"] == name]
        if not pins:
            problems.append(f"{section}: {requirement} has no pin in the lock")
        for pin in pins:
            if not requirement.specifier.contains(pin["version"], prereleases=True):
                problems.append(f"{section}: locked {name}=={pin['version']} does not satisfy {requirement}")

    direct = {canonicalize_name(r.name) for section, r in declared if section != "build-system"}
    locked_direct = {entry["name"] for entry in entries if PYPROJECT_SOURCE in entry["via"]}
    if locked_direct != direct:
        problems.append(f"lock direct dependencies {sorted(locked_direct)} != pyproject {sorted(direct)}")

    # The build backend goes into the lock through requirements-lock.in, exactly as declared.
    lock_inputs = requirement_lines(LOCK_INPUTS)
    for section, requirement in declared:
        if section == "build-system" and requirement not in lock_inputs:
            problems.append(f"build-system requirement {requirement} is not in requirements-lock.in as declared")

    # The etebase override may only add the macOS arm64 exclusion.
    (override,) = requirement_lines(LOCK_OVERRIDES)
    etebase = [r for section, r in declared if section == "project" and canonicalize_name(r.name) == "etebase"]
    if len(etebase) != 1:
        problems.append("pyproject.toml must declare etebase exactly once")
    else:
        (etebase,) = etebase
        if (
            canonicalize_name(override.name) != "etebase"
            or override.extras != etebase.extras
            or override.specifier != etebase.specifier
            or override.url != etebase.url
            or etebase.marker is not None
        ):
            problems.append(f"requirements-lock-overrides.txt {override} does not keep pyproject's {etebase}")
    return problems


def test_lock_header_records_the_compile_command():
    assert COMPILE_COMMAND in LOCK.read_text(encoding="utf-8").splitlines()[1]


def test_every_locked_package_is_pinned_with_sha256_hashes():
    entries = parse_lock()
    assert entries
    for entry in entries:
        assert entry["hashes"], entry["name"]
        for item in entry["hashes"]:
            assert re.fullmatch(r"--hash=sha256:[0-9a-f]{64}", item), (entry["name"], item)


def test_lock_matches_pyproject():
    assert drift_problems(pyproject()) == []


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ('"requests>=2.28.0"', '"requests[socks]>=2.28.0"'),
        ('requires = ["hatchling"]', 'requires = ["hatchling>=2"]'),
        ('"requests>=2.28.0",', '"requests>=2.28.0",\n    "click>=8",'),
        ('"radicale==3.2.3"', '"radicale==3.2.4"'),
        ('"etebase>=0.31.5,<0.32"', '"etebase>=0.31.6,<0.32"'),
        ('"ruff>=0.1.0",', ""),
        ('"pytest>=7.0"', "\"pytest>=7.0 ; sys_platform == 'linux'\""),
    ],
)
def test_drift_check_catches_pyproject_changes(old, new):
    text = PYPROJECT.read_text(encoding="utf-8")
    assert text.count(old) == 1
    assert drift_problems(tomllib.loads(text.replace(old, new)))


def test_lock_inputs_match_the_lock():
    inputs = {canonicalize_name(requirement.name) for requirement in requirement_lines(LOCK_INPUTS)}
    locked_inputs = {entry["name"] for entry in parse_lock() if INPUTS_SOURCE in entry["via"]}
    assert locked_inputs == inputs


def test_each_release_lane_gets_exactly_one_pin_per_applicable_requirement():
    entries = parse_lock()
    required = [r for section, r in declared_inputs(pyproject())] + requirement_lines(LOCK_INPUTS)
    for lane in RELEASE_LANES:
        environment = lane_environment(lane)
        selected = [
            entry["name"] for entry in entries if entry["marker"] is None or entry["marker"].evaluate(environment)
        ]
        assert len(selected) == len(set(selected)), lane
        for requirement in required:
            name = canonicalize_name(requirement.name)
            if requirement.marker is not None and not requirement.marker.evaluate({**environment, "extra": ""}):
                continue
            if lane == "macos-arm64" and name == "etebase":
                # Built from a pinned upstream commit on this lane instead.
                assert name not in selected
                continue
            assert name in selected, (lane, name)
        # The etebase build tools, and the newer setuptools they need, live in their
        # own lock and never reach the environment PyInstaller bundles.
        assert not ETEBASE_BUILD_SYSTEM & set(selected), lane


def test_etebase_build_lock_holds_exactly_the_pinned_commit_build_requirements():
    assert ETEBASE_BUILD_COMMAND in ETEBASE_BUILD_LOCK.read_text(encoding="utf-8").splitlines()[1]
    inputs = {canonicalize_name(r.name) for r in requirement_lines(ETEBASE_BUILD_INPUTS)}
    assert inputs == ETEBASE_BUILD_SYSTEM
    entries = parse_lock(ETEBASE_BUILD_LOCK)
    assert {e["name"] for e in entries if "-r requirements-etebase-build.in" in e["via"]} == inputs
    for entry in entries:
        assert entry["marker"] is None, entry["name"]
        assert entry["hashes"], entry["name"]
        for item in entry["hashes"]:
            assert re.fullmatch(r"--hash=sha256:[0-9a-f]{64}", item), (entry["name"], item)
