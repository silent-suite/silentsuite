# Annual public review producer prerequisite

Before dispatching `.github/workflows/annual-only-public-review.yml`, the owner must provision an explicit `annual-public-review` environment with a main-only deployment branch policy and exactly one secret: `ANNUAL_PUBLIC_REVIEW_HMAC_KEY`. Later, the owner copies the existing HMAC root into that secret via stdin. This repository records no secret value. The environment is not provisioned by this change.

Promotion gate: from this worktree, run `pnpm run check:annual-public-contract-copy`; it compares only the two v2 schemas, the annual-only-billing-v2 schema, and its pinned source digest against the internal worktree byte-for-byte.
