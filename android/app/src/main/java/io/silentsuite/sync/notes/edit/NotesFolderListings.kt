package io.silentsuite.sync.notes.edit

import java.io.File
import java.util.concurrent.atomic.AtomicLong

/**
 * How often each of the two Notes folders in noBackupFilesDir has been seen in this process: notes-pending, which holds
 * one folder per store ([PendingNotesStore.storeDirectories]), and notes-discard, which holds the discard permits and
 * acknowledgements ([PendingNotesDiscardPermits]). A folder's counter moves on every listing of it that works and every
 * time [PendingNotesStore.knownAbsent] shows it not to be there, whoever asked, since every listing of either folder
 * goes through [PendingNotesStore.listDirectory]. So a caller that read a count while a folder could not be read can
 * tell, from the count now, whether anything has read that folder or shown it gone since.
 *
 * The counters only rise, from 0 at process start, and are never reset, so an old count never matches again.
 */
internal object NotesFolderListings {
    enum class Folder(val folderName: String) {
        PENDING(PendingNotesStore.PENDING),
        DISCARD(PendingNotesDiscardPermits.ROOT),
    }

    private val counts = Folder.entries.associateWith { AtomicLong() }

    /** How often [folder] has been listed, or shown not to be there, so far. */
    fun count(folder: Folder): Long = counts.getValue(folder).get()

    /** A listing of [d] worked. */
    internal fun listed(d: File) {
        folderOf(d)?.let { counts.getValue(it).incrementAndGet() }
    }

    /** [top] was shown not to be there, and with it [d] below it and every level between the two. */
    internal fun shownAbsent(d: File, top: File) {
        var level: File? = d
        while (level != null) {
            folderOf(level)?.let { counts.getValue(it).incrementAndGet() }
            if (level == top) return
            level = level.parentFile
        }
    }

    private fun folderOf(d: File) = Folder.entries.firstOrNull { it.folderName == d.name }
}
