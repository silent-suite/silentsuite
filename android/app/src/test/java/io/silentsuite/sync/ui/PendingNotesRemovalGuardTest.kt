package io.silentsuite.sync.ui

import io.silentsuite.sync.notes.edit.NotesFolderListings.Folder
import io.silentsuite.sync.notes.edit.PendingNotesDiscardPermits
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.Companion.StoreFolders
import io.silentsuite.sync.notes.edit.PendingNotesStore.DiscardOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.RemovalCheck
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendOutcome
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Cause
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.CreationId
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Decision
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Input
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Row
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import io.silentsuite.sync.ui.setup.AccountCreationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption

/**
 * The removal guard's decision, one test per row of its table (the first row that matches wins), and the readings it
 * decides from: fake stores for the table, and real stores in a temporary no_backup folder for the stores it finds by
 * path and for a permit folder that cannot be read.
 */
class PendingNotesRemovalGuardTest {
    @get:Rule val tmp = TemporaryFolder()

    @After fun reset() {
        PendingNotesStore.listFilesForTesting = null
        PendingNotesStore.presenceForTesting = null
        PendingNotesStore.identityForTesting = null
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesDiscardPermits.beforeRecordForTesting = null
        PendingNotesDiscardPermits.beforeDeleteForTesting = null
        PendingNotesDiscardPermits.onReadForTesting = null
        PendingNotesStore.resetForTesting()
    }

    // ---- fake stores for the table ----

    private val draft = UnsyncedNotes(1, 1, false, names = setOf("n1.note"))

    /** What each fake store answers, by folder; a folder not here is clean. */
    private val answers = HashMap<String, () -> RemovalCheck>()

    /** Every reading the guard asked for, in order. */
    private val asked = ArrayList<String>()

    private fun answer(folder: String, check: RemovalCheck) {
        answers[folder] = { check }
    }

    /** A fake store folder of an exact identity. */
    private fun folder(name: String, id: String) = "$name@$id"

    private val unlistable: () -> StoreFolders = { throw IOException("could not list the pending stores") }

    private fun listed(vararg stores: String, unknown: Boolean = false): () -> StoreFolders =
        { StoreFolders(stores.toList(), if (unknown) listOf("future.dat") else emptyList()) }

    /**
     * By default a row "b" without a creation id, alone on the device, with both folders listed and empty, and every
     * store folder that a listing of notes-pending leaves out shown absent by its presence check.
     */
    private fun input(
        name: String? = "b",
        id: CreationId = CreationId.Unreadable,
        type: String? = TYPE,
        accounts: () -> List<Row>? = { listOf(Row("b", CreationId.Unreadable)) },
        pending: () -> StoreFolders = listed(),
        discard: () -> Set<String>? = { emptySet() },
        known: () -> Set<String> = { emptySet() },
        presence: (String) -> PendingNotesStore.Presence = { PendingNotesStore.Presence.ABSENT },
    ) = Input(TYPE, type, name, id,
        accounts = { asked += "accounts"; accounts() },
        pending = { asked += "pending"; pending() },
        discard = { asked += "discard"; discard() },
        known = { asked += "known"; known() },
        presence = { folder -> asked += "presence $folder"; presence(folder) },
        folderOf = ::folder,
        check = { folder -> asked += "check $folder"; (answers[folder] ?: { RemovalCheck.Clean })() })

    /** The row "a", whose creation id reads. */
    private fun own(discard: () -> Set<String>? = { emptySet() }) =
        input(name = "a", id = CreationId.Readable("gen-a"), discard = discard)

    private val a = folder("a", "gen-a")

    private fun decide(input: Input) = PendingNotesRemovalGuard.decide(input)

    /** The verdict the maintainer's yes for names of an unknown kind in notes-pending would give. */
    private fun yes(input: Input) = PendingNotesRemovalGuard.decision(input, Verdict.UNKNOWN_KIND_ONLY).verdict

    // ---- the table ----

    @Test fun `row 1, no target, another type, or a reading that throws outside the store checks, refuses as failed`() {
        assertEquals(Verdict.REFUSE_FAILED, decide(input(name = null)))
        assertEquals(Verdict.REFUSE_FAILED, decide(input(type = null)))
        assertEquals(Verdict.REFUSE_FAILED, decide(input(type = "io.silentsuite.address_book")))
        assertEquals("nothing is read for those", emptyList<String>(), asked)
        val thrown = { throw SecurityException("denied") }
        for (failing in listOf(input(accounts = thrown), input(pending = thrown), input(discard = thrown),
                input(known = thrown), own(discard = thrown).also { answer(a, RemovalCheck.NothingUnwithdrawn) })) {
            assertEquals(Verdict.REFUSE_FAILED, decide(failing))
        }
    }

    @Test fun `row 2, a store check that throws refuses as failed, after one reopen of a dropped instance`() {
        answers["orphan"] = { throw IOException("canonicalPath failed") }
        assertEquals(Verdict.REFUSE_FAILED, decide(input(pending = listed("orphan"))))
        answers[a] = { throw SecurityException("denied") }
        assertEquals(Verdict.REFUSE_FAILED, decide(own()))
        // Before the rows after it: a name of an unknown kind beside it.
        assertEquals(Verdict.REFUSE_FAILED, decide(input(pending = listed("orphan", unknown = true))))

        // A dropped instance is asked once more, as a new open of the folder; a second throw refuses.
        var tries = 0
        answers["orphan"] = {
            if (tries++ == 0) throw IllegalStateException("the pending store was dropped")
            RemovalCheck.Clean
        }
        assertEquals(Verdict.ALLOW, decide(input(pending = listed("orphan"))))
        assertEquals(2, tries)
        tries = 0
        answers["orphan"] = { tries++; throw IllegalStateException("the pending store was dropped") }
        assertEquals(Verdict.REFUSE_FAILED, decide(input(pending = listed("orphan"))))
        assertEquals("once more only", 2, tries)
    }

    @Test fun `row 3, an acknowledgement that could not be withdrawn while notes-discard lists refuses as failed`() {
        answer(a, RemovalCheck.NothingUnwithdrawn)
        assertEquals(Verdict.REFUSE_FAILED, decide(own()))
        answer("orphan", RemovalCheck.NothingUnwithdrawn)
        assertEquals(Verdict.REFUSE_FAILED, decide(input(pending = listed("orphan"))))
        assertEquals(Verdict.REFUSE_FAILED, decide(input(pending = unlistable, known = { setOf("orphan") })))
    }

    @Test fun `row 4, a store holding text or there unlisted refuses, and one absent while notes-pending lists`() {
        for (blocking in listOf(RemovalCheck.Blocks(draft), RemovalCheck.Unlisted)) {
            answers.clear()
            answer(a, blocking)
            assertEquals("$blocking", Verdict.REFUSE_STORE, decide(own()))
            answer("orphan", blocking)
            assertEquals("$blocking", Verdict.REFUSE_STORE, decide(input(pending = listed("orphan"))))
            assertEquals("$blocking", Verdict.REFUSE_STORE,
                decide(input(pending = unlistable, known = { setOf("orphan") })))
            assertEquals("before the account list", Verdict.REFUSE_STORE,
                decide(input(accounts = { null }, pending = listed("orphan"))))
            // And before a name of an unknown kind beside it, so that store's own way out is the one shown.
            assertEquals("$blocking", Verdict.REFUSE_STORE, decide(input(pending = listed("orphan", unknown = true))))
        }
        answers.clear()
        answer("orphan", RemovalCheck.UnlistedAbsent)
        assertEquals("absent by its own check alone while notes-pending lists: a race", Verdict.REFUSE_STORE,
            decide(input(pending = listed("orphan"))))
    }

