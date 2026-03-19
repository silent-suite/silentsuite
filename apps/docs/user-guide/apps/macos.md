# macOS Calendar & Contacts

Sync SilentSuite with the native macOS Calendar and Contacts apps through the [SilentSuite Bridge](./dav-bridge.md).

## Prerequisites

1. The [SilentSuite Bridge](./dav-bridge.md) running on your Mac.
2. Your **SilentSuite credentials** from the bridge's web UI at `http://localhost:37358/.web/`.

## Add Calendar Account

1. Open **System Settings** (or System Preferences on older macOS).
2. Go to **Internet Accounts** > **Add Account** > **Other**.
3. Click **CalDAV Account**.
4. Select **Manual** for the account type.
5. Enter:
   - **Username**: your SilentSuite email
   - **Password**: your **SilentSuite password**
   - **Server Address**: `http://localhost:37358/`
6. Click **Sign In**.

Your SilentSuite calendars will appear in the Calendar app.

## Add Contacts Account

1. Open **System Settings** > **Internet Accounts** > **Add Account** > **Other**.
2. Click **CardDAV Account**.
3. Select **Manual**.
4. Enter:
   - **Username**: your SilentSuite email
   - **Password**: your **SilentSuite password**
   - **Server Address**: `http://localhost:37358/`
5. Click **Sign In**.

Your SilentSuite contacts will appear in the Contacts app.

## Running the Bridge at Login

To keep the SilentSuite Bridge running automatically, see the [DAV bridge guide](./dav-bridge.md) for macOS launchd configuration.

## Known Issues

macOS Mojave and later have known bugs with local CalDAV/CardDAV accounts. If you encounter issues:

- Try using `127.0.0.1` instead of `localhost` in the server address.
- If macOS rejects the connection, try adding the account via the Calendar or Contacts app directly instead of System Settings.

## Troubleshooting

### Calendar shows but events are missing

macOS may limit sync to recent events. Open **Calendar > Preferences > Accounts**, select your DAV account, and check the sync range.

### Connection refused

Make sure the SilentSuite Bridge is running. Open `http://localhost:37358/.web/` in Safari to verify.
