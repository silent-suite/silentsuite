# Billing link-proof rollout

This is a bounded, staged cutover. Do not put any secret values in source control or tickets.

1. Provision the same dedicated `ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY` on the hosted Etebase server and Billing. Configure Billing's `ETEBASE_SERVER_URL` with its HTTPS URL. Temporarily set `ETEBASE_LEGACY_BEARER_IDENTITY_ROLLOUT_ENABLED=true` on the Etebase server, but do not yet deploy the proof-producing web image.
2. Promote the public commit. Let the exact-SHA Etebase server image deploy first. The web deployment gate must remain closed because the old Billing service has no `/health/link-proof` readiness endpoint; the existing web container remains active.
3. Deploy Billing with `ETEBASE_LEGACY_BEARER_ROLLOUT_ENABLED=true`. This temporary mode verifies a legacy bearer only by calling Etebase's authenticated identity endpoint; it never restores Billing database access to Etebase token tables. Confirm `https://api.silentsuite.io/health/link-proof` returns `200`.
4. Rerun the failed web deploy job for the same immutable public commit. Its readiness gate must pass before the exact-SHA web image replaces the old container. Confirm hosted signup provisioning, paid-signup finalization, and fresh login all use link proofs. Confirm self-host/custom-server journeys make no hosted Billing proof calls.
5. Disable both temporary flags: unset `ETEBASE_LEGACY_BEARER_ROLLOUT_ENABLED` in Billing and `ETEBASE_LEGACY_BEARER_IDENTITY_ROLLOUT_ENABLED` on Etebase. Restart the affected services and verify requests containing legacy bearers are rejected.
6. Confirm migration `0025_retain_etebase_session_verifier.sql` has retained and validated the old verifier function and its bounded Billing privilege while any rollback-eligible Billing image can still call it. Remove the verifier only in a later reviewed contract release after the rollback window has closed and no rollback-eligible image depends on it. Remove the temporary Etebase identity path in that same or a later reviewed cleanup.

## Rollback-window closure and cleanup admission

Keep the dormant routes, false-by-default flags, verifier function, bounded execute grant, previous Billing image, and rollback configuration intact during the post-cutover soak. Disabled compatibility is not evidence that rollback compatibility is disposable.

Prepare cleanup under issue `silent-suite/silentsuite#621`, but do not merge or deploy the destructive cleanup until all of these conditions are recorded with sanitized evidence:

1. At least 48 hours of clean post-cutover production soak has elapsed.
2. The current proof-only Web, Server, and Billing path passes immediately before cleanup: proof issue, proof exchange, Billing session read, logout, revoked refresh rejection, and legacy bearer rejection.
3. The owner explicitly closes the previous-image rollback window and declares the prior Billing image non-restorable.
4. The public cleanup removes the temporary Etebase identity route and flag without changing the opaque proof contract.
5. The internal cleanup separately removes the legacy bearer request field/resolver and uses a reviewed migration to remove the retained verifier function and bounded grant.
6. Both cleanup heads pass exact-head CI and substantive review before promotion; the database migration is exercised under the restricted Billing role.
7. Only after the proof-only images are healthy in production may the retired image, stale Compose mappings, and rollback backup be removed under a separate operator checkpoint.

If any condition is missing, preserve the rollback-compatible code and verifier. Do not reinterpret elapsed time, disabled flags, or a healthy current image as implicit cleanup approval.

Missing machine-key configuration intentionally makes proof consumption fail closed; it does not prevent a self-hosted Etebase server from starting.
