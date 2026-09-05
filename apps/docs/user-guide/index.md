# User Guide

How-to guides for using SilentSuite -- your private, end-to-end encrypted sync for calendar, contacts, tasks, and notes.

---

| Guide | Description |
|---|---|
| [Getting Started](./getting-started.md) | Create an account and set up your first device |
| [Calendar](./calendar.md) | How to manage your encrypted calendar |
| [Contacts](./contacts.md) | How to manage your encrypted contacts |
| [Tasks](./tasks.md) | How to manage your encrypted tasks |
| [Notes](./notes.md) | How to manage your encrypted Markdown notes |
| [How Encryption Works](./encryption-explained.md) | Understand what's encrypted, how, and why it matters |
| [FAQ](./faq.md) | Frequently asked questions |

---

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
