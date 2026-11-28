# Production deployment authorization

A reviewed merge to protected `main` does not authorize or start a production deployment. Web, Server, and Docs use manual workflows bound to the exact reviewed live `main` commit.

## Component authorization

| Component | Workflow | Required pre-created protected environment | Repository approval variable |
|---|---|---|---|
| Web | `Deploy Web standalone (production, no annual Stage A)` | `web-production` | `WEB_STANDALONE_DEPLOY_APPROVED_SHA` |
| Server | `Deploy SilentSuite Server (production)` | `server-production` | `SERVER_DEPLOY_APPROVED_SHA` |
| Docs | `Deploy Docs standalone (production, no annual Stage A)` | `docs-production` | `DOCS_STANDALONE_DEPLOY_APPROVED_SHA` |

### One-time environment prerequisite

Production dispatch is operationally blocked until all three component environments above have been explicitly created and their live settings verified. Referencing a missing environment from a workflow can auto-create it without protection rules; that auto-created state is forbidden and does not satisfy this runbook.

Before the first dispatch, a repository owner must:

1. Create `web-production`, `server-production`, and `docs-production` in repository Settings.
2. Configure each environment's intended required reviewers/protection rules.
3. Configure a deployment branch policy that permits only `main`.
4. Verify the live environment API response and deployment-branch-policy list for each environment. Do not set an approval variable or dispatch any production workflow until this verification succeeds.

Live verification on 2026-08-02 confirms that all three component environments exist with a custom `main`-only deployment branch policy. The existing unprotected `production` environment remains unused and is not an acceptable substitute. Re-verify the environment and branch-policy APIs before each production rollout rather than relying on this historical checkpoint.

For each component:

1. Confirm the reviewed promotion commit is still the live head of `main` and required checks are green.
2. Set that component's repository approval variable to the exact 40-character live `main` SHA. The protected environment is a separate admission boundary; do not configure a same-named environment variable. Never use a branch, tag, shortened SHA, or mutable image tag.
3. Manually dispatch the component workflow from `main` with `expected_sha` equal to the same exact SHA.
4. The publication/build job has an Actions-level admission predicate requiring the workflow `github.sha` and its repository approval variable both to equal `expected_sha`, so shell control flow cannot authorize a different commit or bypass owner approval. It independently enters the protected environment and checks checkout HEAD, workflow SHA, live `main`, `expected_sha`, and the owner-approved SHA before publishing an image or artifact.
5. The deployment job has the same Actions-level identity and approval predicate and enters the protected environment separately. GitHub repository variables are snapshotted when the workflow run is queued, so both jobs use the same approved run-level snapshot. The deployment job repeats the exact identity and approval checks as its final shell step before the VPS or Cloudflare mutation as defense in depth.
6. Clear the approval variable after the authorized run reaches a terminal state.

Clearing or changing an approval variable affects only future workflow runs; it does not revoke jobs in an already queued run. To withdraw approval before mutation begins, cancel the queued run and verify that no mutation job started. Once a mutation job has started, do not cancel it as a substitute for rollback.

## Artifact identity

- Web and Server deploy the immutable digest produced by the admitted build job and verify the OCI revision label against the exact SHA.
- Docs builds once and uploads the exact VitePress output as a one-day workflow artifact. The build job passes the artifact ID and archive SHA-256; the deployment job downloads that exact archive through the GitHub API, fails closed on a digest mismatch, and deploys the extracted bytes without rebuilding.
- Web and Server retain their previous-image capture, health verification, and automatic rollback behavior.

Server migrations run with Compose interactive stdin and TTY attachment explicitly disabled. The SSH action supplies the deployment script through stdin; an interactive `docker compose run` can otherwise consume the remaining script, exit successfully after migration, and skip container replacement and running-image verification.

## SSH server verification for the Web mutation

The Web `Deploy via SSH` step runs the pinned `appleboy/ssh-action`, whose transport (drone-ssh 1.8.2) skips server host-key verification whenever its `fingerprint` input is empty, and an unprovisioned secret expands to the empty string. The step therefore binds `with.fingerprint` to the dedicated protected secret `VPS_SSH_FINGERPRINT`, and the `Require protected SSH host-key fingerprint before final authorization` step refuses a missing or malformed value immediately before the final live-main re-assertion.

