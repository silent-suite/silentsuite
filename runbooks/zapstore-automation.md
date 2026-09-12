# Zapstore publication automation (dormant)

This lane publishes an already-published, eligible SilentSuite Android release to
Zapstore with the official `zsp` publisher. It is **disabled by default** and has
never been activated. Nothing in this document, the workflow, or the scripts
publishes anything until the activation steps at the end are completed by the
repository owner, each under its own approval.

The lane sits *after* the existing release controller. The controller still ends
at a complete draft release and the owner still publishes the GitHub release by
hand. That boundary is unchanged and this lane must never publish, edit, or move
a GitHub release. It is not a second `repository_dispatch` control plane.

## 1. Surface & sibling-path map

### Surfaces

| # | Surface | Authority / source of truth | Files |
|---|---------|-----------------------------|-------|
| S1 | Trigger: GitHub `release` `published` / `edited` | Workflow YAML loaded from protected main. Jobs check out `refs/heads/main`, never `github.sha` / `github.workflow_sha` (those name the tag). Numeric owner account id compared before the release id is used. | `.github/workflows/zapstore-publish.yml`, `scripts/zapstore/lib/dispatch.mjs` |
| S2 | Trigger: daily `schedule` reconciliation | Runs only on the protected default branch; enumerates exact published release ids with bounded pagination, never `latest`. Covers `GITHUB_TOKEN`-suppressed release events and late APK attachment. | workflow, `lib/github.mjs` |
| S3 | Activation switch | Repository variable `ZAPSTORE_AUTOMATION_ENABLED` must equal `enabled`; it is absent today | workflow `admit` job |
| S4 | Release eligibility | Tag grammar `vX.Y.Z` or `vX.Y.Z-beta`; draft refused; GitHub `prerelease=true` allowed only with a `-beta` tag | `lib/eligibility.mjs` |
| S5 | Exact release binding | Release id, tag, tag commit (annotated tags dereferenced), APK asset id, GitHub asset digest, sidecar `-installer.sha256`, `SHA256SUMS.txt` | `lib/github.mjs`, `lib/binding.mjs` |
| S6 | Source admission | Trusted `scripts/verify-release-identity.sh` from the protected checkout: tag grammar, live tag identity, protected-main ancestry, both v* tag rulesets. The release tree is never executed. | `lib/identity.mjs`, `scripts/verify-release-identity.sh` |
| S7 | APK verification | Local bytes hashed and compared to all three GitHub digests; `apksigner verify --print-certs -v` must print `Verifies` and every signer must be the direct-release certificate; package, version, version code, certificate extracted by the official `zsp` in unsigned offline mode | `lib/apksigner.mjs`, `lib/zsp.mjs` |
| S8 | Source build metadata | `versionName` / `versionCode` parsed as literals from `android/app/build.gradle` at the bound commit (`git show`, data only). Changelog taken from that version code at the same commit. | `lib/source-metadata.mjs`, `lib/metadata.mjs` |
| S9 | Store metadata | Trusted template at the protected revision; media bytes hashed | `scripts/zapstore/release-template.json`, `lib/metadata.mjs` |
| S10 | Relay reconciliation before signing | `wss://relay.zapstore.dev`; completed subscription (EOSE) required; every event id and Schnorr signature verified; scalar tag cardinality and exact release e-link set | `lib/nostr.mjs`, `lib/reconcile.mjs` |
| S11 | Signing and upload | `zsp` 0.4.17 pinned by URL and SHA-256; `SIGN_WITH` from environment secret `ZAPSTORE_SIGN_WITH` (must be `bunker://`); NIP-46 client key from `ZAPSTORE_BUNKER_CLIENT_KEY` written 0600 and removed in a trap. Live runs pass `--overwrite-release`, which upstream uses to read the existing relay release timestamp (not merely a local cache). | `lib/zsp.mjs`, `lib/bunker-key.mjs` |
| S12 | Read-back | Same reconciliation must return `complete-match` after any publication attempt (including nonzero `zsp` exit). CDN bytes for APK, icon and six screenshots are fetched and hashed on every complete-match, including an already-published skip. | `lib/reconcile.mjs`, `lib/cdn.mjs` |
| S13 | Failure notification | Isolated job with `issues: write` only; structured body with exact release/tag/source, phase, outcome and publication claim; open-issue title dedupe; read back after creation | `lib/notify.mjs` |
| S14 | Concurrency | One group for the whole app/publisher, `cancel-in-progress: false`; runs GitHub drops are recovered by the next schedule | workflow |

### Sibling paths (what happens on each neighbouring path)

