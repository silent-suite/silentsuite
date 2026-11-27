# SilentSuite for Android

SilentSuite has its own Android app for end-to-end encrypted sync of your calendar, contacts, and tasks, plus an experimental notes editor. It's a maintained fork of the EteSync Android app, pre-configured to work with SilentSuite.

## What You Get

Once set up, your SilentSuite data syncs directly into Android's system calendar, contacts, and task providers. Calendar apps that use Android's system calendar, such as Etar, Fossify Calendar, and KashCal, can display and edit your SilentSuite events.

## Install

The next Android release requires **Android 10 (API 29) or newer**. Devices running
Android 9 or older stay on their last compatible release, **v0.5.15-beta**, and
cannot install subsequent app updates. This does not disable an existing
installation or promise ongoing maintenance of the older release.

Choose the install channel you want to keep using for updates. Google Play is
the simplest option for most people. F-Droid, Obtainium, Zapstore, and direct
APK downloads keep independent distribution paths available.

<div class="android-channel-grid">
  <a class="android-channel-button" href="https://play.google.com/store/apps/details?id=io.silentsuite.android" target="_blank" rel="noopener noreferrer">
    <span class="android-channel-logo"><img src="/channel-icons/google-play.svg" alt="" aria-hidden="true"></span>
    <span class="android-channel-copy"><strong>Google Play</strong><small>Play-managed install and updates</small></span>
  </a>
  <a class="android-channel-button" href="obtainium://add/https://github.com/silent-suite/silentsuite">
    <span class="android-channel-logo"><img src="/channel-icons/obtainium.svg" alt="" aria-hidden="true"></span>
    <span class="android-channel-copy"><strong>Add to Obtainium</strong><small>Track signed GitHub releases</small></span>
  </a>
  <a class="android-channel-button" href="https://zapstore.dev/apps/io.silentsuite.android" target="_blank" rel="noopener noreferrer">
    <span class="android-channel-logo"><img src="/channel-icons/zapstore.png" alt="" aria-hidden="true"></span>
    <span class="android-channel-copy"><strong>Zapstore</strong><small>Independent app-store updates</small></span>
  </a>
  <a class="android-channel-button" href="https://f-droid.org/packages/io.silentsuite.android" target="_blank" rel="noopener noreferrer">
    <span class="android-channel-logo"><img src="/channel-icons/fdroid.png" alt="" aria-hidden="true"></span>
    <span class="android-channel-copy"><strong>F-Droid</strong><small>Official F-Droid repository</small></span>
  </a>
  <a class="android-channel-button" href="orionstore://app/silentsuite">
    <span class="android-channel-logo"><img src="/channel-icons/orion.png" alt="" aria-hidden="true"></span>
    <span class="android-channel-copy"><strong>Orion Store</strong><small>Third-party community store</small></span>
  </a>
</div>

<div class="android-channel-secondary">
  <span>Prefer a signed APK?</span>
  <a class="android-channel-secondary-link" href="https://github.com/silent-suite/silentsuite/releases/latest" target="_blank" rel="noopener noreferrer">
    <span class="android-channel-logo"><img src="/channel-icons/github.svg" alt="" aria-hidden="true"></span>
    <strong>Direct signed APK</strong>
  </a>
</div>

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

### Other community stores

