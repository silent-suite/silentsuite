# How Encryption Works

SilentSuite uses end-to-end encryption (E2EE) so that the content of your calendars, contacts, tasks and notes is never readable by anyone except you -- not even the SilentSuite server.

## The Basics

- All encryption and decryption happens **on your device**.
- Your password is used to derive encryption keys using **Argon2** (a memory-hard key derivation function designed to resist brute-force attacks).
- Data is encrypted using **XChaCha20-Poly1305**, a modern authenticated encryption algorithm.
- Your calendar, contact, task and note content reaches the server only as **encrypted blobs**. It cannot decrypt them.

## What's Encrypted

All of your content:

- Calendar event titles, dates, locations, descriptions, and reminders
- Contact names, emails, phone numbers, addresses, and notes
- Task titles, due dates, priorities, and notes
- Note titles and Markdown bodies

There is no toggle to turn encryption on or off. Encryption is the architecture, not a feature.

## What the Server Can See

The server knows:

- That you have an account
- How much encrypted data is stored
- How many items each collection holds, and how often each one changes
- When data was last synced

The server **cannot** see:

- The contents of any event, contact, task, or note
- The names of your calendars, address books, task lists, or notebooks

Some account and sharing data is not encrypted: your username and email address, public keys, sign-up and last sign-in times, and who you share with. [What the server sees in Notes](./notes-server-sees.md) lists it in detail.

## What Happens If You Forget Your Password

Since encryption keys are derived from your password and the server never has access to your keys, **there is no password reset**. If you forget your password, your data cannot be recovered.

We strongly recommend:

- Using a password manager to store your account password
- Writing down your password and storing it in a secure physical location

## The Etebase Protocol

SilentSuite is built on the [Etebase protocol](https://www.etebase.com/), an open and auditable end-to-end encryption protocol. You can review the protocol specification and cryptographic design at [docs.etebase.com](https://docs.etebase.com/).
