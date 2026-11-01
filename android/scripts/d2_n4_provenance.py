#!/usr/bin/env python3
"""D2 N4 provenance collector (test-only evidence; D2-N4-PROVENANCE-CHECKPOINT-SPEC-v2 as amended by SPEC-v3).

Collects, with fixed bounds, the boot-image identity, the host/installed APK identity, the ordered BOOTCLASSPATH
containers and whole class-definition blocks of a few named classes, the R8 mapping and the runtime SLF4J factory
line from the already validated carriers. It never modifies raw carriers, validation.json or the N2 classification.
Anything unavailable, truncated, stripped or unsupported is PROVENANCE-INCOMPLETE; nothing is fabricated.

Usage (from android/): python3 scripts/d2_n4_provenance.py API ARCH NONCE OUT_DIR
Exit: 0 COMPLETE, 40 PROVENANCE-INCOMPLETE, 41 PROVENANCE-INTERNAL.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import zipfile

PACKAGE = "io.silentsuite.android"
ALLOWED_CASES = {("29", "x86"), ("36", "x86_64")}
NONCE_RE = re.compile(r"[A-Za-z0-9._-]+")
METHODS = (
    "testLegacyRecorder_RoutedPropertyFamilies_RoundTrip",
    "testLegacyRecorder_ClazzForms_RoundTrip",
    "testLegacyRecorder_DefaultParameterFamilies_RoundTrip",
    "testLegacyRecorder_DateTimeValueShapes_RoundTrip",
    "testLegacyRecorder_ParsedEventUnknownProperties_RoundTrip",
)
BOOT_REQUIRED = (
    b"Llibcore/util/ZoneInfo;", b"Ljava/time/Ser;", b"Ljava/time/ZoneRegion;", b"Ljava/time/zone/ZoneRulesProvider;",
    b"Ljava/time/zone/IcuZoneRulesProvider;", b"Ljava/time/zone/IcuZoneRulesProvider$ZoneRulesCache;",
    b"Llibcore/util/BasicLruCache;", b"Ljava/io/ObjectInputStream;", b"Ljava/text/SimpleDateFormat;",
)
BOOT_OPTIONAL = (b"Lcom/android/i18n/timezone/ZoneInfoData;", b"Lcom/android/icu/util/ExtendedTimeZone;")
APK_REQUIRED = (
    b"Lnet/fortuna/ical4j/model/Recur;", b"Lnet/fortuna/ical4j/util/Configurator;",
    b"Lnet/fortuna/ical4j/util/ResourceLoader;", b"Lorg/slf4j/LoggerFactory;",
)
APK_OPTIONAL = (b"Lorg/slf4j/impl/StaticLoggerBinder;",)
BUILD_PROPS = (
    "ro.build.fingerprint", "ro.build.id", "ro.build.version.incremental", "ro.build.version.release",
    "ro.build.version.sdk", "ro.build.version.security_patch", "ro.product.cpu.abi",
)
BCP_ENTRY_RE = re.compile(r"/(system/framework|apex/[A-Za-z0-9._-]+/javalib)/[A-Za-z0-9._-]+\.jar")
INSTALLED_APK_RE = re.compile(r"/data/app/[A-Za-z0-9._~=/+-]+/base\.apk")
OUTPUT_FILE_RE = re.compile(r"[A-Za-z0-9._-]+\.apk")
MEMBER_RE = re.compile(r"classes([0-9]*)\.dex")
DEX_MAGIC_RE = re.compile(rb"dex\n0(3[5-9]|40)\x00")
BLOCK_START_RE = re.compile(rb"Class #\d+\s+-")
BLOCK_BOUNDARY_RE = re.compile(rb"Class #\d+( header:|\s+-)")
BLOCK_DESCRIPTOR_RE = re.compile(rb"  Class descriptor  : '(L[^']+;)'")
LOGGING_RE = re.compile(r"D2-RECORDER provenance-logging factory=(\S+) loader=(\S+)")
P = r"[A-Za-z0-9._~%-]*"
BEGIN_RE = re.compile(rf"D2-RECORDER-BEGIN schema=1 method=({P}) group=({P}) nonce=({P}) package=({P}) versionCode=(\d+) "
                      rf"versionName=({P}) sdk=(\d+) abi=({P}) fingerprint=({P}) securityPatch=({P}) vm=({P})")
UNRESERVED = set(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

MIB = 1024 * 1024
LIMITS = {
    "deadlineSeconds": 570, "getpropSeconds": 15, "pullSeconds": 120, "dexdumpSeconds": 300,
    "bootclasspathEntries": 64, "dexMembersPerContainer": 64, "dexMemberBytes": 64 * MIB,
    "containerDexBytes": 512 * MIB, "pulledTotalBytes": 512 * MIB, "dumpBytes": 1024 * MIB,
    "classBlockBytes": 32 * MIB, "tempTotalBytes": 3 * 1024 * MIB, "uploadBytes": 256 * MIB,
}


class Incomplete(Exception):
    """A bounded item could not be collected completely; recorded, never treated as success or absence."""


class Terminated(BaseException):
    pass


class Deadline(BaseException):
    pass


def _on_term(signum, frame):  # noqa: ARG001
    raise Terminated()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(MIB), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pct(value: str) -> str:
    return "".join(chr(b) if b in UNRESERVED else "%%%02X" % b for b in value.encode("utf-8"))


def unpct(raw: str) -> str:
    value = urllib.parse.unquote_to_bytes(raw).decode("utf-8")
    if pct(value) != raw:
        raise Incomplete(f"non-canonical percent encoding: {raw}")
    return value


# --- DEX pass 1: complete class_defs descriptor list (raw MUTF-8 bytes) ---------------------------------------

def _u32(data: bytes, offset: int) -> int:
    if offset < 0 or offset + 4 > len(data):
        raise Incomplete(f"dex read out of bounds at {offset}")
    return struct.unpack_from("<I", data, offset)[0]


def _uleb128_end(data: bytes, offset: int) -> int:
    for count in range(5):
        if offset + count >= len(data):
            raise Incomplete("dex uleb128 out of bounds")
        if data[offset + count] & 0x80 == 0:
            return offset + count + 1
    raise Incomplete("dex uleb128 too long")


def parse_dex_class_defs(data: bytes) -> list[bytes]:
    if len(data) < 0x70 or not DEX_MAGIC_RE.fullmatch(data[:8]):
        raise Incomplete(f"unsupported or invalid dex magic {data[:8]!r}")
    if _u32(data, 0x20) != len(data):
        raise Incomplete(f"dex file_size {_u32(data, 0x20)} != member size {len(data)}")
    string_ids_size, string_ids_off = _u32(data, 0x38), _u32(data, 0x3C)
    type_ids_size, type_ids_off = _u32(data, 0x40), _u32(data, 0x44)
    class_defs_size, class_defs_off = _u32(data, 0x60), _u32(data, 0x64)
    for size, off, width, name in ((string_ids_size, string_ids_off, 4, "string_ids"),
                                   (type_ids_size, type_ids_off, 4, "type_ids"),
                                   (class_defs_size, class_defs_off, 32, "class_defs")):
        if size and (off < 0x70 or off + size * width > len(data)):
            raise Incomplete(f"dex {name} out of bounds")
    descriptors = []
    for index in range(class_defs_size):
        class_idx = _u32(data, class_defs_off + 32 * index)
        if class_idx >= type_ids_size:
            raise Incomplete("dex class_idx out of range")
        descriptor_idx = _u32(data, type_ids_off + 4 * class_idx)
        if descriptor_idx >= string_ids_size:
            raise Incomplete("dex descriptor_idx out of range")
        start = _uleb128_end(data, _u32(data, string_ids_off + 4 * descriptor_idx))
        end = data.find(b"\x00", start)
        if end < 0:
            raise Incomplete("dex string data unterminated")
        descriptors.append(data[start:end])
    return descriptors


# --- DEX pass 2: byte-safe dexdump plain-format class blocks ---------------------------------------------------

def parse_dexdump_blocks(path: pathlib.Path) -> list[tuple[bytes, int, int]]:
    """(descriptor bytes, start offset, end offset) per class block; output is never decoded as text."""
    blocks: list[tuple[bytes, int, int]] = []
    current: list | None = None
    expect_descriptor = False
    offset = 0
    with open(path, "rb") as handle:
        for raw in handle:
            line = raw[:-1] if raw.endswith(b"\n") else raw
            if expect_descriptor:
                match = BLOCK_DESCRIPTOR_RE.fullmatch(line)
                if match is None:
                    raise Incomplete("dexdump class block without descriptor line")
                current[0] = match.group(1)
                expect_descriptor = False
            elif BLOCK_BOUNDARY_RE.fullmatch(line):
                if current is not None:
                    blocks.append((current[0], current[1], offset))
                    current = None
                if BLOCK_START_RE.fullmatch(line):
                    current = [None, offset]
                    expect_descriptor = True
            offset += len(raw)
    if expect_descriptor:
        raise Incomplete("dexdump output ends inside a class header")
    if current is not None:
        blocks.append((current[0], current[1], offset))
    return blocks


def _member_order(name: str) -> int:
    number = MEMBER_RE.fullmatch(name).group(1)
    return 1 if number == "" else int(number)


class Collector:
    def __init__(self, api: str, arch: str, nonce: str, out: pathlib.Path):
        self.api, self.arch, self.nonce, self.out = api, arch, nonce, out
        self.prov = out / "provenance"
        self.tmp = pathlib.Path(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()) / f"d2-n4-{nonce}"
        self.adb = os.environ.get("D2_N4_ADB", "adb")
        self.deadline = time.monotonic() + LIMITS["deadlineSeconds"]
        self.reasons: list[str] = []
        self.index: dict[str, dict] = {}
        self.pulled = 0
        self.temp = 0
        self.report: dict = {
            "schema": "d2-n4-provenance-1", "api": int(api), "arch": arch, "nonce": nonce, "finalized": False,
            "limits": LIMITS, "containers": [], "targets": {}, "boundsHit": [],
        }

    # helpers -----------------------------------------------------------------------------------------------------
    def incomplete(self, reason: str) -> None:
        self.reasons.append(reason)

    def run(self, cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
        remaining = self.deadline - time.monotonic()
        if remaining <= 1:
            raise Deadline()
        try:
            return subprocess.run(cmd, capture_output=True, timeout=min(timeout, remaining), check=False)
        except subprocess.TimeoutExpired as ex:
            raise Incomplete(f"timeout after {ex.timeout:.0f}s: {' '.join(cmd[:3])}") from None
        except OSError as ex:
            raise Incomplete(f"cannot run {cmd[0]}: {ex.__class__.__name__}") from None

    def adb_text(self, args: list[str], timeout: int) -> str:
        result = self.run([self.adb, *args], timeout)
        if result.returncode != 0:
            raise Incomplete(f"adb {' '.join(args[:3])} exit {result.returncode}")
        try:
            return result.stdout.decode("utf-8")
        except UnicodeDecodeError:
            raise Incomplete(f"adb {' '.join(args[:3])} output not UTF-8") from None

    def pull(self, remote: str, local: pathlib.Path) -> None:
        result = self.run([self.adb, "pull", remote, str(local)], LIMITS["pullSeconds"])
        if result.returncode != 0 or not local.is_file():
            raise Incomplete(f"adb pull {remote} failed (exit {result.returncode})")
        size = local.stat().st_size
        self.pulled += size
        self.temp += size
        if self.pulled > LIMITS["pulledTotalBytes"]:
            self.report["boundsHit"].append("pulledTotalBytes")
            raise Incomplete("bound pulledTotalBytes exceeded")
        self.check_temp()

    def check_temp(self) -> None:
        if self.temp > LIMITS["tempTotalBytes"]:
            self.report["boundsHit"].append("tempTotalBytes")
            raise Incomplete("bound tempTotalBytes exceeded")

    # steps -------------------------------------------------------------------------------------------------------
    def tool(self) -> str | None:
        override = os.environ.get("D2_N4_DEXDUMP")
        home = os.environ.get("ANDROID_HOME", "")
        path = pathlib.Path(override) if override else pathlib.Path(home) / "build-tools/36.0.0/dexdump"
        entry = {"path": str(path), "override": bool(override)}
        self.report["tool"] = entry
        if not home and not override or not path.is_file():
            self.incomplete("dexdump build-tools/36.0.0 unavailable")
            return None
        entry["sha256"] = sha256_file(path)
        props = path.parent / "source.properties"
        if props.is_file():
            match = re.search(r"^Pkg\.Revision=(\S+)$", props.read_text(encoding="utf-8", errors="strict"), re.M)
            entry["pkgRevision"] = match.group(1) if match else None
        elif not override:
            self.incomplete("build-tools/36.0.0/source.properties missing")
        return str(path)

    def boot_identity(self) -> None:
        values = {}
        try:
            for name in BUILD_PROPS:
                values[name] = self.adb_text(["shell", "getprop", name], LIMITS["getpropSeconds"]).strip("\r\n")
        except Incomplete as ex:
            self.report["bootImage"] = {"props": values, "status": "INCOMPLETE"}
            self.incomplete(f"bootImage: {ex}")
            return
        problems = [f"{name} empty" for name, value in values.items() if not value]
        try:
            validation = json.loads((self.out / "validation.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            validation = {}
        files = validation.get("files") or {}
        if validation.get("classification") != "PASS" or sorted(files) != sorted(f"{m}.txt" for m in METHODS) \
                or any(entry.get("errors") for entry in files.values()):
            problems.append("validation.json not PASS with five error-free carriers")
        carriers = []
        for method in METHODS:
            try:
                first = (self.out / "raw" / f"{method}.txt").read_bytes().split(b"\n", 1)[0].decode("utf-8")
                match = BEGIN_RE.fullmatch(first)
                if match is None:
                    raise Incomplete("BEGIN schema mismatch")
                carriers.append({"sdk": match.group(7), "abi": unpct(match.group(8)),
                                 "fingerprint": unpct(match.group(9)), "securityPatch": unpct(match.group(10))})
            except (OSError, UnicodeDecodeError, Incomplete) as ex:
                problems.append(f"carrier {method}: {ex.__class__.__name__}")
        if len(carriers) == len(METHODS):
            fingerprint = values.get("ro.build.fingerprint")
            for index, carrier in enumerate(carriers):
                if carrier["fingerprint"] != fingerprint:
                    problems.append(f"fingerprint mismatch carrier {index}")
                if not (carrier["sdk"] == self.api == values.get("ro.build.version.sdk")):
                    problems.append(f"sdk mismatch carrier {index}")
                if not (carrier["abi"] == self.arch == values.get("ro.product.cpu.abi")):
                    problems.append(f"abi mismatch carrier {index}")
                if carrier["securityPatch"] != values.get("ro.build.version.security_patch"):
                    problems.append(f"securityPatch mismatch carrier {index}")
        self.report["bootImage"] = {"props": values, "status": "OK" if not problems else "INCOMPLETE",
                                    "problems": problems}
        for problem in problems:
            self.incomplete(f"bootImage: {problem}")

    def host_apk(self) -> pathlib.Path | None:
        directory = pathlib.Path("app/build/outputs/apk/debug")
        metadata_path = directory / "output-metadata.json"
        entry: dict = {}
        self.report["apk"] = entry
        try:
            raw = metadata_path.read_bytes()
            entry["metadataSha256"] = sha256(raw)
            metadata = json.loads(raw.decode("utf-8"))
            if metadata.get("applicationId") != PACKAGE:
                raise Incomplete("root applicationId mismatch")
            elements = metadata.get("elements")
            if not isinstance(elements, list) or len(elements) != 1 or not isinstance(elements[0], dict):
                raise Incomplete("elements must have exactly one entry")
            output_file = elements[0].get("outputFile")
            if not isinstance(output_file, str) or not OUTPUT_FILE_RE.fullmatch(output_file):
                raise Incomplete("unsafe outputFile")
            for key in ("versionCode", "versionName"):
                if key in elements[0]:
                    entry[key] = elements[0][key]
            apk = directory / output_file
            if apk.is_symlink() or not apk.is_file() or apk.resolve().parent != directory.resolve():
                raise Incomplete("outputFile not a regular file inside the metadata directory")
        except (OSError, ValueError, Incomplete) as ex:
            self.incomplete(f"apkMetadata: {ex}")
            return None
        entry.update({"outputFile": output_file, "sha256": sha256_file(apk), "bytes": apk.stat().st_size})
        return apk

    def mapping(self) -> tuple[set[str], set[str]] | None:
        directory = pathlib.Path("app/build/outputs/mapping/debug")
        entry: dict = {}
        self.report["mapping"] = entry
        (self.prov / "mapping").mkdir(parents=True, exist_ok=True)
        classes, removed = set(), set()
        for name, required in (("mapping.txt", True), ("usage.txt", False)):
            source = directory / name
            if not source.is_file():
                if required:
                    self.incomplete("mapping: mapping.txt missing")
                entry[name] = None
                continue
            shutil.copyfile(source, self.prov / "mapping" / name)
            entry[name] = {"sha256": sha256_file(source), "bytes": source.stat().st_size}
            with open(source, "rb") as handle:
                for raw in handle:
                    line = raw.rstrip(b"\r\n")
                    if name == "mapping.txt":
                        match = re.fullmatch(rb"(\S+) -> (\S+):", line)
                        if match:
                            classes.add(match.group(1).decode("utf-8", "replace"))
                    elif line and not line.startswith(b" "):
                        removed.add(line.decode("utf-8", "replace"))
        return (classes, removed) if entry.get("mapping.txt") else None

    def installed_apk(self, host_sha: str | None) -> None:
        entry: dict = {}
        self.report["apkBinding"] = entry
        try:
            lines = [l for l in self.adb_text(["shell", "pm", "path", PACKAGE], 15).splitlines() if l.strip()]
            packages = [l.strip()[len("package:"):] for l in lines if l.strip().startswith("package:")]
            if len(packages) != 1 or len(lines) != 1 or not INSTALLED_APK_RE.fullmatch(packages[0]):
                raise Incomplete(f"pm path must give exactly one base.apk, got {len(packages)}")
            local = self.tmp / "installed-base.apk"
            self.pull(packages[0], local)
            entry.update({"path": packages[0], "sha256": sha256_file(local), "bytes": local.stat().st_size})
        except Incomplete as ex:
            entry["status"] = "UNAVAILABLE"
            self.incomplete(f"apkBinding: {ex}")
            return
        entry["status"] = "BOUND" if host_sha is not None and entry["sha256"] == host_sha else "MISMATCH"
        if entry["status"] != "BOUND":
            self.incomplete("apkBinding: installed base.apk bytes differ from host APK")

    def bootclasspath(self) -> list[tuple[int, str, pathlib.Path]]:
        try:
            entries = self.adb_text(["shell", "echo $BOOTCLASSPATH"], 15).strip().split(":")
        except Incomplete as ex:
            self.incomplete(f"bootclasspath: {ex}")
            return []
        self.report["bootclasspath"] = entries
        if not entries or entries == [""] or len(entries) > LIMITS["bootclasspathEntries"]:
            self.incomplete(f"bootclasspath: entry count {len(entries)} outside 1..{LIMITS['bootclasspathEntries']}")
            return []
        pulled = []
        for index, entry in enumerate(entries):
            if not BCP_ENTRY_RE.fullmatch(entry):
                self.incomplete(f"bootclasspath[{index}]: untrusted entry {entry!r}")
                continue
            local = self.tmp / f"bcp-{index}-{entry.rsplit('/', 1)[1]}"
            try:
                self.pull(entry, local)
            except Incomplete as ex:
                self.incomplete(f"bootclasspath[{index}]: {ex}")
                continue
            pulled.append((index, entry, local))
        return pulled

    def scan(self, label: str, container_index: str, path: pathlib.Path, targets: set[bytes], dexdump: str | None,
             found: dict[bytes, list[dict]]) -> bool:
        """Scans every classes*.dex member; returns True only if the whole container was scanned completely."""
        record: dict = {"label": label, "index": container_index, "path": str(path), "members": []}
        self.report["containers"].append(record)
        try:
            record["sha256"] = sha256_file(path)
            with zipfile.ZipFile(path) as archive:
                infos = archive.infolist()
                dex = [info for info in infos if info.filename.lower().endswith(".dex")]
                names = [info.filename for info in dex]
                for name in names:
                    if not MEMBER_RE.fullmatch(name):
                        raise Incomplete(f"unsafe dex member name {name!r}")
                if len(set(names)) != len(names):
                    raise Incomplete("duplicate dex member names")
                if not dex:
                    record["status"] = "STRIPPED"
                    raise Incomplete("STRIPPED: no classes*.dex member")
                if len(dex) > LIMITS["dexMembersPerContainer"]:
                    raise Incomplete("bound dexMembersPerContainer exceeded")
                if sum(info.file_size for info in dex) > LIMITS["containerDexBytes"]:
                    raise Incomplete("bound containerDexBytes exceeded")
                for info in sorted(dex, key=lambda item: _member_order(item.filename)):
                    if info.file_size > LIMITS["dexMemberBytes"]:
                        raise Incomplete(f"bound dexMemberBytes exceeded by {info.filename}")
                    self.scan_member(record, container_index, archive, info, targets, dexdump, found)
        except (Incomplete, zipfile.BadZipFile, OSError) as ex:
            record.setdefault("status", "INCOMPLETE")
            record["error"] = str(ex)
            self.incomplete(f"container {label}[{container_index}]: {ex}")
            return False
        record["status"] = "COMPLETE"
        return True

    def scan_member(self, record, container_index, archive, info, targets, dexdump, found) -> None:
        local = self.tmp / f"{container_index}-{info.filename}"
        written = 0
        with archive.open(info) as source, open(local, "wb") as sink:
            for chunk in iter(lambda: source.read(MIB), b""):
                written += len(chunk)
                if written > info.file_size:
                    break
                sink.write(chunk)
        self.temp += written
        self.check_temp()
        if written != info.file_size:
            raise Incomplete(f"{info.filename}: written {written} != declared {info.file_size}")
        data = local.read_bytes()
        member = {"name": info.filename, "sha256": sha256(data), "bytes": len(data)}
        record["members"].append(member)
        descriptors = parse_dex_class_defs(data)
        member["classDefs"] = len(descriptors)
        hits = [d for d in descriptors if d in targets]
        if hits:
            if dexdump is None:
                raise Incomplete("dexdump unavailable for target-defining member")
            check = self.run([dexdump, "-c", str(local)], LIMITS["dexdumpSeconds"])
            member["checksumExit"] = check.returncode
            if check.returncode != 0:
                raise Incomplete(f"{info.filename}: dexdump -c exit {check.returncode}")
            dump = self.tmp / f"{container_index}-{info.filename}.dump"
            result = self.run([dexdump, "-f", "-d", "-l", "plain", "-o", str(dump), str(local)],
                              LIMITS["dexdumpSeconds"])
            member["dumpExit"] = result.returncode
            if result.returncode != 0 or not dump.is_file():
                raise Incomplete(f"{info.filename}: dexdump -f -d exit {result.returncode}")
            size = dump.stat().st_size
            self.temp += size
            if size > LIMITS["dumpBytes"]:
                self.report["boundsHit"].append("dumpBytes")
                raise Incomplete(f"{info.filename}: bound dumpBytes exceeded")
            self.check_temp()
            blocks = parse_dexdump_blocks(dump)
            if [block[0] for block in blocks] != descriptors:
                raise Incomplete(f"{info.filename}: dexdump blocks ({len(blocks)}) != class_defs ({len(descriptors)})")
            (self.prov / "dexdump").mkdir(parents=True, exist_ok=True)
            with open(dump, "rb") as handle:
                for descriptor, start, end in blocks:
                    if descriptor not in targets:
                        continue
                    if end - start > LIMITS["classBlockBytes"]:
                        self.report["boundsHit"].append("classBlockBytes")
                        raise Incomplete(f"bound classBlockBytes exceeded for {descriptor!r}")
                    handle.seek(start)
                    block = handle.read(end - start)
                    safe = f"{container_index}-{info.filename}-{sha256(descriptor)[:16]}"
                    (self.prov / "dexdump" / f"{safe}.txt").write_bytes(block)
                    self.index[safe] = {
                        "descriptor": descriptor.decode("utf-8", "backslashreplace"), "container": record["path"],
                        "containerLabel": record["label"], "containerIndex": container_index,
                        "containerSha256": record["sha256"], "member": info.filename, "memberSha256": member["sha256"],
                        "toolSha256": self.report.get("tool", {}).get("sha256"), "checksumExit": check.returncode,
                        "dumpExit": result.returncode, "blockSha256": sha256(block), "blockStart": start,
                        "blockEnd": end,
                    }
            dump.unlink()
            self.temp -= size
        for descriptor in hits:
            found.setdefault(descriptor, []).append({"container": record["label"], "index": container_index,
                                                     "member": info.filename})
        local.unlink()
        self.temp -= written

    def resolve_targets(self, scope, required, optional, found, complete, mapping) -> None:
        for descriptor in (*required, *optional):
            name = descriptor.decode("utf-8")
            occurrences = found.get(descriptor, [])
            entry = {"scope": scope, "required": descriptor in required, "occurrences": occurrences}
            if scope == "apk" and len(occurrences) > 1:
                entry["status"] = "DUPLICATE"
            elif occurrences:
                entry["status"] = "FOUND"
                entry["selected"] = occurrences[0]
            elif scope == "apk" and mapping is not None and (
                    name[1:-1].replace("/", ".") in mapping[1]
                    or (descriptor in required and name[1:-1].replace("/", ".") not in mapping[0])):
                entry["status"] = "REMOVED-BY-R8"
            elif scope == "apk" and mapping is None:
                entry["status"] = "MAPPING-UNAVAILABLE"
            elif descriptor in optional and complete:
                entry["status"] = "ABSENT"
            else:
                entry["status"] = "MISSING" if complete else "NOT-SCANNED-COMPLETELY"
            self.report["targets"][f"{scope}:{name}"] = entry
            if entry["status"] not in ("FOUND", "ABSENT"):
                self.incomplete(f"target {scope}:{name} {entry['status']}")

    def backend(self) -> None:
        factories = []
        for method in METHODS:
            try:
                lines = (self.out / "raw" / f"{method}.txt").read_bytes().decode("utf-8").split("\n")
            except (OSError, UnicodeDecodeError):
                lines = []
            matches = [LOGGING_RE.fullmatch(line) for line in lines]
            matches = [m.groups() for m in matches if m]
            factories.append(matches[0] if len(matches) == 1 else None)
        if all(item is not None for item in factories) and len(set(factories)) == 1:
            self.report["backend"] = {"status": "OBSERVED", "factory": factories[0][0], "loader": factories[0][1]}
        else:
            self.report["backend"] = {"status": "OPEN"}
            self.incomplete("backend: runtime logging line missing, duplicated or inconsistent across carriers")

    def collect(self) -> None:
        self.prov.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(self.tmp, ignore_errors=True)
        self.tmp.mkdir(parents=True)
        dexdump = self.tool()
        self.boot_identity()
        self.backend()
        apk = self.host_apk()
        mapping = self.mapping()
        self.installed_apk(self.report["apk"].get("sha256"))
        apk_found: dict[bytes, list[dict]] = {}
        apk_complete = apk is not None and self.scan("host-apk", "apk", apk, set(APK_REQUIRED + APK_OPTIONAL),
                                                     dexdump, apk_found)
        self.resolve_targets("apk", APK_REQUIRED, APK_OPTIONAL, apk_found, apk_complete, mapping)
        boot_found: dict[bytes, list[dict]] = {}
        entries = self.bootclasspath()
        boot_complete = bool(entries) and len(entries) == len(self.report.get("bootclasspath", []))
        for index, entry, local in entries:
            boot_complete &= self.scan(entry, f"bcp{index:02d}", local, set(BOOT_REQUIRED + BOOT_OPTIONAL),
                                       dexdump, boot_found)
            local.unlink(missing_ok=True)
        self.resolve_targets("boot", BOOT_REQUIRED, BOOT_OPTIONAL, boot_found, boot_complete, None)

    def finalize(self, internal: str | None) -> int:
        status, code = ("COMPLETE", 0) if not self.reasons and internal is None else ("PROVENANCE-INCOMPLETE", 40)
        if internal is not None:
            status, code = "PROVENANCE-INTERNAL", 41
            self.report["internal"] = internal
        (self.prov / "dexdump-index.json").write_text(json.dumps(self.index, indent=2, sort_keys=True) + "\n",
                                                      encoding="utf-8")
        uploaded = sum(p.stat().st_size for p in self.prov.rglob("*") if p.is_file())
        if uploaded > LIMITS["uploadBytes"] and status == "COMPLETE":
            self.report["boundsHit"].append("uploadBytes")
            self.reasons.append("bound uploadBytes exceeded")
            status, code = "PROVENANCE-INCOMPLETE", 40
        self.report.update({"finalized": True, "status": status, "collectorExit": code, "reasons": self.reasons,
                            "pulledBytes": self.pulled, "uploadedBytes": uploaded})
        temporary = self.prov / "provenance.json.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(self.report, indent=2, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.prov / "provenance.json")
        print(f"D2-N4-PROVENANCE status={status} exit={code} reasons={len(self.reasons)}")
        return code


def main(argv: list[str]) -> int:
    if len(argv) != 4 or (argv[0], argv[1]) not in ALLOWED_CASES or not NONCE_RE.fullmatch(argv[2]):
        print("usage: d2_n4_provenance.py API ARCH NONCE OUT_DIR (29 x86 | 36 x86_64)", file=sys.stderr)
        return 41
    collector = Collector(argv[0], argv[1], argv[2], pathlib.Path(argv[3]))
    signal.signal(signal.SIGTERM, _on_term)
    internal = None
    try:
        collector.collect()
    except Terminated:
        collector.reasons.append("terminated")
    except Deadline:
        collector.reasons.append("deadline")
    except Exception as ex:  # noqa: BLE001 - recorded as PROVENANCE-INTERNAL, never success
        internal = f"{ex.__class__.__name__}: {ex}"
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try:
        return collector.finalize(internal)
    except Exception:  # noqa: BLE001 - the wrapper records no-finalized-report
        return 41
    finally:
        shutil.rmtree(collector.tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
