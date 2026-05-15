<div align="center">

# SilentSuite

**Private Sync, By Design.**

End-to-end encrypted calendar, contacts, and tasks.
Your schedule and relationships — visible only to you.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/silent-suite/silentsuite?logo=github&label=release)](https://github.com/silent-suite/silentsuite/releases)
[![Stars](https://img.shields.io/github/stars/silent-suite/silentsuite?style=flat&logo=github)](https://github.com/silent-suite/silentsuite/stargazers)
[![Mastodon](https://img.shields.io/badge/Mastodon-@silentsuiteio-6364FF?logo=mastodon&logoColor=white)](https://infosec.exchange/@silentsuiteio)

[Website](https://silentsuite.io) · [Docs](https://docs.silentsuite.io) · [Blog](https://silentsuite.io/blog)

<br />

<a href="https://silentsuite.io">
  <img src="./.github/assets/showcase-calendar.png" alt="SilentSuite calendar — desktop and mobile mockup" width="100%" />
</a>

</div>

> **Get started:** [Create your account](https://app.silentsuite.io/signup), self-host with Docker, or run locally — see [Quick start](#quick-start).

---

## What is SilentSuite?

SilentSuite is an end-to-end encrypted alternative to Google Calendar, iCloud, and other cloud sync services. Every event, contact, and task is encrypted on your device before it reaches the server. The server only ever sees ciphertext — we cannot read your data, and neither can anyone we are compelled to hand it to.

- **Calendar** — events encrypted before they leave your device
- **Contacts** — your relationships, visible only to you
- **Tasks** — your to-dos, nobody else's business

Built on the open [Etebase protocol](https://www.etebase.com/). Open source, EU-hosted, GDPR-baseline.

## What works today

**Works natively in the web app:**
- Calendar — create, edit, and sync encrypted events
- Contacts — manage your address book, fully encrypted
- Tasks — encrypted to-do lists
- End-to-end encryption — always on, no toggle, no opt-out

**Works with apps you already use (via the CalDAV / CardDAV bridge):**
- Apple Calendar, Thunderbird, DAVx⁵, and any standard CalDAV / CardDAV client
- Bridge decrypts locally on your machine — plaintext never leaves your device
- Calendar, contacts, and tasks all sync through the bridge

**Android:**
- Calendar and contacts sync via the [SilentSuite sync adapter](./android/) (Kotlin)

**iOS (third-party):**
- Calendar and contacts via the open-source [EteSync app](https://github.com/etesync/ios), using the same Etebase protocol

**Coming soon:**
- Native Android and iOS apps
- Family plans

## Why SilentSuite?

| | Google / Apple / Microsoft | Other "encrypted" calendars | **SilentSuite** |
|---|:-:|:-:|:-:|
| E2E encrypted by default | ✗ | partial | **✓** |
| Open-source server + client | ✗ | mixed | **✓** |
| Works with native CalDAV / CardDAV apps | ✓ | mostly ✗ | **✓** |
| Self-hostable | ✗ | mixed | **✓** |
| EU-hosted / GDPR-baseline | varies | varies | **✓** |
| No data monetisation | ✗ | varies | **✓** |
| Standard, exportable data format | ✓ | mixed | **✓** |

## How it works

<img src="./.github/assets/how-it-works.svg" alt="How SilentSuite works — your device encrypts data locally, the server only stores ciphertext, your other device decrypts locally. The server never has your keys and never sees plaintext." width="100%" />

All encryption and decryption happens on your devices. The server stores and syncs encrypted blobs — even with full server access, an attacker or a court order yields ciphertext and nothing else.

## Security & encryption

**Zero-knowledge by architecture.** Your plaintext never touches our servers. Encryption is how the system works, not an optional layer — there is no opt-in and no toggle to disable it.

**How it integrates with your devices:**

- **Web app** — encryption runs in-browser via [libetebase](https://github.com/etesync/libetebase) (WASM). Keys are derived from your password with Argon2id and held in memory only while you're signed in.
- **CalDAV / CardDAV bridge** — decrypts data locally and exposes it to standard calendar apps over localhost. The bridge never sends plaintext to the server.
- **Android** — the [sync adapter](./android/) uses the native Etebase library (libsodium). Encryption happens before any network call.
- **iOS** — the [EteSync app](https://github.com/etesync/ios) provides zero-knowledge sync via the Etebase protocol.

**Cryptographic primitives:**

| Primitive | Algorithm |
|-----------|-----------|
| Authenticated encryption | XChaCha20-Poly1305 |
| Key derivation | Argon2id |
| Underlying library | [libsodium](https://libsodium.org/) |
| Protocol | [Etebase](https://www.etebase.com/) (open source, auditable) |

## Quick start

### Hosted service

The easiest path — sign up and go:

1. Create your account at [app.silentsuite.io/signup](https://app.silentsuite.io/signup).
2. Sign in at [app.silentsuite.io](https://app.silentsuite.io).
3. Optional: pair an existing calendar app via the [CalDAV bridge](./docs/user-guide/).

### Self-host

Spin up the encrypted sync server on your own infrastructure with Docker:

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite/self-host
cp .env.example .env   # then edit
docker compose up -d
```

Full instructions, TLS setup, and operational guidance in the [Self-Hosting guide](./docs/self-hosting/).

## Principles

1. **Encryption is the architecture, not a feature.** No toggles, no opt-in. Everything is encrypted by default.
2. **Open source by default.** Apps and server code are open. Audit the encryption, verify the claims.
3. **No lock-in.** Export your data anytime. Self-host if you want. Standard Etebase protocol, not proprietary formats.
4. **EU-hosted, GDPR-baseline.** Your encrypted data stays in the EU. GDPR as a baseline, not a checkbox.
5. **Sustainable business.** Paid hosted service funds development. No data monetisation — we can't, it's encrypted.

## Documentation

- **[User Guide](./docs/user-guide/)** — calendar, contacts, tasks, encryption, CalDAV pairing
- **[Self-Hosting](./docs/self-hosting/)** — deploy and operate SilentSuite on your own infrastructure
- **[Contributing](./docs/contributing/)** — set up a dev environment and ship changes

Hosted at [docs.silentsuite.io](https://docs.silentsuite.io).

## Contributing

Bug reports, feature requests, and PRs are welcome. Start with the [Contributing guide](./docs/contributing/) for the dev environment, then check [open issues](https://github.com/silent-suite/silentsuite/issues) for something to pick up.

Security issues: please email <info@silentsuite.io> rather than opening a public issue.

## Links

- **Website:** [silentsuite.io](https://silentsuite.io)
- **Blog:** [silentsuite.io/blog](https://silentsuite.io/blog) ([RSS](https://silentsuite.io/blog/feed.xml))
- **Docs:** [docs.silentsuite.io](https://docs.silentsuite.io)
- **Mastodon:** [@silentsuiteio@infosec.exchange](https://infosec.exchange/@silentsuiteio)
- **X:** [@silentsuiteio](https://x.com/silentsuiteio)
- **Email:** info@silentsuite.io

## Star history

⭐ If SilentSuite looks useful, star this repo to follow releases and support the project!

<a href="https://star-history.com/#silent-suite/silentsuite&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=silent-suite/silentsuite&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=silent-suite/silentsuite&type=Date" />
    <img alt="Star history chart" src="https://api.star-history.com/svg?repos=silent-suite/silentsuite&type=Date" />
  </picture>
</a>

---

<details>
<summary><strong>Developer information</strong></summary>

### Run locally for development

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite
pnpm install
pnpm dev   # webapp + docs site
```

The Etebase sync server, CalDAV/CardDAV bridge, and Android adapter each have their own setup — see the [Contributing guide](./docs/contributing/) for the full dev environment.

### Tech stack

| Component | Technology |
|-----------|-----------|
| Sync server | Python, Etebase protocol, Django |
| Web app | Next.js 15, React, Tailwind CSS |
| Docs site | VitePress, Vue, Cloudflare Workers |
| CalDAV / CardDAV bridge | Python, Radicale |
| Android adapter | Kotlin |
| Encryption | Etebase protocol (XChaCha20-Poly1305, Argon2id via libsodium) |
| Hosting | EU cloud infrastructure |
| License | AGPL-3.0 (server + apps) |

### Repository structure

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

The marketing site and billing / accounts API live in a separate private repo — they have no cryptographic responsibilities, and keeping marketing copy out of an AGPL repo is intentional.

</details>

## License

[AGPL-3.0](./LICENSE) · [`android/LICENSE`](./android/LICENSE) (GPL-3.0)