Web production dispatch is blocked until `VPS_SSH_FINGERPRINT` is commissioned. No value is provisioned by the change that introduced this control, and merging it is not a deployment. Before any dispatch:

1. Derive the fingerprint only from independently trusted custody of the host key, re-validated out of band. Never derive the value from a fresh unauthenticated `ssh-keyscan`, from a workflow log, or from the connection being authorized.
2. The value is exactly `SHA256:` followed by the 43-character unpadded base64 digest printed by `ssh-keygen -l -E sha256`: no key-size prefix, comment, padding, whitespace, or second line. The transport compares one fingerprint against the single host key it negotiates, and its choice can differ from OpenSSH's: against a synthetic server offering RSA, ECDSA, and Ed25519 host keys, drone-ssh 1.8.2 negotiated the ECDSA key and rejected the other two fingerprints. Confirm from the same trusted custody the fingerprint of the host-key type the server offers to this transport; a trusted known-hosts entry of another key type yields a fingerprint that fails closed.
3. Store it as the `VPS_SSH_FINGERPRINT` secret of the `web-production` environment, which the standalone Web deployment jobs read. A names-only secret inventory does not verify the value; record who verified it, from which trusted source, and when.
4. Refresh the exact-SHA approval and every existing prerequisite above. This control adds a prerequisite and replaces none.

A host-key mismatch fails the SSH step before any remote command runs and leaves production untouched. Treat it as a possible interception or an unrecorded key rotation: stop, and do not remove, blank, or bypass the fingerprint to recover. A deliberate host-key rotation requires a separate trusted re-verification and an updated secret before the next dispatch.

CI proves the pinned transport rejects a changed server key before running a command against a synthetic loopback server (`scripts/ssh-host-verification-transport.test.mjs`). That proof does not establish which key production presents or that the stored secret matches it; only the custody steps above do.

## Rollback

An older ancestor is not eligible for direct dispatch because every workflow requires `expected_sha` to equal live `main`. To restore earlier behavior:

1. Create and review a revert PR directly against protected `main`.
2. Merge that reviewed revert through the normal protected-`main` gate.
3. Authorize and dispatch the resulting new live `main` SHA using the normal component procedure.

If an in-progress Web or Server replacement fails, its workflow restores the captured previously running image automatically. Verify the running image identity and service health before clearing the approval variable.

Never place approval values, credentials, Cloudflare tokens, SSH material, or production logs in issues, PR bodies, BMAD artifacts, or chat.

## Standalone Docs admission (no annual Stage A)

`Deploy Docs standalone (production, no annual Stage A)` (`.github/workflows/deploy-docs-standalone.yml`) publishes a Docs component change when no Billing or Web admission is in flight. It does not read, create, or require Stage A, a private App token, or any private HMAC key, and it does not touch Billing. It reuses the `docs-production` protected environment, the Cloudflare credentials, and the `deploy-docs-production` concurrency group, so Docs deployments serialize. Its repository approval variable is `DOCS_STANDALONE_DEPLOY_APPROVED_SHA`.

A standalone Docs deployment is a component deployment, not an annual cutover; it produces no Stage A, Stage B, or final manifest and must never be cited as annual proof. It runs these build-side guards: frozen-lockfile install, public analytics and relay checks, the billing copy guard, the Android distribution documentation test, and enabled-mode analytics verification of both the built and the downloaded bytes. A change that touches only Markdown can still alter the built bundle through the lockfile, so it is never treated as content-only.

