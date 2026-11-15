package io.silentsuite.sync.ui.notes

import io.silentsuite.sync.notes.NotesNetworkPolicy
import io.silentsuite.sync.notes.NotesNetworkPolicy.Allowed
import io.silentsuite.sync.notes.NotesNetworkPolicy.Connection
import io.silentsuite.sync.notes.edit.NoteMetaCodec
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.SaveOutcome
import io.silentsuite.sync.ui.notes.NoteEditing.Local
import io.silentsuite.sync.ui.notes.NoteEditing.SyncLine
import io.silentsuite.sync.ui.notes.NoteEditorCore.Field
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.msgpack.core.MessagePack
import java.io.IOException

class NoteEditingTest {
    private var now = 0L
    private val core = NoteEditorCore { now }

    /** Types [text] at the end of [field], one character at a time. */
    private fun type(field: Field, text: String) {
        for (c in text) {
            val shown = core.text(field)
            core.edited(field, shown.length, "", c.toString(), shown + c)
            now += 100
        }
    }

    private fun saveWith(result: SaveResult): NoteEditorCore.Draft {
        val draft = checkNotNull(core.beginSave())
        core.finishSave(draft, result)
        return draft
    }

    // ---- loads ----

    @Test fun `a load older than the last save is dropped`() {
        core.opened("Title", "Body")
        type(Field.BODY, " more")
        saveWith(SaveResult.Saved(10))
        assertFalse("it read the store before the save", core.offerLoad("Old", "Older body", observedSequence = 9))
        assertEquals("Body more", core.body)
        assertTrue(core.offerLoad("Server", "Newer body", observedSequence = 10))
        assertEquals("Newer body", core.body)
        assertEquals("Server", core.title)
    }

    @Test fun `a dirty editor is never overwritten`() {
        core.opened("Title", "Body")
        type(Field.TITLE, "!")
        assertFalse(core.offerLoad("Server", "Server body", observedSequence = 1_000))
        assertEquals("Title!", core.title)
        assertEquals("Body", core.body)
        // Still not while that save runs: typing during it is not saved yet.
        val draft = checkNotNull(core.beginSave())
        type(Field.BODY, "?")
        core.finishSave(draft, SaveResult.Saved(5))
        assertTrue(core.dirty)
        assertFalse(core.offerLoad("Server", "Server body", observedSequence = 1_000))
        assertEquals("Body?", core.body)
    }

    // ---- what each answer leaves ----

    @Test fun `only a save that wrote the text clears the mark of unsaved text, and every answer keeps the text`() {
        val kept = listOf(SaveResult.NotSaved, SaveResult.TooLarge, SaveResult.Unreadable, SaveResult.Stale)
        for (result in kept) {
            val editor = NoteEditorCore { 0 }
            editor.opened("T", "B")
            editor.edited(Field.BODY, 1, "", "x", "Bx")
            editor.finishSave(checkNotNull(editor.beginSave()), result)
            assertTrue("$result keeps it unsaved", editor.dirty)
            assertEquals("Bx", editor.body)
            assertNotNull("$result: the next autosave tries again", editor.beginSave())
            assertEquals(NoteEditorCore.Mode.EDITING, editor.mode)
        }
        for (result in listOf(SaveResult.HeldChanged, SaveResult.Cleared)) {
            val editor = NoteEditorCore { 0 }
            editor.opened("T", "B")
            editor.edited(Field.BODY, 1, "", "x", "Bx")
            editor.finishSave(checkNotNull(editor.beginSave()), result)
            assertTrue(editor.dirty)
            assertEquals("the text stays for Copy", "Bx", editor.body)
            assertEquals(NoteEditorCore.Mode.STOPPED, editor.mode)
            assertNull("nothing more is saved from here", editor.beginSave())
            editor.edited(Field.BODY, 2, "", "y", "Bxy")
            assertEquals("nor typed", "Bx", editor.body)
        }
        core.opened("T", "B")
        type(Field.BODY, "x")
        saveWith(SaveResult.Saved(3))
        assertFalse(core.dirty)
        assertEquals(3L, core.lastSavedVersion)
        type(Field.BODY, "y")
        saveWith(SaveResult.SavedToHolding(4))
        assertFalse(core.dirty)
        assertEquals(NoteEditorCore.Mode.HELD, core.mode)
        assertEquals(4L, core.lastSavedVersion)
    }

