package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import androidx.annotation.WorkerThread
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.notes.edit.NotesFolderListings.Folder
import io.silentsuite.sync.notes.edit.PendingNotesDiscardPermits
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.Companion.StoreFolders
import io.silentsuite.sync.notes.edit.PendingNotesStore.RemovalCheck
import io.silentsuite.sync.ui.setup.AccountCreationRegistry
import java.io.File
import java.io.IOException

/**
 * Whether Android may remove a SilentSuite account row with nothing lost from the unsynced Notes text on this device,
 * decided from the stores alone, by the maintainer's rules on #709:
 * - a row whose creation id reads is refused only while its own store holds anything that nothing covers (2026-10-18);
 *   its own folder that cannot be listed and that lstat answers ENOENT for, under that store's lock, counts as
 *   nothing for that removal only (2026-10-21);
 * - a row whose creation id cannot be read is refused only while some store that no live account with a readable id
 *   owns holds anything or cannot be read, and has no permit (the narrowed rule of 2026-10-18);
 * - a failed check counts as holding drafts, an acknowledgement is never deletion authority, and the Notes switch
 *   decides nothing;
 * - stores whose paths are known keep their normal checks, also while notes-pending cannot be listed (2026-10-20).
 *
 * A store's [RemovalCheck.Clean] or [RemovalCheck.Covered] rests on one listing of it, checked against the store's
 * counter by path: a listing that lacks the counter while lstat does not show it gone counts as short, and the store
 * as one that could not be counted. A listing that skips an entry and still lists the counter, or one of a store whose
 * counter was lost, can still come back short without saying so, and the guard takes those answers as they come. A
 * listing of notes-pending is checked against every store folder whose path is known, one whose clear or discard
 * stopped in this process included: one it left out that lstat does not show gone refuses a row without a readable
 * creation id ([PENDING_LISTED_SHORT]).
 *
 * Nothing is kept between decisions, so the next attempt reads the account list again. While that list cannot be read,
 * no store is left out as a live account's, so a refusal decided then can be a [Verdict.REFUSE_STORE] for a store that
 * may be a live account's.
 *
 * Three verdicts are [Verdict.eligible] for the one-time confirmed removal of the second reply of 2026-10-20, for
 * both folders at once by the reply of 2026-10-21: only a folder that cannot be read stands in the way. A fourth,
 * [Verdict.UNKNOWN_KIND_ONLY], is the one proposed to the maintainer for names of a kind this build does not know in
 * notes-pending. Three open points each have one named value, a refusal: [READABLE_ID_UNDER_UNLISTED_PERMITS],
 * [UNKNOWN_KIND_IN_PENDING] and [PENDING_LISTED_SHORT]. No removal is refused through it yet.
 */
internal object PendingNotesRemovalGuard {
    /**
     * What stands in the way of an eligible verdict ([Verdict.reason]), and in which [folder]: a folder that cannot be
     * listed ([unlisted]), until a listing of it works or it is shown gone; or names of a kind this build does not know
     * at the top of notes-pending, which then lists, and which every decision of the guard lists again.
     */
    enum class Cause(val folder: Folder, val unlisted: Boolean) {
        /** notes-pending cannot be listed. */
        PENDING_UNLISTED(Folder.PENDING, unlisted = true),

        /** notes-discard cannot be listed. */
        DISCARD_UNLISTED(Folder.DISCARD, unlisted = true),

        /** notes-pending lists, and holds names of a kind this build does not know ([StoreFolders.others]). */
        PENDING_UNKNOWN_KIND(Folder.PENDING, unlisted = false),
    }

    /** What the guard decides; [reason] names what stands in the way of an eligible verdict. */
    enum class Verdict(val reason: Set<Cause>?) {
        ALLOW(null),

        /** No target, another type, a reading that threw, or an acknowledgement withdrawal that failed otherwise. */
        REFUSE_FAILED(null),

        /**
         * notes-pending holds a name of a kind this build does not know, for a row without a readable creation id:
         * while notes-discard cannot be listed, and, until the maintainer decides, in place of [UNKNOWN_KIND_ONLY].
         */
        REFUSE_UNKNOWN_KIND(null),

        /** A store holds what nothing covers, or cannot be listed and is there. */
        REFUSE_STORE(null),

