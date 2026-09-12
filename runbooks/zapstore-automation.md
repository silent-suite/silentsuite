# Zapstore publication automation (dormant)

This lane publishes an already-published, eligible SilentSuite Android release to
Zapstore with the official `zsp` publisher. It is **disabled by default** and has
never been activated. Nothing in this document, the workflow, or the scripts
publishes anything until the activation steps at the end are completed by the
repository owner, each under its own approval.

The lane sits *after* the existing release controller. The controller still ends
at a complete draft release and the owner still publishes the GitHub release by
hand. That boundary is unchanged and this lane must never publish, edit, or move
a GitHub release.

## 1. Surface & sibling-path map

### Surfaces

| # | Surface | Authority / source of truth | Files |
|---|---------|-----------------------------|-------|
| S1 | Trigger: owner `repository_dispatch` (`silentsuite_zapstore_publish`) | Numeric owner account id compared before the payload is read; payload is exactly `release_id`, `release_tag`, `source_sha` | `.github/workflows/zapstore-publish.yml`, `scripts/zapstore/lib/dispatch.mjs` |
| S2 | Trigger: daily `schedule` reconciliation | Runs only on the protected default branch; enumerates exact published release ids with bounded pagination, never `latest` | workflow, `lib/github.mjs` |
| S3 | Activation switch | Repository variable `ZAPSTORE_AUTOMATION_ENABLED` must equal `enabled`; it is absent today | workflow `admit` job |
| S4 | Release eligibility | Tag grammar `vX.Y.Z` or `vX.Y.Z-beta`; draft refused; GitHub `prerelease=true` allowed only with a `-beta` tag | `lib/eligibility.mjs` |
| S5 | Exact release binding | Release id, tag, tag commit (annotated tags dereferenced), APK asset id, GitHub asset digest, sidecar `-installer.sha256`, `SHA256SUMS.txt` | `lib/github.mjs`, `lib/binding.mjs` |
| S6 | APK verification | Local bytes hashed and compared to all three GitHub digests; `apksigner verify --print-certs -v` must print `Verifies` and every signer must be the direct-release certificate; package, version, version code, certificate extracted by the official `zsp` in unsigned offline mode | `lib/apksigner.mjs`, `lib/zsp.mjs` |
| S7 | Store metadata | Trusted template at the protected revision; media bytes hashed; changelog taken from the release's own source commit by version code | `scripts/zapstore/release-template.json`, `lib/metadata.mjs` |
| S8 | Relay reconciliation before signing | `wss://relay.zapstore.dev`; completed subscription (EOSE) required; every event id and Schnorr signature verified | `lib/nostr.mjs`, `lib/reconcile.mjs` |
| S9 | Signing and upload | `zsp` 0.4.17 pinned by URL and SHA-256; `SIGN_WITH` from environment secret `ZAPSTORE_SIGN_WITH` (must be `bunker://`); NIP-46 client key from `ZAPSTORE_BUNKER_CLIENT_KEY` written 0600 and removed in a trap | `lib/zsp.mjs`, `lib/bunker-key.mjs` |
| S10 | Read-back | Same reconciliation must return `complete-match`; CDN bytes for APK, icon and six screenshots fetched and hashed | `lib/reconcile.mjs`, `lib/cdn.mjs` |
| S11 | Failure notification | Isolated job with `issues: write` only; structured body; read back after creation | `lib/notify.mjs` |
| S12 | Concurrency | One group for the whole app/publisher, `cancel-in-progress: false`; runs GitHub drops are recovered by the next schedule | workflow |

### Sibling paths (what happens on each neighbouring path)

| Path | Behaviour |
|------|-----------|
| Activation variable absent or not `enabled` | `admit` reports `DISABLED` in the job summary; all later jobs are skipped. No silent success: the summary says nothing was published. |
| Dispatch from a non-owner account | Refused before the payload is parsed. |
| Payload with extra, missing or malformed keys | Refused. |
| Dispatch or schedule running on a non-default ref | Refused (`GITHUB_REF` must be `refs/heads/main`). |
| Draft release | Ineligible; recorded, never published. |
| `vX.Y.Z-rc1`, `-alpha`, nightly | Ineligible. |
| `-beta` tag with GitHub `prerelease=true` | Eligible; channel stays `main` (existing relay history). |
| Stable tag with GitHub `prerelease=true` | Ineligible. |
| Release published before assets exist | Binding fails (APK, sidecar or `SHA256SUMS.txt` missing); notification asks to retry after assets are attached; the schedule retries automatically. |
| Tag moved / release deleted / id mismatch | Binding revalidation fails closed just before signing. |
| Wrong package, version, version code, certificate, size or hash | Fails closed before any signing. |
| Missing or unapproved screenshot set | Fails closed; the template requires exactly the six approved names in order. |
| Stale release notes | Notes come from `changelogs/<versionCode>.txt` at the release's own source commit and must be non-empty; the template never carries release text. |
| Relay timeout / disconnect / no EOSE | Treated as `incomplete`, never as absent; no signing. |
| Relay returns an event with an invalid id or signature | Fails closed. |
| Relay already holds the exact release, APK and matching app metadata | `complete-match`: nothing is signed, run succeeds with an explicit skip. |
| Relay holds part of the set, or a same-version event with a different hash | `partial` / `conflict`: fails closed with recovery instructions; no overwrite. |
| Relay holds a newer version than the candidate | `downgrade-refused`: a stale retry never regresses app metadata. |
| Signer offline, denied, or credentials missing | Fails closed; raw signer output is kept in the runner temp directory and never printed. |
| Upload accepted but event signing fails | Read-back finds `partial`; operator recovers per section 5. |
| Two runs for the same app | Serialized by one concurrency group; a pending run GitHub discards is redone by the next schedule. |
| Notification cannot be created | The job fails visibly; the workflow run itself is already red. |

