# SilentSuite for Android

SilentSuite has its own Android app for end-to-end encrypted sync of your calendar, contacts, and tasks. It's a maintained fork of the EteSync Android app, pre-configured to work with SilentSuite.

## What You Get

Once set up, your SilentSuite data syncs directly into Android's system calendar, contacts, and task providers. This means any calendar app (Etar, Simple Calendar, etc.) and any contacts app will show your encrypted SilentSuite data.

## Install

Download the **SilentSuite** Android app:

- [GitHub (APK)](https://github.com/silent-suite/silentsuite/releases) -- download the latest release APK from the monorepo.

::: tip
The SilentSuite Android app is a fork of the [EteSync Android app](https://github.com/etesync/android) with SilentSuite branding and `server.silentsuite.io` pre-configured as the default server. If you prefer, the original EteSync app from [Google Play](https://play.google.com/store/apps/details?id=com.etesync.syncadapter) or [F-Droid](https://f-droid.org/packages/com.etesync.syncadapter/) also works -- just enter the SilentSuite server URL manually.
:::

## Set Up

1. Open the **SilentSuite** app.
2. Tap the **+** button to add an account.
3. The server URL is pre-configured to `https://server.silentsuite.io`. For self-hosted instances, tap **Advanced Settings** and enter your server URL (e.g. `https://sync.your-domain.com`).
4. Enter your **username** (email) and **password**.
5. Tap **Log in**.

The app will sync your collections. Your calendars, contacts, and tasks now appear in your Android apps.

## Choosing a Calendar App

The SilentSuite app is a sync adapter -- it syncs data in the background but doesn't have a built-in calendar UI. Use any Android calendar app:

- **Etar** (open source, F-Droid) -- lightweight, recommended.
- **Simple Calendar** (open source, F-Droid) -- minimal and private.
- **Google Calendar** -- works, but sends event metadata to Google for notifications. Not recommended if privacy is a priority.

## Choosing a Task App

For tasks, use:

- [Tasks.org](./tasks-org.md) -- has built-in EteSync/Etebase support and can also read from the Android task provider.
- **OpenTasks** -- reads tasks from the Android task provider populated by SilentSuite.

## Source Code

The SilentSuite Android app is open source. The source lives in the `android/` directory of the main monorepo:

- [github.com/silent-suite/silentsuite/tree/main/android](https://github.com/silent-suite/silentsuite/tree/main/android)

## Troubleshooting

### Data not syncing

Open the SilentSuite app and check the sync status. Pull down to force a sync. Check that your account shows as connected.

### Calendar not showing in my app

Some calendar apps need you to enable the SilentSuite calendar in their settings. Look for a "Calendars" or "Accounts" section and make sure the SilentSuite calendars are ticked.

### Battery optimization

Android may restrict background sync. Go to **Settings > Apps > SilentSuite > Battery** and select **Unrestricted** to ensure reliable sync.
