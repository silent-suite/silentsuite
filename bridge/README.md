# SilentSuite Bridge

Local E2EE CalDAV/CardDAV sync daemon for SilentSuite.

Connects to `server.silentsuite.io` by default, or your configured self-hosted server, via the Etebase protocol. It decrypts/encrypts data locally and exposes CalDAV/CardDAV endpoints on `localhost:37358` for use with any standard PIM client (Thunderbird, Apple Calendar, GNOME Calendar, Evolution, etc.).

## Account Commands

`--login` adds a new account or re-authenticates an existing account. It does not remove other configured accounts.

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

The local dashboard at `http://localhost:37358/.web/` exposes the same account-management flow without terminal commands:

- **Add / Re-authenticate Account** opens the bridge sign-in page in your browser and starts that account's sync thread after login succeeds.
- **Log out** removes local bridge credentials/session material for one account and keeps that account's local cache.
- **Remove account** removes local bridge credentials/session material and deletes that account's local cache rows.

The local bridge cache contains decrypted calendar/contact/task data. Use `--remove-account` when retiring a shared or untrusted machine.

## License

AGPL-3.0-only
