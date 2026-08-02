# User Guide

How to use SilentSuite: your end-to-end encrypted sync for calendar, contacts, and tasks. Everything in this guide is grounded in the current beta. See the [latest release](https://github.com/silent-suite/silentsuite/releases/latest) for version-specific details.

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
- **Android:** Install through Google Play, Obtainium, Zapstore, or a signed APK from GitHub Releases. In *Settings → Mobile*, the QR code opens the [Android installation guide](https://docs.silentsuite.io/user-guide/apps/android), and a separate link opens the latest signed APK. Official F-Droid inclusion is pending.
- **Desktop (CalDAV / CardDAV)** — the SilentSuite bridge runs a local DAV daemon for Thunderbird, Apple Calendar, Evolution, GNOME Calendar, etc. Install commands in *Settings → Desktop*
- **iOS** — on the roadmap, coming soon; the native app is in development, and EteSync for iOS is not a supported or working SilentSuite client
