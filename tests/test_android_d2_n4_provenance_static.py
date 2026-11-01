"""Hosted negative/positive controls for the D2 N4 provenance collector (SPEC-v2 as amended by SPEC-v3).

Every fixture here is synthetic (minimal DEX bytes, ZIP containers, stub adb/dexdump, the exact wrapper tail). They
prove the collector's own completeness, bounds, byte-safety and status rules; they are NOT runtime/ART evidence.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import shutil
import stat
import struct
import subprocess
import sys
import warnings
import zipfile

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "android/scripts"
COLLECTOR = SCRIPTS / "d2_n4_provenance.py"
RUNNER = SCRIPTS / "run-legacy-recorder-runtime.sh"
TAIL_BEGIN, TAIL_END = "# D2-N4-PROVENANCE-TAIL-BEGIN", "# D2-N4-PROVENANCE-TAIL-END"

spec = importlib.util.spec_from_file_location("d2_n4_provenance", COLLECTOR)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

FINGERPRINT = "google/sdk_gphone_x86/generic_x86:10/QSR1.211112.011/7889356:userdebug/dev-keys"
PROPS = {"ro.build.fingerprint": FINGERPRINT, "ro.build.id": "QSR1.211112.011", "ro.build.version.incremental": "7889356",
         "ro.build.version.release": "10", "ro.build.version.sdk": "29", "ro.build.version.security_patch": "2021-11-05",
         "ro.product.cpu.abi": "x86"}
INSTALLED = "/data/app/~~abc==/io.silentsuite.android-xyz==/base.apk"
BCP = ["/apex/com.android.art/javalib/core-oj.jar", "/apex/com.android.art/javalib/core-libart.jar"]
JAR0 = [b"Ljava/io/ObjectInputStream;", b"Ljava/text/SimpleDateFormat;", b"Ljava/time/Ser;", b"Ljava/time/ZoneRegion;",
        b"Ljava/time/zone/ZoneRulesProvider;", b"Ljava/time/zone/IcuZoneRulesProvider;",
        b"Ljava/time/zone/IcuZoneRulesProvider$ZoneRulesCache;", b"Ljava/lang/Object;"]
JAR1 = [b"Llibcore/util/ZoneInfo;", b"Llibcore/util/BasicLruCache;", b"Ljava/time/Ser;",
        b"Lcom/android/icu/util/ExtendedTimeZone;"]
APK_DEX1 = [b"Lnet/fortuna/ical4j/model/Recur;", b"Lnet/fortuna/ical4j/util/Configurator;"]
APK_DEX2 = [b"Lnet/fortuna/ical4j/util/ResourceLoader;", b"Lorg/slf4j/LoggerFactory;", b"Lorg/slf4j/impl/StaticLoggerBinder;"]


def uleb(value: int) -> bytes:
    out = bytearray()
    while True:
        byte, value = value & 0x7F, value >> 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def make_dex(descriptors: list[bytes], size_delta: int = 0) -> bytes:
    n = len(descriptors)
    string_ids, type_ids, class_defs = 0x70, 0x70 + 4 * n, 0x70 + 8 * n
    data = bytearray()
    offsets = []
    base = class_defs + 32 * n
    for descriptor in descriptors:
        offsets.append(base + len(data))
        data += uleb(len(descriptor)) + descriptor + b"\0"
    header = bytearray(0x70)
    header[0:8] = b"dex\n039\x00"
    struct.pack_into("<II", header, 0x38, n, string_ids)
    struct.pack_into("<II", header, 0x40, n, type_ids)
    struct.pack_into("<II", header, 0x60, n, class_defs)
    body = b"".join(struct.pack("<I", o) for o in offsets) + b"".join(struct.pack("<I", i) for i in range(n))
    body += b"".join(struct.pack("<I", i) + bytes(28) for i in range(n)) + bytes(data)
    blob = bytearray(header + body)
    struct.pack_into("<I", blob, 0x20, len(blob) + size_delta)
    return bytes(blob)


def make_zip(path: pathlib.Path, members: dict[str, bytes]) -> pathlib.Path:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with zipfile.ZipFile(path, "w") as archive:
            for name, data in members.items() if isinstance(members, dict) else members:
                archive.writestr(name, data)
    return path


def executable(path: pathlib.Path, body: str) -> pathlib.Path:
    path.write_text(f"#!{sys.executable}\n" + body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


STUB_ADB = r'''
import json, os, shutil, sys, time
config = json.load(open(os.environ["STUB_ADB_CONFIG"]))
time.sleep(config.get("sleep", 0))
args = sys.argv[1:]
if args[:2] == ["shell", "getprop"]:
    if args[2] not in config["props"]:
        sys.exit(1)
    print(config["props"][args[2]])
elif args == ["shell", "echo $BOOTCLASSPATH"]:
    print(config["bcp"])
elif args[:3] == ["shell", "pm", "path"]:
    print(config["pm"])
elif args[0] == "pull":
    source = config["files"].get(args[1])
    if source is None:
        sys.exit(1)
    shutil.copyfile(source, args[2])
else:
    sys.exit(2)
'''

STUB_DEXDUMP = r'''
import os, sys, time
sys.path.insert(0, os.environ["STUB_SCRIPTS"])
import d2_n4_provenance as m
time.sleep(float(os.environ.get("STUB_DEXDUMP_SLEEP", "0")))
args = sys.argv[1:]
if args[0] == "-c":
    sys.exit(0)
out = args[args.index("-o") + 1]
descriptors = m.parse_dex_class_defs(open(args[-1], "rb").read())
if os.environ.get("STUB_DEXDUMP_DROP"):
    descriptors = descriptors[:-1]
inject = bytes.fromhex(os.environ.get("STUB_DEXDUMP_INJECT", ""))
with open(out, "wb") as handle:
    handle.write(b"Processing '" + args[-1].encode() + b"'...\nOpened, DEX version '039'\n")
    for index, d in enumerate(descriptors):
        handle.write(b"Class #%d header:\nclass_idx           : %d\n\n" % (index, index))
        handle.write(b"Class #%d            -\n  Class descriptor  : '" % index + d + b"'\n")
        handle.write(b"  Access flags      : 0x0001 (PUBLIC)\n      insns:\n0000: const-string v0, \"" + inject + b"\"\n\n")
'''


def fixture(tmp: pathlib.Path, *, jar1=None, apk_members=None, props=None, carrier_fingerprints=None,
            logging_lines=None, validation="PASS", metadata=None, sleep=0) -> tuple[pathlib.Path, dict]:
    root = tmp / "android"
    stubs = tmp / "stubs"
    stubs.mkdir()
    out = root / "app/build/outputs/androidTest-results/d2-legacy-recorder/n1"
    (out / "raw").mkdir(parents=True)
    for index, method in enumerate(m.METHODS):
        fp = (carrier_fingerprints or [FINGERPRINT] * 5)[index]
        begin = (f"D2-RECORDER-BEGIN schema=1 method={method} group=g nonce=n1 package={m.PACKAGE} versionCode=31 "
                 f"versionName=0.5.17-beta sdk=29 abi=x86 fingerprint={m.pct(fp)} securityPatch=2021-11-05 vm=2.1.0")
        lines = [begin, "D2-RECORDER group=g family=F variant=v class=C descriptors=a"]
        lines += (logging_lines or [["D2-RECORDER provenance-logging factory=org.slf4j.impl.JDK14LoggerFactory "
                                     "loader=dalvik.system.PathClassLoader"]] * 5)[index]
        (out / "raw" / f"{method}.txt").write_text("\n".join(lines + ["D2-RECORDER-END x"]) + "\n", encoding="utf-8")
    (out / "validation.json").write_text(json.dumps(
        {"classification": validation, "files": {f"{x}.txt": {"errors": []} for x in m.METHODS}}), encoding="utf-8")
    apk_dir = root / "app/build/outputs/apk/debug"
    apk_dir.mkdir(parents=True)
    apk = make_zip(apk_dir / "app-debug.apk", apk_members or {"classes.dex": make_dex(APK_DEX1),
                                                               "classes2.dex": make_dex(APK_DEX2)})
    (apk_dir / "output-metadata.json").write_text(json.dumps(metadata or {
        "version": 3, "applicationId": m.PACKAGE, "variantName": "debug",
        "elements": [{"type": "SINGLE", "versionCode": 31, "versionName": "0.5.17-beta", "outputFile": "app-debug.apk"}]}),
        encoding="utf-8")
    mapping = root / "app/build/outputs/mapping/debug"
    mapping.mkdir(parents=True)
    names = [d[1:-1].decode().replace("/", ".") for d in APK_DEX1 + APK_DEX2]
    (mapping / "mapping.txt").write_text("".join(f"{n} -> {n}:\n" for n in names), encoding="utf-8")
    jar0 = make_zip(stubs / "core-oj.jar", {"classes.dex": make_dex(JAR0)})
    jar1 = jar1 if jar1 is not None else make_zip(stubs / "core-libart.jar", {"classes.dex": make_dex(JAR1)})
    config = {"props": props if props is not None else PROPS, "bcp": ":".join(BCP), "pm": f"package:{INSTALLED}",
              "files": {BCP[0]: str(jar0), BCP[1]: str(jar1), INSTALLED: str(apk)}, "sleep": sleep}
    (stubs / "adb.json").write_text(json.dumps(config), encoding="utf-8")
    shutil.copyfile(COLLECTOR, stubs / "d2_n4_provenance.py")
    env = dict(os.environ, D2_N4_ADB=str(executable(stubs / "adb", STUB_ADB)),
               D2_N4_DEXDUMP=str(executable(stubs / "dexdump", STUB_DEXDUMP)), STUB_ADB_CONFIG=str(stubs / "adb.json"),
               STUB_SCRIPTS=str(stubs), RUNNER_TEMP=str(tmp / "runner"))
    return root, env


def collect(root: pathlib.Path, env: dict, **extra) -> tuple[int, dict]:
    out = "app/build/outputs/androidTest-results/d2-legacy-recorder/n1"
    result = subprocess.run([sys.executable, str(COLLECTOR), "29", "x86", "n1", out], cwd=root,
                            env=dict(env, **extra), capture_output=True, text=True, timeout=120)
    return result.returncode, json.loads((root / out / "provenance/provenance.json").read_text(encoding="utf-8"))


def test_positive_control_is_complete_with_multidex_duplicates_and_index(tmp_path):
    root, env = fixture(tmp_path)
    code, report = collect(root, env)
    assert (code, report["status"], report["finalized"]) == (0, "COMPLETE", True), report["reasons"]
    targets = report["targets"]
    assert targets["apk:Lorg/slf4j/LoggerFactory;"]["selected"]["member"] == "classes2.dex"
    assert [o["index"] for o in targets["boot:Ljava/time/Ser;"]["occurrences"]] == ["bcp00", "bcp01"]
    assert targets["boot:Ljava/time/Ser;"]["selected"]["index"] == "bcp00"
    assert targets["boot:Lcom/android/i18n/timezone/ZoneInfoData;"]["status"] == "ABSENT"
    assert report["apkBinding"]["status"] == "BOUND" and report["bootImage"]["status"] == "OK"
    assert report["backend"] == {"status": "OBSERVED", "factory": "org.slf4j.impl.JDK14LoggerFactory",
                                 "loader": "dalvik.system.PathClassLoader"}
    index = json.loads((root / "app/build/outputs/androidTest-results/d2-legacy-recorder/n1/provenance/"
                        "dexdump-index.json").read_text(encoding="utf-8"))
    assert {entry["descriptor"] for entry in index.values()} >= {"Ljava/time/Ser;", "Llibcore/util/ZoneInfo;"}


def test_false_absence_stripped_container_is_incomplete_never_absent(tmp_path):
    root, env = fixture(tmp_path, jar1=make_zip(tmp_path / "stripped.jar", {"META-INF/MANIFEST.MF": b"x"}))
    code, report = collect(root, env)
    assert code == 40 and report["status"] == "PROVENANCE-INCOMPLETE"
    assert report["targets"]["boot:Lcom/android/i18n/timezone/ZoneInfoData;"]["status"] == "NOT-SCANNED-COMPLETELY"
    assert any(c["status"] == "STRIPPED" for c in report["containers"])


def test_required_missing_after_complete_scan_is_incomplete(tmp_path):
    root, env = fixture(tmp_path, jar1=make_zip(tmp_path / "j.jar", {"classes.dex": make_dex(JAR1[:1] + JAR1[2:])}))
    code, report = collect(root, env)
    assert code == 40 and report["targets"]["boot:Llibcore/util/BasicLruCache;"]["status"] == "MISSING"
    assert report["targets"]["boot:Lcom/android/i18n/timezone/ZoneInfoData;"]["status"] == "ABSENT"


def test_truncation_and_dropped_blocks_are_incomplete(tmp_path):
    with pytest.raises(m.Incomplete):
        m.parse_dex_class_defs(make_dex(JAR0, size_delta=4))
    with pytest.raises(m.Incomplete):
        m.parse_dex_class_defs(make_dex(JAR0)[:-3])
    root, env = fixture(tmp_path)
    code, report = collect(root, env, STUB_DEXDUMP_DROP="1")
    assert code == 40 and any("dexdump blocks" in r for r in report["reasons"])


def test_apk_duplicate_class_is_incomplete(tmp_path):
    root, env = fixture(tmp_path, apk_members={"classes.dex": make_dex(APK_DEX1),
                                              "classes2.dex": make_dex(APK_DEX2 + APK_DEX1[:1])})
    code, report = collect(root, env)
    assert code == 40 and report["targets"]["apk:Lnet/fortuna/ical4j/model/Recur;"]["status"] == "DUPLICATE"


@pytest.mark.parametrize("members", [[("../classes.dex", b"x")], [("dir/classes.dex", b"x")],
                                     [("classes.dex", make_dex(JAR1)), ("classes.dex", make_dex(JAR1))]])
def test_unsafe_or_duplicate_dex_members_are_incomplete(tmp_path, members):
    root, env = fixture(tmp_path, jar1=make_zip(tmp_path / "bad.jar", members))
    code, report = collect(root, env)
    assert code == 40 and any("bcp01" in r and ("unsafe" in r or "duplicate" in r) for r in report["reasons"])


def test_untrusted_bootclasspath_entry_and_oversized_member_are_incomplete(tmp_path, monkeypatch):
    root, env = fixture(tmp_path)
    config = json.loads(pathlib.Path(env["STUB_ADB_CONFIG"]).read_text())
    config["bcp"] += ":/data/local/tmp/evil.jar"
    pathlib.Path(env["STUB_ADB_CONFIG"]).write_text(json.dumps(config))
    code, report = collect(root, env)
    assert code == 40 and any("untrusted entry" in r for r in report["reasons"])
    monkeypatch.setitem(m.LIMITS, "dexMemberBytes", 16)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path / "inproc"))
    collector = m.Collector("29", "x86", "n2", tmp_path / "o")
    collector.tmp.mkdir(parents=True, exist_ok=True)
    assert collector.scan("x", "c", tmp_path / "stubs/core-oj.jar", set(), None, {}) is False
    assert any("dexMemberBytes" in r for r in collector.reasons)


@pytest.mark.parametrize("metadata", [
    {"elements": [{"applicationId": "io.silentsuite.android", "outputFile": "app-debug.apk"}]},
    {"applicationId": "io.silentsuite.android", "elements": []},
    {"applicationId": "io.silentsuite.android", "elements": [{"outputFile": "app-debug.apk"}, {"outputFile": "b.apk"}]},
    {"applicationId": "io.silentsuite.android", "elements": [{"outputFile": "../x.apk"}]},
    {"applicationId": "io.silentsuite.android", "elements": [{"outputFile": "/abs.apk"}]},
    {"applicationId": "io.silentsuite.android", "elements": [{"outputFile": "sub/x.apk"}]},
    {"applicationId": "io.silentsuite.android", "elements": [{"outputFile": "link.apk"}]},
])
def test_apk_metadata_schema_violations_are_incomplete(tmp_path, metadata):
    root, env = fixture(tmp_path, metadata=metadata)
    (root / "app/build/outputs/apk/debug/link.apk").symlink_to(tmp_path / "stubs/core-oj.jar")
    code, report = collect(root, env)
    assert code == 40 and any(r.startswith("apkMetadata") for r in report["reasons"])


@pytest.mark.parametrize("case", ["fingerprint", "sdk", "abi", "missing", "validation"])
def test_boot_identity_mismatch_or_missing_is_incomplete(tmp_path, case):
    props = dict(PROPS)
    fingerprints = [FINGERPRINT] * 5
    if case == "fingerprint":
        fingerprints[3] = FINGERPRINT + "x"
    elif case == "sdk":
        props["ro.build.version.sdk"] = "30"
    elif case == "abi":
        props["ro.product.cpu.abi"] = "x86_64"
    elif case == "missing":
        del props["ro.build.version.security_patch"]
    root, env = fixture(tmp_path, props=props, carrier_fingerprints=fingerprints,
                        validation="FIXTURE-DIVERGENCE" if case == "validation" else "PASS")
    code, report = collect(root, env)
    assert code == 40 and report["bootImage"]["status"] == "INCOMPLETE"


@pytest.mark.parametrize("lines", [
    [[]] + [["D2-RECORDER provenance-logging factory=A loader=L"]] * 4,
    [["D2-RECORDER provenance-logging factory=A loader=L"]] * 4 + [["D2-RECORDER provenance-logging factory=B loader=L"]],
    [["D2-RECORDER provenance-logging factory=A loader=L"] * 2] * 5,
])
def test_runtime_backend_missing_duplicated_or_inconsistent_stays_open(tmp_path, lines):
    root, env = fixture(tmp_path, logging_lines=lines)
    code, report = collect(root, env)
    assert code == 40 and report["backend"]["status"] == "OPEN"


def test_mutf8_block_bytes_are_preserved_without_text_decoding(tmp_path):
    dump = tmp_path / "dump"
    payload = b"Class #0            -\n  Class descriptor  : 'LA;'\n0000: const-string v0, \"5, \"\xc0\x80\" /\"\nClass #1            -\n  Class descriptor  : 'LB;'\n"
    dump.write_bytes(payload)
    blocks = m.parse_dexdump_blocks(dump)
    assert [b[0] for b in blocks] == [b"LA;", b"LB;"]
    assert b"\xc0\x80" in payload[blocks[0][1]:blocks[0][2]]
    root, env = fixture(tmp_path / "e2e" if (tmp_path / "e2e").mkdir() is None else tmp_path)
    code, report = collect(root, env, STUB_DEXDUMP_INJECT="352c2022c08022202f")
    assert code == 0, report["reasons"]
    prov = root / "app/build/outputs/androidTest-results/d2-legacy-recorder/n1/provenance"
    index = json.loads((prov / "dexdump-index.json").read_text(encoding="utf-8"))
    for safe, entry in index.items():
        block = (prov / "dexdump" / f"{safe}.txt").read_bytes()
        assert b"\xc0\x80" in block and m.sha256(block) == entry["blockSha256"]


def _tail() -> str:
    text = RUNNER.read_text(encoding="utf-8")
    assert text.count(TAIL_BEGIN) == 1 and text.count(TAIL_END) == 1
    return text[text.index(TAIL_BEGIN):text.index(TAIL_END) + len(TAIL_END)]


def run_tail(tmp: pathlib.Path, collector: str, gradle=0, validator=0, env=None, timeout_s=600, kill_after_s=15):
    (tmp / "scripts").mkdir(exist_ok=True)
    (tmp / "scripts/d2_n4_provenance.py").write_text(collector, encoding="utf-8")
    preamble = f"api=29; arch=x86; nonce=t1; out='{tmp}/out'; gradle_status={gradle}; validator_status={validator}\n"
    result = subprocess.run(["bash", "-c", preamble + _tail()], cwd=tmp, capture_output=True, text=True, timeout=120,
                            env=dict(env or os.environ, D2_N4_TIMEOUT_S=str(timeout_s),
                                     D2_N4_KILL_AFTER_S=str(kill_after_s), RUNNER_TEMP=str(tmp / "runner")))
    return result.returncode, result.stdout


FINALIZING = r'''
import json, os, sys
os.makedirs(sys.argv[4] + "/provenance", exist_ok=True)
code = int(os.environ.get("FAKE_CODE", "0"))
json.dump({"finalized": True, "status": "COMPLETE" if code == 0 else "PROVENANCE-INCOMPLETE", "collectorExit": code},
          open(sys.argv[4] + "/provenance/provenance.json", "w"))
sys.exit(code)
'''


@pytest.mark.parametrize(("gradle", "validator", "fake", "expected"), [
    (1, 0, "0", 1), (0, 20, "0", 20), (1, 20, "40", 1), (0, 0, "0", 0), (0, 0, "40", 40)])
def test_tail_precedence_gradle_validator_provenance(tmp_path, gradle, validator, fake, expected):
    code, stdout = run_tail(tmp_path, FINALIZING, gradle, validator, env=dict(os.environ, FAKE_CODE=fake))
    assert code == expected
    assert f"gradle={gradle} validator={validator} provenance={fake} provenanceRaw={fake}" in stdout


def test_tail_exit_zero_without_finalized_report_is_incomplete(tmp_path):
    code, stdout = run_tail(tmp_path, "import sys; sys.exit(0)\n")
    assert code == 40 and "provenanceReason=no-finalized-report" in stdout
    assert json.loads((tmp_path / "out/provenance/provenance-fallback.json").read_text())["status"] == "PROVENANCE-INCOMPLETE"


def test_tail_sigkill_after_ignored_sigterm_is_incomplete_with_fallback(tmp_path):
    ignoring = "import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(60)\n"
    code, stdout = run_tail(tmp_path, ignoring, timeout_s=1, kill_after_s=1)
    assert code == 40 and "provenanceRaw=137" in stdout and "provenanceReason=forced-termination" in stdout
    assert (tmp_path / "out/provenance/provenance-fallback.json").is_file()
    code, _ = run_tail(tmp_path, ignoring, gradle=3, timeout_s=1, kill_after_s=1)
    assert code == 3


def test_tail_real_collector_sigterm_finalizes_incomplete_never_complete(tmp_path):
    root, env = fixture(tmp_path, sleep=30)
    out = root / "app/build/outputs/androidTest-results/d2-legacy-recorder/n1"
    (root / "scripts").mkdir()
    shutil.copyfile(COLLECTOR, root / "scripts/d2_n4_provenance.py")
    preamble = f"api=29; arch=x86; nonce=n1; out='{out}'; gradle_status=0; validator_status=0\n"
    result = subprocess.run(["bash", "-c", preamble + _tail()], cwd=root, capture_output=True, text=True, timeout=120,
                            env=dict(env, D2_N4_TIMEOUT_S="3", D2_N4_KILL_AFTER_S="20"))
    assert result.returncode == 40 and "provenanceRaw=124" in result.stdout
    report = json.loads((out / "provenance/provenance.json").read_text(encoding="utf-8"))
    assert report["finalized"] is True and report["status"] == "PROVENANCE-INCOMPLETE" and "terminated" in report["reasons"]
