# Zapstore publication automation (dormant)

This lane publishes the newest eligible, already-published SilentSuite Android
release to Zapstore with the official `zsp` publisher. It is **disabled by
default** and has never been activated. Nothing in this document, the workflow,
or the scripts publishes anything until the activation steps in section 6 are
completed by the repository owner, each under its own approval.

The lane sits *after* the existing release controller. The controller still ends
at a complete draft release and the owner still publishes the GitHub release by
hand. That boundary is unchanged: this lane never publishes, edits, or moves a
GitHub release, and it is not a second `repository_dispatch` or
`workflow_dispatch` control plane.

## 1. Architecture

### 1.1 Trigger and workflow-definition provenance

GitHub loads a workflow file from the commit associated with the event. For
`release` events that commit is the **tagged release**, so a `release`-triggered
lane would execute whatever `zapstore-publish.yml` the tag carries, and existing
tags carry none. Checking out `main` afterwards cannot change the jobs,
permissions, or secret references that were already loaded. The lane therefore
uses exactly one trigger:

- **`schedule`** (`17 */6 * * *` UTC). Scheduled runs are loaded from the
  default branch; `github.sha` is that branch head and is the revision that
  supplied the definition.

Admission proves this every run, from the run's own context and never from a
value the lane fabricates: `GITHUB_EVENT_NAME=schedule`,
`GITHUB_REF=refs/heads/main`, `GITHUB_WORKFLOW_REF` names this repository's
`zapstore-publish.yml@refs/heads/main`, and `GITHUB_WORKFLOW_SHA` equals
`GITHUB_SHA`. That commit is the **protected revision**; it is exported as a job
output and every later job checks out exactly `${{ github.sha }}` and refuses to
continue if its `HEAD` differs from the admitted revision. The trusted identity
helper receives the real `GITHUB_REF`.

**Exact-release retry is deterministic, not a moving window.** The only release
that can ever be published is the newest eligible tag, and enumeration always
selects it by exact release id however old it is; the 45-day window bounds
verify-only history alone. Every scheduled run therefore retries that one exact
release until the relay holds it, and a newer eligible release replaces it as
the sole publishable candidate. For an immediate retry, GitHub's native "Re-run
failed jobs" is expected to replay the failed matrix entry with the release id
frozen in that run's candidate list, the same event, the same protected
revision and the same environment gate. It needs repository write access and
cannot select a ref. There is no `repository_dispatch`, `workflow_dispatch`,
`release` or tag-PATCH retry.

**Accepted first-version scope.** The owner has accepted two reduced-scope
limitations for this first version. Acceptance of scope is not proof of
behaviour and replaces no review, CI or commissioning step.

1. *Retry model.* The lane provides scheduled publication of the newest
   eligible release and GitHub's native failed-job replay. It provides no
   on-demand trigger for an arbitrary exact release id, and does not claim one.
2. *APK event present, release or app missing.* The lane refuses and reports;
   handling is manual (5.3).

Caveats that remain open and must be verified during commissioning, stated
rather than assumed away: the failed-job replay has not been demonstrated on a
live run, so that it replays the frozen release id with the same revision and
environment gate is expected behaviour, not evidence; GitHub limits how long a
run can be re-run and how long its artifacts are kept, and a re-run whose
assessment artifact has expired fails closed at the download step rather than
publishing; "Re-run all jobs" re-enumerates instead of replaying a frozen id.
When replay is unavailable, the next schedule is the retry.

**Why not the release controller.** The controller runs at dispatch time and
ends at a *draft*; Zapstore eligibility begins only when the owner publishes the
release later, so there is nothing for a controller job to publish. Its event
type, job set and admission job are digest-pinned by the signing-boundary
checker and the self-host workflow tests. Adding a second dispatch type or a
retry job would relax those gates, and Python tests cannot be run on this
machine. Rejected.

**Why not `workflow_dispatch`.** It loads the definition from the selected ref,
and the owner has ruled it out as a second control plane.

### 1.2 Job graph (one protected revision, one secret step)

