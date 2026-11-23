# Notes

Your notes live at [app.silentsuite.io/notes](https://app.silentsuite.io/notes). Title and body are encrypted on your device before sync.

Notes use the [Etebase Markdown notes](https://docs.etebase.com/type-specs/notes) collection type (`etebase.md.note`), so existing EteSync Notes notebooks on the same account appear in SilentSuite without conversion.

Notes is an experimental feature. You can create and edit notes in the web app, including mobile browsers, and in the Android app once you turn Notes on for your account there. If the same note changes in two places, SilentSuite does not overwrite either version. In the web app, a save that conflicts is refused: the editor shows **Not saved**, keeps your text and says why. **Save as a copy** saves your text as a new note in the same notebook, with a title that ends in "(conflicted copy)", and opens it; the other version stays as it is. **Show newer version** shows the other version, read-only, and changes nothing in your text; the note's row in the list then shows that version too. An edit made offline that conflicts is not sent when you reconnect. It stays in this browser, and a banner says it was not saved to the server because the note changed somewhere else after your edit, with **Retry** and **Discard** buttons. The same banner lists text whose save was refused online. Android keeps both: the other version stays, and your text becomes a separate note whose title ends in "(conflicted copy)". Other apps that use the same notes format may overwrite a newer version without warning, so avoid editing the same note in SilentSuite and in another app at the same time.

## Notebooks

Notes are grouped into notebooks. Each notebook is its own encrypted collection, and you can share one the same way you share a calendar or task list.

Notes is off by default. Turn on **Settings → Experimental → Enable Notes** to show it in navigation. This choice is remembered for your account in this browser, not synced to other devices. Turning it off hides Notes without deleting notes or stopping existing sync.

If your account has no notebooks yet, SilentSuite creates a **Personal Notes** notebook when you enable Notes, not on sign-in.

- With more than one notebook, a row of notebook chips above the list narrows it. **All** shows every visible notebook, and each row then names its notebook.
- The menu below a note's title shows its notebook's name; choose another notebook there to move the note. The note keeps its text and its last-edited time.
- New notes go to the notebook the list is narrowed to. With **All** selected they go to the starred default notebook, or, if none is starred, to the notebook of the note you are reading, or else to the first notebook by name. The **New note** button's tooltip names the target.
- Rename, recolour, star, show or hide, and delete notebooks from the sidebar. When the sidebar is collapsed, the folder button next to **New note** opens it; on a phone it opens the notebooks sheet.
- Deleting a notebook removes it and every note in it from your apps. The server keeps them, encrypted; see [What the Server Sees in Notes](./notes-server-sees.md#deleting). The confirmation says how many notes that is. On the web, the notebook is not deleted while a note in it has changes that are not on the server yet (such as a note marked **Not saved**), or while this browser cannot confirm that it shows everything in it (for example after a change on another device, or for a note just moved there); a message says which, and nothing is deleted.

## Create a Note

1. Click **New note**.
2. The cursor starts in the title. Type a title, then write the body in Markdown (or plain text).
3. Changes save automatically after a short pause, when you switch notes, and when you leave the page. The note is encrypted in your browser and synced.

## Editor

The editor highlights Markdown as you type, continues lists and quotes when you press Enter, and keeps an undo history that survives switching to the preview and back. Tab and Shift+Tab indent and outdent list items. To move keyboard focus out of the editor, press Escape and then Tab, or press Ctrl+M (Shift+Alt+M on macOS) to make Tab move focus until you press it again. Press Ctrl+F (Cmd+F on macOS) to find or replace text inside the note. What you type is stored exactly as written; nothing is reformatted. Browser spellcheck, autocorrect, and writing suggestions are turned off in the editor, because those features can send your text to third-party services.

While you type, a label next to the editor shows **Unsaved changes**, **Saving**, **Saved**, or **Not saved**. **Not saved** means the last save failed, for example while offline without local storage, or was refused because the note changed somewhere else. Text that was not saved stays in this browser when you switch notes or leave Notes, and comes back when you open the note again. Text whose save was refused or failed is also kept, encrypted, in this browser's offline storage for your account, so it comes back after you reload or close the tab. Refused text comes back with **Save as a copy**; text whose save failed is saved again when you open the note. If **Save as a copy** finds that an earlier version of the copy already reached the server, your newer text goes onto the copy and is kept the same way until it is saved there. If the copy was changed somewhere else before this browser could confirm that your latest text reached it, **Save as a copy** says so and keeps your text, and the next **Save as a copy** makes a new copy. Reopened this way, the text counts as unsaved until it is saved or copied. This happens even where the encrypted local cache is turned off, and the key that encrypts it is stored with it in this browser's profile, so while you are signed in, anyone who can use this browser profile, or who has a copy of its files, can read it. Logging out deletes it, and so does being signed out because your session ended. Text the browser has not stored yet, such as typing in the last moments before the tab closes, is lost when the tab closes or reloads; the page asks the browser to confirm first, but not every browser shows that question. A note whose last save is still running opens read-only until that save ends.

Logging out deletes this browser's offline storage. Before it does, **Log out** in the menu at the top right, and **Sign out of this device** in Security settings on a self-hosted server, count the changes that are only on this device: edits waiting to sync, changes that failed or are held, and note text that was not saved in that tab. If there are any, or if they cannot be counted, the app says how many and offers **Sync now**, **Cancel**, and **Log out and delete**, which asks once more before deleting them. Being signed out because your session ended still deletes them without asking.

## Search

The search box above the list matches note titles and text, within the notebook the list is narrowed to. It runs on your device over notes that are already decrypted, so nothing about your search or your notes is sent to the server. Hidden notebooks are not searched.

## Preview Markdown

Click **Preview** to render the body, and click it again to return to editing. Standard Markdown is supported: headings, lists, links, code blocks, quotes, tables, task lists (`- [ ]` and `- [x]`), and strikethrough (`~~text~~`). Task list checkboxes are read-only in the preview; to check or clear one, change the `[ ]` or `[x]` in the text. Only links to web addresses (`http://` and `https://`) and to email addresses (`mailto:`) are live; any other link is shown as its text. A web address or email address typed as plain text stays text; put it in angle brackets, as in `<https://example.com>`, to make it a link. A note nested more than about 100 levels deep is shown as plain text instead of rendered. So is a note whose tables hold more than 10,000 cells in all (the header row counts, and every row counts as wide as the table's header, so 500 columns and 21 rows is over the limit even when most cells are empty). Raw HTML inside a note is shown as text, never executed. Images are never loaded in Markdown previews, so opening a note cannot leak your reading to the servers the images come from.

## Edit a Note

Select the note in the list (newest edits first; each row shows when it was last edited) and change the title or body. The title is stored in the encrypted item metadata, the body in the encrypted item content.

## Delete a Note

Open the note, click **Delete** in the row below the title, and confirm. The deletion syncs to your other devices.

On Android, open the note, open the menu in the top bar and choose **Delete note**, then confirm. If the note has text on this device that has not synced, a second confirmation asks before that text is discarded. If another window of this note saved text that this screen has not shown yet, nothing is deleted: the note reloads to show it, and you can delete it again. The note leaves the list at once and is deleted on the server at the next sync, which follows the same network settings as a save. A note that never synced is only removed from this device; if it is the copy of a synced note you moved there, and the move has not synced yet, the original in its old notebook is deleted on the server at the next sync. If another device changed the note before the delete reached the server, or the notebook became read-only for you, the note is not deleted: it shows again, with the other device's change, and the notebook list says why until you dismiss the message.

## Move a Note

In the web app, choose another notebook in the menu below the note's title, which shows the note's notebook. It needs a connection.

On Android, open the note, open the menu in the top bar and choose **Move to notebook**, then tap a notebook. Only notebooks you can write to are listed, and notebooks other people share with you are marked as shared, unless they gave you **Admin** access. The note opens in its new notebook at once, also offline, and the move is sent at the next sync, which follows the same network settings as a save. The note's text, including text that has not synced yet, its title, its last-edited time and anything else another app stored with it go across unchanged. If SilentSuite finds that the note changed after the screen showed it, nothing is moved: a message says so, and the note shows as it is now, so you can check it and move it again.

A note cannot change notebooks on the server, so a move creates the note again in the other notebook and then deletes the original. Other devices see the note appear in the new notebook and leave the old one, and its revision history starts over. The original is deleted only after this device has checked that the server has the new note, in a notebook that is still there, so a move that stops halfway does not by itself leave the note in neither notebook; at worst the note shows in both. If the new notebook does not take the note, for example because it became read-only for you before the move reached the server, the moved text is kept under **Unsynced text**, and a note that had synced before shows in its old notebook again. If another device changed the note before the move reached the server, or its old notebook became read-only for you, the note stays in both notebooks. If that notebook became read-only after this device had already sent the original's delete, the notebook list says instead that the note may already be deleted in its old notebook. If, before that check, another device deleted the note in its new notebook, the note stays in its old notebook as it last synced there, and changes it had not synced before the move went with the deleted copy. If the new notebook was deleted, or you lost access to it, the note also stays in its old notebook as it last synced there, and the text it had in the new notebook, those changes included, is kept under **Unsynced text**. The exception is access lost after this device sent the copy and before it checked it: those changes are then only in the new notebook, which you can no longer open. If any of this happened after this device had already sent the original's delete, the note may already be deleted in its old notebook too, so the notebook list says to check it there; text kept under **Unsynced text** stays there. The notebook list says why until you dismiss the message. One case gets no message: if another device deletes the note or its new notebook, or you lose access to that notebook, in the moment between this device's check and the original's delete, the original is deleted too, and the note is in neither notebook.

## Offline

Edits made while offline to a note that is already open are encrypted locally and replayed when you reconnect, unless the note changed somewhere else in the meantime; then your edit stays in this browser and is not sent. In the web app, creating a brand-new note, moving one to another notebook, or saving one as a copy requires a connection. On Android, a move works offline and is sent at the next sync.

Reloading the page while offline and reading previously opened notes depends on how the deployment is configured: it needs the encrypted local cache to be enabled, and it only covers notes already loaded on that device. Where the cache is not enabled, an offline reload cannot show your notes.

In the web app, **New note** and the notebook picker in the editor are turned off while you are offline, and the page says why. They turn on again when the connection returns.

## Sharing

Share a notebook from **Settings → Sharing**. Members see the same notebook, end-to-end encrypted to the public keys you confirm. Before you share or accept, compare security fingerprints with each person over a separate channel, such as in person or on a call; the server supplies usernames and keys, so an unverified fingerprint gives no assurance about who receives access. Read-only members can read notes but cannot change them. See [what happens when you remove a member](./collections.md#removing-a-member).

## Export

In the web app, **Settings → Export** saves notes as Markdown files in a `.zip`, with one folder per notebook and one `.md` file per note. Pick one notebook or **All notebooks**, which includes hidden notebooks. **Export All Data (.zip)** puts the same folders under `silentsuite-notes/`, next to your calendars, tasks, and contacts. Notes are included whenever your account has a notebook, even while Notes is turned off under **Settings → Experimental**.

Each file starts with a YAML header (frontmatter) holding the note's `title` and `modified` (when it was last edited), followed by the body exactly as stored. A note without a title is saved as `Untitled.md`, and its header has no `title`. In file names, characters that file systems refuse, such as `/` and `:`, and look-alikes of `/` and `\` become `_`, invisible characters are removed, names Windows reserves, such as `CON`, get a leading `_`, and titles longer than 60 bytes (60 unaccented letters, or 20 Chinese or Japanese characters) are cut. Notes with the same title get a number, such as `Ideas (2).md`. The header keeps the full title.

The export lists your notebooks and notes from the server again, so it needs a connection, and decrypts every note in your browser: no note title, text, or notebook name is sent anywhere. A note that cannot be decrypted is left out, and the page says how many were left out. Changes to notes that are still waiting to sync on this device are not included until they sync. The `.zip` itself is not encrypted, so anyone who gets the file can read your notes.

## Not in this release

The DAV bridge, attachments, importing notes, and rich-text editing are not available yet. Use Markdown in the web app for now.

## What the server can see

Note titles, note text and notebook names are encrypted, but the server still sees some facts, such as how many notes you have, how often each one was saved, and who is in a shared notebook. [What the Server Sees in Notes](./notes-server-sees.md) lists them.