    @Test fun `row 5, a listing of notes-pending that leaves out a folder known by path refuses a row without an id`() {
        val short = PendingNotesRemovalGuard.PENDING_LISTED_SHORT
        assertEquals("refused until the maintainer decides", Verdict.REFUSE_UNREADABLE, short)
        assertFalse(short.eligible)
        val there: (String) -> PendingNotesStore.Presence = { PendingNotesStore.Presence.PRESENT }
        // A folder from each source that the listing left out and that is there: a record in notes-discard, a known
        // path, and another row's own.
        val rows = { listOf(Row("b", CreationId.Unreadable), Row("c", CreationId.Readable("gen-c"))) }
        assertEquals("notes-discard", short,
            decide(input(pending = listed("orphan"), discard = { setOf("missing") }, presence = there)))
        assertEquals("known", short,
            decide(input(pending = listed("orphan"), known = { setOf("missing") }, presence = there)))
        assertEquals("another row's own", short,
            decide(input(accounts = rows, pending = listed("orphan"), presence = there)))
        // A check that fails is no absence; a folder shown absent, as one never made, allows.
        assertEquals("unknown", short, decide(input(pending = listed("orphan"), known = { setOf("missing") },
            presence = { PendingNotesStore.Presence.UNKNOWN })))
        assertEquals(Verdict.ALLOW, decide(input(pending = listed("orphan"), known = { setOf("missing") })))
        assertEquals(Verdict.ALLOW, decide(input(accounts = rows, pending = listed("orphan"))))
        // What the listing held is still checked, and a store that refuses on its own comes first (row 4).
        answer("orphan", RemovalCheck.Blocks(draft))
        assertEquals(Verdict.REFUSE_STORE,
            decide(input(pending = listed("orphan"), known = { setOf("missing") }, presence = there)))
        // So do a store that could not withdraw its acknowledgement while notes-discard lists (row 3), and one absent by
        // lstat alone while notes-pending lists (row 4).
        answer("orphan", RemovalCheck.NothingUnwithdrawn)
        assertEquals("row 3 first", Verdict.REFUSE_FAILED,
            decide(input(pending = listed("orphan"), known = { setOf("missing") }, presence = there)))
        answer("orphan", RemovalCheck.UnlistedAbsent)
        assertEquals("row 4 first", Verdict.REFUSE_STORE,
            decide(input(pending = listed("orphan"), known = { setOf("missing") }, presence = there)))
        answers.clear()
        // Before the rows after it: the account list unread, notes-discard unlistable beside a store that could not
        // withdraw, and names of an unknown kind with the maintainer's yes.
        assertEquals("not REFUSE_ACCOUNTS", short, decide(input(accounts = { null }, pending = listed("orphan"),
            known = { setOf("missing") }, presence = there)))
        answer("orphan", RemovalCheck.NothingUnwithdrawn)
        assertEquals("not PERMITS_UNLISTABLE_ONLY", short, decide(input(pending = listed("orphan"), discard = { null },
            known = { setOf("missing") }, presence = there)))
        answers.clear()
        assertEquals("not UNKNOWN_KIND_ONLY", short, yes(input(pending = listed("orphan", unknown = true),
            known = { setOf("missing") }, presence = there)))
        // Each folder read comes first, then the presence check of the names the listing left out, and only then the
        // first store check.
        asked.clear()
        decide(input(pending = listed("orphan"), known = { setOf("missing") }))
        assertEquals(listOf("accounts", "pending", "discard", "known", "presence missing", "check missing",
            "check orphan"), asked)
    }

    @Test fun `row 6, with the account list unreadable, a row without a creation id is refused unless all is clean`() {
        assertEquals(Verdict.ALLOW, decide(input(accounts = { null }, pending = listed("orphan"))))
        answer("orphan", RemovalCheck.Covered)
        assertEquals("ownership cannot change that answer", Verdict.ALLOW,
            decide(input(accounts = { null }, pending = listed("orphan"))))
        // Never one of the verdicts an allowance is offered for.
        answer("orphan", RemovalCheck.Clean)
        assertEquals(Verdict.REFUSE_ACCOUNTS, decide(input(accounts = { null }, pending = unlistable,
            known = { setOf("orphan") })))
        answer("orphan", RemovalCheck.NothingUnwithdrawn)
        assertEquals(Verdict.REFUSE_ACCOUNTS, decide(input(accounts = { null }, pending = listed("orphan"),
            discard = { null })))
        assertEquals("with the list it would be", Verdict.PERMITS_UNLISTABLE_ONLY,
            decide(input(pending = listed("orphan"), discard = { null })))
        // A live account's store is unowned without the list.
        answers.clear()
        val c = folder("c", "gen-c")
        answer(c, RemovalCheck.NothingUnwithdrawn)
        answer("orphan", RemovalCheck.Covered)
        assertEquals(Verdict.REFUSE_ACCOUNTS, decide(input(accounts = { null }, pending = listed(c, "orphan"),
            discard = { null })))
        // Nor with a name of an unknown kind beside clean stores, whatever the maintainer decides for such names.
        answers.clear()
        val unknown = input(accounts = { null }, pending = listed("orphan", unknown = true))
        assertEquals(Verdict.REFUSE_ACCOUNTS, decide(unknown))
        assertEquals(Verdict.REFUSE_ACCOUNTS, yes(unknown))
    }

    @Test fun `row 7, a name of an unknown kind in notes-pending refuses a row without a creation id for now`() {
        assertEquals("refused until the maintainer decides", Verdict.REFUSE_UNKNOWN_KIND,
            PendingNotesRemovalGuard.UNKNOWN_KIND_IN_PENDING)
        answer("covered", RemovalCheck.Covered)
        answer("acknowledged", RemovalCheck.Acknowledged)
        assertEquals(Verdict.REFUSE_UNKNOWN_KIND, decide(input(pending = listed(unknown = true))))
        assertEquals(Verdict.REFUSE_UNKNOWN_KIND,
            decide(input(pending = listed("clean", "covered", "acknowledged", unknown = true))))
        asked.clear()
        assertEquals(Verdict.ALLOW,
            decide(input(name = "a", id = CreationId.Readable("gen-a"), pending = listed(unknown = true))))
        assertEquals("a row with a creation id lists no notes-pending", listOf("check $a"), asked)
    }

    @Test fun `row 7, with a yes, names of an unknown kind alone are eligible, only while notes-discard lists`() {
        answer("covered", RemovalCheck.Covered)
        answer("acknowledged", RemovalCheck.Acknowledged)
        // Beside clean, covered and acknowledged stores, or none, with notes-discard listed or shown gone.
        for (discard in listOf(setOf("covered"), emptySet())) {
            assertEquals("$discard", Verdict.UNKNOWN_KIND_ONLY,
                yes(input(pending = listed("clean", "covered", "acknowledged", unknown = true), discard = { discard })))
        }
        assertEquals(Verdict.UNKNOWN_KIND_ONLY, yes(input(pending = listed(unknown = true))))
        assertEquals(setOf(Cause.PENDING_UNKNOWN_KIND), Verdict.UNKNOWN_KIND_ONLY.reason)
        // Not while notes-discard cannot be listed: a covered or acknowledged store would rest on a read inside it,
        // and one that could not withdraw is held with that folder.
        for (beside in listOf(RemovalCheck.Clean, RemovalCheck.Covered, RemovalCheck.Acknowledged,
                RemovalCheck.NothingUnwithdrawn)) {
            answer("other", beside)
            assertEquals("$beside", Verdict.REFUSE_UNKNOWN_KIND,
                yes(input(pending = listed("other", unknown = true), discard = { null })))
        }
        // Never beside a store that needs its own way out (row 4), one that failed to withdraw while notes-discard
        // lists (row 3), or with the account list unread (row 6), and never for a row whose creation id reads.
        for (blocking in listOf(RemovalCheck.Blocks(draft), RemovalCheck.Unlisted, RemovalCheck.UnlistedAbsent)) {
            answer("other", blocking)
            assertEquals("$blocking", Verdict.REFUSE_STORE, yes(input(pending = listed("other", unknown = true))))
        }
        answer("other", RemovalCheck.NothingUnwithdrawn)
        assertEquals(Verdict.REFUSE_FAILED, yes(input(pending = listed("other", unknown = true))))
        answers.clear()
        assertEquals(Verdict.REFUSE_ACCOUNTS, yes(input(accounts = { null }, pending = listed(unknown = true))))
        assertEquals(Verdict.ALLOW,
            yes(input(name = "a", id = CreationId.Readable("gen-a"), pending = listed(unknown = true))))
        // Without such a name, the yes changes nothing.
        assertEquals(Verdict.ALLOW, yes(input(pending = listed("clean"))))
        assertEquals(Verdict.ROOT_UNLISTABLE_ONLY, yes(input(pending = unlistable)))
    }

