package io.silentsuite.sync.ui

import io.silentsuite.sync.R
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.DiscardOutcome
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

class CurrentAccountSignOutCoordinatorTest {
    @get:Rule val tmp = TemporaryFolder()

    private val target = ExactAccountIdentity("main", "z@example.invalid", "target-generation")
    private val sibling = ExactAccountIdentity("main", "a@example.invalid", "sibling-generation")
    private val two = UnsyncedNotes(2, 7, false)
    private val uncounted = UnsyncedNotes(0, 0, unreadable = true)

    private inner class Fake : CurrentAccountSignOutCoordinator.Seams {
        val events = mutableListOf<String>()
        var captured: CurrentAccountSignOutSnapshot? = CurrentAccountSignOutSnapshot(
            target, listOf("child" to "book"), listOf(target, sibling))
        var absent = false
        var cache = true
        var status = true
        var active = true
        var reconciledActive: ExactAccountIdentity? = sibling
        var children = true
        var listenerInvalidated = false
        var removeCalls = 0
        var closeCalls = 0
        var removeCallback: ((Boolean) -> Unit)? = null
        var childrenCallback: ((Boolean) -> Unit)? = null
        var cancelThrows = false
        var removeThrows = false
        /** What the store's count answers; while [unsyncedFails] it throws. */
        var unsynced = UnsyncedNotes.NOTHING
        var unsyncedFails = false
        /** What the clear of the store answers, or throws. */
        var discard: () -> DiscardOutcome = { DiscardOutcome.Done }
        /** The confirmation each clear was asked with, in the order asked. */
        val discardedWith = mutableListOf<UnsyncedNotes?>()
        /** When set, the removal answers this at once, from inside its request, before it returns or throws. */
        var answerAtOnce: Boolean? = null
        /** Whether a call runs off the main thread; a [Queued] runner says so while it runs a step's work. */
        var offMainNow: () -> Boolean = { false }
        /** The events that ran off the main thread, in order. */
        val offMainEvents = mutableListOf<String>()
        private fun record(event: String) {
            events += event
            if (offMainNow()) offMainEvents += event
        }
        override fun snapshot() = captured.also { record("snapshot") }
        override fun cancelSync(identity: Pair<String, String>) {
            if (cancelThrows) throw IllegalStateException("cancel failed")
            record("cancel:${identity.first}:${identity.second}")
        }
        override fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit) {
            record("remove"); removeCalls++
            removeCallback = callback
            answerAtOnce?.let(callback)
            if (removeThrows) throw IllegalStateException("remove failed")
        }
        override fun mainGenerationAbsent(main: ExactAccountIdentity) = absent.also { record("absent:$it") }
        override fun clearCache(main: ExactAccountIdentity) = cache.also { record("cache") }
        override fun clearStatus(main: ExactAccountIdentity) = status.also { record("status") }
        override fun reconcileActive(main: ExactAccountIdentity, replacement: ExactAccountIdentity?) =
            ActiveAccountReconciliation(active, reconciledActive).also { record("active:${replacement?.name}") }
        override fun removeAndVerifyChildren(snapshot: CurrentAccountSignOutSnapshot, callback: (Boolean) -> Unit) {
            record("children"); childrenCallback = callback
        }
        override fun unsyncedNotes(main: ExactAccountIdentity): UnsyncedNotes {
            record("count")
            if (unsyncedFails) throw IllegalStateException("cannot look")
            return unsynced
        }
        override fun discardPendingNotes(main: ExactAccountIdentity, confirmed: UnsyncedNotes?): DiscardOutcome {
            record("discard"); discardedWith += confirmed
            return discard()
        }
        override fun reopenPendingNotes(main: ExactAccountIdentity) { record("reopen") }
        override fun hasObservedMainGenerationInvalidation() = listenerInvalidated
        override fun close() { closeCalls++ }
    }

    /**
     * Steps wait until the test runs them: their work in [work], and then what comes back to the main thread
     * in [main], each step's result and each block sent there, in the order they came. While a step's work
     * runs, [offMainNow] is true.
     */
    private class Queued : CurrentAccountSignOutCoordinator.OffMain {
        val work = ArrayDeque<() -> Unit>()
        val main = ArrayDeque<() -> Unit>()
        var offMainNow = false

        override fun <T> run(work: () -> T, then: (T) -> Unit) {
            this.work.addLast {
                offMainNow = true
                val result = try { work() } finally { offMainNow = false }
                main.addLast { then(result) }
            }
        }

        override fun onMain(block: () -> Unit) { main.addLast(block) }

        /** Runs the next step's work, off the main thread. */
        fun runWork() = work.removeFirst()()

        /** Runs the next block on the main thread. */
        fun runMain() = main.removeFirst()()

        /** Runs what is on the main thread first, then the next work, until nothing waits. */
        fun drain() {
            while (work.isNotEmpty() || main.isNotEmpty()) if (main.isNotEmpty()) runMain() else runWork()
        }

        val idle get() = work.isEmpty() && main.isEmpty()
    }

    @Test fun `confirmed removal follows destructive boundary order and routes deterministic sibling`() {
        val f = Fake(); val c = CurrentAccountSignOutCoordinator(f)
        c.begin()
        assertEquals("the count, the cancel, the clear of the Notes store, then the removal",
            listOf("snapshot", "absent:false", "count", "cancel:main:z@example.invalid", "cancel:child:book", "discard",
                "remove"), f.events)
        assertTrue(c.state is CurrentAccountSignOutState.Removing)
        f.absent = true; f.removeCallback!!(true); f.childrenCallback!!(true)
        assertEquals("cleanup has no store step",
            listOf("absent:true", "cache", "status", "active:a@example.invalid", "children"), f.events.drop(7))
        assertEquals(CurrentAccountSignOutState.Complete(sibling), c.state)
        assertEquals(1, f.closeCalls)
    }

    @Test fun `false callback and present row preserve every destructive seam and expose one failure`() {
        val f = Fake(); val states = mutableListOf<CurrentAccountSignOutState>()
        val c = CurrentAccountSignOutCoordinator(f) { states += it }
        c.begin(); f.removeCallback!!(false)
        assertTrue(c.state is CurrentAccountSignOutState.RemovalFailed)
        assertFalse(f.events.any { it in setOf("cache", "status", "children") || it.startsWith("active:") })
        assertEquals(1, states.filterIsInstance<CurrentAccountSignOutState.RemovalFailed>().size)

        val present = Fake(); val other = CurrentAccountSignOutCoordinator(present)
        other.begin(); present.removeCallback!!(true)
        assertTrue(other.state is CurrentAccountSignOutState.RemovalFailed)
        assertFalse(present.events.contains("cache"))
    }

    @Test fun `delayed callback retains pending state and repeated tap cannot remove twice`() {
        val f = Fake(); val c = CurrentAccountSignOutCoordinator(f)
        c.begin(); c.begin()
        assertEquals(1, f.removeCalls)
        assertEquals(1, f.events.count { it == "discard" })
        assertTrue(c.state is CurrentAccountSignOutState.Removing)
    }

    @Test fun `cleanup failure retries cleanup only and never repeats absent main removal`() {
        val f = Fake().apply { absent = true; children = false }
        val c = CurrentAccountSignOutCoordinator(f)
        c.begin(); f.childrenCallback!!(false)
        assertTrue(c.state is CurrentAccountSignOutState.CleanupFailed)
        assertEquals(0, f.removeCalls)
        f.childrenCallback = null
        c.begin(); f.childrenCallback!!(true)
        assertEquals(0, f.removeCalls)
        assertTrue(c.state is CurrentAccountSignOutState.Complete)
    }

    @Test fun `replacement generation before retry cannot trigger another main removal`() {
        val f = Fake()
        val c = CurrentAccountSignOutCoordinator(f)
        c.begin()
        f.removeCallback!!(false)
        assertEquals(1, f.removeCalls)

        // The exact old generation is absent; a same-name replacement may own the platform row.
        f.absent = true
        c.begin()
        f.childrenCallback!!(true)
        assertEquals(1, f.removeCalls)
        assertTrue(c.state is CurrentAccountSignOutState.Complete)
    }

    @Test fun `confirmed removal remains cleanup only even if presence later changes`() {
        val f = Fake()
        val c = CurrentAccountSignOutCoordinator(f)
        c.begin()
        f.absent = true
        f.removeCallback!!(true)
        f.childrenCallback!!(false)
        assertTrue(c.state is CurrentAccountSignOutState.CleanupFailed)

        f.absent = false
        c.begin()
        f.childrenCallback!!(true)
        assertEquals(1, f.removeCalls)
        assertEquals("the cleanup retry clears no store", 1, f.events.count { it == "discard" })
        assertTrue(c.state is CurrentAccountSignOutState.Complete)
    }

    @Test fun `cache status and active failures stop child cleanup and remain cleanup-only retryable`() {
        listOf("cache", "status", "active").forEach { failed ->
            val f = Fake().apply {
                absent = true; cache = failed != "cache"; status = failed != "status"; active = failed != "active"
            }
            val c = CurrentAccountSignOutCoordinator(f); c.begin()
            assertTrue(c.state is CurrentAccountSignOutState.CleanupFailed)
            assertFalse(f.events.contains("children")); assertEquals(0, f.removeCalls)
        }
    }

    @Test fun `last account completes with login destination`() {
        val f = Fake().apply {
            captured = CurrentAccountSignOutSnapshot(target, emptyList(), listOf(target)); reconciledActive = null
        }
        val c = CurrentAccountSignOutCoordinator(f)
        c.begin(); f.absent = true; f.removeCallback!!(true); f.childrenCallback!!(true)
        assertEquals(CurrentAccountSignOutState.Complete(null), c.state)
    }

    @Test fun `concurrently active unrelated sibling is preserved as route`() {
        val other = ExactAccountIdentity("main", "b@example.invalid", "other-generation")
        val f = Fake().apply { reconciledActive = other }
        val c = CurrentAccountSignOutCoordinator(f); c.begin(); f.absent = true
        f.removeCallback!!(true); f.childrenCallback!!(true)
        assertEquals(CurrentAccountSignOutState.Complete(other), c.state)
    }

    @Test fun `monotonic listener invalidation is exposed independently of exact routing`() {
        val f = Fake()
        val c = CurrentAccountSignOutCoordinator(f)
        assertFalse(c.hasObservedMainGenerationInvalidation())

        f.listenerInvalidated = true
        assertTrue(c.hasObservedMainGenerationInvalidation())
        // The seam remains monotonic even if a same-name replacement makes a later direct
        // routing read look present again.
        f.absent = false
        assertTrue(c.hasObservedMainGenerationInvalidation())
    }

    @Test fun `the count comes through the seam, and a seam that cannot look says something may be there`() {
        val f = Fake().apply { unsynced = UnsyncedNotes(2, 7, false) }
        val c = CurrentAccountSignOutCoordinator(f)
        assertEquals(UnsyncedNotes(2, 7, false), c.unsyncedNotes(target))
        f.unsyncedFails = true
        assertEquals(UnsyncedNotes(0, 0, unreadable = true), c.unsyncedNotes(target))
        assertTrue(c.unsyncedNotes(target).anything)
        assertTrue("asking only counts", f.events.all { it == "count" })
        assertEquals(CurrentAccountSignOutState.Idle, c.state)
    }

    @Test fun `unsynced Notes changes no confirmation covers refuse the sign-out before anything is canceled`() {
        val f = Fake().apply { unsynced = two }
        val states = mutableListOf<CurrentAccountSignOutState>()
        val c = CurrentAccountSignOutCoordinator(f) { states += it }
        c.begin()
        assertEquals(CurrentAccountSignOutState.Refused, c.state)
        assertEquals("counted, and nothing canceled, cleared or removed", listOf("snapshot", "absent:false", "count"),
            f.events)
        // A confirmation for another answer, or for another account, does not cover it either.
        c.confirmNotesDiscard(target, UnsyncedNotes(2, 6, false)); c.begin()
        assertEquals(CurrentAccountSignOutState.Refused, c.state)
        c.confirmNotesDiscard(sibling, two); c.begin()
        assertEquals(CurrentAccountSignOutState.Refused, c.state)
        assertEquals(0, f.removeCalls)
        assertTrue(f.discardedWith.isEmpty())
        assertFalse(f.events.any { it.startsWith("cancel:") })
        assertEquals("a refused attempt keeps no snapshot", 3, f.events.count { it == "snapshot" })
        // A confirmation for what the store holds lets the sign-out go on, and the clear is asked with it.
        c.confirmNotesDiscard(target, two); c.begin()
        assertTrue(c.state is CurrentAccountSignOutState.Removing)
        assertEquals(listOf<UnsyncedNotes?>(two), f.discardedWith)
        assertEquals(1, f.removeCalls)
        assertEquals(3, states.count { it == CurrentAccountSignOutState.Refused })
    }

    @Test fun `a count that throws could not be counted, and a confirmation given for that answer covers it`() {
        val f = Fake().apply { unsyncedFails = true }
        val c = CurrentAccountSignOutCoordinator(f)
        c.begin()
        assertEquals("never read as nothing", CurrentAccountSignOutState.Refused, c.state)
        assertEquals(0, f.removeCalls)
        val shown = c.unsyncedNotes(target)
        assertEquals(uncounted, shown)
        c.confirmNotesDiscard(target, shown); c.begin()
        assertTrue(c.state is CurrentAccountSignOutState.Removing)
        assertEquals(listOf<UnsyncedNotes?>(uncounted), f.discardedWith)
        assertEquals(1, f.removeCalls)
    }

    @Test fun `a change the store finds at its clear refuses the sign-out, and the account is not removed`() {
        val f = Fake().apply { unsynced = two; discard = { DiscardOutcome.Changed(UnsyncedNotes(3, 8, false)) } }
        val c = CurrentAccountSignOutCoordinator(f)
        c.confirmNotesDiscard(target, two); c.begin()
        assertEquals(CurrentAccountSignOutState.Refused, c.state)
        assertEquals(listOf("snapshot", "absent:false", "count", "cancel:main:z@example.invalid", "cancel:child:book",
            "discard"), f.events)
        assertEquals("the removal is never asked for", 0, f.removeCalls)
        assertFalse("nothing was cleared, so nothing is reopened", f.events.contains("reopen"))
        // The screen takes the refusal back to idle and shows the count again. The next attempt needs a new
        // confirmation.
        c.acknowledgeRefusal()
        assertEquals(CurrentAccountSignOutState.Idle, c.state)
        f.discard = { DiscardOutcome.Done }
        c.begin()
        assertEquals("the confirmation went with the refused attempt", CurrentAccountSignOutState.Refused, c.state)
        assertEquals(0, f.removeCalls)
    }

    @Test fun `a clear that fails, records no permit or stops keeps the account and drops the confirmation`() {
        val outcomes = listOf<Pair<String, () -> DiscardOutcome>>(
            "IOException" to { throw IOException("disk") },
            "PermitNotRecorded" to { DiscardOutcome.PermitNotRecorded },
            "NotFinished" to { DiscardOutcome.NotFinished },
        )
        for ((name, outcome) in outcomes) {
            val f = Fake().apply { unsynced = two; discard = outcome }
            val c = CurrentAccountSignOutCoordinator(f)
            c.confirmNotesDiscard(target, two); c.begin()
            // A permit that could not be recorded deleted nothing, so no confirmed change is said to be gone.
            val discarded = name != "PermitNotRecorded"
            assertEquals(name, CurrentAccountSignOutState.NotesClearFailed(1, notesDiscarded = discarded), c.state)
            assertEquals("$name: the removal is never asked for", 0, f.removeCalls)
            assertFalse("$name: no cleanup step", f.events.any { it in setOf("cache", "status", "children") })
            assertFalse("$name: the clear did not finish, so nothing is reopened", f.events.contains("reopen"))
            f.discard = { DiscardOutcome.Done }
            c.begin()
            assertEquals("$name: the confirmation went with the attempt", CurrentAccountSignOutState.Refused, c.state)
            assertEquals("$name: and so did the snapshot", 2, f.events.count { it == "snapshot" })
            assertEquals(0, f.removeCalls)
        }
    }

    @Test fun `a clear that stops with nothing unsynced keeps the account and says no confirmed changes went`() {
        val f = Fake().apply { discard = { DiscardOutcome.NotFinished } }
        val c = CurrentAccountSignOutCoordinator(f)
        c.begin()
        assertEquals(CurrentAccountSignOutState.NotesClearFailed(1, notesDiscarded = false), c.state)
        assertEquals("the clear was asked with no confirmation", listOf<UnsyncedNotes?>(null), f.discardedWith)
        assertEquals("the removal is never asked for", 0, f.removeCalls)
    }

    @Test fun `a store that could not be listed deletes nothing, and the account stays, recorded or not`() {
        val unlisted = UnsyncedNotes(0, 7, unreadable = true, listed = false)
        val outcomes = listOf(
            DiscardOutcome.Acknowledged to CurrentAccountSignOutState.NotesClearFailed.Acknowledgement.RECORDED,
            DiscardOutcome.AcknowledgementNotRecorded to
                CurrentAccountSignOutState.NotesClearFailed.Acknowledgement.NOT_RECORDED,
        )
        for ((outcome, acknowledgement) in outcomes) {
            val name = outcome.javaClass.simpleName
            val f = Fake().apply { unsynced = unlisted; discard = { outcome } }
            val c = CurrentAccountSignOutCoordinator(f)
            c.confirmNotesDiscard(target, unlisted); c.begin()
            assertEquals(name, CurrentAccountSignOutState.NotesClearFailed(1, notesDiscarded = false, acknowledgement),
                c.state)
            assertEquals("$name: the clear was asked with the confirmation", listOf<UnsyncedNotes?>(unlisted),
                f.discardedWith)
            assertEquals("$name: the removal is never asked for", 0, f.removeCalls)
            assertFalse("$name: no cleanup step",
                f.events.any { it in setOf("cache", "status", "children") || it.startsWith("active:") })
            assertFalse("$name: nothing was cleared, so nothing is reopened", f.events.contains("reopen"))
            // The confirmation went with the attempt, and so did the snapshot.
            c.begin()
            assertEquals("$name: asked again", CurrentAccountSignOutState.Refused, c.state)
            assertEquals("$name: a new snapshot", 2, f.events.count { it == "snapshot" })
            // Once the store lists, a confirmation of the real count lets the sign-out finish.
            f.unsynced = two; f.discard = { DiscardOutcome.Done }
            c.confirmNotesDiscard(target, two); c.begin()
            assertTrue("$name: ${c.state}", c.state is CurrentAccountSignOutState.Removing)
            f.absent = true; f.removeCallback!!(true); f.childrenCallback!!(true)
            assertTrue("$name: ${c.state}", c.state is CurrentAccountSignOutState.Complete)
            assertEquals(listOf<UnsyncedNotes?>(unlisted, two), f.discardedWith)
            assertEquals(1, f.removeCalls)
        }
    }

    @Test fun `a sign-out after a clear that stopped, over a store that cannot be listed, says what may be gone`() {
        // A real store, so the outcome is the store's own. Its directories get an identity, as on a device.
        PendingNotesStore.identityForTesting = { d ->
            if (d.isDirectory) PendingNotesStore.DirectoryIdentity(device = 7, inode = 1) else null
        }
        try {
            val store = PendingNotesStore.forNoBackup(tmp.newFolder("no_backup"), target.type, target.name,
                target.creationId, syncDirectory = {}, rename = { from, to ->
                    java.nio.file.Files.move(from.toPath(), to.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING)
                })
            store.saveLocal("n1", "b1", "r1", "a".toByteArray(), isCreate = false)
            store.saveLocal("n2", "b1", "r1", "b".toByteArray(), isCreate = false)
            val f = Fake()
            val c = CurrentAccountSignOutCoordinator(object : CurrentAccountSignOutCoordinator.Seams by f {
                override fun unsyncedNotes(main: ExactAccountIdentity) = store.unsynced()
                override fun discardPendingNotes(main: ExactAccountIdentity, confirmed: UnsyncedNotes?) =
                    store.discardStore(confirmed)
            })

            // 1. A confirmed sign-out whose clear deletes n1 and stops: the store's instance is closed.
            val shown = c.unsyncedNotes(target)
            PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw IOException("stopped") }
            c.confirmNotesDiscard(target, shown); c.begin()
            PendingNotesStore.beforeRemoveForTesting = null
            assertEquals(CurrentAccountSignOutState.NotesClearFailed(1, notesDiscarded = true), c.state)
            assertFalse("the clear deleted before it stopped", File(store.dir, "n1.note").exists())

            // 2. The store cannot be listed now, and the user goes on over what the dialog shows. That is no
            // acknowledgement: the sign-out reports a clear that did not finish, not that nothing was deleted.
            PendingNotesStore.listFilesForTesting = { d -> if (d.name == store.dir.name) null else d.listFiles() }
            val unlisted = c.unsyncedNotes(target)
            assertFalse(unlisted.listed)
            c.confirmNotesDiscard(target, unlisted); c.begin()
            assertEquals(CurrentAccountSignOutState.NotesClearFailed(2, notesDiscarded = true), c.state)
            assertEquals(R.string.notes_sign_out_stopped, UnsyncedNotesSignOutPolicy.failureMessage(c.state))
            assertFalse(store.acknowledged())
            assertEquals("the removal is never asked for", 0, f.removeCalls)

            // 3. Once the store lists again, a sign-out confirmed for what is left finishes.
            PendingNotesStore.listFilesForTesting = null
            val left = c.unsyncedNotes(target)
            assertEquals(1, left.count)
            c.confirmNotesDiscard(target, left); c.begin()
            assertTrue("${c.state}", c.state is CurrentAccountSignOutState.Removing)
            assertFalse("the store is gone before the removal", store.dir.exists())
            f.absent = true; f.removeCallback!!(true); f.childrenCallback!!(true)
            assertTrue("${c.state}", c.state is CurrentAccountSignOutState.Complete)
            assertEquals(1, f.removeCalls)
        } finally {
            PendingNotesStore.beforeRemoveForTesting = null
            PendingNotesStore.listFilesForTesting = null
            PendingNotesStore.identityForTesting = null
            PendingNotesStore.resetForTesting()
        }
    }

    @Test fun `only a clear shown finished lets the removal be asked for`() {
        val outcomes = listOf<Pair<String, () -> DiscardOutcome>>(
            "IOException" to { throw IOException("disk") },
            "Changed" to { DiscardOutcome.Changed(two) },
            "PermitNotRecorded" to { DiscardOutcome.PermitNotRecorded },
            "NotFinished" to { DiscardOutcome.NotFinished },
            "Acknowledged" to { DiscardOutcome.Acknowledged },
            "AcknowledgementNotRecorded" to { DiscardOutcome.AcknowledgementNotRecorded },
            "Done" to { DiscardOutcome.Done },
        )
        for ((name, outcome) in outcomes) {
            val f = Fake().apply { unsynced = two; discard = outcome }
            val c = CurrentAccountSignOutCoordinator(f)
            c.confirmNotesDiscard(target, two); c.begin()
            assertEquals(name, if (name == "Done") 1 else 0, f.removeCalls)
        }
    }

    @Test fun `a second confirmed sign-out finishes a clear that stopped`() {
        val f = Fake().apply { unsynced = two; discard = { DiscardOutcome.NotFinished } }
        val c = CurrentAccountSignOutCoordinator(f)
        c.confirmNotesDiscard(target, two); c.begin()
        assertTrue(c.state is CurrentAccountSignOutState.NotesClearFailed)
        f.discard = { DiscardOutcome.Done }
        c.confirmNotesDiscard(target, two); c.begin()
        assertTrue(c.state is CurrentAccountSignOutState.Removing)
        assertEquals(listOf<UnsyncedNotes?>(two, two), f.discardedWith)
        f.absent = true; f.removeCallback!!(true); f.childrenCallback!!(true)
        assertTrue(c.state is CurrentAccountSignOutState.Complete)
        assertEquals(1, f.removeCalls)
    }

    @Test fun `after a restart a new coordinator asks again before it finishes a clear that stopped`() {
        val f = Fake().apply { unsynced = two; discard = { DiscardOutcome.NotFinished } }
        val c = CurrentAccountSignOutCoordinator(f)
        c.confirmNotesDiscard(target, two); c.begin()
        assertTrue(c.state is CurrentAccountSignOutState.NotesClearFailed)
        // The restart: the store holds what the stopped clear left, and the confirmation went with the process.
        f.discard = { DiscardOutcome.Done }
        val restarted = CurrentAccountSignOutCoordinator(f)
        restarted.begin()
        assertEquals(CurrentAccountSignOutState.Refused, restarted.state)
        assertEquals(listOf<UnsyncedNotes?>(two), f.discardedWith)
        restarted.confirmNotesDiscard(target, two); restarted.begin()
        assertTrue(restarted.state is CurrentAccountSignOutState.Removing)
        assertEquals(listOf<UnsyncedNotes?>(two, two), f.discardedWith)
        f.absent = true; f.removeCallback!!(true); f.childrenCallback!!(true)
        assertTrue(restarted.state is CurrentAccountSignOutState.Complete)
        assertEquals(1, f.removeCalls)
    }

    @Test fun `a removal that fails after the clear reopens the store and says whether confirmed changes went`() {
        val f = Fake().apply { unsynced = two }
        val c = CurrentAccountSignOutCoordinator(f)
        c.confirmNotesDiscard(target, two); c.begin(); f.removeCallback!!(false)
        assertEquals(CurrentAccountSignOutState.RemovalFailed(1, notesDiscarded = true, notesCleared = true), c.state)
        assertEquals("the cleared store is reopened once the removal failed", listOf("discard", "remove", "reopen"),
            f.events.filter { it in setOf("discard", "remove", "reopen") })
        // With nothing unsynced, the failure still says that the store was cleared, and the cleared store is
        // reopened as well.
        val plain = Fake()
        val p = CurrentAccountSignOutCoordinator(plain)
        p.begin(); plain.removeCallback!!(false)
        assertEquals(CurrentAccountSignOutState.RemovalFailed(1, notesDiscarded = false, notesCleared = true), p.state)
        assertTrue(plain.events.contains("reopen"))
        // A removal that throws, and one that answers yes while the row is still there, reopen it too.
        val thrower = Fake().apply { removeThrows = true }
        val t = CurrentAccountSignOutCoordinator(thrower)
        t.begin()
        assertEquals(CurrentAccountSignOutState.RemovalFailed(1, notesDiscarded = false, notesCleared = true), t.state)
        assertEquals(listOf("discard", "remove", "reopen"),
            thrower.events.filter { it in setOf("discard", "remove", "reopen") })
        val present = Fake()
        val q = CurrentAccountSignOutCoordinator(present)
        q.begin(); present.removeCallback!!(true)
        assertEquals(CurrentAccountSignOutState.RemovalFailed(1, notesDiscarded = false, notesCleared = true), q.state)
        assertTrue(present.events.contains("reopen"))
        // A failure before the clear neither clears nor reopens anything, and says that nothing was cleared.
        val early = Fake().apply { cancelThrows = true }
        val e = CurrentAccountSignOutCoordinator(early)
        e.begin()
        assertEquals(CurrentAccountSignOutState.RemovalFailed(1, notesDiscarded = false, notesCleared = false), e.state)
        assertFalse(early.events.contains("discard") || early.events.contains("reopen"))
    }

    @Test fun `the store of an account already gone is cleared only as far as it is covered, and cleanup goes on`() {
        // No confirmation: the clear is asked with none, and a store that holds anything keeps it (the stand-in
        // answers Changed, as the store does). Nothing is refused or removed, and cleanup goes on.
        val kept = Fake().apply { absent = true; unsynced = two; discard = { DiscardOutcome.Changed(two) } }
        val c = CurrentAccountSignOutCoordinator(kept)
        c.begin()
        assertTrue(c.state is CurrentAccountSignOutState.CleaningUp)
        kept.childrenCallback!!(true)
        assertTrue(c.state is CurrentAccountSignOutState.Complete)
        assertEquals(listOf("snapshot", "absent:true", "discard", "cache", "status", "active:a@example.invalid",
            "children"), kept.events)
        assertEquals(listOf<UnsyncedNotes?>(null), kept.discardedWith)
        assertEquals(0, kept.removeCalls)
        // With a confirmation for that account, the clear is asked with it.
        val covered = Fake().apply { absent = true; unsynced = two }
        val d = CurrentAccountSignOutCoordinator(covered)
        d.confirmNotesDiscard(target, two); d.begin()
        assertEquals(listOf<UnsyncedNotes?>(two), covered.discardedWith)
        assertTrue(d.state is CurrentAccountSignOutState.CleaningUp)
        // A clear that throws there does not stop cleanup, and a cleanup retry asks for no clear again.
        val failing = Fake().apply { absent = true; discard = { throw IOException("disk") } }
        val e = CurrentAccountSignOutCoordinator(failing)
        e.begin()
        assertTrue(e.state is CurrentAccountSignOutState.CleaningUp)
        failing.childrenCallback!!(false)
        assertTrue(e.state is CurrentAccountSignOutState.CleanupFailed)
        e.begin(); failing.childrenCallback!!(true)
        assertTrue(e.state is CurrentAccountSignOutState.Complete)
        assertEquals(1, failing.events.count { it == "discard" })
    }

    @Test fun `the discard confirmation does not outlive the attempt it was given for`() {
        // A removal that fails before the clear: the next attempt is refused until the confirmation is given again.
        var f = Fake().apply { unsynced = two; cancelThrows = true }
        var c = CurrentAccountSignOutCoordinator(f)
        c.confirmNotesDiscard(target, two); c.begin()
        assertTrue(c.state is CurrentAccountSignOutState.RemovalFailed)
        f.cancelThrows = false; c.begin()
        assertEquals(CurrentAccountSignOutState.Refused, c.state)
        // A removal that fails after the clear.
        f = Fake().apply { unsynced = two }; c = CurrentAccountSignOutCoordinator(f)
        c.confirmNotesDiscard(target, two); c.begin(); f.removeCallback!!(false)
        c.begin()
        assertEquals(CurrentAccountSignOutState.Refused, c.state)
        // No snapshot could be taken.
        f = Fake().apply { unsynced = two; captured = null }; c = CurrentAccountSignOutCoordinator(f)
        c.confirmNotesDiscard(target, two); c.begin()
        assertTrue(c.state is CurrentAccountSignOutState.RemovalFailed)
        f.captured = CurrentAccountSignOutSnapshot(target, emptyList(), listOf(target)); c.begin()
        assertEquals(CurrentAccountSignOutState.Refused, c.state)
        // One given while a removal is under way goes when that attempt ends.
        f = Fake().apply { unsynced = two }; c = CurrentAccountSignOutCoordinator(f)
        c.confirmNotesDiscard(target, two); c.begin()
        c.confirmNotesDiscard(target, two)
        f.removeCallback!!(false)
        c.begin()
        assertEquals(CurrentAccountSignOutState.Refused, c.state)
        assertEquals("no attempt after the first was cleared", 1, f.events.count { it == "discard" })
    }

    @Test fun `an acknowledged refusal returns to idle and the next attempt takes a new snapshot`() {
        val f = Fake().apply { unsynced = two }
        val states = mutableListOf<CurrentAccountSignOutState>()
        val c = CurrentAccountSignOutCoordinator(f) { states += it }
        c.begin(); c.acknowledgeRefusal()
        assertEquals(CurrentAccountSignOutState.Idle, c.state)
        assertEquals("the refusal and the return to idle are both reported", listOf(CurrentAccountSignOutState.Idle,
            CurrentAccountSignOutState.Refused, CurrentAccountSignOutState.Idle), states)
        c.confirmNotesDiscard(target, two); c.begin()
        assertEquals("a refused attempt keeps no snapshot", 2, f.events.count { it == "snapshot" })
        // Acknowledging while a removal is under way, or after it failed, changes nothing.
        c.acknowledgeRefusal()
        assertTrue(c.state is CurrentAccountSignOutState.Removing)
        f.removeCallback!!(false); c.acknowledgeRefusal()
        assertTrue(c.state is CurrentAccountSignOutState.RemovalFailed)
    }

    @Test fun `every call that reaches the store, and the removal request, runs off the main thread, in order`() {
        val q = Queued()
        val f = Fake().apply { unsynced = two; offMainNow = { q.offMainNow } }
        val c = CurrentAccountSignOutCoordinator(f, q)
        c.confirmNotesDiscard(target, two); c.begin()
        assertEquals("nothing reaches the store on the main thread", listOf("snapshot", "absent:false"), f.events)
        assertEquals(CurrentAccountSignOutState.Idle, c.state)
        q.runWork()
        assertEquals("the count, off the main thread", listOf("count"), f.offMainEvents)
        assertEquals("nothing is canceled before its answer is back", 3, f.events.size)
        q.runMain()
        assertTrue(c.state is CurrentAccountSignOutState.Removing)
        assertEquals("the cancels, on the main thread, before the clear", listOf("snapshot", "absent:false", "count",
            "cancel:main:z@example.invalid", "cancel:child:book"), f.events)
        q.runWork()
        assertEquals("the clear and the removal request, in one step off the main thread",
            listOf("count", "discard", "remove"), f.offMainEvents)
        assertEquals("nothing in between", listOf("discard", "remove"), f.events.drop(5))
        q.runMain()
        assertTrue(c.state is CurrentAccountSignOutState.Removing)
        // The removal fails: its answer is taken on the main thread, and the store is reopened off it.
        f.removeCallback!!(false)
        assertTrue("the answer waits for the main thread", c.state is CurrentAccountSignOutState.Removing)
        q.runMain()
        assertTrue("removing until the store is reopened", c.state is CurrentAccountSignOutState.Removing)
        q.runWork()
        assertEquals(listOf("count", "discard", "remove", "reopen"), f.offMainEvents)
        q.runMain()
        assertEquals(CurrentAccountSignOutState.RemovalFailed(1, notesDiscarded = true, notesCleared = true), c.state)
        assertTrue(q.idle)

        // A removal that goes through: its answer and every cleanup step run on the main thread.
        val g = Fake().apply { offMainNow = { q.offMainNow } }
        val d = CurrentAccountSignOutCoordinator(g, q)
        d.begin(); q.drain()
        g.absent = true; g.removeCallback!!(true); q.drain(); g.childrenCallback!!(true)
        assertEquals(CurrentAccountSignOutState.Complete(sibling), d.state)
        assertEquals(listOf("count", "discard", "remove"), g.offMainEvents)
        assertEquals(listOf("absent:true", "cache", "status", "active:a@example.invalid", "children"), g.events.drop(7))
    }

    @Test fun `a second begin() while a step is in flight starts nothing`() {
        val q = Queued()
        val f = Fake().apply { unsynced = two }
        val c = CurrentAccountSignOutCoordinator(f, q)
        c.confirmNotesDiscard(target, two); c.begin()
        // During the count the state is still idle.
        c.begin()
        assertEquals("one count asked for", 1, q.work.size)
        assertEquals(1, f.events.count { it == "snapshot" })
        q.runWork(); q.runMain()
        // During the clear, and during the reopening after the removal failed, the attempt is removing.
        c.begin()
        q.runWork(); q.runMain()
        f.removeCallback!!(false); q.runMain()
        c.begin()
        q.drain()
        assertTrue(c.state is CurrentAccountSignOutState.RemovalFailed)
        // A retry: during its count the state is the failure, not removing, and a second begin() still starts
        // nothing.
        c.confirmNotesDiscard(target, two); c.begin()
        assertTrue(c.state is CurrentAccountSignOutState.RemovalFailed)
        c.begin()
        assertEquals("one count asked for", 1, q.work.size)
        q.drain()
        assertTrue(c.state is CurrentAccountSignOutState.Removing)
        assertEquals("two attempts, each counted, cleared and removed once", listOf(2, 2, 2),
            listOf("count", "discard", "remove").map { event -> f.events.count { it == event } })
    }

    @Test fun `the removal's answer and the end of the step that asked for it can come in either order`() {
        // The answer first, from inside the request, then the end of the step, which changes nothing.
        val q = Queued()
        val f = Fake().apply { unsynced = two }
        val c = CurrentAccountSignOutCoordinator(f, q)
        c.confirmNotesDiscard(target, two); c.begin(); q.runWork(); q.runMain()
        f.absent = true; f.answerAtOnce = true
        q.runWork()
        assertEquals("the answer and the end of the step wait on the main thread", 2, q.main.size)
        q.runMain()
        assertTrue(c.state is CurrentAccountSignOutState.CleaningUp)
        q.runMain()
        assertTrue("the end of the step changed nothing", c.state is CurrentAccountSignOutState.CleaningUp)
        f.childrenCallback!!(true)
        assertEquals(CurrentAccountSignOutState.Complete(sibling), c.state)

        // The end of the step first, then the answer, as the platform's answer comes.
        val g = Fake().apply { unsynced = two }
        val d = CurrentAccountSignOutCoordinator(g, q)
        d.confirmNotesDiscard(target, two); d.begin(); q.drain()
        assertTrue(d.state is CurrentAccountSignOutState.Removing)
        g.absent = true; g.removeCallback!!(true); q.drain(); g.childrenCallback!!(true)
        assertEquals(CurrentAccountSignOutState.Complete(sibling), d.state)

        // A no from inside the request, which then throws: the answer comes first and counts, and the end of the
        // step, which saw the throw, changes nothing. The store is reopened once, and one failure is reported.
        val h = Fake().apply { unsynced = two }
        val hStates = mutableListOf<CurrentAccountSignOutState>()
        val e = CurrentAccountSignOutCoordinator(h, q) { hStates += it }
        e.confirmNotesDiscard(target, two); e.begin(); q.runWork(); q.runMain()
        h.answerAtOnce = false; h.removeThrows = true
        q.drain()
        assertEquals(CurrentAccountSignOutState.RemovalFailed(1, notesDiscarded = true, notesCleared = true), e.state)
        assertEquals("reopened once", 1, h.events.count { it == "reopen" })
        assertEquals("one failure reported", 1, hStates.count { it is CurrentAccountSignOutState.RemovalFailed })

        // A request that throws with no answer fails the attempt at the end of its step. An answer that comes
        // after, here a yes for an account that is gone, is not taken, also while the store is being reopened.
        val k = Fake().apply { unsynced = two; removeThrows = true }
        val m = CurrentAccountSignOutCoordinator(k, q)
        m.confirmNotesDiscard(target, two); m.begin(); q.runWork(); q.runMain(); q.runWork(); q.runMain()
        assertTrue(m.state is CurrentAccountSignOutState.Removing)
        k.absent = true; k.removeCallback!!(true); q.drain()
        assertEquals(CurrentAccountSignOutState.RemovalFailed(1, notesDiscarded = true, notesCleared = true), m.state)
        assertFalse("no cleanup step", k.events.any { it in setOf("cache", "status", "children") })
        assertEquals(1, k.events.count { it == "reopen" })

        // An answer that comes twice counts once.
        val n = Fake().apply { unsynced = two }
        val nStates = mutableListOf<CurrentAccountSignOutState>()
        val p = CurrentAccountSignOutCoordinator(n, q) { nStates += it }
        p.confirmNotesDiscard(target, two); p.begin(); q.drain()
        n.removeCallback!!(false); n.removeCallback!!(false); q.drain()
        assertEquals(1, n.events.count { it == "reopen" })
        assertEquals(1, nStates.count { it is CurrentAccountSignOutState.RemovalFailed })
    }

    @Test fun `an account already gone is cleaning up from before its clear, which runs off the main thread`() {
        val q = Queued()
        val f = Fake().apply { absent = true; unsynced = two; offMainNow = { q.offMainNow } }
        val states = mutableListOf<CurrentAccountSignOutState>()
        val c = CurrentAccountSignOutCoordinator(f, q) { states += it }
        c.confirmNotesDiscard(target, two); c.begin()
        assertEquals("cleaning up while the clear is in flight", CurrentAccountSignOutState.CleaningUp, c.state)
        assertEquals(listOf("snapshot", "absent:true"), f.events)
        c.begin()
        assertEquals("a second begin() starts nothing", 1, q.work.size)
        q.runWork()
        assertEquals(listOf("discard"), f.offMainEvents)
        assertEquals(listOf<UnsyncedNotes?>(two), f.discardedWith)
        assertEquals("cleanup waits for the clear", 3, f.events.size)
        q.runMain()
        assertEquals(listOf("snapshot", "absent:true", "discard", "cache", "status", "active:a@example.invalid",
            "children"), f.events)
        f.childrenCallback!!(true)
        assertEquals("cleaning up is reported once", listOf(CurrentAccountSignOutState.Idle,
            CurrentAccountSignOutState.CleaningUp, CurrentAccountSignOutState.Complete(sibling)), states)
        assertEquals(listOf("discard"), f.offMainEvents)
        assertEquals(0, f.removeCalls)
    }

    @Test fun `an attempt takes the confirmation once, when it begins, and one given while it runs goes with it`() {
        val q = Queued()
        val f = Fake().apply { unsynced = two }
        val c = CurrentAccountSignOutCoordinator(f, q)
        c.confirmNotesDiscard(target, two); c.begin()
        // One for another answer, given while the count is in flight, is not the attempt's.
        c.confirmNotesDiscard(target, UnsyncedNotes(3, 8, false)); c.begin()
        q.runWork(); q.runMain()
        assertTrue("the attempt goes on with the confirmation it took: ${c.state}",
            c.state is CurrentAccountSignOutState.Removing)
        q.drain()
        assertEquals("and the clear is asked with it", listOf<UnsyncedNotes?>(two), f.discardedWith)
        f.removeCallback!!(false); q.drain()
        assertTrue(c.state is CurrentAccountSignOutState.RemovalFailed)
        // The one given while it ran went when it ended, so the next attempt is refused at its count.
        c.begin(); q.drain()
        assertEquals(CurrentAccountSignOutState.Refused, c.state)
        assertEquals(1, f.events.count { it == "discard" })
    }
}
