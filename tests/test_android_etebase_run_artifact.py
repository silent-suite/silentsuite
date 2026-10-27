"""Behavioural tests for android/scripts/etebase-run-artifact.py.

Every case runs the real CLI in a subprocess against temporary files: a producer
records the same-run Etebase AAR into a staging folder, and a fresh consumer
checkout admits it. A rejected admission must leave the fixed destination absent,
or, when it already existed, byte-for-byte unchanged.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import warnings
import zipfile
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "android/scripts/etebase-run-artifact.py"
SCRIPTS = ("build-etebase-client-16kb.sh", "reproducible-build-contract.sh")
AAR = "client-2.3.2-16kb.aar"
PROVENANCE = "etebase-16kb-provenance.json"
ABIS = ("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
FIXED_ENTRIES = [f"jni/{abi}/libetebase_android.so" for abi in ABIS]
HEAD = "0123456789abcdef0123456789abcdef01234567"
RUN_ID = "4242"
NDK_REVISION = "28.2.13676358"


def write_aar(path: Path, *, abis=ABIS, empty=(), extra=(), duplicate=()) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # zipfile warns when a duplicate name is written on purpose
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("AndroidManifest.xml", "<manifest/>")
            archive.writestr("classes.jar", b"jar bytes")
            for abi in abis:
                payload = b"" if abi in empty else f"ELF payload for {abi}".encode()
                archive.writestr(f"jni/{abi}/libetebase_android.so", payload)
            for name in extra:
                archive.writestr(name, b"extra payload")
            for name in duplicate:
                archive.writestr(name, b"duplicate payload")


def android_root(base: Path) -> Path:
    root = base / "android"
    (root / "scripts").mkdir(parents=True)
    for name in SCRIPTS:
        shutil.copyfile(ROOT / "android/scripts" / name, root / "scripts" / name)
    return root


def environment(base: Path, *, attempt: str, sha: str = HEAD, run: str = RUN_ID) -> dict[str, str]:
    ndk = base / "ndk"
    ndk.mkdir(exist_ok=True)
    (ndk / "source.properties").write_text(
        f"Pkg.Desc = Android NDK\nPkg.Revision = {NDK_REVISION}\n", encoding="utf-8"
    )
    return {
        "PATH": os.environ.get("PATH", ""),
        "GITHUB_SHA": sha,
        "GITHUB_RUN_ID": run,
        "GITHUB_RUN_ATTEMPT": attempt,
        "ANDROID_NDK_HOME": str(ndk),
    }


def helper(command: str, root: Path, staging: Path, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(HELPER), command, "--android-root", str(root), "--staging", str(staging)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def produce(tmp: Path, *, attempt: str = "1") -> Path:
    producer = android_root(tmp / "producer")
    write_aar(producer / "app/libs" / AAR)
    staging = tmp / "staging"
    result = helper("record", producer, staging, environment(tmp, attempt=attempt))
    assert result.returncode == 0, result.stderr
    return staging


def canonical(value: dict) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def rewrite(staging: Path, **changes) -> None:
    path = staging / PROVENANCE
    value = json.loads(path.read_bytes())
    for key, new in changes.items():
        if new is DELETE:
            del value[key]
        else:
            value[key] = new
    path.write_bytes(canonical(value))


DELETE = object()


def honest_aar(staging: Path, *, abi_entries=None, **aar_kwargs) -> None:
    """Replace the staged AAR and update its provenance consistently."""
    write_aar(staging / AAR, **aar_kwargs)
    data = (staging / AAR).read_bytes()
    changes = {"aarSha256": hashlib.sha256(data).hexdigest(), "aarSize": len(data)}
    if abi_entries is not None:
        changes["abiEntries"] = abi_entries
    rewrite(staging, **changes)


def admit(tmp: Path, mutate=None, *, attempt: str = "2"):
    staging = produce(tmp)
    consumer = android_root(tmp / "consumer")
    env = environment(tmp, attempt=attempt)
    if mutate is not None:
        mutate(staging, consumer, env)
    result = helper("verify", consumer, staging, env)
    return result, staging, consumer / "app/libs" / AAR


@pytest.mark.parametrize(("recorded", "current"), [("1", "1"), ("1", "2"), ("2", "2")])
def test_valid_same_run_artifact_installs_exactly_the_admitted_bytes(tmp_path: Path, recorded, current):
    staging = produce(tmp_path, attempt=recorded)
    consumer = android_root(tmp_path / "consumer")
    result = helper("verify", consumer, staging, environment(tmp_path, attempt=current))
    assert result.returncode == 0, result.stderr
    destination = consumer / "app/libs" / AAR
    assert destination.read_bytes() == (staging / AAR).read_bytes()
    assert not destination.is_symlink()
    assert sorted(path.name for path in destination.parent.iterdir()) == [AAR]
    provenance = json.loads((staging / PROVENANCE).read_bytes())
    assert provenance["abiEntries"] == FIXED_ENTRIES
    assert provenance["headSha"] == HEAD and provenance["runId"] == RUN_ID
    assert provenance["runAttempt"] == int(recorded)
    assert (staging / PROVENANCE).read_bytes() == canonical(provenance)
    assert sorted(path.name for path in staging.iterdir()) == sorted([AAR, PROVENANCE])


@pytest.mark.parametrize(
    "aar_kwargs",
    [
        *({"abis": tuple(a for a in ABIS if a != missing)} for missing in ABIS),
        {"empty": ("x86",)},
        {"extra": ("jni/mips/libetebase_android.so",)},
        {"duplicate": ("jni/x86_64/libetebase_android.so",)},
    ],
    ids=[*(f"missing-{abi}" for abi in ABIS), "empty-x86", "extra-abi", "duplicate-entry"],
)
def test_record_refuses_an_incomplete_or_unexpected_inventory(tmp_path: Path, aar_kwargs):
    producer = android_root(tmp_path / "producer")
    write_aar(producer / "app/libs" / AAR, **aar_kwargs)
    staging = tmp_path / "staging"
    result = helper("record", producer, staging, environment(tmp_path, attempt="1"))
    assert result.returncode != 0
    assert not staging.exists()


def flip_last_byte(staging, consumer, env):
    data = bytearray((staging / AAR).read_bytes())
    data[-1] ^= 0x01
    (staging / AAR).write_bytes(bytes(data))


def size_mismatch(staging, consumer, env):
    write_aar(staging / AAR, extra=("assets/padding.bin",))
    rewrite(staging, aarSha256=hashlib.sha256((staging / AAR).read_bytes()).hexdigest())


def symlinked_aar(staging, consumer, env):
    real = staging.parent / "elsewhere.aar"
    (staging / AAR).rename(real)
    (staging / AAR).symlink_to(real)


def symlinked_provenance(staging, consumer, env):
    real = staging.parent / "elsewhere.json"
    (staging / PROVENANCE).rename(real)
    (staging / PROVENANCE).symlink_to(real)


def duplicate_key(staging, consumer, env):
    raw = (staging / PROVENANCE).read_bytes()
    (staging / PROVENANCE).write_bytes(raw.replace(b"{", b'{"schema":1,', 1))


def not_canonical(staging, consumer, env):
    value = json.loads((staging / PROVENANCE).read_bytes())
    (staging / PROVENANCE).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def bad_archive(staging, consumer, env):
    (staging / AAR).write_bytes(b"this is not a zip archive")
    rewrite(staging, aarSha256=hashlib.sha256(b"this is not a zip archive").hexdigest(), aarSize=25)


def script_drift(staging, consumer, env):
    with (consumer / "scripts/build-etebase-client-16kb.sh").open("a", encoding="utf-8") as script:
        script.write("# drift\n")


def contract_drift(staging, consumer, env):
    with (consumer / "scripts/reproducible-build-contract.sh").open("a", encoding="utf-8") as script:
        script.write("# drift\n")


REJECTIONS = {
    "corrupt-byte": flip_last_byte,
    "size-mismatch": size_mismatch,
    "wrong-head": lambda s, c, env: env.update(GITHUB_SHA="f" * 40),
    "wrong-run": lambda s, c, env: env.update(GITHUB_RUN_ID="4243"),
    "future-attempt": lambda s, c, env: rewrite(s, runAttempt=3),
    "zero-attempt": lambda s, c, env: rewrite(s, runAttempt=0),
    "bool-attempt": lambda s, c, env: rewrite(s, runAttempt=True),
    "string-attempt": lambda s, c, env: rewrite(s, runAttempt="1"),
    "bool-size": lambda s, c, env: rewrite(s, aarSize=True),
    "string-size": lambda s, c, env: rewrite(s, aarSize="123"),
    "uppercase-head": lambda s, c, env: rewrite(s, headSha=HEAD.upper()),
    "short-sha256": lambda s, c, env: rewrite(s, aarSha256="ab" * 31),
    "non-decimal-run": lambda s, c, env: rewrite(s, runId="run-4242"),
    "wrong-schema": lambda s, c, env: rewrite(s, schema=2),
    "wrong-ndk-major": lambda s, c, env: rewrite(s, ndkRevision="27.2.12479018"),
    "wrong-etebase-pin": lambda s, c, env: rewrite(s, etebaseCommit="0" * 40),
    "wrong-rust-pin": lambda s, c, env: rewrite(s, rustToolchain="1.0.0"),
    "script-drift": script_drift,
    "contract-drift": contract_drift,
    "missing-aar": lambda s, c, env: (s / AAR).unlink(),
    "missing-provenance": lambda s, c, env: (s / PROVENANCE).unlink(),
    "missing-staging": lambda s, c, env: shutil.rmtree(s),
    "malformed-json": lambda s, c, env: (s / PROVENANCE).write_bytes(b"{not json\n"),
    "not-an-object": lambda s, c, env: (s / PROVENANCE).write_bytes(b"[]\n"),
    "not-canonical": not_canonical,
    "duplicate-key": duplicate_key,
    "unknown-key": lambda s, c, env: rewrite(s, unexpected=1),
    "missing-key": lambda s, c, env: rewrite(s, flapigenCommit=DELETE),
    "bad-archive": bad_archive,
    "symlinked-aar": symlinked_aar,
    "symlinked-provenance": symlinked_provenance,
    "extra-staged-file": lambda s, c, env: (s / "notes.txt").write_text("extra", encoding="utf-8"),
    "reordered-abi-manifest": lambda s, c, env: rewrite(s, abiEntries=list(reversed(FIXED_ENTRIES))),
    "extra-abi": lambda s, c, env: honest_aar(s, extra=("jni/mips/libetebase_android.so",)),
    "duplicate-entry": lambda s, c, env: honest_aar(s, duplicate=("jni/arm64-v8a/libetebase_android.so",)),
    "empty-payload": lambda s, c, env: honest_aar(s, empty=("armeabi-v7a",)),
}


@pytest.mark.parametrize("mutate", REJECTIONS.values(), ids=REJECTIONS.keys())
def test_rejected_admission_leaves_the_destination_absent(tmp_path: Path, mutate):
    result, _, destination = admit(tmp_path, mutate)
    assert result.returncode != 0, result.stdout
    assert "error:" in result.stderr
    assert not os.path.lexists(destination)


@pytest.mark.parametrize("missing", ABIS)
@pytest.mark.parametrize("manifest", ["fixed", "honest"])
def test_removing_any_abi_library_is_rejected_even_with_an_honest_manifest(tmp_path: Path, missing, manifest):
    remaining = tuple(abi for abi in ABIS if abi != missing)
    entries = None if manifest == "fixed" else [f"jni/{abi}/libetebase_android.so" for abi in remaining]
    result, _, destination = admit(
        tmp_path, lambda s, c, env: honest_aar(s, abis=remaining, abi_entries=entries)
    )
    assert result.returncode != 0, result.stdout
    assert not os.path.lexists(destination)


def test_an_existing_destination_is_refused_and_preserved(tmp_path: Path):
    def existing(staging, consumer, env):
        destination = consumer / "app/libs" / AAR
        destination.parent.mkdir(parents=True)
        destination.write_bytes(b"previous bytes")

    result, _, destination = admit(tmp_path, existing)
    assert result.returncode != 0
    assert destination.read_bytes() == b"previous bytes"