    @Test fun `typing during a save that joined held text is still saved there`() {
        core.opened("T", "B")
        type(Field.BODY, "x")
        val draft = checkNotNull(core.beginSave())
        type(Field.BODY, "y")
        core.finishSave(draft, SaveResult.SavedToHolding(7))
        assertEquals(NoteEditorCore.Mode.HELD, core.mode)
        val next = checkNotNull(core.beginSave())
        assertEquals("Bxy", next.body)
    }

    @Test fun `a draft says whether the title changed since it was loaded`() {
        core.opened("Plan", "Body")
        type(Field.BODY, "!")
        assertFalse("a body edit leaves the title as loaded", checkNotNull(core.beginSave()).titleChanged)
        type(Field.TITLE, "s")
        assertTrue(checkNotNull(core.beginSave()).titleChanged)
        saveWith(SaveResult.Saved(1))
        assertTrue(core.offerLoad("Plan (conflicted copy)", "Body!", observedSequence = 1))
        type(Field.BODY, "?")
        assertFalse("a load sets the title it compares with", checkNotNull(core.beginSave()).titleChanged)
    }

    // ---- the save run and a conflict copy ----

    /** A store as the editor's handle sees it: the note the handle names, and the answers it gives in turn. */
    private class Store(var target: String, vararg answers: () -> SaveOutcome) {
        val asked = ArrayList<String>()
        private val queue = ArrayDeque(answers.toList())

        fun attempt(): Pair<SaveOutcome, Boolean> {
            asked += target
            return queue.removeFirst()() to false
        }
    }

    @Test fun `a redirect saves again into the copy, once, and a save there that throws is retried into the copy`() {
        lateinit var store: Store
        store = Store("orig",
            { store.target = "copy"; SaveOutcome.Moved("copy") },
            { throw IOException("the write failed") },
            { SaveOutcome.Saved(9) })
        assertEquals(SaveResult.NotSaved, SaveRun.run(store::attempt))
        assertEquals(listOf("orig", "copy"), store.asked)
        assertEquals(SaveResult.Saved(9), SaveRun.run(store::attempt))
        assertEquals("the retry goes into the copy, never the original", listOf("orig", "copy", "copy"), store.asked)
    }

    @Test fun `a copy replaced again is followed, at most a bounded number of times`() {
        var n = 0
        val store = Store("orig", *Array(SaveRun.MAX_ATTEMPTS) { { n++; SaveOutcome.Moved("copy$n") } })
        assertEquals(SaveResult.NotSaved, SaveRun.run(store::attempt))
        assertEquals(SaveRun.MAX_ATTEMPTS, n)
    }

    @Test fun `every store answer is worded, and a discarded store is told apart`() {
        fun one(outcome: SaveOutcome) = SaveRun.run { outcome to true }
        assertEquals(SaveResult.Saved(1, metadataKept = true), one(SaveOutcome.Saved(1)))
        assertEquals(SaveResult.SavedToHolding(2), one(SaveOutcome.SavedToHolding(2)))
        assertEquals(SaveResult.HeldChanged, one(SaveOutcome.HeldChanged))
        assertEquals(SaveResult.Unreadable, one(SaveOutcome.Blocked))
        assertEquals(SaveResult.TooLarge, one(SaveOutcome.TooLarge))
        assertEquals(SaveResult.NotSaved, one(SaveOutcome.RemovalPending))
        assertEquals(SaveResult.Cleared, SaveRun.run { throw PendingNotesStore.Cleared() })
    }

    // ---- undo and redo in the editor ----

    @Test fun `an undo restores the text and leaves it to save, redo applies it again, and new typing drops redo`() {
        core.opened("T", "")
        type(Field.BODY, "hello")
        saveWith(SaveResult.Saved(1))
        val all = core.body
        core.edited(Field.BODY, 0, all, "", "")
        saveWith(SaveResult.Saved(2))
        val undone = checkNotNull(core.undo(Field.BODY))
        assertEquals("hello", undone.text)
        assertEquals("hello", core.body)
        assertTrue("an undo is an edit: the autosave writes it", core.dirty)
        assertEquals("", checkNotNull(core.redo(Field.BODY)).text)
        assertNotNull(core.undo(Field.BODY))
        type(Field.BODY, "!")
        assertFalse(core.history(Field.BODY).canRedo)
        assertTrue(core.history(Field.BODY).canUndo)
        assertFalse("the title has its own history", core.history(Field.TITLE).canUndo)
    }

