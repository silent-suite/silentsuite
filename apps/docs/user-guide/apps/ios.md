# EteSync for iOS

Sync your SilentSuite calendar, contacts, and reminders with the native iOS apps.

## Install

Install the **EteSync** app from the [App Store](https://apps.apple.com/app/etesync/id1489574285).

## Set Up

1. Open the **EteSync** app.
2. Tap **Advanced Settings** to reveal the server URL field.
3. Enter your SilentSuite server URL:
   - Hosted: `https://server.silentsuite.io`
   - Self-hosted: `https://sync.your-domain.com`
4. Enter your **username** (email) and **password**.
5. Tap **Log in**.

## Important: iOS Sync Limitation

iOS does not allow third-party apps to create new calendar or contact accounts directly. To sync with iOS Calendar, Contacts, and Reminders, you need to either:

### Option A: Disable iCloud for these services

1. Go to **Settings > [your name] > iCloud**.
2. Turn off **Calendars**, **Contacts**, and **Reminders**.
3. When prompted, choose **Keep on My iPhone**.
4. Open the EteSync app and sync. Your data will appear in the native apps.

### Option B: Create a local DAV account (workaround)

If you want to keep iCloud enabled alongside EteSync:

1. Go to **Settings > Calendar > Accounts > Add Account > Other**.
2. Tap **Add CalDAV Account**.
3. Enter:
   - Server: `localhost`
   - Username: `aaaaa`
   - Password: `aaaaa`
   - Description: `etesync` (this exact text is required)
4. Tap **Save** (ignore any SSL/verification errors).
5. Open the EteSync app and sync.

## Sync History Limit

By default, iOS only syncs calendar events from the last 30 days. To change this:

1. Go to **Settings > Calendar > Sync**.
2. Select **All Events** (or your preferred range).

## Troubleshooting

### Events not appearing in iOS Calendar

Make sure the EteSync calendars are enabled in iOS Calendar. Open Calendar, tap **Calendars** at the bottom, and check that the EteSync calendars are ticked.

### Contacts not appearing

If using the iCloud workaround (Option B), make sure the local account's contacts are enabled in **Settings > Contacts > Accounts**.
