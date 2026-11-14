package io.silentsuite.sync.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The account's Unsynced Notes screen (HeldTextFragment). Its name does not start with "UnsyncedNotes", so the bans
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
        val tryAgain = screen.substringAfter("    private fun tryAgain(row: HeldTextRow) {").substringBefore("\n    }\n")
        val guard = tryAgain.indexOf("if (outcome.value) {")
        val request = tryAgain.indexOf("NotesSyncCoordinator.request(")
        assertTrue("the request is in Try again", request >= 0)
        assertTrue("and only once the release took", guard >= 0 && guard < request)
    }

    @Test fun `the screen clears no store, and makes every store call off the main thread`() {
        for (banned in listOf("clearAll", "discardStore", "discardOrphan", "discardNotebook", "unregister")) {
            assertFalse("no $banned", screen.contains(banned))
        }
        assertEquals("the store is opened in one place", 1, count("PendingNotesStore.forIdentity("))
        assertEquals("by one helper", 3, count("withStore(appContext)"))
        assertEquals("Try again's call runs on the IO dispatcher", 1, count("withContext(Dispatchers.IO) { withStore(appContext)"))
        assertEquals("the load as well", 1, count("withContext(Dispatchers.IO) { NotesLoader.heldText(appContext, account, creationId) }"))
        // Discard reads the rows again and calls the store in one block on the IO dispatcher.
        val discard = screen.substringAfter("    private fun discardNote(uid: String, shown: Long?) {").substringBefore("\n    }\n")
        val block = discard.substringAfter("val outcome = withContext(Dispatchers.IO) {").substringBefore("\n            }\n")
        assertTrue("the block is there", block.length < discard.length)
        val load = block.indexOf("NotesLoader.heldText(appContext, account, creationId)")
        val call = block.indexOf("withStore(appContext) { it.discard(uid, shown) }")
        assertTrue("the rows are read first, then the store is called, both in the block", load >= 0 && call > load)
        assertTrue("only a row still offered for discard is discarded", block.contains("row?.canDiscard == true -> withStore(appContext) { it.discard(uid, shown) }"))
        assertTrue("a listed row that is not, nothing", block.contains("row != null -> null"))
        assertTrue("a row no longer listed only reads the store", block.contains("else -> when (val read = withStore(appContext) { it.read(uid) })"))
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
