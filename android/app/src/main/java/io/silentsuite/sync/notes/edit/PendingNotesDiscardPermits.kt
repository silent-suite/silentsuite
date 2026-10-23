package io.silentsuite.sync.notes.edit

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * The user's confirmed discards of whole pending stores, one permit per store directory, recorded before
 * anything in a store that may hold unsynced text is deleted. A permit holds the answer of
 * [PendingNotesStore.unsynced] that the discard deletes, with the notes it names, and covers the store for as
 * long as [UnsyncedNotes.covers] holds for what the store holds now. So a discard that stopped halfway, also across
 * a restart, can be finished under the same confirmation while the permit still covers what is left;
 * otherwise the user is asked again.
 *
 * Permits live in a root of their own (noBackupFilesDir/notes-discard, one "<store>.permit" per store
 * directory name). Not in the store, which the discard deletes, and not beside the stores in
 * notes-pending, so a permit stays readable when that directory cannot be listed.
 *
 * A permit never covers text saved after it: before a store hands out a new version it removes its
 * permit, and a removal that cannot be shown fails that write. Nothing here takes a lock; each store's
 * permit is recorded and removed under that store's lock.
 *
 * Beside its permit, a store may have an acknowledgement ("<store>.acknowledgement", in a record kind of its
 * own): what [PendingNotesStore.discardStore] records in place of a permit when the store's directory cannot
 * be listed, so that nothing in it can be deleted. It is no permit and never authority for a deletion:
 * [read] never takes it for one, and nothing else may either, the planned sweep of stores whose account is
 * gone included, which must read permits through [read] alone. It binds to one store directory and that
 * directory's identity, and the store withdraws it once it lists or writes the store again
 * ([PendingNotesStore.acknowledged]).
 *
 * Whether a file is there is decided as in the store: by a read that worked, a deletion that answered
 * true, a listing that worked, or the presence check, which answers absent only when the system says the
 * path does not exist. File.exists() decides nothing.
 */
