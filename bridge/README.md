# SilentSuite Bridge

Local E2EE CalDAV/CardDAV sync daemon for SilentSuite.

Connects to `server.silentsuite.io` by default, or your configured self-hosted server, via the Etebase protocol. It decrypts/encrypts data locally and exposes CalDAV/CardDAV endpoints on `localhost:37358` for supported desktop clients, including Thunderbird, Calendar and Contacts on macOS, GNOME Calendar and Evolution, KDE Kontact, and Outlook on Windows.

## Account Commands

The local dashboard at `http://localhost:37358/` is the normal place to set up and manage bridge accounts. `--login` is still available as a fallback or advanced path; it adds a new account or re-authenticates an existing account without removing other configured accounts.

```bash
silentsuite-bridge --login
silentsuite-bridge --list-accounts
silentsuite-bridge --logout user@example.com
silentsuite-bridge --remove-account user@example.com
```

- `--list-accounts` prints every configured bridge account and its Etebase server URL.
- `--logout <email>` removes that account's local credential/session material and stops its runtime sync, but keeps its local cache for faster re-login.
- `--remove-account <email>` performs logout and deletes that account's local cache rows.
- DAV URLs are namespaced per account: `http://localhost:37358/user@example.com/`.

The dashboard exposes the same account-management flow without terminal commands:

- **Add / Re-authenticate Account** shows the dashboard sign-in form and starts that account's sync thread after login succeeds.
- **Log out** removes local bridge credentials/session material for one account and keeps that account's local cache.
- **Remove account** removes local bridge credentials/session material and deletes that account's local cache rows.

## macOS Apple Internet Accounts

Apple Internet Accounts may require the local bridge to use HTTPS with a trusted localhost certificate. To generate or reuse a localhost certificate and print the Keychain setup steps, run this on the Mac that hosts the bridge:

```bash
silentsuite-bridge --setup-macos-apple-accounts
```

On macOS, this persists bridge SSL settings, opens the certificate for Keychain, and prints the Advanced account setup fields. Trust the certificate in Keychain with **Secure Sockets Layer (SSL)** set to **Always Trust**, restart the bridge, then use the dashboard's `https://localhost:37358/your@example.com/` DAV URL.

Enabling bridge SSL changes the whole single listener to HTTPS. Existing HTTP clients using the same bridge profile must switch to `https://` and trust the localhost certificate. The bridge does not expose simultaneous HTTP and HTTPS listeners in this mode.

Advanced/headless configuration keys:

- `sslEnabled` / `SILENTSUITE_BRIDGE_SSL`
- `sslCertFile` / `SILENTSUITE_BRIDGE_SSL_CERT`
- `sslKeyFile` / `SILENTSUITE_BRIDGE_SSL_KEY`

If Apple Internet Accounts still fails after HTTPS setup, collect redacted bridge logs for `/principals/`, `/.well-known/caldav`, and `/.well-known/carddav`. Do not include passwords or session tokens; this evidence determines whether a later DAV discovery compatibility shim is needed.

The local bridge cache contains decrypted calendar/contact/task data. Use `--remove-account` when retiring a shared or untrusted machine.

## Self-Update

The Bridge can check for and apply updates from the CLI:

```bash
# Check whether a newer release is available (no mutation)
silentsuite-bridge --check-update

# Download, verify, and install the latest release (frozen binary only)
silentsuite-bridge --self-update
```

`--check-update` prints the running version, queries public GitHub releases,
and reports whether an update is available without touching any configuration,
data, or server state.

`--self-update` downloads the latest compatible binary and its `.sha256`
sidecar, verifies the checksum, and replaces the running executable. It only
works with frozen release binaries (installed via the official installer or
GitHub download) in writable locations. Source/editable installs are refused.
Same-version replacement and downgrades are always refused.

Failed downloads, checksum mismatches, or replacement errors leave the
installed executable intact. The existing autostart entries are not changed.
The full bridge docs at `https://docs.silentsuite.io/bridge` cover
manual-installer updates, Windows running-process behavior, and recovery.

## License

AGPL-3.0-only
