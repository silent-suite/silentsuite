# Authenticated restore smoke probe

Use this recipe after preview or production deploys that could affect web login, encrypted-session restore, Etebase item listing, or SyncEngine startup. It proves the authenticated restore path, not just CI or unauthenticated deploy health.

## What this verifies

The smoke is passing only when the redacted diagnostics show all of these phases as `ok` and `failedPhase` is `null`:

- `sessionRead`
- `restoreSession`
- `ensureCollections`
- `hydrateLists`
- `listItems:calendar`
- `listItems:tasks`
- `listItems:contacts`
- `syncEngineTrackCollections`
- `syncEngineStart`

The diagnostics intentionally contain only phase/status/count metadata, safe error names, hostnames, booleans, and durations. They must not contain cookies, headers, session blobs, collection ids, item ids, event/task/contact contents, labels, request bodies, or response bodies.

## Manual browser recipe

1. Open the environment with restore diagnostics enabled:

   ```text
   https://app.silentsuite.io/calendar?syncDebug=1
   ```

   For a preview environment, use that preview host with the same `?syncDebug=1` query.

2. Sign in with an approved internal or seeded smoke account. Do not use a live customer account unless the customer explicitly supplied the diagnostic payload.

3. Wait until the sync indicator settles.

4. If the app shows `Sync error`, click **Copy diagnostics** in the sync indicator. If the button is unavailable, use the console command below.

5. If the app appears healthy, still copy the diagnostics from the console so the success has phase evidence:

   ```js
   copy(sessionStorage.getItem('silentsuite.restore-diagnostics.v1'))
   ```

   If `copy()` is unavailable in the browser console, run `sessionStorage.getItem('silentsuite.restore-diagnostics.v1')` and copy only that returned JSON string.

6. Save the copied JSON to a local temporary file outside the repo, for example:

   ```bash
   tmp=$(mktemp /tmp/silentsuite-restore-smoke-XXXXXX.json)
   $EDITOR "$tmp"
   ```

7. Generate the privacy-safe pass/fail report:

   ```bash
   node scripts/restore-smoke-report.mjs "$tmp"
   rm -f "$tmp"
   ```

8. Paste only the report into the PR, issue, or release checklist. Do not paste the raw browser diagnostics unless a maintainer explicitly asks for it in a private channel.

## Pass criteria

A passing report starts with `Authenticated restore smoke: PASS` and includes `failedPhase: null`; every required phase is present with `ok` status.

A failing report starts with `Authenticated restore smoke: FAIL` and includes safe findings such as a missing phase, a failed phase, or a visible collection type with no collections.

## Scope boundaries

This smoke distinguishes deployment health from real authenticated restore health. It does not prove every event/task/contact is correct, and it does not inspect plaintext PIM. If it fails, use the failed phase to choose the next narrow investigation:

- `sessionRead` or `restoreSession`: saved session or Etebase restore path
- `ensureCollections`: collection listing/creation path
- `listItems:*`: item route, auth, msgpack, or server protocol path
- `syncEngineTrackCollections` or `syncEngineStart`: SyncEngine wiring/startup path

Do not clear browser storage before collecting diagnostics unless the user chooses data recovery over root-cause evidence.