internal class PendingNotesDiscardPermits(
    val root: File,
    private val syncDirectory: (File) -> Unit,
    /** Replaces the target in one step or throws, as for the store. */
    private val rename: (File, File) -> Unit,
    /** The store's presence check: whether a path is there, [PendingNotesStore.Presence.UNKNOWN] when it fails. */
    private val presence: (File) -> PendingNotesStore.Presence,
) {
    /**
     * The permit of the store in directory [store], or null when there is none. A permit that is cut
     * short, fails its checksum, is in a newer format, names another store or cannot be read is no permit,
     * so the store it was for is not covered. An acknowledgement is never read as one: it is in a file and a
     * record kind of its own.
     */
    fun read(store: String): UnsyncedNotes? {
        val bytes = try {
            file(store).readBytes()
        } catch (e: IOException) {
            return null
        }
        val (named, shown) = (PendingCodec.decodePermit(bytes) as? PendingCodec.Decoded.Ok)?.value ?: return null
        return shown.takeIf { named == store }
    }

    /**
     * Records [shown] as the permit of the store in directory [store], in place of any earlier one. It is
     * written to "<name>.new", synced, renamed over "<name>" in one step ([rename]), and the root is synced,
     * so after a power loss the permit is there in full or not at all. The root is created on the way.
     * Throws when any step fails, and removes the temporary file it wrote; a failure after the rename leaves
     * the new permit in place.
     */
    fun record(store: String, shown: UnsyncedNotes) = write(file(store), PendingCodec.encodePermit(store, shown))

    /**
     * Removes the permit of the store in directory [store], and returns only once it is shown not to be
     * there: removed with the root synced, or shown absent by two checks that agree, its presence check and
     * a listing of the root that does not hold it, and then the root synced too, since an earlier call may
     * have unlinked it and failed at its sync (or the root itself shown not to be there,
     * [PendingNotesStore.knownAbsent]). File.exists() is not asked: it answers false for a check that failed
     * as well. Anything else throws IOException, a root that cannot be listed or synced included, so no
     * caller takes a permit that may still be there, or come back after a power loss, for gone.
     */
    fun remove(store: String) = delete(file(store), "the discard permit of $store")

    /**
     * Whether a permit of the store in directory [store] may be there: false only when its presence check shows
     * it not there, so a check that fails answers true. It reads nothing and covers nothing; the store asks it
     * only to decide whether to make its directory's removal durable before the permit goes.
     */
    fun mayHold(store: String): Boolean = presenceOf(file(store)) != PendingNotesStore.Presence.ABSENT

    /**
     * The acknowledgement of the store in directory [store]: the identity its directory had when it was
     * recorded, or null when there is none. One that is cut short, fails its checksum, is in a newer format,
     * names another store or cannot be read is none. Whether it still holds is the store's to say
     * ([PendingNotesStore.acknowledged]), and it is never a permit.
     */
    fun acknowledgement(store: String): PendingNotesStore.DirectoryIdentity? {
        val bytes = try {
            acknowledgementFile(store).readBytes()
        } catch (e: IOException) {
            return null
        }
        val decoded = PendingCodec.decodeAcknowledgement(bytes) as? PendingCodec.Decoded.Ok ?: return null
        val (named, identity) = decoded.value
        return identity.takeIf { named == store }
    }

    /**
     * Records that the user was told, for the store in directory [store], whose directory has [identity] now,
     * that the store could not be listed and nothing in it was deleted
     * ([PendingNotesStore.DiscardOutcome.Acknowledged]), in place of any earlier acknowledgement. It is
     * written as [record] writes a permit, and throws as it does.
     */
    fun acknowledge(store: String, identity: PendingNotesStore.DirectoryIdentity) =
        write(acknowledgementFile(store), PendingCodec.encodeAcknowledgement(store, identity))

    /**
     * Removes the acknowledgement of the store in directory [store], and returns only once it is shown gone,
     * as [remove] does for a permit. Each store instance asks this before it uses its first listing of the
     * store, a listing that worked, and before its first write or removal in it, whether or not an
     * acknowledgement was ever recorded, so while the root is there but cannot be listed, every store's first
     * listing, write and removal fails, a count of it answers that it could not be counted, an empty store's
     * included, and no discard or clear of it can finish.
     */
    fun withdrawAcknowledgement(store: String) = delete(acknowledgementFile(store), "the acknowledgement of $store")

    private fun write(target: File, bytes: ByteArray) {
        val tmp = File(root, target.name + NEW)
        try {
            createRoot()
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.fd.sync()
            }
            beforeRecordForTesting?.invoke(target)
            rename(tmp, target)
            syncDirectory(root)
        } catch (e: Throwable) {
            tmp.delete()
            throw e
        }
    }

    private fun delete(target: File, what: String) {
        beforeDeleteForTesting?.invoke(target)
        if (target.delete()) {
            syncDirectory(root)
            return
        }
        // Not there, or not removed: its own check and a listing tell which, and must agree.
        if (presenceOf(target) != PendingNotesStore.Presence.ABSENT) throw IOException("could not show $what gone")
        val listed = PendingNotesStore.listDirectory(root)
        if (listed == null) {
            if (PendingNotesStore.knownAbsent(root)) return
            throw IOException("could not list the discard permits")
        }
        if (listed.any { it.name == target.name }) throw IOException("could not remove $what")
        // Gone, maybe by an earlier call whose sync failed after the unlink: the removal is on disk only once
        // the root is synced.
        syncDirectory(root)
    }

    private fun file(store: String): File = named(store, PERMIT)

    private fun acknowledgementFile(store: String): File = named(store, ACKNOWLEDGEMENT)

    private fun named(store: String, suffix: String): File {
        require(NAME.matches(store)) { "not a store directory name" }
        return File(root, store + suffix)
    }

    private fun presenceOf(file: File) = PendingNotesStore.presenceForTesting?.invoke(file) ?: presence(file)

    /**
     * Creates the root and any missing parent, one level at a time, and syncs the parent of each new level
     * and the root's own parent, so a permit committed in it cannot outlive, after a power loss, the
     * entries that lead to it. The root's parent is synced on every record, since a record before this one
     * may have created the root and then failed that sync. As in the store, a level whose check fails is
     * made like a missing one, and mkdir, or a directory that is there already, decides.
     */
    private fun createRoot() {
        val missing = generateSequence(root) { it.parentFile }
            .takeWhile { presenceOf(it) != PendingNotesStore.Presence.PRESENT }.toList().asReversed()
        for (level in missing) {
            if (!level.mkdir() && !level.isDirectory) throw IOException("could not create the discard permits")
        }
        (missing.map { it.parentFile } + listOfNotNull(root.parentFile)).distinct().forEach(syncDirectory)
    }

    companion object {
        /** The root's name, beside notes-pending in noBackupFilesDir. */
        const val ROOT = "notes-discard"
        private const val PERMIT = ".permit"
        private const val ACKNOWLEDGEMENT = ".acknowledgement"
        private const val NEW = ".new"

        /** A store directory's name: one path level, never "." or "..". */
        private val NAME = Regex("^[A-Za-z0-9_-]{1,128}$")

        /** Test seam: a crash point after a new permit or acknowledgement is written and synced, before its rename. */
        @Volatile internal var beforeRecordForTesting: ((File) -> Unit)? = null

        /** Test seam: a failure point before a permit or acknowledgement is deleted, which leaves it as it is. */
        @Volatile internal var beforeDeleteForTesting: ((File) -> Unit)? = null
    }
}
