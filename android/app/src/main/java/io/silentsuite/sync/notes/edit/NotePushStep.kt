package io.silentsuite.sync.notes.edit

import com.etebase.client.exceptions.PermissionDeniedException
import io.silentsuite.sync.notes.edit.NotePushPolicy.ConflictOutcome
import io.silentsuite.sync.notes.edit.NotePushPolicy.FailureKind
import io.silentsuite.sync.notes.edit.NotePushPolicy.NotebookCheck
import io.silentsuite.sync.notes.edit.PendingNotesStore.HoldOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.Read
import io.silentsuite.sync.notes.edit.PendingNotesStore.Refusal
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendStart
import io.silentsuite.sync.syncadapter.StaleSyncRunException
import java.io.IOException

/**
 * The push step of one Notes run (design 3.3, 3.4 and 3.8): every change waiting in the pending store
 * is sent, one note per request, and each answer is applied through the store and [NotePushPolicy].
 * It is one step for the whole run, across all notebooks, between the collection refresh and the fetch.
 *
 * Whatever the step repeats because of a server answer has a bound here:
 * - an entry is rebased at most once per run, so it is pushed and fetched at most twice;
 * - a conflict whose server copy cannot be fetched is the entry's failure, with backoff;
 * - a note made from a conflict is pushed in the run that makes it, and its mark turns another
 *   conflict into a hold instead of one more note;
 * - a notebook gets one confirming fetch per run after a 403 or 404, and its result is reused;
 * - a connection error, a temporary server error, or a 403 on the confirming fetch ends the step, so a
 *   run waits out at most one timeout here.
 *
 * No Etebase type appears: the network and the cryptography sit behind [Remote], so every rule is
 * unit-tested with a stand-in. The instance holds the state of one run. A second [pass] is the retry
 * after a token renewal, and the limits above count across both passes.
 *
 * Not here: the token renewal itself and its gate, the follow-up rule (NotesSyncPolicy), notifications,
 * and the fetch that follows the step.
 */
