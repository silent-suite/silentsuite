# Billing link-proof rollout

This is a bounded, staged cutover. Do not put any secret values in source control or tickets.

1. Provision the same dedicated `ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY` on the hosted Etebase server and Billing. Configure Billing's `ETEBASE_SERVER_URL` with its HTTPS URL. Temporarily set `ETEBASE_LEGACY_BEARER_IDENTITY_ROLLOUT_ENABLED=true` on the Etebase server, but do not yet deploy the proof-producing web image.
2. Promote the public commit. Let the exact-SHA Etebase server image deploy first. The web deployment gate must remain closed because the old Billing service has no `/health/link-proof` readiness endpoint; the existing web container remains active.
3. Deploy Billing with `ETEBASE_LEGACY_BEARER_ROLLOUT_ENABLED=true`. This temporary mode verifies a legacy bearer only by calling Etebase's authenticated identity endpoint; it never restores Billing database access to Etebase token tables. Confirm `https://api.silentsuite.io/health/link-proof` returns `200`.
4. Rerun the failed web deploy job for the same immutable public commit. Its readiness gate must pass before the exact-SHA web image replaces the old container. Confirm hosted signup provisioning, paid-signup finalization, and fresh login all use link proofs. Confirm self-host/custom-server journeys make no hosted Billing proof calls.
5. Disable both temporary flags: unset `ETEBASE_LEGACY_BEARER_ROLLOUT_ENABLED` in Billing and `ETEBASE_LEGACY_BEARER_IDENTITY_ROLLOUT_ENABLED` on Etebase. Restart the affected services and verify requests containing legacy bearers are rejected.
6. Confirm migration `0025_remove_etebase_session_verifier.sql` has removed the old verifier function and any dependent Billing privilege. Remove the temporary Etebase identity path in the next source cleanup after the cutover window.

Missing machine-key configuration intentionally makes proof consumption fail closed; it does not prevent a self-hosted Etebase server from starting.
