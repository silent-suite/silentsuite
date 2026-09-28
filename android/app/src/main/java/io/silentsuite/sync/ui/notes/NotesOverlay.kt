package io.silentsuite.sync.ui.notes

import io.silentsuite.sync.notes.edit.NotePushPolicy
import io.silentsuite.sync.notes.edit.PendingEntry
import io.silentsuite.sync.notes.edit.PendingNotesStore.EntryHeader
import io.silentsuite.sync.notes.edit.PendingNotesStore.Read

/** Whether a note has a local change the server does not have yet. */
enum class NoteSync {
    SYNCED,

    /** A saved local change waiting to be pushed. */
    WAITING,

    /** A local change exists but could not be read here; the server version is shown if there is one. */
    LOCAL_UNREADABLE,

    /**
     * The local text is kept under Unsynced text, because it was held or its notebook is read-only or
     * gone. The server version is shown, and an editor must not open over it: a save there would
     * replace the held text.
     */
    HELD,
}

/**
 * Pending changes laid over the cached server copy for display. Pure, so every rule is tested on the
 * JVM; the loader reads the store and the cache and supplies the decryption.
 *
 * - Only a writable notebook the user can see shows pending text. A held entry, and any entry in a
 *   read-only notebook, leaves the server version in place with a [NoteSync.HELD] marker, and counts
 *   toward the unsynced text the notebook list points to. An entry whose notebook is gone counts there
 *   too, so nothing pending is ever invisible.
 * - A pending edit or create replaces or adds its note's row and is marked. A pending delete hides the
 *   row before the first render (web #746).
 * - A pending edit whose blob cannot be read keeps the server row, or adds a placeholder for a create,
 *   with its own marker. So does a note whose entry file cannot be read at all.
 */
internal object NotesOverlay {

    /** A pending edit as the loader decrypted it. [body] is null when only the preview was kept. */
    data class Decrypted(val title: String, val preview: String, val body: String?, val editedAt: Long?)

    /**
     * A cached notebook as the runner sees it: from the collection itself, without decoding its
     * metadata, so a notebook whose name this client cannot decode is still known here.
     */
    data class NotebookAccess(val uid: String, val deleted: Boolean, val readOnly: Boolean)

    /**
     * Note entry files that cannot be read, by note uid (from "<uid>.note", or a leftover
     * "<uid>.note.new"), with the notebook when the entry's own header named it. A uid whose entry reads
     * fine in the same snapshot is left out.
     */
    fun unreadableEntries(unreadable: List<Read.Unreadable>, headers: List<EntryHeader>): Map<String, String?> {
        val present = headers.mapTo(HashSet()) { it.noteUid }
        val result = HashMap<String, String?>()
        for (u in unreadable) {
            val uid = entryUid(u.file) ?: continue
            if (uid !in present && result[uid] == null) result[uid] = u.notebookUid
        }
        return result
    }

    internal fun entryUid(file: String): String? = when {
        file.endsWith(".note") -> file.removeSuffix(".note")
        file.endsWith(".note.new") -> file.removeSuffix(".note.new")
        else -> null
    }

    /**
     * The notebook rows with their counts of waiting changes, and the number of changes that belong in
     * the unsynced text screen, so that every pending change is in exactly one of the two places. A
     * change waits on its notebook's row when it is not held and the notebook accepts writes the way
     * the runner decides it ([access], [NotePushPolicy.acceptsWrites]). Everything else is unsynced
     * text: held text, changes in a read-only, deleted or missing notebook, entry files that cannot be
     * read, and changes in a notebook that accepts writes but has no row because this client cannot
     * decode its metadata. The runner still pushes those last ones; the unsynced text screen is the only
     * place that can show them. [failed] passes through a notebook list that could not be read, in which
     * case no notebook is known and every change counts as unsynced text.
     */
    fun notebooks(
        rows: List<NotebookRow>,
        access: List<NotebookAccess>,
        headers: List<EntryHeader>,
        unreadableEntries: Map<String, String?>,
        failed: Boolean = false,
    ): NotebookOverview {
        val shown = rows.mapTo(HashSet()) { it.uid }
        val waitsOnRow = access.filter { it.uid in shown && NotePushPolicy.acceptsWrites(it.deleted, it.readOnly) }
            .mapTo(HashSet()) { it.uid }
        val waiting = HashMap<String, Int>()
        var unsynced = unreadableEntries.size
        for (h in headers) {
            if (h.state != PendingEntry.State.HELD && h.notebookUid in waitsOnRow) {
                waiting[h.notebookUid] = (waiting[h.notebookUid] ?: 0) + 1
            } else {
                unsynced++
            }
        }
        return NotebookOverview(rows.map { it.copy(waiting = waiting[it.uid] ?: 0) }, unsynced, failed)
    }

