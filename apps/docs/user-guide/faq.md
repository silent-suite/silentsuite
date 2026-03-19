# Frequently Asked Questions

## General

### What is SilentSuite?

SilentSuite is a privacy-focused, end-to-end encrypted sync service for calendar, contacts, and tasks. Your data is encrypted on your device before it reaches the server. The server never sees plaintext.

### Is SilentSuite free?

SilentSuite offers a hosted service with paid plans to fund development. Self-hosting is free and includes all features. See [Self-Hosting](/self-hosting/) for details.

### What platforms are supported?

<!-- TODO: Update as client apps launch -->

SilentSuite is in active development. Web, Android, and iOS clients are planned.

## Privacy & Security

### Can SilentSuite read my data?

No. All data is encrypted on your device before it reaches the server. The server only stores encrypted blobs. Even if compelled by a court order, SilentSuite cannot produce plaintext data because it does not have the encryption keys.

### What encryption does SilentSuite use?

SilentSuite uses the [Etebase protocol](https://www.etebase.com/) with XChaCha20-Poly1305 for encryption and Argon2 for key derivation. See [How Encryption Works](./encryption-explained.md) for details.

### Can I reset my password?

No. Your encryption keys are derived from your password, and the server never has access to them. If you forget your password, your data cannot be recovered. Use a password manager.

## Self-Hosting

### Can I run SilentSuite on my own server?

Yes. See the [Self-Hosting guide](/self-hosting/) for instructions. Self-hosting gives you full data sovereignty and all features unlocked with no subscription.

### What do I need to self-host?

A Linux server with Docker, 2 GB RAM, and a domain name. See [Requirements](/self-hosting/requirements) for full details.