internal class NotePushStep(
    private val store: PendingNotesStore,
    private val remote: Remote,
    private val memory: Memory,
    /** A run the user started tries every entry, backoff or not. */
    private val userInitiated: Boolean,
    /** SyncRunGuard.mayWrite: false once the run is cancelled, Notes is off, or the account generation is gone. */
    private val mayWrite: () -> Boolean = { true },
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** How the notebook stands in the Etebase cache after this run's refresh step, deleted notebooks included. */
    enum class Notebook { WRITABLE, READ_ONLY, DELETED, MISSING }

    /** An item as the server holds it: the answer to an upload, or the result of fetch(uid). [handle] is the remote's own object. */
    class ServerItem(val revision: String, val deleted: Boolean, val blob: ByteArray, val handle: Any? = null)

    /** A rebased item, ready to be stored as the entry's content. */
    class Built(val revision: String, val blob: ByteArray)

    /**
     * The network, the cryptography and the Etebase cache. Every request makes SyncRunGuard.check first,
     * and every cache write goes through SyncRunGuard.write under the cache monitor; the pending lock is
     * never held during a call. Failures are thrown as the binding throws them.
     */
    interface Remote {
        fun notebook(notebookUid: String): Notebook

        /** Uploads the entry's item alone with a transaction and no sync token; returns the saved item. */
        fun upload(entry: PendingEntry): ServerItem

        /** The server's current copy of the entry's note (fetch by uid), deleted or not. */
        fun fetch(entry: PendingEntry): ServerItem

        /** Fetches the notebook itself, to confirm a 403 or 404 on a push. */
        fun fetchNotebook(notebookUid: String): NotebookCheck.Found

        /** Writes [item], the server's copy of the entry's note, into the Etebase cache. */
        fun cache(entry: PendingEntry, item: ServerItem)

        /** Removes a notebook this account can no longer see from the Etebase cache. */
        fun unsetNotebook(notebookUid: String)

        /** The entry's change (its text and title, or its deletion) applied onto [onto]. */
        fun rebase(entry: PendingEntry, onto: ServerItem): Built

        /**
         * A new note in the same notebook that carries the entry's text, with its own uid and fresh
         * metadata, as a pending create. [conflictedCopy] titles it as a conflicted copy; otherwise it
         * keeps the entry's own title (the note was deleted elsewhere).
         */
        fun newNote(entry: PendingEntry, conflictedCopy: Boolean): PendingEntry
    }

    /**
     * What the runner keeps per identity between runs, in memory only: the note whose request ended the
     * most recent push step. That note is pushed last in the next run, whatever its failure count, so a
     * note that draws such an error by itself cannot keep the others from being tried while the user
     * keeps saving it (a save resets the count). Lost with the process, which costs at most one run.
     */
    class Memory {
        @Volatile var endedLastStep: String? = null
    }

    enum class Ended {
        /** Every entry was tried, held, or skipped in backoff. */
        COMPLETED,
        /** An error that is not about one entry ended the step; the entries not yet tried recorded nothing. */
        STOPPED,
        /** A request was answered 401 and recorded nothing: after one renewal the runner calls [pass] again. */
        NEEDS_AUTHENTICATION,
    }

    /**
     * The step so far, over every pass of the run.
     * @property pushed notes that landed, or were found to have landed.
     * @property held texts moved to the holding area.
     * @property conflicts per notebook uid, the conflicts settled with a new note or by giving a note back.
     * @property failure the run's own failure: the error that ended the step, else the first entry failure.
     * @property carriedFailure the last failure category of the most recently failed entry that was skipped
     * in backoff, so an automatic run does not record success over an entry that is still stuck.
     */
    data class Result(
        val ended: Ended,
        val pushed: Int,
        val held: Int,
        val conflicts: Map<String, Int>,
        val failure: FailureKind?,
        val carriedFailure: String?,
    ) {
        /** Every entry the run attempted was pushed or resolved, and none was skipped while stuck. */
        val succeeded: Boolean get() = ended == Ended.COMPLETED && failure == null && carriedFailure == null
    }

    private class EndPass(val ended: Ended) : RuntimeException(null, null, false, false)

    /** Pushed, resolved, held, or recorded as failed in this run: not sent again, in this pass or the next. */
    private val settled = HashSet<String>()
    private val rebased = HashSet<String>()
    private val notebookChecks = HashMap<String, NotebookCheck>()
    private val conflicts = HashMap<String, Int>()
    private var pushed = 0
    private var held = 0
    private var failure: FailureKind? = null
    private var carried: Pair<Long, String>? = null

    /**
     * Runs the step once. Cancellation and a run that may no longer write are thrown
     * (InterruptedException, StaleSyncRunException) with nothing recorded, as in the slice 1 fetch.
     */
    fun pass(): Result {
        val ended = try {
            pushWaiting()
            // A step that ran to its end has nothing to remember.
            memory.endedLastStep = null
            Ended.COMPLETED
        } catch (end: EndPass) {
            end.ended
        }
        return Result(ended, pushed, held, conflicts.toMap(), failure, carried?.second)
    }

    private fun pushWaiting() {
        ensureCurrent()
        val snapshot = store.snapshot { false }
        // A file that cannot be read is kept and reported, and the run never records success over it.
        if (snapshot.unreadable.isNotEmpty()) noteFailure(FailureKind.LOCAL)
        val sendable = ArrayList<PendingNotesStore.EntryHeader>()
        for (header in snapshot.headers) {
            if (header.state == PendingEntry.State.HELD || header.noteUid in settled) continue
            // Design 3.3 step 1: a notebook that takes no pushes gets none. The server would accept
            // writes into a deleted notebook that no client shows.
            val reason = when (remote.notebook(header.notebookUid)) {
                Notebook.WRITABLE -> null
                Notebook.READ_ONLY -> HeldReason.READ_ONLY
                Notebook.DELETED -> HeldReason.NOTEBOOK_DELETED
                Notebook.MISSING -> HeldReason.LOST_ACCESS
            }
            if (reason == null) sendable += header else holdForNotebook(header.noteUid, reason)
        }
        // The note that ended the last push step goes last; the others by fewest failures, and among
        // those the oldest change first, so a note that was just saved does not go ahead of changes
        // that have waited longer (design 3.8).
        val order = compareBy<PendingNotesStore.EntryHeader>(
            { it.noteUid == memory.endedLastStep }, { it.failureCount }, { it.version })
        for (header in sendable.sortedWith(order)) {
            if (header.noteUid in settled) continue
            if (NotePushPolicy.inBackoff(header.failureCount, header.lastFailureAt, now(), userInitiated)) {
                carry(header)
                continue
            }
            push(header.noteUid)
        }
    }

    private fun push(uid: String) {
        ensureCurrent()
        val snapshot = when (val start = store.startSend(uid)) {
            is SendStart.Ready -> start.entry
            is SendStart.Refused -> {
                when (start.reason) {
                    // Design 3.4: while the original's removal keeps failing, neither note is sent, and
                    // the run records a storage failure for the original.
                    Refusal.UNFINISHED_ORIGINAL -> {
                        (store.read(uid) as? Read.Present)?.entry?.let {
                            store.recordFailure(uid, it.version, FailureKind.LOCAL.name, now())
                        }
                        noteFailure(FailureKind.LOCAL)
                    }
                    Refusal.UNREADABLE -> noteFailure(FailureKind.LOCAL)
                    Refusal.LINKED_COPY, Refusal.NOTHING -> Unit
                }
                settled += uid
                return
            }
        }
        val saved = try {
            remote.upload(snapshot)
        } catch (e: Exception) {
            uploadFailed(snapshot, e)
            return
        }
        ensureCurrent()
        if (!cacheFirst(snapshot, saved)) return
        when (val outcome = store.completeSend(uid, snapshot.version, saved.revision, saved.blob)) {
            SendOutcome.Done -> Unit
            // The user changed the note during the upload: the newer change is rebased onto the item
            // that just landed (3.3 step 5). The save that made it asks for its own run.
            is SendOutcome.NewerLocalChange -> rebaseOntoLanded(outcome.entry, saved)
        }
        landed(uid)
    }

    private fun landed(uid: String) {
        pushed++
        settled += uid
        if (memory.endedLastStep == uid) memory.endedLastStep = null
    }

    private fun rebaseOntoLanded(newer: PendingEntry, saved: ServerItem) {
        if (newer.state == PendingEntry.State.HELD) return
        val built = try {
            remote.rebase(newer, saved)
        } catch (e: Exception) {
            if (cancelled(e)) throw e
            // The entry stays on its old base. Its next push gets a 409 whose server copy is ours,
            // and it is rebased then.
            return
        }
        store.rebase(newer.noteUid, newer.version, onto = saved.revision, revision = built.revision, blob = built.blob)
    }

    private fun uploadFailed(snapshot: PendingEntry, error: Exception) {
        val kind = classified(error)
        when (kind) {
            FailureKind.CONFLICT -> conflict(snapshot)
            // Nothing is recorded for the entry, so the pass after the renewal sends it again.
            FailureKind.AUTHENTICATION -> throw EndPass(Ended.NEEDS_AUTHENTICATION)
            FailureKind.READ_ONLY, FailureKind.LOST_ACCESS -> notebookRefused(snapshot, kind)
            FailureKind.REJECTED -> rejected(snapshot)
            FailureKind.TRANSIENT, FailureKind.LOCAL -> {
                fail(snapshot, kind)
                if (NotePushPolicy.endsPushStep(error)) endStep(snapshot.noteUid, kind)
            }
            FailureKind.CANCELLED -> throw error
        }
    }

    /** A 4xx about this content: one odd answer backs off, a second in a row for the same content holds the text. */
    private fun rejected(snapshot: PendingEntry) {
        val reason = NotePushPolicy.heldReasonFor(FailureKind.REJECTED, previousFailure = snapshot.lastFailureCategory)
        if (reason == null) fail(snapshot, FailureKind.REJECTED) else hold(snapshot.noteUid, reason, sentVersion = snapshot.version)
    }

    /**
     * A 403 or 404 on a request for this note. A single answer moves nothing: the notebook itself is
     * fetched, once per notebook per run, and the result decides. Read-only, deleted or gone is a
     * newer answer to step 1, so this entry and the notebook's entries not yet pushed are held without
     * an upload. Still writable or unknown is passing trouble: the entry backs off and the others are
     * still pushed, and a later 403 or 404 in the same notebook reuses the result.
     */
    private fun notebookRefused(snapshot: PendingEntry, kind: FailureKind) {
        val notebookUid = snapshot.notebookUid
        val stored = notebookChecks[notebookUid]
        val check = stored ?: confirm(snapshot).also { notebookChecks[notebookUid] = it }
        val reason = NotePushPolicy.heldReasonFor(kind, check)
        if (reason == null) {
            fail(snapshot, kind)
            return
        }
        for (header in store.snapshot { false }.headers) {
            if (header.notebookUid != notebookUid || header.state == PendingEntry.State.HELD || header.noteUid in settled) continue
            holdForNotebook(header.noteUid, reason)
        }
        if (check == NotebookCheck.Gone && stored == null) {
            // So the notebook does not stay listed as writable until a later run's refresh drops it.
            try {
                remote.unsetNotebook(notebookUid)
            } catch (e: Exception) {
                if (cancelled(e)) throw e
                ensureCurrent()
            }
        }
    }

    /** The one confirming fetch of a notebook in this run. A fetch that fails counts as that one. */
    private fun confirm(snapshot: PendingEntry): NotebookCheck {
        ensureCurrent()
        return try {
            remote.fetchNotebook(snapshot.notebookUid)
        } catch (e: Exception) {
            val kind = classified(e)
            when {
                kind == FailureKind.AUTHENTICATION -> throw EndPass(Ended.NEEDS_AUTHENTICATION)
                kind == FailureKind.LOST_ACCESS -> NotebookCheck.Gone
                // The server answers a read with 403 only for the whole account, and a connection or
                // temporary server error is not about this notebook either: the entry whose push led
                // here records its failure, and the step ends.
                e is PermissionDeniedException || NotePushPolicy.endsPushStep(e) -> {
                    fail(snapshot, kind)
                    endStep(snapshot.noteUid, kind)
                }
                else -> NotebookCheck.Unknown
            }
        }
    }

    /** A 409 on the entry's upload: decided against the server's current copy, never without it. */
    private fun conflict(snapshot: PendingEntry) {
        val uid = snapshot.noteUid
        ensureCurrent()
        val server = try {
            remote.fetch(snapshot)
        } catch (e: Exception) {
            when (val kind = classified(e)) {
                FailureKind.AUTHENTICATION -> throw EndPass(Ended.NEEDS_AUTHENTICATION)
                FailureKind.READ_ONLY, FailureKind.LOST_ACCESS -> notebookRefused(snapshot, kind)
                // The failed fetch is the entry's failure, so it backs off and shows its error. It is
                // never a rejection: a refusal to hand over the copy says nothing about the note's
                // content, and a rejection on record would let one later rejection hold the text.
                else -> {
                    fail(snapshot, FailureKind.TRANSIENT)
                    if (NotePushPolicy.endsPushStep(e)) endStep(uid, FailureKind.TRANSIENT)
                }
            }
            return
        }
        ensureCurrent()
        // The result is built from the entry as it is now: the user may have saved during the upload.
        val latest = (store.read(uid) as? Read.Present)?.entry
        if (latest == null || latest.state == PendingEntry.State.HELD) {
            settled += uid
            return
        }
        val decision = NotePushPolicy.decide(latest, store.landed(uid)?.revision,
            NotePushPolicy.ServerCopy(server.revision, server.deleted))
        when (decision) {
            ConflictOutcome.DONE -> if (cacheFirst(latest, server)) {
                store.completeSend(uid, latest.version, server.revision, server.blob)
                landed(uid)
            }
            ConflictOutcome.REBASE -> rebaseOnce(latest, server)
            ConflictOutcome.KEEP_BOTH -> replaceWithNewNote(latest, server, conflictedCopy = true)
            ConflictOutcome.RECREATE_AS_NEW_NOTE -> replaceWithNewNote(latest, server, conflictedCopy = false)
            // Held with the version that was sent, so a change made during the upload is not held with it.
            ConflictOutcome.HOLD_REPEATED_CONFLICT -> hold(uid, HeldReason.REPEATED_CONFLICT, sentVersion = snapshot.version)
            ConflictOutcome.RESTORE_SERVER_NOTE, ConflictOutcome.ALREADY_DELETED -> if (cacheFirst(latest, server)) {
                store.dropDelete(uid, latest.version)
                if (decision == ConflictOutcome.RESTORE_SERVER_NOTE) countConflict(latest.notebookUid)
                settled += uid
            }
            ConflictOutcome.RETRY_LATER -> error("decided with a server copy")
        }
    }

    /**
     * The server copy is an earlier upload of ours. The newer change is rebased onto it and pushed
     * again, once per entry per run. A second 409 gets its own fetch and decision in [conflict]; only a
     * copy that is ours and would need another rebase ends here, as a transient failure with backoff.
     */
    private fun rebaseOnce(latest: PendingEntry, server: ServerItem) {
        val uid = latest.noteUid
        if (!rebased.add(uid)) {
            fail(latest, FailureKind.TRANSIENT)
            return
        }
        val built = try {
            remote.rebase(latest, server)
        } catch (e: Exception) {
            classified(e)
            fail(latest, FailureKind.LOCAL)
            return
        }
        if (store.rebase(uid, latest.version, onto = server.revision, revision = built.revision, blob = built.blob)) {
            push(uid)
        } else {
            // Saved again in between; that save asks for its own run.
            settled += uid
        }
    }

    /**
     * The local text gets a new note, and the server's version stays in place. The new note is pushed
     * here, in the run that makes it: waiting for a later run would leave it on the device alone, with
     * its conflict already reported (design 3.8). Its mark is what ends the sequence under a server
     * that answers every push with such a 409.
     */
    private fun replaceWithNewNote(latest: PendingEntry, server: ServerItem, conflictedCopy: Boolean) {
        val uid = latest.noteUid
        val note = try {
            remote.newNote(latest, conflictedCopy)
        } catch (e: Exception) {
            classified(e)
            fail(latest, FailureKind.LOCAL)
            return
        }
        if (!cacheFirst(latest, server)) return
        val replaced = try {
            store.replaceWithNewNote(uid, latest.version, server.revision, note)
        } catch (e: IOException) {
            // The original records a storage failure, and neither note is sent in this run.
            fail(latest, FailureKind.LOCAL)
            settled += note.noteUid
            return
        }
        settled += uid
        if (!replaced) return
        countConflict(latest.notebookUid)
        push(note.noteUid)
    }

    /**
     * Design 3.3: the server item is written into the Etebase cache before any store change that lets
     * the note fall back to it, or a load in between would show older server text, or bring back a note
     * deleted here. False when that write failed: the entry stays, with the failure recorded.
     */
    private fun cacheFirst(entry: PendingEntry, item: ServerItem): Boolean = try {
        remote.cache(entry, item)
        true
    } catch (e: Exception) {
        classified(e)
        fail(entry, FailureKind.LOCAL)
        false
    }

    private fun holdForNotebook(uid: String, reason: HeldReason) = hold(uid, reason, sentVersion = null)

    private fun hold(uid: String, reason: HeldReason, sentVersion: Long?) {
        ensureCurrent()
        if (store.hold(uid, reason, now(), sentVersion) == HoldOutcome.HELD) held++
        settled += uid
    }

    /** Counts a failed request for the entry as it was sent; a change made since is left to be tried on its own. */
    private fun fail(entry: PendingEntry, kind: FailureKind) {
        ensureCurrent()
        store.recordFailure(entry.noteUid, entry.version, kind.name, now())
        noteFailure(kind)
        settled += entry.noteUid
    }

    private fun noteFailure(kind: FailureKind) {
        if (failure == null) failure = kind
    }

    private fun endStep(uid: String, kind: FailureKind): Nothing {
        memory.endedLastStep = uid
        failure = kind
        throw EndPass(Ended.STOPPED)
    }

    private fun countConflict(notebookUid: String) {
        conflicts[notebookUid] = (conflicts[notebookUid] ?: 0) + 1
    }

    /** A skipped entry keeps its failure count and time, so its backoff does not grow; the run carries its failure. */
    private fun carry(header: PendingNotesStore.EntryHeader) {
        val at = header.lastFailureAt ?: return
        val category = header.lastFailureCategory ?: return
        if (carried.let { it == null || at > it.first }) carried = at to category
    }

    /**
     * How a thrown error is handled. A cancelled run is rethrown, and so is anything that arrives once
     * the run may no longer write: a cancelled call can surface as any error, and a run that is no
     * longer current records nothing (design 3.7).
     */
    private fun classified(error: Exception): FailureKind {
        val kind = NotePushPolicy.classify(error)
        if (kind == FailureKind.CANCELLED) throw error
        ensureCurrent()
        return kind
    }

    private fun cancelled(error: Exception) = NotePushPolicy.classify(error) == FailureKind.CANCELLED

    private fun ensureCurrent() {
        if (!mayWrite()) throw StaleSyncRunException()
    }
}
