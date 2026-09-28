package io.silentsuite.sync.notes.edit

import android.content.Context
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import io.silentsuite.sync.log.Logger
import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * Unpushed Notes changes for one exact account identity, kept apart from the Etebase cache so a
 * fetch can never overwrite them. One self-describing file per note (`<uid>.note`), a landed record
 * per note after a successful push (`<uid>.landed`), an encrypted copy of each notebook that still
 * has entries (`<uid>.notebook`), so held text stays decryptable after the Etebase cache drops the
 * notebook, and a store-wide version counter (`sequence`).
 *
 * There is exactly one instance per directory in a process ([open]), so its lock is the one lock per
 * identity. Every operation runs under it. Callers must never hold the Etebase cache monitor while
 * calling in, and transforms passed to [update] must not take it either.
 */
internal class PendingNotesStore private constructor(
    val dir: File,
    private val syncDirectory: (File) -> Unit,
    /** Replaces the target in one step or throws; the committed file is never deleted first. */
    private val rename: (File, File) -> Unit,
) {
    private val lock = Any()
    private var closed = false
    private var recovered = false
    private var recoveryProblems: List<Read.Unreadable> = emptyList()

    /** Open editors per note uid. Landed records exist only while one is open (design 3.1). */
    private val openEditors = HashMap<String, Int>()

    /** Originals whose conflict copy is written but whose removal failed in the last recovery. */
    private var unfinishedOriginals: Set<String> = emptySet()

    sealed class Read {
        object Missing : Read()
        data class Present(val entry: PendingEntry) : Read()

        /** [notebookUid] is known when the entry's own header read fine and only the rest did not. */
        data class Unreadable(val file: String, val reason: String, val notebookUid: String? = null) : Read()
    }

    sealed class Change {
        object Keep : Change()
        data class Write(val entry: PendingEntry) : Change()
        object Remove : Change()
    }

    data class Scan(val entries: List<PendingEntry>, val unreadable: List<Read.Unreadable>)

    /** An entry without its blob: enough to count, filter, and choose entries. */
    data class EntryHeader(val noteUid: String, val notebookUid: String, val state: PendingEntry.State, val version: Long)

    /**
     * One consistent view taken under one lock: every header, the full entries the caller asked for,
     * the files that cannot be read, and the store-wide sequence at that moment.
     */
    data class Snapshot(
        val headers: List<EntryHeader>,
        val entries: Map<String, PendingEntry>,
        val unreadable: List<Read.Unreadable>,
        val sequence: Long,
    )

    /** One note's entry and the store-wide sequence, read together. */
    data class Observed(val read: Read, val sequence: Long)

    sealed class SaveOutcome {
        data class Saved(val version: Long) : SaveOutcome()
        /** The text is held (read-only, lost access, rejected): kept there, never pushed. The editor becomes a viewer. */
        data class SavedToHolding(val version: Long) : SaveOutcome()
        /** The note has a pending delete, which is final until pushed. */
        object Discarded : SaveOutcome()
        /** The existing entry cannot be read; it is never overwritten, so it can still be reported. */
        object Blocked : SaveOutcome()
        /** The note is larger than the store keeps ([PendingCodec.MAX_BLOB]); nothing was written. */
        object TooLarge : SaveOutcome()
    }

    sealed class DeleteOutcome {
        object Queued : DeleteOutcome()
        /** A local create that was never sent: nothing to tell the server, so the entry is gone. */
        object Removed : DeleteOutcome()
        object AlreadyQueued : DeleteOutcome()
        /** The note's text is held; the user discards it there, not with a delete. */
        object Held : DeleteOutcome()
        object Blocked : DeleteOutcome()
    }

    sealed class SendOutcome {
        object Done : SendOutcome()
        /** The user changed the note while it was being sent; rebase this entry onto the landed item. */
        data class NewerLocalChange(val entry: PendingEntry) : SendOutcome()
    }

    // ---- reading ----

    fun read(noteUid: String): Read = locked { readEntry(noteUid) }

    /** Lists every entry. A committed file that cannot be read is reported in [Scan.unreadable], never deleted. */
    fun scan(): Scan = locked {
        val entries = mutableListOf<PendingEntry>()
        val unreadable = mutableListOf<Read.Unreadable>()
        for (file in files(NOTE)) {
            when (val read = decodeFile(file)) {
                is Read.Present -> entries += read.entry
                is Read.Unreadable -> unreadable += read
                Read.Missing -> Unit
            }
        }
        unreadable += currentRecoveryProblems(entries.mapTo(HashSet()) { it.noteUid })
        Scan(entries.sortedBy { it.noteUid }, unreadable.sortedBy { it.file })
    }

    /**
     * Like [scan], but keeps a blob only for the entries [keep] selects, so a screen that needs a few
     * blobs, or none, does not hold every one. Entries it does not keep are read by header alone
     * ([PendingCodec.decodeEntryHeader]), so their blobs are not read at all: a blob damaged after its
     * header was written counts by its header here, and is found by whatever reads the whole entry (the
     * notebook's own screen, the viewer, a push). A kept entry that fails its full read is reported with
     * the notebook its header names. [keep] runs under the store lock and must not take the Etebase
     * cache monitor.
     */
    fun snapshot(keep: (EntryHeader) -> Boolean): Snapshot = locked {
        val headers = mutableListOf<EntryHeader>()
        val kept = HashMap<String, PendingEntry>()
        val unreadable = mutableListOf<Read.Unreadable>()
        for (file in files(NOTE)) {
            val header = readHeader(file)
            if (header != null && !keep(header)) {
                headers += header
                continue
            }
            when (val read = decodeFile(file)) {
                is Read.Present -> {
                    val e = read.entry
                    val full = EntryHeader(e.noteUid, e.notebookUid, e.state, e.version)
                    headers += full
                    if (keep(full)) kept[e.noteUid] = e
                }
                is Read.Unreadable -> unreadable += read.copy(notebookUid = header?.notebookUid)
                Read.Missing -> Unit
            }
        }
        unreadable += currentRecoveryProblems(headers.mapTo(HashSet()) { it.noteUid })
        Snapshot(headers.sortedBy { it.noteUid }, kept, unreadable.sortedBy { it.file }, currentSequence())
    }

    /**
     * One note's entry with the store-wide sequence at the same moment. A load carries the sequence, so
     * an editor can drop any load older than its last save whether or not an entry existed.
     */
    fun observe(noteUid: String): Observed = locked { Observed(readEntry(noteUid), currentSequence()) }

    // ---- the one primitive every change goes through ----

    /** Reads the entry and applies [transform] atomically under the store lock. Returns the new state. */
    fun update(noteUid: String, transform: (Read) -> Change): Read = locked {
        val current = readEntry(noteUid)
        when (val change = transform(current)) {
            Change.Keep -> current
            is Change.Write -> {
                require(change.entry.noteUid == noteUid) { "entry written under another uid" }
                writeAtomically(noteFile(noteUid), PendingCodec.encodeEntry(change.entry))
                Read.Present(change.entry)
            }
            Change.Remove -> {
                remove(noteFile(noteUid))
                Read.Missing
            }
        }
    }

    // ---- editor operations ----

    /**
     * An editor save. Resets the failure backoff, since new content may push where the old did not.
     * [notebookCopy], when given, is written in the same step, so no prune can remove it in between.
     */
    fun saveLocal(
        noteUid: String,
        notebookUid: String,
        revision: String,
        blob: ByteArray,
        isCreate: Boolean,
        notebookCopy: ByteArray? = null,
    ): SaveOutcome = locked {
        if (blob.size > PendingCodec.MAX_BLOB) return@locked SaveOutcome.TooLarge
        var outcome: SaveOutcome = SaveOutcome.Blocked
        update(noteUid) { read ->
            when (read) {
                Read.Missing -> {
                    notebookCopy?.let { putNotebookLocked(notebookUid, it) }
                    val version = nextVersion()
                    outcome = SaveOutcome.Saved(version)
                    Change.Write(fromLanded(PendingEntry(noteUid, notebookUid, PendingEntry.State.UPSERT, version, revision, isCreate, blob = blob)))
                }
                is Read.Present -> when (read.entry.state) {
                    PendingEntry.State.UPSERT -> {
                        notebookCopy?.let { putNotebookLocked(read.entry.notebookUid, it) }
                        val version = nextVersion()
                        outcome = SaveOutcome.Saved(version)
                        Change.Write(read.entry.copy(version = version, revision = revision, blob = blob,
                            failureCount = 0, lastFailureAt = null, lastFailureCategory = null))
                    }
                    PendingEntry.State.HELD -> {
                        // The editor's latest text joins the held text instead of being lost.
                        val version = nextVersion()
                        outcome = SaveOutcome.SavedToHolding(version)
                        Change.Write(read.entry.copy(version = version, revision = revision, blob = blob))
                    }
                    PendingEntry.State.DELETE -> {
                        outcome = SaveOutcome.Discarded
                        Change.Keep
                    }
                }
                is Read.Unreadable -> {
                    outcome = SaveOutcome.Blocked
                    Change.Keep
                }
            }
        }
        outcome
    }

    /** A delete from the editor. [revision] and [blob] are the item with `delete()` applied. */
    fun markDeleted(
        noteUid: String,
        notebookUid: String,
        revision: String,
        blob: ByteArray,
        notebookCopy: ByteArray? = null,
    ): DeleteOutcome = locked {
        var outcome: DeleteOutcome = DeleteOutcome.Blocked
        update(noteUid) { read ->
            when (read) {
                Read.Missing -> {
                    notebookCopy?.let { putNotebookLocked(notebookUid, it) }
                    outcome = DeleteOutcome.Queued
                    Change.Write(fromLanded(PendingEntry(noteUid, notebookUid, PendingEntry.State.DELETE, nextVersion(), revision, false, blob = blob)))
                }
                is Read.Present -> {
                    val e = read.entry
                    when (e.state) {
                        PendingEntry.State.UPSERT -> if (e.isCreate && e.sent.isEmpty()) {
                            outcome = DeleteOutcome.Removed
                            Change.Remove
                        } else {
                            outcome = DeleteOutcome.Queued
                            Change.Write(e.copy(state = PendingEntry.State.DELETE, version = nextVersion(),
                                revision = revision, blob = blob, failureCount = 0, lastFailureAt = null,
                                lastFailureCategory = null))
                        }
                        PendingEntry.State.DELETE -> {
                            outcome = DeleteOutcome.AlreadyQueued
                            Change.Keep
                        }
                        PendingEntry.State.HELD -> {
                            outcome = DeleteOutcome.Held
                            Change.Keep
                        }
                    }
                }
                is Read.Unreadable -> {
                    outcome = DeleteOutcome.Blocked
                    Change.Keep
                }
            }
        }
        outcome
    }

    // ---- push operations ----

    /**
     * Records the entry's current revision as sent and returns the snapshot to upload, or null when
     * there is nothing to push (missing, held, or unreadable). The version does not move. An original
     * that a conflict copy has not finished replacing is not sent either: it would conflict again and
     * make a second copy. Recovery keeps trying to finish it before every operation.
     */
    fun beginSend(noteUid: String): PendingEntry? = locked {
        if (noteUid in unfinishedOriginals) return@locked null
        var snapshot: PendingEntry? = null
        update(noteUid) { read ->
            val e = (read as? Read.Present)?.entry
            if (e == null || e.state == PendingEntry.State.HELD) Change.Keep else {
                val updated = e.withSent(e.revision)
                snapshot = updated
                if (updated === e) Change.Keep else Change.Write(updated)
            }
        }
        snapshot
    }

    /**
     * After a successful upload of the snapshot at [sentVersion]: keep the landed item while an editor
     * for the note is open, then drop the entry, unless the user changed the note meanwhile, in which
     * case the entry stays for a rebase. With no editor open nothing can start from the landed item, so
     * no full copy of the note is kept. A pushed delete keeps nothing: the note is gone.
     */
    fun completeSend(noteUid: String, sentVersion: Long, revision: String, blob: ByteArray): SendOutcome = locked {
        val sent = (readEntry(noteUid) as? Read.Present)?.entry?.takeIf { it.version == sentVersion }
        if (sent?.state == PendingEntry.State.DELETE) {
            remove(landedFile(noteUid))
            remove(noteFile(noteUid))
            return@locked SendOutcome.Done
        }
        if (noteUid in openEditors) {
            writeAtomically(landedFile(noteUid), PendingCodec.encodeLanded(LandedRecord(noteUid, revision, sentVersion, blob)))
        } else {
            remove(landedFile(noteUid))
        }
        var outcome: SendOutcome = SendOutcome.Done
        update(noteUid) { read ->
            val e = (read as? Read.Present)?.entry
            when {
                e == null -> Change.Keep
                e.version == sentVersion -> Change.Remove
                else -> {
                    outcome = SendOutcome.NewerLocalChange(e)
                    Change.Keep
                }
            }
        }
        outcome
    }

    /** Replaces the entry's content with a rebase built from [expectedVersion]; false if it moved on. */
    fun rebase(noteUid: String, expectedVersion: Long, revision: String, blob: ByteArray): Boolean = locked {
        var applied = false
        update(noteUid) { read ->
            val e = (read as? Read.Present)?.entry
            if (e == null || e.version != expectedVersion || e.state == PendingEntry.State.HELD) Change.Keep else {
                applied = true
                Change.Write(e.copy(version = nextVersion(), revision = revision, blob = blob))
            }
        }
        applied
    }

    /** Counts a failed upload of the snapshot at [sentVersion]; a newer local change is left to be tried on its own. */
    fun recordFailure(noteUid: String, sentVersion: Long, category: String, now: Long): Boolean = locked {
        var applied = false
        update(noteUid) { read ->
            val e = (read as? Read.Present)?.entry
            if (e == null || e.version != sentVersion) Change.Keep else {
                applied = true
                Change.Write(e.copy(failureCount = e.failureCount + 1, lastFailureAt = now, lastFailureCategory = category))
            }
        }
        applied
    }

    /**
     * Moves the entry's text to the holding area: kept, readable, never pushed. [sentVersion] is given
     * when the reason is about the content (a rejection), so a newer change is not held with it; a
     * reason about the notebook (read-only, lost access, deleted) holds whatever is there.
     *
     * A pending delete has no text worth keeping (its blob is the item with the body dropped), and the
     * server copy stays, which is the right result when the delete cannot be pushed. So a delete is
     * dropped instead of held: [HoldOutcome.DELETE_DROPPED], for the runner to report.
     */
    fun hold(noteUid: String, reason: HeldReason, now: Long, sentVersion: Long? = null): HoldOutcome = locked {
        var outcome = HoldOutcome.NOT_APPLIED
        update(noteUid) { read ->
            val e = (read as? Read.Present)?.entry
            when {
                e == null || e.state == PendingEntry.State.HELD || (sentVersion != null && e.version != sentVersion) -> Change.Keep
                e.state == PendingEntry.State.DELETE -> {
                    outcome = HoldOutcome.DELETE_DROPPED
                    Change.Remove
                }
                else -> {
                    outcome = HoldOutcome.HELD
                    Change.Write(e.copy(state = PendingEntry.State.HELD, held = PendingEntry.Held(reason, now)))
                }
            }
        }
        outcome
    }

    enum class HoldOutcome { HELD, DELETE_DROPPED, NOT_APPLIED }

    /**
     * The user's "Try again" on held text: it waits for a push again, with a fresh backoff. Its base is
     * unchanged, so if the server copy moved on meanwhile the push conflicts and goes through the
     * conflict table rather than overwriting it. False when the note has no held entry.
     */
    fun release(noteUid: String): Boolean = locked {
        var applied = false
        update(noteUid) { read ->
            val e = (read as? Read.Present)?.entry
            if (e == null || e.state != PendingEntry.State.HELD) Change.Keep else {
                applied = true
                Change.Write(e.copy(state = PendingEntry.State.UPSERT, version = nextVersion(), held = null,
                    failureCount = 0, lastFailureAt = null, lastFailureCategory = null))
            }
        }
        applied
    }

    /** The user's explicit discard of held or unreadable text. */
    fun discard(noteUid: String): Unit = locked { remove(noteFile(noteUid)) }

    /**
     * Resolves a conflict by giving the text a new note: [newNote] is written first, carrying an
     * origin, then the original is removed, then the origin is cleared. A crash after the first step
     * is finished by recovery. False when the original moved on or is not a plain edit.
     */
    fun replaceWithNewNote(originalUid: String, expectedVersion: Long, serverRevision: String, newNote: PendingEntry): Boolean =
        locked {
            val e = (readEntry(originalUid) as? Read.Present)?.entry
            if (e == null || e.version != expectedVersion || e.state != PendingEntry.State.UPSERT) return@locked false
            require(newNote.noteUid != originalUid) { "a new note needs its own uid" }
            val copy = newNote.copy(version = nextVersion(), origin = PendingEntry.Origin(originalUid, e.revision, e.version, serverRevision))
            writeAtomically(noteFile(copy.noteUid), PendingCodec.encodeEntry(copy))
            beforeOriginalRemovedForTesting?.invoke()
            remove(noteFile(originalUid))
            writeAtomically(noteFile(copy.noteUid), PendingCodec.encodeEntry(copy.copy(origin = null)))
            true
        }

    // ---- landed records ----

    fun landed(noteUid: String): LandedRecord? = locked { readLanded(noteUid) }

    fun clearLanded(noteUid: String): Unit = locked { remove(landedFile(noteUid)) }

    /** An editor for [noteUid] opened. Each call is matched by one [editorClosed]. */
    fun editorOpened(noteUid: String): Unit = locked {
        checkedUid(noteUid)
        openEditors[noteUid] = (openEditors[noteUid] ?: 0) + 1
    }

    /** An editor for [noteUid] closed. With none left open, the note's landed record has no use and goes. */
    fun editorClosed(noteUid: String): Unit = locked {
        val left = (openEditors[checkedUid(noteUid)] ?: return@locked) - 1
        if (left > 0) {
            openEditors[noteUid] = left
        } else {
            openEditors.remove(noteUid)
            remove(landedFile(noteUid))
        }
    }

    // ---- notebook copies ----

    fun putNotebook(notebookUid: String, blob: ByteArray): Unit = locked { putNotebookLocked(notebookUid, blob) }

    fun notebook(notebookUid: String): ByteArray? = locked {
        val file = notebookFile(notebookUid)
        if (!file.exists()) null else (PendingCodec.decodeNotebook(file.readBytes()) as? PendingCodec.Decoded.Ok)?.value?.second
    }

    /**
     * Removes notebook copies no entry references. Skipped entirely while anything is unreadable,
     * since its notebook is unknown and its copy may be the only way to decrypt it.
     */
    fun pruneNotebooks(): List<String> = locked {
        val scan = scan()
        if (scan.unreadable.isNotEmpty()) return@locked emptyList()
        val referenced = scan.entries.map { it.notebookUid }.toSet()
        files(NOTEBOOK).map { it.name.removeSuffix(NOTEBOOK) }
            .filter { it !in referenced }
            .onEach { remove(notebookFile(it)) }
    }

    /**
     * Sign-out: everything for this identity goes. The closed instance stays registered for the rest of
     * the process, so a late save that opens the store again gets this instance and is refused instead
     * of recreating the directory. The identity (account generation) never comes back after sign-out. A
     * call after a failed one tries the deletion again, so a sign-out cleanup retry does real work.
     */
    fun clearAll() {
        synchronized(lock) {
            closed = true
            beforeClearForTesting?.invoke()
            if (dir.exists() && !dir.deleteRecursively()) throw IOException("could not clear the pending store")
        }
    }

    // ---- internals ----

    /**
     * Every public operation: refuse after [clearAll], and finish any interrupted work first. Recovery
     * runs again before the next operation for as long as anything in it did not work out, including a
     * write or removal inside recovery itself.
     */
    private inline fun <T> locked(block: () -> T): T = synchronized(lock) {
        check(!closed) { "the pending store was cleared" }
        if (!recovered) {
            recovered = true
            recoveryProblems = recoverLocked()
            if (recoveryProblems.isNotEmpty()) recovered = false
        }
        block()
    }

    /** A new entry for a note that landed earlier starts from that evidence: not a create, and the landed revision is ours. */
    private fun fromLanded(entry: PendingEntry): PendingEntry {
        val landed = readLanded(entry.noteUid) ?: return entry
        return entry.copy(isCreate = false).withSent(landed.revision)
    }

    private fun readLanded(noteUid: String): LandedRecord? {
        val file = landedFile(noteUid)
        if (!file.exists()) return null
        return (PendingCodec.decodeLanded(file.readBytes()) as? PendingCodec.Decoded.Ok)?.value
    }

    private fun putNotebookLocked(notebookUid: String, blob: ByteArray) {
        writeAtomically(notebookFile(notebookUid), PendingCodec.encodeNotebook(notebookUid, blob))
    }

    /** The next value of the store-wide counter, persisted before it is handed out. */
    private fun nextVersion(): Long {
        val next = currentSequence() + 1
        writeAtomically(File(dir, SEQUENCE), PendingCodec.encodeSequence(next))
        return next
    }

    /** The last version handed out. A lost or damaged counter restarts above every version still on disk. */
    private fun currentSequence(): Long {
        val file = File(dir, SEQUENCE)
        val stored = if (file.exists()) (PendingCodec.decodeSequence(file.readBytes()) as? PendingCodec.Decoded.Ok)?.value else null
        return stored ?: (files(NOTE).mapNotNull { (decodeFile(it) as? Read.Present)?.entry?.version } +
            files(LANDED).mapNotNull { (PendingCodec.decodeLanded(it.readBytes()) as? PendingCodec.Decoded.Ok)?.value?.version }).maxOrNull() ?: 0L
    }

    /**
     * Recovery problems that still stand: the file is still there and is not an entry that now reads
     * fine (a failed step of a conflict copy is recorded under the copy's own name). Without this a
     * problem would outlive its file until the process restarts, and a readable entry would count twice.
     */
    private fun currentRecoveryProblems(presentUids: Set<String>): List<Read.Unreadable> =
        recoveryProblems.filter { File(dir, it.file).exists() && it.file.removeSuffix(NOTE) !in presentUids }

    /**
     * A leftover "<uid>.note.new" with no committed file is one that recovery could not finish; it may
     * be the only copy of the text, so the note reads as unreadable, which keeps every save and delete
     * from writing through the same path over it. Recovery tries it again before the next operation.
     */
    private fun readEntry(noteUid: String): Read {
        val file = noteFile(noteUid)
        if (file.exists()) return decodeFile(file)
        val stranded = File(dir, file.name + NEW)
        return if (stranded.exists()) Read.Unreadable(stranded.name, "an interrupted write is not recovered yet") else Read.Missing
    }

    private fun decodeFile(file: File): Read = try {
        when (val decoded = PendingCodec.decodeEntry(file.readBytes())) {
            is PendingCodec.Decoded.Ok -> Read.Present(decoded.value)
            is PendingCodec.Decoded.Bad -> Read.Unreadable(file.name, decoded.reason)
        }
    } catch (e: IOException) {
        Read.Unreadable(file.name, e.message ?: "unreadable")
    }

    /** Finishes interrupted writes and conflict copies, and drops unused landed records. One bad file never stops the others. */
    private fun recoverLocked(): List<Read.Unreadable> {
        val problems = mutableListOf<Read.Unreadable>()
        val unfinished = HashSet<String>()
        // 1. A leftover "<name>.new" was never committed while "<name>" exists. Without a committed
        // file it is the first write of that file, stopped before its rename; it is kept if complete.
        for (tmp in dir.listFiles()?.filter { it.name.endsWith(NEW) }.orEmpty()) {
            try {
                val target = File(dir, tmp.name.removeSuffix(NEW))
                if (target.exists() || !isComplete(tmp.readBytes(), target.name)) {
                    if (!tmp.delete()) throw IOException("could not remove ${tmp.name}")
                } else {
                    rename(tmp, target)
                }
            } catch (e: IOException) {
                problems += Read.Unreadable(tmp.name, e.message ?: "unreadable")
            }
        }
        // 2. A landed record only matters while an editor for its note is open. Any other is left from an
        // editor that closed without clearing it, or from an earlier process (no editor survives one),
        // and would otherwise keep a full copy of the note on the device.
        for (file in files(LANDED).filter { it.name.removeSuffix(LANDED) !in openEditors }) {
            try {
                remove(file)
            } catch (e: IOException) {
                problems += Read.Unreadable(file.name, e.message ?: "unreadable")
            }
        }
        // 3. A new note from a conflict: remove the original it replaced if that exact entry is still
        // here (same version and revision), then clear the origin. A later entry for the same note has
        // a higher version and a new revision, so it is never touched.
        for (file in files(NOTE)) {
            try {
                val copy = (decodeFile(file) as? Read.Present)?.entry ?: continue
                val origin = copy.origin ?: continue
                val original = readEntry(origin.noteUid)
                val sameEntry = original is Read.Present &&
                    original.entry.version == origin.version && original.entry.revision == origin.revision
                if (sameEntry) {
                    // Until the original is gone it must not be pushed: it would conflict and be copied again.
                    unfinished += origin.noteUid
                    remove(noteFile(origin.noteUid))
                    unfinished -= origin.noteUid
                }
                // Keep the link only while the original cannot be read, since then it cannot be told apart.
                if (original !is Read.Unreadable) {
                    writeAtomically(noteFile(copy.noteUid), PendingCodec.encodeEntry(copy.copy(origin = null)))
                }
            } catch (e: IOException) {
                problems += Read.Unreadable(file.name, e.message ?: "unreadable")
            }
        }
        unfinishedOriginals = unfinished
        return problems
    }

    private fun isComplete(bytes: ByteArray, name: String): Boolean = when {
        name.endsWith(NOTE) -> PendingCodec.decodeEntry(bytes) is PendingCodec.Decoded.Ok
        name.endsWith(LANDED) -> PendingCodec.decodeLanded(bytes) is PendingCodec.Decoded.Ok
        name.endsWith(NOTEBOOK) -> PendingCodec.decodeNotebook(bytes) is PendingCodec.Decoded.Ok
        name == SEQUENCE -> PendingCodec.decodeSequence(bytes) is PendingCodec.Decoded.Ok
        else -> false
    }

    private fun files(suffix: String): List<File> =
        dir.listFiles()?.filter { it.isFile && it.name.endsWith(suffix) }?.sortedBy { it.name }.orEmpty()

    private fun noteFile(uid: String) = File(dir, checkedUid(uid) + NOTE)
    private fun landedFile(uid: String) = File(dir, checkedUid(uid) + LANDED)
    private fun notebookFile(uid: String) = File(dir, checkedUid(uid) + NOTEBOOK)

    /**
     * Writes to "<name>.new", syncs it, renames it over "<name>" in one step ([rename]), and syncs the
     * directory so the rename itself survives a power loss. The committed file is never deleted first,
     * so at every moment either the old or the new content is there under its own name.
     */
    private fun writeAtomically(target: File, bytes: ByteArray) {
        if (!dir.exists() && !dir.mkdirs()) throw IOException("could not create the pending store")
        val tmp = File(dir, target.name + NEW)
        try {
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.fd.sync()
            }
            beforeRenameForTesting?.invoke(target)
            rename(tmp, target)
            syncDirectory(dir)
        } catch (e: Throwable) {
            // Anything left half done is sorted out by recovery before the next operation.
            recovered = false
            throw e
        }
    }

    /** Removes a committed file together with any leftover ".new" beside it, and makes the removal stick. */
    private fun remove(file: File) {
        try {
            beforeRemoveForTesting?.invoke(file)
            val tmp = File(dir, file.name + NEW)
            if (tmp.exists() && !tmp.delete()) throw IOException("could not remove ${tmp.name}")
            if (file.exists()) {
                if (!file.delete()) throw IOException("could not remove ${file.name}")
                syncDirectory(dir)
            }
        } catch (e: Throwable) {
            // A removal stopped halfway (for example inside a conflict copy) is finished by recovery.
            recovered = false
            throw e
        }
    }

    /**
     * The entry's header alone, from the first bytes of a format 2 file; null when the file is format 1
     * or anything about it does not check out, so the caller reads it whole and reports it properly.
     */
    private fun readHeader(file: File): EntryHeader? = try {
        DataInputStream(FileInputStream(file)).use { input ->
            val prefix = ByteArray(PendingCodec.ENTRY_PREFIX)
            input.readFully(prefix)
            if (prefix[4].toInt() != PendingCodec.ENTRY_FORMAT_VERSION) return@use null
            val end = PendingCodec.entryHeaderEnd(prefix) ?: return@use null
            val head = prefix.copyOf(end)
            input.readFully(head, prefix.size, end - prefix.size)
            (PendingCodec.decodeEntryHeader(head) as? PendingCodec.Decoded.Ok)?.value
                ?.let { it as? PendingCodec.HeaderRead.Header }?.header
        }
    } catch (e: IOException) {
        null
    }

    companion object {
        private const val NOTE = ".note"
        private const val LANDED = ".landed"
        private const val NOTEBOOK = ".notebook"
        private const val NEW = ".new"
        private const val SEQUENCE = "sequence"
        private val UID = Regex("^[A-Za-z0-9_-]{1,128}$")
        private val registry = ConcurrentHashMap<String, PendingNotesStore>()

        /** Test seams: crash points inside the write, conflict, and sign-out sequences. */
        @Volatile internal var beforeOriginalRemovedForTesting: (() -> Unit)? = null
        @Volatile internal var beforeRenameForTesting: ((File) -> Unit)? = null
        @Volatile internal var beforeRemoveForTesting: ((File) -> Unit)? = null
        @Volatile internal var beforeClearForTesting: (() -> Unit)? = null

        /** rename(2) through File.renameTo: on Android and Linux it replaces the target in one step. */
        private val renameTo: (File, File) -> Unit = { from, to ->
            if (!from.renameTo(to)) throw IOException("could not replace ${to.name}")
        }

        /** rename(2) directly, so a failure says why instead of returning false. */
        private val androidRename: (File, File) -> Unit = { from, to ->
            try {
                Os.rename(from.path, to.path)
            } catch (e: ErrnoException) {
                throw IOException("could not replace ${to.name}", e)
            }
        }

        /**
         * The single instance for [dir] in this process, so every caller shares its lock. [rename] must
         * replace an existing target in one step; JVM tests on Windows pass a java.nio atomic move.
         */
        fun open(dir: File, syncDirectory: (File) -> Unit = {}, rename: (File, File) -> Unit = renameTo): PendingNotesStore =
            registry.computeIfAbsent(dir.canonicalPath) { PendingNotesStore(File(it), syncDirectory, rename) }

        /** Test seam: forget every instance, as a process restart would. */
        internal fun resetForTesting() = registry.clear()

        /** Uids come from the server and from collaborators, so they never reach a file name unchecked. */
        internal fun checkedUid(uid: String): String {
            require(UID.matches(uid)) { "not an Etebase uid" }
            return uid
        }

        /** One directory per exact identity, so a same-name replacement account never inherits it. */
        internal fun identityDir(root: File, accountType: String, accountName: String, creationId: String): File {
            val digest = MessageDigest.getInstance("SHA-256")
                .digest("v1\u0000$accountType\u0000$accountName\u0000$creationId".toByteArray(Charsets.UTF_8))
            return File(File(root, "notes-pending"), digest.joinToString("") { "%02x".format(it) })
        }

        /** Makes a rename or removal in [dir] durable; a filesystem without directory sync is logged, not fatal. */
        private val androidDirectorySync: (File) -> Unit = { dir ->
            try {
                val fd = Os.open(dir.path, OsConstants.O_RDONLY, 0)
                try {
                    Os.fsync(fd)
                } finally {
                    Os.close(fd)
                }
            } catch (e: ErrnoException) {
                Logger.log.warning("Pending notes directory sync not available: ${OsConstants.errnoName(e.errno)}")
            }
        }

        /** Outside backup and device transfer, and outside the Etebase cache's per-username directories. */
        fun forIdentity(context: Context, accountType: String, accountName: String, creationId: String) =
            open(identityDir(context.noBackupFilesDir, accountType, accountName, creationId), androidDirectorySync, androidRename)
    }
}
