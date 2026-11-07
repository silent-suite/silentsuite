package io.silentsuite.sync.ui

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.annotation.StringRes
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Decision
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import io.silentsuite.sync.utils.NotificationUtils

/**
 * The notification of a refused removal of a SilentSuite account row, by the maintainer's reply of 2026-10-23 on #709:
 * posted only while notifications are allowed for the app, with no account name or address and no Notes content, so the
 * lock screen shows the same text, and a tap opens Unsynced Notes, where the reason and the way to try again are
 * whether or not it was posted. One at a time: a later refusal replaces it. The authenticator's answer posts it
 * ([NotesRemovalAnswer]), except while a removal of the row that the confirmation in Unsynced Notes asked for is under
 * way: its screen says what came of it, or posts it if the user has left the screen by then, if the outcome can't
 * say whether the account was removed, or if the screen goes first. It goes after a yes of that answer, after the
 * app's own removal of a row ([clearAfter]), and when Unsynced Notes finds nothing in the way of any account.
 */
internal object NotesRemovalNotice {
    /**
     * Which words explain a refusal: [STORE], the guard's [Verdict.REFUSE_STORE] or [Verdict.REFUSE_UNKNOWN_KIND] with
     * the account list read, so a store on this device holds unsynced text or cannot be read or counted, or
     * notes-pending holds names this build cannot read and leaves in place, while notes-discard cannot be listed: the
     * reason stays in Unsynced Notes, so the words that say only to try again later are not theirs;
     * [CONFIRM], an eligible verdict ([Verdict.eligible]), which only the confirmation in Unsynced Notes lets through;
     * [UNCHECKED], anything else, a check that may pass when tried again later: a [Verdict.REFUSE_STORE] decided
     * without the account list and a decision that threw included.
     */
    enum class Kind { STORE, CONFIRM, UNCHECKED }

    /** The words for a refusal of [decision]; null, a decision that threw, is [Kind.UNCHECKED]. */
    fun kind(decision: Decision?): Kind = when {
        decision == null -> Kind.UNCHECKED
        decision.verdict.eligible -> Kind.CONFIRM
        (decision.verdict == Verdict.REFUSE_STORE || decision.verdict == Verdict.REFUSE_UNKNOWN_KIND) &&
            !decision.accountsUnread -> Kind.STORE
        else -> Kind.UNCHECKED
    }

    /** The notification's text for [kind], with no format argument. */
    @StringRes
    fun text(kind: Kind): Int = when (kind) {
        Kind.STORE -> R.string.notes_removal_refused_store
        Kind.CONFIRM -> R.string.notes_removal_refused_confirm
        Kind.UNCHECKED -> R.string.notes_removal_refused_unchecked
    }

    /** Posts the notification for [kind] in place of any earlier one, while notifications are allowed for the app. */
    fun post(context: Context, kind: Kind) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val text = context.getString(text(kind))
        val open = AppSettingsActivity.newUnsyncedNotesIntent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val notification = NotificationUtils.newBuilder(context, NotificationUtils.CHANNEL_GENERAL)
            .setSmallIcon(R.drawable.ic_error_light)
            .setContentTitle(context.getString(R.string.notes_removal_refused_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            // Its own request code: another notification's PendingIntent for Settings must not take this one's place.
            .setContentIntent(PendingIntent.getActivity(context, Constants.NOTIFICATION_NOTES_REMOVAL_REFUSED, open,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .build()
        NotificationUtils.notify(context, Constants.NOTIFICATION_NOTES_REMOVAL_REFUSED, notification)
    }

    /**
     * [callback] for the app's own removal of a SilentSuite account row (sign-out, setup recovery), with the
     * notification taken away first when the row went. Those removals use removeAccountExplicitly, which never asks the
     * authenticator, so no yes of its takes the notification away. It names no account, so one about another account
     * goes too, as after the authenticator's yes; Unsynced Notes reads every account again when it shows.
     */
    fun clearAfter(context: Context, callback: (Boolean) -> Unit): (Boolean) -> Unit =
        afterRemoval({ clear(context) }, callback)

    /** [callback] with the removal's result, after [clear] when the row went; a [clear] that throws changes nothing. */
    internal fun afterRemoval(clear: () -> Unit, callback: (Boolean) -> Unit): (Boolean) -> Unit = { removed ->
        if (removed) {
            try {
                clear()
            } catch (e: Exception) {
                // The removal stands either way.
            }
        }
        callback(removed)
    }

    /** Takes the notification away, once a removal of a SilentSuite account row went through; never throws. */
    fun clear(context: Context) {
        try {
            NotificationManagerCompat.from(context).cancel(Constants.NOTIFICATION_NOTES_REMOVAL_REFUSED)
        } catch (e: Exception) {
            // The removal stands either way.
        }
    }
}
