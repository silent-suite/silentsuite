# Tasks.org

[Tasks.org](https://tasks.org) is an open-source task app for Android. You can let the SilentSuite Android app handle encrypted sync, or connect Tasks.org directly to your server using its built-in EteSync connector. Choose one method per account to avoid duplicate lists.

## Install

Install **Tasks.org** from one of these sources:

- [Google Play](https://play.google.com/store/apps/details?id=org.tasks)
- [F-Droid](https://f-droid.org/packages/org.tasks/)

## Set Up

### Recommended setup with SilentSuite for Android

1. Install Tasks.org 15.14 or later and [SilentSuite for Android](./android.md).
2. On the Tasks.org welcome screen, tap **Continue without sync**. SilentSuite will handle sync on this device. If you already use Tasks.org, skip the welcome screen step.
3. Open SilentSuite and sign in to your account. If the **Tasks** row says **Permission needed**, tap **Allow access** → **Request Tasks.org permissions** → **Allow**.
4. Tap **Sync now** in SilentSuite. Open the navigation drawer in Tasks.org and look for your list under the account labeled **SilentSuite**. The default list is **Personal Tasks**.

Create tasks in that list to sync them back to SilentSuite. Tasks saved under **Local lists** stay on the device.

### Alternative setup with the built-in EteSync connector

Use this method if you want Tasks.org to sync directly without installing the SilentSuite Android app.

1. Open **Tasks.org**.
2. Tap **Add account** on the welcome screen or in **App settings**.
3. Choose **EteSync**.
4. Enter your server URL:
   - Hosted: `https://server.silentsuite.io`
   - Self-hosted: `https://sync.your-domain.com`
5. Enter your **username** (email) and **password**.
6. Tap **Sign in**.

Your task lists from SilentSuite will appear in the app. Any tasks you create, complete, or edit will sync back to `server.silentsuite.io` or your self-hosted server with end-to-end encryption.

## Features

Tasks.org supports:

- Multiple task lists (mapped to Etebase collections)
- Due dates and reminders
- Priorities
- Subtasks
- Tags
- Recurring tasks
- Location-based reminders

## Troubleshooting

### Tasks not syncing

If you use the SilentSuite Android app, check the **Tasks** row in SilentSuite for a permission request or sync error, then tap **Sync now**. In Tasks.org, check which list the task is saved in.

If you use the EteSync connector, open **App settings** in Tasks.org and select your EteSync account to check its sync status.

### Duplicate lists or tasks

Check whether the same account is syncing through both an Android sync app (SilentSuite or EteSync) and the built-in EteSync connector in Tasks.org. Use one sync method per account.
