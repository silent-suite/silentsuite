package io.silentsuite.sync.notes.edit

import com.etebase.client.exceptions.ConflictException
import com.etebase.client.exceptions.ConnectionException
import com.etebase.client.exceptions.HttpException
import com.etebase.client.exceptions.NotFoundException
import com.etebase.client.exceptions.PermissionDeniedException
import com.etebase.client.exceptions.ServerErrorException
import com.etebase.client.exceptions.TemporaryServerErrorException
import com.etebase.client.exceptions.UnauthorizedException
import io.silentsuite.sync.syncadapter.StaleSyncRunException
import java.io.IOException
import java.io.InterruptedIOException
import kotlin.math.min

/**
 * The pure rules for pushing one pending note: what a 409 means, how every other failure is
 * handled, when a failed entry may be retried, and how a conflicted copy is titled. No I/O here,
 * so every rule is unit-tested on its own.
 */
internal object NotePushPolicy {

    /** What the runner does after a 409, given the server's current copy of the note. */
    enum class ConflictOutcome {
        /** Our latest change is already the server's current revision: drop the entry. */
        DONE,
        /** The server copy is our own earlier upload: apply the newer local change onto it and push again. */
        REBASE,
        /** Edited elsewhere: the server version stays, the local text becomes "<title> (conflicted copy)". */
        KEEP_BOTH,
        /** Deleted elsewhere: the local text becomes a new note with its own title. */
        RECREATE_AS_NEW_NOTE,
        /**
         * The entry is itself a note made from a conflict that is not yet known to be on the server
         * ([PendingEntry.fromConflict]), and the server copy is again not ours: no further note is made.
         * The text is held as [HeldReason.REPEATED_CONFLICT], with the sent version, as for a rejection.
         */
        HOLD_REPEATED_CONFLICT,
        /** A local delete against an edit made elsewhere: the newer edit wins, the note comes back. */
        RESTORE_SERVER_NOTE,
        /** Both sides deleted it: done (web issue #745). */
        ALREADY_DELETED,
        /**
         * The server copy could not be fetched: the entry is never resolved without it. The failed fetch
         * is the entry's failure, recorded as [FailureKind.TRANSIENT] with backoff (design 3.8).
         */
        RETRY_LATER,
    }

    data class ServerCopy(val revision: String, val deleted: Boolean)

    /**
     * The server revision history is deliberately not consulted: a lost response followed by a
     * write from another client then yields one redundant conflicted copy, never lost text.
     *
     * The mark of a note made from a conflict changes only the two rows that make a note. Without it, a
     * server that answers every push with a 409 and a copy that is not ours would get a new note, a
     * notification and another push in every run; with it, the run that makes the note also holds it
     * (design 3.8). A copy of ours is handled as for any entry. So is a pending delete, marked or not:
     * the delete rows make no note, and the holding area would drop the delete without the cache write
     * those rows need.
     */
    fun decide(entry: PendingEntry, landedRevision: String?, server: ServerCopy?): ConflictOutcome {
        require(entry.state != PendingEntry.State.HELD) { "held text is never pushed" }
        if (server == null) return ConflictOutcome.RETRY_LATER
        val ours = server.revision in entry.sent || server.revision == landedRevision
        if (ours) return if (server.revision == entry.revision) ConflictOutcome.DONE else ConflictOutcome.REBASE
        return when (entry.state) {
            PendingEntry.State.UPSERT -> when {
                entry.fromConflict -> ConflictOutcome.HOLD_REPEATED_CONFLICT
                server.deleted -> ConflictOutcome.RECREATE_AS_NEW_NOTE
                else -> ConflictOutcome.KEEP_BOTH
            }
            PendingEntry.State.DELETE ->
                if (server.deleted) ConflictOutcome.ALREADY_DELETED else ConflictOutcome.RESTORE_SERVER_NOTE
            PendingEntry.State.HELD -> error("unreachable")
        }
    }