        /**
         * For a row without a readable creation id, the account list cannot be read while a folder cannot be listed:
         * notes-pending, or notes-discard while some store could not withdraw its acknowledgement; or while
         * notes-pending holds a name of a kind this build does not know. That takes the failed list read and one of
         * those at once. Nothing is kept: every attempt reads the list again and refuses while that read throws. A
         * failure that passes clears on the next attempt; one that lasts has no way out yet, and the case is held.
         * Whether a lasting failure first ends the process, at the immediate update of the listener that
         * AccountAuthenticatorService.onCreate adds, before the authenticator exists, is an inference from that code,
         * not tested.
         */
        REFUSE_ACCOUNTS(null),

        /**
         * Anything else that cannot be shown clean, a listing of notes-pending that came back short included, and what
         * would be an eligible verdict for a row the account list reads an id for.
         */
        REFUSE_UNREADABLE(null),

        /** Only notes-pending cannot be listed, and every store found is clean, covered, acknowledged or absent. */
        ROOT_UNLISTABLE_ONLY(setOf(Cause.PENDING_UNLISTED)),

        /** Only notes-discard cannot be listed, every store is clean, and some could not withdraw acknowledgements. */
        PERMITS_UNLISTABLE_ONLY(setOf(Cause.DISCARD_UNLISTED)),

        /**
         * Both folders cannot be listed, and every store found holds nothing a count counts or is absent by lstat, so
         * no permit was read.
         */
        BOTH_UNLISTABLE_ONLY(setOf(Cause.PENDING_UNLISTED, Cause.DISCARD_UNLISTED)),

        /**
         * Only names of a kind this build does not know at the top of notes-pending stand in the way: the account list
         * reads, notes-discard lists or is shown gone, and every store found is clean, covered or acknowledged. Given
         * only once the maintainer says yes to it ([UNKNOWN_KIND_IN_PENDING]).
         */
        UNKNOWN_KIND_ONLY(setOf(Cause.PENDING_UNKNOWN_KIND));

        /** Whether the one-time confirmed removal may be offered and used for it. */
        val eligible: Boolean get() = reason != null
    }

    /**
     * An account whose creation id reads, while notes-discard cannot be listed, and its own store lists, or is shown
     * gone as for an account that never saved a note, and holds nothing a count counts but could not withdraw its
     * acknowledgement. Until the maintainer decides whether that removal may go through with no allowance, as for
     * an own folder absent by lstat, refused; a yes makes this [Verdict.ALLOW]. The one-time allowance is not offered
     * for a row whose creation id reads.
     */
    internal val READABLE_ID_UNDER_UNLISTED_PERMITS = Verdict.REFUSE_UNREADABLE

    /**
     * Names of a kind this build does not know at the top of notes-pending, for a row without a readable creation id,
     * while the account list reads, notes-discard lists or is shown gone, and every store found is clean, covered or
     * acknowledged. Until the maintainer decides on the one-time confirmed removal proposed for it, refused; a yes
     * makes this [Verdict.UNKNOWN_KIND_ONLY].
     */
    internal val UNKNOWN_KIND_IN_PENDING = Verdict.REFUSE_UNKNOWN_KIND

    /**
     * notes-pending lists, but leaves out a store folder whose path is known (a record in notes-discard, [Input.known],
     * one whose clear or discard stopped in this process included, one the account list names for any row) and whose
     * presence check does not show it absent, for a row without a readable creation id:
     * the listing came back short, so a store it left out that no path names may hold text. Until the maintainer
     * decides whether this takes a one-time confirmed removal bound to something a listing does not move, refused. It
     * is not [Verdict.ROOT_UNLISTABLE_ONLY]: that allowance binds notes-pending's listing counter, which the guard's
     * own listing moves, so its tap could never hold. A store folder made between the listing and its check gives this
     * once, and the next attempt lists again.
     */
    internal val PENDING_LISTED_SHORT = Verdict.REFUSE_UNREADABLE

    /** A row's creation id: [Readable], or [Unreadable] when it is null, blank or its read threw. */
    sealed class CreationId {
        data class Readable(val id: String) : CreationId()
        object Unreadable : CreationId()

        companion object {
            fun of(read: () -> String?): CreationId = try {
                read()?.takeIf(String::isNotBlank)?.let(::Readable) ?: Unreadable
            } catch (e: Exception) {
                Unreadable
            }
        }
    }

    /** One account row of the main type, by name, with its creation id. */
    data class Row(val name: String, val id: CreationId)

