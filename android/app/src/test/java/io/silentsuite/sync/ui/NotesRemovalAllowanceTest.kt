package io.silentsuite.sync.ui

import io.silentsuite.sync.notes.edit.NotesFolderListings.Folder
import io.silentsuite.sync.ui.NotesRemovalAllowance.FolderStat
import io.silentsuite.sync.ui.NotesRemovalAllowance.Fingerprint
import io.silentsuite.sync.ui.NotesRemovalAllowance.Key
import io.silentsuite.sync.ui.NotesRemovalAllowance.Mint
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Cause
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import io.silentsuite.sync.utils.AccountRowChanges
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The one-time confirmed removal (the maintainer's second reply of 2026-10-20 on #709): at most 2 minutes, used once,
 * in memory only, checked and used up in one atomic step against the exact row and the counter of adds and removals.
 * The clock, the folder counters, the folders' stats and the row counter are the test's own.
 */
class NotesRemovalAllowanceTest {
    private val rows = AccountRowChanges()
    private val folderCounts = HashMap(mapOf(Folder.PENDING to 0L, Folder.DISCARD to 0L))
    private var now = 1_000L
    private var ids = 0
    private val allowance = NotesRemovalAllowance(rows, { folderCounts.getValue(it) }, { now }, { "shown-${++ids}" })

    private val b = Key(TYPE, "b", creationId = null)
    private val pending = Fingerprint(mapOf(Folder.PENDING to FolderStat.Stat(1, 2, 0x41c0, 3)))
    private val discard = Fingerprint(mapOf(Folder.DISCARD to FolderStat.Failed(13)))

    /** A confirmation shown for [key] while notes-pending alone cannot be read, and minted at once. */
    private fun minted(key: Key = b): Mint {
        val shown = allowance.show(allowance.counts(), key, Verdict.ROOT_UNLISTABLE_ONLY, pending, recovery = null)!!
        return allowance.mint(shown.id, key, Verdict.ROOT_UNLISTABLE_ONLY, pending)
    }

    private fun answer(
        key: Key = b,
        verdict: Verdict = Verdict.ROOT_UNLISTABLE_ONLY,
        fingerprint: Fingerprint? = pending,
    ) = allowance.answer(key, verdict, fingerprint)

    private fun bump(folder: Folder) {
        folderCounts[folder] = folderCounts.getValue(folder) + 1
    }

    /** notes-pending's stat with another inode, as a folder that took its place. */
    private val replaced = Fingerprint(mapOf(Folder.PENDING to FolderStat.Stat(1, 9, 0x41c0, 3)))

    @Test fun `a confirmation is offered only for an eligible verdict, and holds the counts read before it`() {
        val counts = allowance.counts()
        // Something moves the counter after the counts were read and before the verdict: a removal and a re-add.
        rows.before()
        for (refused in Verdict.entries.filterNot { it.eligible }) {
            assertNull("$refused", allowance.show(counts, b, refused, pending, recovery = null))
        }
        val shown = allowance.show(counts, b, Verdict.ROOT_UNLISTABLE_ONLY, pending, recovery = "gen-r")!!
        assertEquals(setOf(Cause.PENDING_UNLISTED), shown.reason)
        assertSame(shown, allowance.shown(shown.id))
        assertEquals("the move since the counts makes the tap fail", Mint.Changed,
            allowance.mint(shown.id, b, Verdict.ROOT_UNLISTABLE_ONLY, pending))
    }

    @Test fun `a mint moves the counter itself and records the count after its own move, used once`() {
        val before = rows.count()
        assertEquals(Mint.Done(b, recovery = null), minted())
        assertEquals("the mint's compare-and-set is the button's own move", before + 1, rows.count())
        assertTrue(answer())
        assertEquals("the answer moved it again", before + 2, rows.count())
        assertFalse("used once", answer())
    }

    @Test fun `another name or type answers false and leaves the slot live, and an allowed one moves the counter`() {
        assertTrue(minted() is Mint.Done)
        assertFalse(answer(Key(TYPE, "d", null)))
        assertFalse(answer(Key("io.silentsuite.address_book", "b", null)))
        assertTrue("still live for b", answer())
        assertTrue(minted() is Mint.Done)
        val beforeAllowed = rows.count()
        assertTrue("another row that is allowed outright", answer(Key(TYPE, "c", "gen-c"), Verdict.ALLOW, null))
        assertEquals(beforeAllowed + 1, rows.count())
        assertFalse("its move voids the slot, which fails closed", answer())

        // An allowed answer for the row itself uses its slot up as well.
        assertTrue(minted() is Mint.Done)
        assertTrue(answer(verdict = Verdict.ALLOW, fingerprint = null))
        assertFalse(answer())
    }

    @Test fun `the slot holds for just under two minutes`() {
        assertTrue(minted() is Mint.Done)
        now += 119_999
        assertTrue(answer())
        assertTrue(minted() is Mint.Done)
        now += 120_000
        assertFalse(answer())
        assertEquals(120_000L, NotesRemovalAllowance.WINDOW_MS)
    }

    @Test fun `a tap's reads must end within two minutes of the tap, or it moves no count and makes no slot`() {
        fun tapThen(read: Long): Mint {
            val shown = allowance.show(allowance.counts(), b, Verdict.ROOT_UNLISTABLE_ONLY, pending, recovery = null)!!
            val tapped = allowance.now()
            now += read
            return allowance.mint(shown.id, b, Verdict.ROOT_UNLISTABLE_ONLY, pending, tapped)
        }
        assertTrue(tapThen(119_999) is Mint.Done)
        assertTrue("one millisecond left", answer())
        assertTrue(tapThen(119_999) is Mint.Done)
        now += 1
        assertFalse("the slot runs from the tap, not from the end of its reads", answer())
        val before = rows.count()
        assertEquals(Mint.Retry, tapThen(120_000))
        assertEquals("the row counter did not move", before, rows.count())
        // A slot would answer here: the counter at its count, and the clock back inside its window.
        rows.before()
        now -= 1
        assertFalse("and there is no slot", answer())
    }

    @Test fun `each change since the mint voids the slot, and a void is final`() {
        val a = Key(TYPE, "a", "gen-a")
        val voids = listOf<Pair<String, () -> Boolean>>(
            "an add or removal" to { rows.before(); answer() },
            "a listing of notes-pending that worked" to { bump(Folder.PENDING); answer() },
            "the folder replaced" to { answer(fingerprint = replaced) },
            "its stat failing" to { answer(fingerprint = Fingerprint(mapOf(Folder.PENDING to FolderStat.Failed(13)))) },
            "the row's id now reads" to { answer(Key(TYPE, "b", "gen-new")) },
            "a verdict that is not eligible" to { answer(verdict = Verdict.REFUSE_STORE) },
            "the account list unread, which no eligible verdict has" to { answer(verdict = Verdict.REFUSE_ACCOUNTS) },
            "another reason" to { answer(verdict = Verdict.BOTH_UNLISTABLE_ONLY) },
        )
        for ((what, use) in voids) {
            assertTrue(what, minted() is Mint.Done)
            assertFalse(what, use())
            assertFalse("$what, then unchanged again", answer())
        }
        // A row whose id reads is never shown a confirmation, so it never has a slot: only an allowed answer holds.
        for (eligible in Verdict.entries.filter { it.eligible }) {
            assertNull("$eligible", allowance.show(allowance.counts(), a, eligible, pending, recovery = null))
            assertFalse("$eligible", answer(a, eligible))
        }
        assertTrue(answer(a, Verdict.ALLOW, null))
        // A listing of the other folder voids nothing.
        assertTrue(minted() is Mint.Done)
        folderCounts[Folder.DISCARD] = 7
        assertTrue(answer())
    }

    @Test fun `the reason binds each of its folders, and only those`() {
        val both = Fingerprint(pending.stats + discard.stats)
        val shown = allowance.show(allowance.counts(), b, Verdict.PERMITS_UNLISTABLE_ONLY, discard, recovery = null)!!
        folderCounts[Folder.PENDING] = 5
        assertTrue(allowance.mint(shown.id, b, Verdict.PERMITS_UNLISTABLE_ONLY, discard) is Mint.Done)
        folderCounts[Folder.PENDING] = 6
        assertTrue("notes-pending is not in its reason", answer(verdict = Verdict.PERMITS_UNLISTABLE_ONLY,
            fingerprint = discard))

        fun mintedForBoth() {
            val next = allowance.show(allowance.counts(), b, Verdict.BOTH_UNLISTABLE_ONLY, both, recovery = null)!!
            assertTrue(allowance.mint(next.id, b, Verdict.BOTH_UNLISTABLE_ONLY, both) is Mint.Done)
        }
        mintedForBoth()
        assertTrue("both folders as they were", answer(verdict = Verdict.BOTH_UNLISTABLE_ONLY, fingerprint = both))
        for (folder in Folder.entries) {
            mintedForBoth()
            folderCounts[folder] = folderCounts.getValue(folder) + 1
            assertFalse("$folder", answer(verdict = Verdict.BOTH_UNLISTABLE_ONLY, fingerprint = both))
            // Or the stat of either folder changed.
            mintedForBoth()
            val changed = Fingerprint(both.stats + (folder to FolderStat.Failed(2)))
            assertFalse("$folder stat", answer(verdict = Verdict.BOTH_UNLISTABLE_ONLY, fingerprint = changed))
        }
    }

    /** Names of an unknown kind in notes-pending: its stat, the names, and the lstat of each. */
    private val unknownKind = Fingerprint(mapOf(Folder.PENDING to FolderStat.Stat(1, 2, 0x41c0, 3)),
        names = listOf("FUTURE", "future.dat"),
        entries = mapOf("FUTURE" to FolderStat.Stat(1, 7, 0x41c0, 5), "future.dat" to FolderStat.Stat(1, 8, 0x81a4, 6)))

    private fun answerUnknown(
        fingerprint: Fingerprint? = unknownKind,
        verdict: Verdict = Verdict.UNKNOWN_KIND_ONLY,
        key: Key = b,
    ) = allowance.answer(key, verdict, fingerprint)

    @Test fun `names of an unknown kind bind no folder counter, so the guard's own listings leave them be`() {
        val shown = allowance.show(allowance.counts(), b, Verdict.UNKNOWN_KIND_ONLY, unknownKind, recovery = null)!!
        assertEquals(setOf(Cause.PENDING_UNKNOWN_KIND), shown.reason)
        // The guard lists notes-pending, and notes-discard, at the show, at the tap and at the answer.
        bump(Folder.PENDING)
        bump(Folder.DISCARD)
        assertEquals(Mint.Done(b, recovery = null),
            allowance.mint(shown.id, b, Verdict.UNKNOWN_KIND_ONLY, unknownKind))
        bump(Folder.PENDING)
        bump(Folder.DISCARD)
        assertTrue(answerUnknown())
        assertFalse("used once", answerUnknown())
        // A folder that cannot be listed keeps that bind.
        assertTrue(minted() is Mint.Done)
        bump(Folder.PENDING)
        assertFalse(answer())
    }

    @Test fun `names of an unknown kind bind the names, each one's lstat, notes-pending's stat and their own reason`() {
        fun mintedForUnknownKind() {
            val shown = allowance.show(allowance.counts(), b, Verdict.UNKNOWN_KIND_ONLY, unknownKind, recovery = null)!!
            assertTrue(allowance.mint(shown.id, b, Verdict.UNKNOWN_KIND_ONLY, unknownKind) is Mint.Done)
        }
        val other = FolderStat.Stat(1, 9, 0x41c0, 5)
        val voids = listOf<Pair<String, () -> Boolean>>(
            "an entry added" to {
                answerUnknown(unknownKind.copy(names = listOf("FUTURE", "future.dat", "more"),
                    entries = unknownKind.entries + ("more" to other)))
            },
            "an entry gone" to {
                answerUnknown(unknownKind.copy(names = listOf("future.dat"), entries = unknownKind.entries - "FUTURE"))
            },
            "an entry renamed" to {
                answerUnknown(unknownKind.copy(names = listOf("FUTURE2", "future.dat"),
                    entries = unknownKind.entries - "FUTURE" + ("FUTURE2" to unknownKind.entries.getValue("FUTURE"))))
            },
            "an entry replaced" to {
                answerUnknown(unknownKind.copy(entries = unknownKind.entries + ("FUTURE" to other)))
            },
            "an entry's lstat failing" to {
                answerUnknown(unknownKind.copy(entries = unknownKind.entries + ("FUTURE" to FolderStat.Failed(13))))
            },
            "notes-pending changed" to {
                answerUnknown(unknownKind.copy(stats = mapOf(Folder.PENDING to FolderStat.Stat(1, 2, 0x41c0, 4))))
            },
            "an add or removal" to { rows.before(); answerUnknown() },
            "the row's id now reads" to { answerUnknown(key = Key(TYPE, "b", "gen-new")) },
            "notes-pending unlisted, with the same stat" to {
                answerUnknown(Fingerprint(unknownKind.stats), Verdict.ROOT_UNLISTABLE_ONLY)
            },
            "a store that holds text" to { answerUnknown(verdict = Verdict.REFUSE_STORE) },
            "notes-discard unlisted as well" to { answerUnknown(verdict = Verdict.REFUSE_UNKNOWN_KIND) },
            "the account list unread" to { answerUnknown(verdict = Verdict.REFUSE_ACCOUNTS) },
        )
        for ((what, use) in voids) {
            mintedForUnknownKind()
            assertFalse(what, use())
            assertFalse("$what, then unchanged again", answerUnknown())
        }
        // The reverse: a slot for notes-pending unlisted answers nothing for names of an unknown kind.
        assertTrue(minted() is Mint.Done)
        assertFalse(answerUnknown(pending))
        assertFalse("used up", answer())
        // Two minutes, as for the others.
        mintedForUnknownKind()
        now += NotesRemovalAllowance.WINDOW_MS
        assertFalse(answerUnknown())
    }

    @Test fun `a tap fails for a confirmation replaced, canceled or used, for what changed since it showed`() {
        val first = allowance.show(allowance.counts(), b, Verdict.ROOT_UNLISTABLE_ONLY, pending, recovery = null)!!
        val second = allowance.show(allowance.counts(), b, Verdict.ROOT_UNLISTABLE_ONLY, pending, recovery = "gen-r")!!
        assertNotEquals(first.id, second.id)
        assertNull("one confirmation at a time", allowance.shown(first.id))
        assertEquals(Mint.Changed, allowance.mint(first.id, b, Verdict.ROOT_UNLISTABLE_ONLY, pending))
        allowance.cancel(first.id)
        assertSame("canceling an old one leaves the new one", second, allowance.shown(second.id))
        allowance.cancel(second.id)
        assertEquals(Mint.Changed, allowance.mint(second.id, b, Verdict.ROOT_UNLISTABLE_ONLY, pending))

        fun tap(change: () -> Unit, key: Key = b, verdict: Verdict = Verdict.ROOT_UNLISTABLE_ONLY,
                fingerprint: Fingerprint = pending): Mint {
            val shown = allowance.show(allowance.counts(), b, Verdict.ROOT_UNLISTABLE_ONLY, pending, recovery = null)!!
            change()
            val mint = allowance.mint(shown.id, key, verdict, fingerprint)
            assertNull("a tap uses the confirmation up, whatever it answers", allowance.shown(shown.id))
            assertEquals("and a second tap does nothing", Mint.Changed,
                allowance.mint(shown.id, key, verdict, fingerprint))
            return mint
        }
        val before = rows.count()
        assertEquals(Mint.Readable, tap({ folderCounts[Folder.PENDING] = 9 }))
        assertEquals(Mint.Changed, tap({ rows.before() }))
        assertEquals(Mint.Changed, tap({}, key = Key(TYPE, "b", "gen-new")))
        assertEquals(Mint.Retry, tap({}, verdict = Verdict.REFUSE_STORE))
        assertEquals(Mint.Retry, tap({}, verdict = Verdict.PERMITS_UNLISTABLE_ONLY))
        assertEquals(Mint.Retry, tap({}, fingerprint = discard))
        assertEquals("only the change itself moved the counter", before + 1, rows.count())
        assertFalse("and no slot was made", answer())
        val last = allowance.show(allowance.counts(), b, Verdict.ROOT_UNLISTABLE_ONLY, pending, recovery = "gen-r")!!
        assertEquals(Mint.Done(b, recovery = "gen-r"),
            allowance.mint(last.id, b, Verdict.ROOT_UNLISTABLE_ONLY, pending))
    }

    @Test fun `a new mint replaces the old slot, and a reset ends it as a process end would`() {
        val c = Key(TYPE, "c", creationId = null)
        assertTrue(minted(c) is Mint.Done)
        assertTrue(minted() is Mint.Done)
        assertFalse("replaced", answer(c))
        assertTrue("b's slot is the live one", answer())
        assertTrue(minted() is Mint.Done)
        allowance.resetForTesting()
        assertFalse(answer())
        // A fresh allowance, as in a new process, has nothing.
        val fresh = NotesRemovalAllowance(rows, { 0 }, { now }, { "x" })
        assertFalse(fresh.answer(b, Verdict.ROOT_UNLISTABLE_ONLY, pending))
    }

    @Test fun `of two answers at once exactly one holds, and none after another add or removal`() {
        repeat(200) {
            assertTrue(minted() is Mint.Done)
            val start = CountDownLatch(1)
            val held = Collections.synchronizedList(ArrayList<Boolean>())
            val callers = (1..2).map { thread { start.await(); held += answer() } }
            start.countDown()
            callers.forEach { it.join(TimeUnit.SECONDS.toMillis(10)) }
            assertEquals(listOf(false, true), held.sorted())
        }
        repeat(200) {
            assertTrue(minted() is Mint.Done)
            val base = rows.count()
            val start = CountDownLatch(1)
            var moved = -1L
            var held = false
            val mover = thread { start.await(); moved = rows.before() }
            val caller = thread { start.await(); held = answer() }
            start.countDown()
            mover.join(TimeUnit.SECONDS.toMillis(10))
            caller.join(TimeUnit.SECONDS.toMillis(10))
            // Held only when the answer's own move came first, so the other move came after it.
            if (held) assertEquals(rows.count(), moved)
            assertEquals("the other move, and the answer's own when it held", if (held) base + 2 else base + 1,
                rows.count())
        }
    }

    private companion object {
        const val TYPE = "io.silentsuite"
    }
}
