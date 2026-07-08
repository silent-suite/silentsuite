# Authenticated restore smoke probe

Use this recipe after preview or production deploys that could affect web login, encrypted-session restore, Etebase item listing, or SyncEngine startup. It proves the authenticated restore path, not just CI, image build, or unauthenticated deploy health.

## What this proves and does not prove

A passing smoke proves that an already-authenticated browser can restore its encrypted Etebase session, list the visible calendar/tasks/contacts collections and items, track collections, and start SyncEngine in the deployed app.

It does **not** prove every event/task/contact is semantically correct. It does not inspect plaintext PIM. It does not replace focused server route contract tests, unit tests, CI, or later end-to-end automation.

## Safety and privacy rules

The smoke report and copied diagnostics must contain only phase/status/count metadata, safe error names, hostnames, booleans, and durations.

Never paste any of the following into GitHub, BMAD, chat, release notes, logs, or public artifacts:

- passwords, session blobs, auth tokens, cookies, or headers
- collection IDs, item IDs, labels, request bodies, or response bodies
- raw URLs with private paths or query strings
- plaintext calendar events, tasks, contacts, notes, or other PIM
- raw error messages or stack traces
- customer account identifiers unless the customer explicitly supplied the redacted diagnostic payload

Production smoke is mutation-free only when the account is already initialized. Do **not** use first-login, empty, or partially initialized production accounts: the current restore path can create default collections when required collections are missing.

## Prerequisites

- Use an approved internal/test account, or a customer/user-approved account where the user supplied the redacted diagnostics.
- For production, get explicit owner approval first.
- For production, confirm the account is already initialized with calendar, tasks, and contacts collections before running the smoke. If it is a new/empty account or required collections are missing, abort production smoke.
- Use a browser profile approved for the smoke account.
- Keep raw diagnostics in a temporary local file outside the repo and delete it after generating the report.

## Preview smoke recipe

1. Wait until the target change is merged to `dev` and the preview deploy has completed. PR image builds do not deploy the shared preview.
2. Open the deployed preview with restore diagnostics enabled:

   ```text
   https://previewapp.silentsuite.io/calendar?syncDebug=1
   ```

3. Sign in only if no valid session exists.
4. Hard reload once after login so the saved encrypted-session restore path runs.
5. Wait until the app reaches a steady state and the sync indicator is not actively syncing.
6. Copy restore diagnostics:
   - Prefer the debug-gated **Copy diagnostics** button in the sync indicator.
   - If the button is unavailable, use the console fallback:

     ```js
     copy(sessionStorage.getItem('silentsuite.restore-diagnostics.v1'))
     ```

     If `copy()` is unavailable, run `sessionStorage.getItem('silentsuite.restore-diagnostics.v1')` and copy only that returned JSON string.

7. Save the copied JSON to a temporary file outside the repo:

   ```bash
   tmp=$(mktemp /tmp/silentsuite-restore-smoke-XXXXXX.json)
   $EDITOR "$tmp"
   ```

8. Generate the privacy-safe pass/fail report:

   ```bash
   node scripts/restore-smoke-report.mjs "$tmp"
   rm -f "$tmp"
   ```

9. Paste only the generated report into the PR, issue, or release checklist. Do not paste raw browser diagnostics unless a maintainer explicitly asks for it in a private channel.

## Production smoke recipe

Production smoke has the same steps as preview, but with stricter gates:

1. Get explicit owner approval for the production smoke.
2. Use only an approved, already-initialized internal/test account or a user-approved account.
3. Abort if the account is first-login, empty, partially initialized, or missing expected calendar/tasks/contacts collections.
4. Do not create, update, import, delete, or rename any data during the smoke.
5. Open production with explicit debug opt-in:

   ```text
   https://app.silentsuite.io/calendar?syncDebug=1
   ```

6. Copy diagnostics and generate the report as in the preview recipe.
7. Share only the redacted report.

