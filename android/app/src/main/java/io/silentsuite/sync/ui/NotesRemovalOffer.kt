package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.accounts.AccountManagerCallback
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.system.ErrnoException
import android.system.Os
import android.system.StructStat
import androidx.annotation.StringRes
import androidx.annotation.WorkerThread
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.notes.edit.NotesFolderListings.Folder
import io.silentsuite.sync.ui.NotesRemovalAllowance.FolderStat
import io.silentsuite.sync.ui.NotesRemovalAllowance.Fingerprint
import io.silentsuite.sync.ui.NotesRemovalAllowance.Key
import io.silentsuite.sync.ui.NotesRemovalAllowance.Mint
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Cause
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Decision
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import io.silentsuite.sync.ui.setup.AccountCreationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File

/**
 * The confirmation that removes an account row whose Notes files cannot be checked, below its dialog
 * ([NotesRemovalDialogFragment]): when it is offered, and what its "Remove account" does. The button starts the removal
 * itself with AccountManager.removeAccount, which asks the authenticator, never through AndroidCompat, which removes
 * without asking (the maintainer's second reply of 2026-10-20 on #709).
 *
 * This is the one place where the app removes a row it cannot prove it owns: a row without a readable creation id, by
 * its confirmation alone. A tap on the row in the removal section of Unsynced Notes opens it ([open]).
 */