    /**
     * What [decide] reads, each only when it needs it: a row with a readable creation id reads only its own store, and
     * notes-discard only when that store's answer asks for it; a row without one reads [accounts], [pending], [discard]
     * and [known], in that order, then [presence] for each folder whose path is known that [pending] left out, before
     * its first store check, so no account read comes after one.
     */
    class Input(
        /** The main account type; the guard decides for its rows only. */
        val mainType: String,
        /** The row whose removal is asked about. */
        val type: String?,
        val name: String?,
        val id: CreationId,
        /** The rows of the main type, read strictly; null when the list cannot be read. */
        val accounts: () -> List<Row>?,
        /** notes-pending's store folders; throws IOException when it cannot be listed and is not shown gone. */
        val pending: () -> StoreFolders,
        /** The store folders notes-discard holds a record of; null when it cannot be listed. */
        val discard: () -> Set<String>?,
        /**
         * The store folders of the active-account preference and of the creation registry's records, and those whose
         * clear or discard stopped in this process ([PendingNotesStore.stoppedIn]), read from memory.
         */
        val known: () -> Set<String>,
        /**
         * The presence check, by path, of a store folder in notes-pending; read after [known], and before any store
         * check.
         */
        val presence: (folder: String) -> PendingNotesStore.Presence,
        /** The store folder of a main-type row with this name and creation id. */
        val folderOf: (name: String, creationId: String) -> String,
        /** The removal check of the store in a folder; may throw. */
        val check: (folder: String) -> RemovalCheck,
    )

    /**
     * The verdict for [input], from the first row of this table that holds:
     * 1. no target, another type, or any reading that throws outside the store checks, other than the IOException of a
     *    notes-pending that cannot be listed ([Input.pending]): [Verdict.REFUSE_FAILED];
     * 2. a store check throws, after one more try when it was an IllegalStateException, from an instance a discard
     *    dropped, which a new open replaces: [Verdict.REFUSE_FAILED];
     * 3. a store could not withdraw its acknowledgement while notes-discard lists or is shown gone, so it failed for
     *    another reason: [Verdict.REFUSE_FAILED];
     * 4. a store holds what nothing covers or is there unlisted, or, for a row without a readable id, one is absent by
     *    lstat alone while notes-pending lists, which only a race gives: [Verdict.REFUSE_STORE];
     * 5. for a row without a readable id, notes-pending lists but leaves out a store folder whose path is known (a
     *    record in notes-discard, [Input.known], one whose clear or discard stopped in this process included, or one
     *    the account list names for any row) and its presence check does not answer ABSENT: [PENDING_LISTED_SHORT];
     * 6. for a row without a readable id, the account list cannot be read, unless row 12 holds:
     *    [Verdict.REFUSE_ACCOUNTS]. That takes the failed list read and, at once, notes-pending that cannot be listed
     *    or holds a name of an unknown kind, or notes-discard that cannot be listed while a store could not withdraw
     *    its acknowledgement. Nothing is kept: every attempt reads the list again and refuses while that read throws.
     *    A failure that passes clears on the next attempt; one that lasts has no way out yet, and the case is held.
     *    Whether a lasting failure first ends the process at the authenticator service's listener, before the
     *    authenticator exists, is an inference ([Verdict.REFUSE_ACCOUNTS]);
     * 7. for a row without a readable id, notes-pending holds a name of a kind this build does not know: while
     *    notes-discard lists or is shown gone and every store is clean, covered or acknowledged, which rows 3 and 4
     *    leave, [UNKNOWN_KIND_IN_PENDING]; otherwise, as while notes-discard cannot be listed, where a covered or
     *    acknowledged store would rest on a read inside it, [Verdict.REFUSE_UNKNOWN_KIND];
     * 8. for a row with a readable id, its own folder cannot be listed and lstat answers ENOENT for it, under its
     *    store lock: [Verdict.ALLOW], for this removal only; it is not eligible, and nothing is cleared on it;
     * 9. for a row without one, notes-pending cannot be listed, notes-discard lists or is shown gone, and every store
     *    found is clean, covered, acknowledged or absent by lstat: [Verdict.ROOT_UNLISTABLE_ONLY];
     * 10. notes-discard cannot be listed, and every store is clean, at least one with an acknowledgement it could not
     *    withdraw: for a row without a readable id, while notes-pending lists or is shown gone,
     *    [Verdict.PERMITS_UNLISTABLE_ONLY]; for a row with one, [READABLE_ID_UNDER_UNLISTED_PERMITS];
     * 11. for a row without one, both folders cannot be listed and every store is clean, unwithdrawn or absent by
     *    lstat, so no permit was read: [Verdict.BOTH_UNLISTABLE_ONLY];
     * 12. every store is clean, covered or acknowledged, and, for a row without a readable id, notes-pending lists or
     *    is shown gone and holds no name of an unknown kind: [Verdict.ALLOW];
     * 13. anything else, such as an unwithdrawn store beside a covered or acknowledged one:
     *    [Verdict.REFUSE_UNREADABLE].
     *
     * For a row with a readable id, the only store is its own. For one without, the stores are those notes-pending
     * lists, those notes-discard holds a record of, [Input.known], those whose clear or discard stopped in this process
     * included, and the folder the account list names for the row itself, less every store of another row whose id
     * reads. The row itself owns none, even when the account list reads an id for it, and with the account list unread
     * no store is left out. The listing of notes-pending is checked against every one of those folders found by path
     * and every other row's own, by its presence check: a folder it left out that is there, or whose check fails, shows
     * that it came back short (row 5), while what it listed is still checked.
     *
     * A row the account list reads an id for gets no allowance, as an account whose id can be read (the reply of
     * 2026-10-21): where rows 7, 9, 10 or 11 would give it an eligible verdict, it gets [Verdict.REFUSE_UNREADABLE],
     * and the next attempt reads its id again.
     */
    fun decide(input: Input): Verdict = decision(input).verdict

