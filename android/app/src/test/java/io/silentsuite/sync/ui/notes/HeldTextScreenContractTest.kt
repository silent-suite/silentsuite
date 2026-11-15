package io.silentsuite.sync.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The account's Unsynced text screen (HeldTextFragment). Its name does not start with "UnsyncedNotes", so the bans
 * of UnsyncedNotesContractTest do not reach it; this test keeps what they would: one request, after Try again only,
 * and no clear of a store.
 */
class HeldTextScreenContractTest {
    private val screen = File("src/main/java/io/silentsuite/sync/ui/notes/HeldTextFragment.kt").readText().replace("\r\n", "\n")

    private fun count(text: String) = screen.split(text).size - 1

    @Test fun `the screen asks for one Notes run, a user-started one, after Try again only`() {
        // UnsyncedNotesContractTest's words, which do not reach this file by its name, with one request allowed.
        val code = screen.replace(Regex("(?s)/\\*.*?\\*/"), "").replace(Regex("//[^\n]*"), "")
        for (banned in listOf("HttpClient", "EtebaseLocalCache", "getEtebase", "etebaseSession", "KEY_ETEBASE_SESSION", "okhttp",
            "java.net", "NotesSyncRunner", "requestSync", "ContentResolver")) {
            assertFalse("no $banned", code.contains(banned, ignoreCase = true))
        }
        assertEquals("one request", 1, Regex(Regex.escape(".request("), RegexOption.IGNORE_CASE).findAll(code).count())
        assertEquals(1, count("NotesSyncCoordinator.request(appContext, account, creationId, NotesSyncPolicy.Trigger.MANUAL)"))
        val tryAgain = screen.substringAfter("    private fun tryAgain(row: HeldTextRow, button: View) {").substringBefore("\n    }\n")
        val io = tryAgain.indexOf("withContext(Dispatchers.IO) {")
        val release = tryAgain.indexOf("store.release(uid).also { released ->")
        val request = tryAgain.indexOf("if (released) NotesSyncCoordinator.request(")
        assertTrue("the request is in Try again", request >= 0)
        assertTrue("in the same step off the main thread, only once the release took", io >= 0 && io < release && release < request)
    }

    @Test fun `the screen clears no store, and makes every store call off the main thread`() {
        for (banned in listOf("clearAll", "discardStore", "discardOrphan", "discardNotebook", "unregister")) {
            assertFalse("no $banned", screen.contains(banned))
        }
        assertEquals("the store is opened in one place", 1, count("PendingNotesStore.forIdentity("))
        assertEquals("by one helper", 2, count("withStore(appContext)"))
        // Each store call runs in a block on the IO dispatcher: Try again's release, and Discard's one call, which the
        // store checks against the version and the text shown, and against a run that may send it, under its lock.
        val tryAgain = screen.substringAfter("    private fun tryAgain(row: HeldTextRow, button: View) {").substringBefore("\n    }\n")
        assertTrue(tryAgain.contains("withContext(Dispatchers.IO) {\n                    withStore(appContext) { store ->"))
        assertEquals("Discard's call", 1, count("withContext(Dispatchers.IO) { withStore(appContext) { it.discard(uid, shown, digest) } }"))
        assertEquals("the load as well", 1, count("withContext(Dispatchers.IO) { NotesLoader.heldText(appContext, account, creationId) }"))
        // A removal that could not be synced is said to be unsure, not failed.
        assertTrue(screen.contains("} catch (_: PendingNotesStore.RemovalNotSynced) {\n            if (current()) StoreCall.Unsure else StoreCall.Stale"))
    }

    @Test fun `a confirmation carries the version and a digest of the text it showed`() {
        val confirm = screen.substringAfter("    private fun confirmDiscard(row: HeldTextRow) {").substringBefore("\n    }\n")
        assertTrue(confirm.contains("row.version?.let { putLong(ARG_VERSION, it) }"))
        assertTrue(confirm.contains("row.digest?.let { putString(ARG_DIGEST, it) }"))
        val dialog = screen.substringAfter("    class DiscardConfirmation : DialogFragment() {").substringBefore("\n    }\n")
        assertTrue(dialog.contains("val digest = args.getString(ARG_DIGEST)"))
        assertTrue(dialog.contains("(parentFragment as? HeldTextFragment)?.discardNote(uid, shown, digest, shownIn)"))
    }

