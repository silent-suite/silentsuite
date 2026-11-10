package io.silentsuite.sync.ui

import io.silentsuite.sync.R
import io.silentsuite.sync.ui.NotesRemovalDialogFragment.Restore
import io.silentsuite.sync.ui.NotesRemovalNotice.Kind
import io.silentsuite.sync.ui.NotesRemovalOffer.Opened
import io.silentsuite.sync.ui.NotesRemovalSection.Row
import io.silentsuite.sync.ui.NotesRemovalSection.Section
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Cause
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Decision
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The removal section of Unsynced Notes, and the confirmation it opens, restored or not. */
class NotesRemovalSectionTest {
    @Test fun `the section lists each present account Android settings would not remove now, once, in name order`() {
        val decisions = mapOf(
            "c" to Decision(Verdict.REFUSE_STORE, "gen-c"),
            "a" to Decision(Verdict.ROOT_UNLISTABLE_ONLY, null),
            "b" to Decision(Verdict.ALLOW, "gen-b"),
            "d" to Decision(Verdict.REFUSE_STORE, null, accountsUnread = true))
        val asked = ArrayList<String>()
        val section = NotesRemovalSection.section(TYPE, listOf("c", "a", "b", "d", "a")) {
            asked += it
            decisions.getValue(it)
        }
        assertEquals(Section(listOf(Row(TYPE, "a", Kind.CONFIRM), Row(TYPE, "c", Kind.STORE),
            Row(TYPE, "d", Kind.UNCHECKED)), accountsUnread = false), section)
        assertEquals("each account decided once", listOf("a", "b", "c", "d"), asked)
        assertFalse(section.empty)
    }

    @Test fun `a decision that throws is a refusal, and an account list that cannot be read is one row`() {
        assertEquals(Section(listOf(Row(TYPE, "a", Kind.UNCHECKED)), accountsUnread = false),
            NotesRemovalSection.section(TYPE, listOf("a")) { throw IllegalStateException("guard") })
        val unread = NotesRemovalSection.section(TYPE, null) { throw AssertionError("nothing to decide") }
        assertEquals(Section(emptyList(), accountsUnread = true), unread)
        assertFalse("its row shows", unread.empty)
        assertTrue(NotesRemovalSection.section(TYPE, emptyList()) { throw AssertionError("no account") }.empty)
        assertTrue(NotesRemovalSection.section(TYPE, listOf("b")) { Decision(Verdict.ALLOW, "gen-b") }.empty)
    }

    @Test fun `each kind has its own summary, and each check its words`() {
        assertEquals(listOf(R.string.notes_removal_section_store, R.string.notes_removal_section_confirm,
            R.string.notes_removal_section_unchecked), Kind.entries.map(NotesRemovalSection::summary))
        assertEquals(R.string.notes_removal_gone, NotesRemovalViewModel.said(Opened.Gone))
        assertEquals(R.string.notes_removal_allowed, NotesRemovalViewModel.said(Opened.Allowed))
        for (kind in Kind.entries) {
            assertEquals(R.string.notes_removal_still_refused, NotesRemovalViewModel.said(Opened.Refused(kind)))
        }
    }

    @Test fun `a confirmation restored in another process checks again, and one that ended here says so`() {
        for (showing in listOf(true, false)) {
            assertEquals("$showing", Restore.ANOTHER_PROCESS,
                NotesRemovalDialogFragment.restore(thisProcess = false, showing = showing, readable = true))
            for (thisProcess in listOf(true, false)) {
                assertEquals("a reason that does not read", Restore.ENDED,
                    NotesRemovalDialogFragment.restore(thisProcess, showing, readable = false))
            }
        }
        assertEquals(Restore.SHOWN, NotesRemovalDialogFragment.restore(thisProcess = true, showing = true, readable = true))
        assertEquals(Restore.ENDED, NotesRemovalDialogFragment.restore(thisProcess = true, showing = false, readable = true))
    }

    @Test fun `a dialog's reason reads only as one of an eligible verdict`() {
        for (verdict in Verdict.entries.filter { it.eligible }) {
            val names = verdict.reason!!.map { it.name }.sorted()
            assertEquals("$verdict", verdict.reason, NotesRemovalDialogFragment.reasonOf(names))
        }
        assertNull(NotesRemovalDialogFragment.reasonOf(null))
        assertNull(NotesRemovalDialogFragment.reasonOf(listOf("NO_SUCH_CAUSE")))
        assertNull(NotesRemovalDialogFragment.reasonOf(emptyList()))
        val noConfirmation = Cause.entries.map { setOf(it) }.firstOrNull { reason ->
            Verdict.entries.none { it.eligible && it.reason == reason }
        }
        if (noConfirmation != null) {
            assertNull("$noConfirmation", NotesRemovalDialogFragment.reasonOf(noConfirmation.map { it.name }))
        }
    }

    private companion object {
        const val TYPE = "io.silentsuite"
    }
}
