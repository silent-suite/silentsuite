package io.silentsuite.sync.ui

import android.os.SystemClock
import io.silentsuite.sync.notes.edit.NotesFolderListings
import io.silentsuite.sync.notes.edit.NotesFolderListings.Folder
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Cause
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import io.silentsuite.sync.utils.AccountRowChanges
import java.security.SecureRandom

/**
 * The one-time confirmed removal of an account row whose Notes files cannot be checked, by the maintainer's second
 * reply of 2026-10-20 on #709: it deletes no Notes files, lasts at most 2 minutes ([WINDOW_MS]), is used once, lives
 * only in this process, and is checked and used up in one atomic step against the exact (type, name) and the counter
 * of adds and removals of main-type account rows ([AccountRowChanges]). The guard's verdict must be eligible
 * ([Verdict.eligible]) at every step, for the same reason ([Verdict.reason]); a folder that cannot be listed must not
 * have been listed or shown gone since ([NotesFolderListings]), and nothing in the [Fingerprint] may have changed: the
 * stat of each folder of the reason, and for names of an unknown kind in notes-pending, those names and the lstat of
 * each. Those names bind no folder counter, since the guard's own listings of notes-pending move it at every step.
 *
 * 1. A confirmation that opens reads [counts] first, before any account read, then shows ([show]) for an eligible
 *    verdict. One confirmation shows at a time; a newer one, [cancel] or a tap ([mint]) ends it.
 * 2. The tap ([mint]) compares, under the lock, the confirmation it was shown for, the row, the verdict's reason, the
 *    counters it binds and the fingerprint, checks that its own reads ended within [WINDOW_MS] of the tap, and then
 *    moves the row counter by a compare-and-set from the count the confirmation read: that is the tap's own move.
 *    Only then is there a slot, holding the count after that move and the time of the tap.
 * 3. The authenticator's answer ([answer]) takes a slot for its (type, name) out first, whatever follows, so it is
 *    used once by whoever asks first; it holds only while nothing has changed and the compare-and-set from the
 *    slot's count works.
 *
 * Everything is kept in memory, under one lock taken last, inside which nothing reads a file, asks AccountManager or
 * takes another lock. Nothing here starts a removal.
 */
