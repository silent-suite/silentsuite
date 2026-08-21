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

1. **Stage A — private pre-public admission.** The private deployment uploads exactly `annual-only-pre-public-admission.json` inside `annual-only-pre-public-admission-<private-run-id>-<private-run-attempt>`. Web and Docs each receive the explicit private run ID, attempt, and immutable artifact ID. A protected GitHub App token scoped only to `silent-suite/silentsuite-internal` fetches that one artifact. The public guard verifies its API run/attempt/artifact metadata, archive digest, closed canonical schema and HMAC (`ANNUAL_PRIVATE_ADMISSION_HMAC_KEY`), all private image/build/QA/provider/disclosure bindings, reviewed public artifact, and `expectedPublicSha == expected_sha`. A Stage A admission has no `clientServedAt` or `verifiedAt`; any such field rejects it.
2. **Public deployment.** Only the exact protected `main` SHA admitted by Stage A may build and deploy. Web verifies its running OCI revision and then the public `/api/deployment-identity` response; Docs verifies the deployed `deployment-identity.json`. Both must serve that exact SHA after their respective deployment before their jobs succeed. Preview and ordinary CI cannot access either cutover HMAC key and cannot emit service evidence.
3. **Stage B — truthful public-served attestation.** Dispatch `Annual-only Public Cutover (Stage B)` from `main` with the same exact SHA and Stage A identity. Its `annual-public-cutover` protected environment requires approval in addition to the normal `web-production` and `docs-production` environments. After that approval and after every prior identity check, its attestation job freshly performs exact, no-cache `GET` probes of both `https://app.silentsuite.io/api/deployment-identity` and `https://docs.silentsuite.io/deployment-identity.json` immediately before artifact reservation/signing. Each must return HTTP 200 and the exact sole JSON member `{ "publicSha": "<expected_sha>" }`; network, status, body, or either-surface mismatch fails closed. Do not treat a reusable-deployment output as a substitute for these probes. Only then may it reserve and finalize `annual-only-public-served-attestation-<public-run-id>-<public-run-attempt>`. It derives UTC-second `clientServedAt` only after both probes, completes all admission/artifact checks, then derives `verifiedAt` with `verifiedAt >= clientServedAt` before signing. The attestation binds the exact Stage A bytes digest and all canonical private/public identities, then signs with `ANNUAL_PUBLIC_SERVED_HMAC_KEY`.
4. **Stage C — private finalization.** The private `annual_finalize_only` continuation downloads the exact Stage B artifact by public repository/run/attempt/artifact ID and name, verifies it, and produces the private final cutover manifest. Never copy that final manifest or a serving timestamp into a Stage A input, this public repository, a preview, or a pre-deploy guard.

Before using the cutover workflow, create and protect `annual-public-cutover` with a `main`-only deployment branch policy. Set `ANNUAL_PUBLIC_CUTOVER_APPROVED_SHA` to the same full SHA only after Stage A is independently reviewed; clear it after the run. Store `ANNUAL_PRIVATE_ADMISSION_APP_ID`, `ANNUAL_PRIVATE_ADMISSION_APP_PRIVATE_KEY`, `ANNUAL_PRIVATE_ADMISSION_HMAC_KEY`, and `ANNUAL_PUBLIC_SERVED_HMAC_KEY` only as protected environment secrets. The GitHub App installation must be restricted to only `silent-suite/silentsuite-internal`, and its exact workflow-granted scope must be `Actions: read` (`permission-actions: read`) with no broader App permission. Reusable Web and Docs calls map only their declared necessary secrets: admission credentials remain explicit, and the Cloudflare credentials remain explicitly available only to Docs; never use `secrets: inherit` or log a secret. No fork, branch name, tag, mutable ref, public token, health endpoint, or fallback handoff is an admission substitute.