    @Test fun `text the screen sets is no step, another version clears the history, and the same text keeps it`() {
        core.opened("T", "B")
        assertFalse("opening records nothing", core.history(Field.BODY).canUndo)
        type(Field.BODY, "x")
        saveWith(SaveResult.Saved(1))
        assertTrue(core.offerLoad("T", "Bx", observedSequence = 1))
        assertTrue("the same text keeps the history", core.history(Field.BODY).canUndo)
        assertTrue(core.offerLoad("T", "Server text", observedSequence = 2))
        assertFalse("another version clears it", core.history(Field.BODY).canUndo)
        assertFalse(core.history(Field.TITLE).canUndo)
        assertNull(core.undo(Field.BODY))
        assertFalse("a load is no edit", core.dirty)
    }

    // ---- when the editor and New note are offered ----

    private fun note(sync: NoteSync = NoteSync.SYNCED, writable: Boolean = true, unfinished: Boolean = false,
                     pending: PendingUnavailable? = null) =
        NoteContent("n", "T", "B", null, sync, pending = pending, writable = writable, discardUnfinished = unfinished)

    @Test fun `the editor opens only over text it can show and save, in a notebook that takes writes, with no discard unfinished`() {
        assertTrue(NoteEditing.offersEditor(note()))
        assertTrue(NoteEditing.offersEditor(note(NoteSync.WAITING)))
        assertFalse("held text", NoteEditing.offersEditor(note(NoteSync.HELD)))
        assertFalse("text that cannot be read", NoteEditing.offersEditor(note(NoteSync.LOCAL_UNREADABLE)))
        for (pending in PendingUnavailable.values()) assertFalse("$pending", NoteEditing.offersEditor(note(pending = pending)))
        assertFalse("a notebook that takes no writes", NoteEditing.offersEditor(note(writable = false)))
        assertFalse("a discard of the whole store unfinished", NoteEditing.offersEditor(note(unfinished = true)))

        assertTrue(NoteEditing.offersNewNote(NewNoteOffer(true, false, null)))
        assertFalse(NoteEditing.offersNewNote(NewNoteOffer(false, false, null)))
        assertFalse(NoteEditing.offersNewNote(NewNoteOffer(true, true, null)))
        assertFalse(NoteEditing.offersNewNote(NewNoteOffer(true, false, PendingUnavailable.DISCARD_STOPPED)))
        assertFalse(NoteEditing.offersNewNote(NewNoteOffer(true, false, PendingUnavailable.UNREADABLE)))

        assertEquals(NoteEditing.NoEditing.READ_ONLY, NoteEditing.noEditing(writable = false, discardUnfinished = true))
        assertEquals(NoteEditing.NoEditing.DISCARD_UNFINISHED, NoteEditing.noEditing(writable = true, discardUnfinished = true))
        assertNull(NoteEditing.noEditing(writable = true, discardUnfinished = false))
    }

    // ---- the status line ----

    @Test fun `the status line over every network setting, connection and account rule`() {
        val rules = listOf(
            NotesNetworkPolicy.AccountRule(false, null) to "no rule",
            NotesNetworkPolicy.AccountRule(true, null) to "Wi-Fi switch",
            NotesNetworkPolicy.AccountRule(true, "home") to "saved name",
        )
        for (automatic in Allowed.values()) for (syncNow in Allowed.values()) for (connection in Connection.values()) {
            for ((rule, ruleName) in rules) {
                val state = NotesNetworkState(NotesNetworkPolicy.Settings(automatic, syncNow), rule, NotesNetworkPolicy.Reading(connection))
                val case = "$automatic/$syncNow/$connection/$ruleName"
                val expected = when {
                    rule.networkName != null -> SyncLine.BLOCKED_FOR_ACCOUNT
                    (automatic == Allowed.WIFI_ONLY || rule.wifiOnly) && connection != Connection.WIFI ->
                        if (syncNow == Allowed.ANY_NETWORK || connection == Connection.WIFI) SyncLine.WAITING_FOR_WIFI_SYNC_NOW_SENDS
                        else SyncLine.WAITING_FOR_WIFI
                    else -> SyncLine.NONE
                }
                assertEquals(case, expected, NoteEditing.syncLine(Local.Waiting(failures = 0), state))
                val afterFailure = if (expected == SyncLine.NONE) SyncLine.LAST_TRY_FAILED else expected
                assertEquals("$case after a failed try", afterFailure, NoteEditing.syncLine(Local.Waiting(failures = 2), state))
                assertEquals(case, SyncLine.SYNCED, NoteEditing.syncLine(Local.None, state))
                assertEquals(case, SyncLine.NONE, NoteEditing.syncLine(Local.Other, state))
            }
        }
        assertEquals("the network could not be read", SyncLine.NONE, NoteEditing.syncLine(Local.Waiting(0), null))
        assertEquals(SyncLine.LAST_TRY_FAILED, NoteEditing.syncLine(Local.Waiting(1), null))
    }

