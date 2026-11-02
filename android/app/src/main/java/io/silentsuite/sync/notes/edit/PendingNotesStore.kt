package io.silentsuite.sync.notes.edit

import android.annotation.SuppressLint
import android.content.Context
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import androidx.annotation.VisibleForTesting
import io.silentsuite.sync.log.Logger
import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.lang.ref.WeakReference
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.attribute.BasicFileAttributes
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
 * identity. Every operation runs under it. Callers must never hold the Etebase cache monitor or the
 * cache's write fence (EtebaseLocalCache.writeIfCurrent) while calling in, and transforms passed to
 * [update] must not take either.
 *
 * Whether a file is there is decided by a read that worked, a listing that worked, or a presence check
 * ([Presence]) that answers absent only when the system says the path does not exist. File.exists()
 * decides nothing here: it answers false for a check that failed as well, and a file taken for absent
 * that way could be written over, skipped by a removal that then reports success, or left out of what a
 * run reports.
 *
 * A store folder that is a symbolic link is never followed: [open] keeps the link's own path and name, and lstat(2),
 * which does not follow it, tells a link apart ([followable]). Nothing is read, written or deleted through it. While
 * the folder is a link, or lstat cannot tell, it cannot be counted and is not listed ([unsynced], [removalCheck],
 * [unsyncedInNotebook]), every read and write of it fails at its start, also in an instance that recovered before the
 * link came ([locked]), and [clearAll] deletes nothing. Its only step is an acknowledgement ([discardStore]), bound to
 * the link's own identity under its own name, which deletes nothing. Removing the link itself is not offered.
 *
 * A confirmed discard of the whole store ([discardStore]) runs under the same lock and, when the store holds
 * anything a removal would lose ([UnsyncedNotes.anything]), records a permit outside the store before any
 * file goes ([PendingNotesDiscardPermits]). An instance dropped after it ([unregister]) refuses everything,
 * so only the new instance acts on the directory. A store whose directory cannot be listed is not deleted:
 * the discard records an acknowledgement instead, which deletes nothing and is no authority for a deletion
 * ([acknowledged]).
 *
 * Each instance shows that acknowledgement gone before it uses its first listing of the store, a listing that
 * worked, and before its first write or removal in it, whether or not one was ever recorded
 * ([withdrawAcknowledgement]), and that operation fails while it cannot.
 * A new instance lists first, in its recovery, so while notes-discard is there but cannot be listed, every
 * operation of a new instance that runs recovery fails, reads and pushes of what waits included, a count of
 * any store, an empty one included, answers that it could not be counted, and no discard or clear finishes.
 */
