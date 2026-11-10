package io.silentsuite.sync.ui

import android.accounts.Account
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.annotation.WorkerThread
import io.silentsuite.sync.App
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.notes.edit.PendingNotesStore.RemovalHold
import io.silentsuite.sync.ui.NotesRemovalAllowance.Fingerprint
import io.silentsuite.sync.ui.NotesRemovalAllowance.Key
import io.silentsuite.sync.ui.NotesRemovalNotice.Kind
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Decision
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import java.util.concurrent.ConcurrentHashMap

/**
 * The authenticator's answer when Android asks whether a SilentSuite account row may be removed
 * (AccountAuthenticatorService, getAccountRemovalAllowed), as from Android settings or the confirmation in Unsynced
 * Notes: the guard's decision for the row ([PendingNotesRemovalGuard.decision]), then this process's allowance
 * ([NotesRemovalAllowance.answer]), which moves the row counter before any yes and takes a slot for that row out
 * whatever it answers. Anything that throws, an Error included, answers no, and first takes a slot for the row out.
 * A no posts the refusal notification ([NotesRemovalNotice]), except while a removal of the row that the confirmation
 * in Unsynced Notes asked for is under way ([askInApp]), whichever removal the no answers: it then waits for that
 * removal's outcome, which the screen shows, and is posted if the user has left the screen by then, if the outcome
 * can't say whether the account was removed, or if the screen goes first. A yes takes the notification away, and
 * any no such a removal took. Neither step changes the answer.
 *
 * Every store the guard checks for the question takes one removal hold ([RemovalHold]), so no save lands in them
 * between the answer and Android's removal of the row: a no releases it at once, and a yes hands it to [Seams.held],
 * which releases it once Android has had the time to remove the row.
 */