## 2. Trigger design

**Why not `release: published`.** A release event runs the workflow file from the
default branch, so it *could* be safe, but GitHub suppresses events for releases
created or published with `GITHUB_TOKEN`, and the existing publication path is a
manual owner action that can precede asset completion. The event is therefore
neither necessary nor sufficient. This lane uses:

1. **Owner `repository_dispatch`** for an explicit publication or exact retry of one
   release id. Same owner-id gate as the release controller.
2. **Daily `schedule`** that enumerates published releases from the last 45 days
   (bounded pages of 100, fails if the window is not fully enumerated), classifies
   each, and reconciles each eligible one against the relay. Releases that are
   already complete are skipped; absent ones are published; anything else fails
   closed with a report.

Both triggers load workflow and script code from the protected default branch.
The release tag's tree is only used as a data source for the changelog text.

## 3. Verification plan (what is checked and where)

Continuous integration (pull requests, no secrets):

- `node --test scripts/zapstore/test/` runs behavioural tests against a fake relay,
  fake GitHub API, recorded unsigned `zsp` output and recorded `apksigner` output.
  It covers eligibility, dispatch validation, binding, wrong identity/certificate/
  hash, missing assets, stale notes, relay partial/corrupt/invalid signatures, full
  match skip, downgrade, disabled activation, secret redaction, exact `zsp`
  invocation flags and notification body construction.
- The Android signing-boundary checker still parses every workflow. The new
  workflow binds a different environment, names no Android signing secret, and has
  no path to the release API, so it passes without any exemption.

Pre-activation rehearsal (owner, no signing):

1. Run the dispatch with `ZAPSTORE_AUTOMATION_ENABLED` still absent: the summary
   must say `DISABLED`.
2. Set the variable to `rehearsal`: `admit` treats it as disabled but the
   `enumerate` job runs and prints the classification table.

Live run (after activation):

- `reconcile` output is attached as a run artifact.
- `readback` must return `complete-match`, and CDN byte hashes must match.

## 4. Pre-activation checklist (each item needs separate owner approval)

- [ ] Create protected environment `zapstore-production` with a required reviewer
      (the owner) and branch policy restricted to the default branch.
- [ ] Add environment secret `ZAPSTORE_SIGN_WITH` (a `bunker://` URL). Never a
      private key.
- [ ] Add environment secret `ZAPSTORE_BUNKER_CLIENT_KEY`: the 64-hex NIP-46
      *client* key that the signer already authorised. This is a client capability,
      not the Nostr identity key. It is written to
      `$XDG_CONFIG_HOME/zsp/bunker-keys/<bunker-target>.key` (mode 0600) for the
      duration of the job and removed afterwards. No Actions cache is used.
- [ ] Signer policy for that client: allow only kinds `32267`, `30063`, `3063`
      and `24242` (upload authorisation). No blanket "always allow".
- [ ] Signer availability: the current signer is an everyday phone. Unattended
      approval has **not** been verified. A dedicated always-on remote signer
      with the least-privilege grant above is recommended before enabling the
      schedule. Until then keep the schedule as a reconciliation report only.
- [ ] Set repository variable `ZAPSTORE_AUTOMATION_ENABLED=enabled`.

## 5. Manual retry and recovery

Exact retry of one release (does not scan other releases):

```
gh api repos/silent-suite/silentsuite/dispatches \
  -f event_type=silentsuite_zapstore_publish \
  -F 'client_payload[release_id]=<numeric id>' \
  -F 'client_payload[release_tag]=vX.Y.Z' \
  -F 'client_payload[source_sha]=<40-hex>'
```

| Reconcile outcome | What it means | What to do |
|-------------------|---------------|------------|
| `complete-match` | Already published and verified | Nothing. |
| `absent` | Nothing for this version on the relay | The run publishes. |
| `incomplete` | Relay did not finish answering | Retry later with the exact dispatch. |
| `partial` | Some of app/release/APK present | Inspect the reported event ids on the relay. If the APK event is present and matches, re-running is safe only after confirming the release event is truly missing; otherwise contact the relay operator. Do not overwrite blindly. |
| `conflict` | Same version, different hash or metadata | Stop. Decide which artefact is correct; a new version is usually the safe fix. |
| `downgrade-refused` | Relay already carries a newer version | Do nothing; the retry is stale. |

## 6. Rollback

- Disable admission: delete or change `ZAPSTORE_AUTOMATION_ENABLED`.
- Remove the environment secrets to make every run fail closed.
- Do not attempt automatic deletion events, do not republish older metadata, and do
  not touch GitHub releases. Already-signed events need a manual relay-state review.

## 7. Pinned tooling

- `zsp` 0.4.17, `https://github.com/zapstore/zsp/releases/download/v0.4.17/zsp-0.4.17-linux-amd64`,
  SHA-256 `3f241da6a5dc7a85fe851d3b42b77790b651bd36c7029382a701262bda832d20`.
- Node 22 (global `WebSocket` is used for relay subscriptions).
- Android build-tools 36.0.0 `apksigner`, installed the same way as the release lane.
- Event signature verification uses the pinned `@noble/curves` package in
  `scripts/zapstore/package.json`, isolated from the monorepo lockfile.
