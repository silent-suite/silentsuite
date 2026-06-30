# Frequently Asked Questions

## General

### What is SilentSuite?

A privacy-focused, end-to-end encrypted sync service for calendar, contacts, and tasks. Your data is encrypted on your device before it reaches the server. The server never sees plaintext — not even item counts or collection names.

### What's available right now?

The v0.1.0-beta release covers:

- **Web app** at [app.silentsuite.io](https://app.silentsuite.io) — calendar, contacts, tasks, import/export, settings, admin
- **Android** — Google Play plus signed APK channels such as GitHub Releases, Zapstore, and F-Droid
- **Desktop bridge** — CalDAV/CardDAV bridge for Thunderbird, Apple Calendar, Evolution, etc., on Linux / macOS / Windows
- **Self-hosting** — two-container Docker stack (PostgreSQL + SilentSuite server)

See the [v0.1.0-beta release notes](https://github.com/silent-suite/silentsuite/releases/tag/v0.1.0-beta) for the full list.

### What's *not* in this beta?

On the roadmap, not yet shipped:

- Native iOS app (the [EteSync iOS app](https://www.etesync.com/) works against your account in the meantime — same Etebase protocol)
- OAuth-based one-click import from Google / iCloud
- Push notifications
- Multiple collections per account ([#88](https://github.com/silent-suite/silentsuite/issues/88))
- First-class encrypted notes ([#45](https://github.com/silent-suite/silentsuite/issues/45))

### Is SilentSuite free?

The hosted service has paid plans (Monthly or Annual). Two free trials are offered at signup: a **7-day trial with no credit card required**, and a **30-day card-secured trial** (you're not charged until day 30 and can cancel any time before then). Self-hosting is free and includes every feature with no subscription. See [Self-Hosting](../self-hosting/).

## Privacy & Security

### Can SilentSuite read my data?

No. All data is encrypted on your device before it reaches the server. The server only stores ciphertext and cannot decrypt it. Even when compelled, SilentSuite cannot produce plaintext data because the keys never reach the server.

See [How Encryption Works](./encryption-explained.md) for the full picture.

### What encryption does SilentSuite use?

The [Etebase protocol](https://www.etebase.com/) — XChaCha20-Poly1305 for symmetric encryption, Argon2 for password-based key derivation. The protocol spec is at [docs.etebase.com](https://docs.etebase.com/).

### Can I reset my password?

No. Your encryption keys are derived from your password, and the server never sees them. If you forget your password, your data cannot be recovered. Use a password manager.

### Are imports and exports also private?

Yes. Both happen entirely in your browser — `.ics` and `.vcf` files are parsed and encrypted (or decrypted and serialized) locally; the file contents never reach the server in plaintext.

## Self-Hosting

### Can I run SilentSuite on my own server?

Yes. See the [Self-Hosting guide](../self-hosting/) for the install flow. Self-hosting gives you full data sovereignty with every feature unlocked and no subscription.

### What do I need to self-host?

A Linux server with Docker, ~1 GB RAM, a domain name, and a reverse proxy you control (Caddy, nginx, Traefik, or Cloudflare Tunnel) for TLS. See [Requirements](../self-hosting/requirements.md).

### Can the same account talk to a self-hosted server *and* the hosted service?

No — an account belongs to a single server. Pick one when you sign up. To migrate later, export from one and import into the other.

## Apps & Devices

### How do I install the Android app?

Use the same channel for install and updates:

- **Google Play** - recommended if you installed from Play and want Play-managed updates.
- **GitHub Releases / Zapstore / F-Droid** - direct APK channels for sideloading and open app-store distribution. To get the direct APK, sign in to [app.silentsuite.io](https://app.silentsuite.io) on a device with a screen, open *Settings → Mobile*, and either scan the QR code or use the direct download link to the latest GitHub Release.

### Why do I see a certificate mismatch when switching Android install channels?

Android only allows an app update when the installed app and the update APK are signed with the same certificate. Google Play uses Play App Signing, so the APK installed from Play can have a different certificate than the direct APK published through GitHub Releases, Zapstore, or F-Droid.

SilentSuite's known Android signing certificate SHA-256 hashes are:

- **Google Play app signing certificate:** `2e10d9ef90276e755bddf086391d7e0c933589c6d36e4e43fae59a7babcb8a49`
- **Direct APK release certificate for GitHub Releases, Zapstore, and reproducible/developer-signed F-Droid builds:** `8035a4ff1511e2045c579c905d26e93af6009b239e741ef78542ae04e7a7ca79`

If you installed from Google Play, update through Google Play. If you installed from a direct APK channel, update through that same channel. Switching channels may require uninstalling and reinstalling the app. A mismatch warning in that situation is expected and does not by itself indicate a compromised build.

### How does the desktop bridge work?

It runs a tiny CalDAV/CardDAV daemon bound to `localhost:37358`. Standard PIM clients (Thunderbird, Apple Calendar, Evolution, etc.) talk to it like any other DAV server. The bridge handles encryption/decryption against your silentsuite.io or self-hosted account; plaintext stays inside `localhost`.

Install commands are in *Settings → Desktop* in the web app.

### Will offline edits sync when I reconnect?

Yes. The web app is an offline-first PWA — encrypted writes queue while offline and flush on reconnect.
