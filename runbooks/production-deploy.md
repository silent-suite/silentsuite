# Production deployment authorization

A reviewed merge to protected `main` does not authorize or start a production deployment. Web, Server, and Docs use manual workflows bound to the exact reviewed live `main` commit.

## Component authorization

| Component | Workflow | Required pre-created protected environment | Repository approval variable |
|---|---|---|---|
| Web | `Deploy Web App (production)` | `web-production` | `WEB_DEPLOY_APPROVED_SHA` |
| Server | `Deploy SilentSuite Server (production)` | `server-production` | `SERVER_DEPLOY_APPROVED_SHA` |
| Docs | `Deploy Docs (production)` | `docs-production` | `DOCS_DEPLOY_APPROVED_SHA` |

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

## Rollback

An older ancestor is not eligible for direct dispatch because every workflow requires `expected_sha` to equal live `main`. To restore earlier behavior:

1. Create and review a revert PR directly against protected `main`.
2. Merge that reviewed revert through the normal protected-`main` gate.
3. Authorize and dispatch the resulting new live `main` SHA using the normal component procedure.

If an in-progress Web or Server replacement fails, its workflow restores the captured previously running image automatically. Verify the running image identity and service health before clearing the approval variable.

Never place approval values, credentials, Cloudflare tokens, SSH material, or production logs in issues, PR bodies, BMAD artifacts, or chat.

## Annual-only private/public handshake

The annual-only production path is deliberately a three-stage sequence. The public repository owns Stage B only; it never creates the final cutover manifest.

1. **Stage A — private pre-public admission (v2).** A private Stage A producer uploads exactly `annual-only-pre-public-admission.json` inside `annual-only-pre-public-admission-<private-run-id>-<private-run-attempt>`. Exactly two private workflows may produce it: `deploy.yml` (the additive deployment) and `annual-only-stage-a-reattest.yml` (a non-mutating re-attestation from a later private `main`, used when either `main` advanced after the deployment). Web and Docs each receive the explicit private run ID, attempt, and immutable artifact ID. A protected GitHub App token scoped only to `silent-suite/silentsuite-internal` fetches that one artifact. The public guard verifies its API run/attempt/artifact metadata, producer workflow path, archive digest, closed canonical v2 schema and HMAC (`ANNUAL_PRIVATE_ADMISSION_HMAC_KEY`), all private image/build/QA/provider/disclosure bindings, the reviewed public artifact, and `expectedPublicSha == expected_sha`. v2 separates two identities: `privateSha`/`producerRun` are the producer source and are bound to the producing run's head and artifact; `deployedRuntime` (`privateSha`, `imageDigest`, `phase: additive`, `deployedAt`, `observedAt`, `reobservedAt`) is the deployed identity the private producer observed twice through its authenticated runtime endpoint, must equal the admitted image, and may name an older private SHA than the producer. The retired v1 wire is rejected explicitly. A Stage A admission has no `clientServedAt` or `verifiedAt`; any such field rejects it.
2. **Public deployment.** Only the exact protected `main` SHA admitted by Stage A may build and deploy. Web verifies its running OCI revision and then the public `/api/deployment-identity` response; Docs verifies the deployed `deployment-identity.json`. Both must serve that exact SHA after their respective deployment before their jobs succeed. Preview and ordinary CI cannot access either cutover HMAC key and cannot emit service evidence.
3. **Stage B — truthful public-served attestation.** Dispatch `Annual-only Public Cutover (Stage B)` from `main` with the same exact SHA and Stage A identity. Its `annual-public-cutover` protected environment requires approval in addition to the normal `web-production` and `docs-production` environments. After that approval and after every prior identity check, its attestation job freshly performs exact, no-cache `GET` probes of both `https://app.silentsuite.io/api/deployment-identity` and `https://docs.silentsuite.io/deployment-identity.json` immediately before artifact reservation/signing. Each must return HTTP 200 and the exact sole JSON member `{ "publicSha": "<expected_sha>" }`; network, status, body, or either-surface mismatch fails closed. Do not treat a reusable-deployment output as a substitute for these probes. Only then may it reserve and finalize `annual-only-public-served-attestation-<public-run-id>-<public-run-attempt>`. That reservation talks to the Actions artifact service directly, so the publisher runs as the local JavaScript action `.github/actions/publish-annual-public-served-attestation`: only a JavaScript action natively receives `ACTIONS_RESULTS_URL` and `ACTIONS_RUNTIME_TOKEN`, which are not reliably exported to a plain shell `run:` child process. Those runtime credentials stay inside the publisher process and are never written to `GITHUB_ENV`, a step output, workflow `env`, or a log. No other artifact publisher in this repository is exposed to the same boundary: every one of them uploads through the `actions/upload-artifact` JavaScript action. The publisher speaks the same ProtoJSON wire form as that pinned official bundle: `mime_type` and `hash` are bare strings (protobuf wrapper scalars, never `{ value }`), `size` is a decimal string, and a rejected call reports only the HTTP status and Twirp error code, never the response body, URL, or token. It derives UTC-second `clientServedAt` only after both probes, completes all admission/artifact checks, then derives `verifiedAt` with `verifiedAt >= clientServedAt` before signing. The v2 attestation binds the exact Stage A bytes digest, carries the Stage A `producerRun` and `deployedRuntime` verbatim, and all canonical private/public identities, then signs with `ANNUAL_PUBLIC_SERVED_HMAC_KEY`.
4. **Stage C — private finalization.** The private `annual_finalize_only` continuation downloads the exact Stage B artifact by public repository/run/attempt/artifact ID and name, verifies it, and produces the private final cutover manifest. Never copy that final manifest or a serving timestamp into a Stage A input, this public repository, a preview, or a pre-deploy guard.

