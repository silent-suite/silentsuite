# Frequently Asked Questions

## General

### What is SilentSuite?

SilentSuite is a privacy-focused, end-to-end encrypted sync service for calendar, contacts, and tasks. Your data is encrypted on your device before it reaches the server. The server never sees plaintext.

### Is SilentSuite free?

SilentSuite offers a hosted service with paid plans to fund development. Self-hosting is free and includes all features. See [Self-Hosting](/self-hosting/) for details.

### What platforms are supported?

SilentSuite works across all major platforms:

- **Web:** The web app is live at [app.silentsuite.io](https://app.silentsuite.io).
- **Android:** A dedicated Android sync adapter is available from Google Play and direct APK channels such as [GitHub Releases](https://github.com/silent-suite/silentsuite/releases), Zapstore, and F-Droid.
- **iOS:** Use the third-party [EteSync for iOS](https://apps.apple.com/app/etesync/id1489574285) app from the App Store. Enter your server URL during setup.
- **Desktop:** Use the [SilentSuite Bridge](./apps/dav-bridge.md) with any CalDAV/CardDAV app (Thunderbird, macOS Calendar, GNOME Calendar, and more).

## Privacy & Security

### Can SilentSuite read my data?

No. All data is encrypted on your device before it reaches the server. The server only stores encrypted blobs. Even if compelled by a court order, SilentSuite cannot produce plaintext data because it does not have the encryption keys.

### What encryption does SilentSuite use?

SilentSuite uses the [Etebase protocol](https://www.etebase.com/) with XChaCha20-Poly1305 for encryption and Argon2 for key derivation. See [How Encryption Works](./encryption-explained.md) for details.

### Can I reset my password?

No. Your encryption keys are derived from your password, and the server never has access to them. If you forget your password, your data cannot be recovered. Use a password manager.

## Apps & Devices

### Why do I see a certificate mismatch when switching Android install channels?

Android only allows an app update when the installed app and the update APK are signed with the same certificate. Google Play uses Play App Signing, so the APK installed from Play can have a different certificate than the direct APK published through GitHub Releases, Zapstore, or F-Droid.

SilentSuite's known Android signing certificate SHA-256 hashes are:

- **Google Play app signing certificate:** `2e10d9ef90276e755bddf086391d7e0c933589c6d36e4e43fae59a7babcb8a49`
- **Direct APK release certificate for GitHub Releases, Zapstore, and reproducible/developer-signed F-Droid builds:** `8035a4ff1511e2045c579c905d26e93af6009b239e741ef78542ae04e7a7ca79`

If you installed from Google Play, update through Google Play. If you installed from GitHub Releases, Zapstore, or F-Droid, update through that same direct APK channel. Switching channels may require uninstalling and reinstalling the app. A certificate mismatch warning in that situation is expected and does not by itself indicate a compromised build.

## Self-Hosting

### Can I run SilentSuite on my own server?

Yes. See the [Self-Hosting guide](/self-hosting/) for instructions. Self-hosting gives you full data sovereignty and all features unlocked with no subscription.

### What do I need to self-host?

A Linux server with Docker, 1 GB RAM minimum, and a domain name. See [Requirements](/self-hosting/requirements) for full details.
