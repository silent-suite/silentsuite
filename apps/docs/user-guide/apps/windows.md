# Windows Calendar & Outlook

Sync SilentSuite with Windows Calendar, Windows Contacts, or Microsoft Outlook through the [SilentSuite Bridge](./dav-bridge.md).

## Prerequisites

1. The [SilentSuite Bridge](./dav-bridge.md) running on your PC.
2. Your **SilentSuite credentials** from the bridge's web UI at `http://localhost:37358/.web/`.

## Windows Calendar & Mail App

1. Open **Calendar** (or **Mail**).
2. Go to **Settings** (gear icon) > **Manage Accounts** > **Add account**.
3. Select **iCloud** (this is a workaround -- Windows doesn't have a generic CalDAV option).
4. Enter:
   - **Email**: your SilentSuite email
   - **Password**: your **SilentSuite password**
5. Windows will fail to connect to iCloud. When it shows the manual configuration:
   - **Calendar server (CalDAV)**: `http://localhost:37358/`
   - **Contacts server (CardDAV)**: `http://localhost:37358/`
6. Click **Sign In**.

::: tip
The Windows DAV client has known limitations. For detailed steps and workarounds specific to your Windows version, see the [SilentSuite Bridge guide](./dav-bridge.md).
:::

## Microsoft Outlook

Outlook's built-in CalDAV support is limited. For best results, use a connector:

1. Install a CalDAV plugin for Outlook (e.g., [Outlook CalDav Synchronizer](https://github.com/niclas5891/OutlookCalDavSynchronizer) -- free, open source).
2. Configure it with:
   - **CalDAV URL**: `http://localhost:37358/`
   - **CardDAV URL**: `http://localhost:37358/`
   - **Username**: your SilentSuite email
   - **Password**: your SilentSuite password

## Alternative: em Client

[em Client](https://www.emclient.com/) is a Windows email/calendar app with excellent CalDAV/CardDAV support:

1. Install em Client.
2. Add a CalDAV account with server `http://localhost:37358/`.
3. Enter your SilentSuite credentials.

## Running the Bridge at Startup

To run the SilentSuite Bridge automatically on Windows startup, see the [DAV bridge guide](./dav-bridge.md) for Windows service configuration.

## Troubleshooting

### Windows Calendar won't connect

Windows 10/11 has bugs with local CalDAV connections. Try:

- Using `127.0.0.1` instead of `localhost`.
- The [SilentSuite Bridge guide](./dav-bridge.md) for platform-specific workarounds.

### Password rejected

Use your **SilentSuite password** to authenticate with the bridge at `http://localhost:37358/.web/`.