    /**
     * [decide]'s verdict for [input], with what it read for the row: its creation id, and the names of an unknown kind
     * its own listing of notes-pending found. [unknownKind] stands for [UNKNOWN_KIND_IN_PENDING], so the tests can show
     * what the maintainer's yes would give.
     */
    internal fun decision(input: Input, unknownKind: Verdict = UNKNOWN_KIND_IN_PENDING): Decision {
        var listed: StoreFolders? = null
        val verdict = try {
            val name = input.name
            if (input.type != input.mainType || name == null) Verdict.REFUSE_FAILED
            else when (val id = input.id) {
                is CreationId.Readable -> own(input, input.folderOf(name, id.id))
                CreationId.Unreadable -> narrowed(input, name, unknownKind) { listed = it }
            }
        } catch (e: Exception) {
            Verdict.REFUSE_FAILED
        }
        return Decision(verdict, (input.id as? CreationId.Readable)?.id, listed?.others.orEmpty())
    }

    private fun own(input: Input, folder: String): Verdict = when (checked(input, folder)) {
        RemovalCheck.Clean, RemovalCheck.Covered, RemovalCheck.Acknowledged -> Verdict.ALLOW
        // lstat answered ENOENT for this exact folder, under its store lock: nothing to lose for this removal alone
        // (2026-10-21). ALLOW is not eligible, so no allowance, and nothing is cleared or deleted on it.
        RemovalCheck.UnlistedAbsent -> Verdict.ALLOW
        is RemovalCheck.Blocks, RemovalCheck.Unlisted -> Verdict.REFUSE_STORE
        RemovalCheck.NothingUnwithdrawn ->
            if (input.discard() == null) READABLE_ID_UNDER_UNLISTED_PERMITS else Verdict.REFUSE_FAILED
    }

