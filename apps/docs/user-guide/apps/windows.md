# Windows / Outlook

Sync SilentSuite with Microsoft Outlook through the [SilentSuite Bridge](./dav-bridge.md).

## Prerequisites

1. The [SilentSuite Bridge](./dav-bridge.md) running on your PC.
2. Your **account credentials** from the bridge's web UI at `http://localhost:37358/`.

## Microsoft Outlook (with CalDav Synchronizer)

Outlook does not support CalDAV natively. The free, open-source [CalDav Synchronizer](https://github.com/niclas5891/OutlookCalDavSynchronizer) plugin adds full CalDAV/CardDAV support.

### Install the Plugin

1. Download the latest release from [GitHub](https://github.com/niclas5891/OutlookCalDavSynchronizer/releases).
2. Close Outlook.
3. Run the installer (.msi file).
4. Re-open Outlook. You should see a **CalDav Synchronizer** tab in the ribbon.

### Add a Calendar Sync Profile

1. Click the **CalDav Synchronizer** tab in the Outlook ribbon.
2. Click **Synchronization Profiles**.
3. Click the **+** (Add) button and select **Generic CalDAV/CardDAV**.
4. Give the profile a name (e.g. "SilentSuite Calendar").
5. Under **Server Settings**, enter:
   - **DAV URL**: `http://localhost:37358/your@email.com/`
   - **Username**: your account email
   - **Password**: your account password
6. Click **Test or discover settings**. The plugin will find your calendars.
7. Select the Outlook folder to sync with (or create a new calendar folder).
8. Click **OK** to save.

### Add a Contacts Sync Profile

1. Open **Synchronization Profiles** again.
2. Click **+** and select **Generic CalDAV/CardDAV**.
3. Name it (e.g. "SilentSuite Contacts").
4. Enter the same server settings as above.
5. Click **Test or discover settings**.
6. Select your Outlook Contacts folder as the target.
7. Click **OK**.

### Sync

Click **Synchronize now** in the CalDav Synchronizer ribbon tab, or wait for the automatic sync interval (default: 30 minutes). You can adjust the interval in each profile's settings.

## Running the Bridge at Startup

To run the SilentSuite Bridge automatically on Windows startup, see the [DAV bridge guide](./dav-bridge.md#auto-start) for auto-start configuration.

## Troubleshooting

### Outlook CalDav Synchronizer not syncing

1. Open the **CalDav Synchronizer** tab and click **Status**.
2. Check for error messages in the sync log.
3. Make sure the bridge is running: open `http://localhost:37358/` in your browser.
4. Verify the DAV URL includes your email: `http://localhost:37358/your@email.com/`.

### Password rejected

Use your **account password** (the same one you use to log into app.silentsuite.io or your self-hosted server). Verify it works by opening `http://localhost:37358/` in your browser.
