package io.silentsuite.sync.ui.etebase

import io.silentsuite.sync.R
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.NotebookDiscard
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.ui.UnsyncedNotesSignOutPolicy.Text
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.After
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Answer
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Ended
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Next
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Start
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class NotebookLeaveOrDeletePolicyTest {
    private val two = UnsyncedNotes(2, 7, false, names = setOf("a.note", "b.note"))
    private val uncounted = UnsyncedNotes(3, 7, unreadable = true, names = setOf("a.note", "b.note", "x.draft"))
    private val unlisted = UnsyncedNotes(0, 7, unreadable = true, listed = false)
    private val policy = NotebookLeaveOrDeletePolicy

    @Test fun `nothing unsynced starts plain, and anything else, a failed count included, with the count`() {
        assertEquals(Start.Plain, policy.start(UnsyncedNotes.NOTHING))
        for (shown in listOf(two, uncounted, unlisted, policy.countFailed)) {
            assertEquals("$shown", Start.ShowCount(shown), policy.start(shown))
        }
        assertTrue("a failed count is never nothing", policy.countFailed.anything)
        assertNotEquals(UnsyncedNotes.NOTHING, policy.countFailed)
    }

    @Test fun `each answer leads where it says, and only the discard answer goes on`() {
        for (shown in listOf(two, uncounted, unlisted)) {
            assertEquals(Next.SyncNotes, policy.answered(Answer.SYNC_NOW, shown, fromThisProcess = true))
            assertEquals(Next.ShowDiscard(shown),
                policy.answered(Answer.GO_ON_WITHOUT_SYNCING, shown, fromThisProcess = true))
            assertEquals(Next.Proceed(shown), policy.answered(Answer.DISCARD, shown, fromThisProcess = true))
            assertEquals(Next.Close, policy.answered(Answer.KEEP, shown, fromThisProcess = true))
        }
    }

    @Test fun `an answer from a dialog made in another process counts again, and never syncs, confirms, goes on or closes`() {
        for (answer in Answer.values()) {
            for (shown in listOf(two, uncounted, unlisted, UnsyncedNotes.NOTHING, policy.countFailed)) {
                val next = policy.answered(answer, shown, fromThisProcess = false)
                assertEquals("$answer to $shown", Next.CountAgain, next)
                assertFalse("$answer to $shown", next == Next.SyncNotes || next is Next.ShowDiscard ||
                    next is Next.Proceed || next == Next.Close)
            }
        }
    }

    @Test fun `the dialogs say the count, that it could not be counted, or that the store could not be read`() {
        assertEquals(Text.Counted(2), policy.text(two))
        assertEquals(Text.Uncounted, policy.text(uncounted))
        assertEquals(Text.Unlisted, policy.text(unlisted))
        assertEquals("never a count of zero", Text.Uncounted, policy.text(UnsyncedNotes.NOTHING))
        assertEquals(Text.Uncounted, policy.text(policy.countFailed))
        // The defaults while the maintainer has not decided: going on while the store cannot be read, and asking once
        // more after a change.
        assertTrue(policy.GOES_ON_WHILE_UNLISTED && policy.ASKS_ONCE_MORE_AFTER_A_CHANGE)
        for (shown in listOf(two, uncounted, unlisted)) assertTrue("$shown", policy.offersGoingOn(shown))
    }

    /** A leave or delete with recording fakes: [calls] lists each step as it runs. */
    private class Run(
        val now: UnsyncedNotes,
        val running: Boolean = true,
        val validate: List<Boolean> = listOf(true, true),
        val server: () -> Boolean = { true },
        val discard: (UnsyncedNotes) -> NotebookDiscard = { NotebookDiscard.Done(it.count, 0) },
    ) {
        val calls = ArrayList<String>()
        private var validated = 0

        fun remove(shown: UnsyncedNotes): Ended = NotebookLeaveOrDelete.remove(shown,
            validate = { calls += "validate"; validate[validated++] },
            count = { calls += "count"; now },
            running = { calls += "running"; running },
            cancel = { calls += "cancel" },
            server = { calls += "server"; server() },
            discard = { calls += "discard"; discard(it) })

        fun again(now: UnsyncedNotes): Ended = NotebookLeaveOrDelete.again(now,
            validate = { calls += "validate"; validate[validated++] },
            discard = { calls += "discard"; discard(it) })
    }

    @Test fun `the server call comes first, the account is checked again, and only then is anything discarded`() {
        val run = Run(two)
        assertEquals(Ended.Removed(NotebookDiscard.Done(2, 0)), run.remove(two))
        assertEquals(listOf("validate", "count", "running", "cancel", "server", "validate", "discard"), run.calls)
        // What the store discards is what the dialog showed, not what the count found since.
        val fewer = UnsyncedNotes(1, 7, false, names = setOf("a.note"))
        var discarded: UnsyncedNotes? = null
        assertTrue(Run(fewer, discard = { discarded = it; NotebookDiscard.Done(1, 0) }).remove(two) is Ended.Removed)
        assertEquals(two, discarded)
    }

    @Test fun `a server call that throws or says the account changed never reaches the discard`() {
        val failing = Run(two, server = { throw IOException("offline") })
        assertThrows(IOException::class.java) { failing.remove(two) }
        assertEquals(listOf("validate", "count", "running", "cancel", "server"), failing.calls)
        val changed = Run(two, server = { false })
        assertEquals(Ended.AccountChanged, changed.remove(two))
        assertFalse(changed.calls.contains("discard"))
    }

    @Test fun `an account that changed before or after the server call discards nothing`() {
        val before = Run(two, validate = listOf(false))
        assertEquals(Ended.AccountChanged, before.remove(two))
        assertEquals(listOf("validate"), before.calls)
        val after = Run(two, validate = listOf(true, false))
        assertEquals(Ended.AccountChanged, after.remove(two))
        assertEquals(listOf("validate", "count", "running", "cancel", "server", "validate"), after.calls)
    }

    @Test fun `a count the confirmation no longer covers asks again, with no server call`() {
        val more = UnsyncedNotes(3, 8, false, names = two.names + "c.note")
        for (now in listOf(more, UnsyncedNotes(2, 8, false, names = two.names), policy.countFailed)) {
            val run = Run(now)
            assertEquals("$now", Ended.AskAgain(now), run.remove(two))
            assertEquals("$now", listOf("validate", "count"), run.calls)
        }
        val plain = Run(two)
        assertEquals("changes saved after today's question was answered", Ended.AskAgain(two),
            plain.remove(UnsyncedNotes.NOTHING))
        assertEquals("the store lists now", Ended.AskAgain(two), Run(two).remove(unlisted))
        // Less than was shown, or nothing left, needs no new answer.
        val fewer = UnsyncedNotes(1, 7, false, names = setOf("b.note"))
        for (now in listOf(fewer, UnsyncedNotes.NOTHING)) assertTrue("$now", Run(now).remove(two) is Ended.Removed)
        assertTrue(Run(UnsyncedNotes.NOTHING).remove(UnsyncedNotes.NOTHING) is Ended.Removed)
    }

    @Test fun `the Notes run is canceled only for a listed answer that holds anything, and only while it runs`() {
        val idle = Run(two, running = false)
        idle.remove(two)
        assertEquals(listOf("validate", "count", "running", "server", "validate", "discard"), idle.calls)
        for (shown in listOf(UnsyncedNotes.NOTHING, unlisted)) {
            val run = Run(shown)
            run.remove(shown)
            assertEquals("$shown", listOf("validate", "count", "server", "validate", "discard"), run.calls)
        }
        val counted = Run(uncounted)
        counted.remove(uncounted)
        assertTrue("one that could not be counted holds anything", counted.calls.contains("cancel"))
    }

    @Test fun `a discard that throws before any text went is told from one that may have deleted some`() {
        /** How a confirmed leave or delete, and the one more question, end when the discard throws [failure]. */
        fun failed(failure: Throwable) =
            listOf(Run(two, discard = { throw failure }).remove(two), Run(two, discard = { throw failure }).again(two))
        // A uid that is not an Etebase uid is refused after any recovery that is owed and before the notebook is
        // counted. An Error, such as running out of memory in the recovery that runs before the count, ends the attempt
        // the same way instead of crashing the app; the store's discard passes on none once its loop began.
        for (failure in listOf(IOException("not listed"), IllegalStateException("x"),
                IllegalArgumentException("not an Etebase uid"), OutOfMemoryError("a large entry"),
                StackOverflowError())) {
            assertEquals("$failure", List(2) { Ended.DiscardFailed(known = true) }, failed(failure))
        }
        // A store that a clear or a whole-store discard closed refuses before this call deletes anything, but that
        // clear may have deleted the notebook's text.
        for (failure in listOf(PendingNotesStore.Cleared(), RuntimeException("anything else"),
                UnsupportedOperationException("or this"))) {
            assertEquals("$failure", List(2) { Ended.DiscardFailed(known = false) }, failed(failure))
        }
    }

    @Test fun `the one more question checks the account and discards, with no count, cancel or server call`() {
        val run = Run(two)
        assertEquals(Ended.Removed(NotebookDiscard.Done(2, 0)), run.again(two))
        assertEquals(listOf("validate", "discard"), run.calls)
        val gone = Run(two, validate = listOf(false))
        assertEquals(Ended.AccountChanged, gone.again(two))
        assertEquals(listOf("validate"), gone.calls)
    }

    @Test fun `each end says what happened to the notebook's changes, and nothing when none were left`() {
        val ends = mapOf(
            Ended.Removed(NotebookDiscard.Done(0, 0)) to After.Quiet,
            Ended.Removed(NotebookDiscard.Done(2, 0)) to After.Say(R.string.notes_notebook_discarded),
            Ended.Removed(NotebookDiscard.Done(2, 1)) to After.Say(R.string.notes_notebook_discarded_readable),
            Ended.Removed(NotebookDiscard.Done(0, 1)) to After.Say(R.string.notes_notebook_kept_unreadable),
            // A notebook that could not be counted: files that could not be placed stay, and may hold its text.
            Ended.Removed(NotebookDiscard.Done(0, 0, uncounted = true)) to
                After.Say(R.string.notes_notebook_nothing_deleted),
            Ended.Removed(NotebookDiscard.Done(2, 0, uncounted = true)) to
                After.Say(R.string.notes_notebook_discarded_readable),
            Ended.Removed(NotebookDiscard.Done(2, 1, uncounted = true)) to
                After.Say(R.string.notes_notebook_discarded_readable),
            Ended.Removed(NotebookDiscard.Done(0, 1, uncounted = true)) to
                After.Say(R.string.notes_notebook_kept_unreadable),
            Ended.Removed(NotebookDiscard.Partly(1, 2)) to After.Say(R.string.notes_notebook_kept_partly),
            Ended.Removed(NotebookDiscard.Partly(0, 2)) to After.Say(R.string.notes_notebook_nothing_deleted),
            // A removal that failed after it unlinked a file, or a sync owed before Done that failed.
            Ended.Removed(NotebookDiscard.Partly(0, 2, unsure = true)) to
                After.Say(R.string.notes_notebook_discard_unknown),
            Ended.Removed(NotebookDiscard.Partly(1, 2, unsure = true)) to
                After.Say(R.string.notes_notebook_discard_unknown),
            Ended.Removed(NotebookDiscard.Partly(1, 0, unsure = true)) to
                After.Say(R.string.notes_notebook_discard_unknown),
            Ended.Removed(NotebookDiscard.NotListed) to After.Say(R.string.notes_notebook_nothing_deleted),
            Ended.DiscardFailed(known = true) to After.Say(R.string.notes_notebook_nothing_deleted),
            Ended.DiscardFailed(known = false) to After.Say(R.string.notes_notebook_discard_unknown),
            Ended.AccountChanged to After.Quiet,
            Ended.AskAgain(two) to After.ShowCount(two),
        )
        for (askedAgain in listOf(false, true)) {
            for ((ended, after) in ends) assertEquals("$ended", after, policy.after(ended, askedAgain))
        }
    }

    @get:org.junit.Rule val tmp = org.junit.rules.TemporaryFolder()

    @org.junit.After fun reset() {
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.resetForTesting()
    }

    @Test fun `a discard that a stopped whole-store discard refuses says that some may already be deleted, through the real store`() {
        val dir = tmp.newFolder("store")
        val store = PendingNotesStore.open(dir, rename = { from, to ->
            java.nio.file.Files.move(from.toPath(), to.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        })
        store.saveLocal("n1", "b1", "r1", "a".toByteArray(), isCreate = false)
        store.saveLocal("n2", "b1", "r1", "b".toByteArray(), isCreate = false)
        val shown = store.unsyncedInNotebook("b1")
        // A discard of the whole store deletes n1 and stops at n2, and the instance stays closed.
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw IOException("stopped") }
        assertEquals(PendingNotesStore.DiscardOutcome.NotFinished, store.discardStore(store.unsynced()))
        PendingNotesStore.beforeRemoveForTesting = null
        assertTrue(store.clearStopped())
        val left = dir.list()!!.toSet()
        fun remove(notebook: String, confirmed: UnsyncedNotes) = NotebookLeaveOrDelete.remove(confirmed,
            validate = { true }, count = { store.unsyncedInNotebook(notebook) }, running = { false }, cancel = {},
            server = { true }, discard = { store.discardNotebook(notebook, it) })
        // The count from disk still covers what the user confirmed, n2 alone now, so the server call goes through.
        for (ended in listOf(remove("b1", shown), NotebookLeaveOrDelete.again(shown, validate = { true },
                discard = { store.discardNotebook("b1", it) }), remove("b2", UnsyncedNotes.NOTHING))) {
            assertEquals(Ended.DiscardFailed(known = false), ended)
            assertEquals(After.Say(R.string.notes_notebook_discard_unknown), policy.after(ended, askedAgain = false))
        }
        assertEquals("the refused discards changed nothing", left, dir.list()!!.toSet())
    }

    @Test fun `an Error after a deletion never ends a leave or delete saying that nothing was deleted, through the real store`() {
        val dir = tmp.newFolder("store")
        var failing: Throwable? = null
        val store = PendingNotesStore.open(dir, syncDirectory = { d ->
            val error = failing
            if (error != null && d.name == dir.name && "n1.note" !in dir.list()!!) {
                failing = null
                throw error
            }
        }, rename = { from, to ->
            java.nio.file.Files.move(from.toPath(), to.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        })
        for (uid in listOf("n1", "n2", "n3")) store.saveLocal(uid, "b1", "r1", uid.toByteArray(), isCreate = false)
        // Once the server call went through, the sync right after n1.note's unlink runs out of memory: n1 is gone.
        failing = OutOfMemoryError("the sync after an unlink")
        val unsure = NotebookLeaveOrDelete.remove(store.unsyncedInNotebook("b1"), validate = { true },
            count = { store.unsyncedInNotebook("b1") }, running = { false }, cancel = {}, server = { true },
            discard = { store.discardNotebook("b1", it) })
        assertEquals(Ended.Removed(NotebookDiscard.Partly(0, 3, unsure = true)), unsure)
        assertEquals(After.Say(R.string.notes_notebook_discard_unknown), policy.after(unsure, askedAgain = false))
        // In the one more question's Discard, n3's removal runs out of memory after n2 went.
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n3.note") throw OutOfMemoryError("a large entry") }
        val partly = NotebookLeaveOrDelete.again(store.unsyncedInNotebook("b1"), validate = { true },
            discard = { store.discardNotebook("b1", it) })
        assertEquals(Ended.Removed(NotebookDiscard.Partly(1, 1)), partly)
        assertEquals(After.Say(R.string.notes_notebook_kept_partly), policy.after(partly, askedAgain = true))
        assertEquals(setOf("n3.note", "sequence"), dir.list()!!.toSet())
    }

    @Test fun `a store that changed after the server call is asked about once more, and only once`() {
        for (now in listOf(two, uncounted)) {
            assertEquals(After.AskAgainAfter(now), policy.after(Ended.Removed(NotebookDiscard.Changed(now)), false))
            assertEquals("asked once already", After.Say(R.string.notes_notebook_kept_changed),
                policy.after(Ended.Removed(NotebookDiscard.Changed(now)), true))
        }
        for (now in listOf(UnsyncedNotes.NOTHING, unlisted)) {
            assertEquals("$now", After.Say(R.string.notes_notebook_kept_changed),
                policy.after(Ended.Removed(NotebookDiscard.Changed(now)), false))
        }
    }
}
