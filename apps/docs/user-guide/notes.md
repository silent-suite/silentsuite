# How to Manage Your Notes

Your notes are end-to-end encrypted: the server stores them encrypted and cannot read them. Only your devices can, and people you share a notebook with can read the notes in that notebook.

Notes is an experimental feature and is off by default. You can use it in the web app, including in a phone's browser, and in the Android app. Most of this page describes the web app; [Notes on Android](./apps/android.md#notes-experimental) covers the Android app.

Notes use the [Etebase Markdown notes](https://docs.etebase.com/type-specs/notes) collection type (`etebase.md.note`), so existing EteSync Notes notebooks on the same account appear in SilentSuite without conversion.

## Turn On Notes

1. Open **Settings → Experimental**.
2. Turn on **Enable Notes**. The switch becomes available once your account has finished syncing.
3. Open **Notes** from the navigation.

The setting is remembered for your account in this browser only, so turn it on in each browser where you want Notes. While it is off, the Notes page shows **Notes is experimental** with an **Open Experimental settings** link.

If your account has no notebooks yet, turning on Notes creates one named **Personal Notes**. No notebook is created when you sign in.

Turning Notes off hides it again. It does not delete notes or stop them from syncing.

## Notebooks

Notes are grouped into notebooks. Each notebook is its own encrypted collection, and you can share one the same way you share a calendar or task list.

- With more than one visible notebook, a row of notebook chips above the list narrows it. **All** shows every visible notebook, and each row then names its notebook.
- The sidebar lists your notebooks. To create one, select the **+** button (**Add notebook**) next to the **Notebooks** heading. Select a notebook's name or color square to show or hide it. Its actions menu has **Rename**, **Set as default**, **Change color**, and **Delete notebook**. The default notebook is marked with a star.
- When the sidebar is collapsed, the folder button next to **New note** opens it. On a phone, that button opens the notebooks sheet.
- A notebook's name and color sync to your other devices. Which notebooks are hidden, and which one is the default, is kept in this browser only: until you log out if you chose "Keep me signed in on this device" or use a self-hosted server, and otherwise only in the current tab.

### Delete a Notebook

Deleting a notebook removes it and every note in it from your apps. The server keeps them, encrypted; see [What the Server Sees in Notes](./notes-server-sees.md#deleting). The confirmation says how many notes the notebook holds.

- You cannot delete your last notebook. Create another one first.
- Only an admin of a shared notebook can delete it. For other members, **Delete notebook** is turned off; they can leave the notebook instead, with **Leave collection** in **Settings → Sharing**.
- The web app does not delete a notebook while a note in it has changes that are not on the server yet, such as a note marked **Not saved**. It also refuses while this browser cannot confirm that it shows everything in the notebook, for example after a change on another device or for a note just moved there. In both cases a message says why, and nothing is deleted.
- Deleting a notebook needs a connection.

## Create a Note

1. Open **Notes**.
2. Select **New note**. The new note is titled "Untitled", with the title selected, so you can type a title over it.
3. Write the body in Markdown or plain text.

The note saves automatically (see [Saving](#saving)). Creating a note needs a connection.

New notes go to the notebook the list is narrowed to. With **All** selected, they go to the default notebook, or, if there is none, to the notebook of the note you are reading, or else to the first notebook by name. Hidden and read-only notebooks are skipped. The **New note** button's tooltip names the notebook.

## Edit a Note

Select a note in the list to open it. The list shows the most recently edited notes first, and each row shows when its note was last edited.

The editor highlights Markdown as you type and continues lists and quotes when you press Enter. Tab and Shift+Tab indent and outdent the current line or the selected lines. The undo history survives switching to the preview and back. Press Ctrl+F (Cmd+F on macOS) to find or replace text inside the note.

Because Tab indents, moving keyboard focus out of the editor takes an extra step: press Escape and then Tab within two seconds, or press Ctrl+M (Shift+Alt+M on macOS) to make Tab move focus until you press it again.

The editor stores your text as you typed it and does not reformat it. The one exception is pasting an address that starts with `http://`, `https://`, `www.`, `mailto:` or `xmpp:` while plain text is selected: the selection becomes a Markdown link to that address, and a `www.` address gets `https://` in front.

Browser spellcheck is turned off in the title and the body, and autocorrect and writing suggestions are turned off in the body, because those features can send your text to third-party services. For the same reason, the note list, the body, and the preview ask the browser not to translate them. Notebook names in the sidebar, the notebook chips and the notebook menu are not marked this way.

Notes in a read-only notebook open read-only and have no **Delete** button. On the hosted service, notes also open read-only, and **New note** is turned off, while your account has no active subscription.

## Move a Note

In the web app, the notebook menu below the note's title shows which notebook the note is in. Choose another notebook there to move the note. The menu lists the notebooks you can write to that are not hidden, and it is turned off for a read-only note or when there is no other such notebook. The note keeps its text and its last-edited time. Moving needs a connection.

In the Android app, open the note, open the menu in the top bar, and choose **Move to notebook**. A move there works offline and is sent at the next sync. [Notes on Android](./apps/android.md#move-a-note) says what happens when something gets in the way, such as a change on another device.

A note cannot change notebooks on the server, so a move creates the note again in the other notebook and then deletes the original. Other devices see the note appear in the new notebook and leave the old one, and its revision history starts over.

## Saving

Changes save automatically 1.5 seconds after you stop typing, when you switch to another note or leave Notes, and when the browser tab is hidden, for example when you switch tabs. Each save is encrypted on your device before it is sent.

A label next to the editor shows **Unsaved changes**, **Saving…**, **Saved**, or **Not saved**, and **Saved as a copy** on a note that **Save as a copy** just made. **Not saved** means the last save failed, for example while offline without local storage, or was refused because the note changed somewhere else (see [When a Note Changes in Two Places](#when-a-note-changes-in-two-places)).

### Text That Was Not Saved

Text that was not saved stays in this browser when you switch notes or leave Notes, and comes back when you open the note again. Text whose save was refused or failed is also kept, encrypted, in this browser's offline storage for your account, so it comes back after you reload or close the tab. Refused text comes back with **Save as a copy**; text whose save failed is saved again when you open the note. Reopened this way, the text counts as unsaved until it is saved or copied.

This does not depend on the encrypted local cache described under [Offline](#offline). The key that encrypts this text is stored with it in this browser's profile, so while you are signed in, anyone who can use this browser profile, or who has a copy of its files, can read it. Logging out deletes it. Being signed out because your session ended deletes it too, once the app notices, which can be the next time you open SilentSuite in this browser.

Text the browser has not stored yet, such as typing in the last moments before the tab closes, is lost when the tab closes or reloads. The page asks the browser to confirm first, but not every browser shows that question.

A note whose last save is still running opens read-only until that save ends.

### Log Out

Logging out deletes this browser's offline storage, and the account key and notebook names the browser keeps while you are signed in ([What a Signed-In Browser Keeps](./encryption-explained.md#what-a-signed-in-browser-keeps) explains where they are kept). Before deleting anything, the app counts the changes that are only on this device: edits waiting to sync, changes that failed or are held, and note text that was not saved in that tab. It does this for **Log out** in the menu at the top right, and for **Sign out of this device** in Security settings on a self-hosted server. If there are any, or if they cannot be counted, the app says how many and offers **Sync now**, **Cancel**, and **Log out and delete**, which asks once more before deleting them. Being signed out because your session ended still deletes them without asking.

## When a Note Changes in Two Places

If the same note changes in two places, SilentSuite does not overwrite either version.

In the web app, a save that conflicts is refused. The editor shows **Not saved**, keeps your text, and says why: the note changed somewhere else after you started editing, or this browser could not confirm that it did not. Two buttons let you decide what to do:

- **Save as a copy** saves your text as a new note in the same notebook, with a title that ends in "(conflicted copy)", and opens it. The other version stays as it is.
- **Show newer version** shows the other version, read-only, and changes nothing in your text. The note's row in the list then shows that version too.

If **Save as a copy** finds that an earlier version of the copy already reached the server, your newer text goes onto the copy and is kept the same way until it is saved there. If the copy was changed somewhere else before this browser could confirm that your latest text reached it, **Save as a copy** says so and keeps your text, and the next **Save as a copy** makes a new copy.

An edit made offline that conflicts is not sent when you reconnect. It stays in this browser, and a banner says it was not saved to the server because the note changed somewhere else after your edit, with **Retry** and **Discard** buttons. The same banner lists text whose save was refused online.

The Android app keeps both versions instead: the other version stays, and your text becomes a separate note whose title ends in "(conflicted copy)". See [Notes on Android](./apps/android.md#conflicts-and-unsynced-text).

Other apps that use the same notes format may overwrite a newer version without warning, so avoid editing the same note in SilentSuite and in another app at the same time.

## Preview Markdown

Select **Preview** to show the note rendered, and select it again to return to editing. On a narrow screen, such as a phone's, **Preview** and **Delete** show as icons only.

The preview supports standard Markdown, such as headings, lists, links, code blocks, and quotes, plus tables, task lists (`- [ ]` and `- [x]`), and strikethrough (`~~text~~`). Task list checkboxes are read-only in the preview; to check or clear one, change the `[ ]` or `[x]` in the text.

Only links to web addresses (`http://` and `https://`) and to email addresses (`mailto:`) are live, and they open in a new tab. Any other link is shown as its text. A web or email address typed as plain text stays text; put it in angle brackets, as in `<https://example.com>`, to make it a link.

Images are never loaded, so opening a note cannot tell the servers the images come from that you read it. In place of an image, the preview shows "Image not shown", followed by the image's description if it has one. Raw HTML inside a note is shown as text, never run.

Some notes are shown as plain text, with a line saying so, instead of formatted:

- A note that is too complex to format quickly: one nested more than about 100 levels deep, one whose tables hold more than 10,000 cells in all, or one that takes too long to format or would produce too many formatted parts, such as a very large note. For the cell count, the header row counts, and every row counts as wide as the table's header, so 500 columns and 21 rows is over the limit even when most cells are empty.
- Every note, in a browser that does not allow web workers.

Open **Preview** again to try again. When a note is plain text only because formatting it took too long or would produce too many parts, or because web workers are not allowed, a **Format anyway** button under the line formats that note on the page; the browser tab may stop responding while it does. A note nested too deeply or with too many table cells stays plain text. If **Format anyway** cannot format a note, Preview remembers it (the last such note only) and shows it as plain text without trying again until the note is edited, the page is reloaded, or you sign out.

The [Notes Markdown profile](https://github.com/silent-suite/silentsuite/blob/main/docs/contributing/notes-markdown.md) gives the exact rules.

## Search

The search box above the list matches note titles and text, within the notebook the list is narrowed to. It runs on your device over notes that are already decrypted, so nothing about your search or your notes is sent to the server. Hidden notebooks are not searched.

## Delete a Note

1. Open the note.
2. Select **Delete** in the row below the title.
3. Confirm with **Delete note**.

The deletion syncs to your other devices. If the note changed somewhere else after this browser loaded it, nothing is deleted and the note stays in the list; no message says why. The server keeps the note's earlier versions, encrypted; see [What the Server Sees in Notes](./notes-server-sees.md#deleting).

In the Android app, open the note, open the menu in the top bar, and choose **Delete note**. See [Notes on Android](./apps/android.md#delete-a-note) for what happens to text that has not synced.

## Offline

Edits made while offline to a note that is already open are encrypted locally and sent when you reconnect, unless the note changed somewhere else in the meantime. Then your edit stays in this browser and is not sent (see [When a Note Changes in Two Places](#when-a-note-changes-in-two-places)). A note you delete while offline leaves the list at once, and the delete is sent when you reconnect. If the note has changes still waiting in this browser, the delete does not happen while you are offline, and no message says why.

In the web app, creating a note, moving one to another notebook, saving one as a copy, and deleting a notebook need a connection. While you are offline, **New note** and the notebook menu in the editor are turned off, and the page says why. They turn on again when the connection returns. In the Android app, a move works offline and is sent at the next sync.

Reloading the page while offline cannot show your notes. That would need the web app's encrypted local cache, which is turned off in SilentSuite's release builds, including app.silentsuite.io and the self-hosted images.

## Sharing

Share a notebook from **Settings → Sharing**. Members see the same notebook, end-to-end encrypted to the public keys you confirm. Before you share or accept, compare security fingerprints with each person over a separate channel, such as in person or on a call. The server supplies usernames and keys, so an unverified fingerprint gives no assurance about who receives access.

Read-only members can read notes but cannot change them. Only an admin can delete a shared notebook (see [Delete a Notebook](#delete-a-notebook)). See also [what happens when you remove a member](./collections.md#removing-a-member).

## Export

In the web app, **Settings → Export** saves notes as Markdown files in a `.zip`, with one folder per notebook and one `.md` file per note. Pick one notebook or **All notebooks**, which includes hidden notebooks. **Export All Data (.zip)** puts the same folders under `silentsuite-notes/`, next to your calendars, tasks, and contacts. Notes are included whenever your account has a notebook, even while Notes is turned off under **Settings → Experimental**. The Android app does not export notebooks yet.

Each file starts with a YAML header (frontmatter) holding the note's `title` and `modified` (when it was last edited), when the note has them, followed by the body exactly as stored. The header keeps the full title, but the file name may not. File names and notebook folder names follow these rules:

- A note whose title is empty, or has nothing left after the rules below, is saved as `Untitled.md`. A notebook folder in the same case is named `Notebook`.
- Characters that file systems refuse, such as `/` and `:`, and look-alikes of `/` and `\` become `_`. Invisible characters are removed.
- Names that Windows reserves, such as `CON`, get a leading `_`.
- Names longer than 60 bytes (60 unaccented letters, or 20 Chinese or Japanese characters) are cut.
- Names that would be the same get a number, such as `Ideas (2).md`.

The export lists your notebooks and notes from the server again, so it needs a connection, and decrypts every note in your browser: no note title, text, or notebook name is sent anywhere. A note that cannot be decrypted is left out, and a message says how many were left out. Changes to notes that are still waiting to sync on that device are not included until they sync. The `.zip` itself is not encrypted, so anyone who gets the file can read your notes.

## Not Available Yet

Attachments, importing notes, rich-text editing, and notes in the [SilentSuite Bridge](./apps/dav-bridge.md) are not available yet. In the Android app, notes are edited without a formatted view and are not part of the export.

## What the Server Can See

Note titles, note text, and notebook names are encrypted, but the server still sees some facts, such as how many notes you have, how often each one was saved, and who is in a shared notebook. [What the Server Sees in Notes](./notes-server-sees.md) lists them.
