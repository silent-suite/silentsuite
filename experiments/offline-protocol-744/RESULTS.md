# Results inventory (synthetic experiment)

Local command: `node --test experiments/offline-protocol-744/*.test.cjs` on Node 22.23.2.

- **RED step:** with `candidate.cjs` delegating to the control, all 15 fake-IDB schedules
  failed on behavioural assertions (15 fail, 0 pass, exit 1).
- **GREEN step:** after implementing the candidate, 19 of 19 passed (15 fake-IDB + 4 SDK),
  exit 0.
- **Database fixtures:** `server_fence_fixture_test.py` has not been run locally.
  **PENDING CI.** A skipped PostgreSQL case counts as unverified (the workflow sets
  `OFFLINE744_REQUIRE_PG=1`, so a missing service fails rather than skips).

| Finding | Test | Substrate | Control | Candidate (local) | Missing proof |
|---|---|---|---|---|---|
| 1 | F01, F01b | fake-IDB | loss erased by replacement | loss record kept; loss capacity rejects without erasing | app store mapping |
| 2 | F02 | fake-IDB | plaintext favourite and body visible in raw dump | no plaintext in raw dump; favourite decrypts in a second context | browser storage inspection, logs |
| 3 | F03 | fake-IDB | second dispatch overwrites; aborted-but-committed revision lost → resend | second context refused; immutable attempt found → applied, ack, exact publish | real server ordering |
| 4 | F04, F04b | fake-IDB | stale acked body published; refresh overwrites live intent | stale publication refused; durable intent survives refresh and restart | all app publishers (initial load, manual sync, event refresh) not wired |
| 5 | F05 | fake-IDB | old cache writer overwrites pinned evidence | old cache connection blocks cache v6 upgrade; afterwards old cache and queue opens fail with VersionError; copy is byte-exact and not dispatchable | real multi-tab blocking; blocked-tab UX |
| 6 | F06 | fake-IDB | locked migration releases the only ciphertext | locked → pending with ciphertext; idempotent resume; auth failure → pending, no loss; malformed → loss | browser CryptoKey persistence |
| 7 | F07 | fake-IDB | delete and missing update retired | `unverified-delete`, `legacy-unresolved`; none dispatchable | none of legacy intent is recoverable by design |
| 8 | F08 | fake-IDB | stale same-account context writes and refreshes | `owner-changed` on admit and refresh | in-memory domain stores outside IDB |
| 9 | F09 | fake-IDB | queue owner B with session A; aborted write reported done | stale login refused; owner and session in one record; unlock keeps work; aborted write rejects | moving the real session store is an app change (not done) |
| 10 | F10 + fixtures | fake-IDB; real PG / SQLite | dispatch allowed with no fence; pre-read fence lets late write through | dispatch only when active and server-bound; fixtures pending | **CI pending**; browser `Origin` (O-1) and native/bridge (A-N) unverified |
| 11 | S2, S3 | installed SDK 0.43.1 | regenerated create mints a new identity | snapshot re-send keeps uid and revision; move legs carry recorded etags; rollback conflicts | per-leg durable records not modelled in fake-IDB; server idempotency (`collection.py:396-398`) not executed |
| 12 | F12 | fake-IDB | collection delete erases unclassified work; delete overrides move | barrier refuses admission; loss recorded before retire; delete refused during move | app collection/reconcile callers |
| 13 | F13 | fake-IDB | all-or-nothing bulk rejection | truthful `{admitted, rejected}`; visibility table | app caller restore branches |
| — | P01 | fake-IDB | — | save→dispatch→ack→publish, favourite, delete, move, 100-item capacity all progress | — |
| — | S0, S1 | installed SDK | batch path distinct | transaction carries base etag; conflict/transport keep baseline | — |

## Limits of this result

- Passing these schedules supports only the proposed synthetic protocol. It says nothing
  about changed application code, which does not exist.
- The candidate moves display, session and replay authority into one queue database and adds a
  cache version bump. Both are application/storage changes that need separate owner decisions.
- The fixture fence relies on a synthetic `origin` flag. No fixture can establish what real
  browsers or native/bridge clients send.
- Legacy rows' original intent remains unknown; the protocol keeps them unverified and
  never auto-dispatches them.
