# What the Server Sees in Notes

Note titles, note text and notebook names are encrypted on your device, and the server has no key to read them. It still sees some facts about your notes, listed here.

"The server" is the sync server your account uses: the hosted one, or your own if you self-host. Calendars, task lists, address books and notebooks are all collections. The web app also keeps collections for settings and labels.

[How Encryption Works](./encryption-explained.md#what-the-server-can-see) summarizes what the server knows about all your data. This page gives the details for Notes.

## At a glance

| What | Can the server read it? | Why |
|---|---|---|
| Note titles | No | They are in encrypted metadata. |
| Last-edited times | Not the stored value | It is encrypted, but the server sees when each save arrives. |
| Note text | No | It is encrypted content. |
| Notebook names, colors and descriptions | No | They are in encrypted metadata. |
| Which collections are notebooks | Yes, in practice | The type is an opaque value, a code the server cannot decode, but all your notebooks share it, and the apps ask for the types in a fixed order: the web app asks for notebooks fourth, after calendars, task lists and address books, and Android asks for them last. |
| Note and notebook IDs | Yes | Random IDs made on your device, with none of your text. They appear in request addresses. |
| How many notebooks you have, and how many notes each one holds | Yes | Each note is a separate item in its notebook. |
| How often each note changed | Yes | Each save adds a version, and earlier versions are kept. |
| The order of changes | Yes | Each change gets a number from a rising counter. |
| The exact length of each title | Yes | The title is stored with only one byte of padding. See [Sizes](#sizes). |
| The size of note text | Roughly | Short text is padded to steps of 1 KiB, and larger pieces to coarser steps. Text over 16 KiB can be split into pieces at points that do not depend on a key. See [Sizes](#sizes). |
| Which notes and notebooks are deleted | Yes | The deleted mark is not encrypted. Deleting a note adds a deleted version and keeps the earlier ones. See [Deleting](#deleting). |
| Members and invitations | Yes | Usernames, access levels, and who invited whom. |
| When you use Notes | Partly | See [Timing and logs](#timing-and-logs). |
| Your searches | No | The web app searches notes it has already decrypted in your browser. |
| Your exported files | No | The file is made in your browser. The export first lists your notebooks and notes from the server again, so the server sees those requests. |

## IDs and versions

- Note text is stored in pieces, each with a keyed hash as its ID: a fingerprint made with the note's key, which the server does not have. The server cannot test guesses with it, but it sees when a piece matches one in an earlier version, as when a save changes only the title.
- The web app saves 1.5 seconds after you stop typing, and at once when you switch notes or hide the tab. Each save that changes a note is a new version, so one writing session can add many. The server sees their order, their timing, and changes in title length and padded text size.
- In the web app, a move creates a copy with a new ID and deletes the original, so the server sees one note appear as another is deleted.

## Sizes

- Note text, and each piece of a long note, is padded to steps of 1 KiB (1,024 bytes) up to 32 KiB, so a 300-byte note and a 900-byte note look the same. Pieces between 32 KiB and 64 KiB are padded to steps of 2 KiB.
- Text over 16 KiB can be split into padded pieces, and text over 64 KiB always is. The split points come from the text alone, with no key, so the same long text is split at the same points, into pieces of the same sizes, in any account. The server sees how many pieces a note has and how large each one is.
- A note with no text has no stored piece, so the server can tell that it is empty.
- The title and last-edited time are encrypted together with only one byte of padding. The stored size is therefore the exact length of the title in bytes plus a nearly fixed number of bytes, in every version, so the server can work out how long each title is. A notebook's name and description work the same way.

## Deleting

- A deleted note keeps its ID. Its newest version is marked deleted and has no text (the web app keeps the encrypted title in it; Android blanks it when it can read the metadata). Earlier versions stay with their encrypted text, so deleting a note does not remove it from the server.
- The mark is not encrypted, so the server can tell which notes and notebooks are deleted.
- In the web app, a deleted notebook is only marked deleted. Its notes are not marked deleted and keep their encrypted text.

## Sharing

- The server knows who created each notebook, its members and their access levels (read-only, read-write or admin), and each invitation's sender, recipient, notebook and access level. Members' copies of the notebook key, and the key inside an invitation, are encrypted.
- When you invite someone, the server sees the username or email address you looked up. When you accept, it stores your account's type value for that notebook, so it learns that your value and the sender's mean the same type.

## Timing and logs

The database stores no dates or times for collections, notes, versions, members or invitations. The server still learns when things happen:

- By default, note text is stored as files in folders named by the notebook owner's account number (the internal number the server gives each account) and notebook ID, and file systems record when each file was written.
- Each sign-in session stores when it was created, and its expiry moves forward when it is used (at most once a minute), which shows roughly when each device was last active.
- The open web app checks for changes about every 30 seconds. On Android, opening the Notes screen starts a sync when the automatic network settings allow it.
- The server image logs each request: client address, method, path with query string, and status. Paths contain notebook and note IDs, and query strings contain sync positions, markers of how far your device has synced. Text pieces travel in request bodies, which this log does not record.
- Sharing puts usernames in the log: the invite lookup has the username or email address in its query string, and changing a member's access puts their username in the path.
- A reverse proxy in front of the server can keep its own log, often with your browser's user agent. For the hosted service, see the [privacy policy](https://silentsuite.io/privacy).

## If you self-host

Behind a proxy listed in `TRUSTED_PROXY_IPS`, the server logs the device address that the proxy reports. Its own messages hold no note data; a missing-file warning names a path with the account number and notebook ID. Deleting an account in the admin panel removes it and the notebooks it owns (not notes it wrote in other people's notebooks), and encrypted files can stay in the media volume (see [Admin Dashboard](../self-hosting/admin-dashboard.md#delete-a-user)). The Umbrel app turns off the server's request log and its own router's access log. Requests still pass through Umbrel's app proxy, whose logs SilentSuite does not control.

## The web app's host

- The web app's host, such as app.silentsuite.io, does not relay Notes requests. They go from your browser to the sync server, also when you use your own server.
- The host can log your address, your browser and the pages you load, such as `/notes`, as web servers do.
- On app.silentsuite.io, error reports go through the host's `/api/error` relay to the error tracker, without your address or full browser user agent. They hold an error type, a fixed code such as "sync notes failed", the page, the browser family and code positions, and no message or note data.
- Analytics events run only on the sign-in, sign-up and subscription pages. The Android app has no crash reporter.

## On your device

The web app's offline cache and queue of offline edits, and Android's store of unsynced changes, stay on your device with note content encrypted. **Report a problem** sends only what you type and fixed diagnostic values ([Reporting a Problem](./reporting-a-problem.md)).

## Your account

The server also stores account data that is not part of Notes: your username (your email address), email address, public keys, salt (a random value used with your password to make your keys), encrypted account data, sign-up time and last sign-in. On the hosted service, billing gets your username and email address, and nothing from Notes.

## How this page was checked

It comes from the SilentSuite code, except where it describes other tools: the log format (uvicorn), sign-up and sign-in times (Django), the web host's page log (Next.js), file system times and proxy logs.
