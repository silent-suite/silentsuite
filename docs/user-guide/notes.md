# Notes

Your notes live at [app.silentsuite.io/notes](https://app.silentsuite.io/notes). Title and body are encrypted on your device before sync.

Notes use the [Etebase Markdown notes](https://docs.etebase.com/type-specs/notes) collection type (`etebase.md.note`), so existing EteSync Notes notebooks on the same account appear in SilentSuite without conversion.

## Notebooks

Notes are grouped into notebooks. Each notebook is its own encrypted collection, and you can share one the same way you share a calendar or task list.

If your account has no notebooks yet, SilentSuite creates a **Personal Notes** notebook on first sign-in.

- With more than one notebook, a row of notebook chips above the list narrows it. **All** shows every visible notebook, and each row then names its notebook.
- The **Notebook** menu below a note's title moves the note to another notebook. The note keeps its text and its last-edited time.
- New notes go to the notebook the list is narrowed to. With **All** selected they go to the starred default notebook, or, if none is starred, to the notebook of the note you are reading, or else to the first notebook by name. The **New note** button's tooltip names the target.
- Rename, recolour, star, show or hide, and delete notebooks from the sidebar. When the sidebar is collapsed, the folder button next to **New note** opens it; on a phone it opens the notebooks sheet.
- Deleting a notebook deletes every note in it. The confirmation says how many notes that is.

## Create a Note

1. Click **New note**.
2. The cursor starts in the title. Type a title, then write the body in Markdown (or plain text).
3. Changes save automatically after a short pause, when you switch notes, and when you leave the page. The note is encrypted in your browser and synced.

## Editor

The editor highlights Markdown as you type, continues lists and quotes when you press Enter, and keeps an undo history that survives switching to the preview and back. Tab and Shift+Tab indent and outdent list items. To move keyboard focus out of the editor, press Escape and then Tab, or press Ctrl+M (Shift+Alt+M on macOS) to make Tab move focus until you press it again. Press Ctrl+F (Cmd+F on macOS) to find or replace text inside the note. What you type is stored exactly as written; nothing is reformatted. Browser spellcheck, autocorrect, and writing suggestions are turned off in the editor, because those features can send your text to third-party services.

While you type, a label next to the editor shows **Unsaved changes**, **Saving**, **Saved**, or **Not saved**. **Not saved** means the last save failed (for example while offline without local storage); keep the note open or try again.

## Search

The search box above the list matches note titles and text, within the notebook the list is narrowed to. It runs on your device over notes that are already decrypted, so nothing about your search or your notes is sent to the server. Hidden notebooks are not searched.

## Preview Markdown

Click **Preview** to render the body, and click it again to return to editing. Standard Markdown is supported: headings, lists, links, code blocks, quotes. Raw HTML inside a note is shown as text, never executed.

## Edit a Note

Select the note in the list (newest edits first; each row shows when it was last edited) and change the title or body. The title is stored in the encrypted item metadata, the body in the encrypted item content.

## Delete a Note

Open the note, click **Delete** in the row below the title, and confirm. The deletion syncs to your other devices.

## Offline

Edits made while offline are encrypted locally and replayed when you reconnect. Creating a brand-new note or moving one to another notebook requires a connection.

## Sharing

Share a notebook from **Settings → Sharing**. Members see the same encrypted notebook; the server never sees plaintext. Read-only members can read notes but cannot change them.

## Not in this release

Android, the DAV bridge, attachments, import/export, and rich-text editing. Use Markdown in the web app for now.
