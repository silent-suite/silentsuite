# Android tracker and network verification

SilentSuite's Android policy prohibits analytics, advertising, attribution, install-referrer, device-identifier, and crash-reporting runtime integrations. These checks are release guardrails, not telemetry.

## Static artifact gate

`security/tracker-signatures.json` is the reviewed, versioned policy. It covers dependency coordinates, Java/Kotlin packages, collection domains, manifest components/metadata, advertising and identifier APIs, DEX signatures, and native strings/symbols. Every category has a positive fixture under `security/fixtures/tracker-scan/positive`; the clean fixture must pass.

`scan-tracker-signatures.py` uses only Python's standard library. It scans ordinary files and recursively scans ZIP-compatible APK, AAB, APKS/split APK, AAR, JAR, DEX, resource, manifest, mapping, dependency-report, and native-library payloads. A match is blocking even if code is dormant, disabled, obfuscated, or believed unreachable.

The Android build workflow gates:

- debug APK, unsigned release APK, and unsigned release AAB on PR/dev/main;
- signed release APK and AAB before tag artifacts are attached;
- bundletool 1.18.1, verified by its pinned SHA-256, to generate local split/universal APK evidence;
- debug/release runtime dependency graphs, merged/intermediate manifests, mapping/resource outputs, packaged archives, DEX bytes, and native strings;
- the existing 16 KiB ELF alignment check.

Evidence is uploaded as `android-tracker-scan-<sha>` with bounded retention. It includes dependency/build metadata, archive/split inventory, SHA-256 hashes, and a sanitized scanner summary. It must never include signing files, credentials, or app data.

### Exceptions and review

An exception must be a narrow `exceptions` record in the manifest with an exact signature ID, path regex, rationale, owner, review date, and expiry date. Unknown, incomplete, malformed, or expired exceptions fail closed. Exceptions are not wildcard policy waivers. Changes require security/privacy review and new or updated fixtures.

The scheduled quarterly workflow reruns fixtures and fails when `review_due` has passed. Reviewers must compare the registry against current dependency graphs, Exodus/TrackerControl tracker catalogs, Android advertising/identifier APIs, and newly adopted native libraries, then update `reviewed_on` and `review_due` in the same reviewed change.

## UID-scoped network evidence

Network evidence is a protected manual release/privacy-claim gate because authenticated scenarios require a dedicated test account and interactive emulator actions. Use an isolated emulator restored from a clean snapshot, controlled DNS, no unrelated apps, and an app-UID-aware VPN/proxy or packet-capture facility. Record the installed APK SHA-256 and discover the app UID with `adb shell dumpsys package io.silentsuite.sync` (the `userId=` value). Filter by that UID; a machine-wide capture is not acceptable evidence.

Exercise all scenarios separately:

1. `clean_launch` after clean install (must make zero outbound requests)
2. `idle_5m`
3. `account_setup`
4. `login`
5. `foreground_sync`
6. `background_sync`
7. `network_failure` using a deliberate DNS/auth/network failure
8. `logout`

The sanitized JSONL has one row per UID/destination/scenario:

```json
{"scenario":"foreground_sync","uid":10123,"host":"<user-selected-server>","requests":2}
```

Use `host:null` and `requests:0` when no request occurred. Normalize the dedicated configured auth/sync host to `<user-selected-server>` after confirming the raw destination. Compare every destination to `security/android-network-endpoints.txt`. Plausible, Telegram, advertising, crash, and analytics destinations are prohibited. Never normalize an unexpected destination into the placeholder.

Before dispatching `.github/workflows/android-network-evidence.yml`, place **only** the sanitized JSONL in the protected `android-network-evidence` environment secret `ANDROID_NETWORK_EVIDENCE_JSONL`. Supply the exact tested APK SHA-256, the one app UID, the raw-capture SHA-256, an opaque restricted evidence record ID, and a named accountable human owner. The checker rejects malformed digests and mixed/mismatched UIDs, hashes the JSONL, and binds those values in sanitized provenance.

**Raw PCAP must never be placed in a public-repository secret or GitHub artifact.** The named owner stores it outside GitHub in access-controlled storage whose ACL limits access to approved security/privacy reviewers and whose retention/deletion policy is enforceable. The public artifact contains only the opaque record ID and digest, never a storage URL, credential, packet bytes, or account data. Before approval, that owner must attest that the raw digest matches provenance, the installed APK digest matches provenance, `dumpsys package` matches the single recorded UID, the capture was filtered to that UID, and destinations were transcribed without normalizing unexpected hosts away. If any correlation cannot be demonstrated, the evidence gate fails and the privacy claim/channel rollout remains blocked.

The workflow creates only `android-network-summary-<sha>`: sanitized endpoint/scenario/UID summary, digest-bound provenance, opaque restricted-record ID, owner, and checklist attestations, retained 30 days. GitHub Actions does not receive or upload the raw capture.

Use only a dedicated fixture account configured in the owner-controlled capture environment. Never use customer credentials. Raw capture must exclude request bodies, passwords, tokens, PIM content, and TLS key material.

## External artifacts and limitations

Play-generated and F-Droid-built outputs are owner-operated post-build gates because this repository cannot fetch or reproduce those final channel artifacts during ordinary CI. The **SilentSuite Android release owner** is accountable for each channel record. Before a privacy claim or rollout, the owner must download the exact channel-delivered APK/APKS, record channel, version, package name, retrieval time, source URL/build ID, SHA-256 and signing-certificate SHA-256, run this scanner against the downloaded final package and extracted splits, attach the sanitized scanner summary to the release evidence, and record pass/fail. A missing digest, certificate, split inventory, scanner result, or named owner blocks rollout. For F-Droid, compare the independently built APK against the submitted version/source and retain the F-Droid build/version reference; for Play, scan Play-generated delivery splits rather than substituting local bundletool output.

- Static signatures are defense in depth, not proof of absence. Reflection, encryption/encoding, runtime downloads, dynamic endpoint construction, obfuscation, and stripped/native code can evade string/signature inspection. Binary strings do not establish reachability.
- Local bundletool splits do not prove Play delivery behavior, and repository builds do not prove F-Droid infrastructure output.
- Network evidence proves only the exact artifact, OS/emulator, configuration, UID attribution method, and exercised scenarios. It cannot prove unexercised paths or future server behavior. TLS commonly hides paths/content, while DNS/SNI/proxy metadata may still expose destinations.
- Raw packet captures can contain account and network metadata even without bodies; keep them restricted and short-lived.
