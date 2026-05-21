# Frequently Asked Questions

## General

### What is SilentSuite?

A privacy-focused, end-to-end encrypted sync service for calendar, contacts, and tasks. Your data is encrypted on your device before it reaches the server. The server never sees plaintext — not even item counts or collection names.

### What's available right now?

The v0.1.0-beta release covers:

- **Web app** at [app.silentsuite.io](https://app.silentsuite.io) — calendar, contacts, tasks, import/export, settings, admin
- **Android** — signed APK for sideloading (download via QR code in the app's *Settings → Mobile*)
- **Desktop bridge** — CalDAV/CardDAV bridge for Thunderbird, Apple Calendar, Evolution, etc., on Linux / macOS / Windows
- **Self-hosting** — two-container Docker stack (PostgreSQL + SilentSuite server)

See the [v0.1.0-beta release notes](https://github.com/silent-suite/silentsuite/releases/tag/v0.1.0-beta) for the full list.

### What's *not* in this beta?

On the roadmap, not yet shipped:

- Native iOS app (the [EteSync iOS app](https://www.etesync.com/) works against your account in the meantime — same Etebase protocol)
- Google Play / F-Droid listings (Android ships as a sideload APK)
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

### How do I get the Android APK?

Sign in to [app.silentsuite.io](https://app.silentsuite.io) on a device with a screen, open *Settings → Mobile*, and either scan the QR code or use the direct download link to the latest GitHub Release.

### Why is the Android app not on Google Play?

Distribution channels (Google Play, F-Droid) are on the roadmap — see [#58](https://github.com/silent-suite/silentsuite-internal/issues/58) and [#59](https://github.com/silent-suite/silentsuite-internal/issues/59). For now it's a signed sideloadable APK.

### How does the desktop bridge work?

It runs a tiny CalDAV/CardDAV daemon bound to `localhost:37358`. Standard PIM clients (Thunderbird, Apple Calendar, Evolution, etc.) talk to it like any other DAV server. The bridge handles encryption/decryption against your silentsuite.io or self-hosted account; plaintext stays inside `localhost`.

Install commands are in *Settings → Desktop* in the web app.

### Will offline edits sync when I reconnect?

Yes. The web app is an offline-first PWA — encrypted writes queue while offline and flush on reconnect.