| Job | Permissions / environment | What it does |
|-----|---------------------------|--------------|
| `admit` | `{}` | Proves trigger and definition provenance (1.1); exports `active`, `rehearsal`, `revision`. |
| `enumerate` | `contents: read` | Lists published releases by exact id (bounded pages), classifies eligibility, always keeps the **single newest** eligible tag as the one `publishable` candidate, keeps verify-only history inside the 45-day window; uploads `candidates.json`. |
| `assess` (matrix, `max-parallel: 1`, `fail-fast: false`) | `contents: read`, no environment, no secrets | Per candidate: bind exact release/tag commit/assets, identity helper, download APK and check three digests, `apksigner`, unsigned offline `zsp` expected events, relay reconciliation, CDN verification when the relay set is complete. Records `assessment.json` and uploads `zapstore-assessment-<id>`. |
| `plan` | `{}` | Downloads all assessments, requires one per enumerated candidate, emits the publish matrix (candidates whose action is `publish`; at most the newest). |
| `publish` (matrix over the plan) | `contents: read`, environment `zapstore-production` | Fresh runner: repeats bind, digests, `apksigner`, prepare and reconciliation, checks nothing drifted from the assessment, revalidates identity, then one secret step: NIP-46 read-only account preflight, then `zsp` live. Read-back and CDN verification follow every attempt. Records `result.json`, uploads `zapstore-result-<id>`. |
| `notify` | `issues: write` | Downloads candidates, assessments and results; opens one issue per candidate whose recorded status is a failure or whose evidence is missing. Successes are never reported. |

Only the `publish` job binds the environment, so the owner is asked to approve
only when a publication is actually pending, never for a verification pass.

Rejecting the environment approval prevents the publication job from running,
but also leaves no result artifact. Notification conservatively reports this as
`evidence-missing`, including a warning that an attempt may have run. Check the
run's environment rejection record before interpreting that warning; it is not
evidence that signing occurred. Do not approve or retry merely to clear the issue.

### 1.3 Surface & sibling-path map

| # | Surface | Authority / source of truth | Files |
|---|---------|-----------------------------|-------|
| S1 | Trigger | `schedule` only; definition and checkout are the same protected-main commit (`github.sha`) | `.github/workflows/zapstore-publish.yml`, `lib/dispatch.mjs` |
| S2 | Revision binding | `admit` exports the revision; every job runs `checkout-guard`; the manifest records it | `cli.mjs` |
| S3 | Activation switch | Repository variable `ZAPSTORE_AUTOMATION_ENABLED` must equal `enabled`; absent today | `admit` |
| S4 | Eligibility | `vX.Y.Z` or `vX.Y.Z-beta`; drafts refused; GitHub `prerelease=true` allowed only with `-beta`; only the newest eligible tag may be published | `lib/eligibility.mjs` |
| S5 | Exact binding | Release id, tag, dereferenced tag commit, APK asset id, GitHub digest, sidecar, `SHA256SUMS.txt` | `lib/github.mjs`, `lib/binding.mjs` |
| S6 | Source admission | Trusted `scripts/verify-release-identity.sh` from the protected checkout with the real `GITHUB_REF` | `lib/identity.mjs` |
| S7 | APK verification | Three digests, `apksigner verify --print-certs -v` with only the direct-release certificate, identity facts from official `zsp` offline output, `versionName`/`versionCode` literals from the tag's `build.gradle` | `lib/apksigner.mjs`, `lib/zsp.mjs`, `lib/source-metadata.mjs` |
| S8 | Store metadata | Trusted template at the protected revision; media bytes hashed; six approved screenshots in order; copy byte-identical to `zapstore.yaml` | `release-template.json`, `lib/metadata.mjs` |
| S9 | Relay reconciliation | EOSE required; every event id and Schnorr signature verified; exact full-tuple comparison (1.4) | `lib/nostr.mjs`, `lib/reconcile.mjs` |
| S10 | Signing account | NIP-46 `connect` + `get_public_key` with the job's client key; the returned **account** pubkey must equal the template `pubkeyHex` before any signature or upload authorisation | `lib/nip44.mjs`, `lib/nip46.mjs`, `lib/publish.mjs` |
| S11 | Publisher | `zsp` 0.4.17 pinned by URL and SHA-256; `SIGN_WITH` must be `bunker://`; client key 0600 for one step | `lib/zsp.mjs`, `lib/bunker-key.mjs` |
| S12 | Read-back and CDN | Read-back must be `complete-match`; APK, icon and six screenshots fetched by hash | `lib/reconcile.mjs`, `lib/cdn.mjs` |
| S13 | Evidence and notification | Per-candidate `assessment.json`/`result.json` with phase outcomes; failures and missing evidence only | `lib/results.mjs`, `lib/notify.mjs` |
| S14 | Concurrency | One group for the whole app, never cancels | workflow |

Sibling paths:

