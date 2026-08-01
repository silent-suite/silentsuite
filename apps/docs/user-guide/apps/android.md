# SilentSuite for Android

SilentSuite has its own Android app for end-to-end encrypted sync of your calendar, contacts, and tasks. It's a maintained fork of the EteSync Android app, pre-configured to work with SilentSuite.

## What You Get

Once set up, your SilentSuite data syncs directly into Android's system calendar, contacts, and task providers. This means any calendar app (Etar, Simple Calendar, etc.) and any contacts app will show your encrypted SilentSuite data.

## Install

Choose the install channel you want to keep using for updates. Google Play is
the simplest option for most people, while Obtainium, Zapstore, and direct APK
downloads keep independent distribution paths available.

### Option 1: Google Play

[Download SilentSuite from Google Play](https://play.google.com/store/apps/details?id=io.silentsuite.android) if you want Play-managed installation and updates. If you installed SilentSuite from Google Play, keep updating it from Google Play.

### Option 2: Obtainium

[Obtainium](https://github.com/ImranR98/Obtainium) is an open-source Android app that installs and auto-updates apps directly from GitHub releases -- no Google Play, no tracking, no account needed.

1. Install Obtainium from [GitHub Releases](https://github.com/ImranR98/Obtainium/releases) or [F-Droid](https://f-droid.org/packages/dev.imranr.obtainium.fdroid/).
2. Tap [Add SilentSuite to Obtainium](obtainium://add/https://github.com/silent-suite/silentsuite), or open Obtainium, tap **Add App**, and paste this URL:
   ```
   https://github.com/silent-suite/silentsuite
   ```
3. Obtainium will detect the latest SilentSuite release and install the APK. It will notify you whenever a new release is published.

### Option 3: Zapstore

[Download SilentSuite from Zapstore](https://zapstore.dev/apps/io.silentsuite.android) if you prefer an open app store that installs the signed APK and manages updates outside Google Play. Release timing can differ from GitHub Releases, so check the version shown before installing.

### Option 4: Direct APK download

Grab the latest APK directly from GitHub Releases:

- [github.com/silent-suite/silentsuite/releases/latest](https://github.com/silent-suite/silentsuite/releases/latest)

Look for the asset named `silentsuite-android-vX.Y.Z-beta.apk` and install it. You'll need to allow installation from unknown sources the first time.

### F-Droid status

Official F-Droid publication is pending inclusion. SilentSuite is not yet
available from the official F-Droid package index. Until that changes, use one
of the available installation channels above.

### Certificate hashes and channel switching

Android only allows an app update when the installed app and the update APK are signed with the same certificate. Google Play uses Play App Signing, so the APK installed from Play can have a different certificate than the developer-signed APK distributed through GitHub Releases, Zapstore, or a future F-Droid build.

SilentSuite's known Android signing certificate SHA-256 hashes are:

- **Google Play app signing certificate:** `2e10d9ef90276e755bddf086391d7e0c933589c6d36e4e43fae59a7babcb8a49`
- **Developer-signed release certificate for GitHub Releases, Zapstore, and future reproducible F-Droid builds:** `8035a4ff1511e2045c579c905d26e93af6009b239e741ef78542ae04e7a7ca79`

If you installed from Google Play, update through Google Play. If you installed from GitHub Releases or Zapstore, update through that same direct APK channel. When official F-Droid distribution becomes available, keep F-Droid installations on that channel. Switching between Google Play and developer-signed APK channels may require uninstalling and reinstalling the app. A certificate mismatch warning in that situation is expected and does not by itself indicate a compromised build.

::: tip
The SilentSuite Android app is a fork of the [EteSync Android app](https://github.com/etesync/android) with SilentSuite branding and `server.silentsuite.io` pre-configured as the default server. If you prefer, the original EteSync app from [Google Play](https://play.google.com/store/apps/details?id=com.etesync.syncadapter) or [F-Droid](https://f-droid.org/packages/com.etesync.syncadapter/) also works -- just enter the server URL manually.
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
