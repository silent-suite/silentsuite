# Tasks

Your tasks live at [app.silentsuite.io/tasks](https://app.silentsuite.io/tasks). Title, due date, priority, notes — every field is encrypted on your device before sync.

## Create a Task

1. Click **+ Add Task** or use the keyboard shortcut.
2. Fill in:
   - Title (required)
   - Due date — a calendar day, or a specific date+time
   - Priority — low / medium / high / urgent
   - Notes
3. Save. The task is serialized to iCalendar (`VTODO`), encrypted, and synced.

## Complete / Reopen

Click the checkbox next to a task to mark it complete. The completion status (and timestamp) syncs across all your devices. Click again to reopen.

## Edit / Delete

Open a task, change its fields, save — or delete. Changes are re-encrypted and synced.

## Filter and Sort

The list can be filtered by completion state and sorted by due date or priority. Both run against your locally decrypted data.

## Import

**Settings → Import** accepts `.ics` files containing `VTODO` entries. Parsing is local-only.

## Export

**Settings → Export** gives you:

- **Tasks (`.ics`)** — all tasks as a single iCalendar file with `VTODO` entries
- **Everything (`.zip`)** — calendars, contacts, and tasks together

## Bridge / DAV clients

With the [desktop bridge](./getting-started.md#desktop-caldav--carddav-via-the-bridge) installed, any CalDAV client that speaks `VTODO` can read and write the same tasks through `localhost:37358`.

## Limits in this beta

- A single default tasks collection per account. Managing multiple task lists is on the roadmap (see [issue #88](https://github.com/silent-suite/silentsuite/issues/88)).
- Date-only `DUE` values round-trip cleanly. Full timezone (`TZID`) preservation on date-time `DUE` values is being tightened up — see [issue #66](https://github.com/silent-suite/silentsuite/issues/66).
- No subtasks or dependencies — a flat task list per collection.