internal class NotesRemovalOffer(
    private val mainType: String,
    private val allowance: NotesRemovalAllowance,
    private val seams: Seams,
) {
    interface Seams {
        /** The guard's decision for the row now. */
        fun decision(type: String, name: String): Decision

        /** The creation registry's records, or null when they cannot be read. */
        fun records(): List<AccountCreationRegistry.Record>?

        /** What stands in the way in [decision], as [NotesRemovalOffer.fingerprint] takes it. */
        fun fingerprint(decision: Decision): Fingerprint

        /** Starts the removal of the row; [removed] runs off the main thread once Android has answered. */
        fun remove(type: String, name: String, removed: () -> Unit)

        /** Whether the row is there now, or null when the rows cannot be read. */
        fun present(type: String, name: String): Boolean?

        /** Clears the registry record of the row only while it is the one with [creationId]. */
        fun clearRecord(type: String, name: String, creationId: String): Boolean
    }

    /**
     * What a tap on "Remove account" came to; [UNKNOWN] when the rows could not be read once Android answered, so
     * whether the row went is not known.
     */
    enum class Outcome { REMOVED, READABLE, CHANGED, RETRY, UNKNOWN }

    /** The registry's records of the row. */
    private fun recordsOf(records: List<AccountCreationRegistry.Record>?, type: String, name: String) =
        records.orEmpty().filter { it.accountType == type && it.accountName == name }

    /** A creation of that row in progress, which the registry records as PREPARED or CREATING. */
    private fun creating(records: List<AccountCreationRegistry.Record>?, type: String, name: String) =
        recordsOf(records, type, name).any { it.phase != AccountCreationRegistry.Phase.RECOVERY_REQUIRED }

    /**
     * The confirmation for the row, shown now, or null when it is not offered: only for a row of the main type, an
     * eligible verdict, and no creation of that row in progress. A registry that cannot be read does not stop it. The
     * counters are read first, before the guard reads any account, so a removal and a same-name re-add while it reads
     * fail the tap; the fingerprint is taken last.
     */
    @WorkerThread
    fun show(type: String, name: String): NotesRemovalAllowance.Shown? {
        if (type != mainType) return null
        val counts = allowance.counts()
        val decision = seams.decision(type, name)
        if (!decision.verdict.eligible) return null
        return offered(counts, type, name, decision)
    }

    /** What a tap on a row of the removal section of Unsynced Notes comes to ([open]). */
    sealed class Opened {
        /** The confirmation shows now. */
        data class Confirm(val shown: NotesRemovalAllowance.Shown) : Opened()

        /** The row is no longer on this device. */
        object Gone : Opened()

        /** Nothing stands in the way now: Android settings can remove the row. */
        object Allowed : Opened()

        /** Still refused, in the words of [kind]. */
        data class Refused(val kind: NotesRemovalNotice.Kind) : Opened()
    }

    /**
     * A tap on the row in the removal section of Unsynced Notes, which checks again: [show]'s steps, with a read of
     * the row between the counters and the guard, so a row that went before the tap is not offered, and one that goes
     * after the counters fails the tap ([confirm]). A read of the rows that fails says nothing either way.
     */
    @WorkerThread
    fun open(type: String, name: String): Opened {
        if (type != mainType) return Opened.Refused(NotesRemovalNotice.Kind.UNCHECKED)
        val counts = allowance.counts()
        if (seams.present(type, name) == false) return Opened.Gone
        val decision = seams.decision(type, name)
        return when {
            decision.verdict == Verdict.ALLOW -> Opened.Allowed
            !decision.verdict.eligible -> Opened.Refused(NotesRemovalNotice.kind(decision))
            // A creation of that row in progress: not offered now, as in show.
            else -> offered(counts, type, name, decision)?.let { Opened.Confirm(it) }
                ?: Opened.Refused(NotesRemovalNotice.Kind.UNCHECKED)
        }
    }

    /** [show]'s last steps, for an eligible [decision] read after [counts]. */
    private fun offered(counts: NotesRemovalAllowance.Counts, type: String, name: String,
                        decision: Decision): NotesRemovalAllowance.Shown? {
        val records = seams.records()
        if (creating(records, type, name)) return null
        val recovery = recordsOf(records, type, name)
            .firstOrNull { it.phase == AccountCreationRegistry.Phase.RECOVERY_REQUIRED }?.creationId
        return allowance.show(counts, Key(type, name, decision.creationId), decision.verdict,
            seams.fingerprint(decision), recovery)
    }

    /**
     * The tap on "Remove account" of the confirmation [id]: the guard, the registry and the fingerprint again, outside
     * any lock, then the allowance's atomic step ([NotesRemovalAllowance.mint]) with the time of the tap, [tapped], so
     * that those reads count against the allowance's two minutes, then, holding no lock, the removal itself. [done]
     * gets what it came to: once Android answered, the row is read again, and only a row that is gone is removed,
     * whoever removed it; then the registry record the confirmation saw is cleared by its own id, so a new sign-in with
     * that name is not stopped by it until the next launch. Rows that cannot be read then give [Outcome.UNKNOWN], and
     * the record stays.
     */
    @WorkerThread
    fun confirm(type: String, name: String, id: String, tapped: Long = allowance.now(), done: (Outcome) -> Unit) {
        val decision = seams.decision(type, name)
        if (creating(seams.records(), type, name)) {
            allowance.cancel(id)
            done(Outcome.CHANGED)
            return
        }
        val fingerprint = seams.fingerprint(decision)
        val key = Key(type, name, decision.creationId)
        when (val minted = allowance.mint(id, key, decision.verdict, fingerprint, tapped)) {
            Mint.Readable -> done(Outcome.READABLE)
            Mint.Changed -> done(Outcome.CHANGED)
            Mint.Retry -> done(Outcome.RETRY)
            is Mint.Done -> {
                afterMintForTesting?.invoke()
                seams.remove(type, name) { done(afterRemoval(type, name, minted.recovery)) }
            }
        }
    }

    @WorkerThread
    private fun afterRemoval(type: String, name: String, recovery: String?): Outcome {
        val present = seams.present(type, name) ?: return Outcome.UNKNOWN
        if (present) return Outcome.RETRY
        if (recovery != null) seams.clearRecord(type, name, recovery)
        return Outcome.REMOVED
    }

    /** The seams on this device. */
    private class OnDevice(private val context: Context) : Seams {
        override fun decision(type: String, name: String) =
            PendingNotesRemovalGuard.decision(context, Account(name, type))

        override fun records() = try {
            AccountCreationRegistry.open(context).records()
        } catch (e: Exception) {
            null
        }

        override fun fingerprint(decision: Decision) = fingerprintOnDevice(context, decision)

        override fun remove(type: String, name: String, removed: () -> Unit) {
            val answered = AccountManagerCallback<Bundle> { io.launch { removed() } }
            try {
                AccountManager.get(context).removeAccount(Account(name, type), null, answered,
                    Handler(Looper.getMainLooper()))
            } catch (e: Exception) {
                // Nothing was started; the row is read again all the same.
                io.launch { removed() }
            }
        }

        override fun present(type: String, name: String): Boolean? = try {
            Account(name, type) in AccountManager.get(context).getAccountsByType(type)
        } catch (e: Exception) {
            null
        }

        override fun clearRecord(type: String, name: String, creationId: String) = try {
            AccountCreationRegistry.open(context).clearOwned(type, name, creationId)
        } catch (e: Exception) {
            false
        }
    }

    companion object {
        /** Test seam: runs after a tap made the slot and before the button's own removal starts. */
        @Volatile internal var afterMintForTesting: (() -> Unit)? = null

        /** Where the removal's answer goes on, off the main thread, for as long as the process lives. */
        private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        /** The offer on this device, over this process's allowance. */
        fun onDevice(context: Context) =
            NotesRemovalOffer(App.accountType, NotesRemovalAllowance.process, OnDevice(context.applicationContext))

        /**
         * What stands in the way in [decision], in [noBackup]: [stat] of each folder of its reason, and for names of an
         * unknown kind in notes-pending, those names from the guard's own listing ([Decision.unknown]) with [lstat] of
         * each. Nothing here lists a folder or opens an entry; [stat] follows a link and [lstat] does not.
         */
        internal fun fingerprint(
            noBackup: File,
            decision: Decision,
            stat: (File) -> FolderStat,
            lstat: (File) -> FolderStat,
        ): Fingerprint {
            val reason = decision.verdict.reason.orEmpty()
            val stats = reason.map { it.folder }.distinct().associateWith { stat(File(noBackup, it.folderName)) }
            if (Cause.PENDING_UNKNOWN_KIND !in reason) return Fingerprint(stats)
            val pending = File(noBackup, Folder.PENDING.folderName)
            return Fingerprint(stats, decision.unknown, decision.unknown.associateWith { lstat(File(pending, it)) })
        }

        /** [fingerprint] on this device, in no_backup: the offer's and the authenticator's answer's. */
        @WorkerThread
        fun fingerprintOnDevice(context: Context, decision: Decision): Fingerprint =
            fingerprintIn(context.noBackupFilesDir, decision)

        /** [fingerprint] in [noBackup], by Os.stat and Os.lstat. */
        @WorkerThread
        internal fun fingerprintIn(noBackup: File, decision: Decision): Fingerprint =
            fingerprint(noBackup, decision, stat = { stat(it) }, lstat = { lstat(it) })

        /** [stat] with its change time in nanoseconds: st_ctime's whole seconds would miss a change in the same one. */
        private fun folderStat(stat: StructStat) = FolderStat.Stat(stat.st_dev, stat.st_ino, stat.st_mode,
            stat.st_ctim.tv_sec * 1_000_000_000L + stat.st_ctim.tv_nsec)

        /** The stat of [path], following a link, or the errno it failed with. */
        private fun stat(path: File): FolderStat = try {
            folderStat(Os.stat(path.path))
        } catch (e: ErrnoException) {
            FolderStat.Failed(e.errno)
        }

        /** The lstat of [path], of a link itself and not its target, or the errno it failed with. */
        private fun lstat(path: File): FolderStat = try {
            folderStat(Os.lstat(path.path))
        } catch (e: ErrnoException) {
            FolderStat.Failed(e.errno)
        }

        /** The confirmation's words for what stands in the way. */
        @StringRes
        fun text(reason: Set<Cause>): Int = when (reason) {
            setOf(Cause.PENDING_UNLISTED) -> R.string.notes_remove_uncheckable_text_root
            setOf(Cause.DISCARD_UNLISTED) -> R.string.notes_remove_uncheckable_text_permits
            setOf(Cause.PENDING_UNLISTED, Cause.DISCARD_UNLISTED) -> R.string.notes_remove_uncheckable_text_both
            setOf(Cause.PENDING_UNKNOWN_KIND) -> R.string.notes_remove_uncheckable_text_unknown_kind
            else -> throw IllegalArgumentException("no confirmation for $reason")
        }

        /** What the screen says once a tap came to [outcome]. */
        @StringRes
        fun message(outcome: Outcome): Int = when (outcome) {
            Outcome.REMOVED -> R.string.notes_remove_uncheckable_done
            Outcome.READABLE -> R.string.notes_remove_uncheckable_readable
            Outcome.CHANGED -> R.string.notes_remove_uncheckable_changed
            Outcome.RETRY -> R.string.notes_remove_uncheckable_retry
            Outcome.UNKNOWN -> R.string.notes_remove_uncheckable_unknown
        }
    }
}
