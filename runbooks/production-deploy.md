# Production deployment authorization

Promotion to `main` does not authorize or start a production deployment. Web, Server, and Docs use manual workflows bound to the exact reviewed live `main` commit.

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

1. Create and review a revert on `dev`.
2. Promote that reviewed tree through the normal `dev` to `main` gate.
3. Authorize and dispatch the resulting new live `main` SHA using the normal component procedure.

If an in-progress Web or Server replacement fails, its workflow restores the captured previously running image automatically. Verify the running image identity and service health before clearing the approval variable.

Never place approval values, credentials, Cloudflare tokens, SSH material, or production logs in issues, PR bodies, BMAD artifacts, or chat.
