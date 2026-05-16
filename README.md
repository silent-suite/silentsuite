<div align="center">

# SilentSuite

**Privacy by Architecture.**

Open-source, zero-knowledge sync for calendars, contacts, and tasks.
Plaintext stays off the server; keys stay on-device.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/silent-suite/silentsuite?logo=github&label=release)](https://github.com/silent-suite/silentsuite/releases)
[![Stars](https://img.shields.io/github/stars/silent-suite/silentsuite?style=flat&logo=github)](https://github.com/silent-suite/silentsuite/stargazers)
[![X](https://img.shields.io/badge/X-@silentsuiteio-000000?logo=x&logoColor=white)](https://x.com/silentsuiteio)

[Website](https://silentsuite.io) · [Docs](https://docs.silentsuite.io) · [Blog](https://silentsuite.io/blog)

<br />

<a href="https://silentsuite.io">
  <img src="./.github/assets/showcase-calendar.png" alt="SilentSuite calendar desktop and mobile mockup" width="100%" />
</a>

<br /><br />

[**Create your account**](https://app.silentsuite.io/signup) · [Self-host with Docker](#self-host) · [Help test the beta](#help-test-the-beta) · [Run locally](#run-locally-for-development)

</div>

---

## What is SilentSuite?

SilentSuite is an end-to-end encrypted alternative to Google Calendar, iCloud, and other cloud sync services. Every event, contact, and task is encrypted on your device before it reaches the server. The sync server stores ciphertext and never receives your encryption keys, so we cannot read your private data.

- 📅 **Calendar:** events encrypted before they leave your device
- 👥 **Contacts:** your relationships, visible only to you
- ✅ **Tasks:** encrypted end-to-end, the server can never read them

Built on the open [Etebase protocol](https://www.etebase.com/). Open source, self-hostable, EU-hosted for the managed service, GDPR-baseline.

## Beta status

SilentSuite is in public beta. The core encrypted sync path is usable today, but the product is still being hardened through external testing before broad app-store launch.

- **Available now:** hosted web app, self-hosting, signed Android APK, CalDAV/CardDAV bridge, calendar/contact import-export, task export
- **In progress:** F-Droid and Google Play listings, broader Android device testing, compatibility reports for DAV clients
- **Not in this beta:** native iOS app, push notifications, shared calendars/contacts, OAuth-based Google/iCloud import
- **Best way to follow along:** [star the repo](https://github.com/silent-suite/silentsuite/stargazers) to track the F-Droid / Google Play launch and release notes

## What works today

✅ **Works natively in the web app:**
- Calendar: create, edit, and sync encrypted events
- Contacts: manage your address book, fully encrypted
- Tasks: encrypted to-do lists
- End-to-end encryption: always on, no toggle, no opt-out

🔌 **Works with apps you already use (via the CalDAV / CardDAV bridge):**
- Apple Calendar, Thunderbird, DAVx⁵, and any standard CalDAV / CardDAV client
- Bridge runs on your machine; plaintext never leaves your device
- Calendar, contacts, and tasks all sync through the bridge

🤖 **Android:**
- Signed APK available from GitHub Releases, with Obtainium-friendly updates
- Syncs SilentSuite data into Android calendar, contacts, and task providers
- F-Droid and Google Play listings are in progress

🍎 **iOS (third-party):**
- Calendar and contacts via the open-source [EteSync app](https://github.com/etesync/ios), using the same Etebase protocol

🚧 **Coming soon:**
- Native iOS app
- Store listings for easier Android installation
- Family plans

> **Ready?** [Create your account](https://app.silentsuite.io/signup): 7 days free with no card, or 30 days with a card; from €3/mo after trial. Or [self-host for free](#self-host).

## How it works

<img src="./.github/assets/how-it-works.svg" alt="How SilentSuite works: your device encrypts data locally, the server stores ciphertext, and your other device decrypts locally." width="100%" />

**Zero-knowledge by architecture.** Your plaintext never touches our sync servers. Encryption is how the system works, not an optional layer. There is no opt-in and no toggle to disable it. Even with full sync-server access, an attacker or a court order yields encrypted data and operational metadata, not plaintext.

**What the hosted service can still see:** account and billing details, approximate encrypted storage size, sync timing, IP-level network logs, and other operational metadata needed to run the service. Event titles, contact fields, task contents, notes, descriptions, locations, and reminders stay encrypted.

**How it integrates with your devices:**

- **Web app:** encryption runs in-browser via [libetebase](https://github.com/etesync/libetebase) (WASM). Keys are derived from your password with Argon2id and held in memory only while you're signed in.
- **CalDAV / CardDAV bridge:** decrypts data locally and exposes it to standard calendar apps over localhost. The bridge never sends plaintext to the server.
- **Android:** the [sync adapter](./android/) uses the native Etebase library (libsodium). Encryption happens before any network call.
- **iOS:** the [EteSync app](https://github.com/etesync/ios) provides zero-knowledge sync via the Etebase protocol.

**Cryptographic primitives:**

| Primitive | Algorithm |
|-----------|-----------|
| Authenticated encryption | XChaCha20-Poly1305 |
| Key derivation | Argon2id |
| Underlying library | [libsodium](https://libsodium.org/) |
| Protocol | [Etebase](https://www.etebase.com/) (open source, auditable) |

## Quick start

### Hosted service

The easiest path: sign up and go. Start with 7 days free without a card, or 30 days with a card; plans from €3/mo after trial:

1. Create your account at [app.silentsuite.io/signup](https://app.silentsuite.io/signup).
2. Sign in at [app.silentsuite.io](https://app.silentsuite.io).
3. Optional: pair an existing calendar app via the [CalDAV bridge](./docs/user-guide/).

### Self-host

Free forever: spin up the encrypted sync server on your own infrastructure with Docker:

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
4. **EU-hosted, GDPR-baseline.** Hosted encrypted data stays in the EU; self-hosted data stays wherever you deploy it. GDPR as a baseline, not a checkbox.
5. **Sustainable business.** Paid hosted service funds development. No private-data monetisation, because we cannot read your sync contents.

## Documentation

- **[User Guide](./docs/user-guide/):** calendar, contacts, tasks, encryption, CalDAV pairing
- **[Self-Hosting](./docs/self-hosting/):** deploy and operate SilentSuite on your own infrastructure
- **[Contributing](./docs/contributing/):** set up a dev environment and ship changes

Hosted at [docs.silentsuite.io](https://docs.silentsuite.io).

## Help test the beta

The most useful feedback right now is concrete, reproducible, and tied to a device or client:

- **Android APK testing:** install via [GitHub Releases](https://github.com/silent-suite/silentsuite/releases/latest) or Obtainium, sign in, confirm calendar/contact/task sync, and report your Android version and device model
- **Bridge compatibility testing:** try Thunderbird, Apple Calendar, Evolution, GNOME Calendar, or another desktop CalDAV/CardDAV client and report what works or breaks
- **Self-hosting verification:** run the Docker setup on a fresh server and report unclear steps, TLS issues, or upgrade problems
- **Docs and trust review:** point out vague privacy claims, missing limitations, confusing setup steps, or screenshots that do not match the current beta

Open a [GitHub issue](https://github.com/silent-suite/silentsuite/issues) with logs/screenshots where useful, but do not paste secrets, recovery phrases, passwords, or private calendar/contact data.

## Contributing

Bug reports, feature requests, and PRs are welcome. Start with the [Contributing guide](./docs/contributing/) for the dev environment, then check [open issues](https://github.com/silent-suite/silentsuite/issues) for something to pick up.

Security issues: please email <info@silentsuite.io> rather than opening a public issue.

## Links

- 🌐 **Website:** [silentsuite.io](https://silentsuite.io)
- 📝 **Blog:** [silentsuite.io/blog](https://silentsuite.io/blog) ([RSS](https://silentsuite.io/blog/feed.xml))
- 📖 **Docs:** [docs.silentsuite.io](https://docs.silentsuite.io)
- 🐦 **X:** [@silentsuiteio](https://x.com/silentsuiteio)
- 📧 **Email:** info@silentsuite.io

## Star history

<a href="https://star-history.com/#silent-suite/silentsuite&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=silent-suite/silentsuite&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=silent-suite/silentsuite&type=Date" />
    <img alt="Star history chart" src="https://api.star-history.com/svg?repos=silent-suite/silentsuite&type=Date" />
  </picture>
</a>

---

<details>
<summary>🛠️ <strong>Developer information</strong></summary>

### Run locally for development

```bash
git clone https://github.com/silent-suite/silentsuite.git
cd silentsuite
pnpm install
pnpm dev   # webapp + docs site
```

The Etebase sync server, CalDAV/CardDAV bridge, and Android adapter each have their own setup. See the [Contributing guide](./docs/contributing/) for the full dev environment.

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
| [`apps/web/`](./apps/web/) | Web app (app.silentsuite.io): encrypted calendar, contacts, tasks UI |
| [`apps/docs/`](./apps/docs/) | Documentation site (docs.silentsuite.io) |
| [`packages/core/`](./packages/core/) | Shared core library (crypto, sync primitives) |
| [`packages/ui/`](./packages/ui/) | Shared UI components |
| [`packages/config/`](./packages/config/) | Shared TypeScript / ESLint / Tailwind config |
| [`server/`](./server/) | Etebase sync server (Python / Django) |
| [`bridge/`](./bridge/) | CalDAV / CardDAV bridge for native calendar apps |
| [`android/`](./android/) | Android sync adapter (Kotlin) |
| [`self-host/`](./self-host/) | Self-hosting Docker configs and scripts |
| [`docs/`](./docs/) | Markdown documentation (user, self-host, contributing) |

The marketing site and billing / accounts API live in a separate private repo. They have no cryptographic responsibilities, and keeping marketing copy out of an AGPL repo is intentional.

</details>

## License

[AGPL-3.0](./LICENSE) · [`android/LICENSE`](./android/LICENSE) (GPL-3.0)
