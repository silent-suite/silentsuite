# SilentSuite

**Private Sync, By Design.**

End-to-end encrypted synchronization for calendar, contacts, and tasks. Your schedule and relationships, visible only to you.

Built on the [Etebase protocol](https://www.etebase.com/). Open source. EU-hosted.

[Website](https://silentsuite.io) | [Blog](https://silentsuite.io/blog) | [Waitlist](https://silentsuite.io/#waitlist)

## What is SilentSuite?

SilentSuite is an encrypted alternative to Google Calendar, Apple iCloud, and other cloud sync services. Every piece of data is encrypted on your device before it reaches our server. The server only ever sees ciphertext.

- **Calendar** -- events encrypted before they leave your device
- **Contacts** -- your relationships, visible only to you
- **Tasks** -- your to-dos, nobody else's business

## How it works

```
Your Device          SilentSuite Server          Your Other Device
    |                      |                          |
    |-- encrypt locally -->|                          |
    |                      |-- stores ciphertext ---->|
    |                      |                          |-- decrypt locally
    |                      |                          |
    |   Server never has the keys. Never sees plaintext.
```

All encryption and decryption happens on your devices. The server stores and syncs encrypted blobs. We can't read your data, even if compelled to.

## Status

SilentSuite is in active development.

- [x] Etebase server deployed and running
- [x] Real E2E encrypted sync verified between devices
- [x] Landing page live at [silentsuite.io](https://silentsuite.io)
- [x] Waitlist open (GDPR-compliant double opt-in)
- [x] Blog with RSS feed
- [ ] Client apps (Android, web, iOS)
- [ ] CalDAV bridge for existing calendar apps
- [ ] Family plans

## Tech stack

| Component | Technology |
|-----------|-----------|
| Server | Python, Etebase protocol, Docker |
| Landing page | Next.js 15, Tailwind CSS, Cloudflare Workers |
| Hosting | EU cloud infrastructure |
| Encryption | Etebase protocol (XChaCha20-Poly1305, Argon2) |
| License | AGPL-3.0 (server + apps) |

## Principles

1. **Encryption is the architecture, not a feature.** No toggles, no opt-in. Everything is encrypted by default.
2. **Open source by default.** Apps and server code are open. Audit the encryption, verify the claims.
3. **No lock-in.** Export your data anytime. Self-host if you want. Standard Etebase protocol, not proprietary formats.
4. **EU-hosted, GDPR-compliant.** Your encrypted data stays in the EU. GDPR as a baseline, not a checkbox.
5. **Sustainable business.** Paid hosted service funds development. No data monetisation. We can't -- it's encrypted.

## Repository Structure

| Directory | Description |
|-----------|-------------|
| `apps/web/` | Next.js web app (app.silentsuite.io) |
| `apps/mobile/` | React Native mobile app |
| `apps/landing/` | Marketing site (silentsuite.io) |
| `apps/docs/` | Documentation site |
| `packages/core/` | Shared core library |
| `packages/ui/` | Shared UI components |
| `packages/config/` | Shared configuration |
| `android/` | Android sync adapter (Kotlin) |
| `bridge/` | CalDAV/CardDAV bridge (Python) |
| `server/` | Etebase sync server (Python/Django) |
| `self-host/` | Self-hosting Docker configs and scripts |

## Documentation

Full documentation is available in the [`docs/`](./docs/) directory:

- **[User Guide](./docs/user-guide/)** -- how-to guides for calendar, contacts, tasks, and encryption
- **[Self-Hosting](./docs/self-hosting/)** -- deploy and manage SilentSuite on your own infrastructure
- **[Contributing](./docs/contributing/)** -- set up a dev environment and contribute to SilentSuite

## Self-hosting

The server can be self-hosted. See the [Self-Hosting guide](./docs/self-hosting/) for complete instructions.

See `deploy/RUNBOOK.md` in this repo for additional server administration details.

## Development

This repository contains the SilentSuite landing page and blog. See the [Contributing guide](./docs/contributing/) for full setup instructions.

```bash
# Install dependencies
pnpm install

# Run locally
pnpm dev

# Build and deploy
npx opennextjs-cloudflare build && npx wrangler deploy --keep-vars
```

## Links

- **Website:** [silentsuite.io](https://silentsuite.io)
- **Blog:** [silentsuite.io/blog](https://silentsuite.io/blog)
- **RSS:** [silentsuite.io/blog/feed.xml](https://silentsuite.io/blog/feed.xml)
- **X:** [@silentsuiteio](https://x.com/silentsuiteio)
- **Reddit:** [u/silentsuiteio](https://reddit.com/user/silentsuiteio)
- **Mastodon:** [@silentsuiteio@infosec.exchange](https://infosec.exchange/@silentsuiteio)
- **Email:** info@silentsuite.io
- **Status:** [status.silentsuite.io](https://status.silentsuite.io)

## License

AGPL-3.0
