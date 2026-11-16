# What the Server Sees in Notes

Note titles, note text and notebook names are encrypted on your device, and the server has no key to read them. It still sees some facts about your notes, listed here.

"The server" is the sync server your account uses: the hosted one, or your own if you self-host. Calendars, task lists, address books and notebooks are all collections.

## At a glance

| What | Can the server read it? | Why |
|---|---|---|
| Note titles | No | They are in encrypted metadata. |
| Last-edited times | Not the stored value | It is encrypted, but the server sees when each save arrives. |
| Note text | No | It is encrypted content. |
| Notebook names, colors and descriptions | No | They are in encrypted metadata. |
| Which collections are notebooks | Yes, in practice | The type is an opaque value, a code the server cannot decode, but all your notebooks share it and the apps list notebooks after the other types. |
| Note and notebook IDs | Yes | Random IDs made on your device, with none of your text. They appear in request addresses. |
| How many notebooks and notes you have | Yes | Each note is a separate item. |
| How many times each note was saved | Yes | Each save adds a version, and earlier versions are kept. |
| The order of changes | Yes | Each change gets a number from a rising counter. |
| The length of each title | Yes | Metadata gets only one byte of padding. |
| The size of note text | Roughly | Text is padded before encryption. |
| Which notes and notebooks are deleted | Yes | The deleted mark is not encrypted. |
| Members and invitations | Yes | Usernames, access levels, and who invited whom. |
| When you use Notes | Partly | See [Timing and logs](#timing-and-logs). |
| Searches and exported files | No | Both run on your device. |

## IDs and versions

- Note text is stored in pieces, each with a keyed hash as its ID: a fingerprint made with the note's key, which the server does not have. The server cannot test guesses with it, but it sees when a piece matches one in an earlier version, as when a save changes only the title.
- The web app saves 1.5 seconds after you stop typing, and each save is a new version, so one writing session can add many. The server sees their order, their timing, and changes in title length and padded text size.
- In the web app, a move creates a copy with a new ID and deletes the original, so the server sees one note appear as another is deleted.

## Sizes

- Note text is padded to steps of 1 KiB (1,024 bytes), so a 300-byte note and a 900-byte note look the same.
- Text over 16 KiB is usually split into padded pieces at points that depend only on the text, not on a key, so the same long text gives the same piece sizes in any account. The server sees how many pieces a note has.
- A note with no text has no stored piece, so the server can tell that it is empty.
- The title and last-edited time are encrypted together with one byte of padding, so the stored size is the title's length in bytes plus a few bytes that barely vary, in every version. A notebook's name and description work the same way.

## Deleting

- A deleted note keeps its ID. Its newest version is marked deleted and has no text (the web app keeps the encrypted title in it; Android blanks it), and earlier versions stay, encrypted.
- In the web app, a deleted notebook is marked deleted. It and its notes stay on the server, encrypted.

## Sharing

- The server knows who created each notebook, its members and their access levels (read-only, read-write or admin), and each invitation's sender, recipient, notebook and access level. Members' copies of the notebook key, and the key inside an invitation, are encrypted.
- When you invite someone, the server sees the username or email address you looked up. When you accept, it stores your account's type value for that notebook, so it learns that your value and the sender's mean the same type.
- When a member leaves or is removed, the server deletes the membership and keeps a record that it ended.

## Timing and logs

The database stores no dates or times for collections, notes, versions, members or invitations. The server still learns when things happen:

- By default, note text is stored as files in folders named by the notebook owner's account number (the internal number the server gives each account) and notebook ID, and file systems record when each file was written.
- Each sign-in session stores when it was created, and its expiry moves forward when it is used (at most once a minute), which shows roughly when each device was last active.
- The open web app checks for changes about every 30 seconds. On Android, opening the Notes screen starts a sync when the automatic network settings allow it.
- The server image logs each request: client address, method, path with query string, and status. Paths contain notebook and note IDs, and query strings contain sync positions, markers of how far your device has synced. Text pieces travel in request bodies, which this log does not record.
- Sharing puts usernames in the log: the invite lookup has the username or email address in its query string, and removing a member or changing their access puts their username in the path.
- A reverse proxy in front of the server can keep its own log, often with your browser's user agent. For the hosted service, see the [privacy policy](https://silentsuite.io/privacy).

## If you self-host

Behind a proxy listed in `TRUSTED_PROXY_IPS`, the server logs the device address that the proxy reports. Its own messages hold no note data; a missing-file warning names a path with the account number and notebook ID. Deleting an account in the admin panel removes it and the notebooks it owns (not notes it wrote in other people's notebooks), and encrypted files can stay in the media volume (see [Admin Dashboard](../self-hosting/admin-dashboard.md#delete-a-user)). The Umbrel app turns off the server's request log and its own router's access log. Requests still pass through Umbrel's app proxy, whose logs SilentSuite does not control.

## The web app's host

- The web app's host, such as app.silentsuite.io, does not relay Notes requests. They go from your browser to the sync server, also when you use your own server.
- The host can log your address, your browser and the pages you load, such as `/notes`, as web servers do.
- On app.silentsuite.io, error reports go through the host's `/api/error` relay to the error tracker, without your address or browser. They hold an error type, a fixed code such as "sync notes failed", the page, the browser family and code positions, and no message or note data.
- Analytics events run only on the sign-in, sign-up and subscription pages. The Android app has no crash reporter.

## On your device

The web app's offline cache and queue of offline edits, and Android's store of unsynced changes, stay on your device with note content encrypted. **Report a problem** sends only what you type and fixed diagnostic values ([Reporting a Problem](https://docs.silentsuite.io/user-guide/reporting-a-problem)).

## Your account

The server also stores account data that is not part of Notes: your username (your email address), email address, public keys, salt (a random value used with your password to make your keys), encrypted account data, sign-up time and last sign-in. On the hosted service, billing gets your username and email address, and nothing from Notes.

## How this page was checked

It comes from the SilentSuite code, except where it describes other tools: the log format (uvicorn), sign-up and sign-in times (Django), the web host's page log (Next.js), file system times and proxy logs.
