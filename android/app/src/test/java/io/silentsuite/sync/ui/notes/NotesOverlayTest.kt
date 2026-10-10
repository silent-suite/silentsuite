package io.silentsuite.sync.ui.notes

import io.silentsuite.sync.notes.edit.PendingEntry
import io.silentsuite.sync.notes.edit.PendingEntry.State
import io.silentsuite.sync.notes.edit.PendingNotesStore.EntryHeader
import io.silentsuite.sync.notes.edit.PendingNotesStore.Read
import io.silentsuite.sync.ui.notes.NotesOverlay.Decrypted
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotesOverlayTest {
    private val own = NotebookRow("own", "Own", "", null, readOnly = false, shared = false)
    private val team = NotebookRow("team", "Team", "Shared", null, readOnly = false, shared = true)
    private val readOnly = NotebookRow("ro", "Read only", "", null, readOnly = true, shared = true)

    private val older = NoteRow("a", "Alpha", "first line", 10)
    private val newer = NoteRow("b", "Bravo", "second", 20)
    private val cached = listOf(older, newer)

    private fun header(uid: String, state: State, notebook: String = "own", version: Long = 1) = EntryHeader(uid, notebook, state, version)

    /** A fake decryption: the texts it knows, and every uid it was asked for. */
    private class Fake(val texts: Map<String, Decrypted>) {
        val asked = mutableListOf<String>()
        fun decrypt(h: EntryHeader): Decrypted? = texts[h.noteUid].also { asked += h.noteUid }
    }

    private fun text(title: String, body: String, at: Long?) = Decrypted(title, NotesLoader.previewOf(body), null, at)

    private fun notebook(
        headers: List<EntryHeader>,
        texts: Map<String, Decrypted> = emptyMap(),
        row: NotebookRow = own,
        unreadableCached: Set<String> = emptySet(),
        unreadableEntries: Map<String, String?> = emptyMap(),
        fake: Fake = Fake(texts),
    ) = NotesOverlay.notebook(row, cached, unreadableCached, headers, unreadableEntries, fake::decrypt)

    // ---- one notebook ----

    @Test fun `without pending changes the cached rows show as they are`() {
        val result = notebook(emptyList())
        assertEquals(listOf(newer, older), result.notes)
        assertEquals(0, result.unreadable)
    }

    @Test fun `a pending edit replaces the server row and is marked`() {
        val result = notebook(listOf(header("a", State.UPSERT)), mapOf("a" to text("Alpha edited", "\n# New first line\nmore", 30)))
        assertEquals(listOf(NoteRow("a", "Alpha edited", "New first line", 30, NoteSync.WAITING), newer), result.notes)
    }

    @Test fun `a pending create adds a row`() {
        val result = notebook(listOf(header("c", State.UPSERT)), mapOf("c" to text("Charlie", "body", 5)))
        assertEquals(listOf("b", "a", "c"), result.notes.map { it.uid })
        assertEquals(NoteSync.WAITING, result.notes.last().sync)
    }

    @Test fun `a pending delete hides the row before the first render`() {
        assertEquals(listOf("a"), notebook(listOf(header("b", State.DELETE))).notes.map { it.uid })
        assertEquals(listOf("b", "a"), notebook(listOf(header("z", State.DELETE))).notes.map { it.uid })
    }

    @Test fun `held text leaves the server version in place and says where the text is`() {
        val result = notebook(listOf(header("a", State.HELD), header("x", State.HELD)))
        assertEquals(listOf(newer, older.copy(sync = NoteSync.HELD)), result.notes)
    }

    @Test fun `an edit that cannot be read keeps the server row with its own marker`() {
        val result = notebook(listOf(header("a", State.UPSERT)))
        assertEquals(older.copy(sync = NoteSync.LOCAL_UNREADABLE), result.notes.single { it.uid == "a" })
    }

    @Test fun `a create that cannot be read still gets a row`() {
        assertEquals(NoteRow("c", "", "", null, NoteSync.LOCAL_UNREADABLE), notebook(listOf(header("c", State.UPSERT))).notes.last())
    }

    @Test fun `a read-only notebook shows only the server version and never decrypts`() {
        val fake = Fake(mapOf("a" to text("Edited", "x", 30), "c" to text("New", "y", 40)))
        val result = notebook(
            listOf(header("a", State.UPSERT, "ro"), header("b", State.DELETE, "ro"), header("c", State.UPSERT, "ro")),
            row = readOnly, unreadableCached = setOf("u1"), fake = fake,
        )
        assertEquals(listOf(newer.copy(sync = NoteSync.HELD), older.copy(sync = NoteSync.HELD)), result.notes)
        assertEquals(1, result.unreadable)
        assertTrue(fake.asked.isEmpty())
    }

    @Test fun `only this notebook's changes are laid over it and only its edits are decrypted`() {
        val fake = Fake(mapOf("a" to text("Other notebook", "x", 99), "c" to text("Here", "y", 5)))
        val result = notebook(listOf(
            header("a", State.UPSERT, "team"),
            header("b", State.DELETE, "team"),
            header("c", State.UPSERT),
            header("d", State.DELETE),
            header("e", State.HELD),
        ), fake = fake)
        assertEquals(listOf(newer, older, NoteRow("c", "Here", "y", 5, NoteSync.WAITING)), result.notes)
        assertEquals(listOf("c"), fake.asked)
    }

    @Test fun `items that could not be decoded are counted unless a pending change covers them`() {
        val result = notebook(
            listOf(header("u1", State.UPSERT), header("u2", State.DELETE), header("u3", State.HELD)),
            mapOf("u1" to text("Fixed", "", 1)),
            unreadableCached = setOf("u1", "u2", "u3", "u4"),
        )
        // u1 shows through its edit and u2 is deleted locally; u3 is held, so its server copy is still unreadable, as is u4
        assertEquals(2, result.unreadable)
        assertTrue(result.notes.any { it.uid == "u1" && it.sync == NoteSync.WAITING })
    }

    @Test fun `a note whose entry file cannot be read is marked`() {
        val result = notebook(emptyList(), unreadableEntries = mapOf("a" to null, "not-here" to null))
        assertEquals(listOf(newer, older.copy(sync = NoteSync.LOCAL_UNREADABLE)), result.notes)
    }

    @Test fun `an entry whose header names this notebook but whose rest is damaged is never out of view`() {
        // A damaged create gets a placeholder, a damaged edit or delete marks the server row, and one
        // filed under another notebook, or with no readable header, adds nothing here.
        val result = notebook(emptyList(), unreadableEntries = mapOf("c" to "own", "b" to "own", "d" to "team", "e" to null))
        assertEquals(listOf(newer.copy(sync = NoteSync.LOCAL_UNREADABLE), older, NoteRow("c", "", "", null, NoteSync.LOCAL_UNREADABLE)), result.notes)
        assertEquals("a read-only notebook shows no placeholder; the list counts it as unsynced text", listOf("b", "a"),
            notebook(emptyList(), row = readOnly, unreadableEntries = mapOf("c" to "ro")).notes.map { it.uid })
    }

    // ---- the notebook list ----

    /** The notebooks as the loader reads them from the cached collections, without decoding them. */
    private val access = listOf(
        NotesOverlay.NotebookAccess("own", deleted = false, readOnly = false),
        NotesOverlay.NotebookAccess("team", deleted = false, readOnly = false),
        NotesOverlay.NotebookAccess("ro", deleted = false, readOnly = true),
    )

    @Test fun `waiting changes are counted per writable notebook`() {
        val overview = NotesOverlay.notebooks(listOf(own, team, readOnly), access,
            listOf(header("n1", State.UPSERT), header("n2", State.DELETE), header("n3", State.UPSERT, "team")), emptyMap())
        assertEquals(listOf(2, 1, 0), overview.notebooks.map { it.waiting })
        assertEquals(0, overview.unsyncedText)
    }

    @Test fun `held text, changes in read-only, deleted or missing notebooks, and unreadable files count as unsynced text`() {
        // "team" still has a row from the cache, but the collection is now marked deleted.
        val overview = NotesOverlay.notebooks(listOf(own, team, readOnly),
            access.map { if (it.uid == "team") it.copy(deleted = true) else it }, listOf(
                header("n1", State.HELD),
                header("n2", State.UPSERT, "ro"),
                header("n3", State.UPSERT, "gone"),
                header("n4", State.DELETE, "gone"),
                header("n5", State.UPSERT),
                header("n6", State.UPSERT, "team"),
            ), unreadableEntries = mapOf("x" to null, "y" to "own"))
        assertEquals(listOf(1, 0, 0), overview.notebooks.map { it.waiting })
        assertEquals(7, overview.unsyncedText)
    }

    @Test fun `a change in a notebook this client cannot show counts as unsynced text, the one place that shows it`() {
        // "hidden" accepts writes, so the runner will push to it, but it has no row: its metadata cannot
        // be decoded here. Counted nowhere, the change would be out of view.
        val overview = NotesOverlay.notebooks(listOf(own), access + NotesOverlay.NotebookAccess("hidden", false, false),
            listOf(header("n1", State.UPSERT, "hidden"), header("n2", State.HELD, "hidden"), header("n3", State.UPSERT)), emptyMap())
        assertEquals(listOf(1), overview.notebooks.map { it.waiting })
        assertEquals(2, overview.unsyncedText)
    }

    @Test fun `every change is in exactly one place`() {
        val headers = listOf(header("n1", State.UPSERT), header("n2", State.HELD), header("n3", State.UPSERT, "ro"),
            header("n4", State.DELETE, "team"), header("n5", State.UPSERT, "hidden"), header("n6", State.UPSERT, "gone"))
        val unreadable = mapOf("x" to null)
        val overview = NotesOverlay.notebooks(listOf(own, team, readOnly), access + NotesOverlay.NotebookAccess("hidden", false, false), headers, unreadable)
        assertEquals(headers.size + unreadable.size, overview.notebooks.sumOf { it.waiting } + overview.unsyncedText)
    }

    @Test fun `unsynced text still counts when no notebook is left or the list could not be read`() {
        assertEquals(NotebookOverview(emptyList(), 1),
            NotesOverlay.notebooks(emptyList(), emptyList(), listOf(header("n", State.UPSERT, "gone")), emptyMap()))
        assertEquals(NotebookOverview(emptyList(), 2, failed = true),
            NotesOverlay.notebooks(emptyList(), emptyList(), listOf(header("n", State.UPSERT)), mapOf("x" to null), failed = true))
    }

    @Test fun `after a failed load the rows on screen stay without counts, since every change is unsynced text then`() {
        val shown = listOf(own.copy(waiting = 2), team.copy(waiting = 1))
        val failed = NotesOverlay.notebooks(emptyList(), emptyList(),
            listOf(header("n1", State.UPSERT), header("n2", State.UPSERT), header("n3", State.UPSERT, "team")), emptyMap(), failed = true)
        assertEquals(NotebookOverview(listOf(own, team), 3, failed = true), NotesOverlay.keptAfterFailure(shown, failed))
    }

    @Test fun `an unreadable entry file counts once by uid, keeps its notebook when known, and not when its entry reads fine`() {
        val unreadable = listOf("x.note", "x.note.new", "y.note.new", "z.note", "b1.notebook", "n1.landed", "sequence.new")
            .map { Read.Unreadable(it, "bad") } + Read.Unreadable("w.note", "bad", notebookUid = "own")
        assertEquals(mapOf("x" to null, "y" to null, "w" to "own"),
            NotesOverlay.unreadableEntries(unreadable, listOf(header("z", State.UPSERT))))
    }

    // ---- the viewer ----

    private val server = NoteContent("a", "Alpha", "server text", 10)

    private fun entry(state: State, version: Long, notebook: String = "own", held: PendingEntry.Held? = null) =
        PendingEntry("a", notebook, state, version, "r$version", isCreate = false, held = held, blob = ByteArray(0))

    private val heldReason = PendingEntry.Held(io.silentsuite.sync.notes.edit.HeldReason.REJECTED, 1)

    private fun note(cached: NoteContent?, read: Read, writable: Boolean = true, sequence: Long = 12, body: Decrypted? = null) =
        NotesOverlay.note("a", "own", cached, read, sequence, writable) { body }

    @Test fun `the viewer shows the pending text with its version and the sequence it saw`() {
        assertEquals(NoteContent("a", "Alpha edited", "local text", 30, NoteSync.WAITING, 7, 12),
            note(server, Read.Present(entry(State.UPSERT, 7)), body = Decrypted("Alpha edited", "local text", "local text", 30)))
        // a local create has no server copy
        assertEquals(NoteContent("a", "New", "text", 5, NoteSync.WAITING, 3, 12),
            note(null, Read.Present(entry(State.UPSERT, 3)), body = Decrypted("New", "text", "text", 5)))
    }

    @Test fun `a pending edit shows even when the server copy cannot be decoded`() {
        // the loader passes null for a server copy it cannot decode, as the list leaves it out
        assertEquals("local text", note(null, Read.Present(entry(State.UPSERT, 4)), body = Decrypted("T", "local text", "local text", 1))?.body)
    }

    @Test fun `with nothing pending the server version shows and still carries the sequence`() {
        assertEquals(server.copy(observedSequence = 12), note(server, Read.Missing))
        assertNull(note(null, Read.Missing))
    }

    @Test fun `held text and a read-only or deleted notebook show the server version marked, with the entry version`() {
        assertEquals(server.copy(sync = NoteSync.HELD, pendingVersion = 4, observedSequence = 12),
            note(server, Read.Present(entry(State.HELD, 4, held = heldReason))))
        assertEquals(server.copy(sync = NoteSync.HELD, pendingVersion = 5, observedSequence = 12),
            note(server, Read.Present(entry(State.UPSERT, 5)), writable = false, body = Decrypted("x", "x", "x", 1)))
        // held text of a create that never reached the server
        assertEquals(NoteContent("a", "", "", null, NoteSync.HELD, 6, 12), note(null, Read.Present(entry(State.HELD, 6, held = heldReason))))
    }

    @Test fun `a note deleted locally is not shown`() {
        assertNull(note(server, Read.Present(entry(State.DELETE, 5))))
    }

    @Test fun `an unreadable edit shows the server version marked, and an unreadable create shows a marked placeholder`() {
        assertEquals(server.copy(sync = NoteSync.LOCAL_UNREADABLE, pendingVersion = 6, observedSequence = 12),
            note(server, Read.Present(entry(State.UPSERT, 6))))
        assertEquals(NoteContent("a", "", "", null, NoteSync.LOCAL_UNREADABLE, 6, 12), note(null, Read.Present(entry(State.UPSERT, 6))))
    }

    @Test fun `an entry file that cannot be read marks the note`() {
        assertEquals(server.copy(sync = NoteSync.LOCAL_UNREADABLE, observedSequence = 12), note(server, Read.Unreadable("a.note", "bad")))
    }

    @Test fun `an entry filed under another notebook is not laid over this one`() {
        assertEquals(server.copy(observedSequence = 12), note(server, Read.Present(entry(State.UPSERT, 8, notebook = "team")),
            body = Decrypted("x", "x", "x", 1)))
    }
}
