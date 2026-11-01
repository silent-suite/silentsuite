#!/usr/bin/env bash
# D2 N2: runs the shared positive legacy-recorder floor on the emulator inside the product debug APK, then always
# collects and validates the schema-1 carriers (D2-ART-CHECKPOINT-SPEC-v3 §3-§5 as amended by v4 §2).
# Evidence collection only; no restriction, no production reader change, no ART success/safety claim.
set -uo pipefail                                   # deliberately NO -e: both statuses must be captured

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || exit 2
android_root="$(cd -- "${script_dir}/.." && pwd)" || exit 2
cd "${android_root}" || exit 2                     # anchor: android/

api="${1:?usage: run-legacy-recorder-runtime.sh API_LEVEL ARCH}"
arch="${2:?usage: run-legacy-recorder-runtime.sh API_LEVEL ARCH}"
case "${api}:${arch}" in
  29:x86|36:x86_64) ;;
  *) echo "unsupported matrix case ${api}:${arch}" >&2; exit 2 ;;
esac
command -v timeout >/dev/null 2>&1 || { echo "timeout(1) is required" >&2; exit 2; }

package="io.silentsuite.android"
nonce="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${api}-${arch}-${RANDOM}"
[[ "${nonce}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid nonce ${nonce}" >&2; exit 2; }
out="app/build/outputs/androidTest-results/d2-legacy-recorder/${nonce}"
rm -rf -- "${out}"
mkdir -p -- "${out}/raw" || exit 2

if adb shell pm path "${package}" >/dev/null 2>&1; then
  adb shell run-as "${package}" rm -rf "files/d2-legacy-recorder/${nonce}" || true
fi

timeout --signal=TERM --kill-after=10s 900s \
  ./gradlew app:connectedDebugAndroidTest --no-daemon \
  -PrequireEtebase16Kb=true \
  -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true \
  -Pandroid.testInstrumentationRunnerArguments.class=io.silentsuite.sync.resource.LegacyUnknownPropertyRecorderRuntimeTest \
  -Pandroid.testInstrumentationRunnerArguments.d2RecorderNonce="${nonce}"
gradle_status=$?

python3 - "${api}" "${arch}" "${nonce}" "${out}" "${gradle_status}" <<'PY'
import collections, glob, hashlib, json, pathlib, re, subprocess, sys, urllib.parse

api_arg, arch, nonce, out_dir, gradle_status = sys.argv[1:]
api = int(api_arg)
out = pathlib.Path(out_dir)
PACKAGE = "io.silentsuite.android"
REMOTE_DIR = f"files/d2-legacy-recorder/{nonce}"
METHOD_GROUP = {
    "testLegacyRecorder_RoutedPropertyFamilies_RoundTrip": "routed-properties",
    "testLegacyRecorder_ClazzForms_RoundTrip": "clazz",
    "testLegacyRecorder_DefaultParameterFamilies_RoundTrip": "default-parameters",
    "testLegacyRecorder_DateTimeValueShapes_RoundTrip": "date-time-shapes",
    "testLegacyRecorder_ParsedEventUnknownProperties_RoundTrip": "parsed-event",
}
GROUP_COUNTS = {"routed-properties": 44, "clazz": 3, "default-parameters": 30, "date-time-shapes": 11, "parsed-event": 16}
FLOOR_KEYS_SHA256 = "3c98b7fbae9451bdd81710fdcf1fd00487258c1fe5409a2c2a3c10b6c00ba43c"
FLOOR_KEYS = [
# D2-FLOOR-KEYS-BEGIN
    ("clazz", "CLASS", "custom-value"),
    ("clazz", "CLASS", "factory-confidential"),
    ("clazz", "CLASS", "shared-constant"),
    ("date-time-shapes", "CREATED", "utc"),
    ("date-time-shapes", "DUE", "date"),
    ("date-time-shapes", "DUE", "floating"),
    ("date-time-shapes", "DUE", "parsed-value-date"),
    ("date-time-shapes", "DUE", "tzid-ical4j-timezone"),
    ("date-time-shapes", "DUE", "utc"),
    ("date-time-shapes", "FREEBUSY", "period-list"),
    ("date-time-shapes", "REFRESH-INTERVAL", "duration"),
    ("date-time-shapes", "TRIGGER", "date-time"),
    ("date-time-shapes", "TRIGGER", "duration"),
    ("date-time-shapes", "TZOFFSETFROM", "utc-offset"),
    ("default-parameters", "param:Abbrev", "on-x-property"),
    ("default-parameters", "param:AltRep", "on-x-property"),
    ("default-parameters", "param:Cn", "on-x-property"),
    ("default-parameters", "param:CuType", "on-x-property"),
    ("default-parameters", "param:DelegatedFrom", "on-x-property"),
    ("default-parameters", "param:DelegatedTo", "on-x-property"),
    ("default-parameters", "param:Dir", "on-x-property"),
    ("default-parameters", "param:Display", "on-x-property"),
    ("default-parameters", "param:Email", "on-x-property"),
    ("default-parameters", "param:Encoding", "on-x-property"),
    ("default-parameters", "param:FbType", "on-x-property"),
    ("default-parameters", "param:Feature", "on-x-property"),
    ("default-parameters", "param:FmtType", "on-x-property"),
    ("default-parameters", "param:Label", "on-x-property"),
    ("default-parameters", "param:Language", "on-x-property"),
    ("default-parameters", "param:Member", "on-x-property"),
    ("default-parameters", "param:PartStat", "on-x-property"),
    ("default-parameters", "param:Range", "on-x-property"),
    ("default-parameters", "param:RelType", "on-x-property"),
    ("default-parameters", "param:Related", "on-x-property"),
    ("default-parameters", "param:Role", "on-x-property"),
    ("default-parameters", "param:Rsvp", "on-x-property"),
    ("default-parameters", "param:ScheduleAgent", "on-x-property"),
    ("default-parameters", "param:ScheduleStatus", "on-x-property"),
    ("default-parameters", "param:SentBy", "on-x-property"),
    ("default-parameters", "param:Type", "on-x-property"),
    ("default-parameters", "param:TzId", "on-x-property"),
    ("default-parameters", "param:Value", "on-x-property"),
    ("default-parameters", "param:Vvenue", "on-x-property"),
    ("default-parameters", "param:XParameter", "on-x-property"),
    ("parsed-event", "ATTACH", "parsed-4"),
    ("parsed-event", "COMMENT", "parsed-5"),
    ("parsed-event", "CONFERENCE", "parsed-11"),
    ("parsed-event", "CONTACT", "parsed-9"),
    ("parsed-event", "CREATED", "parsed-0"),
    ("parsed-event", "DUE", "parsed-1"),
    ("parsed-event", "FOO-BAR", "parsed-15"),
    ("parsed-event", "GEO", "parsed-3"),
    ("parsed-event", "IMAGE", "parsed-12"),
    ("parsed-event", "PRIORITY", "parsed-7"),
    ("parsed-event", "REFRESH-INTERVAL", "parsed-13"),
    ("parsed-event", "RELATED-TO", "parsed-8"),
    ("parsed-event", "REQUEST-STATUS", "parsed-10"),
    ("parsed-event", "RESOURCES", "parsed-6"),
    ("parsed-event", "URL", "parsed-2"),
    ("parsed-event", "X-SILENTSUITE-TEST", "parsed-14"),
    ("routed-properties", "ACKNOWLEDGED", "utc"),
    ("routed-properties", "ACTION", "text"),
    ("routed-properties", "ATTACH", "binary"),
    ("routed-properties", "ATTACH", "uri"),
    ("routed-properties", "BUSYTYPE", "text"),
    ("routed-properties", "CALSCALE", "text"),
    ("routed-properties", "COMMENT", "text-altrep-language"),
    ("routed-properties", "COMPLETED", "utc"),
    ("routed-properties", "CONFERENCE", "uri-feature-label"),
    ("routed-properties", "CONTACT", "text"),
    ("routed-properties", "COUNTRY", "text"),
    ("routed-properties", "CREATED", "utc"),
    ("routed-properties", "DUE", "utc"),
    ("routed-properties", "EXTENDED-ADDRESS", "text"),
    ("routed-properties", "FREEBUSY", "period-list"),
    ("routed-properties", "GEO", "decimal"),
    ("routed-properties", "IMAGE", "binary"),
    ("routed-properties", "IMAGE", "uri"),
    ("routed-properties", "LOCALITY", "text"),
    ("routed-properties", "LOCATION-TYPE", "list"),
    ("routed-properties", "METHOD", "text"),
    ("routed-properties", "NAME", "text"),
    ("routed-properties", "PERCENT-COMPLETE", "integer"),
    ("routed-properties", "POSTAL-CODE", "text"),
    ("routed-properties", "PRIORITY", "integer"),
    ("routed-properties", "REFRESH-INTERVAL", "duration"),
    ("routed-properties", "REGION", "text"),
    ("routed-properties", "RELATED-TO", "text-reltype"),
    ("routed-properties", "REPEAT", "integer"),
    ("routed-properties", "REQUEST-STATUS", "text"),
    ("routed-properties", "RESOURCES", "text-list"),
    ("routed-properties", "SOURCE", "uri"),
    ("routed-properties", "STREET-ADDRESS", "text"),
    ("routed-properties", "TEL", "text"),
    ("routed-properties", "TRIGGER", "date-time"),
    ("routed-properties", "TRIGGER", "duration"),
    ("routed-properties", "TZID", "text"),
    ("routed-properties", "TZNAME", "text"),
    ("routed-properties", "TZOFFSETFROM", "utc-offset"),
    ("routed-properties", "TZOFFSETTO", "utc-offset"),
    ("routed-properties", "TZURL", "uri"),
    ("routed-properties", "URL", "uri"),
    ("routed-properties", "VERSION", "text"),
    ("routed-properties", "X-SILENTSUITE-TEST", "x-property-x-parameter"),
# D2-FLOOR-KEYS-END
]

P = r"[A-Za-z0-9._~%-]*"
BEGIN_RE = re.compile(rf"^D2-RECORDER-BEGIN schema=1 method=({P}) group=({P}) nonce=({P}) package=({P}) versionCode=(\d+) "
                      rf"versionName=({P}) sdk=(\d+) abi=({P}) fingerprint=({P}) securityPatch=({P}) vm=({P})$")
END_RE = re.compile(rf"^D2-RECORDER-END schema=1 method=({P}) group=({P}) nonce=({P}) package=({P}) lines=(\d+) records=(\d+) "
                    r"failures=(\d+) keysSha256=([0-9a-f]{64}) status=(PASS|FAIL) sha256=([0-9a-f]{64})$")
RECORD_RE = re.compile(r"^D2-RECORDER group=(\S+) family=(\S+) variant=(\S+) (class=\S+ descriptors=\S*|status=FAILED error=.*)$")
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")
UNRESERVED = set(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

def pct(value):
    return "".join(chr(b) if b in UNRESERVED else "%%%02X" % b for b in value.encode("utf-8"))

def unpct(raw):
    value = urllib.parse.unquote_to_bytes(raw).decode("utf-8")
    if pct(value) != raw:
        raise ValueError(f"non-canonical percent encoding: {raw}")
    return value

def canonical_sha256(keys):
    encoded = sorted("\t".join(key).encode("utf-8") for key in keys)
    return hashlib.sha256(b"".join(item + b"\n" for item in encoded)).hexdigest()

def adb(*args, binary=False):
    return subprocess.run(["adb", *args], check=False, capture_output=True, text=not binary, timeout=120)

report = {"schema": 1, "expected": {"api": api, "arch": arch}, "nonce": nonce, "package": PACKAGE,
          "gradleStatus": int(gradle_status), "collection": {}, "files": {}, "identity": {}, "semantic": {},
          "classification": "INTERNAL", "exit": 30}

def finish(classification, code):
    report["classification"] = classification
    report["exit"] = code
    (out / "validation.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"D2-VALIDATION classification={classification} exit={code}")
    sys.exit(code)

try:
    if canonical_sha256(FLOOR_KEYS) != FLOOR_KEYS_SHA256 or len(FLOOR_KEYS) != 104 or len(set(FLOOR_KEYS)) != 104 \
            or dict(collections.Counter(k[0] for k in FLOOR_KEYS)) != GROUP_COUNTS:
        report["internal"] = "pinned floor self-check failed"
        finish("INTERNAL", 30)

    expected_files = {f"{method}.txt" for method in METHOD_GROUP}
    infra = []

    # Stage A: collect (always attempted; raw bytes saved before any parsing)
    pm = adb("shell", "pm", "path", PACKAGE)
    installed = pm.returncode == 0 and any(line.startswith("package:") for line in pm.stdout.splitlines())
    report["collection"]["installed"] = installed
    # -a: leftover dot-prefixed temp carriers must be visible so that they fail the exact file-set check
    listing = adb("exec-out", "run-as", PACKAGE, "ls", "-a", REMOTE_DIR) if installed else None
    remote = sorted({n.strip() for n in listing.stdout.splitlines() if n.strip() and n.strip() not in (".", "..")}) \
        if listing and listing.returncode == 0 else []
    report["collection"]["listing"] = remote
    if not installed:
        infra.append("target package not installed")
    elif listing.returncode != 0:
        infra.append(f"remote listing failed: {listing.stderr.strip()}")
    raw = {}
    for name in remote:
        if not SAFE_NAME.fullmatch(name):
            infra.append(f"unsafe remote name: {name!r}")
            continue
        fetched = adb("exec-out", "run-as", PACKAGE, "cat", f"{REMOTE_DIR}/{name}", binary=True)
        if fetched.returncode != 0:
            infra.append(f"cat failed for {name}")
            continue
        (out / "raw" / name).write_bytes(fetched.stdout)
        raw[name] = fetched.stdout
        report["collection"].setdefault("rawSha256", {})[name] = hashlib.sha256(fetched.stdout).hexdigest()
    if set(remote) != expected_files:
        infra.append(f"remote file set mismatch: {remote} != {sorted(expected_files)}")

    # Identity inputs from host side
    metadata = []
    for path in glob.glob("app/build/outputs/apk/**/output-metadata.json", recursive=True):
        try:
            item = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if item.get("applicationId") == PACKAGE:
            metadata.append(item)
    meta_versions = {(int(m["elements"][0]["versionCode"]), m["elements"][0]["versionName"]) for m in metadata if m.get("elements")}
    dump = adb("shell", "dumpsys", "package", PACKAGE).stdout if installed else ""
    code_match = re.search(r"\bversionCode=(\d+)\b", dump)
    name_match = re.search(r"\bversionName=([^\s]+)", dump)
    device_sdk = adb("shell", "getprop", "ro.build.version.sdk").stdout.strip()
    device_abi = adb("shell", "getprop", "ro.product.cpu.abi").stdout.strip()
    report["identity"] = {"metadataApplicationIds": len(metadata), "metadataVersions": sorted(map(list, meta_versions)),
                          "dumpsysVersionCode": code_match.group(1) if code_match else None,
                          "dumpsysVersionName": name_match.group(1) if name_match else None,
                          "getpropSdk": device_sdk, "getpropAbi": device_abi}
    if len(meta_versions) != 1:
        infra.append(f"target application output metadata not unique: {sorted(meta_versions)}")
    if code_match is None or name_match is None:
        infra.append("missing installed package version identity")
    if device_sdk != str(api) or device_abi != arch:
        infra.append(f"device identity {device_sdk}/{device_abi} != expected {api}/{arch}")

    observed = {}
    total_failures = 0
    for name in sorted(expected_files):
        method = name[:-len(".txt")]
        group = METHOD_GROUP[method]
        errors = []
        entry = {"method": method, "group": group}
        report["files"][name] = entry
        data = raw.get(name)
        if data is None:
            entry["errors"] = ["not collected"]
            infra.append(f"{name}: not collected")
            continue
        # Stage B: carrier integrity
        try:
            if data.startswith(b"\xef\xbb\xbf"): raise ValueError("BOM present")
            if b"\r" in data: raise ValueError("CR present")
            if not data.endswith(b"\n"): raise ValueError("not LF-terminated")
            text = data.decode("utf-8")
            lines = text[:-1].split("\n")
            if sum(l.startswith("D2-RECORDER-BEGIN ") for l in lines) != 1 or not lines[0].startswith("D2-RECORDER-BEGIN "):
                raise ValueError("BEGIN is not the single first line")
            if sum(l.startswith("D2-RECORDER-END ") for l in lines) != 1 or not lines[-1].startswith("D2-RECORDER-END "):
                raise ValueError("END is not the single last line")
            begin, end = BEGIN_RE.fullmatch(lines[0]), END_RE.fullmatch(lines[-1])
            if begin is None or end is None: raise ValueError("BEGIN/END schema-1 field order mismatch")
            b = [unpct(v) if i not in (4, 6) else v for i, v in enumerate(begin.groups())]
            e = [unpct(v) if i < 4 else v for i, v in enumerate(end.groups())]
            prefix = data[:len(data) - len(lines[-1].encode("utf-8")) - 1]
            records = [RECORD_RE.fullmatch(l) for l in lines[1:-1]]
            records = [r for r in records if r is not None]
            keys = [(r.group(1), r.group(2), r.group(3)) for r in records]
            failures = sum(r.group(4).startswith("status=FAILED") for r in records)
            if hashlib.sha256(prefix).hexdigest() != e[9]: errors.append("sha256 mismatch")
            if int(e[4]) != len(lines) - 1: errors.append("lines mismatch")
            if int(e[5]) != len(records): errors.append("records mismatch")
            if int(e[6]) != failures: errors.append("failures mismatch")
            if canonical_sha256(keys) != e[7]: errors.append("keysSha256 mismatch")
            if b[:4] != e[:4]: errors.append("BEGIN/END method/group/nonce/package disagree")
            if b[0] != method or b[1] != group: errors.append("method/group mismatch")
            if any(k[0] != group for k in keys): errors.append("record group mismatch")
        except (ValueError, UnicodeDecodeError) as ex:
            errors.append(f"integrity: {ex}")
            b = e = None
        # Stage C: identity
        if b is not None:
            entry.update({"begin": {"versionCode": b[4], "versionName": b[5], "sdk": b[6], "abi": b[7],
                                    "fingerprint": b[8], "securityPatch": b[9], "vm": b[10]},
                          "status": e[8], "records": int(e[5]), "failures": int(e[6])})
            if b[3] != PACKAGE: errors.append("package mismatch")
            if b[2] != nonce: errors.append("nonce mismatch")
            if (int(b[4]), b[5]) not in meta_versions: errors.append("version != output metadata")
            if code_match is None or name_match is None or b[4] != code_match.group(1) or b[5] != name_match.group(1):
                errors.append("version != dumpsys")
            if b[6] != str(api) or b[6] != device_sdk: errors.append("sdk mismatch")
            if b[7] != arch or b[7] != device_abi: errors.append("abi mismatch")
        entry["errors"] = errors
        if errors:
            infra.extend(f"{name}: {err}" for err in errors)
        else:
            observed[group] = keys
            total_failures += failures

    report["infra"] = infra
    if infra:
        finish("INFRA-INCOMPLETE", 10)

    # Stage D: semantic comparison with the pinned floor (never modifies it)
    divergence = {}
    for group in GROUP_COUNTS:
        want = collections.Counter(k for k in FLOOR_KEYS if k[0] == group)
        got = collections.Counter(observed.get(group, []))
        if want != got:
            divergence[group] = {"missing": sorted(map(list, (want - got).elements())),
                                 "extra": sorted(map(list, (got - want).elements())),
                                 "expected": sum(want.values()), "observed": sum(got.values())}
    report["semantic"] = {"divergence": divergence, "failures": total_failures,
                          "observedRecords": sum(len(v) for v in observed.values()), "floorRecords": len(FLOOR_KEYS)}
    if divergence and total_failures:
        finish("FIXTURE-DIVERGENCE+ART-COMPAT", 22)
    if divergence:
        finish("FIXTURE-DIVERGENCE", 20)
    if total_failures:
        finish("ART-COMPAT", 21)
    finish("PASS", 0)
except SystemExit:
    raise
except Exception as ex:  # internal validator error: best-effort report, then 30
    report["internal"] = f"{type(ex).__name__}: {ex}"
    try:
        finish("INTERNAL", 30)
    except OSError:
        sys.exit(30)
PY
validator_status=$?

# D2-N4-PROVENANCE-TAIL-BEGIN
# D2 N4 provenance (SPEC-v2 as amended by SPEC-v3): always attempted after the validator returns; bounded; an
# interrupted or non-finalized collection is PROVENANCE-INCOMPLETE (40), never COMPLETE. Precedence: Gradle ->
# validator -> provenance. Cleanup/report are best-effort under uncatchable termination.
timeout --signal=TERM --kill-after="${D2_N4_KILL_AFTER_S:-15}s" "${D2_N4_TIMEOUT_S:-600}s" \
  python3 scripts/d2_n4_provenance.py "${api}" "${arch}" "${nonce}" "${out}"
provenance_raw=$?
report="${out}/provenance/provenance.json"
provenance_status="${provenance_raw}"
if [[ "${provenance_raw}" -eq 124 || "${provenance_raw}" -eq 137 || "${provenance_raw}" -eq 143 ]]; then
  provenance_status=40; reason="forced-termination"
elif ! python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get("finalized") is True and r.get("collectorExit")==int(sys.argv[2]) and (r.get("status")=="COMPLETE")==(int(sys.argv[2])==0) else 1)' \
       "${report}" "${provenance_raw}" 2>/dev/null; then
  provenance_status=40; reason="no-finalized-report"
else
  reason="finalized"
fi
if [[ "${reason}" != "finalized" ]]; then
  mkdir -p "${out}/provenance" 2>/dev/null
  printf '{"schema":"d2-n4-provenance-fallback-1","status":"PROVENANCE-INCOMPLETE","reason":"%s","collectorRaw":%d}\n' \
    "${reason}" "${provenance_raw}" > "${out}/provenance/provenance-fallback.json" 2>/dev/null || true
fi
rm -rf -- "${RUNNER_TEMP:-/tmp}/d2-n4-${nonce}" 2>/dev/null || true
echo "D2-STATUS api=${api} arch=${arch} nonce=${nonce} gradle=${gradle_status} validator=${validator_status} provenance=${provenance_status} provenanceRaw=${provenance_raw} provenanceReason=${reason}"
if [[ "${gradle_status}" -ne 0 ]]; then exit "${gradle_status}"; fi            # primary: test/build outcome
if [[ "${validator_status}" -ne 0 ]]; then exit "${validator_status}"; fi      # then: carrier/semantic outcome
exit "${provenance_status}"                                                    # then: N4 provenance outcome
# D2-N4-PROVENANCE-TAIL-END
