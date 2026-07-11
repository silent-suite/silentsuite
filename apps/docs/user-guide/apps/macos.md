# macOS Calendar & Contacts

Sync SilentSuite with the native macOS Calendar and Contacts apps through the [SilentSuite Bridge](./dav-bridge.md).

macOS Apple Internet Accounts is stricter than many DAV clients: use **Advanced** setup with **SSL enabled** and a trusted localhost certificate.

## Prerequisites

1. Install and start the [SilentSuite Bridge](./dav-bridge.md) on your Mac.
2. Sign in to the bridge dashboard first so your account appears at `http://localhost:37358/`.
3. Run the macOS Apple Accounts setup command:

   ```bash
   silentsuite-bridge --setup-macos-apple-accounts
   ```

4. In **Keychain Access**, add/open the generated localhost certificate and set **Trust > Secure Sockets Layer (SSL)** to **Always Trust**.
5. Restart the bridge and open the dashboard at `https://localhost:37358/` or `https://127.0.0.1:37358/`.

::: warning HTTPS affects the whole local bridge
After SSL setup, this bridge profile serves its single DAV listener over HTTPS. Existing clients configured with `http://localhost:37358/` must be updated to the `https://` URL shown in the dashboard and may need to trust the same localhost certificate.
:::

## Add Calendar Account

1. Open **System Settings** (or System Preferences on older macOS).
2. Go to **Internet Accounts** > **Add Account** > **Other**.
3. Click **CalDAV Account**.
4. Select **Advanced** for the account type.
5. Enter:
   - **User Name**: your SilentSuite account email
   - **Password**: your account password
   - **Server Address**: `localhost` or `127.0.0.1`
   - **Server Path**: `/your@email.com/` using the exact account email shown in the bridge dashboard
   - **Port**: `37358`
   - **Use SSL**: checked
6. Click **Sign In**.

Your SilentSuite calendars should appear in Calendar after the bridge completes sync.

## Add Contacts Account

1. Open **System Settings** > **Internet Accounts** > **Add Account** > **Other**.
2. Click **CardDAV Account**.
3. Select **Advanced**.
4. Enter:
   - **User Name**: your SilentSuite account email
   - **Password**: your account password
   - **Server Address**: `localhost` or `127.0.0.1`
   - **Server Path**: `/your@email.com/` using the exact account email shown in the bridge dashboard
   - **Port**: `37358`
   - **Use SSL**: checked
5. Click **Sign In**.

Your SilentSuite contacts should appear in Contacts after the bridge completes sync.

## If CalDAV Fails

Some macOS versions accept the trusted localhost certificate more reliably after adding CardDAV first.

1. Add the **CardDAV** account using Advanced setup and SSL.
2. Confirm Contacts can connect.
3. Add the **CalDAV** account again using the same server address, port, SSL setting, username, password, and account path.

## Running the Bridge at Login

To keep the SilentSuite Bridge running automatically, see the [DAV bridge guide](./dav-bridge.md) for macOS launchd configuration.

## Troubleshooting

### Connection refused

Make sure the SilentSuite Bridge is running. Open the dashboard URL shown by the bridge:

- Before SSL setup: `http://localhost:37358/`
- After SSL setup: `https://localhost:37358/`

### Certificate warning or account rejected

1. Reopen **Keychain Access**.
2. Find the generated localhost certificate from `silentsuite-bridge --setup-macos-apple-accounts`.
3. Set **Trust > Secure Sockets Layer (SSL)** to **Always Trust**.
4. Restart the bridge and retry Apple Internet Accounts.

### `SSL: WRONG_VERSION_NUMBER`

A client connected using HTTP while bridge HTTPS is enabled. Enable SSL in the DAV client and use an `https://` URL. The bridge has one listener, so it cannot redirect plaintext HTTP after HTTPS is enabled.

An initial anonymous `401 Unauthorized` followed by a successful authenticated request is the normal Basic authentication challenge. An explicit `Invalid password for configured user` message is a separate credentials failure.

### Calendar shows but events are missing

macOS may limit sync to recent events. Open **Calendar > Settings > Accounts**, select your DAV account, and check the sync range.

### Apple Internet Accounts still fails with `/principals/`

Current Bridge builds provide an authenticated, non-enumerating `/principals/` discovery container while keeping your account's normal `/your@email.com/` path canonical. If HTTPS + Advanced setup still fails, collect an ordered, redacted bridge trace for support. Include the method, path, Depth value, status, and returned href classes for paths such as:

- `/principals/`
- `/.well-known/caldav`
- `/.well-known/carddav`
- `/your@email.com/`

Do **not** include passwords, Authorization headers, session tokens, contact/calendar contents, or full private logs. Record whether macOS requests `/principals/your@email.com/`; that account-specific alias remains denied unless real Apple protocol evidence proves it is required.
