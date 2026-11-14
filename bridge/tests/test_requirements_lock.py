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


def parse_lock() -> list[dict]:
    """Return one entry per pinned line: name, version, marker, hashes, via sources."""
    entries: list[dict] = []
    current: dict | None = None
    in_via = False
    for raw in LOCK.read_text(encoding="utf-8").replace("\\\n", " ").splitlines():
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


def declared_requirements() -> list[Requirement]:
    project = pyproject()["project"]
    declared = list(project["dependencies"])
    for extra in ("dev", "tray"):
        declared += project["optional-dependencies"][extra]
    return [Requirement(item) for item in declared]


def requirement_lines(path: Path) -> list[Requirement]:
    return [
        Requirement(line.split("#", 1)[0].strip())
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.split("#", 1)[0].strip()
    ]


def test_lock_header_records_the_compile_command():
    assert COMPILE_COMMAND in LOCK.read_text(encoding="utf-8").splitlines()[1]


def test_every_locked_package_is_pinned_with_sha256_hashes():
    entries = parse_lock()
    assert entries
    for entry in entries:
        assert entry["hashes"], entry["name"]
        for item in entry["hashes"]:
            assert re.fullmatch(r"--hash=sha256:[0-9a-f]{64}", item), (entry["name"], item)


def test_lock_direct_dependencies_match_pyproject():
    entries = parse_lock()
    declared = {canonicalize_name(requirement.name) for requirement in declared_requirements()}
    locked_direct = {entry["name"] for entry in entries if PYPROJECT_SOURCE in entry["via"]}
    assert locked_direct == declared


def test_every_locked_pin_satisfies_its_pyproject_range():
    entries = parse_lock()
    for requirement in declared_requirements():
        name = canonicalize_name(requirement.name)
        pins = [entry for entry in entries if entry["name"] == name]
        assert pins, name
        for pin in pins:
            assert requirement.specifier.contains(pin["version"], prereleases=True), (name, pin["version"])


def test_lock_inputs_are_the_build_backend_and_match_the_lock():
    inputs = {canonicalize_name(requirement.name) for requirement in requirement_lines(LOCK_INPUTS)}
    build_backend = {
        canonicalize_name(Requirement(item).name) for item in pyproject()["build-system"]["requires"]
    }
    assert build_backend <= inputs
    locked_inputs = {entry["name"] for entry in parse_lock() if INPUTS_SOURCE in entry["via"]}
    assert locked_inputs == inputs


def test_etebase_override_keeps_the_pyproject_range():
    (override,) = requirement_lines(LOCK_OVERRIDES)
    (declared,) = [r for r in declared_requirements() if canonicalize_name(r.name) == "etebase"]
    assert canonicalize_name(override.name) == "etebase"
    assert override.specifier == declared.specifier


def test_each_release_lane_gets_exactly_one_pin_per_package():
    entries = parse_lock()
    names = {entry["name"] for entry in entries}
    for lane in RELEASE_LANES:
        environment = lane_environment(lane)
        selected = [
            entry["name"]
            for entry in entries
            if entry["marker"] is None or entry["marker"].evaluate(environment)
        ]
        assert len(selected) == len(set(selected)), lane
        # macOS arm64 builds etebase from a pinned upstream commit instead.
        expected_etebase = lane != "macos-arm64"
        assert ("etebase" in selected) is expected_etebase, lane
        assert {"pystray", "pillow", "radicale", "pytest", "hatchling"} <= set(selected), lane
    assert "etebase" in names