1. Confirm the reviewed commit is still the live head of `main` and required checks, including the dependency audit, are green at that exact SHA.
2. Re-verify the `docs-production` environment and its `main`-only deployment branch policy as in the one-time environment prerequisite above.
3. Set the repository variable `DOCS_STANDALONE_DEPLOY_APPROVED_SHA` to the exact 40-character live `main` SHA. Do not configure a same-named environment variable.
4. Dispatch the workflow from `main` with `expected_sha` equal to the same SHA. Its secretless `admission` job reports one explicit diagnostic per unmet condition (not on `main`, malformed `expected_sha`, dispatched head mismatch, variable unarmed or armed for another SHA) and fails before any protected environment, secret, or build starts.
5. The build job builds once and uploads `docs-standalone-production-<sha>`. The deployment job downloads that exact archive through the GitHub API, verifies its digest and analytics bytes without rebuilding, re-asserts the exact owner-approved live `main` head as the step immediately before the Wrangler deployment, and then verifies that `https://docs.silentsuite.io/deployment-identity.json` serves the exact SHA.
6. Clear `DOCS_STANDALONE_DEPLOY_APPROVED_SHA` after the run reaches a terminal state; clearing affects only future runs.

The variable is snapshotted when the workflow run is queued, so clearing it does not revoke a queued run. To withdraw approval before mutation, cancel the run before the deployment job reaches `Deploy to production Worker`; once that step has started, do not cancel it as a substitute for rollback. Docs has no automatic rollback: restore earlier content through a reviewed revert PR to `main` and a fresh standalone authorization of the resulting live `main` SHA, as described under Rollback.

## Standalone Web admission (no annual Stage A)

`Deploy Web standalone (production, no annual Stage A)` (`.github/workflows/deploy-web-standalone.yml`) deploys a Web component change without the annual Billing-dependent Stage A. It does not read, create, or require Stage A, a private App token, or any private HMAC key; and it does not touch Billing, Server, or Docs. It reuses the `web-production` environment, the existing Web secrets, and the `deploy-web-production` concurrency group, so Web deployments serialize. Its repository approval variable is `WEB_STANDALONE_DEPLOY_APPROVED_SHA`. Merging this workflow, or any change it would deploy, starts no deployment.

A standalone Web deployment is a component deployment, not an annual cutover; it produces no Stage A, Stage B, or final manifest and must never be cited as annual proof. Re-read the live `web-production` protection and branch-policy APIs before each dispatch; do not assume required reviewers or other protections that the live response does not show.

1. Confirm the commit is the live head of `main`, its required checks (including the image verification and dependency audit) are green at that exact SHA, and the required independent reviews cover that exact SHA.
2. Confirm `VPS_SSH_FINGERPRINT` is commissioned as described above, no Billing or other Web deployment is queued or running against the shared host, and record the currently served Web SHA, running image, and the Billing identity, so you can show afterwards that Billing was unchanged.
3. Set the repository variable `WEB_STANDALONE_DEPLOY_APPROVED_SHA` to the exact 40-character live `main` SHA, without a same-named environment variable, and dispatch the workflow from `main` with `expected_sha` equal to the same SHA. Its secretless `admission` job names every unmet condition and fails before any protected environment, secret, or build starts.
4. The build job re-checks the live `main` identity, runs the frozen install, billing copy, public analytics, dependency audit, and tests, validates the production build arguments without printing them, and builds the image once with the existing hosted flags. The Docker build summary and build-record upload are disabled in this lane. It runs `scripts/verify-web-image.mjs` against that single image, re-asserts live `main` immediately before publication, pushes a run-specific tag, and checks that the raw registry manifest bytes hash to the pushed manifest digest. Before pushing, it reads the runner's image-store declaration, using the same rules as the deployment host, because the verified local image handle depends on it. On the containerd image store, the verified handle must be that manifest digest. On classic overlay2, it must be the manifest's configuration ID. Any other declaration refuses before publication. The manifest digest and the configuration ID read from those authenticated bytes are two different identities, and both are passed to deployment. On failure, the step names only the stage that failed.
5. The deployment job validates that handoff and the host-key fingerprint, re-asserts live `main` as the step immediately before `Deploy via SSH`, and replaces only the Compose `web` service by manifest digest with `--no-deps --no-build`. The remote script requires `docker`, `timeout`, `curl`, and `python3` on the host (python3 checks the identity JSON in isolated mode; the host does not need jq) and refuses before any replacement if they are missing or the predecessor is not healthy and identifiable. Before any replacement, it selects exactly one Docker local image handle from the daemon's image-store declaration: the manifest digest for the containerd snapshotter, or the configuration ID for classic overlay2. Any other, failed, or ambiguous declaration refuses. It then requires the digest-pulled image's handle, its exact `RepoDigests` entry, and its revision to match. Automatic rollback stays armed until the running local handle, revision, public root, and exact no-store `publicSha` match; on any failure it restores and verifies the predecessor image, revision, and served SHA, and the run still fails. A final runner-side check then re-verifies the public root and served SHA. A failure there happens after the SSH step has finished, so there is no automatic rollback: verify production and follow "Restore the captured predecessor after a post-SSH failure" below. Do not rely on a revert and fresh dispatch for this state; the fresh dispatch refuses before replacement while the running Web is unhealthy.
6. Clear `WEB_STANDALONE_DEPLOY_APPROVED_SHA` after the run reaches a terminal state, and confirm Billing and Docs still serve their recorded identities.

