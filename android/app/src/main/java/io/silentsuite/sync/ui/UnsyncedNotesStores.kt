package io.silentsuite.sync.ui

import android.accounts.AccountManager
import android.content.Context
import androidx.annotation.WorkerThread
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.Companion.StoreFolders
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.ui.UnsyncedNotesDiscardPolicy.Failure
import io.silentsuite.sync.ui.UnsyncedNotesDiscardPolicy.Result
import io.silentsuite.sync.ui.UnsyncedNotesDiscardPolicy.Step
import java.io.File
import java.io.IOException

/**
 * One Notes store the Settings way out shows: its folder in notes-pending, the present account it belongs to, if any,
 * and what it holds that has not synced. [answer] is null when reading the store threw: there is nothing to confirm.
 * [stopped]: a discard of the store, from this screen or a sign-out, got as far as deleting and has not finished
 * ([PendingNotesStore.clearStopped]); its row then says so, and is the Retry whatever [answer] says, unless the read
 * threw.
 */
internal data class UnsyncedNotesRow(
    val directory: String,
    val owner: ExactAccountIdentity?,
    val answer: UnsyncedNotes?,
    val stopped: Boolean,
)

/**
 * Every store that holds unsynced text, cannot be read, or has a discard that stopped ([UnsyncedNotesRow.stopped]), in
 * folder-name order. [othersUnlisted]: notes-pending could not be listed, so stores that no present account or known
 * path names could not be found; or notes-pending lists but left out a folder whose path is known and that lstat does
 * not show absent; or a read of the known paths threw. A notes-discard that cannot be listed, or a creation registry
 * whose rows do not decode, does not throw there: it names no folders, and sets nothing. [unknownOthers]: notes-pending
 * holds a name that is not a store folder, of a kind this build cannot read.
 */
internal data class UnsyncedNotesListing(
    val rows: List<UnsyncedNotesRow>,
    val othersUnlisted: Boolean,
    val unknownOthers: Boolean,
)

/**
 * The Settings way out for unsynced Notes, below its screen: it finds every Notes store on this device and discards
 * one store that the user confirmed. It reads only the account list, the store files, the discard permits, from
 * memory the stores whose discard stopped in this process ([PendingNotesStore.stoppedIn]), and the names of
 * notes-discard's records, the active-account preference and the creation registry, so it works offline and without
 * a session, also for a store whose account is gone (the maintainer's condition of
 * 2026-10-18 on #709). It opens every store by its folder's name ([PendingNotesStore.forDirectory]), never keeps an
 * instance, and reads no acknowledgement as authority for anything.
 */
internal object UnsyncedNotesStores {
    /** The exact identity of an account row whose creation id [creationId] reads, or null when it does not. */
    internal fun identity(type: String, name: String, creationId: String?): ExactAccountIdentity? =
        creationId?.takeIf(String::isNotBlank)?.let { ExactAccountIdentity(type, name, it) }

    /**
     * The present accounts whose creation id reads. A read that throws gives none: the stores then show as not matched
     * to an account, and nothing is decided from that.
     */
    fun presentAccounts(context: Context): List<ExactAccountIdentity> = try {
        val manager = AccountManager.get(context)
        manager.getAccountsByType(App.accountType).mapNotNull {
            identity(it.type, it.name, manager.getUserData(it, AccountSettings.KEY_CREATION_ID))
        }
    } catch (e: Exception) {
        emptyList()
    }

    /**
     * Every store on this device that holds anything, cannot be read, or has a discard that stopped. Never on the main
     * thread.
     */
    @WorkerThread
    fun read(context: Context): UnsyncedNotesListing = read(context.noBackupFilesDir, presentAccounts(context),
        folders = { PendingNotesStore.storeDirectories(context) },
        open = { PendingNotesStore.forDirectory(context, it) },
        pathFound = { PendingNotesRemovalGuard.foundByPath(context) },
        presence = PendingNotesStore::presenceOnDevice)

