package io.silentsuite.sync.ui

import io.silentsuite.sync.notes.edit.NotesFolderListings.Folder
import io.silentsuite.sync.notes.edit.PendingNotesStore.RemovalHold
import io.silentsuite.sync.ui.NotesRemovalAllowance.FolderStat
import io.silentsuite.sync.ui.NotesRemovalAllowance.Fingerprint
import io.silentsuite.sync.ui.NotesRemovalAllowance.Key
import io.silentsuite.sync.ui.NotesRemovalAllowance.Mint
import io.silentsuite.sync.ui.NotesRemovalNotice.Kind
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Decision
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import io.silentsuite.sync.utils.AccountRowChanges
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotesRemovalAnswerTest {
    private val rows = AccountRowChanges()
    private var now = 1_000L
    private var ids = 0
    private val allowance = NotesRemovalAllowance(rows, { 0L }, { now }, { "shown-${++ids}" })
    private val pending = Fingerprint(mapOf(Folder.PENDING to FolderStat.Stat(1, 2, 0x41c0, 3)))

    /** Seams that record each step, with the decision and fingerprint they are given. */
    private inner class Seams(
        var decide: (String) -> Decision = { Decision(Verdict.ALLOW, "id") },
        var print: (Decision) -> Fingerprint = { pending },
    ) : NotesRemovalAnswer.Seams {
        val steps = mutableListOf<String>()
        val holds = mutableListOf<RemovalHold>()
        val handedOn = mutableListOf<RemovalHold>()
        var hand: (RemovalHold) -> Unit = { handedOn += it }
        var inApp = false
        var refuse: (Kind) -> Unit = {}
        var allow: () -> Unit = {}
        var logged: (Verdict?, Boolean) -> Unit = { _, _ -> }

        override fun decision(type: String, name: String, hold: RemovalHold): Decision {
            steps += "decision"
            holds += hold
            return decide(name)
        }

        override fun held(hold: RemovalHold) = hand(hold)

        override fun withheldInApp(type: String, name: String, kind: Kind): Boolean {
            if (inApp) steps += "withheld $kind"
            return inApp
        }

        override fun allowedInApp(type: String, name: String) {
            if (inApp) steps += "allowedInApp $name"
        }

        override fun fingerprint(decision: Decision): Fingerprint {
            steps += "fingerprint"
            return print(decision)
        }

        override fun refused(kind: Kind) {
            steps += "refused $kind"
            refuse(kind)
        }

        override fun allowed() {
            steps += "allowed"
            allow()
        }

        override fun log(verdict: Verdict?, allowed: Boolean) {
            steps += "log $verdict $allowed"
            logged(verdict, allowed)
        }
    }

    private fun answer(seams: Seams) = NotesRemovalAnswer(TYPE, allowance, seams)

    /** A slot for [a] without a creation id, made the way the confirmation's tap makes it. */
    private fun slot() {
        val shown = allowance.show(allowance.counts(), Key(TYPE, "a", null), Verdict.ROOT_UNLISTABLE_ONLY, pending,
            null)!!
        assertTrue(allowance.mint(shown.id, Key(TYPE, "a", null), Verdict.ROOT_UNLISTABLE_ONLY, pending, now)
            is Mint.Done)
    }

    @Test fun `an allowed removal moves the row counter first and takes the notification away`() {
        val seams = Seams()
        assertTrue(answer(seams).allowed(TYPE, "a"))
        assertEquals(1L, rows.count())
        assertEquals(listOf("decision", "log ALLOW true", "allowed"), seams.steps)
    }

    @Test fun `a refusal moves nothing, and its notification says what kind it is`() {
        val cases = listOf(
            Decision(Verdict.REFUSE_STORE, "id") to Kind.STORE,
            Decision(Verdict.REFUSE_STORE, null) to Kind.STORE,
            Decision(Verdict.REFUSE_STORE, null, accountsUnread = true) to Kind.UNCHECKED,
            Decision(Verdict.REFUSE_ACCOUNTS, null, accountsUnread = true) to Kind.UNCHECKED,
            Decision(Verdict.REFUSE_UNREADABLE, "id") to Kind.UNCHECKED,
            Decision(Verdict.REFUSE_FAILED, null) to Kind.UNCHECKED,
            Decision(Verdict.REFUSE_UNKNOWN_KIND, null) to Kind.STORE,
            Decision(Verdict.ROOT_UNLISTABLE_ONLY, null) to Kind.CONFIRM,
            Decision(Verdict.UNKNOWN_KIND_ONLY, null) to Kind.CONFIRM)
        for ((decision, kind) in cases) {
            val seams = Seams(decide = { decision })
            assertFalse("$decision", answer(seams).allowed(TYPE, "a"))
            val fingerprint = if (decision.verdict.eligible) listOf("fingerprint") else emptyList()
            assertEquals("$decision", listOf("decision") + fingerprint +
                listOf("log ${decision.verdict} false", "refused $kind"), seams.steps)
        }
        assertEquals("no refusal moves the row counter", 0L, rows.count())
    }

    @Test fun `an eligible verdict is let through by the confirmation's slot alone, once`() {
        slot()
        val moved = rows.count()
        val seams = Seams(decide = { Decision(Verdict.ROOT_UNLISTABLE_ONLY, null) })
        assertTrue(answer(seams).allowed(TYPE, "a"))
        assertEquals("the slot's compare-and-set", moved + 1, rows.count())
        assertEquals(listOf("decision", "fingerprint", "log ROOT_UNLISTABLE_ONLY true", "allowed"), seams.steps)
        assertFalse("used once", answer(Seams(decide = { Decision(Verdict.ROOT_UNLISTABLE_ONLY, null) })).allowed(TYPE, "a"))
    }

    @Test fun `anything that throws answers no and takes the row's slot out first`() {
        val throwers = listOf<Pair<String, (Seams) -> Unit>>(
            "decision" to { s -> s.decide = { throw IllegalStateException("decision") } },
            "decision error" to { s -> s.decide = { throw OutOfMemoryError("decision") } },
            "fingerprint" to { s ->
                s.decide = { Decision(Verdict.ROOT_UNLISTABLE_ONLY, null) }
                s.print = { throw StackOverflowError("fingerprint") }
            })
        for ((what, breaks) in throwers) {
            slot()
            val seams = Seams()
            breaks(seams)
            assertFalse(what, answer(seams).allowed(TYPE, "a"))
            assertTrue(what, seams.steps.contains("log ${if (what == "fingerprint") "ROOT_UNLISTABLE_ONLY" else "null"} false"))
            assertEquals(what, if (what == "fingerprint") "refused CONFIRM" else "refused UNCHECKED", seams.steps.last())
            // The slot is gone: the same eligible question with nothing thrown is refused now.
            assertFalse(what, answer(Seams(decide = { Decision(Verdict.ROOT_UNLISTABLE_ONLY, null) })).allowed(TYPE, "a"))
        }
    }

    @Test fun `the notification, its removal and the log line never change the answer`() {
        for (thrown in listOf(RuntimeException("seam"), LinkageError("seam"))) {
            val allowed = Seams().apply {
                allow = { throw thrown }
                logged = { _, _ -> throw thrown }
            }
            assertTrue("$thrown", answer(allowed).allowed(TYPE, "a"))
            val refused = Seams(decide = { Decision(Verdict.REFUSE_STORE, "id") }).apply {
                refuse = { throw thrown }
                logged = { _, _ -> throw thrown }
            }
            assertFalse("$thrown", answer(refused).allowed(TYPE, "a"))
            assertEquals(listOf("decision", "log REFUSE_STORE false", "refused STORE"), refused.steps)
        }
    }

    @Test fun `the hold the decision's store checks took goes at once for a no, and is handed on for a yes`() {
        val yes = Seams()
        assertTrue(answer(yes).allowed(TYPE, "a"))
        assertEquals("handed on", yes.holds, yes.handedOn)
        assertFalse("not released here", yes.holds.single().released)
        val no = Seams(decide = { Decision(Verdict.REFUSE_STORE, "id") })
        assertFalse(answer(no).allowed(TYPE, "a"))
        assertTrue(no.holds.single().released)
        assertEquals(emptyList<RemovalHold>(), no.handedOn)
        for (thrown in listOf(IllegalStateException("decision"), OutOfMemoryError("decision"))) {
            val failed = Seams(decide = { throw thrown })
            assertFalse("$thrown", answer(failed).allowed(TYPE, "a"))
            assertTrue("$thrown", failed.holds.single().released)
        }
        // A yes whose hold cannot be handed on keeps the yes, and the hold goes, so no save waits for the process.
        val unhanded = Seams().apply { hand = { throw IllegalStateException("handler") } }
        assertTrue(answer(unhanded).allowed(TYPE, "a"))
        assertTrue(unhanded.holds.single().released)
        assertEquals(listOf("decision", "log ALLOW true", "allowed"), unhanded.steps)
    }

    @Test fun `on a device a yes's hold is released after the time Android takes to remove the row`() {
        val source = java.io.File("src/main/java/io/silentsuite/sync/ui/NotesRemovalAnswer.kt").readText()
        assertTrue(source.contains("Handler(Looper.getMainLooper()).postDelayed(hold::release, HOLD_AFTER_YES_MS)"))
        assertEquals(30_000L, NotesRemovalAnswer.HOLD_AFTER_YES_MS)
    }

    @Test fun `a no while a removal the confirmation asked for is under way waits for its outcome and posts nothing`() {
        val asked = Seams(decide = { Decision(Verdict.REFUSE_STORE, "id") }).apply { inApp = true }
        assertFalse(answer(asked).allowed(TYPE, "a"))
        assertEquals(listOf("decision", "log REFUSE_STORE false", "withheld STORE"), asked.steps)
        // A yes takes away any no such a removal took, and the notification.
        val allowed = Seams().apply { inApp = true }
        assertTrue(answer(allowed).allowed(TYPE, "a"))
        assertEquals(listOf("decision", "log ALLOW true", "allowedInApp a", "allowed"), allowed.steps)
    }

    @Test fun `a removal the confirmation asks for takes each no until its outcome comes or the screen goes, once`() {
        assertFalse(NotesRemovalAnswer.withheldInApp(TYPE, "m", Kind.STORE))
        val first = NotesRemovalAnswer.askInApp(TYPE, "m")
        val second = NotesRemovalAnswer.askInApp(TYPE, "m")
        val third = NotesRemovalAnswer.askInApp(TYPE, "m")
        assertFalse("by row", NotesRemovalAnswer.withheldInApp(TYPE, "n", Kind.STORE))
        assertTrue(NotesRemovalAnswer.withheldInApp(TYPE, "m", Kind.CONFIRM))
        assertEquals("every open mark takes the no", Kind.CONFIRM, third.left())
        first.done()
        assertNull("shown, so there is nothing to post, and it ends once", first.left())
        assertFalse("ended, so it takes no more", first.withhold(Kind.STORE))
        assertTrue("one ended, the other still takes a no",
            NotesRemovalAnswer.withheldInApp(TYPE, "m", Kind.UNCHECKED))
        assertEquals("gone first: the last no it took is to post", Kind.UNCHECKED, second.left())
        assertNull("once", second.left())
        second.done()
        assertFalse(NotesRemovalAnswer.withheldInApp(TYPE, "m", Kind.STORE))
        assertNull("no no, nothing to post", NotesRemovalAnswer.askInApp(TYPE, "m").left())
        assertFalse(NotesRemovalAnswer.withheldInApp(TYPE, "m", Kind.STORE))
        assertEquals("every mark ended, so none is kept", 0, NotesRemovalAnswer.markedRowsForTesting())
    }

    @Test fun `a yes for the row takes away the no a removal the confirmation asks for took, by row`() {
        val asked = NotesRemovalAnswer.askInApp(TYPE, "y")
        val second = NotesRemovalAnswer.askInApp(TYPE, "y")
        val other = NotesRemovalAnswer.askInApp(TYPE, "z")
        assertTrue(NotesRemovalAnswer.withheldInApp(TYPE, "y", Kind.STORE))
        assertTrue(NotesRemovalAnswer.withheldInApp(TYPE, "z", Kind.STORE))
        NotesRemovalAnswer.allowedInApp(TYPE, "y")
        assertEquals("by row", Kind.STORE, other.left())
        assertNull("the yes came last, so there is nothing to post", asked.left())
        assertNull("from every open mark of the row", second.left())
        val again = NotesRemovalAnswer.askInApp(TYPE, "y")
        NotesRemovalAnswer.allowedInApp(TYPE, "y")
        assertTrue(NotesRemovalAnswer.withheldInApp(TYPE, "y", Kind.UNCHECKED))
        assertEquals("a no after the yes counts", Kind.UNCHECKED, again.left())
        assertEquals(0, NotesRemovalAnswer.markedRowsForTesting())
    }

    @Test fun `a row of another type or no row is refused, asks nothing and posts nothing`() {
        for ((type, name) in listOf(null to null, "other.type" to "a", TYPE to null)) {
            slot()
            val seams = Seams()
            assertFalse("$type $name", answer(seams).allowed(type, name))
            assertEquals("$type $name", listOf("log null false"), seams.steps)
            assertTrue("the slot of $TYPE stays", answer(Seams(decide = { Decision(Verdict.ROOT_UNLISTABLE_ONLY, null) }))
                .allowed(TYPE, "a"))
        }
    }

    private companion object {
        const val TYPE = "io.silentsuite"
    }
}