| Path | Behaviour |
|------|-----------|
| Activation variable absent or not `enabled` | `admit` reports `DISABLED`; nothing after it runs except in `rehearsal`. |
| `release`, `repository_dispatch`, `workflow_dispatch`, `push` | Not declared; admission refuses any event but `schedule`. |
| Schedule with `GITHUB_REF`/`GITHUB_WORKFLOW_REF` not protected main, or `GITHUB_WORKFLOW_SHA != GITHUB_SHA` | Refused. |
| Job checkout `HEAD` differs from the admitted revision | `checkout-guard` fails the job. |
| Draft, `-rc`, `-alpha`, nightly, stable with `prerelease=true` | Ineligible, listed as omitted with a reason. |
| Eligible but not the newest tag | Verify-only: reconciled and CDN-checked if present, never published. |
| Release published before assets exist | Binding fails; the next schedule retries. |
| Tag moved / asset replaced / ruleset drift | Fails closed at binding, at `publish` drift check, and at revalidation before signing. |
| Relay: nothing for this version, app metadata absent or exactly equal to the template | `absent` → publish (newest only). |
| Relay: nothing for this version, app metadata differs from the template | `app-drift` → fail closed; the template must be updated by a reviewed change, or the listing reviewed by hand. |
| Relay: exact lane set present | `complete-match` → skip, CDN verified. |
| Relay: pre-lane set (APK without `commit` tag) whose identity tuple matches and whose release e-links it | `legacy-complete` → skip, CDN verified, never rewritten; same-hash duplicate APK events from earlier manual publications are tolerated. |
| Relay: release (and app) present and equal to the expected tuples, **no APK event** for this version, no newer `version_code` | `partial`, recoverable → one publisher run completes the set (newest candidate only); read-back must be `complete-match`. This is the state a failed asset publish leaves, because upstream publishes app, release, then asset. |
| Relay: a matching APK event present without its release, or without app metadata | `partial`, unrecoverable → fail closed with the exact preserved ids; see 5.2. |
| Relay: same version with a different hash, extra e-links, extra APK references, tuple differences | `conflict` → fail closed. |
| Relay: nothing for this version and a newer `version_code` exists | `superseded` → skip. |
| Relay timeout, close, `CLOSED`, or result at the subscription limit | `incomplete` → fail; never treated as absent. |
| Bunker unreachable, needs interactive approval, or returns another account | Fails before any signature or upload. |
| `zsp` exits nonzero | Read-back still runs; publication is reported as `unknown` unless read-back proves otherwise. |
| CDN bytes differ or are missing after `complete-match`/`legacy-complete` | Candidate status `failure`, phase `cdn`; issue opened even though nothing was signed. |
| A candidate has no assessment or result artifact | `evidence-missing` failure; issue opened. |
| Two runs overlap | Serialized by one concurrency group. |

### 1.4 Exact event contract

Expected events are the unsigned offline `zsp` output for the exact APK, trusted
template and bound changelog. Observed events must match **content and the full
ordered tag list**, tuple by tuple. Permitted differences are exactly `id`,
`sig`, `created_at`, and the release `e` tuple, which must be
`["e", <observed matching APK id>, "wss://relay.zapstore.dev"]`. This covers the
app `h` community tag, `icon`, ordered `image`, ordered `t`, `f`, `url`,
`repository`, `license`; the APK `i`, `x`, `version`, `version_code`, `url`,
`m`, `size`, `f`, `min_platform_version`, `target_platform_version`,
`filename`, `commit`, `apk_certificate_hash` and empty content; the release
`i`, `version`, `d`, `c`, `f`, `e` and changelog content. Any extra tag, missing
tag, reordered tag, or extra tuple element is a difference.

Legacy mode applies only to observed APK events that carry no `commit` tag:
`i`, `x`, `version`, `version_code`, `size`, `m`, `apk_certificate_hash` must
match exactly once, and the CDN `url` must be among the observed `url` tags
(hand publications from a GitHub source also carry the original download URL);
the release must carry `i`, `version`, `d`, `c` equal to expected and exactly
one `e` pointing at a matching APK. Legacy sets are never rewritten.

### 1.5 Invariants

1. Definition, admission code and store template come from one protected-main
   commit, recorded in the manifest.
2. Publication is bounded to the newest eligible tag; older tags are verify-only.
3. No signature and no upload authorisation before the signing account is
   proven equal to the approved publisher.