    private fun narrowed(input: Input, name: String, unknownKind: Verdict, listed: (StoreFolders) -> Unit): Verdict {
        val rows = input.accounts()
        val pending = try {
            input.pending().also(listed)
        } catch (e: IOException) {
            null
        }
        val discard = input.discard()
        val known = input.known()
        // The row itself owns nothing: its own read found no id, so an id the list reads for it now proves nothing.
        val owned = rows.orEmpty().filter { it.name != name }.mapNotNullTo(HashSet()) { row ->
            (row.id as? CreationId.Readable)?.let { input.folderOf(row.name, it.id) }
        }
        // Yet that id names a folder, so that folder is checked like any store no other row owns.
        val itself = rows.orEmpty().filter { it.name == name }.mapNotNullTo(HashSet()) { row ->
            (row.id as? CreationId.Readable)?.let { input.folderOf(row.name, it.id) }
        }
        // A listing of notes-pending can come back short with no error. A store folder whose path is known that it left
        // out, and that lstat does not show absent, shows that it did: what it listed is still checked, but it proves
        // no absence.
        val short = pending != null && pending.stores.toHashSet().let { inListing ->
            (discard.orEmpty() + known + owned + itself).toSortedSet()
                .any { it !in inListing && input.presence(it) != PendingNotesStore.Presence.ABSENT }
        }
        val stores = (pending?.stores.orEmpty() + discard.orEmpty() + known + itself).toSortedSet() - owned
        val answers = stores.map { checked(input, it) }
        val rootLists = pending != null
        val unknown = pending?.unknown == true
        fun all(vararg kinds: RemovalCheck) = answers.all { it in kinds }
        val unwithdrawn = answers.any { it == RemovalCheck.NothingUnwithdrawn }
        val allowed = rootLists && !unknown &&
            all(RemovalCheck.Clean, RemovalCheck.Covered, RemovalCheck.Acknowledged)
        val verdict = when {
            discard != null && unwithdrawn -> Verdict.REFUSE_FAILED
            answers.any { it is RemovalCheck.Blocks || it == RemovalCheck.Unlisted } -> Verdict.REFUSE_STORE
            rootLists && answers.any { it == RemovalCheck.UnlistedAbsent } -> Verdict.REFUSE_STORE
            short -> PENDING_LISTED_SHORT
            rows == null -> if (allowed) Verdict.ALLOW else Verdict.REFUSE_ACCOUNTS
            // Only while notes-discard lists or is shown gone: otherwise a covered or acknowledged store would rest on
            // a read inside a folder that cannot be listed.
            unknown ->
                if (discard != null && all(RemovalCheck.Clean, RemovalCheck.Covered, RemovalCheck.Acknowledged)) {
                    unknownKind
                } else {
                    Verdict.REFUSE_UNKNOWN_KIND
                }
            !rootLists && discard != null && all(RemovalCheck.Clean, RemovalCheck.Covered, RemovalCheck.Acknowledged,
                RemovalCheck.UnlistedAbsent) -> Verdict.ROOT_UNLISTABLE_ONLY
            rootLists && discard == null && unwithdrawn && all(RemovalCheck.Clean, RemovalCheck.NothingUnwithdrawn) ->
                Verdict.PERMITS_UNLISTABLE_ONLY
            !rootLists && discard == null && all(RemovalCheck.Clean, RemovalCheck.NothingUnwithdrawn,
                RemovalCheck.UnlistedAbsent) -> Verdict.BOTH_UNLISTABLE_ONLY
            allowed -> Verdict.ALLOW
            else -> Verdict.REFUSE_UNREADABLE
        }
        return if (verdict.eligible && itself.isNotEmpty()) Verdict.REFUSE_UNREADABLE else verdict
    }

    /** One store's check, tried once more after an IllegalStateException, as from an instance a discard dropped. */
    private fun checked(input: Input, folder: String): RemovalCheck = try {
        input.check(folder)
    } catch (e: IllegalStateException) {
        input.check(folder)
    }

    /**
     * The stores found by path other than through notes-discard: the folder of the active-account preference's name and
     * creation id ([active]), and the folder of each creation-registry record of [mainType]. A registry that cannot be
     * read ([records] null) gives none, and its stores then count only where a listing of notes-pending finds them.
     */
    internal fun known(
        noBackup: File,
        mainType: String,
        active: Pair<String, String>?,
        records: List<AccountCreationRegistry.Record>?,
    ): Set<String> {
        val identities = listOfNotNull(active) +
            records.orEmpty().filter { it.accountType == mainType }.map { it.accountName to it.creationId }
        return identities.mapTo(HashSet()) { (name, creationId) ->
            PendingNotesStore.identityDir(noBackup, mainType, name, creationId).name
        }
    }

    /**
     * The store folders notes-discard in [noBackup] holds a record of ([PendingNotesDiscardPermits.listNames]), or null
     * when it cannot be listed, from a reader that only lists.
     */
    internal fun discardNames(noBackup: File, presence: (File) -> PendingNotesStore.Presence): Set<String>? =
        PendingNotesDiscardPermits(File(noBackup, PendingNotesDiscardPermits.ROOT), syncDirectory = {},
            rename = { _, _ -> throw IOException("this reader only lists") }, presence = presence).listNames()