internal class NotesRemovalAnswer(
    private val mainType: String,
    private val allowance: NotesRemovalAllowance,
    private val seams: Seams,
) {
    interface Seams {
        /** The guard's decision for the row now, each store it checks taking [hold]. */
        fun decision(type: String, name: String, hold: RemovalHold): Decision

        /** After a yes: releases [hold] once the removal that follows it is done or cannot come any more. */
        fun held(hold: RemovalHold)

        /** What stands in the way in [decision], for an eligible verdict only. */
        fun fingerprint(decision: Decision): Fingerprint

        /** Tells the user that the removal was refused, in the words of [kind]. */
        fun refused(kind: Kind)

        /** Takes the refusal notification away: the removal goes ahead. */
        fun allowed()

        /**
         * For a no for the row of [type] named [name], in the words of [kind]: whether a removal of that row that the
         * confirmation in Unsynced Notes asked for, still under way, takes it ([withheldInApp]), so no notification is
         * posted now.
         */
        fun withheldInApp(type: String, name: String, kind: Kind): Boolean

        /** For a yes for the row of [type] named [name]: each such removal drops any no it took ([allowedInApp]). */
        fun allowedInApp(type: String, name: String)

        /** The one log line: the verdict, when there was one, and the answer. No account name. */
        fun log(verdict: Verdict?, allowed: Boolean)
    }

    /** Whether Android may remove the row of [type] named [name] now. Never throws. */
    @WorkerThread
    fun allowed(type: String?, name: String?): Boolean {
        val hold = RemovalHold()
        var decision: Decision? = null
        val yes = try {
            if (type != mainType || name == null) {
                false
            } else {
                val decided = seams.decision(type, name, hold).also { decision = it }
                val fingerprint = if (decided.verdict.eligible) seams.fingerprint(decided) else null
                allowance.answer(Key(type, name, decided.creationId), decided.verdict, fingerprint)
            }
        } catch (t: Throwable) {
            // A slot for this row is used up by this question, whatever it answers.
            try {
                if (type != null && name != null) allowance.answer(Key(type, name, null), Verdict.REFUSE_FAILED, null)
            } catch (ignored: Throwable) {
            }
            false
        }
        // Only a yes lets a removal follow, and the hold lasts until it is done. One that cannot be handed on goes, so
        // saves are never held for the rest of the process.
        try {
            if (yes) seams.held(hold) else hold.release()
        } catch (t: Throwable) {
            hold.release()
        }
        try {
            seams.log(decision?.verdict, yes)
        } catch (ignored: Throwable) {
        }
        try {
            if (yes) {
                if (type != null && name != null) seams.allowedInApp(type, name)
                seams.allowed()
            } else if (type == mainType && name != null) {
                val kind = NotesRemovalNotice.kind(decision)
                if (!seams.withheldInApp(type, name, kind)) seams.refused(kind)
            }
        } catch (ignored: Throwable) {
        }
        return yes
    }

    /** The seams on this device. */
    private class OnDevice(private val context: Context) : Seams {
        override fun decision(type: String, name: String, hold: RemovalHold) =
            PendingNotesRemovalGuard.decision(context, Account(name, type), hold)

        // Android removes the row as soon as it has the yes (AccountManagerService, RemoveAccountSession), with no
        // answer back to the authenticator, so the hold is released after a time no such step takes.
        override fun held(hold: RemovalHold) {
            Handler(Looper.getMainLooper()).postDelayed(hold::release, HOLD_AFTER_YES_MS)
        }

        override fun fingerprint(decision: Decision) = NotesRemovalOffer.fingerprintOnDevice(context, decision)

        override fun refused(kind: Kind) = NotesRemovalNotice.post(context, kind)

        override fun allowed() = NotesRemovalNotice.clear(context)

        override fun withheldInApp(type: String, name: String, kind: Kind) =
            NotesRemovalAnswer.withheldInApp(type, name, kind)

        override fun allowedInApp(type: String, name: String) = NotesRemovalAnswer.allowedInApp(type, name)

        override fun log(verdict: Verdict?, allowed: Boolean) {
            Logger.log.info("Notes removal answer: $verdict, allowed $allowed")
        }
    }

    /** One removal [Companion.askInApp] marked. It ends once, by [done] or [left]. */
    internal class Asking(internal val row: Pair<String, String>) {
        private var open = true
        private var withheld: Kind? = null

        /** Takes a no in the words of [kind] while it has not ended; whether it did. A later no replaces it. */
        @Synchronized
        fun withhold(kind: Kind): Boolean {
            if (open) withheld = kind
            return open
        }

        /** A yes for its row: any no it took goes, as the notification goes after a yes. A later no counts again. */
        @Synchronized
        fun allow() {
            withheld = null
        }

        /**
         * Its outcome came while its screen is in front of the user, who sees it there, and says whether the account
         * was removed: the mark ends, with any no.
         */
        fun done() {
            end()
        }

        /**
         * Its outcome may go unseen or not say that the account stayed: it came after the user left its screen, it
         * can't say whether the account was removed, or the screen went first. The mark ends, and any no it took is
         * to post.
         */
        fun left(): Kind? = end()

        @Synchronized
        private fun end(): Kind? {
            if (!open) return null
            open = false
            inApp.computeIfPresent(row) { _, marks -> (marks - this).takeIf { it.isNotEmpty() } }
            return withheld
        }
    }

    companion object {
        /** How long saves into the stores checked for a yes stay held ([Seams.held]) on this device. */
        internal const val HOLD_AFTER_YES_MS = 30_000L

        /** The removals the confirmation in Unsynced Notes asked for whose mark hasn't ended, by row. */
        private val inApp = ConcurrentHashMap<Pair<String, String>, Set<Asking>>()

        /**
         * Marks a removal of the row of [type] named [name] that the confirmation in Unsynced Notes asks for,
         * until its outcome comes ([Asking.done], or [Asking.left] once the user has left the screen or for an
         * outcome that can't say whether the account was removed) or the screen goes first ([Asking.left]): a no
         * for that row meanwhile waits on the mark instead of posting the notification ([withheldInApp]), and a
         * yes takes it away ([allowedInApp]). An answer to a removal Android settings asks for in the meantime
         * is not told apart.
         */
        internal fun askInApp(type: String, name: String): Asking {
            val asking = Asking(type to name)
            inApp.compute(asking.row) { _, marks -> marks.orEmpty() + asking }
            return asking
        }

        /**
         * Hands a no for the row of [type] named [name], in the words of [kind], to each removal [askInApp] marked for
         * it that has not ended; whether there was one.
         */
        internal fun withheldInApp(type: String, name: String, kind: Kind): Boolean =
            inApp[type to name].orEmpty().map { it.withhold(kind) }.any { it }

        /** Takes any no away from each removal [askInApp] marked for the row of [type] named [name]. */
        internal fun allowedInApp(type: String, name: String) {
            inApp[type to name].orEmpty().forEach { it.allow() }
        }

        /** How many rows have a mark that hasn't ended, for the tests: none once every mark has ended. */
        internal fun markedRowsForTesting(): Int = inApp.size

        /** The answer on this device for [account], over this process's allowance; false when even that fails. */
        @WorkerThread
        fun allowedOnDevice(context: Context, account: Account?): Boolean = try {
            NotesRemovalAnswer(App.accountType, NotesRemovalAllowance.process, OnDevice(context.applicationContext))
                .allowed(account?.type, account?.name)
        } catch (t: Throwable) {
            false
        }
    }
}
