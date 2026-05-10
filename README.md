<div align="center">

# SilentSuite

**Private Sync, By Design.**

End-to-end encrypted calendar, contacts, and tasks. Your schedule and relationships, visible only to you.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/silent-suite/silentsuite?style=flat&logo=github)](https://github.com/silent-suite/silentsuite/stargazers)
[![Release](https://img.shields.io/github/v/release/silent-suite/silentsuite?logo=github&label=release)](https://github.com/silent-suite/silentsuite/releases)

[Website](https://silentsuite.io) · [Blog](https://silentsuite.io/blog) · [Docs](https://docs.silentsuite.io) · [Waitlist](https://silentsuite.io/#waitlist)

<br />

<a href="https://silentsuite.io">
  <img src="./.github/assets/showcase-calendar.png" alt="SilentSuite calendar — desktop and mobile mockup" width="100%" />
</a>

</div>

> **Try it now:** Join the waitlist at [silentsuite.io](https://silentsuite.io/#waitlist) or self-host with `docker compose up -d` — see [Quick start](#quick-start) below.

---

## What is SilentSuite?

SilentSuite is an end-to-end encrypted alternative to Google Calendar, iCloud, and other cloud sync services. Every event, contact, and task is encrypted on your device before it touches our server. The server only ever stores ciphertext — we cannot read your data, and neither can anyone we are compelled to hand it to.

- 📅 **Calendar** — events encrypted before they leave your device
- 👥 **Contacts** — your relationships, visible only to you
- ✅ **Tasks** — your to-dos, nobody else's business

| Feature | Web app | CalDAV/CardDAV bridge | Android | iOS |
|---|:---:|:---:|:---:|:---:|
| Calendar | ✓ | ✓ | ✓ | ✓ ¹ |
| Contacts | ✓ | ✓ | ✓ | ✓ ¹ |
| Tasks | ✓ | — | 🔄 | 🔄 |
| End-to-end encryption | ✓ | ✓ | ✓ | ✓ ¹ |

¹ Via the open-source [EteSync app](https://github.com/etesync/ios) on iOS.

Built on the open [Etebase protocol](https://www.etebase.com/). Open source, EU-hosted, GDPR-baseline.

## Why SilentSuite?

|  | Google / Apple / Microsoft | Other "encrypted" calendars | **SilentSuite** |
|---|:-:|:-:|:-:|
| End-to-end encrypted by default | ✗ | partial | ✓ |
| Open-source server + client | ✗ | mixed | ✓ |
| Works with native CalDAV / CardDAV apps | ✓ | mostly ✗ | ✓ (via bridge) |
| Self-hostable | ✗ | mixed | ✓ |
| EU-hosted / GDPR-baseline | varies | varies | ✓ |
| No data monetisation | ✗ | varies | ✓ (impossible — it's encrypted) |
| Standard, exportable data format | ✓ | mixed | ✓ |

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

All encryption and decryption happens on your devices. The server stores and syncs encrypted blobs. Even with full server access, an attacker — or a court order — gets ciphertext and nothing else.

## Security & encryption

**Zero-knowledge by architecture.** Your plaintext never touches our servers — there is no opt-in or toggle because encryption is how the system works, not an optional layer on top.

**How it integrates with your devices:**

- **Web app** — encryption runs in-browser via [libetebase](https://github.com/etesync/libetebase) (WASM). Keys are derived from your password (Argon2) and held in memory only while you're signed in.
- **CalDAV / CardDAV bridge** — the bridge decrypts data locally and exposes it to standard calendar apps (Apple Calendar, Thunderbird, DAVx⁵) over localhost. The bridge never sends plaintext to the server.
- **Android** — the [SilentSuite sync adapter](./android/) uses the native Etebase library (libsodium). Encryption happens before any network call.
- **iOS** — the [EteSync app](https://github.com/etesync/ios) provides the same zero-knowledge sync via the Etebase protocol.

**Cryptographic primitives:** XChaCha20-Poly1305 authenticated encryption, Argon2id key derivation, via [libsodium](https://libsodium.org/). The full protocol is [open source and auditable](https://www.etebase.com/).

## Quick start

### Try the hosted service

The easiest path is the hosted webapp:

1. Join the waitlist at [silentsuite.io](https://silentsuite.io/#waitlist).
2. Sign in at [app.silentsuite.io](https://app.silentsuite.io) once your invite arrives.
3. Optional: pair an existing calendar app (Apple Calendar, Thunderbird, DAVx⁵) via the [CalDAV bridge](./docs/user-guide/).

### Self-host

Spin up the encrypted sync server on your own infrastructure with Docker:

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite/self-host
cp .env.example .env   # then edit
docker compose up -d
```

Full instructions, TLS setup, and operational guidance are in the [Self-Hosting guide](./docs/self-hosting/).

### Run locally for development

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite
pnpm install
pnpm dev   # webapp + docs site
```

The Etebase sync server, CalDAV/CardDAV bridge, and Android adapter each have their own setup — see the [Contributing guide](./docs/contributing/) for the full dev environment.

## Status

SilentSuite is in active development.

- [x] Etebase server deployed and running
- [x] Real E2E encrypted sync verified between devices
- [x] Web app live at [app.silentsuite.io](https://app.silentsuite.io)
- [x] CalDAV / CardDAV bridge
- [x] Landing page live at [silentsuite.io](https://silentsuite.io)
- [x] Waitlist open (GDPR-compliant double opt-in)
- [x] Blog with RSS feed
- [ ] Android client
- [ ] iOS client
- [ ] Family plans

## Tech stack

| Component | Technology |
|-----------|-----------|
| Sync server | Python, Etebase protocol, Docker |
| Web app | Next.js 15, React, Tailwind CSS |
| Docs site | VitePress, Vue, Cloudflare Workers |
| CalDAV / CardDAV bridge | Python, Radicale |
| Android adapter | Kotlin |
| Encryption | Etebase protocol (XChaCha20-Poly1305, Argon2 via libsodium) |
| Hosting | EU cloud infrastructure |
| License | AGPL-3.0 (server + apps) |

## Repository structure

| Path | What it is |
|------|-----------|
| [`apps/web/`](./apps/web/) | Web app (app.silentsuite.io) — encrypted calendar, contacts, tasks UI |
| [`apps/docs/`](./apps/docs/) | Documentation site (docs.silentsuite.io) |
| [`packages/core/`](./packages/core/) | Shared core library (crypto, sync primitives) |
| [`packages/ui/`](./packages/ui/) | Shared UI components |
| [`packages/config/`](./packages/config/) | Shared TypeScript / ESLint / Tailwind config |
| [`server/`](./server/) | Etebase sync server (Python / Django) |
| [`bridge/`](./bridge/) | CalDAV / CardDAV bridge for native calendar apps |
| [`android/`](./android/) | Android sync adapter (Kotlin) |
| [`self-host/`](./self-host/) | Self-hosting Docker configs and scripts |
| [`docs/`](./docs/) | Markdown documentation (user, self-host, contributing) |

The marketing site (silentsuite.io) and the billing / accounts API live in a separate, private repo. They have no cryptographic responsibilities, and keeping marketing copy out of an AGPL repo is intentional.

## Documentation

- **[User Guide](./docs/user-guide/)** — calendar, contacts, tasks, encryption, CalDAV pairing
- **[Self-Hosting](./docs/self-hosting/)** — deploy and operate SilentSuite on your own infrastructure
- **[Contributing](./docs/contributing/)** — set up a dev environment and ship changes

Hosted at [docs.silentsuite.io](https://docs.silentsuite.io).

## Principles

1. **Encryption is the architecture, not a feature.** No toggles, no opt-in. Everything is encrypted by default.
2. **Open source by default.** Apps and server code are open. Audit the encryption, verify the claims.
3. **No lock-in.** Export your data anytime. Self-host if you want. Standard Etebase protocol, not proprietary formats.
4. **EU-hosted, GDPR-baseline.** Your encrypted data stays in the EU. GDPR as a baseline, not a checkbox.
5. **Sustainable business.** Paid hosted service funds development. No data monetisation. We can't — it's encrypted.

## Contributing

Bug reports, feature requests, and PRs are welcome. Start with the [Contributing guide](./docs/contributing/) for the dev environment, then check [open issues](https://github.com/silent-suite/silentsuite/issues) for something to pick up.

Security issues: please email <info@silentsuite.io> rather than opening a public issue.

## Contributors

[![Contributors](https://contrib.rocks/image?repo=silent-suite/silentsuite)](https://github.com/silent-suite/silentsuite/graphs/contributors)

## Links

- 🌐 **Website:** [silentsuite.io](https://silentsuite.io)
- 📝 **Blog:** [silentsuite.io/blog](https://silentsuite.io/blog) ([RSS](https://silentsuite.io/blog/feed.xml))
- 📖 **Docs:** [docs.silentsuite.io](https://docs.silentsuite.io)
- 🟢 **Status:** [status.silentsuite.io](https://status.silentsuite.io)
- 🐦 **X:** [@silentsuiteio](https://x.com/silentsuiteio)
- 📧 **Email:** info@silentsuite.io

## Star history

⭐ If you find SilentSuite useful, star this repo to follow releases and support the project!

<a href="https://star-history.com/#silent-suite/silentsuite&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=silent-suite/silentsuite&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=silent-suite/silentsuite&type=Date" />
    <img alt="Star history chart" src="https://api.star-history.com/svg?repos=silent-suite/silentsuite&type=Date" />
  </picture>
</a>

## License

[AGPL-3.0](./LICENSE)