`?syncDebug=1` is an intentional user/operator opt-in for this slice. It may expose redacted self-account metadata such as phase timings, counts, hostnames, and safe error categories. It must never expose secrets, raw identifiers, plaintext PIM, raw errors, or unknown stored fields.

## Expected redacted diagnostics

The raw diagnostics in `sessionStorage` should be JSON under the key `silentsuite.restore-diagnostics.v1`. A passing restore smoke requires:

- `source: "restore"`
- `failedPhase: null`
- `ok` entries for all required phases:
  - `sessionRead`
  - `restoreSession`
  - `ensureCollections`
  - `hydrateLists`
  - `listItems:calendar`
  - `listItems:tasks`
  - `listItems:contacts`
  - `syncEngineTrackCollections`
  - `syncEngineStart`

A `source: "login"` snapshot only proves login/session persistence diagnostics. It is not sufficient for authenticated restore smoke; hard reload and collect a `source: "restore"` snapshot.

## Failure triage by `failedPhase`

If the smoke fails, do not start with broad rollback. Use the failed phase to choose the next narrow investigation:

| `failedPhase` | First triage direction |
| --- | --- |
| `sessionRead` | Browser storage, secure-storage, or saved-session availability. |
| `sessionPersistence` | Login session write/read roundtrip. |
| `restoreSession` | Saved Etebase session validity, server URL/account mismatch, or SDK restore path. |
| `ensureCollections` | Collection list/create path. On production, confirm the account was already initialized and stop if restore would create defaults. |
| `hydrateLists` | Local list-store hydration. |
| `listItems:calendar` | Calendar item route/auth/msgpack/decrypt path. If safe local evidence shows HTTP 422, check FastAPI path binding and route contracts before more frontend rollback. |
| `listItems:tasks` | Tasks item route/auth/msgpack/decrypt path. |
| `listItems:contacts` | Contacts item route/auth/msgpack/decrypt path. |
| `syncEngineTrackCollections` | Collection tracking or stoken/cache seeding. |
| `syncEngineStart` | SyncEngine startup/auth/network path. |
| `unknown` | Failure before a phase marker or unclassified exception. |

Do not clear browser storage before collecting diagnostics unless the user chooses data recovery over root-cause evidence.

## Evidence template

Paste reports in this shape:

```text
Authenticated restore smoke: PASS|FAIL
environment: preview|production|local
appHost: previewapp.silentsuite.io|app.silentsuite.io
commitOrDeploy: <short sha / PR / deploy identifier if known>
timestamp: <UTC timestamp>
failedPhase: null|<phase>
phases:
  - sessionRead: ok|failed|missing
  - restoreSession: ok|failed|missing
  - ensureCollections: ok|failed|missing
  - hydrateLists: ok|failed|missing
  - listItems:calendar: ok|failed|missing (collections=N, items=N, pages=N)
  - listItems:tasks: ok|failed|missing (collections=N, items=N, pages=N)
  - listItems:contacts: ok|failed|missing (collections=N, items=N, pages=N)
  - syncEngineTrackCollections: ok|failed|missing
  - syncEngineStart: ok|failed|missing
findings:
  - <privacy-safe finding, if any>
```

Before sharing, confirm the evidence contains no credentials, emails, session blobs, collection IDs, item IDs, plaintext PIM, raw URLs with query strings, cookies, headers, response bodies, or raw error messages.

## Automation follow-up design

A future automation slice may add a local-only or secure-runner probe that reads credentials from environment variables outside the repo, for example:

- `SILENTSUITE_SMOKE_BASE_URL`
- `SILENTSUITE_SMOKE_EMAIL`
- `SILENTSUITE_SMOKE_PASSWORD`

That future probe should fail closed when credentials are missing, write no secrets to logs, and print only the same redacted report shape. This runbook-first slice must not add CI secrets, seeded account secrets, or permanent credential storage.