    // ---- metadata ----

    private fun metaMap(vararg entries: Pair<String, (org.msgpack.core.MessagePacker) -> Unit>): ByteArray {
        val packer = MessagePack.newDefaultBufferPacker()
        packer.packMapHeader(entries.size)
        for ((key, value) in entries) {
            packer.packString(key)
            value(packer)
        }
        return packer.toByteArray()
    }

    private fun entry(key: String, value: (org.msgpack.core.MessagePacker) -> Unit): ByteArray {
        val packer = MessagePack.newDefaultBufferPacker()
        packer.packString(key)
        value(packer)
        return packer.toByteArray()
    }

    private fun ByteArray.contains(part: ByteArray): Boolean =
        (0..size - part.size).any { start -> part.indices.all { this[start + it] == part[it] } }

    @Test fun `a save over metadata another client wrote keeps every other field byte for byte`() {
        val description: (org.msgpack.core.MessagePacker) -> Unit = { it.packString("from the web") }
        val color: (org.msgpack.core.MessagePacker) -> Unit = { it.packString("#8ab4f8") }
        val extra: (org.msgpack.core.MessagePacker) -> Unit = { it.packArrayHeader(2); it.packInt(1); it.packBinaryHeader(1); it.writePayload(byteArrayOf(7)) }
        val raw = metaMap("name" to { p: org.msgpack.core.MessagePacker -> p.packString("Old") }, "description" to description, "mtime" to { p: org.msgpack.core.MessagePacker -> p.packLong(1) },
            "color" to color, "x-handrun" to extra)
        val merged = checkNotNull(NoteEditing.metadataToWrite(raw, "New title", 42))
        for ((key, value) in listOf("description" to description, "color" to color, "x-handrun" to extra)) {
            assertTrue("$key is kept byte for byte", merged.bytes.contains(entry(key, value)))
        }
        val peek = checkNotNull(NoteMetaCodec.peek(merged.bytes))
        assertEquals("New title", peek.name)
        assertEquals(42L, peek.mtime)
        assertArrayEquals("the same as the merge the push step's rebase uses",
            (NoteMetaCodec.merge(raw, "New title", 42) as NoteMetaCodec.Merge.Merged).bytes, merged.bytes)
    }

    @Test fun `metadata that cannot be merged is kept as it is, and only none at all gets a fresh map`() {
        assertNull("not one map", NoteEditing.metadataToWrite(byteArrayOf(0x91.toByte(), 0x01), "T", 1))
        val repeated = metaMap("name" to { p: org.msgpack.core.MessagePacker -> p.packString("a") }, "name" to { p: org.msgpack.core.MessagePacker -> p.packString("b") })
        assertNull("a repeated name", NoteEditing.metadataToWrite(repeated, "T", 1))
        for (empty in listOf(null, ByteArray(0))) {
            val fresh = checkNotNull(NoteEditing.metadataToWrite(empty, "T", 1))
            assertArrayEquals(NoteMetaCodec.fresh("T", 1).bytes, fresh.bytes)
        }
    }

    @Test fun `a new note with a blank title is made as Untitled, and an existing one keeps what is typed`() {
        assertEquals("Untitled", NoteEditing.nameToWrite("  ", newNote = true))
        assertEquals("  ", NoteEditing.nameToWrite("  ", newNote = false))
        assertEquals(" Plan ", NoteEditing.nameToWrite(" Plan ", newNote = true))
    }

    // ---- leaving the editor ----

    /** What leaving needs now, for this test's editor, shown as the editor unless [editor] is false. */
    private fun leave(editor: Boolean = true) = NoteEditing.leave(editor, core.dirty, core.mode, core.lastResult)