    /**
     * [read] for the stores in [noBackup], with [accounts] present, the folders of notes-pending listed by [folders]
     * and each store opened by [open]. The folders are those notes-pending lists, every present account's own, every
     * folder whose path is known otherwise ([pathFound]: records in notes-discard, the active account, the creation
     * registry), read whether or not notes-pending lists, and every folder whose clear or discard stopped in this
     * process ([PendingNotesStore.stoppedIn]), which can be gone, or left out of a listing, while its Retry is owed. So
     * a listing that comes back short cannot hide a store that a present account or a known path names; a folder that
     * is not there counts nothing and is not made, though while notes-pending lists and notes-discard cannot be listed,
     * a first count by a new instance answers that it could not be counted, which keeps a row. A store is kept while
     * it holds anything, its read throws, or its
     * discard stopped ([UnsyncedNotesRow.stopped]). The last is told by the store's state, never by its count, which
     * can come back short, or find nothing once the text went while an unlink whose sync failed can come back. The
     * counts run no recovery and write nothing in a store, though a count of a store that lists withdraws its
     * acknowledgement ([PendingNotesStore.unsynced]).
     *
     * While notes-pending lists, a folder whose path is known, or a present account's, or one whose discard stopped,
     * that the listing left out and that its [presence] check does not show absent, flags the others
     * ([UnsyncedNotesListing.othersUnlisted]): the listing came back short, so a store that no path names may be
     * missing too. So does a read of the known paths that throws. The checks come after the counts, and a folder made
     * between the listing and its check flags once.
     *
     * While notes-pending cannot be listed and is not shown gone, a store that its [presence] check shows not to be
     * there is left out, a present account's included, unless its discard stopped: it holds nothing, and an
     * acknowledgement for it could never be recorded, since a folder that is not there has no identity. The check is
     * asked after the store's count, and whether its discard stopped is asked once more after the check, so a discard
     * that stops while the stores are read keeps its row. A folder whose check fails is kept, and so is every folder
     * whose clear or discard stopped, whatever its check shows: its row is the Retry.
     */
    internal fun read(
        noBackup: File,
        accounts: List<ExactAccountIdentity>,
        folders: () -> StoreFolders = { PendingNotesStore.storeDirectories(noBackup) },
        open: (String) -> PendingNotesStore,
        pathFound: () -> Set<String> = { emptySet() },
        presence: (File) -> PendingNotesStore.Presence = PendingNotesStore.nioPresence,
    ): UnsyncedNotesListing {
        val byDirectory = accounts.associateBy { directoryOf(noBackup, it) }
        val listed = try {
            folders()
        } catch (e: IOException) {
            null
        }
        // Read whether or not notes-pending lists: a listing can come back short with no error, and must not hide a
        // store that the removal guard finds by path. Null when that read throws, which flags the others below.
        val known = try {
            pathFound()
        } catch (e: Exception) {
            null
        }
        val stopped = PendingNotesStore.stoppedIn(noBackup)
        val pending = File(noBackup, PendingNotesStore.PENDING)
        val found = (listed?.stores.orEmpty() + byDirectory.keys + known.orEmpty() + stopped).distinct().sorted()
            .map { row(it, byDirectory[it], open) }
            .filter { it.answer == null || it.answer.anything || it.stopped }
        val rows = if (listed != null) found else found.mapNotNull { whileUnlisted(it, pending, presence, open) }
        // A folder that the listing left out and that lstat does not show absent: the listing came back short.
        val short = listed != null && listed.stores.toHashSet().let { inListing ->
            (byDirectory.keys + known.orEmpty() + stopped).distinct().sorted()
                .any { it !in inListing && presence(File(pending, it)) != PendingNotesStore.Presence.ABSENT }
        }
        return UnsyncedNotesListing(rows, othersUnlisted = listed == null || short || known == null,
            unknownOthers = listed?.unknown == true)
    }

    /**
     * [row], as [read] keeps it while notes-pending cannot be listed: null for a store whose discard has not
     * stopped and whose folder its [presence] check shows not to be there. The check is asked after the count, and
     * the store is read once more after a check that shows it absent, so a discard that stopped in between keeps
     * its row. A check that fails keeps the row.
     */
    private fun whileUnlisted(
        row: UnsyncedNotesRow,
        pending: File,
        presence: (File) -> PendingNotesStore.Presence,
        open: (String) -> PendingNotesStore,
    ): UnsyncedNotesRow? {
        if (row.stopped || presence(File(pending, row.directory)) != PendingNotesStore.Presence.ABSENT) return row
        return row(row.directory, row.owner, open).takeIf { it.stopped }
    }

