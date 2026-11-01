package io.silentsuite.sync.ui.etebase

import android.accounts.AccountManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.annotation.StringRes
import androidx.annotation.WorkerThread
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.NotesSyncPolicy
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.NotebookDiscard
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Ended
import java.io.IOException
import java.util.UUID

/**
 * The order of the user's confirmed leave or delete of a Notes notebook, and the Android glue for it. The server call
 * comes first, and the notebook's unsynced Notes changes are discarded only once it went through and the account's
 * generation is still there, under the store's lock ([PendingNotesStore.discardNotebook]): a deletion or a change of
 * access that did not come from this confirmation keeps the text for the push step to hold (the maintainer's answer of
 * 2026-10-04 on #709). So a server call that fails, the device being offline, or the process ending in between
 * discards nothing.
 */
internal object NotebookLeaveOrDelete {
    /**
     * The confirmed leave or delete of a notebook whose dialog showed [shown], with every step injected, and each one
     * blocking, so nothing can cancel the work between the server call and the discard. In order:
     * 1. [validate]: false gives [Ended.AccountChanged].
     * 2. The notebook is counted again ([count]). When it holds anything [shown] does not cover, nothing is done:
     *    [Ended.AskAgain], for the count again.
     * 3. When [shown] is from a store that listed and holds anything, the exact generation's Notes run is canceled
     *    ([cancel]), only while [running] says it runs or waits to, since a cancel always tells the job's listeners.
     * 4. The server call ([server]). A throw is the caller's. False is an account that changed before the call or
     *    after it: [Ended.AccountChanged].
     * 5. [validate] again: false gives [Ended.AccountChanged], with nothing discarded, since the store belongs to a
     *    generation that is gone.
     * 6. [discard] of what [shown] covers. A throw becomes [Ended.DiscardFailed].
     */
    fun remove(
        shown: UnsyncedNotes,
        validate: () -> Boolean,
        count: () -> UnsyncedNotes,
        running: () -> Boolean,
        cancel: () -> Unit,
        server: () -> Boolean,
        discard: (UnsyncedNotes) -> NotebookDiscard,
    ): Ended {
        if (!validate()) return Ended.AccountChanged
        val now = count()
        if (now.anything && !shown.covers(now)) return Ended.AskAgain(now)
        if (shown.listed && shown.anything && running()) cancel()
        if (!server()) return Ended.AccountChanged
        if (!validate()) return Ended.AccountChanged
        return discarded { discard(shown) }
    }

    /**
     * The user's Discard in the one more question, for [now], once the leave or delete went through: [validate], then
     * [discard] of what [now] covers. No count, no cancel and no server call.
     */
    fun again(now: UnsyncedNotes, validate: () -> Boolean, discard: (UnsyncedNotes) -> NotebookDiscard): Ended {
        if (!validate()) return Ended.AccountChanged
        return discarded { discard(now) }
    }

    /**
     * [discard]'s outcome. A store that a clear or a whole-store discard closed, a dropped one included, refuses
     * ([PendingNotesStore.Cleared]) before this call deletes anything, but that clear or discard may have deleted the
     * notebook's text, whether it stopped or finished, so the attempt is never said to have deleted nothing. Any other
     * IllegalStateException, an IOException, or an IllegalArgumentException of a notebook uid that is not an Etebase
     * uid, which is checked after any recovery that is owed and before the notebook is counted, comes before any of
     * the notebook's text went; any other exception may come from anywhere. An Error, such as running out of memory in
     * the recovery that runs first, comes before any went as well, since [PendingNotesStore.discardNotebook] passes on
     * no throw once its loop began and gives [NotebookDiscard.Partly] instead; it ends the attempt like a refusal, so
     * a leave or delete that already went through on the server never ends in a crash.
     */
    private inline fun discarded(discard: () -> NotebookDiscard): Ended = try {
        Ended.Removed(discard())
    } catch (e: PendingNotesStore.Cleared) {
        Ended.DiscardFailed(known = false)
    } catch (e: IOException) {
        Ended.DiscardFailed(known = true)
    } catch (e: IllegalStateException) {
        Ended.DiscardFailed(known = true)
    } catch (e: IllegalArgumentException) {
        Ended.DiscardFailed(known = true)
    } catch (e: Exception) {
        Ended.DiscardFailed(known = false)
    } catch (e: Error) {
        Ended.DiscardFailed(known = true)
    }