internal class PendingNotesStore private constructor(
    val dir: File,
    private val syncDirectory: (File) -> Unit,
    /** Replaces the target in one step or throws; the committed file is never deleted first. */
    private val rename: (File, File) -> Unit,
    /** Whether a path is there, without following a link; [Presence.UNKNOWN] when the check fails. */
    private val presence: (File) -> Presence,
    /** Where this store's discard permit and acknowledgement are kept, under its directory's name. */
    private val permits: PendingNotesDiscardPermits,
    /** The identity of a directory, without following a link; null when it cannot be read. */
    private val identity: (File) -> DirectoryIdentity?,
    /** Whether lstat shows a path is a symbolic link: false for anything else or ENOENT, null when it fails. */
    private val link: (File) -> Boolean?,
) {
    private val lock = Any()
    private var closed = false
    private var recovered = false
    private var recoveryProblems: List<Read.Unreadable> = emptyList()

    /** Whether this instance has shown its store's discard permit gone; see [withdrawPermit]. */
    private var permitWithdrawn = false

    /**
     * The highest sequence this instance has read from its store, handed out or handed to an upload, and no
     * lower than a dropped instance of the same directory had ([unregister]). [currentSequence] never answers
     * below it; see [nextVersion].
     */
    private var highWater = 0L

    /**
     * Whether this instance has listed or written the store since it last recorded an acknowledgement, which
     * no longer holds then, even when its withdrawal failed; see [withdrawAcknowledgement].
     */
    private var acknowledgementVoid = false

    /** Whether this instance has shown its store's acknowledgement gone since it last recorded one. */
    private var acknowledgementWithdrawn = false

    /** Set once [discardStore] has shown the directory gone and synced its removal ([syncRemoval]). */
    private var discarded = false

    /** Set once [clearAll] returned, which it does only once the directory is shown gone; see [clearedInFull]. */
    private var clearReturned = false

    /**
     * How many times a clear of this instance finished: [clearAll] returned, or [discardStore] gave
     * [DiscardOutcome.Done]; see [unregisterIfFinishedOnce].
     */
    private var finishes = 0

    /** Set by [unregister]: another instance may own the directory now. */
    private var dropped = false

    /**
     * How many files [remove] has unlinked in this instance: [discardNotebook] tells by it whether a removal that
     * failed had deleted a file already.
     */
    private var unlinks = 0L

    /**
     * Set once [remove] has unlinked a file and no sync of the store's directory by [remove] or [discardNotebook] has
     * worked since, so that unlink can still come back after a power loss; [discardNotebook] syncs the directory
     * before it says Done under a confirmation from a listed store that holds anything.
     */
    private var unlinkUnsynced = false

    /**
     * New directory levels whose entry in their parent is not synced yet. A level stays here until that
     * sync succeeds, so a failed one is tried again by the next write.
     */
    private val unsyncedLevels = ArrayList<File>()

    /** The open editors. A note's landed record exists only while one of them is on that note (design 3.1). */
    private val editors = ArrayList<EditorHandle>()

    /**
     * Editors that closed. They count for nothing but the redirect: a save that reaches the store after
     * its editor closed must still be kept away from a note that a conflict copy replaced. Held weakly,
     * so a handle goes when its editor drops it.
     */
    private val closedEditors = ArrayList<WeakReference<EditorHandle>>()

    /**
     * One editor's registration, from [editorOpened] to [editorClosed]. The editor saves
     * through it, and it follows the editor's text: when a conflict gives that text a new note
     * ([replaceWithNewNote], or recovery finishing one), every handle on the original points at the copy
     * from then on, closed handles included. It belongs to the editor, not to the uid, so an editor
     * opened on the original once that entry is gone is not moved. Kept in memory only, which is enough,
     * since no editor outlives its process.
     */
    inner class EditorHandle internal constructor(noteUid: String) {
        /** Guarded by the store lock. */
        internal var target = noteUid
        internal var open = true
        internal val store get() = this@PendingNotesStore

        /** The note this editor's text belongs to now. */
        val noteUid: String get() = synchronized(lock) { target }
    }

    /**
     * Originals that a conflict copy still links to after the last recovery: the removal failed, or the
     * original could not be read. They are not sent.
     */
    private var unfinishedOriginals: Set<String> = emptySet()

    sealed class Read {
        object Missing : Read()
        data class Present(val entry: PendingEntry) : Read()

        /** [notebookUid] is known when the entry's own header read fine and only the rest did not. */
        data class Unreadable(val file: String, val reason: String, val notebookUid: String? = null) : Read()
    }

    /**
     * What a check of whether one path is there answered. Only [ABSENT] says it is not: the system answered
     * that the path does not exist (ENOENT). A check that failed in any other way is [UNKNOWN], which the
     * store never takes for absent.
     */
    enum class Presence { PRESENT, ABSENT, UNKNOWN }

    /**
     * What tells a directory from one that takes its path later: the device and inode numbers lstat(2) gives
     * for it. A directory removed and made again under the same path gets other numbers, unless the
     * filesystem hands the new one the inode number the old one freed. A directory this build makes again
     * never relies on that: it writes first, and every write withdraws the acknowledgement ([acknowledged]).
     */
    data class DirectoryIdentity(val device: Long, val inode: Long)

    sealed class Change {
        object Keep : Change()
        data class Write(val entry: PendingEntry) : Change()
    }

    data class Scan(val entries: List<PendingEntry>, val unreadable: List<Read.Unreadable>)

    /** An entry without its blob: enough to count, filter, order and choose entries. */
    data class EntryHeader(
        val noteUid: String,
        val notebookUid: String,
        val state: PendingEntry.State,
        val version: Long,
        val failureCount: Int = 0,
        val lastFailureAt: Long? = null,
        val lastFailureCategory: String? = null,
    ) {
        companion object {
            fun of(e: PendingEntry) =
                EntryHeader(e.noteUid, e.notebookUid, e.state, e.version, e.failureCount, e.lastFailureAt, e.lastFailureCategory)
        }
    }

    /**
     * One consistent view taken under one lock: every header, the full entries the caller asked for,
     * the files that cannot be read, and the store-wide sequence at that moment. [discardConfirmed] holds the
     * notes among [headers] whose entry file the store's discard permit names: text the user confirmed for
     * discard in a discard that has not finished, which is never sent ([startSend]). [discardUnfinished] says
     * whether any file the permit names is there, checked by path and not taken from the listing, which can come
     * back short and leave such a note out of [headers]: a run does not record success while it is. While a permit
     * that may be there cannot be read, or the permit was recorded as for an answer that could not be counted
     * ([permitNames]), [discardConfirmed] holds every note among [headers], and [discardUnfinished] is true.
     */
    data class Snapshot(
        val headers: List<EntryHeader>,
        val entries: Map<String, PendingEntry>,
        val unreadable: List<Read.Unreadable>,
        val sequence: Long,
        val discardConfirmed: Set<String> = emptySet(),
        val discardUnfinished: Boolean = false,
    )

    /** One note's entry and the store-wide sequence, read together. */
    data class Observed(val read: Read, val sequence: Long)

    sealed class SaveOutcome {
        data class Saved(val version: Long) : SaveOutcome()
        /** The text is held (read-only, lost access, rejected, a repeated conflict, a note that could not be built): kept there, never pushed. The editor becomes a viewer. */
        data class SavedToHolding(val version: Long) : SaveOutcome()
        /**
         * A conflict gave the editor's text a new note, [noteUid], after the editor built this save for
         * the original. Nothing was written. The editor applies its text to that note and saves again.
         * The answer can repeat, since a copy can be replaced in turn: the save is not done, and the
         * editor must not report it or close, until a call returns something else.
         */
        data class Moved(val noteUid: String) : SaveOutcome()
        /** The existing entry cannot be read; it is never overwritten, so it can still be reported. */
        object Blocked : SaveOutcome()
        /** The note is larger than the store keeps ([PendingCodec.MAX_BLOB]); nothing was written. */
        object TooLarge : SaveOutcome()
    }

    sealed class SendOutcome {
        object Done : SendOutcome()
        /** The user changed the note while it was being sent; rebase this entry onto the landed item. */
        data class NewerLocalChange(val entry: PendingEntry) : SendOutcome()
    }

    /**
     * What every operation but [unsynced], [unsyncedInNotebook], [removalCheck], [discardStore], [acknowledged],
     * [clearedInFull], [clearStopped], [unregister], [unregisterIfFinishedOnce] and [clearAll] throws once
     * [clearAll], or a [discardStore] that got as far as deleting, has closed the store: nothing in it is read,
     * pushed, pruned or written from then on. An IllegalStateException, as before it had a type of its own.
     */
    class Cleared : IllegalStateException("the pending store was cleared")

    /**
     * What a rebase and a conflict copy throw, before anything is written, while a file the store's discard permit
     * names is there, or a permit that may be there cannot be read or was recorded as for an answer that could not be
     * counted ([nextRunVersion]). An IOException, so a run takes it for that entry's storage failure.
     */
    class HeldBack : IOException("a discard that has not finished holds back new versions")

    // ---- reading ----

    fun read(noteUid: String): Read = locked { readEntry(noteUid) }

    /**
     * Lists every entry. A committed file that cannot be read is reported in [Scan.unreadable], never deleted.
     * A listing that fails throws IOException: read as an empty store, it would hide every waiting change.
     */
    fun scan(): Scan = locked { scanOf(files(NOTE)) }

    private fun scanOf(noteFiles: List<File>): Scan {
        val entries = mutableListOf<PendingEntry>()
        val unreadable = mutableListOf<Read.Unreadable>()
        for (file in noteFiles) {
            when (val read = decodeFile(file)) {
                is Read.Present -> entries += read.entry
                is Read.Unreadable -> unreadable += read
                Read.Missing -> Unit
            }
        }
        unreadable += currentRecoveryProblems(entries.mapTo(HashSet()) { it.noteUid })
        return Scan(entries.sortedBy { it.noteUid }, unreadable.sortedBy { it.file })
    }

    /**
     * Like [scan], but keeps a blob only for the entries [keep] selects, so a screen that needs a few
     * blobs, or none, does not hold every one. Entries it does not keep are read by header alone
     * ([PendingCodec.decodeEntryHeader]), so their blobs are not read at all: a blob damaged after its
     * header was written counts by its header here, and is found by whatever reads the whole entry (the
     * notebook's own screen, the viewer, a push). A kept entry that fails its full read is reported with
     * the notebook its header names. [keep] runs under the store lock and must not take the Etebase
     * cache monitor or the cache's write fence. A listing that fails throws IOException, as in [scan].
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
                    val full = EntryHeader.of(e)
                    headers += full
                    if (keep(full)) kept[e.noteUid] = e
                }
                is Read.Unreadable -> unreadable += read.copy(notebookUid = header?.notebookUid)
                Read.Missing -> Unit
            }
        }
        unreadable += currentRecoveryProblems(headers.mapTo(HashSet()) { it.noteUid })
        val confirmed = permitNames()
        Snapshot(headers.sortedBy { it.noteUid }, kept, unreadable.sortedBy { it.file },
            currentSequence(strict = false),
            headers.filter { confirmed == null || noteFile(it.noteUid).name in confirmed }
                .mapTo(HashSet()) { it.noteUid },
            discardUnfinished = namedThere(confirmed))
    }

    /**
     * One note's entry with the store-wide sequence at the same moment. A load carries the sequence, so
     * an editor can drop any load older than its last save whether or not an entry existed.
     */
    fun observe(noteUid: String): Observed = locked { Observed(readEntry(noteUid), currentSequence(strict = false)) }

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
        }
    }

    // ---- editor operations ----

    /**
     * An editor save, through the editor's handle. [noteUid] is the note [blob] was built for. If a
     * conflict has given the editor's text a new note since ([replaceWithNewNote]), nothing is written
     * and the outcome names that note: the editor applies its text to the copy's item (its entry, or
     * its landed record once the copy has been pushed) and saves again. The store cannot take that
     * step, because a blob is encrypted for one item. So a save that still names the original never
     * writes a new entry for it, which would get the same 409 and become a second conflicted copy.
     * A handle that was closed still saves, so text is not lost to a save that arrives late, and it is
     * still redirected.
     */
    fun saveLocal(
        editor: EditorHandle,
        noteUid: String,
        notebookUid: String,
        revision: String,
        blob: ByteArray,
        isCreate: Boolean,
        notebookCopy: ByteArray? = null,
    ): SaveOutcome = locked {
        movedTo(editor, noteUid)?.let { return@locked SaveOutcome.Moved(it) }
        saveLocal(noteUid, notebookUid, revision, blob, isCreate, notebookCopy)
    }

    /** The note [editor]'s text belongs to now, when that is no longer [noteUid]. */
    private fun movedTo(editor: EditorHandle, noteUid: String): String? {
        require(editor.store === this) { "an editor of another store" }
        return editor.target.takeIf { it != noteUid }
    }

    /**
     * A save by note uid. An open editor saves through its handle instead (above), which is what keeps
     * a late save away from a note that a conflict copy replaced. Resets the failure backoff, since new
     * content may push where the old did not. [notebookCopy], when given, is written in the same step,
     * so no prune can remove it in between.
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
                }
                is Read.Unreadable -> {
                    outcome = SaveOutcome.Blocked
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
     * make a second copy.
     *
     * Neither is the copy, for as long as it carries its origin link. The link in the copy's own file is
     * the only record that the original was replaced. A copy that landed would be dropped together with
     * it, the original would then read as an ordinary pending edit, and its next 409 would make another
     * copy. Recovery clears the link as soon as the original is shown gone, so the copy waits only while
     * the removal keeps failing, the original cannot be read or cannot be shown gone, or the write that
     * clears the link fails (design 3.4). Each send refused for this reason has recovery look again before
     * the next operation, since an original that could not be read leaves no failed step behind to do that.
     */
    fun beginSend(noteUid: String): PendingEntry? = (startSend(noteUid) as? SendStart.Ready)?.entry

    /**
     * [beginSend] with the reason when nothing is sent, which the push step needs for the run's status. A note
     * whose entry file the store's discard permit names is not sent and its file is not touched: the user
     * confirmed its discard, and a discard that stopped keeps the permit until it finishes, while any save
     * withdraws it first ([withdrawPermit]), and a run makes no new version while a file it names is there
     * ([nextRunVersion]). A save or a release that fails after it withdrew the permit has released those notes as
     * well, as one that works does by design. While a permit may be there but cannot be read, or the permit was
     * recorded as for an answer that could not be counted, no note is sent ([permitNames]); a damaged one holds
     * nothing back. Once this instance has shown the permit gone, nothing is held back until a [discardStore],
     * which has it read the permit again.
     */
    fun startSend(noteUid: String): SendStart = locked {
        val confirmed = permitNames()
        if (confirmed == null || noteFile(noteUid).name in confirmed) {
            return@locked SendStart.Refused(Refusal.DISCARD_CONFIRMED)
        }
        if (noteUid in unfinishedOriginals) {
            recovered = false
            return@locked SendStart.Refused(Refusal.UNFINISHED_ORIGINAL)
        }
        var start: SendStart = SendStart.Refused(Refusal.NOTHING)
        update(noteUid) { read ->
            val e = (read as? Read.Present)?.entry
            when {
                read is Read.Unreadable -> {
                    start = SendStart.Refused(Refusal.UNREADABLE)
                    Change.Keep
                }
                e == null || e.state == PendingEntry.State.HELD -> Change.Keep
                e.origin != null -> {
                    recovered = false
                    start = SendStart.Refused(Refusal.LINKED_COPY)
                    Change.Keep
                }
                else -> {
                    val updated = e.withSent(e.revision)
                    start = SendStart.Ready(updated)
                    // The upload carries this version: no note saved again after its entry went may take it.
                    if (updated.version > highWater) highWater = updated.version
                    if (updated === e) Change.Keep else Change.Write(updated)
                }
            }
        }
        start
    }

    sealed class SendStart {
        /** The snapshot to upload, with its revision recorded as sent. */
        data class Ready(val entry: PendingEntry) : SendStart()
        data class Refused(val reason: Refusal) : SendStart()
    }

    enum class Refusal {
        /** No entry, or held text: nothing to push. */
        NOTHING,
        /** The entry's file cannot be read. */
        UNREADABLE,
        /** An original that a conflict copy has not finished replacing. */
        UNFINISHED_ORIGINAL,
        /** A conflict copy that still carries its origin link. */
        LINKED_COPY,
        /**
         * Text the store's discard permit names: the user confirmed its discard, which has not finished. Every note,
         * while a permit that may be there cannot be read, or the permit was recorded as for an answer that could not
         * be counted.
         */
        DISCARD_CONFIRMED,
    }

    /**
     * After a successful upload of the snapshot at [sentVersion]: keep the landed item while an editor
     * for the note is open, then drop the entry, unless the user changed the note meanwhile, in which
     * case the entry stays for a rebase. With no editor open nothing can start from the landed item, so
     * no full copy of the note is kept.
     *
     * An entry that stays loses the mark of a note made from a conflict, since the note is on the server
     * now (design 3.8). That write leaves the version where it is, as [hold] and [recordFailure] do, so
     * the rebase that follows still applies, and the outcome carries the entry as written. If the write
     * fails, the upload has still landed: the outcome carries the entry with its mark, and the rebase
     * clears it.
     */
    fun completeSend(noteUid: String, sentVersion: Long, revision: String, blob: ByteArray): SendOutcome = locked {
        if (hasEditor(noteUid)) {
            writeAtomically(landedFile(noteUid), PendingCodec.encodeLanded(LandedRecord(noteUid, revision, sentVersion, blob)))
        } else {
            remove(landedFile(noteUid))
        }
        val e = (readEntry(noteUid) as? Read.Present)?.entry
        when {
            e == null -> SendOutcome.Done
            e.version == sentVersion -> {
                remove(noteFile(noteUid))
                SendOutcome.Done
            }
            !e.fromConflict -> SendOutcome.NewerLocalChange(e)
            else -> {
                val unmarked = e.copy(fromConflict = false)
                try {
                    writeAtomically(noteFile(noteUid), PendingCodec.encodeEntry(unmarked))
                    SendOutcome.NewerLocalChange(unmarked)
                } catch (failed: IOException) {
                    SendOutcome.NewerLocalChange(e)
                }
            }
        }
    }

    /**
     * Replaces the entry's content with a rebase built from [expectedVersion] onto [onto], the server
     * revision the new blob has as its base; false if the entry moved on.
     *
     * [onto] is an upload of ours that landed, so the note is on the server and the mark of a note made
     * from a conflict is cleared. [onto] also moves to the newest end of the sent list, or joins it there
     * when it was matched through the landed record. Every rebase makes a new revision and the next send
     * appends it, so under a server that keeps answering 409 with the same copy of ours, the cap would
     * otherwise drop that copy's revision after about 31 runs, and the user's own text would then read
     * as another client's and become a conflicted copy (design 3.8). No other revision is removed here;
     * if [onto] joins a list that is already full, the cap drops the oldest one, as on any send.
     *
     * While a file the store's discard permit names is there, or a permit that may be there cannot be read or was
     * recorded as for an answer that could not be counted, it throws and writes nothing ([nextRunVersion]).
     */
    fun rebase(noteUid: String, expectedVersion: Long, onto: String, revision: String, blob: ByteArray): Boolean = locked {
        var applied = false
        update(noteUid) { read ->
            val e = (read as? Read.Present)?.entry
            if (e == null || e.version != expectedVersion || e.state == PendingEntry.State.HELD) Change.Keep else {
                applied = true
                Change.Write(e.withNewestSent(onto).copy(version = nextRunVersion(), revision = revision, blob = blob, fromConflict = false))
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
     * when the reason is about the content (a rejection, a repeated conflict, a note that could not be
     * built for its upload), so a newer change is not held with it; a reason about the notebook
     * (read-only, lost access, deleted) holds whatever is there. The mark of a note made from a
     * conflict stays through a hold.
     */
    fun hold(noteUid: String, reason: HeldReason, now: Long, sentVersion: Long? = null): HoldOutcome = locked {
        if (noteUid in unfinishedOriginals) {
            // Its text lives in the conflict copy now, which can be held in its own right. Held here as
            // well it would be the same text twice, and Try again would give it a new version, which
            // breaks the copy's link and sends the original as an ordinary edit.
            recovered = false
            return@locked HoldOutcome.UNFINISHED_ORIGINAL
        }
        var outcome = HoldOutcome.NOT_APPLIED
        update(noteUid) { read ->
            val e = (read as? Read.Present)?.entry
            when {
                e == null || e.state == PendingEntry.State.HELD || (sentVersion != null && e.version != sentVersion) -> Change.Keep
                else -> {
                    outcome = HoldOutcome.HELD
                    Change.Write(e.copy(state = PendingEntry.State.HELD, held = PendingEntry.Held(reason, now)))
                }
            }
        }
        outcome
    }

    enum class HoldOutcome {
        HELD,
        NOT_APPLIED,
        /** An original that a conflict copy has not finished replacing: nothing was written. */
        UNFINISHED_ORIGINAL,
    }

    /**
     * The user's "Try again" on held text: it waits for a push again, with a fresh backoff. Its base is
     * unchanged, so if the server copy moved on meanwhile the push conflicts and goes through the
     * conflict table rather than overwriting it. False when the note has no held entry.
     *
     * It also clears the mark of a note made from a conflict, for any hold reason. With the mark kept,
     * a conflict that is real would hold the text again on every tap. Without it the tap sends the text
     * through the conflict table once more, which costs at most one new note per tap (design 3.8).
     */
    fun release(noteUid: String): Boolean = locked {
        var applied = false
        update(noteUid) { read ->
            val e = (read as? Read.Present)?.entry
            if (e == null || e.state != PendingEntry.State.HELD) Change.Keep else {
                applied = true
                Change.Write(e.copy(state = PendingEntry.State.UPSERT, version = nextVersion(), held = null,
                    failureCount = 0, lastFailureAt = null, lastFailureCategory = null, fromConflict = false))
            }
        }
        applied
    }

    /**
     * The user's explicit discard of held or unreadable text. Throws, and discards nothing, when the text
     * is a conflict copy whose original is not shown gone and cannot be removed or read ([removeReplacedOriginal]).
     */
    fun discard(noteUid: String): Unit = locked { removeEntry(noteUid, (readEntry(noteUid) as? Read.Present)?.entry) }

    /**
     * Removes [noteUid]'s entry as the user's discard does, whose full read gave [entry], or null when it read as
     * missing or unreadable: a conflict copy takes the original it replaced with it ([removeReplacedOriginal]).
     */
    private fun removeEntry(noteUid: String, entry: PendingEntry?) {
        entry?.let { removeReplacedOriginal(it) }
        remove(noteFile(noteUid))
        // A conflict copy keeps its origin link, and so is not sent, while its original cannot be read.
        // If this was that original, the recovery before the next operation clears the link.
        recovered = false
    }

    /**
     * Before a conflict copy that still carries its origin link is removed (a discard), the original it
     * replaced goes first. The link is the only record of the replacement: with the copy gone, the
     * original would read as an ordinary pending edit again, be sent, get the same 409, and bring back
     * as another copy the text the user just removed. Throws, leaving the copy and its link in place,
     * when the original cannot be removed, cannot be read, or cannot be shown gone.
     */
    private fun removeReplacedOriginal(copy: PendingEntry) {
        val origin = copy.origin ?: return
        when (val original = readEntry(origin.noteUid)) {
            is Read.Present -> if (original.entry.version == origin.version && original.entry.revision == origin.revision) {
                moveEditors(origin.noteUid, copy.noteUid)
                remove(noteFile(origin.noteUid))
                remove(landedFile(origin.noteUid))
            }
            is Read.Unreadable -> throw IOException("the note this copy replaced cannot be read")
            Read.Missing -> Unit
        }
        // The replaced entry is gone, or what is there is a later entry of its own. Either way nothing
        // links to that note once the copy goes, so an edit of it is not held back from sending.
        unfinishedOriginals = unfinishedOriginals - origin.noteUid
    }

    /**
     * Resolves a conflict by giving the text a new note: [newNote] is written first, carrying an
     * origin, then the original is removed, then the origin is cleared. A crash after the first step
     * is finished by recovery. False when the original moved on or is not a plain edit.
     *
     * The new note carries the mark of a note made from a conflict ([PendingEntry.fromConflict]). Once
     * its file is written it owns the text, so the editors registered on the original are pointed at it
     * in the same step, under the lock: the copy can be pushed before an editor has rebound, and a save
     * that still named the original would otherwise write a new entry for it (design 3.2). The
     * original's landed record goes with its entry, since it no longer describes the server's copy.
     *
     * While a file the store's discard permit names is there, or a permit that may be there cannot be read or was
     * recorded as for an answer that could not be counted, it throws and writes nothing ([nextRunVersion]).
     */
    fun replaceWithNewNote(originalUid: String, expectedVersion: Long, serverRevision: String, newNote: PendingEntry): Boolean =
        locked {
            val e = (readEntry(originalUid) as? Read.Present)?.entry
            if (e == null || e.version != expectedVersion || e.state != PendingEntry.State.UPSERT) return@locked false
            require(newNote.noteUid != originalUid) { "a new note needs its own uid" }
            val copy = newNote.copy(version = nextRunVersion(), fromConflict = true,
                origin = PendingEntry.Origin(originalUid, e.revision, e.version, serverRevision))
            val copyFile = noteFile(copy.noteUid)
            try {
                writeAtomically(copyFile, PendingCodec.encodeEntry(copy))
            } catch (failed: IOException) {
                // The call fails, the original still owns the text, and the next run resolves the conflict
                // again. A complete write left behind would be committed by a later recovery, as a second
                // copy next to the one that run makes. A copy that was committed has no write left beside
                // it, so this asks nothing about the copy itself.
                File(dir, copyFile.name + NEW).delete()
                throw failed
            }
            moveEditors(originalUid, copy.noteUid)
            beforeOriginalRemovedForTesting?.invoke()
            remove(noteFile(originalUid))
            remove(landedFile(originalUid))
            writeAtomically(noteFile(copy.noteUid), PendingCodec.encodeEntry(copy.copy(origin = null)))
            true
        }

    // ---- landed records ----

    fun landed(noteUid: String): LandedRecord? = locked { readLanded(noteUid) }

    fun clearLanded(noteUid: String): Unit = locked { remove(landedFile(noteUid)) }

    /** An editor for [noteUid] opened. Each call is matched by one [editorClosed] with the handle it returned. */
    fun editorOpened(noteUid: String): EditorHandle = locked {
        EditorHandle(checkedUid(noteUid)).also { editors += it }
    }

    /**
     * [editor] closed. With no other editor open on its note, that note's landed record has no use and
     * goes. The note is the one the handle points at now, which is the copy after a conflict. A second
     * call does nothing. The handle is still redirected after this, for a save that arrives late, but
     * no landed record is kept for it: the editor should close only after its last save has returned
     * something other than Moved.
     */
    fun editorClosed(editor: EditorHandle): Unit = locked {
        require(editor.store === this) { "an editor of another store" }
        if (!editor.open) return@locked
        editor.open = false
        editors.remove(editor)
        closedEditors.removeAll { it.get() == null }
        closedEditors += WeakReference(editor)
        if (!hasEditor(editor.target)) remove(landedFile(editor.target))
    }

    /** Whether an open editor is on [noteUid]. Closed handles do not count. */
    private fun hasEditor(noteUid: String): Boolean = editors.any { it.target == noteUid }

    /** Points every handle on [from] at [to], open or closed: the text they edit lives in [to] now. */
    private fun moveEditors(from: String, to: String) {
        for (editor in editors) if (editor.target == from) editor.target = to
        for (closed in closedEditors) closed.get()?.let { if (it.target == from) it.target = to }
    }

    // ---- notebook copies ----

    fun putNotebook(notebookUid: String, blob: ByteArray): Unit = locked { putNotebookLocked(notebookUid, blob) }

    /**
     * The notebook's stored copy, or null when there is none or it does not decode. Throws when the copy
     * cannot be read, or cannot be shown not to be there ([readIfPresent]).
     */
    fun notebook(notebookUid: String): ByteArray? = locked {
        val bytes = readIfPresent(notebookFile(notebookUid)) ?: return@locked null
        (PendingCodec.decodeNotebook(bytes) as? PendingCodec.Decoded.Ok)?.value?.second
    }

    /**
     * Removes notebook copies no entry references, decided from one listing: a listing that reads as
     * empty then has no copy to remove either. Skipped entirely while anything is unreadable, since its
     * notebook is unknown and its copy may be the only way to decrypt it, and while the listing holds a
     * first write that is not committed yet ("<uid>.note.new"), which may be the only copy of a note
     * whose notebook no committed entry names. A listing that fails throws, as every listing of the store
     * does, and nothing is removed. Skipped as well while a file the store's discard permit names is there, or a
     * permit that may be there cannot be read or was recorded as for an answer that could not be counted
     * ([Snapshot.discardUnfinished]): the listing can come back short and leave out such a file, whose notebook
     * copy may be the only key to its text once a save withdraws the permit. Skipping a prune is always safe.
     *
     * It runs no recovery: while one is owed, it lists and removes nothing and returns at once. The runner
     * only logs a prune that fails, so a recovery that failed here would be logged and nothing more. The
     * next other call runs it instead, at the latest the snapshot of the next run, where a failure counts.
     */
    fun pruneNotebooks(): List<String> = synchronized(lock) {
        if (closed) throw Cleared()
        if (!recovered) emptyList() else locked {
            if (namedThere(permitNames())) return@locked emptyList()
            val listed = listing()
            if (listed.any { it.name.endsWith(NOTE + NEW) }) return@locked emptyList()
            val scan = scanOf(withSuffix(listed, NOTE))
            if (scan.unreadable.isNotEmpty()) return@locked emptyList()
            val referenced = scan.entries.map { it.notebookUid }.toSet()
            withSuffix(listed, NOTEBOOK).filter { it.isFile }.map { it.name.removeSuffix(NOTEBOOK) }
                .filter { it !in referenced }
                .onEach { remove(notebookFile(it)) }
        }
    }

    // ---- the whole store ----

    /**
     * Test teardown only: everything for this identity goes, with no count, confirmation or permit, so no
     * production code calls it. Sign-out clears through [discardStore]. The closed instance stays registered
     * for the rest of the process, so a late save that opens the store again gets this instance and is
     * refused instead of recreating the directory. A call after a failed one tries the deletion again.
     *
     * It returns only once the directory is shown gone by two checks that agree ([shownGone]). Otherwise it
     * throws IOException, whatever the deletion answered, since the deletion counts a file it could not
     * remove as gone when File.exists() says so, and that answers false for a check that failed as well. A
     * caller may rely on a clear only when it returned, and a run takes the store for cleared in full only then
     * ([clearedInFull]). A clear writes the store, so it withdraws the store's acknowledgement first
     * ([acknowledged]), and throws before anything goes when that cannot be shown. While the folder is a link, or
     * lstat cannot tell ([followable]), it throws before that and deletes nothing, since the deletion would follow a
     * link to a directory.
     */
    fun clearAll() {
        synchronized(lock) {
            checkNotDropped()
            closed = true
            beforeClearForTesting?.invoke()
            if (!followable()) throw IOException(LINKED)
            withdrawAcknowledgement()
            dir.deleteRecursively()
            if (!shownGone(dir)) throw IOException("could not clear the pending store")
            clearReturned = true
            finishes++
        }
    }

    /**
     * What removing this identity's account would lose, read from the directory alone. Like [acknowledged], and
     * unlike every other read, it runs no recovery, and it writes nothing in the store. A cleared store answers
     * too, until it is dropped ([unregister]), from what is still on disk: a clear that failed may have left
     * text there.
     *
     * Counted: each note with an entry file (waiting, held, or one this build cannot read), and each first
     * write that never got its name and is intact, which recovery would commit. Not counted: a first write
     * that is cut short or fails its checksum, and an uncommitted write beside an entry, which recovery
     * drops, and notebook copies and landed records, which hold no unsynced text. No entry is decoded while
     * the counter file reads.
     *
     * The sequence is the one [nextVersion] builds on: the counter, or with the counter lost, cut short or
     * failing its checksum, the strict rebuild ([currentSequence]) from every file that may hold a version
     * (each entry's header, each landed record, each intact uncommitted write), and never below [highWater],
     * what this instance has read or handed out or a dropped one had. A counter written in full in a layout
     * this build does not know, a version that cannot be read, and a file of a kind this build does not know
     * stop that rebuild, since a newer build may have handed out versions above all of them.
     *
     * A directory that cannot be listed, a read in it that fails, a version that the rebuild cannot read,
     * and a file of a kind this build does not know, whether or not the counter reads, answer "could not be
     * counted" ([UnsyncedNotes.unreadable]), not "nothing": such a file may hold text a newer build wrote. A
     * directory that cannot be listed, and is not shown gone, answers so with [UnsyncedNotes.listed] false, and
     * a caller words its confirmation from that as an acknowledgement ([DiscardOutcome.Acknowledged]). Only a
     * directory shown not to be there by two checks that agree ([shownGone]) lists as empty. After a failed
     * read, or beside a file of an unknown kind, every entry file and every "<uid>.note.new" counts by its name,
     * whatever its state, so the number is of files and one note can count twice. Such an answer still carries
     * the sequence when [nextVersion] could read it, so a save since moves it, and otherwise [highWater]
     * ([uncountedSequence]).
     *
     * A listing that works can still come back short: File.listFiles returns what it read so far, or nothing,
     * when reading the directory fails partway, and does not say so. A listing that lacks the store's counter
     * while its presence check, by path, does not show it absent is taken for such a listing, and the answer is
     * "could not be counted" ([shortOfCounter]): every version is written to the counter before its entry, so a
     * store that holds an entry lists its counter unless the counter was lost. That catches a listing that came
     * back empty or stopped before the counter, and no other: a count can still be low, and an answer of nothing
     * can still come from a listing that skipped an entry and listed the counter, or from a store whose counter
     * was lost, so a caller must not take it for proof that nothing would be lost. A discard stays within what
     * was confirmed all the same, since an answer names what it counted ([UnsyncedNotes.names]) and a
     * confirmation covers no name it does not hold.
     *
     * A listing that works, or a directory shown gone, withdraws the store's acknowledgement, which holds only
     * while the store cannot be listed ([acknowledged]); while that cannot be shown, the store is listed but
     * the answer is "could not be counted", an empty store's included.
     *
     * A folder that is a link, or whose lstat cannot tell ([followable]), is not listed and nothing in it is read,
     * the counter included: the answer is that it could not be counted, with [UnsyncedNotes.listed] false, no
     * names, and [highWater] for its sequence, and the acknowledgement is not withdrawn.
     */
    fun unsynced(): UnsyncedNotes = synchronized(lock) {
        checkNotDropped()
        countUnsynced().answer
    }

    /** An answer of [unsynced], and the names it was counted from: null when the store could not be listed. */
    private class Count(val answer: UnsyncedNotes, val names: List<String>?)

    /** [unsynced], under the store lock. */
    private fun countUnsynced(): Count {
        if (!followable()) return Count(UnsyncedNotes(0, highWater, unreadable = true, listed = false), names = null)
        val listed = listDirectory(dir)
        if (listed == null && !shownGone(dir)) {
            return Count(UnsyncedNotes(0, uncountedSequence(), unreadable = true, listed = false), names = null)
        }
        val names = listed.orEmpty().map { it.name }
        val answer = try {
            withdrawAcknowledgement()
            countOf(names)
        } catch (e: IOException) {
            uncountedOf(names)
        }
        return Count(answer, names)
    }

    /**
     * What [names], from a listing of the store that worked, hold that has not synced; throws when it cannot count,
     * a listing that came back short by the store's own counter included ([shortOfCounter], or [short] when the
     * caller asked it already).
     */
    private fun countOf(names: List<String>, short: Boolean = shortOfCounter(names)): UnsyncedNotes {
        if (short) throw IOException("the listing of the store left out its counter")
        val unknown = names.firstOrNull { !isKnownKind(it) }
        if (unknown != null) throw IOException("$unknown is of a kind this build does not know")
        // Each note by its entry's name, which a first write takes when it is committed.
        val committed = names.filterTo(HashSet()) { it.endsWith(NOTE) }
        val stranded = names.filter { it.endsWith(NOTE + NEW) }.map { it.removeSuffix(NEW) }
            .filter { it !in committed && PendingCodec.isIntact(File(dir, it + NEW).readBytes()) }
        val counted = committed + stranded
        return if (counted.isEmpty()) UnsyncedNotes.NOTHING
        else UnsyncedNotes(counted.size, currentSequence(strict = true), unreadable = false, names = counted)
    }

    /** The answer for [names], a listing of the store that worked, when what they hold could not be counted. */
    private fun uncountedOf(names: List<String>): UnsyncedNotes {
        val files = names.count { it.endsWith(NOTE) || it.endsWith(NOTE + NEW) }
        return UnsyncedNotes(files, uncountedSequence(), unreadable = true, names = uncountedNames(names))
    }

    /**
     * Whether [names], from a listing of the store that worked, came back short by the store's own counter: they lack
     * [SEQUENCE] while its presence check, by path, does not show it absent. Every version is written to the counter
     * before its entry ([nextVersion]), and a discard removes the counter last ([deleteAll]), so a store that holds an
     * entry lists its counter unless the counter was lost. A lost one is absent by lstat, and nothing is refused for
     * it, nor for a store never made or an empty folder; a check that fails counts the counter as there. One check by
     * path: it catches a listing that came back empty, or stopped before it reached the counter, not one that skipped
     * an entry and still listed the counter.
     */
    private fun shortOfCounter(names: List<String>): Boolean =
        SEQUENCE !in names && presenceOf(File(dir, SEQUENCE)) != Presence.ABSENT

    /**
     * What [removalCheck] found. Only [Clean], [Covered] and [Acknowledged] say that a removal of the account loses
     * nothing that was not confirmed; the guard that asks decides what the others mean. Like an answer of nothing
     * from [unsynced], [Clean] and [Covered] rest on one listing of the store, checked against the store's counter by
     * path, which can still come back short without saying so: they are the most one check can show, not proof that
     * nothing would be lost.
     */
    sealed class RemovalCheck {
        /** The store listed, or is shown gone, and holds nothing a count counts; its acknowledgement is shown gone. */
        object Clean : RemovalCheck()

        /** The store holds something, and the permit of a confirmed discard covers all of it. */
        object Covered : RemovalCheck()

        /** The store cannot be listed, or is a link, and an acknowledgement of that holds ([acknowledged]). */
        object Acknowledged : RemovalCheck()

        /**
         * The store holds [answer], or that cannot be ruled out, and no permit covers it, or a listing that lacks the
         * store's counter lists a note ([removalCheck], step 4).
         */
        data class Blocks(val answer: UnsyncedNotes) : RemovalCheck()

        /**
         * The store cannot be listed, is not shown gone, and is there or its presence cannot be told, or its folder is
         * a link, or lstat cannot tell ([followable]).
         */
        object Unlisted : RemovalCheck()

        /**
         * The store cannot be listed and is not shown gone, but its presence check answers [Presence.ABSENT], which is
         * ENOENT alone, asked in the same hold of the store lock as the failed listing: one check, not the two that
         * show a directory gone ([shownGone]). The folders above do not show it gone, as while notes-pending is there
         * but cannot be listed; a notes-pending or no_backup that is missing under a folder that lists shows it gone,
         * and the store is counted ([Clean] or [NothingUnwithdrawn]). A removal guard may take this answer as nothing
         * to lose for one removal of the account whose creation id names this store. [clearAll], [discardStore] and
         * any sweep never take it for gone.
         */
        object UnlistedAbsent : RemovalCheck()

        /**
         * The store listed, or is shown gone, and holds nothing a count counts, but its acknowledgement could not be
         * shown gone, as while notes-discard is there but cannot be listed.
         */
        object NothingUnwithdrawn : RemovalCheck()
    }

    /**
     * What a removal of this identity's account would lose, decided in one hold of the store lock, for a guard of
     * account removals. Like [unsynced], it runs no recovery, writes nothing in the store, and answers on a cleared
     * instance too; it calls no function of the caller's.
     *
     * 1. When the folder is a link, or lstat cannot tell ([followable]), it is not listed and nothing in it is read:
     *    [RemovalCheck.Acknowledged] when an acknowledgement holds for the link's own identity, else
     *    [RemovalCheck.Unlisted], never [RemovalCheck.UnlistedAbsent] or [RemovalCheck.Clean]. No permit is read, and
     *    the acknowledgement is not withdrawn.
     * 2. When the directory cannot be listed and is not shown gone, nothing is counted: [RemovalCheck.Acknowledged]
     *    when an acknowledgement holds, asked right after that listing as [acknowledged] asks it, else
     *    [RemovalCheck.UnlistedAbsent] when the directory's own presence check answers [Presence.ABSENT] (ENOENT
     *    alone, one check, in the same hold of the lock), else [RemovalCheck.Unlisted]. A presence check that fails is
     *    no absence, and leaves no identity to bind an acknowledgement to. A guard may take
     *    [RemovalCheck.UnlistedAbsent] as nothing to lose for one removal of the account this store is for;
     *    [clearAll], [discardStore] and any sweep never take it for gone.
     * 3. Otherwise the store's acknowledgement is withdrawn, as a count withdraws it. When that cannot be shown, this
     *    instance takes none for valid from then on, and the store is counted all the same, unless a note needs its
     *    counter rebuilt ([currentSequence]): the rebuild's own listing then fails at the same withdrawal, and the
     *    store could not be counted.
     * 4. The store is counted as [unsynced] counts it, from that one listing, which can come back short. A listing
     *    that lacks the store's counter while lstat does not show the counter gone counts as short, and the store as
     *    one that could not be counted ([shortOfCounter]); one that skipped an entry and still listed the counter is
     *    taken as it comes. Holding nothing, it answers [RemovalCheck.Clean], or [RemovalCheck.NothingUnwithdrawn]
     *    when step 3 failed, and no permit is read. A listing that lacks the counter and lists a note answers
     *    [RemovalCheck.Blocks], and no permit is read either: before the counter check such a listing gave a counted
     *    answer, unless a file of a kind this build does not know stopped the count, and a permit recorded as for an
     *    answer that could not be counted, also one recorded so while the user confirmed a counted answer (step 5),
     *    never covers a counted answer.
     * 5. Holding anything else, it answers [RemovalCheck.Covered] when the store's permit, read by path, covers the
     *    answer ([UnsyncedNotes.covers]), else [RemovalCheck.Blocks]. A permit that cannot be read is none. A permit
     *    recorded as for an answer that could not be counted covers no counted answer, and a discard records its permit
     *    so in place of such a permit or of one that cannot be read, whatever its own count showed ([discardStore],
     *    step 3): while what a discard that stopped under such a permit left counts, the answer is
     *    [RemovalCheck.Blocks]. Such a permit does cover an answer that could not be counted at its sequence, with no
     *    more files and no name it lacks, such as a listing that lacks the counter and lists no note: the answer is
     *    then [RemovalCheck.Covered], whatever that listing left out, also for a permit recorded so in place of another
     *    while the user confirmed a counted answer.
     */
    fun removalCheck(): RemovalCheck = synchronized(lock) {
        checkNotDropped()
        if (!followable()) {
            return@synchronized if (holdsAcknowledgement()) RemovalCheck.Acknowledged else RemovalCheck.Unlisted
        }
        val listed = listDirectory(dir)
        if (listed == null && !shownGone(dir)) {
            return@synchronized when {
                holdsAcknowledgement() -> RemovalCheck.Acknowledged
                presenceOf(dir) == Presence.ABSENT -> RemovalCheck.UnlistedAbsent
                else -> RemovalCheck.Unlisted
            }
        }
        val names = listed.orEmpty().map { it.name }
        val withdrawn = try {
            withdrawAcknowledgement()
            true
        } catch (e: IOException) {
            false
        }
        val short = shortOfCounter(names)
        val answer = try {
            countOf(names, short)
        } catch (e: IOException) {
            uncountedOf(names)
        }
        when {
            !answer.anything -> if (withdrawn) RemovalCheck.Clean else RemovalCheck.NothingUnwithdrawn
            // Before the counter check such a listing gave a counted answer, unless a file of an unknown kind stopped
            // the count, and a permit recorded as for an answer that could not be counted never covered that: a note
            // it lists is not taken as covered now either.
            short && answer.count > 0 -> RemovalCheck.Blocks(answer)
            permits.read(dir.name)?.covers(answer) == true -> RemovalCheck.Covered
            else -> RemovalCheck.Blocks(answer)
        }
    }

    /**
     * Test seam: records a permit for what the store holds now, by its count alone, and deletes nothing and leaves the
     * store open; the next new version withdraws it, as it withdraws a discard's. A confirmed discard ([discardStore],
     * step 3) also names what its confirmation and a permit from before named, and records its permit as for an answer
     * that could not be counted in place of such a permit or of one that cannot be read; this seam does neither, so it
     * is for a store with no permit. Unit tests call it to cover a store before they check a removal. It covers the
     * store with no confirmation, so no main code may call it.
     */
    @VisibleForTesting
    internal fun coverForTesting(): UnsyncedNotes = synchronized(lock) {
        checkNotDropped()
        permitWithdrawn = false
        val now = countUnsynced().answer
        if (now.anything) permits.record(dir.name, now)
        now
    }

    /**
     * The names an answer that could not be counted gives what in [listed] may hold unsynced text: each entry
     * file and first write by its entry's name, and each file of a kind this build does not know by its own.
     */
    private fun uncountedNames(listed: List<String>): Set<String> =
        listed.filter { it.endsWith(NOTE) || it.endsWith(NOTE + NEW) || !isKnownKind(it) }
            .mapTo(HashSet()) { if (it.endsWith(NOTE + NEW)) it.removeSuffix(NEW) else it }

    /**
     * The sequence of an answer that could not be counted: the one [nextVersion] builds on, so a save
     * between two such answers moves it. When that cannot be read, [highWater]: no new version can be
     * handed out while it cannot, since [nextVersion] reads it the same way, but the counter can read again
     * between two answers, and a save then moves this on too. 0 only in an instance that has read and
     * handed out none and follows no dropped instance, as after a restart. A counter file that reads needs no
     * listing, so a store that cannot be listed carries it too.
     */
    private fun uncountedSequence(): Long = try {
        currentSequence(strict = true)
    } catch (e: IOException) {
        highWater
    }

    sealed class DiscardOutcome {
        /**
         * The directory is shown gone, and its removal is synced. Its permit was removed, or is left for a new
         * version to withdraw.
         */
        object Done : DiscardOutcome()

        /**
         * The store holds what the confirmation does not cover, or it lists now where the confirmation was for a
         * store that could not be listed, or the reverse: [now]. Nothing was written or deleted.
         */
        data class Changed(val now: UnsyncedNotes) : DiscardOutcome()

        /**
         * The permit could not be recorded, and nothing was deleted. A permit may still be on disk: one from
         * before this call, which stays unless it was shown not there, also when it cannot be read, or this call's
         * own, when the record failed after its rename and was not taken back. Either covers only what the user
         * confirmed, until the next new version withdraws it.
         */
        object PermitNotRecorded : DiscardOutcome()

        /**
         * The deletion stopped, the directory is not shown gone, or its removal could not be synced (step 6 of
         * [discardStore]). A permit recorded for it stays. While it still covers what is left (step 5), a later
         * call can finish; otherwise that call gives [Changed], and the user is asked again. Also the answer,
         * with nothing recorded or deleted, while the directory cannot be listed in an instance that a clear or
         * a discard closed and that is not cleared in full (step 2): a later call can finish once it lists.
         */
        object NotFinished : DiscardOutcome()

        /**
         * The store's directory cannot be listed, so nothing in it was deleted, and an acknowledgement was
         * recorded instead of a permit ([acknowledged]): the user was shown that the store could not be counted
         * and went on. It is not a discard and no permit. It deletes nothing now and is never authority for a
         * deletion later: a later [discardStore] counts the store again and needs a confirmation of what it
         * finds. A confirmation given for a store that could not be listed ([UnsyncedNotes.listed] false) covers
         * no answer from a store that lists, so once the store lists, the user is asked again with what it
         * holds, and a permit of its own is recorded before anything goes. discardStore does not close the
         * instance here. It is never the answer of an instance that [clearAll] or an earlier discard closed and
         * that is not cleared in full ([clearedInFull]): that clear or discard may have deleted, so the answer
         * there is [NotFinished], and nothing is recorded.
         *
         * The confirmation's text is the caller's, chosen from [UnsyncedNotes.listed] before it asks. It must not
         * call this a discard, and must say that nothing was deleted, and that unsynced text may remain on this
         * device and may no longer sync. A caller that removes an account only after a verified clear keeps the
         * account.
         */
        object Acknowledged : DiscardOutcome()

        /**
         * The store's directory cannot be listed, and no acknowledgement holds for this instance: the
         * directory's identity cannot be read, or the record failed. Nothing was deleted. A record that reached
         * the disk before a later step failed is withdrawn when it can be; one left behind, because its removal
         * failed or was not made durable before a power loss, can read as held for a new instance after a
         * restart, until a listing or write of the store removes it, and it still stops holding as
         * [acknowledged] says.
         */
        object AcknowledgementNotRecorded : DiscardOutcome()
    }

    /**
     * The user's confirmed discard of everything in this store. [confirmed] is the answer of [unsynced] the
     * user was shown, or null when nothing was shown. It all happens in one hold of the store lock, the lock
     * every write takes, so a save either comes first and is counted, or comes once the store is closed and
     * is refused. It runs no recovery, and it runs on a cleared instance too, so a discard that stopped can
     * be finished.
     *
     * 1. The store is counted again from disk. When anything is there that [confirmed] does not cover,
     *    nothing is written or deleted ([DiscardOutcome.Changed]). That includes a note it does not name, and an
     *    answer from a listed store where [confirmed] was for one that could not be listed, or the other way
     *    round ([UnsyncedNotes.covers]); for a listed store, an answer of nothing as well, so notebook copies,
     *    landed records, the counter and first writes cut short are not deleted under an acknowledgement.
     * 2. When the store's directory cannot be listed, and is not shown gone, nothing is deleted. An
     *    acknowledgement bound to that directory is recorded instead, never a permit
     *    ([DiscardOutcome.Acknowledged], [acknowledged]), and discardStore does not close the instance. When the
     *    directory's identity cannot be read, or the record fails, no acknowledgement holds for this instance,
     *    though one that reached the disk may read as held for a new one
     *    ([DiscardOutcome.AcknowledgementNotRecorded]). A folder that is a link, or whose lstat cannot tell, is
     *    never listed ([unsynced]), so it gets this step alone, bound to the link's own identity under its own name.
     *    In an instance that [clearAll] or an earlier discard closed and that is not cleared in full
     *    ([clearedInFull]), nothing is recorded ([DiscardOutcome.NotFinished]): that clear or discard may have
     *    deleted, and an acknowledgement would let a caller say that nothing was.
     * 3. When anything is there, a permit for it is recorded ([PendingNotesDiscardPermits.record]) before any
     *    file goes. Besides what the count names, it names what [confirmed] and a permit from before name: the
     *    count's listing can come back short and leave out a note the user confirmed, whose text must still not
     *    be sent ([startSend]). A permit for an answer that could not be counted holds back every note of the
     *    store all the same, since the user confirmed the discard of all of it ([permitNames]), and so does one
     *    recorded in place of such a permit from before, or of one that cannot be read, which may be such a
     *    permit, whatever this count shows: it is recorded as for an answer that could not be counted. A permit
     *    from before is still there only while no new version has withdrawn it, so what it names is still text the
     *    user confirmed. Those names delete nothing in this call: what goes is still what the count's listing held
     *    (step 5). A permit from before that cannot be read names nothing here, and this one takes its place all
     *    the same, so that a lasting read failure does not refuse the sign-out. When the record fails,
     *    nothing is deleted ([DiscardOutcome.PermitNotRecorded]), though a permit may be left for the next new
     *    version to withdraw, and a permit from before stays unless its presence check shows it not there
     *    ([PendingNotesDiscardPermits.mayHold]), read or not.
     * 4. The instance is closed for the rest of the process, as by [clearAll]: every operation but [unsynced],
     *    [unsyncedInNotebook], [removalCheck], [discardStore], [unregister], [unregisterIfFinishedOnce],
     *    [acknowledged], [clearedInFull], [clearStopped] and [clearAll] is refused.
     * 5. The files the count listed go ([deleteAll]), each of a kind this build writes with its write beside it, in
     *    this order: entries and first writes, landed records, then, once a second listing works (or the directory
     *    is shown gone) and shows no note and nothing the count's listing did not hold, notebook copies and anything
     *    else, the counter, then the directory. With the counter last, while the counter file reads, what a
     *    discard that stopped leaves keeps its sequence and the count only falls, so its permit still covers
     *    it. With the counter lost, cut short or failing its checksum, the sequence is rebuilt from what is left
     *    and, in a new instance after a restart, can fall, and an answer that could not be counted can become a
     *    counted one once the file that stopped the count is gone. The permit then no longer covers the store:
     *    the next call gives [DiscardOutcome.Changed], and the user is asked again. So does a note that a short
     *    listing left out of the count and a later listing shows, since the confirmation does not name it. The
     *    removal of the directory is synced in step 6, not here, since a later call finds it gone.
     * 6. [DiscardOutcome.Done] only once the directory is shown gone by two checks that agree ([shownGone]) and
     *    its removal is synced into the directory above it ([syncRemoval]), whether this call removed it or an
     *    earlier one did and failed at that sync: until then a power loss can undo the removal. Only then is the
     *    permit removed; a removal that fails then is logged, and the permit is left for the next new version to
     *    withdraw. Otherwise, a failed removal or sync included, the permit stays ([DiscardOutcome.NotFinished]).
     */
    fun discardStore(confirmed: UnsyncedNotes?): DiscardOutcome = synchronized(lock) {
        checkNotDropped()
        // Whatever happens below may leave a permit on disk, so the next new version withdraws it again.
        permitWithdrawn = false
        val count = countUnsynced()
        val now = count.answer
        // A confirmation given as an acknowledgement is no authority for a deletion, also once the store lists and
        // holds nothing it counts: what is left is not deleted under it.
        if (confirmed != null && confirmed.listed != now.listed) return@synchronized DiscardOutcome.Changed(now)
        if (now.anything && (confirmed == null || !confirmed.covers(now))) {
            return@synchronized DiscardOutcome.Changed(now)
        }
        val names = count.names ?: return@synchronized acknowledge()
        if (now.anything) {
            // Told by path, not by a read: a permit from before whose read fails is still there, and may be what
            // holds back the text the user confirmed.
            val earlierThere = permits.mayHold(dir.name)
            // A permit from before that cannot be read names nothing here, and this one takes its place all the same.
            val found = permits.lookup(dir.name)
            val earlier = (found as? PendingNotesDiscardPermits.Lookup.Found)?.permit
            // A recount whose listing came back short can leave out a note the user confirmed, now or for a discard
            // that stopped, so the permit names it too, and its text stays held back.
            val heldBack = now.names + earlier?.names.orEmpty() + confirmed?.names.orEmpty()
            // A permit from before for an answer that could not be counted holds back every note, which the user
            // confirmed the discard of, and so does one that cannot be read, which may be such a permit. So the one
            // that replaces either does too, whatever this count shows.
            val holdsAll = earlier?.unreadable == true || found == PendingNotesDiscardPermits.Lookup.Unknown
            try {
                permits.record(dir.name, now.copy(unreadable = now.unreadable || holdsAll, names = heldBack))
            } catch (e: IOException) {
                // A permit from before, such as the one a discard that stopped keeps, covers what is left, so it
                // stays, read or not, and so does one this call put in its place. Otherwise one that reached the
                // disk before a later step failed goes, when it can.
                if (!earlierThere) {
                    try {
                        permits.remove(dir.name)
                    } catch (left: IOException) {
                        // Then it covers only what the user confirmed, until the next new version withdraws it.
                    }
                }
                return@synchronized DiscardOutcome.PermitNotRecorded
            }
        }
        closed = true
        try {
            beforeClearForTesting?.invoke()
            deleteAll(names)
            if (!shownGone(dir)) return@synchronized DiscardOutcome.NotFinished
            syncRemoval()
        } catch (e: IOException) {
            return@synchronized DiscardOutcome.NotFinished
        }
        discarded = true
        finishes++
        try {
            permits.remove(dir.name)
        } catch (e: IOException) {
            // It is for a directory that is gone, and the next new version withdraws it, or a later discard that
            // finishes removes it. Until then a store opened again in that folder, as after an account removal that
            // fails, holds back by it: for one recorded as for an answer that could not be counted, every note, so
            // each of its runs records a storage failure.
            Logger.log.warning("Pending notes discard permit could not be removed")
        }
        DiscardOutcome.Done
    }

    /**
     * Removes every file of the store in [listed] ([removeListed]), the listing the count was made from, in the
     * order [discardStore] gives, then the directory. A listing can come back short, so a note it left out may
     * still be there, and with it the notebook copy that note needs once the Etebase cache drops the notebook. So
     * after the entries, first writes and landed records, the directory is listed again, and the notebook copies,
     * the counter and the rest go only when that listing holds no note and nothing the first one did not hold;
     * otherwise this throws and they stay. Two listings that come back short the same way still get past it. A file
     * the listings did not hold, other than a write beside a listed file of a kind this build writes, keeps the
     * directory, which is then not shown gone.
     *
     * The removal of the directory is not synced here, since this call finds the directory already gone when an
     * earlier one removed it and then failed at that sync: [discardStore] syncs it once the directory is shown
     * gone, whoever removed it ([syncRemoval]).
     */
    private fun deleteAll(listed: List<String>) {
        val held = listed.toHashSet()
        val names = listed.map { it.removeSuffix(NEW) }.distinct().sorted()
        val (entries, rest) = names.partition { it.endsWith(NOTE) }
        val (landed, others) = rest.partition { it.endsWith(LANDED) }
        for (name in entries + landed) removeListed(name, held)
        val again = listDirectory(dir)
            ?: if (shownGone(dir)) emptyArray() else throw IOException("the store could not be listed again")
        again.firstOrNull { it.name.endsWith(NOTE) || it.name.endsWith(NOTE + NEW) || it.name !in held }?.let {
            throw IOException("${it.name} is in the store after its notes went")
        }
        for (name in others.filter { it != SEQUENCE } + others.filter { it == SEQUENCE }) removeListed(name, held)
        dir.delete()
    }

    /**
     * Removes what [held] holds of [name] and of its write ("<name>.new"), and the write beside a listed file of a
     * kind this build writes, listed or not ([remove]): that write is of the same note, notebook copy, landed record
     * or counter. Anything else goes only as listed, so a write whose file was not listed goes alone, and an
     * unlisted write beside a file of a kind this build does not know stays.
     */
    private fun removeListed(name: String, held: Set<String>) {
        if (name in held && isKnownKind(name) && !isKnownWrite(name)) return remove(File(dir, name))
        if (name in held) removeExactly(File(dir, name))
        if (name + NEW in held) removeExactly(File(dir, name + NEW))
    }

    /**
     * Step 2 of [discardStore]: the acknowledgement of this store, bound to its directory's identity now. When
     * the record fails, whatever may have reached the disk is withdrawn when it can be, and this instance
     * takes none for valid until it records one. An instance whose clear or discard stopped ([clearStopped]:
     * closed, and not cleared in full) records none and answers [DiscardOutcome.NotFinished]: what closed it
     * may have deleted, and an acknowledgement would let a caller say that nothing was.
     */
    private fun acknowledge(): DiscardOutcome {
        if (clearStopped()) return DiscardOutcome.NotFinished
        val now = identityOf(dir) ?: return DiscardOutcome.AcknowledgementNotRecorded
        try {
            permits.acknowledge(dir.name, now)
        } catch (e: IOException) {
            acknowledgementVoid = true
            acknowledgementWithdrawn = false
            try {
                permits.withdrawAcknowledgement(dir.name)
                acknowledgementWithdrawn = true
            } catch (left: IOException) {
                // The next listing or write of the store tries again.
            }
            return DiscardOutcome.AcknowledgementNotRecorded
        }
        acknowledgementVoid = false
        acknowledgementWithdrawn = false
        return DiscardOutcome.Acknowledged
    }

    /**
     * Whether this store has an acknowledgement that still holds ([DiscardOutcome.Acknowledged]), read without
     * listing the store: for a caller that was just told the store could not be counted, such as a refusal of
     * an account removal. It never stands for a count and is never authority for a deletion. Since it does not
     * list, a caller asks it only right after [unsynced] answered that the store could not be listed
     * ([UnsyncedNotes.listed] false), in the same decision; asked on its own, it can still answer true for a
     * store that would list now.
     *
     * The acknowledgement is bound to this store's directory: it is kept under the directory's name, which the
     * record names as well, with the identity the directory had when it was recorded ([DirectoryIdentity]), for a
     * folder that is a link the link's own, read without following it. It holds for no other store, and it stops
     * holding:
     * - once a listing of the store works, or shows the directory gone, a count included: that listing removes
     *   it, so a later state in which the store cannot be listed needs a new one;
     * - once anything is written to the store or removed from it: every write and removal this build makes
     *   removes it first, and fails when that cannot be shown;
     * - once the directory is replaced: its identity is no longer the recorded one, or cannot be read, and the
     *   record is passed over until a listing or a write of the store removes it.
     * An instance that has listed or written the store since takes none for valid, also while a removal that
     * failed left the record on disk. An instance that a clear or a discard closed and that is not cleared in
     * full records none ([discardStore], step 2).
     */
    fun acknowledged(): Boolean = synchronized(lock) {
        checkNotDropped()
        holdsAcknowledgement()
    }

    /** [acknowledged], under the store lock. */
    private fun holdsAcknowledgement(): Boolean {
        if (acknowledgementVoid) return false
        val recorded = permits.acknowledgement(dir.name) ?: return false
        return recorded == identityOf(dir)
    }

    /**
     * Whether a clear of this instance finished: [clearAll] returned, or [discardStore] gave [DiscardOutcome.Done].
     * Told by this instance's state alone, never by a listing or a count, which can come back short, and an unlink
     * whose sync failed can come back. So a clear or a discard that stopped answers false for the rest of the
     * process, also once nothing is left to list, until another one finishes. It reads memory only, so it answers on
     * a cleared instance and on a dropped one, which had [DiscardOutcome.Done].
     */
    fun clearedInFull(): Boolean = synchronized(lock) { discarded || clearReturned }

    /**
     * Whether a clear or a discard of this instance got as far as deleting and has not finished: [clearAll], or a
     * [discardStore] that got as far as deleting, closed it, and [clearedInFull] answers false. Told by this
     * instance's state alone, as [clearedInFull] is, never by a listing or a count: a discard that stopped can leave
     * nothing to count while an unlink whose sync failed can come back. So it holds for the rest of the process,
     * whatever [unsynced] answers, until another call finishes. It reads memory only, so it answers on a cleared
     * instance, and false on a dropped one, which had [DiscardOutcome.Done]. A new instance, as after a restart,
     * starts with it false, and the discard permit holds back what it names, or every note for a permit recorded as
     * for an answer that could not be counted ([startSend], [permitNames]).
     */
    fun clearStopped(): Boolean = synchronized(lock) { closed && !discarded && !clearReturned }

    /**
     * Drops this instance from the registry once [discardStore] has finished, so the next [open] of the
     * directory gets a new instance, over a directory that is not there, which takes saves again. This one
     * refuses every operation from then on, [unsynced], [unsyncedInNotebook], [removalCheck], [discardStore],
     * [acknowledged] and [clearAll] included, since the new instance may own the directory by then. Only
     * [clearedInFull] and [clearStopped] still answer, from memory. A second call does nothing, and so does
     * [unregisterIfFinishedOnce].
     */
    fun unregister() {
        synchronized(lock) {
            if (dropped) return
            check(discarded) { "only a discarded store is dropped" }
            dropped = true
            floors.merge(dir.path, highWater, ::maxOf)
            registry.remove(dir.path, this)
        }
    }

    /**
     * [unregister], only when one clear of this instance finished, and that was a [discardStore] that gave
     * [DiscardOutcome.Done]; it answers whether it dropped the instance. For a caller that has just had that Done:
     * told under the store lock, so it never drops an instance that another call finished as well, before that Done
     * or after it, such as the sign-out's, which keeps the instance it cleared closed for the rest of the process so
     * that a late save for a removed account is refused. On a dropped instance it does nothing and answers false.
     */
    fun unregisterIfFinishedOnce(): Boolean = synchronized(lock) {
        if (dropped || !discarded || finishes != 1) return@synchronized false
        unregister()
        true
    }

    private fun checkNotDropped() = check(!dropped) { "the pending store was dropped" }

    // ---- one notebook ----

    /**
     * What one notebook holds that has not synced, for the user who leaves or deletes it, decided from one
     * listing. Like [unsynced], it runs no recovery, writes nothing in the store, answers on a cleared instance from
     * what is on disk, and withdraws the store's acknowledgement once the store lists ([withdrawAcknowledgement]):
     * - A folder that is a link, or whose lstat cannot tell ([followable]), is not listed and nothing in it is read,
     *   the counter included: every notebook's answer is the one [unsynced] gives for it, "could not be counted" with
     *   [UnsyncedNotes.listed] false, no names, and [highWater] for its sequence, and the acknowledgement is not
     *   withdrawn.
     * - A store whose directory cannot be listed, and is not shown gone, answers as [unsynced] does, with
     *   [UnsyncedNotes.listed] false, for every notebook.
     * - A listing that lacks the store's counter while its presence check, by path, does not show it absent came back
     *   short, as [unsynced] takes it ([shortOfCounter]): every notebook's answer is "could not be counted", naming
     *   what the listing placed in it. A lost counter, a store never made and an empty folder are no such listing. One
     *   that skipped an entry and still listed the counter is taken as it comes, so a count can be low, and an answer
     *   of nothing is no proof that the notebook holds nothing.
     * - An entry file counts in the notebook its header names, read alone ([readHeader]), when the header names the
     *   note its file is named for: a held entry and a conflict copy too. A first write with no entry beside it counts
     *   the same way under its entry's name when it is intact, and nowhere when it is cut short, since recovery drops
     *   it. Landed records, notebook copies, the counter and their writes hold no unsynced text.
     * - A file that cannot be placed in a notebook may hold this notebook's text, so it leaves every notebook's answer
     *   "could not be counted" ([UnsyncedNotes.unreadable]), with each entry, first write and file of an unknown kind
     *   named as in [unsynced]: an entry whose header cannot be read or names another note, a name that is not an
     *   Etebase uid, a first write whose header cannot be read, and a file of a kind this build does not know. So does
     *   a withdrawal of the acknowledgement that cannot be shown. A sequence that cannot be read gives "could not be
     *   counted" only for a notebook that holds anything; one that holds nothing counts nothing then.
     *
     * That one such file leaves every notebook uncountable is my chosen default; [countNotebook] holds that rule in
     * one branch. A header carries its own checksum and the text does not, so an entry counted here can turn out
     * unreadable at [discardNotebook], which keeps it.
     */
    fun unsyncedInNotebook(notebookUid: String): UnsyncedNotes = synchronized(lock) {
        checkNotDropped()
        countNotebook(checkedUid(notebookUid)).answer
    }

    /** What [discardNotebook] did. */
    sealed class NotebookDiscard {
        /**
         * Every entry of the notebook that could be read went, [deleted] of them, as far as a second listing in the same
         * hold of the store lock shows, and a look by path at what the confirmation names and neither listing showed:
         * an entry that the confirmation does not name, and that two listings leave out while they still list the
         * counter, is not seen. The [unreadable] ones, whose header names the notebook and whose text cannot be read,
         * stay.
         * [uncounted] when the notebook could not be counted, by the count the confirmation was compared with or by the
         * second listing: the files that could not be placed in a notebook, which may hold its text, stay too.
         */
        data class Done(val deleted: Int, val unreadable: Int, val uncounted: Boolean = false) : NotebookDiscard()

        /** The notebook holds what the confirmation does not cover: [now]. Nothing was deleted. */
        data class Changed(val now: UnsyncedNotes) : NotebookDiscard()

        /**
         * The store's directory cannot be listed. None of the notebook's entries was deleted, and nothing was
         * recorded. While its folder is a link, or lstat cannot tell, [discardNotebook] throws instead, before
         * anything is read; the count checks again, so a link that takes the folder's place after that first check
         * gives this answer too.
         */
        object NotListed : NotebookDiscard()

        /**
         * [deleted] entries went, and [kept] of the notebook's entries stay: a removal failed, the loop stopped, a
         * throw after the loop stopped the discard, the second listing still places an entry in the notebook that this
         * call did not keep for being unreadable, or the confirmation names one that neither listing showed and that a
         * look by path does not show gone. [unsure] when a removal that failed had unlinked a file already, such as an
         * entry whose directory sync then failed or a conflict copy's original whose copy then stayed, or when the
         * directory sync owed before Done failed: some of the notebook's text may be gone that [deleted] does not
         * count, and an unlink whose sync failed can come back after a power loss. [unsure] too when a throw after the
         * loop stopped a discard that had unlinked a file, before it could check what went.
         */
        data class Partly(val deleted: Int, val kept: Int, val unsure: Boolean = false) : NotebookDiscard()
    }

    /**
     * The user's confirmed discard of one notebook's unsynced Notes changes, once their leave or delete of it went
     * through on the server. [confirmed] is the answer of [unsyncedInNotebook] they were shown. Like [discard], it runs
     * any recovery that is owed first and refuses a cleared instance ([Cleared]); a recovery that cannot list the store
     * throws before anything goes. While the store's folder is a link, or lstat cannot tell ([followable]), it throws
     * IOException at its start, before recovery, and nothing is listed, read, recorded or deleted ([locked]). Its count
     * checks again, so a link that takes the folder's place after that check and before the count gives
     * [NotebookDiscard.NotListed], and the loop deletes nothing; the recovery that runs in between when one is owed
     * does not check again, so it does not see a link that comes while it runs, as no operation does ([followable]).
     * Then, in the same hold of the store lock:
     * 1. The notebook is counted again, as [unsyncedInNotebook] counts it.
     * 2. While the store's directory cannot be listed, nothing is deleted and nothing is recorded, neither a permit
     *    nor an acknowledgement ([NotebookDiscard.NotListed]).
     * 3. A notebook that holds nothing now has nothing to delete, also under a confirmation given while the store could
     *    not be listed, and goes on to step 6 with none.
     * 4. When [confirmed] does not cover what the notebook holds now ([UnsyncedNotes.covers], which compares
     *    [UnsyncedNotes.listed] too), nothing is deleted ([NotebookDiscard.Changed]).
     * 5. Each entry placed in the notebook is read in full. One whose text cannot be read is kept and reported, as
     *    the maintainer's rule for unreadable drafts asks; keeping it in a notebook's discard is my chosen default,
     *    held in that one branch. Any other goes as [discard] removes it, a conflict copy's original with
     *    it. A removal that throws an IOException or a RuntimeException keeps that entry while the others still go;
     *    any other throw, such as running out of memory on a large entry, keeps it and the rest
     *    ([NotebookDiscard.Partly]), and is not passed on. A removal that throws after it unlinked a file, such as one
     *    whose directory sync failed, or a conflict copy whose original went first, marks that outcome
     *    [NotebookDiscard.Partly.unsure].
     * 6. [NotebookDiscard.Done] comes only after two more steps. Under a [confirmed] from a listed store that holds
     *    anything, while an unlink by [remove], in this call or an earlier one, has had no directory sync that worked
     *    since, the store's directory is synced, so a retry after a partial success makes that durability step too; a
     *    sync that fails gives [NotebookDiscard.Partly] with [NotebookDiscard.Partly.unsure]. Under any other
     *    [confirmed] the loop walked nothing, so there is no discard to make last, and the unlink stays owed. Then the
     *    notebook is listed again, and an entry that listing places in it, other than one kept for being unreadable,
     *    stays and gives [NotebookDiscard.Partly], since the first listing can have come back short; nothing more is
     *    deleted for it. So does a name in [confirmed] that neither listing showed, which the loop did not walk, unless
     *    its path is shown absent ([namesThere]). An entry that [confirmed] does not name, and that two listings leave
     *    out while they still list the counter, gets past this. A second listing that cannot count the notebook, or
     *    cannot list the store, otherwise gives Done with [NotebookDiscard.Done.uncounted].
     *
     * From step 5 on nothing is passed on, since a caller takes a throw for a discard that deleted nothing: a throw
     * that no step turns into an outcome of its own gives [NotebookDiscard.Partly], in the loop as step 5 says, and
     * after it, such as running out of memory while an outcome is made, with [NotebookDiscard.Partly.unsure] once
     * this call unlinked a file.
     *
     * It records no permit and no acknowledgement, hands out no version, and never closes or drops the instance, so
     * what it keeps is held by the next push step, and the notebook copy goes with the next prune. Other notebooks'
     * entries, files that cannot be placed, landed records and the counter stay. Anything it throws comes before an
     * entry went, except an Error: memory can run out again while that last [NotebookDiscard.Partly] is made.
     */
    fun discardNotebook(notebookUid: String, confirmed: UnsyncedNotes): NotebookDiscard = locked {
        val uid = checkedUid(notebookUid)
        val count = countNotebook(uid)
        val now = count.answer
        // No permit and no acknowledgement, here or below: my chosen default.
        val placed = count.placed ?: return@locked NotebookDiscard.NotListed
        if (now.anything && !confirmed.covers(now)) return@locked NotebookDiscard.Changed(now)
        var deleted = 0
        val unreadable = HashSet<String>()
        var failed = 0
        var unsure = false
        // For a throw that stops the discard: the entries from [reached] on stay, the one being tried among them, and
        // [unlinksBefore] is the count of unlinks before that one, or before the loop once it ended.
        var reached = 0
        val unlinksAtStart = unlinks
        var unlinksBefore = unlinksAtStart
        try {
            for (entry in placed.sorted()) {
                unlinksBefore = unlinks
                val noteUid = entry.removeSuffix(NOTE)
                try {
                    when (val read = readEntry(noteUid)) {
                        // Kept, as unreadable drafts are: my chosen default for this discard.
                        is Read.Unreadable -> unreadable += entry
                        is Read.Present -> {
                            removeEntry(noteUid, read.entry)
                            deleted++
                        }
                        Read.Missing -> Unit
                    }
                } catch (e: IOException) {
                    failed++
                    if (unlinks != unlinksBefore) unsure = true
                } catch (e: RuntimeException) {
                    failed++
                    if (unlinks != unlinksBefore) unsure = true
                }
                reached++
            }
            unlinksBefore = unlinksAtStart
            if (failed > 0) return@locked NotebookDiscard.Partly(deleted, failed + unreadable.size, unsure)
            // Step 6: an unlink whose directory sync has not worked since, in this call or an earlier one, lasts only
            // once the directory is synced. A confirmation of nothing, or one from a store that could not be listed,
            // walked nothing, so it has no discard to make last.
            if (confirmed.anything && confirmed.listed && unlinkUnsynced) {
                try {
                    syncDirectory(dir)
                    unlinkUnsynced = false
                } catch (e: Throwable) {
                    return@locked NotebookDiscard.Partly(deleted, unreadable.size, unsure = true)
                }
            }
            // The listing the count came from can have come back short: what a second one still places in the
            // notebook stays, and nothing more is deleted for it. That one can leave out the same entry, so what the
            // confirmation names and neither listing showed, which the loop did not walk, is looked up by path.
            val again = try {
                countNotebook(uid)
            } catch (e: Throwable) {
                null
            }
            val left = again?.placed.orEmpty().toHashSet()
            left += namesThere(confirmed.names - count.shown - again?.shown.orEmpty())
            left -= unreadable
            if (left.isNotEmpty()) return@locked NotebookDiscard.Partly(deleted, unreadable.size + left.size)
            NotebookDiscard.Done(deleted, unreadable.size,
                uncounted = now.unreadable || again?.answer?.unreadable != false)
        } catch (e: Throwable) {
            // Any other throw, such as running out of memory on a large entry or once the loop ended, stops the discard
            // and is not passed on: the entry being tried and those after it stay, and the outcome is unsure when that
            // entry had unlinked a file or, once the loop ended, when this call had unlinked any.
            NotebookDiscard.Partly(deleted, failed + unreadable.size + placed.size - reached,
                unsure || unlinks != unlinksBefore)
        }
    }

    /**
     * An answer of [unsyncedInNotebook], the entries it placed in the notebook, null when not listed, and the names
     * its listing showed, as [UnsyncedNotes.names] gives them: every entry placed in any notebook, and what could not
     * be placed. A first write cut short gives no name, so it shows nothing of its entry.
     */
    private class NotebookCount(
        val answer: UnsyncedNotes,
        val placed: List<String>?,
        val shown: Set<String> = emptySet(),
    )

    /** [unsyncedInNotebook] for [notebookUid], a checked uid, under the store lock. */
    private fun countNotebook(notebookUid: String): NotebookCount {
        if (!followable()) return NotebookCount(UnsyncedNotes(0, highWater, unreadable = true, listed = false), null)
        val listed = listDirectory(dir)
        if (listed == null && !shownGone(dir)) {
            return NotebookCount(UnsyncedNotes(0, uncountedSequence(), unreadable = true, listed = false), null)
        }
        val names = listed.orEmpty().map { it.name }
        val withdrawn = try {
            withdrawAcknowledgement()
            true
        } catch (e: IOException) {
            false
        }
        // A listing that lacks the counter while its presence check does not show it absent came back short.
        val short = shortOfCounter(names)
        val held = names.toHashSet()
        val shown = HashSet<String>()
        val placed = ArrayList<String>()
        val unplaced = ArrayList<String>()
        for (name in names) {
            when (val placement = placementOf(name, held)) {
                is Placement.In -> {
                    shown += placement.entry
                    if (placement.notebookUid == notebookUid) placed += placement.entry
                }
                Placement.Unknown -> unplaced += name
                Placement.Nowhere -> Unit
            }
        }
        shown += uncountedNames(unplaced)
        // One file that cannot be placed leaves every notebook uncountable, since it may hold this notebook's text, and
        // so does a listing that came back short, which may have left out this notebook's entries.
        if (withdrawn && unplaced.isEmpty() && !short) {
            if (placed.isEmpty()) return NotebookCount(UnsyncedNotes.NOTHING, placed, shown)
            try {
                return NotebookCount(UnsyncedNotes(placed.size, currentSequence(strict = true), unreadable = false,
                    names = placed.toSet()), placed, shown)
            } catch (e: IOException) {
                // A sequence that cannot be read: the notebook could not be counted.
            }
        }
        return NotebookCount(UnsyncedNotes(placed.size + unplaced.size, uncountedSequence(), unreadable = true,
            names = placed.toSet() + uncountedNames(unplaced)), placed, shown)
    }

    /** The notebook a listed file's unsynced text belongs to: [In] one, [Nowhere], or [Unknown]. */
    private sealed class Placement {
        /** In the notebook [notebookUid], as the entry [entry] ("<uid>.note"). */
        data class In(val notebookUid: String, val entry: String) : Placement()

        /** It holds no unsynced text. */
        object Nowhere : Placement()

        /** It may hold unsynced text, and its notebook cannot be told. */
        object Unknown : Placement()
    }

    /**
     * Where the file [name] belongs, from a listing of the store that worked and held [held]. An entry's own header
     * decides, and must name the note its file is named for. A first write beside its entry holds nothing, since
     * recovery drops it unread, and neither does one that is cut short; an intact one counts as its entry would.
     */
    private fun placementOf(name: String, held: Set<String>): Placement {
        if (!isKnownKind(name)) return Placement.Unknown
        val first = name.endsWith(NOTE + NEW)
        if (!first && !name.endsWith(NOTE)) return Placement.Nowhere
        val entry = name.removeSuffix(NEW)
        if (first && entry in held) return Placement.Nowhere
        val noteUid = entry.removeSuffix(NOTE)
        if (!UID.matches(noteUid)) return Placement.Unknown
        val header = if (!first) readHeader(File(dir, name)) else {
            val bytes = try {
                File(dir, name).readBytes()
            } catch (e: IOException) {
                return Placement.Unknown
            }
            if (!PendingCodec.isIntact(bytes)) return Placement.Nowhere
            (PendingCodec.decodeEntryHeader(bytes) as? PendingCodec.Decoded.Ok)?.value
        }
        return if (header == null || header.noteUid != noteUid) Placement.Unknown
        else Placement.In(header.notebookUid, entry)
    }

    // ---- internals ----

    /**
     * Every public operation except [unsynced], [unsyncedInNotebook], [removalCheck], [discardStore], [acknowledged],
     * [clearedInFull], [clearStopped], [unregister], [unregisterIfFinishedOnce], [clearAll] and [pruneNotebooks]:
     * refuse ([Cleared]) once [clearAll], or a [discardStore] that got as far as deleting, has closed the store, and
     * finish any interrupted work first. Recovery runs again before the next operation for as long as anything in it
     * did not work out, including a write or removal inside recovery itself, or a listing it works from. A recovery
     * whose listing fails throws, so the operation fails with it and the recovery is not taken for done: a first
     * write it did not see may be the only copy of a note's text, and an original it did not see may still wait for
     * its conflict copy. A listing also fails while the store's acknowledgement cannot be shown gone ([listing]), so
     * a new instance does nothing while notes-discard is there but cannot be listed.
     *
     * While the store's folder is a link, or lstat cannot tell ([followable]), every such operation throws
     * IOException at its start, before recovery and on every call, also in an instance that recovered before the
     * link came, so nothing is read, written or deleted through the link. Recovery is then owed again, so it runs
     * over whatever the folder holds once it can be followed.
     *
     * [pruneNotebooks] refuses ([Cleared]) after [clearAll] as well, but runs no recovery: while one is owed it does
     * nothing, and it comes here only when none is, so no recovery runs inside a prune, where a failure
     * would show only as a log line.
     *
     * Recovery runs once per operation, at its start. An operation that calls another one under the lock (a
     * save through a handle, anything that goes through [update]) does not recover again in between:
     * recovery can remove an original and move editors, and what the outer call read or decided before
     * the inner one must still hold when the inner one writes.
     */
    private inline fun <T> locked(block: () -> T): T = synchronized(lock) {
        if (closed) throw Cleared()
        if (depth == 0 && !followable()) {
            recovered = false
            throw IOException(LINKED)
        }
        if (depth == 0 && !recovered) {
            // Done only once it returned with nothing left over: a recovery that ends with an error
            // that is not an I/O failure (out of memory on a large entry) runs again as well.
            recoveryProblems = recoverLocked()
            recovered = recoveryProblems.isEmpty()
        }
        depth++
        try {
            block()
        } finally {
            depth--
        }
    }

    /** How many [locked] calls are open on the thread that holds the lock. */
    private var depth = 0

    /** A new entry for a note that landed earlier starts from that evidence: not a create, and the landed revision is ours. */
    private fun fromLanded(entry: PendingEntry): PendingEntry {
        val landed = readLanded(entry.noteUid) ?: return entry
        return entry.copy(isCreate = false).withSent(landed.revision)
    }

    /** Null when there is no landed record or it does not decode; throws as [readIfPresent] does. */
    private fun readLanded(noteUid: String): LandedRecord? {
        val bytes = readIfPresent(landedFile(noteUid)) ?: return null
        return (PendingCodec.decodeLanded(bytes) as? PendingCodec.Decoded.Ok)?.value
    }

    private fun putNotebookLocked(notebookUid: String, blob: ByteArray) {
        writeAtomically(notebookFile(notebookUid), PendingCodec.encodeNotebook(notebookUid, blob))
    }

    /**
     * The next value of the store-wide counter, persisted before it is handed out. A counter that does not
     * read is rebuilt strictly ([highestVersion]): while a version on disk cannot be read, or a file there
     * may hold one this build cannot read (a counter written in full in a layout it does not know, a file
     * of a kind it does not know), it throws, and nothing is written, the counter included. A version that
     * is not above all of them could be one an entry already holds, and a drop or a rebase that checks the
     * version would then take the newer text for the older.
     *
     * It is also above [highWater], which [currentSequence] never answers below: every sequence this instance
     * has read or handed out, the version it handed to an upload, and what a dropped instance of the same
     * directory had. The store-wide sequence that [observe] hands an editor and that a discard's confirmation
     * compares must not come back for text saved after it was shown, nor the version an upload carries for a
     * note saved again after its entry went, and a rebuild after the counter is lost can fall below both, when
     * the entries that held the highest versions are gone. That bound is kept in memory only. After a
     * restart a new instance starts from the counter, so an answer a dialog keeps in its arguments across a
     * restart holds only while the counter reads, as [UnsyncedNotes.covers] says, and one shown before a
     * discard that finished, which deletes the counter, does not hold at all. The push order, which compares
     * versions across notes, is bounded the same way.
     */
    private fun nextVersion(): Long {
        withdrawPermit()
        val next = currentSequence(strict = true) + 1
        writeAtomically(File(dir, SEQUENCE), PendingCodec.encodeSequence(next))
        highWater = next
        return next
    }

    /**
     * [nextVersion] for a step of a Notes run, a rebase or a conflict copy, which the user did not ask for. While a
     * file the store's discard permit names is there ([namedThere]), it throws [HeldBack] before anything is
     * written: a new version would withdraw the permit, and the text the user confirmed for that discard would then
     * be sent. So does a permit that may be there but cannot be read, and one recorded as for an answer that could not
     * be counted, whatever the store holds ([permitNames]). The note waits for a later run as it is. A save and a
     * release from holding still withdraw the permit. Once this instance has shown the permit gone
     * ([withdrawPermit]), nothing holds a new version back, and the permit is not read again ([permitNames]).
     */
    private fun nextRunVersion(): Long {
        if (namedThere(permitNames())) throw HeldBack()
        return nextVersion()
    }

    /**
     * A discard permit never covers text saved after it, so before the first new version this instance
     * hands out, the store's permit is removed ([PendingNotesDiscardPermits.remove]). Comparing answers
     * is not enough: with the counter gone and nothing versioned left on disk, versions start at 1 again in
     * a new instance after a restart, and there two answers that could not be counted can carry the same
     * sequence and compare only files, by number and name ([uncountedSequence]). A removal that cannot be
     * shown throws before the counter or the entry is written. Once shown, it is
     * not asked again by this instance until a [discardStore], which may leave a permit behind.
     *
     * While a permit may be there ([PendingNotesDiscardPermits.mayHold]), the store's directory, when it is there,
     * and then the directory above it are synced first ([syncRemoval]): the discard it was for, in this process or
     * before a restart, may have removed files from the store, or the store's directory, and stopped before the
     * sync that makes that removal last, and a permit retired first could leave the discarded text to come back
     * after a power loss with no permit. A sync that fails throws, and so does a check of the store's directory
     * that fails, and the permit stays. With no permit there, nothing is synced here.
     *
     * The permit goes before the counter and the entry are written ([nextVersion]), so a save or a release that
     * fails after this has still released what the permit held back, as one that works does by design. A permit that
     * cannot be read is removed all the same, since a removal only unlinks.
     */
    private fun withdrawPermit() {
        if (permitWithdrawn) return
        if (permits.mayHold(dir.name)) {
            if (isPresent(dir)) syncDirectory(dir)
            syncRemoval()
        }
        permits.remove(dir.name)
        permitWithdrawn = true
    }

    /**
     * The files the store's discard permit names, read by path, never listed: what a discard that has not
     * finished was confirmed for, which is not sent ([startSend], [Snapshot.discardConfirmed]), and while one of
     * them is there a run makes no new version ([nextRunVersion]) and records no success
     * ([Snapshot.discardUnfinished]). Empty when there is no permit, and for a damaged one, which holds nothing back
     * ([PendingNotesDiscardPermits.Lookup.Damaged]). Null while a permit may be there but cannot be read, and for a
     * permit recorded as for an answer that could not be counted ([UnsyncedNotes.unreadable]): one for such an
     * answer, or one recorded in place of such a permit or of one that cannot be read, whatever its own count showed
     * ([discardStore], step 3). A permit for such an answer names only what listings held, the count's, its
     * confirmation's and an earlier permit's, each of which can come back short and say nothing, while the user
     * confirmed the discard of all of the store. Every note is held back then, until a save or a release withdraws
     * the permit, or a discard that finishes removes it, none of which needs to read it. While the check of whether
     * a permit that cannot be read is there fails as well, as when notes-discard itself cannot be checked, a save or
     * a release that cannot unlink it fails, and every note stays held back until that check works again.
     *
     * Once this instance has shown the permit gone ([withdrawPermit]), it is empty and nothing is read: only
     * [discardStore] records a permit, and it has this instance read it again first, under the same lock. So a
     * check that keeps failing for a permit a save withdrew holds nothing back.
     */
    private fun permitNames(): Set<String>? {
        if (permitWithdrawn) return emptySet()
        return when (val found = permits.lookup(dir.name)) {
            is PendingNotesDiscardPermits.Lookup.Found -> if (found.permit.unreadable) null else found.permit.names
            PendingNotesDiscardPermits.Lookup.Unknown -> null
            PendingNotesDiscardPermits.Lookup.Absent, PendingNotesDiscardPermits.Lookup.Damaged -> emptySet()
        }
    }

    /**
     * Whether a file among [names], read from the store's discard permit ([permitNames]), is there: text a discard
     * that has not finished was confirmed for. Each name, and the write beside it ("<name>.new", which the count
     * names by its entry's name), is checked by path ([presenceOf]), never listed or read, so a listing that comes
     * back short does not hide it. Only a path shown absent ([Presence.ABSENT]) is not there: a check that fails
     * counts as there, and so does a name that is not one file name in the store, which is not looked up. While the
     * folder is a link, or lstat cannot tell ([followable]), nothing is looked up through it and any name counts as
     * there: every caller runs under [locked], which refuses such a folder at its start, so this is for a link that
     * takes the folder's place during the operation. No names, as for no permit or a damaged one, is false. Null,
     * for a permit that may be there but cannot be read or was recorded as for an answer that could not be counted, is
     * true, and nothing is looked up.
     */
    private fun namedThere(names: Set<String>?): Boolean {
        if (names == null) return true
        if (names.isEmpty()) return false
        if (!followable()) return true
        return names.any { fileThere(it) }
    }

    /** The ones of [names] that are there, as [namedThere] asks it: all of them while the folder may not be followed. */
    private fun namesThere(names: Set<String>): Set<String> =
        if (followable()) names.filterTo(HashSet()) { fileThere(it) } else names

    /** Whether the file [name], or the write beside it, is there, as [namedThere] asks it for each name. */
    private fun fileThere(name: String): Boolean =
        name.isEmpty() || name == "." || name == ".." || '\u0000' in name || File(name).name != name ||
            listOf(name, name + NEW).any { presenceOf(File(dir, it)) != Presence.ABSENT }

    /**
     * An acknowledgement holds only while the store cannot be listed and is not written ([acknowledged]), so
     * the first listing of it that works, and the first write or removal in it, remove the store's
     * acknowledgement ([PendingNotesDiscardPermits.withdrawAcknowledgement]). A removal that cannot be shown
     * throws, which fails that listing or write, and this instance takes no acknowledgement for valid from
     * then on. Once shown, it is not asked again by this instance until it records one. It is asked whether
     * or not an acknowledgement was ever recorded, since no read can show that none is there, so while
     * notes-discard is there but cannot be listed, the first listing, write or removal of every instance fails.
     */
    private fun withdrawAcknowledgement() {
        acknowledgementVoid = true
        if (acknowledgementWithdrawn) return
        permits.withdrawAcknowledgement(dir.name)
        acknowledgementWithdrawn = true
    }

    private fun identityOf(d: File): DirectoryIdentity? =
        identityForTesting.let { if (it != null) it(d) else identity(d) }

    /**
     * Whether the store's folder may be followed: lstat shows it is not a symbolic link, or is not there. A folder
     * that is a link is not, and neither is one whose lstat fails, since it may be one. It is asked at the start of
     * each operation, under the store lock, so it does not see a link that something outside this process puts in
     * the folder's place while the operation runs.
     */
    private fun followable(): Boolean = linkForTesting.let { if (it != null) it(dir) else link(dir) } == false

    /**
     * The last version handed out. A counter that is lost, cut short or fails its checksum is rebuilt as
     * the highest version still on disk ([highestVersion]) and is not written back here; [nextVersion]
     * hands out the one above it. A counter written in full in a layout this build does not know (a newer
     * build's after a downgrade, or an older one this build no longer reads) comes from a build that may
     * have handed out versions above every file here, so nothing is rebuilt over it: with [strict], which
     * is for [nextVersion], it throws, as a version on disk that cannot be read does. A counter file that
     * cannot be read at all throws, and so does one that cannot be shown not to be there ([readIfPresent]):
     * of a counter whose read fails, only one shown to be missing is rebuilt. The readers ([snapshot],
     * [observe]) take the highest version they can read instead: a push needs no new version, so one file
     * that cannot be read does not stop a run from pushing the others. What they read is a version on disk
     * all the same, so it raises [highWater], and the next version goes above it. Whatever it reads, it
     * answers no lower than [highWater], so in one process the sequence does not fall, also once the counter
     * is lost.
     *
     * The counter shares [PendingCodec.RECORD_FORMAT_VERSION] with landed records and notebook copies, and
     * the codec reads no other format version, an earlier one included. A build that raises it must keep
     * decoding every earlier counter layout: otherwise, after the upgrade, every write that needs a new
     * version fails here, since [versionOf] takes an intact counter it cannot decode for one that may hold
     * versions it cannot read.
     */
    private fun currentSequence(strict: Boolean): Long {
        val stored = readIfPresent(File(dir, SEQUENCE))?.let { PendingCodec.decodeSequence(it) }
        val sequence = (stored as? PendingCodec.Decoded.Ok)?.value ?: highestVersion(strict)
        if (sequence > highWater) highWater = sequence
        return highWater
    }

    /**
     * The highest version on disk, from one [listing]: each entry's, read from its header alone, which
     * checks its own CRC and reads no blob, each landed record's, the counter's when the listing shows
     * one that reads, and those of intact writes not committed yet ("<uid>.note.new", "<uid>.landed.new",
     * "sequence.new"), since recovery may still commit one. A write that was cut short holds none: it was
     * never reported saved, and recovery drops it. Neither does a counter that is cut short or fails its
     * checksum, which is what is rebuilt here, nor a notebook copy. A listing that fails throws. With
     * [strict], so does a version that cannot be read (a damaged header, a newer format after a
     * downgrade, a landed record that does not decode, a counter written in full in a layout this build
     * does not know), and so does a file of a kind this build does not know, which may hold one;
     * otherwise that file is passed over.
     */
    private fun highestVersion(strict: Boolean): Long {
        var highest = 0L
        for (file in listing()) {
            val version = try {
                versionOf(file)
            } catch (e: IOException) {
                if (strict) throw e
                null
            }
            if (version != null && version > highest) highest = version
        }
        return highest
    }

    /**
     * The version [file] holds, or null for a file that holds none (a notebook copy, a write or a counter
     * that was cut short or fails its checksum). Throws when it holds one that cannot be read, and for a
     * file of a kind this build does not know, which may hold one.
     */
    private fun versionOf(file: File): Long? {
        val name = file.name
        val version = when {
            name.endsWith(NOTE) -> readHeader(file)?.version
            name.endsWith(LANDED) -> landedVersion(file.readBytes())
            name.endsWith(NOTEBOOK) || name.endsWith(NOTEBOOK + NEW) -> return null
            name.endsWith(NOTE + NEW) || name.endsWith(LANDED + NEW) || name == SEQUENCE || name == SEQUENCE + NEW -> {
                val bytes = file.readBytes()
                if (!PendingCodec.isIntact(bytes)) return null
                when {
                    name.endsWith(LANDED + NEW) -> landedVersion(bytes)
                    name.endsWith(NOTE + NEW) -> entryVersion(bytes)
                    else -> (PendingCodec.decodeSequence(bytes) as? PendingCodec.Decoded.Ok)?.value
                }
            }
            else -> throw IOException("$name is of a kind this build does not know")
        }
        return version ?: throw IOException("the version in $name cannot be read")
    }

    private fun entryVersion(bytes: ByteArray): Long? =
        (PendingCodec.decodeEntryHeader(bytes) as? PendingCodec.Decoded.Ok)?.value?.version

    private fun landedVersion(bytes: ByteArray): Long? =
        (PendingCodec.decodeLanded(bytes) as? PendingCodec.Decoded.Ok)?.value?.version

    /**
     * A write this build makes, which recovery may finish or drop: the "<name>.new" of an entry, a landed record, a
     * notebook copy or the counter.
     */
    private fun isKnownWrite(name: String): Boolean =
        name.endsWith(NOTE + NEW) || name.endsWith(LANDED + NEW) || name.endsWith(NOTEBOOK + NEW) ||
            name == SEQUENCE + NEW

    /**
     * A file of a kind this build writes: an entry, a landed record, a notebook copy, the counter, or a
     * write of one of them.
     */
    private fun isKnownKind(name: String): Boolean = name.endsWith(NOTE) || name.endsWith(LANDED) ||
        name.endsWith(NOTEBOOK) || name == SEQUENCE || isKnownWrite(name)

    /**
     * Recovery problems that still stand: the file is not shown to be gone, and is not an entry that now
     * reads fine (a failed step of a conflict copy is recorded under the copy's own name). Without this a
     * problem would outlive its file until the process restarts, and a readable entry would count twice.
     * A file whose presence cannot be told keeps its problem: dropped, a recovery that has not finished
     * would show in no report, and a run could record success while its file still waits.
     */
    private fun currentRecoveryProblems(presentUids: Set<String>): List<Read.Unreadable> = recoveryProblems.filter {
        presenceOf(File(dir, it.file)) != Presence.ABSENT && it.file.removeSuffix(NOTE) !in presentUids
    }

    /**
     * Missing only when neither the entry nor a first write of it is there, as each is shown not to be. The
     * entry is read first, and its presence is asked only when that read fails. An entry, or a first write,
     * that is there but cannot be read, or whose presence cannot be told, reads as unreadable: taken for
     * missing, a save would write a new entry over it, and a run would not report it.
     *
     * A leftover "<uid>.note.new" with no committed file is one that recovery could not finish; it may
     * be the only copy of the text, so the note reads as unreadable, which keeps every save from
     * writing through the same path over it. Recovery tries it again before the next operation.
     */
    private fun readEntry(noteUid: String): Read {
        val file = noteFile(noteUid)
        val bytes = try {
            readIfPresent(file)
        } catch (e: IOException) {
            return Read.Unreadable(file.name, e.message ?: "unreadable")
        }
        if (bytes != null) return decodeEntry(file.name, bytes)
        val stranded = File(dir, file.name + NEW)
        val interrupted = try {
            isPresent(stranded)
        } catch (e: IOException) {
            return Read.Unreadable(stranded.name, e.message ?: "unreadable")
        }
        if (!interrupted) return Read.Missing
        return Read.Unreadable(stranded.name, "an interrupted write is not recovered yet")
    }

    /** A listed entry file, read whole: a read that fails is reported, as the listing shows the file is there. */
    private fun decodeFile(file: File): Read = try {
        decodeEntry(file.name, file.readBytes())
    } catch (e: IOException) {
        Read.Unreadable(file.name, e.message ?: "unreadable")
    }

    private fun decodeEntry(name: String, bytes: ByteArray): Read =
        when (val decoded = PendingCodec.decodeEntry(bytes)) {
            is PendingCodec.Decoded.Ok -> Read.Present(decoded.value)
            is PendingCodec.Decoded.Bad -> Read.Unreadable(name, decoded.reason)
        }

    /**
     * The bytes of [file], or null when it is shown not to be there. It is read first, and its presence is
     * asked only when the read fails, since FileNotFoundException stands for a file that is not there and
     * for one that cannot be opened alike. A read that fails on a file that is there throws, and so does
     * one on a file whose presence cannot be told ([isPresent]).
     */
    private fun readIfPresent(file: File): ByteArray? = try {
        file.readBytes()
    } catch (e: IOException) {
        if (isPresent(file)) throw e
        null
    }

    /**
     * Whether [file] is there: false only when it is shown not to be ([Presence.ABSENT]). A check that
     * fails throws IOException, so nothing that may still be there is passed over as absent.
     */
    private fun isPresent(file: File): Boolean = when (presenceOf(file)) {
        Presence.PRESENT -> true
        Presence.ABSENT -> false
        Presence.UNKNOWN -> throw IOException("could not tell whether ${file.name} is there")
    }

    private fun presenceOf(file: File): Presence = presenceForTesting?.invoke(file) ?: presence(file)

    /** Finishes interrupted writes and conflict copies, and drops unused landed records. One bad file never stops the others. */
    private fun recoverLocked(): List<Read.Unreadable> {
        val problems = mutableListOf<Read.Unreadable>()
        val unfinished = HashSet<String>()
        // 1. A leftover "<name>.new" of a kind this build writes was never committed. While "<name>" exists
        // that write never reported success, so it goes, unread. Without a committed file it is the first
        // write of that file, stopped before its rename. One that is cut short or fails its checksum goes as
        // well. Any other is committed under its own name, in the order a write commits (content synced,
        // renamed in one step, the rename synced), whether or not this build can read its layout (a newer
        // format after a downgrade, a held reason added later), so nothing a build wrote in full is thrown
        // away (design 3.1). An entry file this build cannot read is then reported like every committed
        // entry that cannot be read. The other kinds are kept for a build that can read them but not
        // reported. A landed record goes in step 2 unless an editor is open, and a notebook copy lasts until
        // a run prunes or rewrites it. A counter this build cannot read stays as it is, and every write that
        // needs a new version fails while it does: the build that wrote it may have handed out higher ones.
        // A ".new" of any other kind is left as it is: not deleted, not committed and not reported, since
        // this build cannot judge it and a newer build may keep versions in it. With the counter lost, the
        // version rebuild ([versionOf]) then takes it for a file of a kind this build does not know.
        // "<name>" is there when the same listing shows it. A listing can come back short, since
        // File.listFiles can return what it read so far when reading the directory fails partway, so a
        // "<name>" that the listing leaves out is checked on its own ([isPresent]), and only a check that
        // shows it absent lets the write be committed: a write that never reported success never replaces
        // the committed file. A check that fails throws, so the write is reported, both files stay, and the
        // next recovery decides again.
        val listed = listing()
        val names = listed.mapTo(HashSet()) { it.name }
        for (tmp in listed.filter { isKnownWrite(it.name) }) {
            try {
                val target = File(dir, tmp.name.removeSuffix(NEW))
                if (target.name in names || isPresent(target) || !PendingCodec.isIntact(tmp.readBytes())) {
                    if (!tmp.delete()) throw IOException("could not remove ${tmp.name}")
                } else {
                    FileOutputStream(tmp, true).use { it.fd.sync() }
                    rename(tmp, target)
                    syncDirectory(dir)
                }
            } catch (e: IOException) {
                problems += Read.Unreadable(tmp.name, e.message ?: "unreadable")
            }
        }
        // 2. A landed record only matters while an editor for its note is open. Any other is left from an
        // editor that closed without clearing it, or from an earlier process (no editor survives one),
        // and would otherwise keep a full copy of the note on the device. Only regular files are removed,
        // as in [pruneNotebooks].
        for (file in files(LANDED).filter { it.isFile && !hasEditor(it.name.removeSuffix(LANDED)) }) {
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
                    // The copy's file is committed, so it owns the text: editors still on the original
                    // follow it, as in replaceWithNewNote, which may have failed before it moved them.
                    moveEditors(origin.noteUid, copy.noteUid)
                    remove(noteFile(origin.noteUid))
                    unfinished -= origin.noteUid
                    remove(landedFile(origin.noteUid))
                }
                // Keep the link only while the original cannot be read, since then it cannot be told apart.
                // It is not pushed in the meantime either. Nothing failed here, so no problem is recorded
                // and this is not looked at again by itself: beginSend asks for that when it refuses a send.
                if (original is Read.Unreadable) {
                    unfinished += origin.noteUid
                } else {
                    writeAtomically(noteFile(copy.noteUid), PendingCodec.encodeEntry(copy.copy(origin = null)))
                }
            } catch (e: IOException) {
                problems += Read.Unreadable(file.name, e.message ?: "unreadable")
            }
        }
        unfinishedOriginals = unfinished
        return problems
    }

    /** The files with [suffix], from [listing]: a listing that fails throws. */
    private fun files(suffix: String): List<File> = withSuffix(listing(), suffix)

    /**
     * The files in [listed] with [suffix], chosen by name alone. File.isFile also answers false when its
     * check fails, and an entry dropped for that would be neither reported nor pushed, its version would
     * be passed over, and its notebook copy would look unreferenced. A caller that removes what it lists
     * keeps only regular files on top, since there a shorter list can only keep more.
     */
    private fun withSuffix(listed: Array<out File>, suffix: String): List<File> =
        listed.filter { it.name.endsWith(suffix) }.sortedBy { it.name }

    /**
     * Everything in the store's directory. A listing that fails throws IOException, so nothing reads it
     * as an empty store: only a directory shown not to be there ([knownAbsent]), such as one that was
     * never created, lists as empty. File.exists() is not asked: it answers false for a check that
     * failed as well as for a directory that is not there. A listing that works withdraws the store's
     * acknowledgement ([withdrawAcknowledgement]), and throws when that cannot be shown.
     */
    private fun listing(): Array<File> {
        val listed = listDirectory(dir)
            ?: if (knownAbsent(dir)) emptyArray() else throw IOException("could not list the pending store")
        withdrawAcknowledgement()
        return listed
    }

    /**
     * Whether [d] is shown gone by two checks that agree: the nearest directory above it that can be listed
     * does not hold the next name on the way down to it ([knownAbsent]), and its presence check answers
     * [Presence.ABSENT]. A listing alone is no proof, since File.listFiles can return what it read so far
     * when reading a directory fails partway.
     */
    private fun shownGone(d: File): Boolean {
        if (!knownAbsent(d)) return false
        if (presenceOf(d) != Presence.ABSENT) return false
        return true
    }

    private fun noteFile(uid: String) = File(dir, checkedUid(uid) + NOTE)
    private fun landedFile(uid: String) = File(dir, checkedUid(uid) + LANDED)
    private fun notebookFile(uid: String) = File(dir, checkedUid(uid) + NOTEBOOK)

    /**
     * Writes to "<name>.new", syncs it, renames it over "<name>" in one step ([rename]), and syncs the
     * directory so the rename itself survives a power loss. The committed file is never deleted first,
     * so at every moment either the old or the new content is there under its own name. A directory
     * created on the way is synced into its parent first ([createDirectory]). The store's acknowledgement
     * is withdrawn before anything is written ([withdrawAcknowledgement]).
     */
    private fun writeAtomically(target: File, bytes: ByteArray) {
        withdrawAcknowledgement()
        createDirectory()
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

    /**
     * Creates the store's directory and any missing parent, one level at a time, and syncs the parent of
     * each new level, so a file committed in it cannot outlive, after a power loss, the entries that
     * lead to it.
     *
     * A level whose check fails is made like a missing one: mkdir, or a directory that is there already,
     * decides, and a level that was there costs one more sync of its parent. Taken for there, a missing
     * level would be neither made nor synced.
     */
    private fun createDirectory() {
        if (presenceOf(dir) != Presence.PRESENT) {
            val levels = generateSequence(dir) { it.parentFile }.takeWhile { presenceOf(it) != Presence.PRESENT }
            for (level in levels.toList().asReversed()) {
                if (!level.mkdir() && !level.isDirectory) throw IOException("could not create the pending store")
                unsyncedLevels += level
            }
        }
        while (unsyncedLevels.isNotEmpty()) {
            syncDirectory(unsyncedLevels.first().parentFile)
            unsyncedLevels.removeAt(0)
        }
    }

    /**
     * Makes the removal of the store's directory survive a power loss, whether this instance removed it or an
     * earlier attempt did and failed at this step: before [discardStore] reports the directory gone ([shownGone])
     * and before a permit goes ([withdrawPermit]). [createDirectory] in reverse: it syncs the nearest directory
     * above the store that is there, notes-pending, or the directory above notes-pending while that is not there
     * either, as for a store
     * never made on a device where no store was, since a sync of a directory that is not there fails. A level is
     * passed on the way up only when its check shows it not there ([Presence.ABSENT]). A level whose check fails
     * throws, as a sync that fails does: which directory to sync cannot be told then.
     */
    private fun syncRemoval() {
        var above = dir.parentFile
        while (above != null) {
            when (presenceOf(above)) {
                Presence.PRESENT -> return syncDirectory(above)
                Presence.ABSENT -> above = above.parentFile
                Presence.UNKNOWN -> throw IOException("could not tell whether ${above.name} is there")
            }
        }
        throw IOException("no directory above the pending store is there")
    }

    /**
     * Removes a committed file together with any leftover ".new" beside it, and makes the removal stick. A
     * file is passed over only when it is shown not to be there: one whose presence cannot be told throws
     * ([isPresent]), as a deletion that fails does, so a removal never reports success over a file that
     * may still be there. The store's acknowledgement is withdrawn first ([withdrawAcknowledgement]).
     */
    private fun remove(file: File) {
        withdrawAcknowledgement()
        try {
            beforeRemoveForTesting?.invoke(file)
            val tmp = File(dir, file.name + NEW)
            if (isPresent(tmp)) {
                if (!tmp.delete()) throw IOException("could not remove ${tmp.name}")
                unlinked()
            }
            if (isPresent(file)) {
                if (!file.delete()) throw IOException("could not remove ${file.name}")
                unlinked()
                syncDirectory(dir)
                unlinkUnsynced = false
            }
        } catch (e: Throwable) {
            // A removal stopped halfway (for example inside a conflict copy) is finished by recovery.
            recovered = false
            throw e
        }
    }

    /** A file [remove] unlinked, whose removal lasts only once the store's directory is synced. */
    private fun unlinked() {
        unlinks++
        unlinkUnsynced = true
    }

    /** [remove] for [file] alone: a write beside it stays. */
    private fun removeExactly(file: File) {
        withdrawAcknowledgement()
        try {
            beforeRemoveForTesting?.invoke(file)
            if (isPresent(file)) {
                if (!file.delete()) throw IOException("could not remove ${file.name}")
                if (!file.name.endsWith(NEW)) syncDirectory(dir)
            }
        } catch (e: Throwable) {
            recovered = false
            throw e
        }
    }

    /**
     * The entry's header alone, from the first bytes of the file; null when the file is not in the
     * current format or anything about it does not check out, so the caller reads it whole and reports
     * it properly.
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
        private const val LINKED = "the pending store folder is a link, or lstat cannot tell"
        private val UID = Regex("^[A-Za-z0-9_-]{1,128}$")
        private val registry = ConcurrentHashMap<String, PendingNotesStore>()

        /**
         * The [highWater] of each directory's dropped instance ([unregister]), which the next instance of that
         * directory in this process starts from. A discard that finished deletes the counter, and an answer a
         * dialog showed before it must not cover text saved in the store opened after it.
         */
        private val floors = ConcurrentHashMap<String, Long>()

        /** The folder in noBackupFilesDir that holds one store folder per exact identity ([identityDir]). */
        internal const val PENDING = "notes-pending"

        /** The name of a store folder: [identityDir]'s SHA-256 digest, in lowercase hex. */
        internal val STORE_DIRECTORY = Regex("^[0-9a-f]{64}$")

        /** Test seams: crash points inside the write, conflict, and sign-out sequences. */
        @Volatile internal var beforeOriginalRemovedForTesting: (() -> Unit)? = null
        @Volatile internal var beforeRenameForTesting: ((File) -> Unit)? = null
        @Volatile internal var beforeRemoveForTesting: ((File) -> Unit)? = null
        @Volatile internal var beforeClearForTesting: (() -> Unit)? = null

        /**
         * Test seam: what a listing of the directory it is given answers in place of File.listFiles();
         * null is a listing that failed. It answers every listing the store makes itself: of its own
         * directory, and of the directories above it that [knownAbsent] lists, after a listing of it fails or
         * when [clearAll] or [discardStore] checks that the directory is gone, but not the deletion in
         * [clearAll]. It answers the listings of the discard permits' root too ([PendingNotesDiscardPermits.remove],
         * [PendingNotesDiscardPermits.listNames]).
         */
        @Volatile internal var listFilesForTesting: ((File) -> Array<File>?)? = null

        /**
         * The files in [d], or null when the listing fails, as File.listFiles answers: [d] is not there, is
         * not a directory, or the check failed. A listing of notes-pending or notes-discard that works moves
         * that folder's counter ([NotesFolderListings]).
         */
        internal fun listDirectory(d: File): Array<File>? =
            listFilesForTesting.let { if (it != null) it(d) else d.listFiles() }?.also { NotesFolderListings.listed(d) }

        /**
         * Whether [d] is shown not to be there: the nearest directory above it that can be listed does not
         * hold the next name on the way down to it. When that directory does hold the name, or no directory
         * above can be listed, it is unknown. File.exists() is not asked, for the reason [listing] gives.
         * Shown not to be there, notes-pending or notes-discard on the way moves that folder's counter
         * ([NotesFolderListings]).
         */
        internal fun knownAbsent(d: File): Boolean {
            var below = d
            while (true) {
                val above = below.parentFile ?: return false
                val names = listDirectory(above)?.map { it.name }
                if (names != null) {
                    val absent = below.name !in names
                    if (absent) NotesFolderListings.shownAbsent(d, below)
                    return absent
                }
                below = above
            }
        }

        /**
         * The store folders in notes-pending, by name in sorted order ([stores]), and every other name it holds, in
         * sorted order too ([others]). A store folder is a name of exactly 64 lowercase hex characters, whatever the
         * entry is; any other name, of a file, a folder or a link, is of a kind this build does not know ([unknown]).
         * Only store folders are ever made there, so another name may hold unsynced text a newer build wrote: it is
         * never read as nothing.
         */
        internal class StoreFolders(val stores: List<String>, val others: List<String>) {
            /** Whether notes-pending holds a name of a kind this build does not know. */
            val unknown: Boolean get() = others.isNotEmpty()
        }

        /**
         * The folders of notes-pending in [noBackup], chosen by name alone from one listing: nothing is asked of each
         * name. A notes-pending shown not to be there by two checks that agree, as a store's own folder is
         * ([shownGone]), holds none, such as one that was never made: the folder above lists without it
         * ([knownAbsent]), and its [presence] check answers [Presence.ABSENT]. A listing that fails otherwise throws
         * IOException: read as an empty one, it would hide every store. A listing that works can still come back
         * short, as in [unsynced], so a store missing from it is not shown to be gone, and neither is notes-pending
         * by a listing of the folder above alone.
         */
        internal fun storeDirectories(noBackup: File, presence: (File) -> Presence = nioPresence): StoreFolders {
            val root = File(noBackup, PENDING)
            val listed = listDirectory(root)
            if (listed == null) {
                val gone = knownAbsent(root) && (presenceForTesting?.invoke(root) ?: presence(root)) == Presence.ABSENT
                if (gone) return StoreFolders(emptyList(), emptyList())
                throw IOException("could not list the pending stores")
            }
            val (stores, others) = listed.map { it.name }.partition { STORE_DIRECTORY.matches(it) }
            return StoreFolders(stores.sorted(), others.sorted())
        }

        /** [storeDirectories] in noBackupFilesDir, with the presence check [forDirectory] gives a store on a device. */
        internal fun storeDirectories(context: Context) = storeDirectories(context.noBackupFilesDir, lstatPresence)

        /**
         * The store folders of notes-pending in [noBackup] whose instance in this process has a clear or a discard that
         * stopped ([clearStopped]), by name in sorted order. Read from memory, never from a listing: such a folder can
         * be gone while its removal may not last, or be left out of a listing that came back short. None while the
         * path of notes-pending cannot be resolved, which no store in it can be opened through either ([open]).
         */
        internal fun stoppedIn(noBackup: File): List<String> {
            val root = try {
                File(noBackup, PENDING).canonicalFile
            } catch (e: IOException) {
                return emptyList()
            }
            return registry.values.filter { it.dir.parentFile == root && STORE_DIRECTORY.matches(it.dir.name) }
                .filter { it.clearStopped() }.map { it.dir.name }.sorted()
        }

        /**
         * Test seam: what a check of whether the path it is given is there answers in place of the store's
         * own [Presence] check; null leaves the answer to that check. [Presence.UNKNOWN] is a check that failed.
         * It answers the checks of the discard permits too ([PendingNotesDiscardPermits]).
         */
        @Volatile internal var presenceForTesting: ((File) -> Presence?)? = null

        /**
         * lstat(2) through java.nio, for the JVM tests, which cannot call [Os]: NoSuchFileException is ENOENT,
         * and any other failure is unknown. Android has java.nio.file only from API 26, so a store on a device
         * gets [lstatPresence] through [forIdentity] or [forDirectory].
         */
        @SuppressLint("NewApi")
        internal val nioPresence: (File) -> Presence = { path ->
            try {
                Files.readAttributes(path.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
                Presence.PRESENT
            } catch (e: NoSuchFileException) {
                Presence.ABSENT
            } catch (e: IOException) {
                Presence.UNKNOWN
            }
        }

        /**
         * lstat(2), which does not follow a link, so a link whose target is gone is still there, as a listing
         * shows it. ENOENT is the only answer that a path is not there; any other errno is unknown.
         */
        private val lstatPresence: (File) -> Presence = { path ->
            try {
                Os.lstat(path.path)
                Presence.PRESENT
            } catch (e: ErrnoException) {
                if (e.errno == OsConstants.ENOENT) Presence.ABSENT else Presence.UNKNOWN
            }
        }

        /**
         * The presence check a store on a device gets ([lstatPresence]), for a caller outside the store that decides
         * from one path, such as a list that leaves out a store folder lstat shows not to be there. The test seam
         * [presenceForTesting] answers first, as it does for the store's own checks.
         */
        internal fun presenceOnDevice(path: File): Presence = presenceForTesting?.invoke(path) ?: lstatPresence(path)

        /**
         * Test seam: what a read of the identity of the directory it is given answers in place of the store's
         * own; null is an identity that cannot be read. JVM tests on Windows have no inode numbers to read.
         */
        @Volatile internal var identityForTesting: ((File) -> DirectoryIdentity?)? = null

        /**
         * lstat(2)'s device and inode numbers through java.nio's unix view, for the JVM tests, which cannot
         * call [Os]. Where the JVM has no such view (Windows), or the read fails, the identity cannot be read.
         * A store on a device gets [lstatIdentity] through [forIdentity] or [forDirectory].
         */
        @SuppressLint("NewApi")
        internal val nioIdentity: (File) -> DirectoryIdentity? = { path ->
            try {
                val read = Files.readAttributes(path.toPath(), "unix:dev,ino", LinkOption.NOFOLLOW_LINKS)
                val device = read["dev"] as? Long
                val inode = read["ino"] as? Long
                if (device != null && inode != null) DirectoryIdentity(device, inode) else null
            } catch (e: UnsupportedOperationException) {
                null
            } catch (e: IllegalArgumentException) {
                null
            } catch (e: IOException) {
                null
            }
        }

        /** lstat(2)'s device and inode numbers, of a link itself and not its target; null when lstat fails. */
        private val lstatIdentity: (File) -> DirectoryIdentity? = { path ->
            try {
                val stat = Os.lstat(path.path)
                DirectoryIdentity(stat.st_dev, stat.st_ino)
            } catch (e: ErrnoException) {
                null
            }
        }

        /**
         * Test seam: what a check of whether the path it is given is a symbolic link answers in place of the store's
         * own; null is a check that failed, which the store takes for a link ([followable]).
         */
        @Volatile internal var linkForTesting: ((File) -> Boolean?)? = null

        /**
         * Whether lstat(2) through java.nio shows a symbolic link, for the JVM tests, which cannot call [Os]:
         * NoSuchFileException is ENOENT, which is no link, and any other failure is unknown. A store on a device
         * gets [lstatLink] through [forIdentity] or [forDirectory].
         */
        private val nioLink: (File) -> Boolean? = { path ->
            try {
                Files.readAttributes(path.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
                    .isSymbolicLink
            } catch (e: NoSuchFileException) {
                false
            } catch (e: IOException) {
                null
            }
        }

        /**
         * Whether lstat(2), which does not follow a link, shows one: ENOENT is no link, and any other errno is
         * unknown.
         */
        private val lstatLink: (File) -> Boolean? = { path ->
            try {
                OsConstants.S_ISLNK(Os.lstat(path.path).st_mode)
            } catch (e: ErrnoException) {
                if (e.errno == OsConstants.ENOENT) false else null
            }
        }

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
         * replace an existing target in one step; JVM tests on Windows pass a java.nio atomic move. The
         * default [presence] is for the JVM tests; a store on a device is opened through [forIdentity] or
         * [forDirectory]. So are the default [permits], in a root beside [dir] (both keep every permit in
         * noBackupFilesDir/notes-discard), and the default [identity] and [link]. The first opener's functions
         * and permits are the ones kept.
         *
         * The folders above [dir] are resolved to their canonical path, and [dir]'s own name is kept as given, never
         * resolved: the instance's [PendingNotesStore.dir], and the key it is registered under, are that parent and
         * that name. So a store folder that is a link is opened at the link, never at what it points to: it never
         * shares an instance with its target, and its permit and acknowledgement are never filed under the target's
         * name. [dir] must name a folder of its own, not "." or "..".
         */
        fun open(
            dir: File,
            syncDirectory: (File) -> Unit = {},
            rename: (File, File) -> Unit = renameTo,
            presence: (File) -> Presence = nioPresence,
            permits: PendingNotesDiscardPermits = PendingNotesDiscardPermits(
                File(dir.parentFile, PendingNotesDiscardPermits.ROOT), syncDirectory, rename, presence),
            identity: (File) -> DirectoryIdentity? = nioIdentity,
            link: (File) -> Boolean? = nioLink,
        ): PendingNotesStore {
            val given = dir.absoluteFile
            val parent = given.parentFile
            require(parent != null && given.name != "." && given.name != "..") { "not a store folder of its own" }
            return registry.computeIfAbsent(File(parent.canonicalFile, given.name).path) {
                PendingNotesStore(File(it), syncDirectory, rename, presence, permits, identity, link).apply {
                    highWater = floors[it] ?: 0L
                }
            }
        }

        /** Test seam: forget every instance, as a process restart would. */
        internal fun resetForTesting() {
            registry.clear()
            floors.clear()
        }

        /** Uids come from the server and from collaborators, so they never reach a file name unchecked. */
        internal fun checkedUid(uid: String): String {
            require(UID.matches(uid)) { "not an Etebase uid" }
            return uid
        }

        /** One directory per exact identity, so a same-name replacement account never inherits it. */
        internal fun identityDir(root: File, accountType: String, accountName: String, creationId: String): File {
            val digest = MessageDigest.getInstance("SHA-256")
                .digest("v1\u0000$accountType\u0000$accountName\u0000$creationId".toByteArray(Charsets.UTF_8))
            return File(File(root, PENDING), digest.joinToString("") { "%02x".format(it) })
        }

        /**
         * Makes a rename, removal or new directory durable through [fsync], which syncs one directory and
         * answers 0 or the errno it failed with. Only a filesystem that cannot sync a directory at all
         * ([cannotSync]) is logged and passed over. Any other failure is thrown, so a write is never
         * reported saved without its sync.
         */
        internal fun directorySync(fsync: (String) -> Int, cannotSync: (Int) -> Boolean): (File) -> Unit = { dir ->
            val errno = fsync(dir.path)
            if (errno != 0) {
                if (!cannotSync(errno)) throw IOException("could not sync a pending store directory: errno $errno")
                Logger.log.warning("Pending notes directory sync not available: ${OsConstants.errnoName(errno)}")
            }
        }

        /** fsync(2) on a directory: 0, or the errno of the step that failed. */
        private val fsyncDirectory: (String) -> Int = { path ->
            try {
                val fd = Os.open(path, OsConstants.O_RDONLY, 0)
                try {
                    Os.fsync(fd)
                } finally {
                    Os.close(fd)
                }
                0
            } catch (e: ErrnoException) {
                e.errno
            }
        }

        /** EINVAL and ENOTSUP are what a filesystem that cannot sync a directory answers. */
        private val androidDirectorySync = directorySync(fsyncDirectory) { it == OsConstants.EINVAL || it == OsConstants.ENOTSUP }

        /** Outside backup and device transfer, and outside the Etebase cache's per-username directories. */
        fun forIdentity(context: Context, accountType: String, accountName: String, creationId: String) =
            forNoBackup(context.noBackupFilesDir, accountType, accountName, creationId, androidDirectorySync,
                androidRename, lstatPresence, lstatIdentity, lstatLink)

        /**
         * The store in folder [name] of notes-pending ([storeDirectories]), opened as [forIdentity] opens it, for a
         * caller that knows the folder and not the identity, such as a store whose account is gone. It is the same
         * instance [forIdentity] gives for that folder, whichever opens it first, with its permits in the same root.
         * A name that is not a store folder is refused (IllegalArgumentException).
         */
        fun forDirectory(context: Context, name: String) = forNoBackupDirectory(context.noBackupFilesDir, name,
            androidDirectorySync, androidRename, lstatPresence, lstatIdentity, lstatLink)

        /** [forDirectory] in [noBackup], as [forNoBackup] is [forIdentity] there. */
        internal fun forNoBackupDirectory(
            noBackup: File,
            name: String,
            syncDirectory: (File) -> Unit,
            rename: (File, File) -> Unit,
            presence: (File) -> Presence = nioPresence,
            identity: (File) -> DirectoryIdentity? = nioIdentity,
            link: (File) -> Boolean? = nioLink,
        ): PendingNotesStore {
            require(STORE_DIRECTORY.matches(name)) { "not a pending store folder" }
            return openIn(noBackup, File(File(noBackup, PENDING), name), syncDirectory, rename, presence, identity,
                link)
        }

        /**
         * [forIdentity] in [noBackup]: the store in notes-pending, and its discard permit and acknowledgement in
         * a root of their own beside notes-pending, so they stay readable when notes-pending cannot be listed.
         * JVM tests pass their own [syncDirectory] and [rename], and keep the default [presence], [identity] and
         * [link], which are for them.
         */
        internal fun forNoBackup(
            noBackup: File,
            accountType: String,
            accountName: String,
            creationId: String,
            syncDirectory: (File) -> Unit,
            rename: (File, File) -> Unit,
            presence: (File) -> Presence = nioPresence,
            identity: (File) -> DirectoryIdentity? = nioIdentity,
            link: (File) -> Boolean? = nioLink,
        ) = openIn(noBackup, identityDir(noBackup, accountType, accountName, creationId), syncDirectory, rename,
            presence, identity, link)

        /** The store in [dir] of notes-pending in [noBackup], with its permits in their root beside notes-pending. */
        private fun openIn(
            noBackup: File,
            dir: File,
            syncDirectory: (File) -> Unit,
            rename: (File, File) -> Unit,
            presence: (File) -> Presence,
            identity: (File) -> DirectoryIdentity?,
            link: (File) -> Boolean?,
        ) = open(dir, syncDirectory, rename, presence,
            PendingNotesDiscardPermits(File(noBackup, PendingNotesDiscardPermits.ROOT), syncDirectory, rename,
                presence), identity, link)
    }
}
