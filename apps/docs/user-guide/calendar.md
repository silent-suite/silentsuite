# How to Manage Your Calendar

Your calendar events are end-to-end encrypted. Only your devices can read them.

## Overview

In the web app your calendar is at [app.silentsuite.io/calendar](https://app.silentsuite.io/calendar). Title, location, description, attendees and alarms are all encrypted on your device before sync.

The view switcher in the calendar header offers **Week** and **Month** views. On narrow screens the calendar shows a vertical agenda of upcoming events instead. The sidebar includes a mini calendar for quick navigation and a calendar list where you can toggle visibility of individual calendars.

You can create multiple calendars. Each calendar is a separate encrypted collection with its own name, color, items, and DAV collection URL.

## Create an Event

1. Open the Calendar view.
2. Click or tap the date and time for your event.
3. Enter the event details (title, location, notes, reminders).
4. Save. The event is encrypted on your device and synced.

Each event can be all-day or have a start and end time. The time zone defaults to your browser's and can be changed per event. Reminders (`VALARM`) can be relative, such as 15 minutes before the start, or at a fixed time.

## Edit an Event

1. Open the event you want to change.
2. Make your changes.
3. Save. The updated event is re-encrypted and synced to your other devices.

## Delete an Event

1. Open the event.
2. Select delete.
3. The deletion syncs across all your devices.

## Import

You can import events from `.ics` files in **Settings → Import**. This is useful for migrating from another calendar service or importing shared event files. The file is parsed in your browser, so its contents never reach the server unencrypted. Imported events keep their original time zones (`TZID`) and reminders (`VALARM`).

When you select several `.ics` files at once, SilentSuite asks whether to create one calendar per file or import every file into a single calendar. Calendar names are suggested from the file metadata or filename before anything is imported.

If you imported into the wrong place, use **Settings → Import → Manage imported data** to clear a calendar's events or delete an extra calendar and everything inside it.

## Export

**Settings → Export** offers:

- **Calendar (`.ics`)**: all calendar events as a single iCalendar file
- **Everything (`.zip`)**: calendars, contacts and tasks together, plus your notebooks as Markdown files when you have any ([Notes](./notes.md#export))

Both are built from the data already decrypted on your device, so they work offline once your data is loaded. When your account has notebooks, **Everything** also lists your notes from the server again, so it then needs a connection.

## Time Zones

Each event stores its time zone as a `TZID` reference instead of converting it to UTC on save. An imported event keeps its original time zone through later edits, so it stays correct when you travel.

## Recurring Events

Recurring events are supported using the standard iCalendar recurrence rules (`RRULE`): daily, weekly, monthly or yearly, with intervals and specific weekdays or days of the month.

When you edit or delete one occurrence of a recurring event, SilentSuite asks which events the change applies to: **This event**, **This and all future events**, or **All events**.

## Sharing

You can share a calendar with another SilentSuite account from **Settings → Sharing** in the web app. The same page shares task lists, address books, and notebooks.

1. Under **Collection members**, find the calendar and enter the other person's username or email address.
2. Pick an access level: **Read-only**, **Read/write**, or **Admin**. Read-only members can see events but cannot change them. Only admins can invite accounts or manage members.
3. Select **Invite**. A **Verify security fingerprint** dialog asks you to compare the fingerprint before you send the invitation.

The other person opens **Settings → Sharing**, finds your invitation under **Incoming**, and selects **Accept** after comparing your fingerprint. The calendar is then added to their account. A member who is not an admin can use **Leave collection** to leave. Admins can use **Load members** to see who has access, change a member's access, or remove them; see [what happens when you remove a member](./collections.md#removing-a-member).

Members see the same calendar, end-to-end encrypted to the public keys you confirm. Before you share or accept, compare security fingerprints with each person over a separate channel, such as in person or on a call. The server supplies usernames and keys, so an unverified fingerprint gives no assurance about who receives access. Your own fingerprint is under **Settings → Security**.

The generated Birthdays calendar cannot be shared.

Event invitations and RSVP are not supported yet. Sharing gives another account access to a whole calendar; you cannot invite someone to a single event.

## Desktop CalDAV Clients

With the [SilentSuite Bridge](./apps/dav-bridge.md) installed, your CalDAV client (Thunderbird, Calendar on macOS, and others) can read and write the same calendars through `localhost:37358`. Edits there sync the same way as edits in the web app.