    @Test fun `an answer from a confirmation made in another app process deletes nothing and asks again`() {
        val confirm = screen.substringAfter("    private fun confirmDiscard(row: HeldTextRow) {").substringBefore("\n    }\n")
        assertTrue(confirm.contains("putString(ARG_PROCESS, ProcessIncarnation.current())"))
        val dialog = screen.substringAfter("    class DiscardConfirmation : DialogFragment() {").substringBefore("\n    }\n")
        assertTrue(dialog.contains("val shownIn = args.getString(ARG_PROCESS)"))
        val discard = screen.substringAfter("    private fun discardNote(").substringBefore("\n    }\n")
        val check = discard.indexOf("if (!ProcessIncarnation.isCurrent(shownIn)) { askAgainFor = uid; reload(); return }")
        assertTrue("checked before any store call", check in 0 until discard.indexOf("withStore(appContext)"))
        val render = screen.substringAfter("    private fun render(view: View, held: HeldTexts) {").substringBefore("\n    }\n")
        assertTrue(render.contains("held.rows.firstOrNull { it.noteUid == uid && it.canDiscard }?.let { confirmDiscard(it) }"))
    }

    @Test fun `a second tap starts nothing while Try again or a Discard runs, and Try again waits for a covered discard`() {
        val tryAgain = screen.substringAfter("    private fun tryAgain(row: HeldTextRow, button: View) {").substringBefore("\n    }\n")
        assertTrue(tryAgain.indexOf("if (actionRunning) return") in 0 until tryAgain.indexOf("actionRunning = true"))
        assertTrue(tryAgain.contains("button.isEnabled = false"))
        assertTrue(tryAgain.contains("} finally {\n                actionRunning = false"))
        assertTrue("the button works again even when the reload fails", tryAgain.contains("                button.isEnabled = true\n            }"))
        val confirm = screen.substringAfter("    private fun confirmDiscard(row: HeldTextRow) {").substringBefore("\n    }\n")
        assertTrue(confirm.contains("if (actionRunning) return"))
        val render = screen.substringAfter("    private fun render(view: View, held: HeldTexts) {").substringBefore("\n    }\n")
        assertTrue(render.contains("val covered = held.rows.any { it.discardConfirmed || it.permitUnchecked }"))
        assertTrue(render.contains("card(inflater, container, row, offerTryAgain = !covered)"))
    }

    @Test fun `the screen words its own notices, and a failed load is a line that stays`() {
        val render = screen.substringAfter("    private fun render(view: View, held: HeldTexts) {").substringBefore("\n    }\n")
        assertTrue(render.contains("if (held.notebooksFailed && held.pending == null) View.VISIBLE else View.GONE"))
        assertTrue(render.contains("PendingUnavailable.UNREADABLE -> getString(R.string.notes_held_pending_unreadable)"))
        assertTrue(render.contains("PendingUnavailable.DISCARD_STOPPED -> getString(R.string.notes_held_pending_discard_stopped)"))
        assertFalse("the note list's notices are not reused", screen.contains("NoteListFragment.pendingNotice") || screen.contains("R.string.notes_pending_"))
        val reload = screen.substringAfter("    private fun reload() {").substringBefore("\n    }\n")
        assertTrue(reload.contains("is NotesLoad.Failed -> showNotice(view, getString(R.string.notes_held_load_failed))"))
        assertFalse("no message repeated after every run", reload.contains("Toast"))
    }

    @Test fun `text reaches the clipboard only through the sensitive clip`() {
        assertEquals(1, count("SensitiveClip.copy("))
        assertFalse(screen.contains("setPrimaryClip"))
        val clip = File("src/main/java/io/silentsuite/sync/ui/notes/SensitiveClip.kt").readText()
        assertTrue(clip.contains("putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)"))
        val item = File("src/main/res/layout/held_text_item.xml").readText()
        assertFalse("the body is not selectable, so no copy bypasses the flag", item.contains("textIsSelectable"))
    }
}