    @Test fun `a refusal while the account list cannot be read carries nothing over to the next attempt`() {
        val c = folder("c", "gen-c")
        answer(c, RemovalCheck.NothingUnwithdrawn)
        answer("orphan", RemovalCheck.Covered)
        // Two failures at once: the list read, and notes-discard unlistable while c's acknowledgement stays.
        assertEquals(Verdict.REFUSE_ACCOUNTS, decide(input(accounts = { null }, pending = listed(c, "orphan"),
            discard = { null })))
        // The retry reads everything again, and the list now names c as a live account: c's store is c's own, and
        // the orphan's permit covers it.
        val rows = { listOf(Row("b", CreationId.Unreadable), Row("c", CreationId.Readable("gen-c"))) }
        asked.clear()
        assertEquals(Verdict.ALLOW, decide(input(accounts = rows, pending = listed(c, "orphan"), discard = { null })))
        assertEquals("every reading again, and c's store is not even checked",
            listOf("accounts", "pending", "discard", "known", "check orphan"), asked)
    }

    @Test fun `row 8, an account's own folder absent by lstat while it cannot be listed allows that removal alone`() {
        answer(a, RemovalCheck.UnlistedAbsent)
        assertEquals(Verdict.ALLOW, decide(own()))
        assertEquals("its own store alone: no account list, notes-pending, notes-discard or store found by path",
            listOf("check $a"), asked)
        assertFalse("no allowance is offered for it", Verdict.ALLOW.eligible)
        // Decided for each removal: the store's next answer decides the next one.
        answer(a, RemovalCheck.Unlisted)
        assertEquals(Verdict.REFUSE_STORE, decide(own()))
        assertEquals(listOf("check $a", "check $a"), asked)
        // Any other answer keeps its own row.
        answer(a, RemovalCheck.Blocks(draft))
        assertEquals(Verdict.REFUSE_STORE, decide(own()))
        answers[a] = { throw IOException("lstat failed") }
        assertEquals(Verdict.REFUSE_FAILED, decide(own()))
        answer(a, RemovalCheck.NothingUnwithdrawn)
        assertEquals(Verdict.REFUSE_FAILED, decide(own()))
        // For a row without a readable id, an absent store keeps the rows it had: a race while notes-pending lists,
        // and the root's allowance while it cannot be listed.
        answer("orphan", RemovalCheck.UnlistedAbsent)
        assertEquals(Verdict.REFUSE_STORE, decide(input(pending = listed("orphan"))))
        assertEquals(Verdict.ROOT_UNLISTABLE_ONLY, decide(input(pending = unlistable, known = { setOf("orphan") })))
    }

    @Test fun `row 9, only notes-pending unreadable, every store clean, covered, acknowledged or absent`() {
        answer("acknowledged", RemovalCheck.Acknowledged)
        answer("covered", RemovalCheck.Covered)
        answer("absent", RemovalCheck.UnlistedAbsent)
        val found = { setOf("clean", "acknowledged", "covered", "absent") }
        assertEquals(Verdict.ROOT_UNLISTABLE_ONLY, decide(input(pending = unlistable, known = found)))
        assertEquals("with no store found at all", Verdict.ROOT_UNLISTABLE_ONLY, decide(input(pending = unlistable)))
        assertEquals(setOf(Cause.PENDING_UNLISTED), Verdict.ROOT_UNLISTABLE_ONLY.reason)
        // Not with one that is there and cannot be listed (row 4), nor with one that could not withdraw (row 3).
        answer("absent", RemovalCheck.Unlisted)
        assertEquals(Verdict.REFUSE_STORE, decide(input(pending = unlistable, known = found)))
        answer("absent", RemovalCheck.NothingUnwithdrawn)
        assertEquals(Verdict.REFUSE_FAILED, decide(input(pending = unlistable, known = found)))
    }

    @Test fun `row 10, only notes-discard unreadable, every store clean and at least one unwithdrawn`() {
        assertEquals("refused for a row whose id reads, until the maintainer decides", Verdict.REFUSE_UNREADABLE,
            PendingNotesRemovalGuard.READABLE_ID_UNDER_UNLISTED_PERMITS)
        answer(a, RemovalCheck.NothingUnwithdrawn)
        assertEquals(PendingNotesRemovalGuard.READABLE_ID_UNDER_UNLISTED_PERMITS, decide(own(discard = { null })))
        assertEquals(setOf(Cause.DISCARD_UNLISTED), Verdict.PERMITS_UNLISTABLE_ONLY.reason)
        answer("orphan", RemovalCheck.NothingUnwithdrawn)
        assertEquals(Verdict.PERMITS_UNLISTABLE_ONLY, decide(input(pending = listed("orphan", "clean"),
            discard = { null })))
        // Only while notes-discard cannot be listed: listed, or shown gone, it is a withdrawal that failed (row 3).
        assertEquals(Verdict.REFUSE_FAILED, decide(input(pending = listed("orphan"), discard = { emptySet() })))
        // With nothing unwithdrawn, it allows.
        answers.clear()
        assertEquals(Verdict.ALLOW, decide(input(pending = listed("clean"), discard = { null })))
    }

    @Test fun `row 11, both folders unreadable, every store clean, unwithdrawn or absent, gives one allowance`() {
        answer("orphan", RemovalCheck.NothingUnwithdrawn)
        answer("absent", RemovalCheck.UnlistedAbsent)
        answer("covered", RemovalCheck.Covered)
        fun both(vararg found: String) =
            decide(input(pending = unlistable, discard = { null }, known = { found.toSet() }))
        assertEquals(Verdict.BOTH_UNLISTABLE_ONLY, both("orphan", "absent", "clean"))
        assertEquals(setOf(Cause.PENDING_UNLISTED, Cause.DISCARD_UNLISTED), Verdict.BOTH_UNLISTABLE_ONLY.reason)
        // Never one of the single-folder verdicts, which bind one folder only: not with no store found, nor with only
        // stores absent by lstat (row 9 needs notes-discard), nor with only clean and unwithdrawn ones (row 10 needs
        // notes-pending).
        assertEquals("no store found", Verdict.BOTH_UNLISTABLE_ONLY, both())
        assertEquals("only absent ones", Verdict.BOTH_UNLISTABLE_ONLY, both("absent"))
        assertEquals("clean and unwithdrawn", Verdict.BOTH_UNLISTABLE_ONLY, both("orphan", "clean"))
        // Not with a store that only its permit covers, which would rest on a permit read (row 13), nor with the
        // account list unread (row 6), nor with a store holding text or there unlisted (row 4).
        assertEquals("a covered one, by row 13", Verdict.REFUSE_UNREADABLE, both("covered", "clean"))
        assertEquals(Verdict.REFUSE_ACCOUNTS, decide(input(accounts = { null }, pending = unlistable,
            discard = { null }, known = { setOf("orphan", "absent") })))
        answer("held", RemovalCheck.Blocks(draft))
        answer("there", RemovalCheck.Unlisted)
        assertEquals(Verdict.REFUSE_STORE, both("orphan", "held"))
        assertEquals(Verdict.REFUSE_STORE, both("absent", "there"))
    }