| Path | Behaviour |
|------|-----------|
| Activation variable absent or not `enabled` | `admit` reports `DISABLED` in the job summary; all later jobs are skipped. No silent success: the summary says nothing was published. |
| `repository_dispatch` | Unsupported. Admission refuses it. The release controller remains the only dispatch workflow. |
| `workflow_dispatch` | Unsupported. Admission refuses it. A selected ref must never supply this lane. |
| `release` event from a non-owner account | Refused before the release id is used. |
| Draft release | Ineligible; recorded, never published. |
| Schedule running on a non-default `GITHUB_REF` or `GITHUB_WORKFLOW_REF` | Refused. |
| `release` event `GITHUB_REF` is the tag | Expected. Jobs still check out `refs/heads/main`. |
| Checkout of `github.sha` or `github.workflow_sha` | Must not happen. Every job checks out `refs/heads/main`. |
| `vX.Y.Z-rc1`, `-alpha`, nightly | Ineligible. |
| `-beta` tag with GitHub `prerelease=true` | Eligible; channel stays `main` (existing relay history). |
| Stable tag with GitHub `prerelease=true` | Ineligible. |
| Release published before assets exist | Binding fails (APK, sidecar or `SHA256SUMS.txt` missing); the next schedule or an owner-authored release edit retries. |
| Tag moved / release deleted / id mismatch / ruleset drift | Binding or identity-helper revalidation fails closed just before signing. |
| Off-main source commit | `verify-release-identity.sh` refuses ancestry. |
| Wrong package, version, version code, certificate, size or hash | Fails closed before any signing. Version name/code must match the source `build.gradle` literals, not merely be a positive integer. |
| Missing or unapproved screenshot set | Fails closed; the template requires exactly the six approved names in order. |
| Stale release notes | Notes come from `changelogs/<versionCode>.txt` at the release's own source commit and must be non-empty; the template never carries release text. |
| Relay timeout / disconnect / no EOSE | Treated as `incomplete`, never as absent; no signing; no overwrite. |
| Relay returns an event with an invalid id or signature | Fails closed. |
| Relay already holds the exact release, APK and matching app metadata | `complete-match`: nothing is signed; CDN bytes are still verified; run succeeds only if CDN matches. |
| Relay holds part of the set, present events match the immutable expected tags, and no newer version_code exists | `partial` with `safe-partial-recovery`: one live `zsp` run is allowed. `--overwrite-release` consults the relay timestamp. Blind overwrite of conflicts is refused. |
| Relay holds part of the set with tag/hash/e-link mismatch, extra APK references, or a newer version_code | `conflict` / fail closed. |
| Relay holds a newer version and this candidate has no same-version events | `superseded`. Schedule skips without a failure issue. An explicit owner `release` trigger fails closed (`downgrade-refused`) so a stale retry never regresses app metadata. |
| Same-version events already complete while a newer version also exists | `complete-match` for that historical exact set; not a recurring incident. |
| Signer offline, denied, or credentials missing | Fails closed; raw signer output is kept in the runner temp directory and never printed. Relay read-back still runs after any publication attempt. |
| Upload accepted but event signing fails / `zsp` exits nonzero | Read-back still runs. Notification must not claim nothing was published. |
| Two runs for the same app | Serialized by one concurrency group; a pending run GitHub discards is redone by the next schedule. |
| Notification cannot be created | The job fails visibly; the workflow run itself is already red. An open issue with the same title is reused rather than duplicated. |

## 2. Trigger design

**Why not `repository_dispatch`.** Existing Android signing-boundary and
self-host release tests permit exactly one dispatch workflow: the release
controller (`silentsuite_release`). A second dispatch event type would be a
second release control plane. Those gates are not relaxed.

**Why not `workflow_dispatch`.** That trigger can load the workflow file from a
selected non-default ref, which would let a branch supply the lane itself.

**Why not the existing controller.** `silentsuite_release` re-runs Android
signing and the umbrella draft. Adding a zapstore job or a second dispatch type
would change those exact-set gates. This lane must not change GitHub release
publication behaviour.

This lane therefore uses two default-branch-loaded triggers:

1. **`release`: `published` and `edited`**, owner-sender gated, for the release
   the owner just published or edited. Exact on-demand retry. Jobs check out
   `refs/heads/main`, never the tag.
2. **Daily `schedule`** that enumerates published releases from the last 45 days
   (bounded pages of 100, fails if the window is not fully enumerated),
   classifies each, and reconciles each eligible one against the relay.

The release tag's tree is only used as data: changelog text and literal
`versionName`/`versionCode` from `android/app/build.gradle`.