    /**
     * The store in [directory] read again as [read] reads it, with its account found again now, for an answer from a
     * dialog made in another app process ([UnsyncedNotesDiscardPolicy.restored]). Never on the main thread.
     */
    @WorkerThread
    fun reread(context: Context, directory: String): UnsyncedNotesRow = reread(context.noBackupFilesDir, directory,
        ownerOf(context, directory),
        folders = { PendingNotesStore.storeDirectories(context) },
        open = { PendingNotesStore.forDirectory(context, it) },
        presence = PendingNotesStore::presenceOnDevice)

    /**
     * [reread] for the store in [directory] of [noBackup], with [owner] as its account, notes-pending listed by
     * [folders], the store opened by [open], and [presence] for its folder's check. While notes-pending cannot be
     * listed, a store whose discard has not stopped and whose folder its check shows not to be there holds nothing, as
     * [read] leaves it out: its answer is [UnsyncedNotes.NOTHING], so the dialog is not shown again.
     */
    internal fun reread(
        noBackup: File,
        directory: String,
        owner: ExactAccountIdentity?,
        folders: () -> StoreFolders = { PendingNotesStore.storeDirectories(noBackup) },
        open: (String) -> PendingNotesStore,
        presence: (File) -> PendingNotesStore.Presence = PendingNotesStore.nioPresence,
    ): UnsyncedNotesRow {
        val lists = try {
            folders()
            true
        } catch (e: IOException) {
            false
        }
        val row = row(directory, owner, open)
        if (lists) return row
        return whileUnlisted(row, File(noBackup, PendingNotesStore.PENDING), presence, open)
            ?: row.copy(answer = UnsyncedNotes.NOTHING)
    }

    /**
     * The store in [directory] as [read] reads it, with [owner] as its account. Whether its discard stopped is asked
     * after its count, which waits for a discard that runs, so a stop it made is seen; it reads memory only.
     */
    private fun row(
        directory: String,
        owner: ExactAccountIdentity?,
        open: (String) -> PendingNotesStore,
    ): UnsyncedNotesRow {
        val store = try {
            open(directory)
        } catch (e: Exception) {
            null
        }
        val answer = try {
            store?.unsynced()
        } catch (e: Exception) {
            null
        }
        return UnsyncedNotesRow(directory, owner, answer, stopped = store?.clearStopped() == true)
    }

    /**
     * The user's confirmation of [shown] for the store in [directory], a Retry when [retry]. Never on the main thread.
     * The store's account, when it is present, is found again now, and its Notes run is canceled first when it runs or
     * waits to, and found once more after a discard that finished, for [discard]'s step 5. Whether a discard of the
     * store stopped in this process is read from memory ([PendingNotesStore.stoppedIn]) only when the store is not
     * reached, for step 2.
     */
    @WorkerThread
    fun discard(context: Context, directory: String, label: String?, shown: UnsyncedNotes, retry: Boolean): Result =
        discard(directory, label, shown, retry, ownerOf(context, directory),
            open = { PendingNotesStore.forDirectory(context, it) },
            running = { NotesSyncCoordinator.isActive(it) || NotesSyncCoordinator.isPending(it) },
            cancel = NotesSyncCoordinator::cancel,
            ownerNow = { ownerOf(context, directory) },
            stoppedBefore = { directory in PendingNotesStore.stoppedIn(context.noBackupFilesDir) })