    @Test fun `leaving goes at once only while nothing on screen is unsaved, and asks after every save that did not write it`() {
        core.opened("Plan", "First")
        assertEquals("nothing typed", NoteEditing.Leave.GO, leave())
        type(Field.BODY, " draft")
        assertEquals("typed, and no save ran yet", NoteEditing.Leave.ASK_TRY_AGAIN, leave())
        saveWith(SaveResult.Saved(1))
        assertEquals("saved on this device", NoteEditing.Leave.GO, leave())

        // A failure may not happen again: Try again is offered. A refusal gets the same answer again: it is not.
        for ((result, expected) in listOf(
            SaveResult.NotSaved to NoteEditing.Leave.ASK_TRY_AGAIN,
            SaveResult.TooLarge to NoteEditing.Leave.ASK,
            SaveResult.Unreadable to NoteEditing.Leave.ASK,
        )) {
            type(Field.BODY, "!")
            saveWith(result)
            assertEquals("after $result", expected, leave())
            saveWith(SaveResult.Saved(2))
            assertEquals("saved after $result", NoteEditing.Leave.GO, leave())
        }

        // Typing during a save that wrote the text before it: the typing is not saved yet.
        type(Field.BODY, " more")
        val draft = checkNotNull(core.beginSave())
        type(Field.BODY, " during")
        core.finishSave(draft, SaveResult.Saved(3))
        assertEquals(NoteEditing.Leave.ASK_TRY_AGAIN, leave())
        saveWith(SaveResult.Saved(4))

        // Saved into held text: saved on this device, and the viewer takes over.
        type(Field.BODY, " held")
        saveWith(SaveResult.SavedToHolding(5))
        assertEquals(NoteEditing.Leave.GO, leave())
        assertEquals("the viewer shows: nothing on screen to save", NoteEditing.Leave.GO, leave(editor = false))
    }

    @Test fun `after a save that stops the editor, leaving asks without Try again`() {
        for (stop in listOf(SaveResult.HeldChanged, SaveResult.Cleared)) {
            core.opened("Plan", "First")
            type(Field.BODY, " typed")
            saveWith(stop)
            assertEquals(NoteEditorCore.Mode.STOPPED, core.mode)
            assertTrue("$stop keeps the text unsaved", core.dirty)
            assertEquals("after $stop", NoteEditing.Leave.ASK, leave())
        }
    }

    @Test fun `leaving without saving stops the editor, so no later save writes the text it said is lost`() {
        core.opened("Plan", "First")
        type(Field.BODY, " typed")
        saveWith(SaveResult.NotSaved)
        core.leaveWithoutSaving()
        assertNull("no save after it", core.beginSave())
        assertTrue("and the text is still not saved", core.dirty)
        assertEquals(NoteEditorCore.Mode.STOPPED, core.mode)
        type(Field.BODY, " after")
        assertEquals("no typing after it", "First typed", core.body)
        assertNull("no undo after it", core.undo(Field.BODY))
    }

    @Test fun `an answer to the question before leaving is taken only from this process, for the same note and text, while it is unsaved`() {
        fun holds(madeHere: Boolean = true, askedNote: String? = "n1", askedEdits: Long = 5, shownNote: String? = "n1",
                  note: String? = "n1", edits: Long = 5, unsaved: Boolean = true) =
            NoteEditing.leaveAnswerHolds(madeHere, askedNote, askedEdits, shownNote, note, edits, unsaved)
        assertTrue(holds())
        assertTrue("a new note no save made yet", holds(askedNote = null, shownNote = null, note = null))
        assertFalse("made in another app process", holds(madeHere = false))
        assertFalse("the text moved to a conflict copy since", holds(note = "copy"))
        assertFalse("a new note that a save made since", holds(askedNote = null, shownNote = null, note = "n1"))
        assertFalse("the dialog shows another note", holds(shownNote = "n2"))
        assertFalse("the text changed since", holds(edits = 6))
        assertFalse("the text was saved since", holds(unsaved = false))
    }

    @Test fun `the edit count moves with every change the user makes and with nothing else`() {
        core.opened("Plan", "First")
        val start = core.edits
        type(Field.BODY, "ab")
        assertEquals(start + 2, core.edits)
        saveWith(SaveResult.NotSaved)
        saveWith(SaveResult.Saved(1))
        assertEquals("saves move nothing", start + 2, core.edits)
        assertTrue(core.offerLoad("Plan", "Firstab", observedSequence = 1))
        assertEquals("a load moves nothing", start + 2, core.edits)
        checkNotNull(core.undo(Field.BODY))
        assertEquals("an undo is a change", start + 3, core.edits)
    }
}
