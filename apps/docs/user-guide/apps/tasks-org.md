# Tasks.org

[Tasks.org](https://tasks.org) is an open-source task management app for Android with built-in EteSync support. It connects directly to your SilentSuite server for end-to-end encrypted task sync.

## Install

Install **Tasks.org** from one of these sources:

- [Google Play](https://play.google.com/store/apps/details?id=org.tasks)
- [F-Droid](https://f-droid.org/packages/org.tasks/)

## Set Up

1. Open **Tasks.org**.
2. Go to **Settings** (gear icon) > **Synchronization**.
3. Tap **Add account** > **EteSync**.
4. Enter your SilentSuite server URL:
   - Hosted: `https://server.silentsuite.io`
   - Self-hosted: `https://sync.your-domain.com`
5. Enter your **username** (email) and **password**.
6. Tap **Sign in**.

Your task lists from SilentSuite will appear in the app. Any tasks you create, complete, or edit will sync back to your SilentSuite server with end-to-end encryption.

## Using with EteSync Android App

If you also have the [EteSync Android app](./android.md) installed, Tasks.org can read tasks from Android's system task provider as well. However, the built-in EteSync support in Tasks.org is simpler -- you don't need both. Choose one method:

- **Tasks.org built-in EteSync** -- direct connection, simpler setup, recommended.
- **EteSync Android app + Tasks.org reading from Android** -- useful if you also want tasks in other apps via the system provider.

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

Go to **Settings > Synchronization** and check your EteSync account status. Tap the account to force a sync.

### Duplicate tasks

If you have both the EteSync Android app and Tasks.org's built-in EteSync sync configured, you may see duplicates. Use only one sync method.
