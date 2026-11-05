package io.silentsuite.sync.ui

import io.silentsuite.sync.notes.edit.PendingNotesStore
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.StandardCopyOption

/**
 * The store folder the active-account preference named at the last startup sweep that went ahead
 * ([NotesStartupSweep]), so that a sweep still keeps that folder's store once the preference has moved on, as a read of
 * the active account moves it off a name whose row is gone ([ActiveAccountManager.getActiveIdentity]), which can come
 * before the sweep in the same start. One file in noBackupFilesDir, beside notes-pending and never inside it, where
 * every listing of notes-pending would show it as a name of a kind this build does not know. It holds one store folder
 * name ([PendingNotesStore.STORE_DIRECTORY]) or nothing: no account name and no text. It is a file of its own, so a
 * record that cannot be read is told apart from one that is not there.
 */
internal object NotesLastActiveRecord {
    const val FILE = "notes-last-active"

    /** What a read of the record found. */
    sealed class Read {
        /** There is no record: no sweep has gone ahead on this device yet. */
        object Missing : Read()

        /** The record names [folder], or none when it is empty. */
        data class Holds(val folder: String?) : Read()

        /** The read failed, or the record holds anything but one store folder name or nothing. */
        object Unreadable : Read()
    }

    /**
     * The record in [noBackup]: [Read.Missing] only when the file is not there (NoSuchFileException); empty is
     * [Read.Holds] with no folder; exactly one store folder name is [Read.Holds] with it; anything else, a read that
     * fails, a newline, upper case or another length included, is [Read.Unreadable].
     */
    fun read(noBackup: File): Read = try {
        val content = String(Files.readAllBytes(File(noBackup, FILE).toPath()), Charsets.UTF_8)
        when {
            content.isEmpty() -> Read.Holds(null)
            PendingNotesStore.STORE_DIRECTORY.matches(content) -> Read.Holds(content)
            else -> Read.Unreadable
        }
    } catch (e: NoSuchFileException) {
        Read.Missing
    } catch (e: Exception) {
        Read.Unreadable
    }

    /**
     * Writes [folder], or nothing for null, to "<FILE>.new" in [noBackup], syncs it, and moves it over the record in
     * one step, so a power loss leaves the record of before or this one, never one cut short. noBackupFilesDir is not
     * synced after the move: a move that a power loss undoes leaves the record of before, as when the preference moves
     * twice between two sweeps, which the record does not cover either. A write that fails throws, an IOException for
     * any failure of the file system, with the temp file removed when it can be.
     */
    fun write(noBackup: File, folder: String?) {
        val target = File(noBackup, FILE)
        val tmp = File(noBackup, "$FILE.new")
        try {
            FileOutputStream(tmp).use { out ->
                out.write(folder.orEmpty().toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING)
        } catch (e: Throwable) {
            tmp.delete()
            throw e
        }
    }
}
