# GNOME Calendar & Contacts

GNOME Calendar and GNOME Contacts support CalDAV and CardDAV through GNOME Online Accounts. Connect them to SilentSuite through the [SilentSuite Bridge](./dav-bridge.md).

## Prerequisites

1. GNOME Desktop (any recent version).
2. [SilentSuite Bridge](./dav-bridge.md) installed and running on your machine.
3. Your SilentSuite email and password.

## Add CalDAV/CardDAV Account

GNOME uses a centralized account system. Adding one account enables both calendars and contacts.

1. Open **Settings** > **Online Accounts**.
2. Click **Other** (or **CalDAV / CardDAV** if listed separately).
3. Enter:
   - **CalDAV URL**: `http://localhost:37358/your@email.com/`
   - **CardDAV URL**: `http://localhost:37358/your@email.com/`
   - **Username**: your SilentSuite email
   - **Password**: your SilentSuite password
4. Click **Connect**.

Your calendars, tasks, and contacts will now appear in:
- **GNOME Calendar** for events
- **GNOME Contacts** for address books
- **GNOME To Do** for tasks (if installed)

## Alternative: Direct CalDAV Setup

If GNOME Online Accounts doesn't show CalDAV/CardDAV:

1. Open **GNOME Calendar**.
2. Click the menu button > **Calendar Sources** > **+**.
3. Select **CalDAV**.
4. Enter the CalDAV URL: `http://localhost:37358/your@email.com/`
5. Enter your SilentSuite email and password.

## Troubleshooting

### No calendars appear

1. Ensure the bridge is running: `http://localhost:37358/.web/`
2. GNOME may take a moment to discover collections. Wait 30 seconds and refresh.
3. Try restarting `gnome-calendar`.

### System tray not visible

GNOME removed native tray support. Install the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/) to see the bridge tray icon.