    @Test fun `row 12, every store clean, covered or acknowledged allows`() {
        for (fine in listOf(RemovalCheck.Clean, RemovalCheck.Covered, RemovalCheck.Acknowledged)) {
            answer(a, fine)
            assertEquals("$fine", Verdict.ALLOW, decide(own()))
            answer("orphan", fine)
            assertEquals("$fine", Verdict.ALLOW, decide(input(pending = listed("orphan", "clean"))))
        }
        assertEquals("with no store at all", Verdict.ALLOW, decide(input()))
        assertNull(Verdict.ALLOW.reason)
    }

    @Test fun `row 13, an unwithdrawn store beside a covered or acknowledged one refuses as unreadable`() {
        answer("orphan", RemovalCheck.NothingUnwithdrawn)
        for (beside in listOf(RemovalCheck.Covered, RemovalCheck.Acknowledged)) {
            answer("other", beside)
            assertEquals("$beside", Verdict.REFUSE_UNREADABLE, decide(input(pending = listed("orphan", "other"),
                discard = { null })))
        }
    }

    @Test fun `the three unreadable-folder verdicts and the unknown-kind one are eligible, each with its reason`() {
        val eligible = listOf(Verdict.ROOT_UNLISTABLE_ONLY, Verdict.PERMITS_UNLISTABLE_ONLY,
            Verdict.BOTH_UNLISTABLE_ONLY, Verdict.UNKNOWN_KIND_ONLY)
        assertEquals(eligible, Verdict.entries.filter { it.eligible })
        assertTrue(Verdict.entries.filterNot { it.eligible }.all { it.reason == null })
        // Only a folder that cannot be listed counts as unlisted; names of an unknown kind are in a folder that lists.
        assertEquals(listOf(Cause.PENDING_UNLISTED, Cause.DISCARD_UNLISTED), Cause.entries.filter { it.unlisted })
        assertEquals(listOf(Folder.PENDING, Folder.DISCARD, Folder.PENDING), Cause.entries.map { it.folder })
    }

    // ---- whose stores count ----

    @Test fun `a row with a creation id is decided by its own store alone, and reads no list`() {
        answer("orphan", RemovalCheck.Blocks(draft))
        answer(folder("c", "gen-c"), RemovalCheck.Blocks(draft))
        assertEquals(Verdict.ALLOW, decide(input(name = "a", id = CreationId.Readable("gen-a"),
            pending = listed("orphan", folder("c", "gen-c")), known = { setOf("orphan") })))
        assertEquals("no account list, no notes-pending, no store found by path", listOf("check $a"), asked)
        asked.clear()
        answer(a, RemovalCheck.NothingUnwithdrawn)
        decide(own(discard = { null }))
        assertEquals("notes-discard only after its own answer asks for it", listOf("check $a", "discard"), asked)
    }

    @Test fun `a row without a creation id is not blocked by live accounts' stores, only by stores nobody owns`() {
        val c = folder("c", "gen-c")
        answer(c, RemovalCheck.Blocks(draft))
        val rows = { listOf(Row("b", CreationId.Unreadable), Row("c", CreationId.Readable("gen-c"))) }
        assertEquals(Verdict.ALLOW, decide(input(accounts = rows, pending = listed(c), known = { setOf(c) })))
        assertFalse("a live account's store is not even checked", "check $c" in asked)
        // An orphan with a draft refuses; covered by its permit, it allows.
        answer("orphan", RemovalCheck.Blocks(draft))
        assertEquals(Verdict.REFUSE_STORE, decide(input(accounts = rows, pending = listed(c, "orphan"))))
        answer("orphan", RemovalCheck.Covered)
        assertEquals(Verdict.ALLOW, decide(input(accounts = rows, pending = listed(c, "orphan"))))
        // A row whose creation id read threw owns nothing.
        val threw = { listOf(Row("b", CreationId.Unreadable), Row("c", CreationId.of { throw SecurityException() })) }
        assertEquals(Verdict.REFUSE_STORE, decide(input(accounts = threw, pending = listed(c))))
        // Nor does the row itself, when the list reads an id for it that its own read did not find.
        val b = folder("b", "gen-b")
        answer(b, RemovalCheck.Blocks(draft))
        assertEquals(Verdict.REFUSE_STORE, decide(input(accounts = { listOf(Row("b", CreationId.Readable("gen-b"))) },
            pending = listed(b))))
        assertEquals(CreationId.Unreadable, CreationId.of { " " })
        assertEquals(CreationId.Unreadable, CreationId.of { null })
        assertEquals(CreationId.Readable("gen-c"), CreationId.of { "gen-c" })
    }

    @Test fun `the folder the list names for the row itself is checked, whatever notes-pending says`() {
        val b = folder("b", "gen-b")
        val rows = { listOf(Row("b", CreationId.Readable("gen-b"))) }
        answer(b, RemovalCheck.Blocks(draft))
        assertEquals("left out of the listing", Verdict.REFUSE_STORE, decide(input(accounts = rows)))
        assertEquals("no listing at all", Verdict.REFUSE_STORE, decide(input(accounts = rows, pending = unlistable)))
        answer(b, RemovalCheck.Clean)
        assertEquals("nothing in it", Verdict.ALLOW, decide(input(accounts = rows)))
        assertEquals("a listing that leaves out a folder that is there is short",
            PendingNotesRemovalGuard.PENDING_LISTED_SHORT,
            decide(input(accounts = rows, presence = { PendingNotesStore.Presence.PRESENT })))
    }

    @Test fun `a row the list reads an id for gets no allowance, whichever one it would have been`() {
        val b = folder("b", "gen-b")
        val read = { listOf(Row("b", CreationId.Readable("gen-b"))) }
        // Each state twice: with an account list that reads no id for the row, eligible; with one that does, refused.
        fun both(eligible: Verdict, pending: () -> StoreFolders, discard: () -> Set<String>?,
            ask: (Input) -> Verdict = ::decide) {
            assertEquals(eligible, ask(input(pending = pending, discard = discard, known = { setOf(b) })))
            assertEquals(Verdict.REFUSE_UNREADABLE, ask(input(accounts = read, pending = pending, discard = discard)))
        }
        both(Verdict.ROOT_UNLISTABLE_ONLY, unlistable, { emptySet() })
        answer(b, RemovalCheck.NothingUnwithdrawn)
        both(Verdict.PERMITS_UNLISTABLE_ONLY, listed(b), { null })
        both(Verdict.BOTH_UNLISTABLE_ONLY, unlistable, { null })
        answer(b, RemovalCheck.Clean)
        both(Verdict.UNKNOWN_KIND_ONLY, listed(b, unknown = true), { emptySet() }, ::yes)
    }

    @Test fun `every account read comes before the first store check, and every store is checked once`() {
        answer("orphan", RemovalCheck.Covered)
        decide(input(pending = listed("orphan", "x"), discard = { setOf("x", "y") }, known = { setOf("y", "z") }))
        assertEquals(listOf("accounts", "pending", "discard", "known", "presence y", "presence z", "check orphan",
            "check x", "check y", "check z"), asked)
    }

    // ---- real stores ----