    /**
     * Every store folder in [noBackup] whose path is known without a listing of notes-pending: those notes-discard
     * holds a record of, when it lists ([discardNames]), and [known]'s, two of the readings the guard takes for a row
     * without a readable creation id ([input]); the third, the stores whose clear or discard stopped in this process
     * ([PendingNotesStore.stoppedIn]), the Settings list reads itself. For the Settings way out, read whether or not
     * notes-pending lists, so a listing that comes back short does not hide a store that the guard finds.
     */
    internal fun foundByPath(
        noBackup: File,
        mainType: String,
        presence: (File) -> PendingNotesStore.Presence,
        active: Pair<String, String>?,
        records: List<AccountCreationRegistry.Record>?,
    ): Set<String> = discardNames(noBackup, presence).orEmpty() + known(noBackup, mainType, active, records)

    /** [foundByPath] on this device, from the active-account preference and the creation registry. */
    @WorkerThread
    internal fun foundByPath(context: Context): Set<String> = foundByPath(context.noBackupFilesDir, App.accountType,
        PendingNotesStore::presenceOnDevice, ActiveAccountManager.savedIdentity(context),
        AccountCreationRegistry.open(context).records())

    /**
     * [Input] over the stores in [noBackup], each opened by [open], with [presence] for the folders' own checks; the
     * reader of notes-discard here only lists it.
     */
    internal fun input(
        noBackup: File,
        mainType: String,
        type: String?,
        name: String?,
        id: CreationId,
        accounts: () -> List<Row>?,
        active: () -> Pair<String, String>?,
        records: () -> List<AccountCreationRegistry.Record>?,
        presence: (File) -> PendingNotesStore.Presence,
        open: (String) -> PendingNotesStore,
    ) = Input(mainType, type, name, id, accounts,
        pending = { PendingNotesStore.storeDirectories(noBackup, presence) },
        discard = { discardNames(noBackup, presence) },
        known = { known(noBackup, mainType, active(), records()) + PendingNotesStore.stoppedIn(noBackup) },
        // The seam first, as the store's own checks ask it; on a device presence asks it first already.
        presence = { folder ->
            File(File(noBackup, PendingNotesStore.PENDING), folder)
                .let { PendingNotesStore.presenceForTesting?.invoke(it) ?: presence(it) }
        },
        folderOf = { rowName, rowId -> PendingNotesStore.identityDir(noBackup, mainType, rowName, rowId).name },
        check = { open(it).removalCheck() })

    /**
     * A verdict, with the creation id it read for the row, when one read, and the names of a kind this build does not
     * know that its own listing of notes-pending found ([StoreFolders.others]), sorted; none when it listed none.
     */
    data class Decision(val verdict: Verdict, val creationId: String?, val unknown: List<String> = emptyList())

    /**
     * The guard on this device for [account]: its creation id first, then for a row without one the account list, with
     * each row's id, then notes-pending, notes-discard, the active-account preference, the registry and the stores
     * whose clear or discard stopped in this process, and only then the store checks, each store opened by its folder
     * ([PendingNotesStore.forDirectory]). It never builds AccountSettings and never takes the Etebase cache's monitor.
     * The log line holds the verdict and a count only.
     */
    @WorkerThread
    fun decision(context: Context, account: Account?): Decision {
        val manager = AccountManager.get(context)
        val id = if (account == null || account.type != App.accountType) CreationId.Unreadable
        else CreationId.of { manager.getUserData(account, AccountSettings.KEY_CREATION_ID) }
        var checks = 0
        val decision = decision(input(context.noBackupFilesDir, App.accountType, account?.type, account?.name, id,
            accounts = { rows(manager) },
            active = { ActiveAccountManager.savedIdentity(context) },
            records = { AccountCreationRegistry.open(context).records() },
            presence = PendingNotesStore::presenceOnDevice,
            open = { folder ->
                checks++
                PendingNotesStore.forDirectory(context, folder)
            }))
        val verdict = decision.verdict
        Logger.log.info("Notes removal guard: $verdict after $checks store checks")
        return decision
    }

    /** Whether the guard allows removing [account] now, with nothing to confirm. */
    @WorkerThread
    fun allows(context: Context, account: Account?): Boolean = decision(context, account).verdict == Verdict.ALLOW

    /** The rows of the main type with each one's creation id, or null when the list cannot be read. */
    private fun rows(manager: AccountManager): List<Row>? {
        val accounts = try {
            manager.getAccountsByType(App.accountType)
        } catch (e: Exception) {
            return null
        }
        return accounts.map { row ->
            Row(row.name, CreationId.of { manager.getUserData(row, AccountSettings.KEY_CREATION_ID) })
        }
    }
}