4. An accepted immutable APK event is never duplicated: no event set is
   regenerated when the relay already holds an APK event for that version
   (complete, legacy, partial or conflicting). Recovery runs only when no such
   event exists, so every accepted event id is preserved.
5. The identity private key never enters CI; only a `bunker://` URL and a
   NIP-46 client key do.
6. Successes are silent; every failure and every missing piece of evidence is an
   issue with the exact phase.

## 2. Rollback

- Disable admission: delete or change `ZAPSTORE_AUTOMATION_ENABLED`.
- Remove the environment secrets or the environment: every `publish` job fails
  closed before the secret step.
- Never delete relay events automatically, never republish older metadata, never
  touch GitHub releases. A signed set that must be withdrawn needs a manual relay
  review by the owner.

## 3. Regression and CI coverage

`pnpm run check:zapstore-automation` (pull requests, no secrets) runs:

- `lane.test.mjs`: eligibility and newest-only marking; schedule-only admission
  including refusal of `release`; real `GITHUB_REF` pass-through to the identity
  helper; binding, digests, `apksigner`, template, media, changelog, `zsp`
  invocation, relay subscription semantics, signature verification on real
  relay events, and every reconciliation outcome: exact match, legacy match on
  the recorded 0.5.4-beta and duplicate-APK 0.5.0-beta history, `app-drift`,
  outcome-aware issue guidance (stop, not re-run, for unrecoverable `partial`,
  `conflict` and `app-drift`),
  recoverable `partial` (stranded release, no APK event) through to an exact
  read-back and its guards, unrecoverable `partial` fail-closed, the newest
  release staying an exact candidate outside the window, conflicts on `h`, APK content,
  `min_allowed_version_code`, e-link relay hint, superseded, incomplete.
- `protocol.test.mjs`: NIP-44 v2 against the published test vectors; NIP-46
  `connect`/`get_public_key` round trip against an in-process responder that
  implements the same protocol, mismatch refusal, error and timeout handling,
  and the guarantee that the publisher is never spawned after a failed
  preflight.
- `orchestration.test.mjs`: `checkout-guard` on a temporary repository;
  `record-result` status/phase derivation; `plan` selection and missing
  evidence; `notify` end to end against a local fake GitHub API: a successful
  sibling opens nothing, a CDN failure on an already-complete candidate opens an
  issue, missing evidence opens an issue, open issues are deduplicated.
- `workflow-boundary.test.mjs`: schedule-only trigger, every checkout is
  `${{ github.sha }}`, no `refs/heads/main` or tag checkout, exactly one secret
  step in the environment-bound job, assess job carries no environment or
  secret, notify holds only `issues: write`, pinned actions and publisher.

CI only (cannot run on this machine): the Python signing-boundary checker and
self-host workflow tests still parse this workflow; real `apksigner`; live
identity-helper reads.

Not covered anywhere until commissioning: a live bunker, a live upload, a live
relay write. The in-process NIP-46 responder proves the client side of the
protocol, not a specific signer product.

## 4. Live run walk-through

1. `admit` summary states `ENABLED` and the protected revision.
2. `enumerate` table: every release in the window with candidate/omitted and the
   one `publishable` tag.
3. `assess` per candidate: binding line, digest line, apksigner line,
   reconciliation outcome and action, CDN line.
4. `plan`: publish matrix (usually empty; one entry after a new release).
5. `publish` (approval required): drift check, revalidation, preflight
   `signing account verified`, `zsp` exit, read-back `complete-match`, CDN.
6. `notify`: `No failure issue required` or the issue numbers.

## 5. Manual retry and recovery

### 5.1 Retry

First read the issue's **Decision** line. For `partial-unrecoverable`, `conflict`
and `app-drift` a retry is not a remedy: go to 5.2 and 5.3 and stop.

For transient failures (relay `incomplete`, a download or signer timeout), open
the failed scheduled run and choose **Re-run failed jobs**; it is expected to
replay the release id frozen in that run (see the open limitations in 1.1).
Publication still waits for environment approval. Without any action, the next
schedule (at most six hours) retries the same exact newest release. To retry
with a code fix, merge the fix to `main` and wait for the next schedule. After
any publication attempt whose outcome is `unknown`, do not re-run blindly: wait
for the next scheduled reconciliation to read the relay first.

### 5.2 Outcomes