    /**
     * What the list shows after a load that read the local changes but not the notebooks: the rows
     * already on screen stay, without their waiting counts, since [failed] counts every change as
     * unsynced text and a change must not show in both places.
     */
    fun keptAfterFailure(shown: List<NotebookRow>, failed: NotebookOverview): NotebookOverview =
        failed.copy(notebooks = shown.map { it.copy(waiting = 0) })

    /**
     * The rows of one notebook. [unreadableCached] are cached items that could not be decoded; one that
     * a pending change covers is shown through that change instead of being counted. [decrypt] is
     * called only for pending edits in a writable notebook.
     */
    fun notebook(
        row: NotebookRow,
        cached: List<NoteRow>,
        unreadableCached: Set<String>,
        headers: List<EntryHeader>,
        unreadableEntries: Map<String, String?>,
        decrypt: (EntryHeader) -> Decrypted?,
    ): NotebookContents {
        val writable = !row.readOnly
        val rows = LinkedHashMap<String, NoteRow>()
        cached.forEach { rows[it.uid] = it }
        val covered = HashSet<String>()
        for (h in headers) {
            if (h.notebookUid != row.uid) continue
            if (!writable || h.state == PendingEntry.State.HELD) {
                rows[h.noteUid]?.let { rows[h.noteUid] = it.copy(sync = NoteSync.HELD) }
                continue
            }
            covered += h.noteUid
            if (h.state == PendingEntry.State.DELETE) {
                rows.remove(h.noteUid)
                continue
            }
            val content = decrypt(h)
            rows[h.noteUid] = if (content != null) {
                NoteRow(h.noteUid, content.title, content.preview, content.editedAt, NoteSync.WAITING)
            } else {
                (rows[h.noteUid] ?: NoteRow(h.noteUid, "", "", null)).copy(sync = NoteSync.LOCAL_UNREADABLE)
            }
        }
        // An entry file that cannot be read names its note. A row already here is marked. When the file's
        // own header named this notebook (only the rest of it is damaged), a note with no row, such as a
        // local create, gets a marked placeholder; with the notebook unknown it stays under Unsynced text.
        for ((uid, notebookUid) in unreadableEntries) {
            val existing = rows[uid]
            if (existing == null) {
                if (writable && notebookUid == row.uid) rows[uid] = NoteRow(uid, "", "", null, NoteSync.LOCAL_UNREADABLE)
            } else if (existing.sync == NoteSync.SYNCED) {
                rows[uid] = existing.copy(sync = NoteSync.LOCAL_UNREADABLE)
            }
        }
        return NotebookContents(row, NotesLoader.sortNotes(rows.values.toList()), unreadableCached.count { it !in covered })
    }

    /**
     * One note for the viewer, or null when there is nothing to show (a note deleted locally, or neither
     * a server copy nor any local change). [read] is this note's entry file and [sequence] the store's
     * sequence read with it; every result carries the sequence, so an editor can drop a load older than
     * its last save whether or not an entry existed. [cached] is null when the server copy is missing
     * or cannot be decoded.
     */
    fun note(
        noteUid: String,
        notebookUid: String,
        cached: NoteContent?,
        read: Read,
        sequence: Long,
        writable: Boolean,
        decrypt: (PendingEntry) -> Decrypted?,
    ): NoteContent? {
        fun marked(sync: NoteSync, version: Long?) =
            (cached ?: NoteContent(noteUid, "", "", null)).copy(sync = sync, pendingVersion = version, observedSequence = sequence)
        val entry = when (read) {
            Read.Missing -> return cached?.copy(observedSequence = sequence)
            is Read.Unreadable -> return marked(NoteSync.LOCAL_UNREADABLE, null)
            is Read.Present -> read.entry
        }
        if (entry.notebookUid != notebookUid) return cached?.copy(observedSequence = sequence)
        if (!writable || entry.state == PendingEntry.State.HELD) return marked(NoteSync.HELD, entry.version)
        if (entry.state == PendingEntry.State.DELETE) return null
        val content = decrypt(entry) ?: return marked(NoteSync.LOCAL_UNREADABLE, entry.version)
        return NoteContent(noteUid, content.title, content.body.orEmpty(), content.editedAt, NoteSync.WAITING, entry.version, sequence)
    }
}
