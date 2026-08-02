# Production deployment authorization

Promotion to `main` does not authorize or start a production deployment. Web, Server, and Docs use manual workflows bound to the exact reviewed live `main` commit.

## Component authorization

| Component | Workflow | Protected environment | Approval variable |
|---|---|---|---|
| Web | `Deploy Web App (production)` | `web-production` | `WEB_DEPLOY_APPROVED_SHA` |
| Server | `Deploy SilentSuite Server (production)` | `server-production` | `SERVER_DEPLOY_APPROVED_SHA` |
| Docs | `Deploy Docs (production)` | `docs-production` | `DOCS_DEPLOY_APPROVED_SHA` |

For each component:

1. Confirm the reviewed promotion commit is still the live head of `main` and required checks are green.
2. Set that component's repository approval variable to the exact 40-character live `main` SHA. The protected environment is a separate admission boundary; do not configure a same-named environment variable. Never use a branch, tag, shortened SHA, or mutable image tag.
3. Manually dispatch the component workflow from `main` with `expected_sha` equal to the same exact SHA.
4. The publication/build job independently enters the protected environment, evaluates the repository approval variable for that job, and checks checkout HEAD, workflow SHA, live `main`, `expected_sha`, and the owner-approved SHA before publishing an image or artifact.
5. The deployment job enters the protected environment separately and evaluates a fresh repository-variable snapshot after the build finishes. It repeats the exact identity checks as its final step before the VPS or Cloudflare mutation.
6. Clear the approval variable after the authorized run reaches a terminal state.

Clearing or changing approval after the build and before the deployment job starts makes deployment fail closed. Approval is not dynamically reloaded after a deployment job has started, so do not claim or rely on mid-job revocation. Do not cancel a mutation job as a substitute for rollback.

## Artifact identity

- Web and Server deploy the immutable digest produced by the admitted build job and verify the OCI revision label against the exact SHA.
- Docs builds once and uploads the exact VitePress output as a one-day workflow artifact. The build job passes the artifact ID and archive SHA-256; the deployment job downloads that exact archive through the GitHub API, fails closed on a digest mismatch, and deploys the extracted bytes without rebuilding.
- Web and Server retain their previous-image capture, health verification, and automatic rollback behavior.

## Rollback

An older ancestor is not eligible for direct dispatch because every workflow requires `expected_sha` to equal live `main`. To restore earlier behavior:

1. Create and review a revert on `dev`.
2. Promote that reviewed tree through the normal `dev` to `main` gate.
3. Authorize and dispatch the resulting new live `main` SHA using the normal component procedure.

If an in-progress Web or Server replacement fails, its workflow restores the captured previously running image automatically. Verify the running image identity and service health before clearing the approval variable.

Never place approval values, credentials, Cloudflare tokens, SSH material, or production logs in issues, PR bodies, BMAD artifacts, or chat.
