# How to Manage Your Calendar

Your calendar events are end-to-end encrypted. Only your devices can read them.

## Overview

The web app at [app.silentsuite.io](https://app.silentsuite.io) provides day, week, and month views. The sidebar includes a mini calendar for quick navigation and a calendar list where you can toggle visibility of individual calendars.

You can create multiple calendars. Each calendar is a separate encrypted collection with its own name, color, items, and DAV collection URL.

## Create an Event

1. Open the Calendar view.
2. Click or tap the date and time for your event.
3. Enter the event details (title, location, notes, reminders).
4. Save. The event is encrypted on your device and synced.

## Edit an Event

1. Open the event you want to change.
2. Make your changes.
3. Save. The updated event is re-encrypted and synced to your other devices.

## Delete an Event

1. Open the event.
2. Select delete.
3. The deletion syncs across all your devices.

## Import

You can import events from `.ics` files. This is useful for migrating from another calendar service or importing shared event files.

## Recurring Events

Recurring events are supported using the standard iCalendar recurrence rules.

## Sharing

You can share a calendar with another SilentSuite account from **Settings → Sharing** in the web app. The same page shares task lists, address books, and notebooks.

1. Under **Collection members**, find the calendar and enter the other person's username or email address.
2. Pick an access level: **Read-only**, **Read/write**, or **Admin**. Read-only members can see events but cannot change them. Only admins can invite accounts or manage members.
3. Select **Invite**. A **Verify security fingerprint** dialog asks you to compare the fingerprint before you send the invitation.

The other person opens **Settings → Sharing**, finds your invitation under **Incoming**, and selects **Accept** after comparing your fingerprint. The calendar then appears in their web app. A member who is not an admin can use **Leave collection** to leave. Admins can use **Load members** to see who has access, change a member's access, or remove them; see [what happens when you remove a member](./collections.md#removing-a-member).

Members see the same calendar, end-to-end encrypted to the public keys you confirm. Before you share or accept, compare security fingerprints with each person over a separate channel, such as in person or on a call. The server supplies usernames and keys, so an unverified fingerprint gives no assurance about who receives access. Your own fingerprint is under **Settings → Security**.

The generated Birthdays calendar cannot be shared.

Event invitations and RSVP are not supported yet. Sharing gives another account access to a whole calendar; you cannot invite someone to a single event.