## 3. Verification plan (what is checked and where)

Continuous integration (pull requests, no secrets):

- `node --test scripts/zapstore/test/` runs behavioural tests against a fake relay,
  fake GitHub API, recorded unsigned `zsp` output and recorded `apksigner` output.
  It covers eligibility, trigger admission, binding, source identity helper
  refusal, source gradle versionCode mismatch, wrong identity/certificate/hash,
  missing assets, stale notes, relay partial/corrupt/invalid signatures, extra
  e-links and extra APK tags, APK selection by release e-link, full match skip,
  CDN required on complete-match, superseded historical schedule candidates,
  safe partial recovery vs conflict, disabled activation, secret redaction, exact
  `zsp` invocation flags (including overwrite-release relay-timestamp semantics
  in comments), notification identity/uncertainty/dedupe, and the absence of a
  second `repository_dispatch` plane.
- The Android signing-boundary checker still parses every workflow. This
  workflow is not `repository_dispatch`, binds a different environment, names no
  Android signing secret, and has no path to the release-write API, so it passes
  without any exemption.
- Web workflow governance requires the reviewed `actions/upload-artifact` and
  `actions/download-artifact` pins; this file uses those pins.

Pre-activation rehearsal (owner, no signing):

1. Wait for a schedule with `ZAPSTORE_AUTOMATION_ENABLED` still absent: the
   summary must say `DISABLED`.
2. Set the variable to `rehearsal`: `admit` treats it as disabled but the
   `enumerate` job runs and prints the classification table.

Live run (after activation):

- `reconcile` output is attached as a run artifact.
- `readback` after any publication attempt must return `complete-match`, and CDN
  byte hashes must match. Already-complete candidates also have CDN verified.

Gaps the local Node suite does not close (coordinator / CI):

- Real `apksigner` on a GitHub runner.
- Live identity-helper calls against GitHub (rulesets, compare API).
- Python Android signing-boundary and self-host workflow tests.
- Any live bunker/NIP-46 signing, upload, or relay write.

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

There is no `repository_dispatch` retry. Exact retry of one release:

- Wait for the next protected-main schedule (`17 4 * * *` UTC), which
  enumerates exact published release ids, or
- As the owner, edit that GitHub release (the lane never does this itself) so
  GitHub delivers `release: edited` from the default-branch workflow.

```
# Owner-only. `-f` keeps release_id out of JSON-number coercion.
gh api repos/silent-suite/silentsuite/releases/<numeric id> -X PATCH \
  -f tag_name='vX.Y.Z'
```

| Reconcile outcome | What it means | What to do |
|-------------------|---------------|------------|
| `complete-match` | Already published and tag-identical; CDN still verified | Nothing if CDN matches. |
| `absent` | Nothing for this version on the relay | The run publishes. |
| `incomplete` | Relay did not finish answering | Retry later. Never overwrite. |
| `partial` (present events match, no newer version) | Some of app/release/APK present and equal to the immutable expected tags | The run may recover with one live `zsp` invocation. `--overwrite-release` reads the existing relay release timestamp. |
| `partial` / `conflict` otherwise | Extra e-links, extra APK references, hash mismatch, or a newer version_code | Stop. Do not overwrite. |
| `superseded` | No events for this version; relay already has a newer version_code | Schedule skips. An explicit owner retry fails closed. |
| `downgrade-refused` | Explicit retry of a superseded candidate | Do nothing; the retry is stale. |

A nonzero `zsp` exit is followed by relay read-back. Treat publication as
**unknown** until that read-back is `complete-match` or `absent` with EOSE.

## 6. Rollback

- Disable admission: delete or change `ZAPSTORE_AUTOMATION_ENABLED`.
- Remove the environment secrets to make every run fail closed.
- Do not attempt automatic deletion events, do not republish older metadata, and do
  not touch GitHub releases. Already-signed events need a manual relay-state review.

## 7. Pinned tooling

- `zsp` 0.4.17, `https://github.com/zapstore/zsp/releases/download/v0.4.17/zsp-0.4.17-linux-amd64`,
  SHA-256 `3f241da6a5dc7a85fe851d3b42b77790b651bd36c7029382a701262bda832d20`.
- Node 22 (global `WebSocket` is used for relay subscriptions).
- Android build-tools 36.0.0 `apksigner`, installed the same way as the release lane
  (finite license file, not `yes |` under `pipefail`).
- Event signature verification uses the pinned `@noble/curves` package in
  `scripts/zapstore/package.json`, isolated from the monorepo lockfile.
- Governed Actions pins: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`,
  `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020`,
  `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`,
  `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`.