SilentSuite is also indexed by the independent, open-source [Orion Store](https://github.com/RookieEnough/Orion-Store). Orion currently retrieves the developer-signed APK from SilentSuite's GitHub Releases. Install Orion separately, then [open SilentSuite in Orion](orionstore://app/silentsuite).

Orion is a third-party distribution client and is not operated by SilentSuite. Before installing, confirm that Orion shows the expected SilentSuite version and GitHub release source.

### F-Droid

[Download SilentSuite from F-Droid](https://f-droid.org/packages/io.silentsuite.android) if you want the official F-Droid repository. F-Droid builds this package from the public source and signs it with the developer release certificate. Release timing can differ from GitHub Releases, so check the version shown before installing.

### Certificate hashes and channel switching

Android only allows an app update when the installed app and the update APK are signed with the same certificate. Google Play uses Play App Signing, so the APK installed from Play can have a different certificate than the developer-signed package distributed through GitHub Releases, Zapstore, Orion Store, and official F-Droid.

SilentSuite's known Android signing certificate SHA-256 hashes are:

- **Google Play app signing certificate:** `2e10d9ef90276e755bddf086391d7e0c933589c6d36e4e43fae59a7babcb8a49`
- **Developer-signed release certificate for GitHub Releases, Zapstore, Orion Store, and official F-Droid builds:** `8035a4ff1511e2045c579c905d26e93af6009b239e741ef78542ae04e7a7ca79`

If you installed from Google Play, update through Google Play. GitHub Releases, Zapstore, Orion Store, and official F-Droid currently share the developer release certificate, so an update between those channels can install without a certificate mismatch. Stay on the channel you installed from if you want that store to keep managing updates. Switching between Google Play and a developer-signed channel may require uninstalling and reinstalling the app. A certificate mismatch warning in that situation is expected and does not by itself indicate a compromised build.

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

The SilentSuite app is a sync adapter -- it syncs data in the background but doesn't have a built-in calendar UI. Use any Android calendar app. They all sync both ways: events you create, edit, or delete in the calendar app reach SilentSuite on the next sync.

- <img src="/app-logos/etar.png" alt="" width="32" height="32" style="display: inline-block; vertical-align: middle; margin-right: 8px; object-fit: contain;"> **Etar** (open source, F-Droid) -- lightweight, recommended.
- <img src="/app-logos/fossify-calendar.png" alt="" width="32" height="32" style="display: inline-block; vertical-align: middle; margin-right: 8px; object-fit: contain;"> [Fossify Calendar](https://github.com/FossifyOrg/Calendar) (open source, F-Droid) -- minimal and private.
- <img src="/app-logos/kashcal.png" alt="" width="32" height="32" style="display: inline-block; vertical-align: middle; margin-right: 8px; object-fit: contain;"> [KashCal](https://github.com/KashCal/KashCal) (open source) -- uses Android's system calendar, so you don't need to set up a CalDAV account in KashCal.
- **Google Calendar** -- works, but sends event metadata to Google for notifications. Not recommended if privacy is a priority.

### Moving events from another calendar

Only SilentSuite calendars sync. If your events are in a calendar that was already on the phone, such as a local phone calendar or a Google account calendar, the SilentSuite app leaves them where they are. To move them:

1. In the SilentSuite app, open the SilentSuite calendar you want the events in, open the menu and tap **Import**.
2. Copy the events from the other calendar on the phone, or pick an `.ics` file you exported from it. Only accounts that share their data with Android are listed, so some setups, such as some Outlook accounts, may be missing; for those, export an `.ics` file.
3. Check that the events show up in the web app.
4. Delete the old calendar from the phone, or hide it in your calendar app.

After that, every calendar app on the phone shows the same SilentSuite events. When you add an event, check that a SilentSuite calendar is selected, not the old one.

## Choosing a Task App

For tasks, use:

- [Tasks.org](./tasks-org.md) (15.14 or later) can use this SilentSuite app for sync. Choose **Continue without sync** when you first open Tasks.org, then follow the permission and sync steps in the Tasks.org guide. The guide also covers direct EteSync setup.
- **OpenTasks** -- reads tasks from the Android task provider populated by SilentSuite.

## Notes (experimental)

The app can show and edit your encrypted [notes](../notes.md). Notes is off by default and is turned on per account:

1. Open **Settings**, then **Account**.
2. Under **Experimental**, turn on **Notes (experimental)**. The app tries to sync your notebooks right away.
3. Open **Notes** from the navigation drawer, and tap a notebook to see its notes.
4. Tap a note to edit it, or tap **New note**. A note opens read-only when its notebook is read-only, when its change on this device cannot be read, or when its text is kept under **Unsynced text**; in that last case an **Open Unsynced text** button takes you there.

Turning Notes off hides it again and removes it from the sync overview. Nothing is deleted, including text that has not synced yet.

Not in this version: a formatted view of a note, and notebooks in the import and export options.

### Notebooks

- No notebook is created for you. If a sync finds none, the notebook list offers **New notebook**. **Create notebook** is always in the menu at the top of the notebook list.
- Touch and hold a notebook to open its settings. If you are an admin of the notebook, you can manage its members, rename it or delete it there; otherwise you can leave it.
- Shared notebooks appear with the same shared and read-only markers as other collections, and you accept notebook invitations the same way.
- If a notebook you delete or leave holds notes that have not synced, the app says how many and offers **Sync now** first. Deleting or leaving without syncing discards them from this device, after a separate confirmation, once the server has accepted the delete or leave. If only some of the changes on this device can be read, only the readable ones are discarded. If none can be read, nothing is discarded, and the text may stay on this device without syncing.

### Editing

- Notes are edited as plain Markdown text.
- Each edit is saved on this device about a second and a half after you stop typing, and when you leave the note. Below the text, the editor says "Saved on this device", then "Synced" or why the note is waiting to sync.
- **Undo** and **Redo** are in the toolbar. On a hardware keyboard, Ctrl+Z undoes, and Ctrl+Shift+Z or Ctrl+Y redoes.
- The note fields ask the keyboard not to learn from what you type and not to suggest words. A keyboard can ignore that request.
- If your changes cannot be saved on this device when you go back, the editor stays open, says why, and asks **Leave this note?**. **Copy** copies your text, **Try again** appears when another save may work (otherwise the button is **Cancel**), and **Leave anyway** closes the note. If you leave anyway, the app tries one more save, and the changes may not be kept. Changes that cannot be saved may also be lost if the note closes without you leaving it, for example when the account is removed or Android stops the app in the background.

### Move a note

Open the note, open the menu in the top bar, and choose **Move to notebook**, then tap a notebook. Only notebooks you can write to are listed, and notebooks other people share with you are marked as shared, unless they gave you admin access. If no other notebook can take the note, a message says so.

The app saves the note's text first. A note whose text is kept under **Unsynced text**, or whose text could not be saved, is not moved, and a message says why. If the app finds that the note changed after the screen showed it, nothing is moved either: a message says so, and the note shows as it is now, so you can check it and move it again.

Otherwise the note opens in its new notebook at once, also offline. Its text, including text that has not synced yet, its title, its last-edited time and anything else another app stored with it go across unchanged. The move is sent at the next Notes sync that is allowed to run, like a saved edit.

The server cannot move a note between notebooks, so the app creates the note again in the new notebook and deletes the original only after it has checked that the server has the new one, in a notebook that is still there. Its revision history starts over. If a move stops halfway, the note can show in both notebooks; the move alone never leaves it in neither. When something gets in the way, the notebook list says why until you tap **Dismiss**:

- If the new notebook does not take the note, for example because it became read-only for you before the move reached the server, the moved text is kept under **Unsynced text**, and a note that had synced before shows in its old notebook again.
- If another device changed the note first, its old notebook became read-only for you, or the server refused the original's delete, the note stays in both notebooks. If that notebook became read-only after the original's delete was already sent, the list says the note may already be deleted there.
- If, before that check, another device deleted the note in its new notebook, the note stays in its old notebook as it last synced there, and changes it had not synced before the move went with the deleted copy.
- If the new notebook was deleted or you lost access to it, the note stays in its old notebook as it last synced there, and the text it had in the new notebook, those changes included, is kept under **Unsynced text**. The exception is access lost after this device sent the copy and before it checked it: those changes are then only in the new notebook, which you can no longer open.
- If any of this happened after this device had already sent the original's delete, the note may already be deleted in its old notebook too, so the list says to check it there. Text kept under **Unsynced text** stays there.

One case gets no message: if another device deletes the note or its new notebook, or you lose access to that notebook, in the moment between this device's check and the original's delete, the original is deleted too, and the note is in neither notebook.

### Delete a note

Open the note, open the menu in the top bar, and choose **Delete note**, then confirm. If the note has text on this device that has not synced, a second confirmation asks before that text is discarded. If the note changed after the screen showed it, for example in another window of the same note, nothing is deleted: a message says so, the note reloads to show the change, and you can delete it again.

The note leaves the list at once and is deleted on the server at the next Notes sync that is allowed to run, like a saved edit. A note that never synced is only removed from this device; if it is the copy of a synced note you moved there, and the move has not synced yet, the original in its old notebook is deleted on the server at the next sync. If the delete cannot be done, for example because another device changed the note first or the notebook became read-only for you, the note is not deleted: it shows again, with any change made on the other device, and the notebook list says why until you tap **Dismiss**.

### Conflicts and unsynced text

- If a note changed on another device since you started editing it, the other version stays, and your text is saved as a separate note whose title ends in "(conflicted copy)". Both sync. If the note was deleted on another device, your text becomes a new note with your title.
- Text that cannot sync from its notebook, for example after you lose access to a shared notebook or when a conflicted copy conflicts again, is kept under **Unsynced text** in the notebook list. There, depending on why the text is kept, you can copy it, send it again with **Try again**, or discard it. Text that cannot be read can only be discarded together with all of the account's unsynced Notes text, in **Settings**, **Unsynced Notes**.
- If a discard of all unsynced Notes text in **Settings**, **Unsynced Notes** did not finish, no note can be edited until you finish it there.
- Before you sign out with **Sign out** in the app, it counts the Notes changes that have not synced and offers **Sync now**. Signing out without syncing deletes them from this device, after a separate confirmation. If the changes cannot be read at all, going on deletes nothing, and the account stays signed in.
- Android's own account settings cannot remove the account while it has Notes changes that have not synced or cannot be read. If notifications are allowed for the app, it shows an **Account not removed** notification. **Settings**, **Unsynced Notes** lists the account until it can be removed.

### How notes sync

An edit or move saved offline waits on this device until the next Notes sync that is allowed to run. Two settings under **Settings**, **Account**, **Experimental** decide which connections notes use. Each can be set to **Wi-Fi only** or **Wi-Fi or mobile data**.

| Setting | Covers | Default |
|---|---|---|
| **Automatic Notes sync** | Syncs that start by themselves: when you open the Notes screen, about 10 seconds after you save a note (at once when you leave it), and after a calendar, contact, or task sync finishes | **Wi-Fi only** |
| **Sync now for Notes** | Syncs you start, such as **Refresh** at the top of the notebook list, pull to refresh, **Sync now** on the account screen, turning Notes on, and **Try again** under **Unsynced text** | **Wi-Fi or mobile data** |

With the default settings, an edit you save on mobile data waits for Wi-Fi unless you start a sync yourself, for example with **Refresh**.

- A wired (Ethernet) connection counts as Wi-Fi, here and for **Sync over WiFi only**.
- A sync you start from Android's own account settings counts as a calendar, contact, or task sync here, so notes follow **Automatic Notes sync**.
- Coming back onto Wi-Fi does not sync notes on its own, and there is no separate background schedule for notes yet. If the other services do not sync on this device, notes refresh when you open the Notes screen, save a note, pull to refresh, tap **Refresh**, or tap **Sync now** on the account screen, as the settings above allow.
- If **Sync over WiFi only** (under **Settings**, **Sync**) is on for the account, notes sync by themselves only on Wi-Fi, whatever **Automatic Notes sync** says. If a network name is also saved there under **Saved WiFi network**, notes do not sync by themselves until you remove it, because Android does not give the app network names. Neither affects syncs you start.
- When notes are not syncing by themselves on the connection Android reports, the notebook list says so in one line, including whether pulling down will sync now, and the Notes row on the account screen says **Waiting for Wi-Fi**.

## Source Code

The SilentSuite Android app is open source. The source lives in the `android/` directory of the main monorepo:

- [github.com/silent-suite/silentsuite/tree/main/android](https://github.com/silent-suite/silentsuite/tree/main/android)

## What to include in a beta test report

When you report a beta test result, include:

- **Android version** (for example, Android 15).
- **Device model** (for example, Pixel 8).
- **Install source** -- Google Play, F-Droid, Obtainium, Zapstore, Orion Store, or a signed APK from GitHub Releases.
- **Signup/login result** -- whether account creation and login succeeded.
- **Sync result for contacts, calendars, and tasks** -- what synced, what did not, and any error message shown.
- **Errors or screenshots** -- redact your username, email address, server URL (if self-hosted), and any contact, event, or task content before sharing.

## Troubleshooting

### Data not syncing

Open the SilentSuite app and check the sync status. Pull down to force a sync. Check that your account shows as connected.

### Calendar not showing in my app

Some calendar apps need you to enable the SilentSuite calendar in their settings. Look for a "Calendars" or "Accounts" section and make sure the SilentSuite calendars are ticked.

### Battery optimization

Android may restrict background sync. Go to **Settings > Apps > SilentSuite > Battery** and select **Unrestricted** to ensure reliable sync.