    /** Replaces the target in one step on Windows too, as in PendingNotesStoreTest. */
    private val atomicMove: (File, File) -> Unit = { from, to ->
        java.nio.file.Files.move(from.toPath(), to.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }

    private fun storeIn(noBackup: File, name: String, id: String) =
        PendingNotesStore.forNoBackup(noBackup, TYPE, name, id, {}, atomicMove)

    /** The guard's input over the stores in [noBackup], as on a device, with the JVM's presence check. */
    private fun real(
        noBackup: File,
        name: String,
        id: CreationId,
        rows: List<Row>?,
        active: Pair<String, String>? = null,
        records: List<AccountCreationRegistry.Record>? = null,
    ) = PendingNotesRemovalGuard.input(noBackup, TYPE, TYPE, name, id, accounts = { rows }, active = { active },
        records = { records }, presence = PendingNotesStore.nioPresence,
        open = { PendingNotesStore.forNoBackupDirectory(noBackup, it, {}, atomicMove) })

    @Test fun `stores are found by path from notes-discard, the active account and the registry`() {
        val noBackup = tmp.newFolder("no_backup")
        fun dir(name: String, id: String) = PendingNotesStore.identityDir(noBackup, TYPE, name, id).name
        val records = listOf(
            AccountCreationRegistry.Record("r", "gen-r", AccountCreationRegistry.Phase.RECOVERY_REQUIRED, 1, TYPE),
            AccountCreationRegistry.Record("x", "gen-x", AccountCreationRegistry.Phase.PREPARED, 1, "other.type"))
        assertEquals(setOf(dir("p", "gen-p"), dir("r", "gen-r")),
            PendingNotesRemovalGuard.known(noBackup, TYPE, "p" to "gen-p", records))
        assertEquals("a registry that cannot be read gives none", setOf(dir("p", "gen-p")),
            PendingNotesRemovalGuard.known(noBackup, TYPE, "p" to "gen-p", null))
        assertEquals(emptySet<String>(), PendingNotesRemovalGuard.known(noBackup, TYPE, null, emptyList()))

        // Under a notes-pending that cannot be listed, each source finds a store with a draft that refuses b.
        val rows = listOf(Row("b", CreationId.Unreadable))
        for ((source, store) in listOf("active" to storeIn(noBackup, "p", "gen-p"),
                "registry" to storeIn(noBackup, "r", "gen-r"), "acknowledgement" to storeIn(noBackup, "k", "gen-k"),
                "uncommitted permit" to storeIn(noBackup, "n", "gen-n"))) {
            store.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
            PendingNotesStore.listFilesForTesting = { d -> if (d.name == "notes-pending") null else d.listFiles() }
            assertEquals("hidden", Verdict.ROOT_UNLISTABLE_ONLY, PendingNotesRemovalGuard.decide(real(noBackup, "b",
                CreationId.Unreadable, rows)))
            val discard = File(noBackup, PendingNotesDiscardPermits.ROOT).also { it.mkdirs() }
            val input = when (source) {
                "active" -> real(noBackup, "b", CreationId.Unreadable, rows, active = "p" to "gen-p")
                "registry" -> real(noBackup, "b", CreationId.Unreadable, rows, records = records)
                else -> {
                    val suffix = if (source == "acknowledgement") ".acknowledgement" else ".permit.new"
                    File(discard, store.dir.name + suffix).writeBytes(ByteArray(1))
                    real(noBackup, "b", CreationId.Unreadable, rows)
                }
            }
            assertEquals(source, Verdict.REFUSE_STORE, PendingNotesRemovalGuard.decide(input))
            // Its draft goes once the store is clean, as after a push.
            PendingNotesStore.listFilesForTesting = null
            assertEquals(SendOutcome.Done, store.completeSend("n1", store.beginSend("n1")!!.version, "r1",
                "landed".toByteArray()))
            File(discard, store.dir.name + ".permit.new").delete()
        }
        assertEquals("clean again, with notes-pending listed", Verdict.ALLOW,
            PendingNotesRemovalGuard.decide(real(noBackup, "b", CreationId.Unreadable, rows)))
    }

    @Test fun `a notes-pending listing that comes back empty does not allow a row without an id over a store it hid`() {
        val noBackup = tmp.newFolder("no_backup")
        // a, the active account, whose creation id reads: its last change was pushed, so its store is clean. b's id
        // does not read, and a store that no live account owns holds a draft.
        val a = storeIn(noBackup, "a", "gen-a")
        a.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        assertEquals(SendOutcome.Done, a.completeSend("n1", a.beginSend("n1")!!.version, "r1", "landed".toByteArray()))
        val orphan = storeIn(noBackup, "b", "gen-b")
        orphan.saveLocal("n1", "b1", "r1", "draft".toByteArray(), isCreate = false)
        val rows = listOf(Row("a", CreationId.Readable("gen-a")), Row("b", CreationId.Unreadable))
        fun decided() = PendingNotesRemovalGuard.decide(real(noBackup, "b", CreationId.Unreadable, rows,
            active = "a" to "gen-a"))
        assertEquals("with the whole listing, the draft refuses", Verdict.REFUSE_STORE, decided())
        // A listing of notes-pending that comes back with nothing, while a's folder, known by path, is there.
        PendingNotesStore.listFilesForTesting = { d ->
            if (d.name == PendingNotesStore.PENDING) emptyArray() else d.listFiles()
        }
        assertEquals(PendingNotesRemovalGuard.PENDING_LISTED_SHORT, decided())
        // The limit: a listing that leaves out only the folder that no path names is not caught.
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == PendingNotesStore.PENDING) all.filter { it.name != orphan.dir.name }
                .toTypedArray() else all
        }
        assertEquals("not caught: no path names b's folder", Verdict.ALLOW, decided())
    }

    @Test fun `the Settings list finds by path the stores the guard finds, from notes-discard and the known paths`() {
        val noBackup = tmp.newFolder("no_backup")
        fun dir(name: String, id: String) = PendingNotesStore.identityDir(noBackup, TYPE, name, id).name
        val discard = File(noBackup, PendingNotesDiscardPermits.ROOT).also { it.mkdirs() }
        // A permit, an acknowledgement and an uncommitted write of each, every one for another store folder.
        val ends = listOf(".permit", ".acknowledgement", ".permit.new", ".acknowledgement.new")
        val recorded = ends.mapIndexed { i, end ->
            dir("k$i", "gen-$i").also { File(discard, it + end).writeBytes(ByteArray(1)) }
        }
        File(discard, "not-a-record").writeBytes(ByteArray(1))
        val active = "p" to "gen-p"
        val records = listOf(
            AccountCreationRegistry.Record("r", "gen-r", AccountCreationRegistry.Phase.RECOVERY_REQUIRED, 1, TYPE),
            AccountCreationRegistry.Record("x", "gen-x", AccountCreationRegistry.Phase.PREPARED, 1, "other.type"))
        val byKnownPath = setOf(dir("p", "gen-p"), dir("r", "gen-r"))
        fun found() =
            PendingNotesRemovalGuard.foundByPath(noBackup, TYPE, PendingNotesStore.nioPresence, active, records)
        val guard = real(noBackup, "b", CreationId.Unreadable, null, active, records)
        assertEquals(recorded.toSet() + byKnownPath, found())
        assertEquals("the guard's own two readings", found(), guard.discard().orEmpty() + guard.known())
        // While notes-discard cannot be listed, the known paths alone, as for the guard.
        PendingNotesStore.listFilesForTesting = { d ->
            if (d.name == PendingNotesDiscardPermits.ROOT) null else d.listFiles()
        }
        assertEquals(byKnownPath, found())
        assertNull(guard.discard())
        assertEquals(found(), guard.known())
    }

    @Test fun `a store whose discard stopped in this process is checked when no listing or known path names it`() {
        // A discard of b's store, confirmed for an answer that could not be counted, since a file of a kind this build
        // does not know stopped the count: it removed n1 and stopped at n2. Once that file is gone, what is left
        // counts, and a permit recorded as for an answer that could not be counted covers no counted answer.
        val noBackup = tmp.newFolder("no_backup")
        val stopped = storeIn(noBackup, "b", "gen-b")
        stopped.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        stopped.saveLocal("n2", "b1", "r1", "text".toByteArray(), isCreate = false)
        File(stopped.dir, "x.draft").writeBytes(ByteArray(1))
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, stopped.discardStore(stopped.unsynced()))
        PendingNotesStore.beforeRemoveForTesting = null
        assertTrue(File(stopped.dir, "x.draft").delete())
        assertTrue(stopped.clearStopped())
        assertEquals(listOf(stopped.dir.name), PendingNotesStore.stoppedIn(noBackup))
        assertTrue(stopped.removalCheck() is RemovalCheck.Blocks)
        // The same discard with no file of an unknown kind, in another no_backup folder: its permit is for a counted
        // answer and covers what is left.
        val coveredIn = tmp.newFolder("no_backup_covered")
        val covered = storeIn(coveredIn, "b", "gen-b")
        covered.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        covered.saveLocal("n2", "b1", "r1", "text".toByteArray(), isCreate = false)
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, covered.discardStore(covered.unsynced()))
        PendingNotesStore.beforeRemoveForTesting = null
        assertTrue(covered.clearStopped())
        assertEquals(RemovalCheck.Covered, covered.removalCheck())

        // No active account, registry record or other row names either store, so only notes-pending's listing,
        // notes-discard's record of the permit and this process's memory of the stop do.
        fun decided(root: File, pending: (File) -> Array<File>?, discard: (File) -> Array<File>?): Verdict {
            PendingNotesStore.listFilesForTesting = { d ->
                when (d.name) {
                    PendingNotesStore.PENDING -> pending(d)
                    PendingNotesDiscardPermits.ROOT -> discard(d)
                    else -> d.listFiles()
                }
            }
            return PendingNotesRemovalGuard.decide(real(root, "b", CreationId.Unreadable,
                listOf(Row("b", CreationId.Unreadable))))
        }
        val whole: (File) -> Array<File>? = { it.listFiles() }
        val fails: (File) -> Array<File>? = { null }
        val verdicts = linkedMapOf(
            "every folder lists" to decided(noBackup, whole, whole),
            "notes-pending lists nothing, notes-discard cannot be listed" to decided(noBackup, { emptyArray() }, fails),
            "neither can be listed" to decided(noBackup, fails, fails),
            "neither can be listed, what is left covered" to decided(coveredIn, fails, fails))
        assertEquals(linkedMapOf(
            "every folder lists" to Verdict.REFUSE_STORE,
            "notes-pending lists nothing, notes-discard cannot be listed" to Verdict.REFUSE_STORE,
            "neither can be listed" to Verdict.REFUSE_STORE,
            "neither can be listed, what is left covered" to Verdict.REFUSE_UNREADABLE), verdicts)
    }

    @Test fun `while notes-discard cannot be read, a clean account is decided with no permit or acknowledgement`() {
        val noBackup = tmp.newFolder("no_backup")
        // An orphan whose last change was pushed: clean, with its counter and notebook copy left.
        val orphan = storeIn(noBackup, "orphan", "gen-o")
        orphan.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false, notebookCopy = "key".toByteArray())
        assertEquals(SendOutcome.Done, orphan.completeSend("n1", orphan.beginSend("n1")!!.version, "r1",
            "landed".toByteArray()))
        // And a store with text, which no allowance may pass.
        val held = storeIn(noBackup, "held", "gen-h")
        held.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        // notes-discard is there, as after a permit that came and went; with no folder, a withdrawal succeeds.
        assertTrue(File(noBackup, PendingNotesDiscardPermits.ROOT).mkdir())
        PendingNotesStore.resetForTesting()
        var listings = 0
        var withdrawals = 0
        PendingNotesStore.listFilesForTesting = { d ->
            if (d.name == PendingNotesDiscardPermits.ROOT) { listings++; null } else d.listFiles()
        }
        PendingNotesDiscardPermits.beforeDeleteForTesting = { withdrawals++ }
        PendingNotesDiscardPermits.onReadForTesting = { throw AssertionError("${it.name} was read") }

        val fresh = CreationId.Readable("gen-a")
        val readableId = PendingNotesRemovalGuard.READABLE_ID_UNDER_UNLISTED_PERMITS
        assertEquals(readableId, PendingNotesRemovalGuard.decide(real(noBackup, "a", fresh, null)))
        assertEquals("its withdrawal was tried, and both of its listings, which failed", listOf(1, 2),
            listOf(withdrawals, listings))
        val rows = listOf(Row("b", CreationId.Unreadable), Row("held", CreationId.Readable("gen-h")))
        assertEquals(Verdict.PERMITS_UNLISTABLE_ONLY, PendingNotesRemovalGuard.decide(real(noBackup, "b",
            CreationId.Unreadable, rows)))
        assertEquals("the orphan's withdrawal too, and listNames", listOf(2, 4), listOf(withdrawals, listings))

        // The same without the seam that fails every read.
        PendingNotesDiscardPermits.onReadForTesting = null
        PendingNotesStore.resetForTesting()
        assertEquals(readableId, PendingNotesRemovalGuard.decide(real(noBackup, "a", fresh, null)))
        assertEquals(Verdict.PERMITS_UNLISTABLE_ONLY, PendingNotesRemovalGuard.decide(real(noBackup, "b",
            CreationId.Unreadable, rows)))
        // The store with text stays refused, for its own account and for a row that does not own it.
        assertEquals(Verdict.REFUSE_STORE, PendingNotesRemovalGuard.decide(real(noBackup, "held",
            CreationId.Readable("gen-h"), null)))
        assertEquals(Verdict.REFUSE_STORE, PendingNotesRemovalGuard.decide(real(noBackup, "b", CreationId.Unreadable,
            listOf(Row("b", CreationId.Unreadable)))))
    }

    @Test fun `while notes-discard cannot be read, an own folder that lists and holds no text is held, as refused`() {
        val noBackup = tmp.newFolder("no_backup")
        // The account's own store, whose last change was pushed: there, clean, with its counter and notebook copy.
        val own = storeIn(noBackup, "a", "gen-a")
        own.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false, notebookCopy = "key".toByteArray())
        assertEquals(SendOutcome.Done, own.completeSend("n1", own.beginSend("n1")!!.version, "r1",
            "landed".toByteArray()))
        // notes-discard is there, as after a permit that came and went, and cannot be listed.
        assertTrue(File(noBackup, PendingNotesDiscardPermits.ROOT).mkdir())
        PendingNotesStore.resetForTesting()
        val listings = ArrayList<String>()
        fun discardUnlistable() {
            PendingNotesStore.listFilesForTesting = { d ->
                listings += d.name
                if (d.name == PendingNotesDiscardPermits.ROOT) null else d.listFiles()
            }
        }
        discardUnlistable()
        val reads = ArrayList<String>()
        PendingNotesDiscardPermits.onReadForTesting = { reads += it.name }
        val before = snapshot(noBackup)
        fun decided() = PendingNotesRemovalGuard.decide(real(noBackup, "a", CreationId.Readable("gen-a"), null))

        assertEquals(Verdict.REFUSE_UNREADABLE, PendingNotesRemovalGuard.READABLE_ID_UNDER_UNLISTED_PERMITS)
        assertEquals(PendingNotesRemovalGuard.READABLE_ID_UNDER_UNLISTED_PERMITS, decided())
        assertEquals("its own folder listed first", own.dir.name, listings.first())
        assertEquals("no permit or acknowledgement is read", emptyList<String>(), reads)
        assertEquals("nothing changes", before, snapshot(noBackup))
        // Allowed once notes-discard lists. The same instance, having withdrawn then, is allowed after it cannot be
        // listed again, while a new one, as after a restart, is held again.
        PendingNotesStore.listFilesForTesting = null
        assertEquals(Verdict.ALLOW, decided())
        discardUnlistable()
        assertEquals(Verdict.ALLOW, decided())
        PendingNotesStore.resetForTesting()
        assertEquals(PendingNotesRemovalGuard.READABLE_ID_UNDER_UNLISTED_PERMITS, decided())
    }

    /** A symbolic link at [at] to [target], or a skip where this machine cannot make one. */
    private fun linked(at: File, target: File) {
        assertTrue("the link's folder is there", at.parentFile!!.isDirectory)
        val made = try {
            Files.createSymbolicLink(at.toPath(), target.toPath())
            true
        } catch (e: IOException) {
            false
        } catch (e: UnsupportedOperationException) {
            false
        }
        assumeTrue("this machine cannot make a symbolic link", made)
    }

    /**
     * Identities for an acknowledgement, read without following a link, where this JVM has no lstat numbers: one per
     * path that is there, and a link's own differs from what takes its place.
     */
    private fun identifyWithoutFollowing() {
        PendingNotesStore.identityForTesting = { d ->
            val path = d.toPath()
            if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) null
            else PendingNotesStore.DirectoryIdentity(device = 7,
                inode = ((if (Files.isSymbolicLink(path)) "link " else "") + d.path).hashCode().toLong())
        }
    }

    /** A clean store of a live account "c", whose last change was pushed, for a link to point at. */
    private fun cleanStore(noBackup: File): PendingNotesStore = storeIn(noBackup, "c", "gen-c").also { c ->
        c.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        assertEquals(SendOutcome.Done, c.completeSend("n1", c.beginSend("n1")!!.version, "r1", "landed".toByteArray()))
    }

    @Test fun `an account whose own store folder is a link is refused as a store, and allowed once acknowledged`() {
        identifyWithoutFollowing()
        val noBackup = tmp.newFolder("no_backup")
        val target = cleanStore(noBackup).dir
        val folder = PendingNotesStore.identityDir(noBackup, TYPE, "a", "gen-a")
        linked(folder, target)
        PendingNotesStore.resetForTesting()
        val reads = ArrayList<String>()
        PendingNotesDiscardPermits.onReadForTesting = { reads += it.name }
        val before = snapshot(noBackup)
        fun decided() = PendingNotesRemovalGuard.decide(real(noBackup, "a", CreationId.Readable("gen-a"), null))

        assertEquals(Verdict.REFUSE_STORE, decided())
        assertEquals("no permit is read", listOf(folder.name + ".acknowledgement"), reads)
        assertEquals("nothing changes", before, snapshot(noBackup))
        // Its way out is the acknowledgement, bound to the link itself, which deletes nothing.
        val store = storeIn(noBackup, "a", "gen-a")
        assertEquals(DiscardOutcome.Acknowledged, store.discardStore(store.unsynced()))
        assertEquals(Verdict.ALLOW, decided())
        assertTrue("the link is still a link", Files.isSymbolicLink(folder.toPath()))
        assertEquals("to the same folder", target.toPath(), Files.readSymbolicLink(folder.toPath()))
        // By the name under notes-pending, as the snapshot's keys are: target's own path has canonical parents.
        val targetFiles = File(PendingNotesStore.PENDING, target.name).path
        val targetBefore = before.filterKeys { it.startsWith(targetFiles) }
        assertTrue("the target holds files", targetBefore.values.any { it != null })
        assertEquals("whose files are as they were", targetBefore,
            snapshot(noBackup).filterKeys { it.startsWith(targetFiles) })
    }

    @Test fun `a row without a creation id beside a link store is refused as a store, never by an eligible verdict`() {
        identifyWithoutFollowing()
        val noBackup = tmp.newFolder("no_backup")
        val target = cleanStore(noBackup).dir
        val folder = PendingNotesStore.identityDir(noBackup, TYPE, "l", "gen-l")
        linked(folder, target)
        // notes-discard is there, as after a permit that came and went, so the seam below can make it unlistable.
        assertTrue(File(noBackup, PendingNotesDiscardPermits.ROOT).mkdir())
        // The link is found in notes-pending, or by path from the active account while notes-pending cannot be listed;
        // the store it points at is the live account c's own, so the link's alone counts.
        val rows = listOf(Row("b", CreationId.Unreadable), Row("c", CreationId.Readable("gen-c")))
        fun decided(vararg unlistable: String): Verdict {
            PendingNotesStore.resetForTesting()
            PendingNotesStore.listFilesForTesting = { d -> if (d.name in unlistable) null else d.listFiles() }
            return PendingNotesRemovalGuard.decide(real(noBackup, "b", CreationId.Unreadable, rows,
                active = "l" to "gen-l"))
        }
        val reads = ArrayList<String>()
        PendingNotesDiscardPermits.onReadForTesting = { reads += it.name }
        val before = snapshot(noBackup)
        val discard = PendingNotesDiscardPermits.ROOT
        for (unlistable in listOf(emptyList(), listOf(PendingNotesStore.PENDING), listOf(discard),
                listOf(PendingNotesStore.PENDING, discard))) {
            val verdict = decided(*unlistable.toTypedArray())
            assertEquals("$unlistable", Verdict.REFUSE_STORE, verdict)
            assertFalse("$unlistable", verdict.eligible)
        }
        assertTrue("no permit is read: $reads", reads.all { it == folder.name + ".acknowledgement" })
        assertEquals("nothing changes", before, snapshot(noBackup))
        // Acknowledged, it counts as any acknowledged store does.
        PendingNotesStore.listFilesForTesting = null
        val link = PendingNotesStore.forNoBackupDirectory(noBackup, folder.name, {}, atomicMove)
        assertEquals(DiscardOutcome.Acknowledged, link.discardStore(link.unsynced()))
        assertEquals(Verdict.ALLOW, decided())
        assertTrue("the link is still a link", Files.isSymbolicLink(folder.toPath()))
    }

    /** Every file and folder under [root], by its relative path, with each file's bytes. */
    private fun snapshot(root: File) =
        root.walk().associate { f -> f.relativeTo(root).path to (if (f.isFile) f.readBytes().toList() else null) }

    @Test fun `an own folder absent by lstat under an unlistable notes-pending allows its account, changing nothing`() {
        val noBackup = tmp.newFolder("no_backup")
        fun dir(id: String) = PendingNotesStore.identityDir(noBackup, TYPE, "a", id)
        // The same name with an older creation id is another identity, whose draft this removal does not ask about.
        storeIn(noBackup, "a", "gen-old").saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        // For the refusals below: an own folder that is there with a draft, and a regular file at another one's path.
        storeIn(noBackup, "a", "gen-there").saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        dir("gen-file").writeBytes(ByteArray(1))
        PendingNotesStore.resetForTesting()
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == "notes-pending") null else d.listFiles() }
        PendingNotesDiscardPermits.beforeRecordForTesting = { throw AssertionError("a record of ${it.name}") }
        PendingNotesDiscardPermits.beforeDeleteForTesting = { throw AssertionError("a withdrawal of ${it.name}") }
        val reads = ArrayList<String>()
        PendingNotesDiscardPermits.onReadForTesting = { reads += it.name }
        val looked = ArrayList<String>()
        PendingNotesStore.presenceForTesting = { f -> looked += f.canonicalPath; null }
        val before = snapshot(noBackup)
        fun own(id: String) = PendingNotesRemovalGuard.decide(real(noBackup, "a", CreationId.Readable(id), null))

        assertEquals(Verdict.ALLOW, own("gen-a"))
        assertEquals("one lstat, of exactly that account's own folder", listOf(dir("gen-a").canonicalPath), looked)
        assertEquals("its acknowledgement alone is read, and no permit", listOf(dir("gen-a").name + ".acknowledgement"),
            reads)
        assertEquals("nothing written, made or removed", before, snapshot(noBackup))

        // Every other answer for an own folder refuses: one there with a draft that cannot be listed, a regular file at
        // the path, and a presence check that answers there or fails.
        PendingNotesStore.listFilesForTesting = { d ->
            if (d.name == "notes-pending" || d.name == dir("gen-there").name) null else d.listFiles()
        }
        assertEquals(Verdict.REFUSE_STORE, own("gen-there"))
        assertEquals("a regular file", Verdict.REFUSE_STORE, own("gen-file"))
        for (presence in listOf(PendingNotesStore.Presence.PRESENT, PendingNotesStore.Presence.UNKNOWN)) {
            PendingNotesStore.presenceForTesting = { f -> if (f.name == dir("gen-x").name) presence else null }
            assertEquals("$presence", Verdict.REFUSE_STORE, own("gen-x"))
        }
        assertEquals(before, snapshot(noBackup))
    }

    @Test fun `with both folders unreadable, no permit is read for the one allowance, and stores with text refuse`() {
        val noBackup = tmp.newFolder("no_backup")
        fun dir(name: String, id: String) = PendingNotesStore.identityDir(noBackup, TYPE, name, id)
        // Found by path: the active account's store, whose last change was pushed (its counter is left), and a
        // registry record's store that was never made.
        val active = storeIn(noBackup, "p", "gen-p")
        active.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        assertEquals(SendOutcome.Done, active.completeSend("n1", active.beginSend("n1")!!.version, "r1",
            "landed".toByteArray()))
        val records = listOf(
            AccountCreationRegistry.Record("r", "gen-r", AccountCreationRegistry.Phase.RECOVERY_REQUIRED, 1, TYPE))
        // notes-discard is there, as after a permit that came and went; neither folder can be listed.
        assertTrue(File(noBackup, PendingNotesDiscardPermits.ROOT).mkdir())
        PendingNotesStore.resetForTesting()
        fun unlistable() {
            PendingNotesStore.listFilesForTesting = { d ->
                if (d.name == "notes-pending" || d.name == PendingNotesDiscardPermits.ROOT) null else d.listFiles()
            }
        }
        unlistable()
        // Both kinds of read call the seam; they are told apart by the name read.
        val permitReads = ArrayList<String>()
        val acknowledgementReads = ArrayList<String>()
        PendingNotesDiscardPermits.onReadForTesting = { f ->
            if (f.name.endsWith(".permit")) permitReads += f.name else acknowledgementReads += f.name
        }
        val input = real(noBackup, "b", CreationId.Unreadable, listOf(Row("b", CreationId.Unreadable)),
            active = "p" to "gen-p", records = records)
        val before = snapshot(noBackup)

        assertEquals(Verdict.BOTH_UNLISTABLE_ONLY, PendingNotesRemovalGuard.decide(input))
        assertEquals("no permit read at all", emptyList<String>(), permitReads)
        assertEquals("the absent store reads its acknowledgement by path",
            listOf(dir("r", "gen-r").name + ".acknowledgement"), acknowledgementReads)
        assertEquals("and nothing changes", before, snapshot(noBackup))

        // A store found by path whose check fails still refuses.
        PendingNotesStore.presenceForTesting = { f ->
            if (f.name == dir("r", "gen-r").name) PendingNotesStore.Presence.UNKNOWN else null
        }
        assertEquals(Verdict.REFUSE_STORE, PendingNotesRemovalGuard.decide(input))
        PendingNotesStore.presenceForTesting = null
        // So does one that holds text.
        PendingNotesStore.listFilesForTesting = null
        storeIn(noBackup, "p", "gen-p").saveLocal("n2", "b1", "r1", "text".toByteArray(), isCreate = false)
        PendingNotesStore.resetForTesting()
        unlistable()
        permitReads.clear()
        assertEquals(Verdict.REFUSE_STORE, PendingNotesRemovalGuard.decide(input))
        assertEquals("the counter sees a permit read: p's, by path", listOf(dir("p", "gen-p").name + ".permit"),
            permitReads)
    }

    @Test fun `a decision names the entries of an unknown kind its listing found, and lists, checks and opens none`() {
        val noBackup = tmp.newFolder("no_backup")
        val pending = File(noBackup, PendingNotesStore.PENDING)
        // An orphan whose last change was pushed: clean.
        val orphan = storeIn(noBackup, "orphan", "gen-o")
        orphan.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        assertEquals(SendOutcome.Done, orphan.completeSend("n1", orphan.beginSend("n1")!!.version, "r1",
            "landed".toByteArray()))
        // Entries of kinds this build does not know: a file, a folder holding one, a folder named with 64 uppercase hex
        // characters (with no lowercase twin, which a file system that ignores case would take it for), and one named
        // with the store's name and a suffix.
        val store = orphan.dir.name
        File(pending, "future.dat").writeBytes(ByteArray(64) { it.toByte() })
        assertTrue(File(pending, "FUTURE").mkdir())
        File(pending, "FUTURE/inside.dat").writeBytes(ByteArray(8))
        val upper = "0123456789ABCDEF".repeat(4)
        assertTrue(File(pending, upper).mkdir())
        assertTrue(File(pending, "$store.new").mkdir())
        val unknown = listOf("future.dat", "FUTURE", upper, "$store.new").sorted()
        val unknownPaths = unknown.map { File(pending, it).path }
        fun touches(path: String) = unknownPaths.any { path == it || path.startsWith(it + File.separator) }
        PendingNotesStore.resetForTesting()
        val listings = ArrayList<String>()
        PendingNotesStore.listFilesForTesting = { d -> listings += d.path; d.listFiles() }
        val looked = ArrayList<String>()
        PendingNotesStore.presenceForTesting = { f -> looked += f.path; null }
        val opened = ArrayList<String>()
        val input = PendingNotesRemovalGuard.input(noBackup, TYPE, TYPE, "b", CreationId.Unreadable,
            accounts = { listOf(Row("b", CreationId.Unreadable)) }, active = { null }, records = { emptyList() },
            presence = PendingNotesStore.nioPresence,
            open = { opened += it; PendingNotesStore.forNoBackupDirectory(noBackup, it, {}, atomicMove) })
        val before = snapshot(noBackup)

        val decided = PendingNotesRemovalGuard.decision(input, Verdict.UNKNOWN_KIND_ONLY)
        assertEquals(Verdict.UNKNOWN_KIND_ONLY, decided.verdict)
        assertEquals("the names its own listing found, sorted", unknown, decided.unknown)
        assertNull(decided.creationId)
        assertEquals("only the store folder is opened", listOf(store), opened)
        assertTrue("nothing lists an entry of an unknown kind: $listings", listings.none(::touches))
        assertTrue("nothing checks one: $looked", looked.none(::touches))
        assertEquals("and nothing changes", before, snapshot(noBackup))
        // Refused as the default stands, with the same names.
        val refused = PendingNotesRemovalGuard.decision(input)
        assertEquals(Verdict.REFUSE_UNKNOWN_KIND, refused.verdict)
        assertEquals(unknown, refused.unknown)
        // A row whose creation id reads lists no notes-pending, so it names none.
        val own = PendingNotesRemovalGuard.decision(real(noBackup, "a", CreationId.Readable("gen-a"), null))
        assertEquals(Decision(Verdict.ALLOW, "gen-a", emptyList()), own)
        assertEquals(before, snapshot(noBackup))
    }

    private companion object {
        const val TYPE = "io.silentsuite"
    }
}
