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

1. Wait until the target change is merged to protected `main` and the shared preview deploy has completed. PR image builds do not deploy the shared preview. An optional manually dispatched preview may deploy an identified exact PR head; record that PR number and full SHA with the smoke evidence so it is not mistaken for the shared `main` preview.
2. Open the deployed preview with restore diagnostics enabled:

   ```text
   https://previewapp.silentsuite.io/calendar?syncDebug=1
   ```

   If the change also needs privacy-safe startup timing evidence, explicitly opt in for that run:

   ```text
   https://previewapp.silentsuite.io/calendar?syncDebug=1&syncTiming=1
   ```

   Timing output is console-only and explicit-opt-in only outside local development. Do not enable it for general preview browsing.

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

## Optional sync timing capture

For changes that instrument startup timing, add `syncTiming=1` to the smoke URL for that single run or set `localStorage.setItem('silentsuite:syncTiming', 'true')` before reload. Timing is not auto-enabled on preview or production.

Capture only console lines beginning with `[silentsuite-sync-timing]`. Before sharing timing evidence, confirm it contains only phase names, durations, counts, booleans, status/source labels, and safe error categories. Do not share credentials, cookies, tokens, session blobs, item IDs, collection IDs, stokens, raw browser storage, raw errors, plaintext PIM, or full URLs with paths/query strings.

Timing evidence is optional context. It does not replace the restore smoke helper report.

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

## Partial-load warning check

After Slice 4, one failed visible domain load must not make sibling domains look empty or block the app shell. If the app reaches the calendar while one or more domains could not be refreshed, expected behavior is:

- cached or already-loaded sibling domains remain visible;
- bulk destructive collection clears are blocked until that domain finishes loading;
- a calm amber warning appears in the app shell with static copy and a **Retry sync** action;
- the sync indicator uses a warning affordance instead of reporting a fully healthy synced state;
- no raw errors, phase names, tokens, collection IDs, item IDs, plaintext PIM, or request details are shown.

Use this as a non-destructive smoke after preview deploys that touch domain item loading:

```text
Partial-load warning check: PASS|FAIL
environment: preview|local
app reached shell: yes|no
healthy sibling data preserved: yes|no
partial-load banner shown: yes|no
retry action present: yes|no
sync indicator warning affordance: yes|no
privacy-safe copy only: yes|no
bulk clear blocked before full domain load: yes|no
findings:
  - <privacy-safe finding, if any>
```

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

## Negative check: restore-blocked / unlock path

The positive smoke proves a healthy restore. This negative check proves the app is honest when the encrypted session cannot be restored on a browser: it shows a calm, non-blocking restore-blocked banner and offers a loop-free unlock route, without clearing any local data.

It requires no secrets and no stored credentials. It uses a controlled local mutation to force the blocked state, then re-unlocks with the same approved account you already use for the positive smoke.

### Safety

- Do not paste session blobs, storage values, tokens, cookies, IDs, or plaintext PIM anywhere. Observe shapes and booleans only.
- This check is intentionally recoverable: re-entering credentials restores the vault. It never asks you to permanently delete data.

### Recipe

1. Start from a healthy state: sign in on preview with an approved test account and confirm the positive smoke passes (`failedPhase: null`, and **no** restore-blocked banner is visible).
2. Force a blocked local session using DevTools, choosing one:
   - Remove or scramble the local `etebase_session` entry in the browser's encrypted secure storage (Application → IndexedDB / storage), then reload; or
   - Open the app in a fresh browser profile that still has a valid billing cookie/session but no local `etebase_session`, then load `/calendar`.
   Both simulate "authenticated at billing, but this browser cannot unlock the local vault."
3. Reload and observe the app shell. Expected:
   - The **restore-blocked banner** appears with reassurance copy along the lines of "Your data is encrypted and safe on the server. This browser needs to unlock it again."
   - The banner shows **no** raw error text, phase names, counts, IDs, or PIM — only static reassurance copy plus an "Unlock now" action.
   - The sync indicator no longer implies a healthy empty account.
4. Click **Unlock now**. Expected:
   - You land on `/login?reason=unlock&returnTo=…` and are **not** immediately bounced back to `/calendar` (no redirect loop).
   - The login page shows a short unlock explanation instead of the normal "Welcome back" copy.
5. Re-enter the approved account credentials and submit. Expected:
   - Login succeeds, the browser navigates to the `returnTo` path, the next restore initializes cleanly, and the restore-blocked banner disappears.
6. Confirm non-destructiveness. Before unlocking, verify that no local data was auto-cleared by the blocked state itself (the only clearing is the pre-existing offline-queue clear that happens when you explicitly re-enter credentials via `login()`). The app must never auto-clear localStorage, sessionStorage, or IndexedDB, and must never auto-logout, in the blocked state.

### Expected result shape

```text
Restore-blocked negative check: PASS|FAIL
environment: preview|local
trigger: missing-session|corrupt-session|fresh-profile
banner shown while blocked: yes|no
banner copy privacy-safe (no error/phase/ID/PIM): yes|no
/login?reason=unlock bounced back: yes|no   (PASS requires "no")
re-unlock restored vault + cleared banner: yes|no
local data auto-cleared before unlock: yes|no   (PASS requires "no")
findings:
  - <privacy-safe finding, if any>
```

## Automation follow-up design

A future automation slice may add a local-only or secure-runner probe that reads credentials from environment variables outside the repo, for example:

- `SILENTSUITE_SMOKE_BASE_URL`
- `SILENTSUITE_SMOKE_EMAIL`
- `SILENTSUITE_SMOKE_PASSWORD`

That future probe should fail closed when credentials are missing, write no secrets to logs, and print only the same redacted report shape. This runbook-first slice must not add CI secrets, seeded account secrets, or permanent credential storage.