    /** How a failed upload of one entry is handled. */
    enum class FailureKind {
        /** 409: resolved with [decide]; not a failure. */
        CONFLICT,
        /** 403: the notebook is read-only for this user; the text goes to the holding area. */
        READ_ONLY,
        /** 404: the user can no longer see the notebook; the text goes to the holding area. */
        LOST_ACCESS,
        /**
         * 401: the session is no longer accepted. Not about one entry: no failure is recorded on it,
         * and the run ends with the authentication failure.
         */
        AUTHENTICATION,
        /** Network trouble or a server error: back off and retry. */
        TRANSIENT,
        /** A 4xx the server will keep giving for this content (for example 400 or 413): the text is held. */
        REJECTED,
        /** A failure on this device (encoding, storage): back off and retry. */
        LOCAL,
        /**
         * The run was cancelled or is no longer current (sign-out, Notes turned off, the account replaced).
         * Not a failure: no backoff, nothing held. Before recording any failure the runner must first ask
         * whether the run may still write (SyncRunGuard.mayWrite). The interrupt flag alone is not enough:
         * a cancelled network call reaches the runner as a ConnectionException and can clear the flag on
         * the way.
         */
        CANCELLED,
    }

    /** The binding's message for a status it has no exception class for: "HTTP error 429! Code: '...'. Detail: '...'". */
    private val HTTP_STATUS = Regex("""^HTTP error (\d{3})!""")

    /** The binding reports a redirect as a NotFoundException with this message; the app's client does not follow redirects. */
    private const val REDIRECT_MESSAGE = "Got a redirect"

    fun classify(error: Throwable): FailureKind = when (error) {
        is InterruptedException, is InterruptedIOException, is StaleSyncRunException -> FailureKind.CANCELLED
        is ConflictException -> FailureKind.CONFLICT
        is PermissionDeniedException -> FailureKind.READ_ONLY
        is NotFoundException -> if (error.message?.startsWith(REDIRECT_MESSAGE) == true) FailureKind.TRANSIENT else FailureKind.LOST_ACCESS
        is UnauthorizedException -> FailureKind.AUTHENTICATION
        is TemporaryServerErrorException, is ServerErrorException, is ConnectionException -> FailureKind.TRANSIENT
        // The binding reports network trouble as ConnectionException; a raw IOException comes from this
        // device (the pending store, a full disk), not from the network.
        is IOException -> FailureKind.LOCAL
        is HttpException -> statusKind(error.message)
        else -> FailureKind.LOCAL
    }

    /** Statuses that clear up on their own retry; other 4xx are rejections; anything unreadable retries. */
    private fun statusKind(message: String?): FailureKind {
        val status = message?.let { HTTP_STATUS.find(it) }?.groupValues?.get(1)?.toIntOrNull() ?: return FailureKind.TRANSIENT
        return when (status) {
            408, 425, 429 -> FailureKind.TRANSIENT
            in 400..499 -> FailureKind.REJECTED
            else -> FailureKind.TRANSIENT
        }
    }

    /**
     * What a fetch of the notebook itself showed, made after a push failed with 403 or 404 and before
     * anything is held. A single status on the item upload says little on its own: this server also
     * answers 403 for the whole account (for example a user no longer in the LDAP directory), and a
     * proxy can answer anything.
     */
    sealed class NotebookCheck {
        data class Found(val readOnly: Boolean, val deleted: Boolean) : NotebookCheck()
        /** The notebook fetch answered 404: this account is no longer a member. */
        object Gone : NotebookCheck()
        /** The notebook fetch failed some other way, so nothing is known yet. */
        object Unknown : NotebookCheck()
    }

    /**
     * Whether a notebook takes pushes: not deleted and not read-only. The one rule for the runner, which
     * holds changes for any other notebook, and for the screens, which show what the runner will do.
     */
    fun acceptsWrites(deleted: Boolean, readOnly: Boolean): Boolean = !deleted && !readOnly