    // ---- Android glue ----

    private fun store(context: Context, identity: CollectionLifecycleIdentity) =
        PendingNotesStore.forIdentity(context, identity.account.type, identity.account.name, identity.creationId)

    private fun exact(identity: CollectionLifecycleIdentity) =
        ExactAccountIdentity(identity.account.type, identity.account.name, identity.creationId)

    /** The notebook's unsynced Notes changes. A count that throws could not be counted, never nothing. */
    @WorkerThread
    fun count(context: Context, identity: CollectionLifecycleIdentity): UnsyncedNotes = runCatching {
        store(context, identity).unsyncedInNotebook(requireNotNull(identity.collectionUid))
    }.getOrDefault(NotebookLeaveOrDeletePolicy.countFailed)

    /** The discard of what [shown] covers in the notebook, under the store's lock. */
    @WorkerThread
    fun discard(context: Context, identity: CollectionLifecycleIdentity, shown: UnsyncedNotes): NotebookDiscard =
        store(context, identity).discardNotebook(requireNotNull(identity.collectionUid), shown)

    /** Whether the exact generation's Notes run runs or waits to. */
    fun running(identity: CollectionLifecycleIdentity): Boolean =
        exact(identity).let { NotesSyncCoordinator.isActive(it) || NotesSyncCoordinator.isPending(it) }

    /** Cancels the exact generation's Notes run, and only that one. */
    fun cancel(identity: CollectionLifecycleIdentity) = NotesSyncCoordinator.cancel(exact(identity))

    enum class SyncAsked { ASKED, NOTES_OFF, NOT_ASKED }

    /**
     * Sync now from the count. While the generation still has its account and Notes is on for it, a request is
     * recorded under the exact generation and the Notes job is asked for a run the user started, as Sync now before a
     * sign-out does; with Notes off nothing is asked, and turning Notes off keeps the changes. When the generation no
     * longer has its account, nothing is asked. The run is an attempt that can be skipped or fail.
     */
    fun syncNotesNow(context: Context, identity: CollectionLifecycleIdentity): SyncAsked {
        if (!identity.validate(context)) return SyncAsked.NOT_ASKED
        val account = identity.account
        if (!AccountSettings.notesEnabled(AccountManager.get(context), account)) return SyncAsked.NOTES_OFF
        val requestId = UUID.randomUUID().toString()
        val statusStore = SyncStatusStore(context.applicationContext)
        // Recorded for the exact generation, the one the run reports under.
        statusStore.recordRequested(statusStore.identity(account, identity.creationId),
            setOf(SyncStatusStore.Service.NOTES), requestId, System.currentTimeMillis())
        NotesSyncCoordinator.request(context.applicationContext, account, identity.creationId,
            NotesSyncPolicy.Trigger.MANUAL, requestId)
        return SyncAsked.ASKED
    }

    /**
     * Shows [text] from any thread, through the application context, so it can show after the screen is gone too: the
     * screen posts the result of a leave or delete from inside its IO block. While the app is in the background, the
     * system drops it when notifications are off for the app, as they are from Android 13 on until the notification
     * permission is granted. From Android 12 on a text message shows two lines at most, so each result says first
     * what came of the discard.
     */
    fun postResult(context: Context, text: CharSequence) {
        val application = context.applicationContext
        Handler(Looper.getMainLooper()).post { Toast.makeText(application, text, Toast.LENGTH_LONG).show() }
    }

    /** [postResult] for the string [text]. */
    fun postResult(context: Context, @StringRes text: Int) =
        postResult(context, context.applicationContext.getString(text))
}
