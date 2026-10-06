# Results inventory (synthetic experiment)

Local command: `node --test experiments/offline-protocol-744/*.test.cjs` on Node 22.23.2.
Database fixtures (`server_fence_fixture_test.py`) run only in hosted CI; they are never
run locally. A skipped PostgreSQL case would count as unverified (the workflow sets
`OFFLINE744_REQUIRE_PG=1`).

## Execution history (2026-10-06)

| Stage | Commit | What ran | Outcome |
|---|---|---|---|
| Initial local RED | pre-commit | Node, candidate delegating to control | 15 fake-IDB schedules failed behaviourally |
| Initial local GREEN | pre-commit | Node | 19/19 pass |
| Initial hosted run 37490078951 | `a4a20fd` | Node + PostgreSQL + SQLite | 19 Node + 8 PG + 8 SQLite passed. A later technical review still found 13 problems. The authoring session hit its deadline without a final handoff. |
| Database regression checkpoint, hosted run 37502658393 | `c36282e` | Node + PG + SQLite | Node 19/19 passed. Database: 28 methods (14 PG, 14 SQLite), 9 failures: 7 behavioural (foreign-principal write on both engines; two outside-collection subtests on both engines; PostgreSQL independent lock-domain overwrite) and 2 setup failures (global-uid schema) |
| Correction pass, local RED | pre-commit | Node with new `correction.test.cjs` against the previous candidate | 27 tests: 19 pass, 8 fail; all 8 are R02–R09 behavioural assertions |
| Correction pass, local GREEN | pre-commit | Node | 28/28 pass (23 fake-IDB + 5 SDK), 0 skipped |
| Correction pass, hosted | — | Database fixtures | Not yet run as of this file; results are recorded in the CI run, not here |

## Inventory by reviewed finding

| Finding | Tests | Kind | Local status | Remaining unproved |
|---|---|---|---|---|
| 2 receipt binding | R02, F03 | candidate-only; paired | pass | real server receipts |
| 3 activation at dispatch | R03, F10, every dispatching schedule now activates first | candidate-only; paired | pass | real server activation; browser `Origin`; native/bridge behaviour |
| 4 favourite after retirement | R04, F02, P01 | candidate-only; paired | pass | app favourite caller |
| 5 refresh capture and tombstones | R05, F04, F04b | candidate-only; paired | pass | app publishers (initial load, manual sync, event refresh) |
| 6 common admission policy | R06, F12, F13 | candidate-only; paired | pass | app collection and reconcile callers |
| 7 legacy ownership | R07 | candidate-only | pass | real legacy rows' original intent stays unknowable |
| 8 blocked cutover interval | R08, F05 | candidate-only; paired | pass | real multi-tab blocking; claim narrowed (preservation starts at upgrade) |
| 9 raw UTF-8 authentication | R09, F06 | candidate-only; paired | pass | browser `CryptoKey` persistence |
| 10 SQL ownership and identity | `server_fence_fixture_test.py` | candidate-only, CI-only | not run locally | hosted result; real server authorization |
| 11 durable SDK snapshots | S0–S4 | library controls | pass | server acceptance of re-sent revisions; S3 conflict is injected |
| 13 documentation | SPEC.md, this file | — | updated | — |

Findings 1 and 12 are operational (a shared docs-preview deployment triggered by a sibling
workflow, and an identity verification that could not run). They are not runtime defects
and this experiment does not change them.

## Limits

- Passing these schedules supports only the proposed synthetic protocol. No application
  code exists or was changed.
- The candidate moves display, session and replay authority into one queue database and
  adds a synthetic cache version bump. Both would be application/storage changes needing
  separate owner decisions.
- Legacy rows' original intent remains unknown; the protocol keeps them unverified and
  never auto-dispatches them.