Before using the cutover workflow, create and protect `annual-public-cutover` with a `main`-only deployment branch policy. Stage B is admitted by **three** repository variables, not one: set `ANNUAL_PUBLIC_CUTOVER_APPROVED_SHA`, `WEB_DEPLOY_APPROVED_SHA`, and `DOCS_DEPLOY_APPROVED_SHA` to the same full SHA only after Stage A is independently reviewed, and clear all three after the run. The reusable Web and Docs callees gate their own jobs on their own deploy-surface variable, so arming only the cutover variable leaves every callee job skipped, both caller jobs `skipped`, and the run concluded `skipped` with zero jobs and no logs. The unconditional `admission` preflight job now observes all three and fails with one `::error::` per unmet condition instead, and the always()-run `cutover-outcome` job fails the run if any admitted job did not succeed, so a non-executing cutover is never silent. `tests/test_annual_cutover_admission_preflight.py` enforces that contract. Store `ANNUAL_PRIVATE_ADMISSION_APP_ID`, `ANNUAL_PRIVATE_ADMISSION_APP_PRIVATE_KEY`, `ANNUAL_PRIVATE_ADMISSION_HMAC_KEY`, and `ANNUAL_PUBLIC_SERVED_HMAC_KEY` only as protected environment secrets. The GitHub App installation must be restricted to only `silent-suite/silentsuite-internal`, and its exact workflow-granted scope must be `Actions: read` (`permission-actions: read`) with no broader App permission. Reusable Web and Docs calls map only their declared necessary secrets: admission credentials remain explicit, and the Cloudflare credentials remain explicitly available only to Docs; never use `secrets: inherit` or log a secret. Each reusable caller job also declares the least-privilege token its callee jobs request (`contents: read` + `packages: write` for Web, `actions: read` + `contents: read` for Docs); without those explicit maps the caller inherits the read-only default grant and GitHub rejects the dispatch during startup validation with zero jobs created. `tests/test_reusable_workflow_caller_permissions.py` enforces this subset for every local reusable caller. No fork, branch name, tag, mutable ref, public token, health endpoint, or fallback handoff is an admission substitute.

### If a Stage B dispatch fails startup validation, admission, deployment, or attestation

A startup-validation failure creates zero jobs, and an `admission` refusal creates no deploying jobs, so nothing was deployed and no attestation exists. A later failure can instead leave Web and Docs deployed with no Stage B artifact: run `33907789637` attempt 1 deployed both surfaces and then the `attest` job was rejected before artifact reservation with `Actions artifact results URL is invalid`, because the publisher ran as a plain shell `run:` step that never received the Actions artifact runtime variables. That is still an incomplete cutover — Stage C has nothing to consume — and the deployed surfaces are left in place; do not roll them back to force a clean retry. In every case treat the approved SHA window as spent, and recover in this exact order.

1. **Clear `ANNUAL_PUBLIC_CUTOVER_APPROVED_SHA`, `WEB_DEPLOY_APPROVED_SHA`, and `DOCS_DEPLOY_APPROVED_SHA` immediately**, before any other remediation. A failed dispatch leaves the variable set to a SHA that is still armed; leaving it armed means the next dispatch — including one triggered by someone else, or by a re-run — can proceed against a head nobody re-reviewed.
2. **Fix the cause on a feature branch and merge it to `main` through the normal review gates.** Never hand-edit the workflow on `main`, and never re-arm the variable to get "one more attempt" at the old SHA.
3. **Recognise that the fix has invalidated the old approval.** Merging advances public `main`, so the previously approved SHA is no longer the head being cut over, and the Stage A run bound to it no longer describes what would be served. The old Stage A identity is dead; it may not be reused, re-signed, or referenced by the new dispatch.
4. **Obtain a fresh Stage A run bound to the new public `main` head**, and have it independently reviewed exactly as the first one was. A re-review of the old Stage A does not satisfy this. When Billing is already healthy at additive, the private non-mutating `annual-only-stage-a-reattest.yml` produces that fresh Stage A from the current private `main` without redeploying; it consumes the new public review and observes the live deployment, and its artifact is consumed here exactly like a deployment Stage A.
5. **Only then set all three approval variables to the new full SHA**, arming them solely for the new dispatch, which must carry the new immutable Stage A identity. Clear all three again after the run ends, whatever its outcome.

Each retry is a complete new three-stage sequence, not a resumption. Two candidate heads is the limit; if a third would be needed, stop and re-plan rather than dispatching again.
