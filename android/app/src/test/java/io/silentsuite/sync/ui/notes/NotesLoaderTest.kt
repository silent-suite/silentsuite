package io.silentsuite.sync.ui.notes

import io.silentsuite.sync.notes.edit.NoteMetaCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotesLoaderTest {
    private val loader by lazy {
        java.io.File("src/main/java/io/silentsuite/sync/ui/notes/NotesLoader.kt").readText().replace("\r\n", "\n")
    }

    @Test fun `a load reads the pending store first, then the cache, and never both together`() {
        // design 3.2: the pending lock is never held together with the cache monitor or the cache's write fence.
        val load = loader.substringAfter("    private fun <P, T : Any> load(").substringBefore("\n    }\n")
        val store = load.indexOf("readLocalChanges(appContext, account, creationId, readPending)")
        assertTrue("the store is read in load", store > 0)
        for (later in listOf("EtebaseLocalCache.getInstance(", "EtebaseLocalCache.getEtebase(", "synchronized(cache)")) {
            assertTrue("the store is read before $later", load.indexOf(later) > store)
        }
        assertEquals("one cache monitor in the loader, the one in load", 1, loader.split("synchronized(").size - 1)
        // The Unsynced text screen reads the store again after the cache, and decrypts there: outside the monitor,
        // in a step that load() has returned from.
        val held = loader.substringAfter("    private fun heldRows(plan: HeldPlan): HeldTexts {").substringBefore("\n    }\n")
        assertTrue(held.contains("store.read(header.noteUid)"))
        val step = loader.substringAfter("is NotesLoad.Loaded -> guarded(context, account, creationId) {").substringBefore("\n        }\n")
        assertTrue("heldRows runs in the guarded step, after load() returned", step.contains("heldRows(held)"))
        // No store call is made from a cache block: every one of them is in a readPending lambda or in heldRows.
        for (call in listOf("store.snapshot {", "store.observe(", "store.notebook(")) {
            assertTrue("$call is made", loader.contains(call))
        }
        assertFalse("the overlay's keep never touches the cache", Regex("snapshot \\{[^}]*cache").containsMatchIn(loader))
    }

    /** The text of one catch clause of [body]: from its brace to the next clause or the end of the try. */
    private fun clause(body: String, catch: String): String {
        val at = body.indexOf(catch)
        assertTrue("caught: $catch", at >= 0)
        return body.substring(at + catch.length).substringBefore("\n        }")
    }

    @Test fun `local changes that cannot be read, or that a stopped discard holds, never close or fail a screen`() {
        // Every load reads the store through one function, which turns a store that cannot be opened, listed or
        // read into Unreadable, and a store a discard closed into DiscardStopped or Cleared, never into a failure.
        val read = loader.substringAfter("    private fun <P> readLocalChanges(").substringBefore("\n    }\n")
        assertEquals("if (store.clearStopped()) Pending.DiscardStopped else Pending.Cleared",
            clause(read, "} catch (_: PendingNotesStore.Cleared) {").trim())
        assertTrue(clause(read, "} catch (e: IOException) {").trim().endsWith("Pending.Unreadable"))
        assertTrue("opening the store is inside the same guard",
            read.indexOf("PendingNotesStore.forIdentity(") in 0 until read.indexOf("return store to try {"))
        val load = loader.substringAfter("    private fun <P, T : Any> load(").substringBefore("\n    }\n")
        assertEquals("load reads the store only through it", 1,
            load.split("readLocalChanges(appContext, account, creationId, readPending)").size - 1)
        assertFalse("and closes no screen for a cleared store", load.contains("PendingNotesStore.Cleared"))
        // Each screen shows the cached notes with the reason.
        val notebooks = loader.substringAfter("    fun notebooks(").substringBefore("\n    }\n")
        assertTrue(notebooks.contains("Pending.Unreadable -> NotebookOverview(rows, 0, failed, pendingUnreadable = true)"))
        assertTrue(notebooks.contains("Pending.DiscardStopped -> NotebookOverview(rows, 0, failed, discardStopped = true)"))
        val notebook = loader.substringAfter("    fun notebook(").substringBefore("\n    }\n")
        assertTrue(notebook.contains("?: return@load NotebookContents(row, sortNotes(notes), unreadable.size, pending.unavailable())"))
        val note = loader.substringAfter("    fun note(").substringBefore("\n    }\n")
        assertTrue(note.contains("?: return@load cached?.copy(pending = pending.unavailable())"))
        // An action on a store a discard closed closes the screen only once the account is gone.
        val screen = java.io.File("src/main/java/io/silentsuite/sync/ui/notes/HeldTextFragment.kt").readText().replace("\r\n", "\n")
        val withStore = screen.substringAfter("    private fun <T> withStore(").substringBefore("\n    }\n")
        val cleared = clause(withStore, "} catch (_: PendingNotesStore.Cleared) {").trimStart()
        assertTrue(cleared, cleared.startsWith(
            "if (!current()) {\n                StoreCall.Stale\n            } else if (store?.clearStopped() == true) {\n                StoreCall.Stopped"))
    }

    private fun hex(s: String) = s.replace(" ", "").chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test fun `preview takes the first meaningful line without markdown markers`() {
        assertEquals("Shopping", NotesLoader.previewOf("\n\n# Shopping\n- milk"))
        assertEquals("milk", NotesLoader.previewOf("- milk\n- eggs"))
        assertEquals("first step", NotesLoader.previewOf("1. first step\n2. second"))
        assertEquals("quoted", NotesLoader.previewOf("> quoted"))
        assertEquals("", NotesLoader.previewOf("   \n\t\n"))
        assertEquals(140, NotesLoader.previewOf("x".repeat(500)).length)
    }

    @Test fun `notes sort newest edit first and untimed notes last`() {
        val sorted = NotesLoader.sortNotes(listOf(
            NoteRow("c", "Charlie", "", null),
            NoteRow("a", "alpha", "", 10),
            NoteRow("b", "Bravo", "", 20),
            NoteRow("d", "delta", "", null),
        )).map { it.uid }
        assertEquals(listOf("b", "a", "c", "d"), sorted)
    }

    @Test fun `only a missing or empty item type is a note as on the web`() {
        assertTrue(NotesLoader.isMarkdownNote(null))
        assertTrue(NotesLoader.isMarkdownNote(""))
        // packages/core isMarkdownNoteItem skips these, so Android must too.
        assertFalse(NotesLoader.isMarkdownNote(" "))
        assertFalse(NotesLoader.isMarkdownNote("attachment"))
    }

    @Test fun `titles come from the raw metadata bytes`() {
        // A four-byte character reads back whole from the bytes, and the title is trimmed.
        assertEquals("Plan 🛒", NotesLoader.titleOf(NoteMetaCodec.fresh("  Plan 🛒 ", 5).bytes))
        assertEquals("a lone surrogate was written as U+FFFD", "a�b", NotesLoader.titleOf(NoteMetaCodec.fresh("a\uD800b", 5).bytes))
        val noTitle = mapOf(
            "no metadata" to null,
            "empty metadata" to ByteArray(0),
            "an array" to hex("91 01"),
            "a name that is a number" to hex("82 a4 6e616d65 05 a5 6d74696d65 01"),
            "a name that is not UTF-8" to hex("81 a4 6e616d65 a2 c328"),
            "a repeated name" to hex("82 a4 6e616d65 a1 61 a4 6e616d65 a1 62"),
            "a plain name next to another client's key" to hex("83 a4 6e616d65 a1 41 a5 6d74696d65 05 01 a1 42"),
            // These pass the typed decoder, so they are what reaches titleOf from a real cache. The
            // typed name would read "B" for the last two; the raw path gives no title.
            "no name" to hex("81 a5 6d74696d65 05"),
            "a nil name" to hex("82 a4 6e616d65 c0 a5 6d74696d65 05"),
            "a name only under another client's key" to hex("82 01 a1 42 a5 6d74696d65 05"),
            "a name under a binary key" to hex("82 c4 04 6e616d65 a1 42 a5 6d74696d65 05"),
        )
        for ((what, raw) in noTitle) assertEquals(what, "", NotesLoader.titleOf(raw))
    }
}
