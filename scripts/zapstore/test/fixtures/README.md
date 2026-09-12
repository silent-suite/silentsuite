# Test fixtures

All fixtures are labelled by origin. None of them came from a live publication.

- `zsp-unsigned-offline-v0.5.6-beta.jsonl` — genuine stdout of the pinned
  `zsp` 0.4.17 run in **unsigned npub offline mode** against the exact
  v0.5.6-beta APK (sha256 `3007b514…09d4`) and local copies of the approved
  media and changelog 20. Three unsigned events, no `sig` field. The `filename`
  tag reflects the local basename used during that run, not the canonical
  release asset name; tests account for that.
- `zsp-unsigned-offline-inputs.json` — media/changelog hash manifest recorded in
  the same run, bound to source commit `3111352d…`.
- `relay-observed-2026-09-12.json` — read-only subscription result from
  `wss://relay.zapstore.dev` (EOSE reached, 20 events). These are real signed
  events and are used to prove that id and Schnorr verification pass on real
  data and fail on tampered copies.
- `apksigner-verifies.txt` / `apksigner-foreign-signer.txt` — **synthetic**
  samples in the `apksigner verify --print-certs -v` output format. No local
  `apksigner` exists on the development machine; the real tool runs only in CI.