| Outcome | Meaning | Action |
|---------|---------|--------|
| `complete-match` / `legacy-complete` | Present and verified | Nothing; CDN is checked. |
| `absent` | Nothing for this version | Newest candidate is published. |
| `superseded` | Relay or GitHub already has a newer version | Nothing; not an incident. |
| `app-drift` | Store listing differs from the approved template | Reviewed template change, or manual listing review. Nothing is published. |
| `partial` (`partial-recovery`) | Release/app present and exact, no APK event for this version | Automatic for the newest candidate: one publisher run; the regenerated release supersedes the stranded one under its `d` tag; read-back must be `complete-match`. No accepted event id is lost because no immutable event existed. |
| `partial` (`partial-unrecoverable`) | A matching APK event exists without its release or app | **Stop; no automatic recovery exists.** Accepted limitation: see 5.3. The issue names the preserved event ids. |
| `partial` (`partial-not-newest`) | Recoverable state on a release that is no longer the newest | Nothing is published; a newer release is the publishable one. |
| `conflict` | Same version, different bytes or tuples | Manual relay review. Never overwrite. |
| `incomplete` | Relay did not finish answering | Re-run later. |
| `unknown` publication after a nonzero `zsp` exit | Read-back did not prove the set | Treat as possibly published; the next schedule reconciles. |

### 5.3 Accepted limitation: APK event present, release or app missing

The owner has accepted this as a reduced-scope limitation: the lane refuses,
reports, and does not recover this state. In the pinned publisher source
(`zsp` 0.4.17), a live run always constructs a new APK event stamped with the
current time when the source is a local file, links the release only to the
APK events built in that same run, and offers no publish option that names an
existing APK event id. A run would therefore add a second immutable APK event
for the same version. Supported recovery is being pursued with the publisher's
maintainers; this lane will not sign events itself to work around it.

Procedure:

1. **Stop.** Do not re-run the job as a fix (it refuses again, harmlessly, and
   the issue stays open). Do not run `zsp` by hand for this version, with or
   without `--overwrite-release`. Do not delete relay events.
2. **Collect evidence** and attach it to the issue: the preserved event ids
   from the issue detail, the run's `zapstore-assessment-<release id>` artifact
   (`assessment.json`, `reconcile.json`, `expected-events.jsonl`), and a
   read-only relay query for the package showing which kinds exist.
3. **Decide with the owner.** Either leave the version as is until a supported
   publisher recovery exists, or let a newer release supersede it: once a newer
   eligible release is published on GitHub, this version becomes verify-only
   and the newer one is published normally.
4. **Keep the issue open** while the state persists. The lane reuses the open
   issue rather than filing a new one each run.

`conflict` and `app-drift` issues carry the same stop guidance: a re-run does
not fix them and a hand-run publisher would make them worse.

## 6. Pre-activation checklist (each item needs separate owner approval)

- [ ] Create environment `zapstore-production`: required reviewer (owner),
      deployment branch policy `main` only.
- [ ] Environment secret `ZAPSTORE_SIGN_WITH`: a `bunker://` URL. Never a key.
- [ ] Environment secret `ZAPSTORE_BUNKER_CLIENT_KEY`: the 64-hex NIP-46 client
      key already authorised by the signer for kinds `32267`, `30063`, `3063`,
      `24242` and the `get_public_key` method. No blanket allow.
- [ ] Signer availability: unattended approval has not been verified; a
      dedicated always-on signer with the grant above is recommended.
- [ ] Replay verification (open caveat in 1.1): on a rehearsal or first live
      run with a transient failure, use "Re-run failed jobs" and confirm from
      the run log that the replayed job carries the same release id and
      protected revision; record the observed re-run and artifact-retention
      limits here. Until then the replay is unverified.
- [ ] Secret-free commissioning first: set `ZAPSTORE_AUTOMATION_ENABLED=rehearsal`
      and confirm `enumerate` and `assess` produce the expected table, the
      recorded history reconciles as `legacy-complete`, and no issue is opened.
- [ ] Then set `ZAPSTORE_AUTOMATION_ENABLED=enabled`.

## 7. Pinned tooling

- `zsp` 0.4.17, `https://github.com/zapstore/zsp/releases/download/v0.4.17/zsp-0.4.17-linux-amd64`,
  SHA-256 `3f241da6a5dc7a85fe851d3b42b77790b651bd36c7029382a701262bda832d20`.
- Node 22 (global `WebSocket`), Android build-tools 36.0.0 `apksigner`.
- `@noble/curves`, `@noble/hashes`, `@noble/ciphers` pinned in
  `scripts/zapstore/package.json`, isolated from the monorepo lockfile.
- Actions: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`,
  `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020`,
  `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`,
  `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`.
