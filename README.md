# SilentSuite

**Private Sync, By Design.**

End-to-end encrypted synchronization for calendar, contacts, and tasks. Your schedule and relationships, visible only to you.

Built on the [Etebase protocol](https://www.etebase.com/). Open source. EU-hosted.

[Website](https://silentsuite.io) | [Blog](https://silentsuite.io/blog)

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

## Features

- **Web app** -- full calendar, contacts, and task management at [app.silentsuite.io](https://app.silentsuite.io)
- **Android app** -- native sync adapter that integrates with your system calendar and contacts
- **CalDAV/CardDAV bridge** -- use Thunderbird, GNOME Calendar, or any standards-compliant client
- **Self-hosting** -- run your own server and keep everything on your infrastructure
- **Stripe billing** -- hosted plans with free trial, or self-host for free

## Tech stack

| Component | Technology |
|-----------|-----------|
| Web app | Next.js 16, TypeScript, Zustand, Tailwind CSS |
| Android | Kotlin, Etebase SDK (Rust JNI) |
| CalDAV bridge | Python, Radicale |
| Server | Django, Etebase protocol, PostgreSQL |
| Billing API | Fastify, Drizzle ORM, Stripe |
| Landing page | Next.js, Cloudflare Workers |
| Encryption | Etebase protocol (XChaCha20-Poly1305, Argon2) |

## Principles

1. **Encryption is the architecture, not a feature.** No toggles, no opt-in. Everything is encrypted by default.
2. **Open source by default.** Apps and server code are open. Audit the encryption, verify the claims.
3. **No lock-in.** Export your data anytime. Self-host if you want. Standard Etebase protocol, not proprietary formats.
4. **EU-hosted, GDPR-compliant.** Your encrypted data stays in the EU. GDPR as a baseline, not a checkbox.
5. **Sustainable business.** Paid hosted service funds development. No data monetisation. We can't -- it's encrypted.

## Repository structure

| Directory | Description |
|-----------|-------------|
| `apps/web/` | Next.js web app (app.silentsuite.io) |
<<<<<<< ours
| `apps/docs/` | Documentation site (docs.silentsuite.io) |
| `packages/core/` | Shared core library |
| `packages/ui/` | Shared UI components |
| `packages/config/` | Shared configuration |
=======
| `apps/landing/` | Marketing site (silentsuite.io) |
| `apps/docs/` | Documentation site |
>>>>>>> theirs
| `android/` | Android sync adapter (Kotlin) |
| `bridge/` | CalDAV/CardDAV bridge (Python) |
| `server/` | Etebase sync server (Django) |
| `silentsuite-billing/` | Billing API (Fastify/Stripe) |
| `packages/core/` | Shared parsers and types |
| `packages/ui/` | Shared UI components |
| `self-host/` | Self-hosting installer and scripts |

## Self-hosting

Run SilentSuite on your own infrastructure. The installer handles Docker, PostgreSQL, and nginx configuration.

```bash
curl -fsSL https://silentsuite.io/bridge/install.sh | bash
```

See the [Self-Hosting guide](./docs/self-hosting/) for complete instructions.

## Development

<<<<<<< ours
This repository contains the open-source pieces of SilentSuite: the encrypted sync server, the web client (with end-to-end crypto), the Android sync adapter, and the CalDAV/CardDAV bridge. See the [Contributing guide](./docs/contributing/) for setup instructions.

The marketing site (silentsuite.io) and the billing/accounts API live in a separate, private repository — they don't bear any cryptographic responsibilities, and keeping marketing copy out of an AGPL repo is intentional.
=======
This is a pnpm monorepo with Turborepo for build orchestration.

```bash
# Install dependencies
pnpm install

# Run the web app locally
pnpm --filter web dev

# Run the landing page locally
pnpm --filter landing dev

# Run all packages in dev mode
pnpm dev
```
>>>>>>> theirs

The Android app is built separately with Gradle. The bridge and server are Python projects with their own dependency management. See each directory's README for component-specific setup.

## Contributing

See the [Contributing guide](./docs/contributing/) for full setup instructions and development conventions.

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

[AGPL-3.0](./LICENSE)
