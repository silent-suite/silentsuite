package io.silentsuite.sync.ui

import io.silentsuite.sync.R
import io.silentsuite.sync.ui.NotesRemovalNotice.Kind
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Decision
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NotesRemovalNoticeTest {
    @Test fun `the words of a refusal follow the verdict, and the account list for a store`() {
        for (verdict in Verdict.entries) {
            for (accountsUnread in listOf(false, true)) {
                val expected = when {
                    verdict.eligible -> Kind.CONFIRM
                    // Without the account list no store was left out as a live account's: the remedy is another
                    // attempt, not a review. Names of an unknown kind stay, so another attempt gets the same answer:
                    // the words that say to try again later are not theirs.
                    (verdict == Verdict.REFUSE_STORE || verdict == Verdict.REFUSE_UNKNOWN_KIND) && !accountsUnread ->
                        Kind.STORE
                    else -> Kind.UNCHECKED
                }
                assertEquals("$verdict, accounts unread $accountsUnread", expected,
                    NotesRemovalNotice.kind(Decision(verdict, null, accountsUnread = accountsUnread)))
            }
        }
        assertEquals("a row whose creation id reads, its own store", Kind.STORE,
            NotesRemovalNotice.kind(Decision(Verdict.REFUSE_STORE, "id")))
        assertEquals("names of a kind this build cannot read", Kind.STORE,
            NotesRemovalNotice.kind(Decision(Verdict.REFUSE_UNKNOWN_KIND, null, listOf("future.dat"))))
        assertEquals("its acknowledgement not withdrawn, nothing counted", Kind.UNCHECKED,
            NotesRemovalNotice.kind(Decision(Verdict.REFUSE_UNREADABLE, "id")))
        assertEquals("a check that threw", Kind.UNCHECKED, NotesRemovalNotice.kind(Decision(Verdict.REFUSE_FAILED, "id")))
        assertEquals("no decision", Kind.UNCHECKED, NotesRemovalNotice.kind(null))
    }

    @Test fun `each kind has its own text`() {
        assertEquals(listOf(R.string.notes_removal_refused_store, R.string.notes_removal_refused_confirm,
            R.string.notes_removal_refused_unchecked), Kind.entries.map(NotesRemovalNotice::text))
    }

    @Test fun `the app's own removal takes the notification away only once the row went, and always answers`() {
        val seen = ArrayList<String>()
        NotesRemovalNotice.afterRemoval({ seen += "clear" }) { seen += "removed $it" }(true)
        assertEquals(listOf("clear", "removed true"), seen)
        seen.clear()
        NotesRemovalNotice.afterRemoval({ seen += "clear" }) { seen += "removed $it" }(false)
        assertEquals(listOf("removed false"), seen)
        seen.clear()
        NotesRemovalNotice.afterRemoval({ throw IllegalStateException("no manager") }) { seen += "removed $it" }(true)
        assertEquals("a clear that throws changes nothing", listOf("removed true"), seen)
    }

    @Test fun `sign-out and setup recovery take the notification away after their own removal`() {
        val signOut = File("src/main/java/io/silentsuite/sync/ui/AndroidCurrentAccountSignOut.kt").readText()
        assertTrue(signOut.contains(
            "AndroidCompat.removeAccount(manager, row, NotesRemovalNotice.clearAfter(context, callback))"))
        // The other removal there is of an address book row, which holds no Notes.
        assertEquals(2, Regex("""AndroidCompat\.removeAccount\(""").findAll(signOut).count())
        assertTrue(signOut.contains("AndroidCompat.removeAccount(manager, child!!) { confirmed ->"))
        val recovery = File("src/main/java/io/silentsuite/sync/ui/setup/PostLoginSetupViewModel.kt").readText()
        assertTrue(recovery.contains("NotesRemovalNotice.clearAfter(appContext, done)"))
    }
}