internal class NotesRemovalAllowance(
    private val rows: AccountRowChanges,
    private val folders: (Folder) -> Long,
    /** Milliseconds since boot, as SystemClock.elapsedRealtime. */
    private val clock: () -> Long,
    private val newId: () -> String,
) {
    /**
     * The row an allowance is for, with the creation id the guard read for the row; a confirmation is only ever shown
     * for null.
     */
    data class Key(val type: String, val name: String, val creationId: String?)

    /**
     * What a stat of one folder, or an lstat of one entry, answered: its device, inode, mode and change time, or the
     * errno it failed with.
     */
    sealed class FolderStat {
        data class Stat(val device: Long, val inode: Long, val mode: Int, val changed: Long) : FolderStat()
        data class Failed(val errno: Int) : FolderStat()
    }

    /**
     * What stands in the way, taken outside the lock: the stat of each folder of the reason ([stats]), and for names of
     * an unknown kind in notes-pending, those names, sorted, from the guard's own listing ([names]), with the lstat of
     * each ([entries]), which does not follow a link.
     */
    data class Fingerprint(
        val stats: Map<Folder, FolderStat>,
        val names: List<String> = emptyList(),
        val entries: Map<String, FolderStat> = emptyMap(),
    )

    /** The counters a confirmation starts from, read before anything else. */
    class Counts internal constructor(internal val rows: Long, internal val folders: Map<Folder, Long>)

    /** The confirmation that shows now. */
    class Shown internal constructor(
        val id: String,
        val key: Key,
        val reason: Set<Cause>,
        internal val rows: Long,
        internal val folders: Map<Folder, Long>,
        internal val fingerprint: Fingerprint,
        /** The creation id of the registry's RECOVERY_REQUIRED record of the row, when it had one. */
        internal val recovery: String?,
    )

    /** What a tap gives. */
    sealed class Mint {
        /** The slot is there; [recovery] is the registry record the confirmation saw. */
        data class Done(val key: Key, val recovery: String?) : Mint()

        /** A folder that could not be listed was listed, or shown gone, since the confirmation showed. */
        object Readable : Mint()

        /** The accounts changed: an add or removal, another creation id, or another confirmation since. */
        object Changed : Mint()

        /** The verdict or the fingerprint is not what the confirmation showed, or the tap's reads took [WINDOW_MS]. */
        object Retry : Mint()
    }

    private class Slot(
        val key: Key,
        val reason: Set<Cause>,
        val rows: Long,
        val folders: Map<Folder, Long>,
        val fingerprint: Fingerprint,
        val tapped: Long,
    )

    private val lock = Any()
    private var shown: Shown? = null
    private var slot: Slot? = null

    /** The time of a tap: read first, on the tap's own thread, so that all that follows counts against [WINDOW_MS]. */
    fun now(): Long = clock()

    /** The counters now: the first step of a confirmation, before the guard reads any account. */
    fun counts(): Counts = Counts(rows.count(), Folder.entries.associateWith { folders(it) })

    /**
     * Shows the confirmation for [key] in place of any other, for [verdict] with [fingerprint] taken after it, from
     * [counts] read before the verdict; null, and nothing shown, when [verdict] is not eligible or [key] has a creation
     * id.
     */
    fun show(counts: Counts, key: Key, verdict: Verdict, fingerprint: Fingerprint, recovery: String?): Shown? {
        if (key.creationId != null) return null
        val reason = verdict.reason ?: return null
        // Only a folder that cannot be listed binds its counter: the guard's own listings move notes-pending's.
        val bound = counts.folders.filterKeys { folder -> reason.any { it.unlisted && it.folder == folder } }
        val made = Shown(newId(), key, reason, counts.rows, bound, fingerprint, recovery)
        synchronized(lock) { shown = made }
        return made
    }

    /** The confirmation [id] while it shows, or null. */
    fun shown(id: String): Shown? = synchronized(lock) { shown?.takeIf { it.id == id } }

    /** Ends the confirmation [id], as its Cancel, Back or a tap outside it does; another one stays. */
    fun cancel(id: String) {
        synchronized(lock) { if (shown?.id == id) shown = null }
    }

    /**
     * The tap on the confirmation [id] at [tapped], with [key], [verdict] and [fingerprint] read again since, outside
     * the lock. It ends the confirmation, whatever it gives, so a later state needs a new one. [Mint.Done] only when
     * the row, the verdict's reason, the counters it binds and the fingerprint are what it showed, less than
     * [WINDOW_MS] has passed since [tapped], and the row counter moves from the count it read.
     */
    fun mint(
        id: String,
        key: Key,
        verdict: Verdict,
        fingerprint: Fingerprint,
        tapped: Long = clock(),
    ): Mint = synchronized(lock) {
        val confirmed = shown?.takeIf { it.id == id } ?: return@synchronized Mint.Changed
        shown = null
        when {
            confirmed.folders.any { (folder, count) -> folders(folder) != count } -> Mint.Readable
            key != confirmed.key -> Mint.Changed
            verdict.reason != confirmed.reason || fingerprint != confirmed.fingerprint -> Mint.Retry
            clock() - tapped >= WINDOW_MS -> Mint.Retry
            !rows.moveIfUnchanged(confirmed.rows) -> Mint.Changed
            else -> {
                slot = Slot(confirmed.key, confirmed.reason, confirmed.rows + 1, confirmed.folders,
                    confirmed.fingerprint, tapped)
                Mint.Done(confirmed.key, confirmed.recovery)
            }
        }
    }

    /**
     * The answer to a removal of [key]'s row, for [verdict] and [fingerprint] read just now. A slot for its (type,
     * name) is taken out first, whatever follows. [Verdict.ALLOW] moves the row counter and answers true. Otherwise
     * true only for an eligible verdict with the slot's reason, a slot for this exact [key], with the same fingerprint
     * and bound folder counters, tapped less than [WINDOW_MS] ago, and a compare-and-set of the row counter from the
     * slot's count. A slot for another row stays.
     */
    fun answer(key: Key, verdict: Verdict, fingerprint: Fingerprint?): Boolean = synchronized(lock) {
        val taken = slot?.takeIf { it.key.type == key.type && it.key.name == key.name }
        if (taken != null) slot = null
        if (verdict == Verdict.ALLOW) {
            rows.before()
            return@synchronized true
        }
        taken != null && verdict.eligible && verdict.reason == taken.reason && key == taken.key &&
            fingerprint == taken.fingerprint && taken.folders.all { (folder, count) -> folders(folder) == count } &&
            clock() - taken.tapped < WINDOW_MS && rows.moveIfUnchanged(taken.rows)
    }

    /** Test seam: no confirmation and no slot, as at process start. The counters are never reset. */
    fun resetForTesting() {
        synchronized(lock) {
            shown = null
            slot = null
        }
    }

    companion object {
        /** How long a slot lasts after its tap. */
        const val WINDOW_MS = 120_000L

        /** The one allowance of this process. */
        val process = NotesRemovalAllowance(AccountRowChanges.mainType, NotesFolderListings::count,
            SystemClock::elapsedRealtime, ::randomId)

        private val random = SecureRandom()

        /** A random 128-bit id, in hex. */
        private fun randomId(): String =
            ByteArray(16).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
    }
}
