# Windows Calendar & Outlook

Sync SilentSuite with Microsoft Outlook, Windows Calendar, or other Windows apps through the [SilentSuite Bridge](./dav-bridge.md).

## Prerequisites

1. The [SilentSuite Bridge](./dav-bridge.md) running on your PC.
2. Your **SilentSuite credentials** from the bridge's web UI at `http://localhost:37358/.web/`.

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
   - **Username**: your SilentSuite email
   - **Password**: your SilentSuite password
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

## em Client

[em Client](https://www.emclient.com/) is a Windows email, calendar, and contacts app with built-in CalDAV/CardDAV support. The free version supports up to two email accounts.

1. Open em Client and go to **Menu > Accounts**.
2. Click **+** (Add Account).
3. Select **Calendar** (or **Contacts**) > **CalDAV** (or **CardDAV**).
4. Enter:
   - **Server URL**: `http://localhost:37358/your@email.com/`
   - **Username**: your SilentSuite email
   - **Password**: your SilentSuite password
5. Click **Next**. em Client will discover your calendars and contacts.
6. Click **Finish**.

## Windows Calendar & Mail App

The built-in Windows Calendar app has limited CalDAV support. It requires a workaround to add a CalDAV account.

1. Open **Calendar** (or **Mail**).
2. Go to **Settings** (gear icon) > **Manage Accounts** > **Add account**.
3. Select **iCloud** (Windows does not have a generic CalDAV option, so we use iCloud as a starting point).
4. Enter:
   - **Email**: your SilentSuite email
   - **Password**: your SilentSuite password
5. Windows will fail to connect to iCloud. When it shows the manual configuration:
   - **Calendar server (CalDAV)**: `http://localhost:37358/`
   - **Contacts server (CardDAV)**: `http://localhost:37358/`
6. Click **Sign In**.

::: warning
The Windows Calendar DAV client has known bugs with local connections. If it does not work, we recommend using Outlook with CalDav Synchronizer or em Client instead.
:::

## Running the Bridge at Startup

To run the SilentSuite Bridge automatically on Windows startup, see the [DAV bridge guide](./dav-bridge.md#auto-start) for auto-start configuration.

## Troubleshooting

### Outlook CalDav Synchronizer not syncing

1. Open the **CalDav Synchronizer** tab and click **Status**.
2. Check for error messages in the sync log.
3. Make sure the bridge is running: open `http://localhost:37358/.web/` in your browser.
4. Verify the DAV URL includes your email: `http://localhost:37358/your@email.com/`.

### Windows Calendar won't connect

Windows 10/11 has bugs with local CalDAV connections. Try:

- Using `http://127.0.0.1:37358/` instead of `http://localhost:37358/`.
- Switching to Outlook with CalDav Synchronizer or em Client for a more reliable experience.

### Password rejected

Use your **SilentSuite password** (the same one you use to log into the SilentSuite web app). Verify it works by opening `http://localhost:37358/.web/` in your browser.
