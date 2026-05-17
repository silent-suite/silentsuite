# Calendar

Your calendar lives at [app.silentsuite.io/calendar](https://app.silentsuite.io/calendar). Events are encrypted on your device before they sync — title, location, description, attendees, alarms, the lot.

## Create an Event

1. Click any cell in the week or month grid, or press the **+** button.
2. Fill in the event:
   - Title, location, description
   - Start / end (or *all-day*)
   - Timezone — defaults to your browser's, change per event if needed
   - Reminders (`VALARM`) — relative offsets (e.g. 15 min before start) or absolute times
   - Recurrence — see below
3. Save. The event is serialized to iCalendar (`VEVENT`), encrypted, and synced.

## Edit / Delete

Click the event in any view. Edit the same fields and save, or hit delete. Changes are re-encrypted and synced to your other devices.

## Recurring Events

Recurring events use standard `RRULE` strings (daily, weekly, monthly, yearly, with intervals, weekdays, by-day-of-month, etc.).

When you edit or delete an instance of a recurring event, SilentSuite asks for the **scope**:

- **This event only** — split a single occurrence into an exception (`EXDATE` for delete, override `VEVENT` for edit)
- **This and all following** — close out the original `RRULE` with `UNTIL` and start a new one from the chosen instance
- **All events in the series** — apply the change to the whole `RRULE`

This matches the behaviour you'd expect from any CalDAV-compliant client.

## Views

The view switcher in the calendar header offers two views:

| View | Best for |
|---|---|
| **Week** | Day-by-day planning, dragging events across days |
| **Month** | Glance overview |

On narrow viewports the calendar automatically renders as a vertical **agenda list** of upcoming events. A **mini calendar** in the sidebar acts as a quick-jump date picker.

## Timezones

Timezones are stored as `TZID` references on each event, not converted to UTC on save. When an event is imported with a `TZID` that isn't your local one, the original timezone is preserved through round-trips so the event stays meaningful when you travel.

## Import

**Settings → Import** accepts `.ics` files. Parsing happens entirely in your browser — the file's contents never reach the server in plaintext. Imported events keep their original `TZID`s and `VALARM`s.

## Export

**Settings → Export** gives you:

- **Calendar (`.ics`)** — all calendar events as a single iCalendar file
- **Everything (`.zip`)** — calendars, contacts, and tasks together

The export is built from your locally decrypted data, so it works offline once your data is loaded.

## Sharing

Shared calendars between accounts are not supported in v0.1.0-beta. Your calendar is visible only to you, across your own devices.

## Bridge / DAV clients

If you've installed the [desktop bridge](./getting-started.md#desktop-caldav--carddav-via-the-bridge), your CalDAV client (Thunderbird, Apple Calendar, etc.) can read and write the same calendar through `localhost:37358`. Edits there sync the same way as edits in the web app.

Multiple calendars are supported. Each calendar is a separate encrypted collection with its own name, color, items, and DAV collection URL.

## Limits in this beta

- No invitations / RSVP / scheduling — SilentSuite is single-user, by design.
