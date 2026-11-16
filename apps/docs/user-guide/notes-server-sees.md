# What the Server Sees in Notes

Note titles, note text and notebook names are encrypted on your device before they are uploaded. The server stores them but has no key to read them. To store and sync your notes, the server still sees some facts about them. This page lists those facts for Notes, checked against the code of the SilentSuite server, the web app and the Android app.

"The server" means the sync server your account uses: the hosted server, or your own server if you self-host. Facts that belong to your account as a whole, such as your email address, are listed at the end.

## At a glance

| What | Can the server read it? | Why |
|---|---|---|
| Note titles and last-edited times | No | They are in each note's encrypted metadata. |
| Note text | No | It is the note's encrypted content. |
| Notebook names, colors and descriptions | No | They are in the notebook's encrypted metadata. |
| Which collections are notebooks | Not by name | The type name `etebase.md.note` is encrypted with a key from your account. The server sees one opaque value that all your notebooks share. |
| Note and notebook IDs | Yes | Random IDs made on your device. They contain none of your text. |
| How many notebooks and notes you have | Yes | Each note is stored as a separate item in its notebook. |
| How many times each note was saved | Yes | Each save adds a version, and the server keeps the earlier versions. |
| The order of changes | Yes | Each change gets a number from a rising counter. |
| Sizes | Roughly | Note text is padded before encryption. Titles are not padded. |
| Which notes and notebooks are deleted | Yes | The deleted mark is not encrypted. |
| Members of a shared notebook | Yes | Their usernames and access levels. |
| Invitations | Yes | Who invited whom, to which notebook, at which access level. |
| When you use Notes | Partly | From the order of changes, file times and request logs. See [Timing](#timing). |
| What you search for | No | Search runs on your device. |
| Exported files | No | Export decrypts your notes on your device. |

## IDs

- Each note and each notebook has an ID that your device picks at random. The server uses these IDs to store and find items, and they appear in the addresses of requests.
- Each saved version has an ID that is calculated while its metadata is encrypted, so it contains nothing readable.
- Note text is stored in pieces. Each piece's ID is a keyed hash of that piece, made with the note's key, which the server does not have. So the server cannot use the IDs to test guesses about your text, but it can see when a piece is identical to one in an earlier version of the same note. For example, when a save changes only the title, the pieces of text keep the IDs they had.
- In the web app, moving a note to another notebook creates a copy with a new ID and deletes the original. The server sees a new note in one notebook and a deleted note in the other at about the same time.
- On Android, when a note changed in two places, your text is saved as a new note whose title ends in "(conflicted copy)". The title is encrypted; the server sees one more note in that notebook.

## Counts and versions

- Each note is its own item in its notebook, so the server can count the notes in each notebook and the notebooks in each account.
- Each save stores a new version and keeps the earlier ones, encrypted. The server can count how many times each note was saved.

## Sizes

- Note text under 16 KiB (16,384 bytes) is stored as one piece, rounded up to the next multiple of 1 KiB before encryption. A 300-byte note and a 900-byte note look the same size.
- Longer text is split into pieces of up to 64 KiB, each rounded up to a multiple of 1 KiB (2 KiB for pieces of 32 KiB or more), plus one small piece that records their order. The server sees how many pieces a note has.
- A note with no text has no stored piece at all, so the server can tell that its text is empty.
- A note's title and last-edited time are encrypted together as its metadata, with only one byte of padding. The size of the encrypted metadata follows the length of the title, so the server can estimate how long a title is. The same applies to notebook names.
- These sizes come from the Etebase library that the web app uses. The Android app uses the Etebase Java client; its padding has not been checked for this page.

## Deleting

- A deleted note keeps its ID on the server. Its newest version is marked deleted and has no note text, only encrypted metadata. Its earlier versions stay on the server, encrypted.
- In the web app, deleting a notebook marks the notebook deleted. The notebook and the notes in it stay on the server, encrypted.
- On a self-hosted server, deleting the account in the admin panel removes its rows from the database, but the encrypted files can stay in the server's media volume. See [Admin Dashboard](../self-hosting/admin-dashboard.md#delete-a-user).

## Sharing and members

- For each notebook, the server knows which account created it, which accounts are members, and each member's access level: read-only, read-write and admin.
- Each member's copy of the notebook key is encrypted, so the server cannot read it.
- For each invitation, the server stores who sent it, who it is for, which notebook it is for and the access level. The notebook key inside it is encrypted to the recipient's public key.
- When you invite someone, the server sees the username or email address you looked up.
- Admins of a notebook can list its members' usernames.
- When a member leaves a notebook or is removed from it, the server deletes the membership and keeps a record that it ended.

## Timing

The database tables that hold notebooks, notes, versions, members and invitations have no date or time columns. The last-edited time you see in the app is inside the encrypted metadata. The server still learns when things happen:

- The rising counter on each change records the order of all changes on the server.
- By default, note text is stored as files on the server's disk, in folders named by account number and notebook ID. File systems record when each file was written.
- The server keeps a record of each sign-in session, with the time it was created and an expiry that moves forward when the session is used, at most once a minute. That shows roughly when each signed-in device last made a request.
- While the web app is open, it asks the server for changes about every 30 seconds.
- Request logs, described below.

## Request logs

- The server image logs each request with the client's address, the method, the path with its query string, and the response status. For Notes, paths contain notebook IDs, note IDs and text piece IDs, and query strings contain sync positions. When you share a notebook, the query string of the lookup contains the username or email address you looked up.
- Behind a reverse proxy listed in `TRUSTED_PROXY_IPS`, the logged address is the device address that the proxy reports.
- A reverse proxy in front of the server can keep its own access log, often with each browser's user agent. Check its settings.
- The Umbrel app turns off both the server's request log and its router's access log.
- The server's own log messages contain no note data. A warning about a missing file names the file's path, which includes the account number and the notebook ID.
- For the hosted service, see the [privacy policy](https://silentsuite.io/privacy).

## The web app's host

- The host that serves the web app, such as app.silentsuite.io, sends you the app's files. Notes requests go from your browser to the sync server; the web app's own server does not receive or relay them. This is also how it works when you use app.silentsuite.io with your own server.
- On app.silentsuite.io, error reports contain a fixed set of fields: the error type, a fixed code such as "sync notes failed", the page (`/notes`), the browser family and positions in the app's code. They contain no error message, note ID, title or text.
- The web app's analytics events are limited to the sign-in, sign-up and subscription pages. Notes pages send none.
- The Android app does not include a crash reporter.

## On your device

- Search runs over notes the app has already decrypted. Your search terms are not sent.
- Export decrypts your notes in your browser and builds the `.zip` there. It reads your notes from the server again first.
- The web app's offline cache and its queue of edits made offline stay in your browser, with note content encrypted.
- The Android app keeps changes that have not synced yet in an encrypted store on the device.
- **Report a problem** sends only what you type and fixed diagnostic values. See [Reporting a Problem](./reporting-a-problem.md).

## Your account

These belong to your account, not to Notes: your username (the apps use your email address as the username), your email address, your public keys, the salt used to derive your keys, your encrypted account data, when you signed up and when you last signed in. On the hosted service, the link between your account and billing passes your username and email address to billing, and nothing from Notes.

## How this page was checked

The facts above were checked against the server (`server/etebase_server`), the web app and its shared code (`apps/web`, `packages/core`), the Etebase JavaScript library 0.43.1, and the Android Notes code (`android/app/src/main/java/io/silentsuite/sync/notes`). A few statements describe the tools SilentSuite runs on rather than its own code: the request log format (uvicorn), the sign-up and sign-in times (Django), file system times and reverse proxy logs.
