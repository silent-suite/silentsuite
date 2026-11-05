package io.silentsuite.sync.ui

import android.accounts.AccountManager
import android.content.Context
import androidx.annotation.WorkerThread
import io.silentsuite.sync.App
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.Companion.StoreFolders
import io.silentsuite.sync.notes.edit.PendingNotesStore.DiscardOutcome
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.CreationId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.io.File

/**
 * The startup sweep of Notes stores whose account is gone: once per app start, off the main thread, it removes a store
 * folder of notes-pending that no present owner names, and only when the store's own discard of such a store
 * ([PendingNotesStore.discardOrphan]) finds it clean by two kinds of listing, or covered by a discard permit the user
 * confirmed. In every other case it writes and deletes nothing in that store, which the next start tries again.
 *
 * Ownership is read once, before the first store lock: the account rows of the main type, each with its creation id
 * ([PendingNotesRemovalGuard.rows]), the active-account preference, read from the preference alone
 * ([ActiveAccountManager.savedIdentity]), and the last folder that preference named at a sweep that went ahead
 * ([NotesLastActiveRecord]). The store of any of them is never opened. The sweep reads no acknowledgement and no
 * allowance as authority and records none, takes no candidate from the names in notes-discard, never reads the creation
 * registry, and never builds AccountSettings or takes the Etebase cache's monitor. Its one log line holds counts, a
 * reason or a class name only.
 */
internal object NotesStartupSweep {
    /** What holds a whole run back, before any store is opened, so that it deletes nothing. */
    enum class HoldBack {
        /** notes-pending cannot be listed and is not shown gone ([PendingNotesStore.storeDirectories]). */
        ROOT_UNLISTABLE,

        /** The account list cannot be read. */
        ACCOUNTS_UNREADABLE,

        /** A row of the main type has no creation id that reads, so the folder of its store is not known. */
        ROW_WITHOUT_ID,

        /** The account list holds no row of the main type: as a misread, it would leave every store unowned. */
        NO_ACCOUNTS,

        /** The active-account preference cannot be read. */
        ACTIVE_UNREADABLE,

        /** The record cannot be read, or holds anything but one store folder name or nothing. */
        LAST_ACTIVE_UNREADABLE,

        /** The record had to name the preference's folder, and its write failed. */
        RECORD_WRITE_FAILED,
    }

    /** What one run did. */
    sealed class Outcome {
        /** notes-pending holds no store folder, or is shown gone; no account and no record was read. */
        object NoStores : Outcome()

        /** The run stopped at [reason]. */
        data class HeldBack(val reason: HoldBack) : Outcome()

        /**
         * The run went ahead: [removed] stores are gone ([DiscardOutcome.Done]); [kept] were left as they were
         * ([DiscardOutcome.Changed], [DiscardOutcome.PermitNotRecorded]); [stopped] were not finished
         * ([DiscardOutcome.NotFinished]); [failed] could not be opened or discarded, or gave an acknowledgement's
         * answer, which [PendingNotesStore.discardOrphan] never gives; [others] names in notes-pending are not store
         * folders, and none was opened.
         */
        data class Swept(val removed: Int, val kept: Int, val stopped: Int, val failed: Int, val others: Int) :
            Outcome()
    }

    /** The launch of this process start, for the device tests to wait on; set only by [launchIn]. */
    @Volatile var startup: Job? = null
        private set

    /** Starts the one sweep of this process start in [scope], off the main thread (App.onCreate). */
    fun launchIn(scope: CoroutineScope, context: Context) {
        startup = scope.launch(Dispatchers.IO) { atStart(context) }
    }

    /** One run on this device, with its log line; it never throws. */
    @WorkerThread
    fun atStart(context: Context) {
        report { run(context) }
    }

    /** [sweep] on this device. Never on the main thread. */
    @WorkerThread
    fun run(context: Context): Outcome {
        val noBackup = context.noBackupFilesDir
        return sweep(noBackup, App.accountType,
            folders = { PendingNotesStore.storeDirectories(context) },
            rows = { PendingNotesRemovalGuard.rows(AccountManager.get(context)) },
            active = { ActiveAccountManager.savedIdentity(context) },
            lastActive = { NotesLastActiveRecord.read(noBackup) },
            remember = { NotesLastActiveRecord.write(noBackup, it) },
            open = { PendingNotesStore.forDirectory(context, it) })
    }

    /**
     * Runs [sweep] and logs its one line, none for [Outcome.NoStores]. Any Throwable is caught, since none may end the
     * process, and logged by its class name only; null then.
     */
    internal fun report(sweep: () -> Outcome): Outcome? = try {
        sweep().also { outcome ->
            when (outcome) {
                Outcome.NoStores -> Unit
                is Outcome.HeldBack -> Logger.log.info("Notes startup sweep: held back (${outcome.reason})")
                is Outcome.Swept -> Logger.log.info("Notes startup sweep: ${outcome.removed} removed, " +
                    "${outcome.kept} kept, ${outcome.stopped} not finished, ${outcome.failed} failed, " +
                    "${outcome.others} other names")
            }
        }
    } catch (e: Throwable) {
        Logger.log.warning("Notes startup sweep failed: ${e.javaClass.name}")
        null
    }

