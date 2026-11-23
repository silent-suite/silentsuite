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

## What a Signed-In Browser Keeps

To decrypt your data, the web app needs your account's encryption key, so a signed-in browser holds that key and a sync token. The browser stores them without a password of their own. Anyone who copies them can open your account without knowing your password: for example, malware on your computer, someone who reads your browser profile or a backup of it, or a script running inside the app.

Where the key is kept depends on how you signed in:

- **"Keep me signed in on this device" off** (the default): the key stays in that browser tab only. Closing the tab removes it, although a browser's "restore tabs" feature can keep it for longer. A new tab you open yourself asks for your password again.
- **"Keep me signed in on this device" on**, or a **self-hosted server**: the key stays in the browser's storage until you log out.

Some things to know:

- **Logging out** removes the key and your calendar, address book, task list and notebook names from this browser. It can't make a copy that someone took earlier useless.
- **Changing your password** is meant to sign out your other sessions. If the app shows a warning afterwards, they may still be signed in. Your account's encryption key doesn't change, so data someone already copied stays readable to them.
- On a shared or untrusted computer, leave "Keep me signed in" off and log out when you're done.

## The Etebase Protocol

SilentSuite is built on the [Etebase protocol](https://www.etebase.com/), an open and auditable end-to-end encryption protocol. You can review the protocol specification and cryptographic design at [docs.etebase.com](https://docs.etebase.com/).