The variable is snapshotted when the workflow run is queued, so clearing it does not revoke a queued run. To withdraw approval before mutation, cancel the run before the deployment job reaches `Deploy via SSH`; once that step has started, do not cancel it as a substitute for rollback. A successful deployment or synthetic smoke check does not by itself prove a customer-reported behavior is resolved.

### Restore the captured predecessor after a post-SSH failure

Use this only when `Deploy via SSH` succeeded and the Web service then fails, for example at the runner-side check. Automatic rollback is already disarmed at that point. A revert and fresh dispatch cannot help either, because a fresh dispatch first requires a healthy, identifiable running predecessor. This restoration does not require the current service to be healthy. It falls under the documented rollback of the authorized deployment, not a new deployment: get the owner's go-ahead for the specific restoration, and do not touch any service other than Compose `web`.

The block runs outside GitHub workflow concurrency, so it is safe only inside an exclusive restoration window:

1. Clear `WEB_STANDALONE_DEPLOY_APPROVED_SHA` and read back its absence. New Web runs then fail admission. Clearing does not stop a run that already exists, because its approval was snapshotted when the run was queued.
2. List every queued, waiting, or in-progress run of `deploy-web-standalone.yml`. Cancel each run whose deployment job has not started `Deploy via SSH`, and confirm each has completed. If a run is already inside `Deploy via SSH`, let it finish, then restart this procedure from step 1, because it may have changed the running Web.
3. Get the Billing coordinator's explicit confirmation that nothing will operate on the shared host until this restoration has been verified, and record it. Do not re-arm any approval or dispatch any deployment until then.

The block re-reads the `web` container immediately before replacing it and refuses if it changed after validation. That check detects a breach of the window; it cannot make the check and the replacement atomic, so the window is what prevents the race.

These receipts use Docker's local image handle, the value of `docker inspect .Id` and of a container's `.Image`. It depends on the host's image store: under the containerd snapshotter it is the image's manifest digest, and under classic overlay2 it is the configuration digest. It is not a registry identity. The workflow's registry manifest digest and configuration ID binding stays in the build job. Earlier records that label a host value `config_id` or `image-config-id` hold this local handle.

4. From the failed run's `Deploy via SSH` log, copy `Predecessor receipt: image-store=<containerd|classic> image-handle=<sha256:…> revision=<40-hex SHA>` and `Candidate receipt: image-store=<same store> image-handle=<sha256:…>`. Both receipts must name the same store. Cross-check the predecessor receipt against the served SHA and running image recorded in the pre-deployment ledger (step 2 above). If either receipt is missing or they disagree with each other or with the ledger, stop: there is no trusted restoration target.
5. Set `IMAGE_STORE` and `CANDIDATE_IMAGE_HANDLE` from the candidate receipt, `PREVIOUS_IMAGE_HANDLE` and `PREVIOUS_REVISION` from the predecessor receipt, and `DEPLOY_SHA` to the failed `expected_sha`. Never use a mutable tag or the currently served identity as a restoration source.
6. Connect only through the trusted host-key custody described above (strict host-key checking against the commissioned fingerprint). Run the block below on the host with `IMAGE_NAME=ghcr.io/silent-suite/silentsuite-web` and the five values exported, for example by piping it to `bash -se`. Before any change, it refuses unless:
   - the host still declares the same image store;
   - Compose has exactly one `web` container in any state (running or exited), and it is exactly the failed candidate (local handle and revision);
   - the predecessor image is still cached locally with the recorded revision.

   It then retags that exact image, replaces only `web` with `--no-deps --no-build`, and verifies the running local handle, revision, public root and exact no-store `publicSha`.