    /**
     * [run] for the stores in [noBackup], whose accounts are of [accountType], with each reading passed in. They are
     * asked in this order, and an Exception from any of them holds back at its own step:
     * 1. [folders]: notes-pending's store folders. None gives [Outcome.NoStores] before any account is read; a throw
     *    gives [HoldBack.ROOT_UNLISTABLE]. A name that is not a store folder is counted and never opened.
     * 2. [rows]: the account rows of the main type. Null or a throw gives [HoldBack.ACCOUNTS_UNREADABLE], a row whose
     *    creation id does not read [HoldBack.ROW_WITHOUT_ID], and no row [HoldBack.NO_ACCOUNTS].
     * 3. [active]: the name and creation id the active-account preference holds, or null for none; a throw gives
     *    [HoldBack.ACTIVE_UNREADABLE].
     * 4. [lastActive]: the last folder the preference named at a run that went ahead. A record that is not there names
     *    none; one that cannot be read gives [HoldBack.LAST_ACTIVE_UNREADABLE]. When the preference names a folder
     *    other than the one the record holds, [remember] writes it, before any store is opened, and a write that fails
     *    gives [HoldBack.RECORD_WRITE_FAILED]; a preference that names none never writes. This step comes last, so a
     *    run held back for any other reason writes nothing.
     * 5. Every store folder that none of the rows, the preference or the record as it was read names is opened by
     *    [open], in name order, and discarded as a store whose account is gone ([PendingNotesStore.discardOrphan]),
     *    under its own lock, one store at a time, with no account read under it. A throw from either counts that
     *    store as failed, and the next goes on.
     *
     * The rows are not read again after a removal: a removed store's instance stays registered and closed for the
     * rest of the process, so a late save for it is refused and does not bring the folder back. For an account the
     * account list left out that is still there, that refuses its saves until the app restarts. A Throwable that is
     * not an Exception goes to the caller ([report]).
     */
    internal fun sweep(
        noBackup: File,
        accountType: String,
        folders: () -> StoreFolders,
        rows: () -> List<PendingNotesRemovalGuard.Row>?,
        active: () -> Pair<String, String>?,
        lastActive: () -> NotesLastActiveRecord.Read,
        remember: (String?) -> Unit,
        open: (String) -> PendingNotesStore,
    ): Outcome {
        val listed = try {
            folders()
        } catch (e: Exception) {
            return Outcome.HeldBack(HoldBack.ROOT_UNLISTABLE)
        }
        if (listed.stores.isEmpty()) return Outcome.NoStores
        val accounts = try {
            rows()
        } catch (e: Exception) {
            null
        } ?: return Outcome.HeldBack(HoldBack.ACCOUNTS_UNREADABLE)
        if (accounts.any { it.id == CreationId.Unreadable }) return Outcome.HeldBack(HoldBack.ROW_WITHOUT_ID)
        if (accounts.isEmpty()) return Outcome.HeldBack(HoldBack.NO_ACCOUNTS)
        val saved = try {
            active()
        } catch (e: Exception) {
            return Outcome.HeldBack(HoldBack.ACTIVE_UNREADABLE)
        }
        val record = try {
            lastActive()
        } catch (e: Exception) {
            NotesLastActiveRecord.Read.Unreadable
        }
        val held = when (record) {
            NotesLastActiveRecord.Read.Missing -> null
            is NotesLastActiveRecord.Read.Holds -> record.folder
            NotesLastActiveRecord.Read.Unreadable -> return Outcome.HeldBack(HoldBack.LAST_ACTIVE_UNREADABLE)
        }
        fun folderOf(name: String, creationId: String) =
            PendingNotesStore.identityDir(noBackup, accountType, name, creationId).name
        val named = saved?.let { (name, creationId) -> folderOf(name, creationId) }
        // Before any store is opened, so the next run keeps this folder's store even once the preference moved on.
        if (named != null && named != held) {
            try {
                remember(named)
            } catch (e: Exception) {
                return Outcome.HeldBack(HoldBack.RECORD_WRITE_FAILED)
            }
        }
        val owned = accounts.mapNotNullTo(HashSet()) { row ->
            (row.id as? CreationId.Readable)?.let { folderOf(row.name, it.id) }
        } + listOfNotNull(named, held)
        var removed = 0
        var kept = 0
        var stopped = 0
        var failed = 0
        for (folder in listed.stores) {
            if (folder in owned) continue
            val outcome = try {
                open(folder).discardOrphan()
            } catch (e: Exception) {
                failed++
                continue
            }
            when (outcome) {
                DiscardOutcome.Done -> removed++
                is DiscardOutcome.Changed, DiscardOutcome.PermitNotRecorded -> kept++
                DiscardOutcome.NotFinished -> stopped++
                DiscardOutcome.Acknowledged, DiscardOutcome.AcknowledgementNotRecorded -> failed++
            }
        }
        return Outcome.Swept(removed, kept, stopped, failed, listed.others.size)
    }
}
