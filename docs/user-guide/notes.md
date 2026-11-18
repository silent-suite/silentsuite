# Notes

Your notes live at [app.silentsuite.io/notes](https://app.silentsuite.io/notes). Title and body are encrypted on your device before sync.

Notes use the [Etebase Markdown notes](https://docs.etebase.com/type-specs/notes) collection type (`etebase.md.note`), so existing EteSync Notes notebooks on the same account appear in SilentSuite without conversion.

Notes is an experimental feature. You can create and edit notes in the web app, including mobile browsers, and in the Android app once you turn Notes on for your account there. If the same note changes in two places, SilentSuite does not overwrite either version. In the web app, a save that conflicts is refused: the editor shows **Not saved**, keeps your text and says why. **Save as a copy** saves your text as a new note in the same notebook, with a title that ends in "(conflicted copy)", and opens it; the other version stays as it is. **Show newer version** shows the other version, read-only, and changes nothing in your text; the note's row in the list then shows that version too. An edit made offline that conflicts is not sent when you reconnect. It stays in this browser, and a banner says it was not saved to the server because the note changed somewhere else after your edit, with **Retry** and **Discard** buttons. The same banner lists text whose save was refused online. Android keeps both: the other version stays, and your text becomes a separate note whose title ends in "(conflicted copy)". Other apps that use the same notes format may overwrite a newer version without warning, so avoid editing the same note in SilentSuite and in another app at the same time.

## Notebooks

Notes are grouped into notebooks. Each notebook is its own encrypted collection, and you can share one the same way you share a calendar or task list.

Notes is off by default. Turn on **Settings → Experimental → Enable Notes** to show it in navigation. This choice is remembered for your account in this browser, not synced to other devices. Turning it off hides Notes without deleting notes or stopping existing sync.

If your account has no notebooks yet, SilentSuite creates a **Personal Notes** notebook when you enable Notes, not on sign-in.

- With more than one notebook, a row of notebook chips above the list narrows it. **All** shows every visible notebook, and each row then names its notebook.
- The **Notebook** menu below a note's title moves the note to another notebook. The note keeps its text and its last-edited time.
- New notes go to the notebook the list is narrowed to. With **All** selected they go to the starred default notebook, or, if none is starred, to the notebook of the note you are reading, or else to the first notebook by name. The **New note** button's tooltip names the target.
- Rename, recolour, star, show or hide, and delete notebooks from the sidebar. When the sidebar is collapsed, the folder button next to **New note** opens it; on a phone it opens the notebooks sheet.
- Deleting a notebook deletes every note in it. The confirmation says how many notes that is. On the web, the notebook is not deleted while a note in it has changes that are not on the server yet (such as a note marked **Not saved**), or while this browser cannot confirm that it shows everything in it (for example after a change on another device, or for a note just moved there); a message says which, and nothing is deleted.

## Create a Note

1. Click **New note**.
2. The cursor starts in the title. Type a title, then write the body in Markdown (or plain text).
3. Changes save automatically after a short pause, when you switch notes, and when you leave the page. The note is encrypted in your browser and synced.

## Editor

The editor highlights Markdown as you type, continues lists and quotes when you press Enter, and keeps an undo history that survives switching to the preview and back. Tab and Shift+Tab indent and outdent list items. To move keyboard focus out of the editor, press Escape and then Tab, or press Ctrl+M (Shift+Alt+M on macOS) to make Tab move focus until you press it again. Press Ctrl+F (Cmd+F on macOS) to find or replace text inside the note. What you type is stored exactly as written; nothing is reformatted. Browser spellcheck, autocorrect, and writing suggestions are turned off in the editor, because those features can send your text to third-party services.

While you type, a label next to the editor shows **Unsaved changes**, **Saving**, **Saved**, or **Not saved**. **Not saved** means the last save failed, for example while offline without local storage, or was refused because the note changed somewhere else. Text that was not saved stays in this browser when you switch notes or leave Notes, and comes back when you open the note again. Text whose save was refused is also kept, encrypted, in this browser's offline storage for your account, so it comes back after you reload or close the tab, with **Save as a copy**; reopened this way, it counts as unsaved until it is saved or copied. Other text that was not saved, such as text whose save failed with an error, is lost when the tab closes or reloads; the page asks the browser to confirm first, but not every browser shows that question. A note whose last save is still running opens read-only until that save ends.

Logging out deletes this browser's offline storage. Before it does, **Log out** counts the changes that are only on this device: edits waiting to sync, changes that failed or are held, and note text that was not saved. If there are any, or if they cannot be counted, it says how many and offers **Sync now**, **Cancel**, and **Log out and delete**, which asks once more before deleting them.

## Search

The search box above the list matches note titles and text, within the notebook the list is narrowed to. It runs on your device over notes that are already decrypted, so nothing about your search or your notes is sent to the server. Hidden notebooks are not searched.

## Preview Markdown

Click **Preview** to render the body, and click it again to return to editing. Standard Markdown is supported: headings, lists, links, code blocks, quotes. Raw HTML inside a note is shown as text, never executed. Images are never loaded in Markdown previews, so opening a note cannot leak your reading to the servers the images come from.

## Edit a Note

Select the note in the list (newest edits first; each row shows when it was last edited) and change the title or body. The title is stored in the encrypted item metadata, the body in the encrypted item content.

## Delete a Note

Open the note, click **Delete** in the row below the title, and confirm. The deletion syncs to your other devices.

On Android, open the note, open the menu in the top bar and choose **Delete note**, then confirm. If the note has text on this device that has not synced, a second confirmation asks before that text is discarded. The note leaves the list at once and is deleted on the server at the next sync, which follows the same network settings as a save. A note that never synced is only removed from this device. If another device changed the note before the delete reached the server, or the notebook became read-only for you, the note is not deleted: it shows again, with the other device's change, and the notebook list says why until you dismiss the message.

## Offline

Edits made while offline to a note that is already open are encrypted locally and replayed when you reconnect, unless the note changed somewhere else in the meantime; then your edit stays in this browser and is not sent. Creating a brand-new note, moving one to another notebook, or saving one as a copy requires a connection.

Reloading the page while offline and reading previously opened notes depends on how the deployment is configured: it needs the encrypted local cache to be enabled, and it only covers notes already loaded on that device. Where the cache is not enabled, an offline reload cannot show your notes.

In the web app, **New note** and the notebook picker in the editor are turned off while you are offline, and the page says why. They turn on again when the connection returns.

## Sharing

Share a notebook from **Settings → Sharing**. Members see the same notebook, end-to-end encrypted to the public keys you confirm. Before you share or accept, compare security fingerprints with each person over a separate channel, such as in person or on a call; the server supplies usernames and keys, so an unverified fingerprint gives no assurance about who receives access. Read-only members can read notes but cannot change them.

## Export

In the web app, **Settings → Export** saves notes as Markdown files in a `.zip`, with one folder per notebook and one `.md` file per note. Pick one notebook or **All notebooks**, which includes hidden notebooks. **Export All Data (.zip)** puts the same folders under `silentsuite-notes/`, next to your calendars, tasks, and contacts. Notes are included whenever your account has a notebook, even while Notes is turned off under **Settings → Experimental**.

Each file starts with a YAML header (frontmatter) holding the note's `title` and `modified` (when it was last edited), followed by the body exactly as stored. A note without a title is saved as `Untitled.md`, and its header has no `title`. In file names, characters that file systems refuse, such as `/` and `:`, and look-alikes of `/` and `\` become `_`, invisible characters are removed, names Windows reserves, such as `CON`, get a leading `_`, and titles longer than 60 bytes (60 unaccented letters, or 20 Chinese or Japanese characters) are cut. Notes with the same title get a number, such as `Ideas (2).md`. The header keeps the full title.

The export lists your notebooks and notes from the server again, so it needs a connection, and decrypts every note in your browser: no note title, text, or notebook name is sent anywhere. A note that cannot be decrypted is left out, and the page says how many were left out. Changes to notes that are still waiting to sync on this device are not included until they sync. The `.zip` itself is not encrypted, so anyone who gets the file can read your notes.

## Not in this release

Moving notes on Android, the DAV bridge, attachments, importing notes, and rich-text editing are not available yet. Use Markdown in the web app for now.
