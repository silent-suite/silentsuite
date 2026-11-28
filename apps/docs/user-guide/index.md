# User Guide

How-to guides for using SilentSuite -- your private, end-to-end encrypted sync for calendar, contacts, tasks, and notes.

---

| Guide | Description |
|---|---|
| [Getting Started](./getting-started.md) | Create an account and set up your first device |
| [Collections](./collections.md) | What happens when you remove a member from a shared collection |
| [Calendar](./calendar.md) | How to manage your encrypted calendar |
| [Contacts](./contacts.md) | How to manage your encrypted contacts |
| [Tasks](./tasks.md) | How to manage your encrypted tasks |
| [Notes](./notes.md) | How to manage your encrypted Markdown notes (experimental), and [what the server can and can't see](./notes-server-sees.md) about them |
| [How Encryption Works](./encryption-explained.md) | Understand what's encrypted, how, and why it matters |
| [FAQ](./faq.md) | Frequently asked questions |
| [Reporting a Problem](./reporting-a-problem.md) | Send a problem report or feature request, and what it includes |

---

## Where to Use SilentSuite

- **Web:** [app.silentsuite.io](https://app.silentsuite.io), which works offline and can be [installed](./apps/web.md) on a desktop or phone.
- **Android:** Install through [Google Play](https://play.google.com/store/apps/details?id=io.silentsuite.android), [F-Droid](https://f-droid.org/packages/io.silentsuite.android), Obtainium, Zapstore, or a signed APK from GitHub Releases. In *Settings → Mobile*, the QR code opens the [Android installation guide](https://docs.silentsuite.io/user-guide/apps/android), and a separate link opens the latest signed APK.
- **Desktop (CalDAV / CardDAV):** the [SilentSuite Bridge](./apps/dav-bridge.md) runs a local DAV server for supported clients such as Thunderbird, Calendar on macOS, Evolution and GNOME Calendar. Install commands are in *Settings → Desktop*.
- **iOS:** not supported yet. A native app is [planned](./apps/ios.md), but its scope and timing haven't been decided. EteSync for iOS is not a supported or working SilentSuite client.

## How SilentSuite Works

All your data -- events, contacts, tasks, and notes -- is encrypted on your device before it leaves. The server only ever stores and syncs encrypted blobs. Nobody, including the SilentSuite team, can read your data.

```
Your Device          SilentSuite Server          Your Other Device
    |                      |                          |
    |-- encrypt locally -->|                          |
    |                      |-- stores ciphertext ---->|
    |                      |                          |-- decrypt locally
    |                      |                          |
    |   Server never has the keys. Never sees plaintext.
```