    /** Whether [kind] needs a [NotebookCheck] before [heldReasonFor] can decide. */
    fun needsNotebookCheck(kind: FailureKind): Boolean = kind == FailureKind.READ_ONLY || kind == FailureKind.LOST_ACCESS

    /**
     * The holding-area reason for a failure, or null when the entry stays pending and backs off. A
     * notebook-level reason holds text only when [check] confirms it: a read-only or deleted notebook,
     * or one this account can no longer see. A rejection holds text only when the same content was
     * rejected the time before too ([previousFailure] is the entry's last recorded failure category,
     * which the runner records as the [FailureKind] name), so one odd answer from a proxy moves nothing.
     * Anything else is treated as passing trouble. Held text goes back to waiting only through the
     * user's "Try again" ([PendingNotesStore.release]).
     */
    fun heldReasonFor(kind: FailureKind, check: NotebookCheck? = null, previousFailure: String? = null): HeldReason? = when (kind) {
        FailureKind.READ_ONLY, FailureKind.LOST_ACCESS -> when (check) {
            is NotebookCheck.Found -> when {
                check.deleted -> HeldReason.NOTEBOOK_DELETED
                check.readOnly -> HeldReason.READ_ONLY
                else -> null
            }
            NotebookCheck.Gone -> HeldReason.LOST_ACCESS
            NotebookCheck.Unknown, null -> null
        }
        // A rejection is about this content: nothing else to ask, but it has to happen twice in a row.
        FailureKind.REJECTED -> if (previousFailure == FailureKind.REJECTED.name) HeldReason.REJECTED else null
        FailureKind.CONFLICT, FailureKind.AUTHENTICATION, FailureKind.TRANSIENT, FailureKind.LOCAL, FailureKind.CANCELLED -> null
    }

    const val BACKOFF_BASE_MILLIS = 60_000L
    const val BACKOFF_MAX_MILLIS = 6 * 60 * 60_000L

    /** 1, 2, 4, ... minutes after each consecutive failure, capped at six hours. */
    fun backoffMillis(failureCount: Int): Long {
        if (failureCount <= 0) return 0
        val shift = min(failureCount - 1, 30)
        return min(BACKOFF_MAX_MILLIS, BACKOFF_BASE_MILLIS shl shift)
    }

    /**
     * Whether an entry sits out this run. A run the user started (Sync now, pull to refresh) tries every
     * entry, so a waiting edit is never skipped for hours after the user asked to sync. A failure time
     * in the future (the clock was corrected backwards since) never keeps an entry waiting.
     */
    fun inBackoff(entry: PendingEntry, now: Long, userInitiated: Boolean): Boolean =
        inBackoff(entry.failureCount, entry.lastFailureAt, now, userInitiated)

    fun inBackoff(failureCount: Int, lastFailureAt: Long?, now: Long, userInitiated: Boolean): Boolean {
        if (userInitiated) return false
        val last = lastFailureAt ?: return false
        return now >= last && now < last + backoffMillis(failureCount)
    }

    /**
     * Whether an error on a request of the push step is not about one entry: a connection error or a
     * temporary server error ends the step for the whole run (design 3.8), as the same errors end the
     * slice 1 fetch for every notebook (but for a listing that cannot finish, which fails only its own
     * notebook there). A 403 ends it too, but only on the confirming notebook fetch, which the step
     * decides itself.
     */
    fun endsPushStep(error: Throwable): Boolean = error is ConnectionException || error is TemporaryServerErrorException

    /**
     * "<title> (conflicted copy)", built from the title as displayed, so a blank name becomes
     * "Untitled (conflicted copy)" and a copy of a copy does not grow a second suffix.
     */
    fun conflictCopyTitle(displayTitle: String?, untitled: String, suffix: String): String {
        val base = displayTitle?.trim().orEmpty().ifEmpty { untitled }
        return if (base.endsWith(" $suffix")) base else "$base $suffix"
    }
}