```bash
set -Eeuo pipefail
for name in docker timeout curl python3; do command -v "$name" >/dev/null; done
[[ "${DEPLOY_SHA:-}" =~ ^[0-9a-f]{40}$ && "${#DEPLOY_SHA}" -eq 40 ]]
[[ "${IMAGE_STORE:-}" = containerd || "${IMAGE_STORE:-}" = classic ]]
[[ "${CANDIDATE_IMAGE_HANDLE:-}" =~ ^sha256:[0-9a-f]{64}$ && "${#CANDIDATE_IMAGE_HANDLE}" -eq 71 ]]
[[ "${PREVIOUS_IMAGE_HANDLE:-}" =~ ^sha256:[0-9a-f]{64}$ && "${#PREVIOUS_IMAGE_HANDLE}" -eq 71 ]]
[[ "${PREVIOUS_REVISION:-}" =~ ^[0-9a-f]{40}$ && "${#PREVIOUS_REVISION}" -eq 40 ]]
[ "$PREVIOUS_IMAGE_HANDLE" != "$CANDIDATE_IMAGE_HANDLE" ]
[ "$IMAGE_NAME" = ghcr.io/silent-suite/silentsuite-web ]
cd ~/etebase
docker() { command timeout 15s docker "$@"; }
revision_format='{{ index .Config.Labels "org.opencontainers.image.revision" }}'
# The receipts' handles are only comparable on a host that still declares the same image store.
STORE_PROGRAM='import json, sys
def unique(pairs):
    if len({key for key, _ in pairs}) != len(pairs): sys.exit(1)
    return dict(pairs)
info = json.loads(sys.stdin.read(), object_pairs_hook=unique)
if type(info) is not dict or sorted(info) != ["Driver", "DriverStatus"]: sys.exit(1)
driver, status = info["Driver"], info["DriverStatus"]
if type(driver) is not str or type(status) is not list: sys.exit(1)
if not all(type(entry) is list and len(entry) == 2 and all(type(part) is str for part in entry) for entry in status): sys.exit(1)
keys = [entry[0] for entry in status]
if len(set(keys)) != len(keys): sys.exit(1)
overlay2 = ["Backing Filesystem", "Supports d_type", "Using metacopy", "Native Overlay Diff", "userxattr"]
if status == [["driver-type", "io.containerd.snapshotter.v1"]] and driver not in ("", "overlay2"): print("containerd")
elif driver == "overlay2" and keys == overlay2 and status[0][1] != "" and all(entry[1] in ("true", "false") for entry in status[1:]): print("classic")
else: sys.exit(1)'
HOST_STORE=$(docker info --format '{"Driver":{{json .Driver}},"DriverStatus":{{json .DriverStatus}}}' | python3 -I -c "$STORE_PROGRAM" 2>/dev/null)
[ "$HOST_STORE" = "$IMAGE_STORE" ]
# Refuse unless the single web container (running or exited) is the failed candidate and the exact predecessor is cached.
CURRENT_CONTAINER=$(docker compose ps -a -q web)
[[ "$CURRENT_CONTAINER" =~ ^[0-9a-f]{64}$ ]]
CURRENT_IMAGE_HANDLE=$(docker inspect "$CURRENT_CONTAINER" --format '{{.Image}}')
CURRENT_REVISION=$(docker inspect "$CURRENT_CONTAINER" --format "$revision_format")
[ "$CURRENT_IMAGE_HANDLE" = "$CANDIDATE_IMAGE_HANDLE" ]
[ "$CURRENT_REVISION" = "$DEPLOY_SHA" ]
CACHED_IMAGE_HANDLE=$(docker inspect "$PREVIOUS_IMAGE_HANDLE" --format '{{.Id}}')
CACHED_REVISION=$(docker inspect "$PREVIOUS_IMAGE_HANDLE" --format "$revision_format")
[ "$CACHED_IMAGE_HANDLE" = "$PREVIOUS_IMAGE_HANDLE" ]
[ "$CACHED_REVISION" = "$PREVIOUS_REVISION" ]
RESTORE_TAG="${IMAGE_NAME}:rollback-${DEPLOY_SHA}"
docker tag "$PREVIOUS_IMAGE_HANDLE" "$RESTORE_TAG"
[ "$(docker inspect "$RESTORE_TAG" --format '{{.Id}}')" = "$PREVIOUS_IMAGE_HANDLE" ]
RESTORE_OVERRIDE=$(mktemp)
HEALTH_HEADERS=$(mktemp)
HEALTH_BODY=$(mktemp)
trap 'rm -f "$RESTORE_OVERRIDE" "$HEALTH_HEADERS" "$HEALTH_BODY"' EXIT
cat > "$RESTORE_OVERRIDE" <<EOF
services:
  web:
    image: ${RESTORE_TAG}
EOF
# Last check before the only mutation: refuse if anything replaced web since validation.
[ "$(docker compose ps -a -q web)" = "$CURRENT_CONTAINER" ]
[ "$(docker inspect "$CURRENT_CONTAINER" --format '{{.Image}}')" = "$CANDIDATE_IMAGE_HANDLE" ]
command timeout 90s docker compose -f docker-compose.yml -f "$RESTORE_OVERRIDE" up -d --force-recreate --no-deps --no-build web
RESTORED_CONTAINER=$(docker compose ps -q web)
[ "$(docker inspect "$RESTORED_CONTAINER" --format '{{.Image}}')" = "$PREVIOUS_IMAGE_HANDLE" ]
[ "$(docker inspect "$RESTORED_CONTAINER" --format "$revision_format")" = "$PREVIOUS_REVISION" ]
check_web() {
  local status
  status=$(curl --proto '=https' --connect-timeout 3 --max-time 5 -fsS -H 'Cache-Control: no-cache' -o /dev/null -w '%{http_code}' https://app.silentsuite.io/) || return 1
  [ "$status" = 200 ] || return 1
  status=$(curl --proto '=https' --connect-timeout 3 --max-time 5 -fsS -H 'Cache-Control: no-cache' -D "$HEALTH_HEADERS" -o "$HEALTH_BODY" -w '%{http_code}' https://app.silentsuite.io/api/deployment-identity) || return 1
  [ "$status" = 200 ] || return 1
  grep -Eiq '^cache-control:.*[[:space:],]no-store([[:space:],;]|$)' "$HEALTH_HEADERS" || return 1
  python3 -I -c 'import json, sys; body = json.loads(open(sys.argv[1], encoding="utf-8").read(), object_pairs_hook=lambda pairs: pairs); sys.exit(0 if body == [("publicSha", sys.argv[2])] else 1)' "$HEALTH_BODY" "$PREVIOUS_REVISION" >/dev/null 2>&1
}
for attempt in 1 2 3 4 5 6; do
  if check_web; then echo "Predecessor ${PREVIOUS_REVISION} restored and serving its exact identity"; exit 0; fi
  sleep 5
done
echo "Predecessor container restored but public identity not verified; operator intervention is required" >&2
exit 1
```

7. Record the restoration, its verification output and the restored identities on the deployment record, then tell the Billing coordinator the window is closed. Keep the approvals cleared until a new, separately authorized deployment. A failed refusal check leaves Compose `web` unchanged: investigate it rather than editing the block or its values, and treat a changed container as a breach of the window.

## Billing v2 contract copy

`contracts/annual-only-billing-v2.schema.json` and its `.sha256` exist in this repository and in the private Billing repository, and must stay byte-identical. CI checks only this repository's copy (`pnpm run check:annual-billing-v2-contract`). Before merging a change to either file in either repository, compare the two copies from the public checkout against a checkout of the exact private candidate:

```bash
pnpm run check:annual-public-contract-copy <private checkout>
```
