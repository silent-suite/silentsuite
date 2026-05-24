# User Guide

How to use SilentSuite — your end-to-end encrypted sync for calendar, contacts, and tasks. Everything in this guide is grounded in what's actually shipped in [v0.1.0-beta](https://github.com/silent-suite/silentsuite/releases/tag/v0.1.0-beta).

---

| Guide | Description |
|---|---|
| [Getting Started](./getting-started.md) | Sign up, pick a plan, install on a second device, confirm sync |
| [Calendar](./calendar.md) | Events, recurrence, timezones, ICS import/export |
| [Contacts](./contacts.md) | Contact CRUD, vCard import/export |
| [Tasks](./tasks.md) | Tasks, priorities, due dates, ICS task export |
| [How Encryption Works](./encryption-explained.md) | What's encrypted, how, and what the server can and can't see |
| [FAQ](./faq.md) | Common questions |

---

## How SilentSuite Works

All your data — events, contacts, tasks — is encrypted on your device before it leaves. The server only ever stores and syncs ciphertext. Nobody, including the SilentSuite team, can read your data.

```
Your Device          SilentSuite Server          Your Other Device
    |                      |                          |
    |-- encrypt locally -->|                          |
    |                      |-- stores ciphertext ---->|
    |                      |                          |-- decrypt locally
    |                      |                          |
    |   Server never has the keys. Never sees plaintext.
```

## Where to Use SilentSuite

- **Web** — [app.silentsuite.io](https://app.silentsuite.io) (offline-first PWA, installable to any desktop or mobile home screen)
- **Android** — signed APK, sideloadable. QR-code download in *Settings → Mobile* once you're signed in
- **Desktop (CalDAV / CardDAV)** — the SilentSuite bridge runs a local DAV daemon for Thunderbird, Apple Calendar, Evolution, GNOME Calendar, etc. Install commands in *Settings → Desktop*
- **iOS** — no native app yet; the [EteSync iOS app](https://www.etesync.com/) works against your silentsuite.io or self-hosted account in the meantime