    /**
     * [discard], with the store opened by [open], the Notes job asked through [running] and [cancel], the store's
     * account found again by [ownerNow], and a discard of the store that stopped in this process told by
     * [stoppedBefore]:
     * 1. For a discard of a store whose account [owner] is present, that exact generation's Notes run is canceled
     *    when [running] says it runs or waits to. Only then, since a cancel always tells the job's listeners, and
     *    neither an acknowledgement nor an answer of nothing deletes text, so they cancel nothing.
     * 2. The store is opened. A throw in 1 or 2 is a failure before this call deleted anything, but the attempt
     *    before it may have: on a Retry, and when [stoppedBefore], asked only then, finds that a discard of the store
     *    stopped, as for the dialog that a stopped row's Retry shows again. Such a failure is taken as a Retry's.
     * 3. An answer of nothing, the Retry of a row whose discard stopped ([UnsyncedNotesRow.stopped]), goes on only
     *    while that discard has not finished, whatever [retry] says: on any other instance it would delete notebook
     *    copies, landed records and the counter that nobody confirmed. Once another call finished it, that is Done;
     *    otherwise the stores are only read again. An acknowledgement over a store whose discard stopped records
     *    nothing and says nothing, also not that nothing was deleted: the stores are read again, and the store's row
     *    is then the Retry.
     * 4. The store discards what [shown] covers ([PendingNotesStore.discardStore]), under its own lock: it counts
     *    again, records the permit before any file goes, and refuses anything it was not shown. An
     *    IllegalStateException there is an instance that was dropped, before this call deleted anything; any other
     *    throw may come from anywhere.
     * 5. Only once the folder is gone, only when this call's discard is the one clear that finished the instance, and
     *    only while a present account owns the folder, found again now by [ownerNow], the instance is dropped, so the
     *    next opener gets a new one that takes saves ([PendingNotesStore.unregisterIfFinishedOnce]). Any other
     *    finished instance stays registered and closed for the rest of the process, as the sign-out keeps the one it
     *    cleared before its account is removed: a late save or run for an account that is gone is refused and does
     *    not bring the folder back. A store with no present account, or whose account read throws, keeps it too.
     * 6. A discard of the store that stopped, whoever started it ([PendingNotesStore.clearStopped], read after the
     *    call), may have deleted already, so whatever the store answered is taken as a Retry's
     *    ([UnsyncedNotesDiscardPolicy.result]).
     */
    internal fun discard(
        directory: String,
        label: String?,
        shown: UnsyncedNotes,
        retry: Boolean,
        owner: ExactAccountIdentity?,
        open: (String) -> PendingNotesStore,
        running: (ExactAccountIdentity) -> Boolean,
        cancel: (ExactAccountIdentity) -> Unit,
        ownerNow: () -> ExactAccountIdentity?,
        stoppedBefore: () -> Boolean,
    ): Result {
        val store = try {
            if (shown.listed && shown.anything && owner != null && running(owner)) cancel(owner)
            open(directory)
        } catch (e: Exception) {
            return UnsyncedNotesDiscardPolicy.result(shown, retry || stoppedBefore(), directory, label,
                Failure.BEFORE_DISCARD)
        }
        val stopped = store.clearStopped()
        if (!shown.anything && !stopped) return if (store.clearedInFull()) Result.Done else Result.Reload
        if (stopped && UnsyncedNotesDiscardPolicy.step(shown) == Step.ACKNOWLEDGE) return Result.Reload
        // Read again after the call: a discard of the store that stopped, whoever started it, may have deleted already.
        fun asRetry() = retry || store.clearStopped()
        val ended = try {
            store.discardStore(shown)
        } catch (e: IllegalStateException) {
            return UnsyncedNotesDiscardPolicy.result(shown, asRetry(), directory, label, Failure.BEFORE_DISCARD)
        } catch (e: Exception) {
            return UnsyncedNotesDiscardPolicy.result(shown, asRetry(), directory, label, Failure.UNKNOWN)
        }
        if (ended == PendingNotesStore.DiscardOutcome.Done && ownedNow(ownerNow)) store.unregisterIfFinishedOnce()
        return UnsyncedNotesDiscardPolicy.result(shown, asRetry(), directory, label, ended)
    }

    /** Whether [ownerNow] finds a present account for the store; a read that throws finds none. */
    private fun ownedNow(ownerNow: () -> ExactAccountIdentity?): Boolean = try {
        ownerNow() != null
    } catch (e: Exception) {
        false
    }

    /** The present account whose store is in [directory], or none, as when its read throws ([presentAccounts]). */
    private fun ownerOf(context: Context, directory: String): ExactAccountIdentity? =
        presentAccounts(context).firstOrNull { directoryOf(context.noBackupFilesDir, it) == directory }

    private fun directoryOf(noBackup: File, account: ExactAccountIdentity) =
        PendingNotesStore.identityDir(noBackup, account.type, account.name, account.creationId).name
}
