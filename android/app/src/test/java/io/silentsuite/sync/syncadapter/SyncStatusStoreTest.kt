package io.silentsuite.sync.syncadapter

import android.accounts.Account
import java.util.IdentityHashMap
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

class SyncStatusStoreTest {
    private class MemoryStorage : SyncStatusStore.Storage {
        val values = mutableMapOf<String, String>()
        var failNextCommit = false
        var failAllCommits = false
        var commits = 0

        override fun get(key: String) = values[key]
        override fun commit(puts: Map<String, String>, removes: Set<String>): Boolean {
            commits++
            if (failAllCommits || failNextCommit) {
                failNextCommit = false
                return false
            }
            val next = values.toMutableMap()
            removes.forEach(next::remove)
            next.putAll(puts)
            values.clear()
            values.putAll(next)
            return true
        }
    }

    private val first = Account("first@example.invalid", "main")
    private val second = Account("second@example.invalid", "main")
    private val readdedFirst = Account("first@example.invalid", "main")
    private val storage = MemoryStorage()
    private val namespace = UUID.randomUUID().toString()
    private val mainKeys = IdentityHashMap<Account, String>().apply {
        put(first, "first-generation-$namespace")
        put(second, "second-generation-$namespace")
        put(readdedFirst, "readded-generation-$namespace")
    }
    private val childKeys = IdentityHashMap<Account, String>()
    private val store = SyncStatusStore(
        storage,
        mainAccountKey = { mainKeys[it] ?: error("missing main test identity") },
        childAccountKey = { childKeys[it] ?: error("missing child test identity") },
    )

    private fun child(name: String): Account = Account(name, "child").also {
        childKeys[it] = "child-${childKeys.size}"
    }

    private fun started(result: SyncStatusStore.ContactsStart) =
        (result as SyncStatusStore.ContactsStart.Started).attemptId

    private fun freshStore() = SyncStatusStore(
        storage,
        mainAccountKey = { mainKeys[it] ?: error("missing main test identity") },
        childAccountKey = { childKeys[it] ?: error("missing child test identity") },
    )

    @Test fun `success and bounded failure records are atomic isolated and privacy bounded`() {
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 10))
        val before = storage.commits
        assertTrue(store.recordFailure(first, SyncStatusStore.Service.TASKS, SyncStatusStore.FailureCategory.NETWORK, 20))
        assertEquals(before + 1, storage.commits)

        assertEquals(10L, store.status(first, SyncStatusStore.Service.CALENDAR).lastSuccessAt)
        assertEquals(SyncStatusStore.FailureCategory.NETWORK, store.status(first, SyncStatusStore.Service.TASKS).lastFailureCategory)
        assertEquals(SyncStatusStore.Status(), store.status(second, SyncStatusStore.Service.CALENDAR))
        assertEquals(SyncStatusStore.Status(), store.status(readdedFirst, SyncStatusStore.Service.CALENDAR))
        assertFalse(storage.values.toString().contains("example.invalid"))
    }

    @Test fun `failed direct outcome is durably failed closed and successful retry removes sentinel`() {
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 50))
        storage.failNextCommit = true
        assertFalse(store.recordFailure(first, SyncStatusStore.Service.CALENDAR, SyncStatusStore.FailureCategory.PERMISSION, 60))
        val failedClosed = freshStore().status(first, SyncStatusStore.Service.CALENDAR)
        assertEquals(50L, failedClosed.lastSuccessAt)
        assertEquals(SyncStatusStore.FailureCategory.STORAGE, failedClosed.lastFailureCategory)
        assertTrue(failedClosed.lastFailureAt!! > failedClosed.lastSuccessAt!!)
        val persistedFaultAt = storage.values.entries
            .single { (key, _) -> key.startsWith("fault.") && key.endsWith(".CALENDAR") }
            .value.split('|')[1].toLong()
        assertEquals(persistedFaultAt, failedClosed.lastFailureAt)
        assertEquals(
            failedClosed.lastFailureAt,
            freshStore().status(first, SyncStatusStore.Service.CALENDAR).lastFailureAt,
        )

        assertTrue(store.recordFailure(first, SyncStatusStore.Service.CALENDAR, SyncStatusStore.FailureCategory.PERMISSION, 60))
        assertEquals(SyncStatusStore.FailureCategory.PERMISSION, freshStore().status(first, SyncStatusStore.Service.CALENDAR).lastFailureCategory)
    }

    @Test fun `new evidence is ordered without erasing the previous outcome`() {
        store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 50)
        store.recordFailure(first, SyncStatusStore.Service.CALENDAR, SyncStatusStore.FailureCategory.PERMISSION, 50)
        val failed = store.status(first, SyncStatusStore.Service.CALENDAR)
        assertEquals(50L, failed.lastSuccessAt)
        assertEquals(51L, failed.lastFailureAt)

        store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 50)
        assertEquals(52L, store.status(first, SyncStatusStore.Service.CALENDAR).lastSuccessAt)
    }

    @Test fun `latest contacts generation stays incomplete over historical success`() {
        val childOne = child("book-one")
        val firstAttempt = started(store.beginContacts(first, setOf(childOne)))
        assertEquals(SyncStatusStore.ChildWrite.RECORDED, store.recordContactsChild(first, firstAttempt, childOne, SyncStatusStore.ChildResult.SUCCESS))
        val oldSuccess = store.status(first, SyncStatusStore.Service.CONTACTS).lastSuccessAt

        val childTwo = child("book-two")
        started(store.beginContacts(first, setOf(childOne, childTwo)))
        val pending = store.status(first, SyncStatusStore.Service.CONTACTS)
        assertEquals(oldSuccess, pending.lastSuccessAt)
        assertTrue(pending.latestGenerationIncomplete)
        assertEquals(2, pending.pendingChildren)
    }

    @Test fun `contacts status snapshots creation identity once`() {
        val child = child("identity-snapshot-book")
        val attempt = started(store.beginContacts(first, setOf(child)))
        assertEquals(
            SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, attempt, child, SyncStatusStore.ChildResult.SUCCESS),
        )

        var lookups = 0
        val changingIdentityStore = SyncStatusStore(
            storage,
            mainAccountKey = {
                lookups++
                if (lookups == 1) "first-generation-$namespace" else "readded-generation-$namespace"
            },
            childAccountKey = { childKeys[it] ?: error("missing child test identity") },
        )
        assertNotNull(changingIdentityStore.status(first, SyncStatusStore.Service.CONTACTS).lastSuccessAt)
        assertEquals(1, lookups)
    }

    @Test fun `contacts terminal and outcome share one commit and failed commit permits replay`() {
        val child = child("book")
        val completedAttempt = started(store.beginContacts(first, setOf(child)))
        assertEquals(SyncStatusStore.ChildWrite.RECORDED, store.recordContactsChild(first, completedAttempt, child, SyncStatusStore.ChildResult.SUCCESS))
        val oldSuccess = store.status(first, SyncStatusStore.Service.CONTACTS).lastSuccessAt
        val attempt = started(store.beginContacts(first, setOf(child)))
        val before = storage.commits
        storage.failNextCommit = true
        assertEquals(SyncStatusStore.ChildWrite.STORAGE_FAILURE, store.recordContactsChild(first, attempt, child, SyncStatusStore.ChildResult.SUCCESS))
        assertEquals(before + 2, storage.commits)
        val failed = freshStore().status(first, SyncStatusStore.Service.CONTACTS)
        assertEquals(oldSuccess, failed.lastSuccessAt)
        assertEquals(SyncStatusStore.FailureCategory.STORAGE, failed.lastFailureCategory)
        assertTrue(failed.latestGenerationIncomplete)

        assertEquals(SyncStatusStore.ChildWrite.RECORDED, store.recordContactsChild(first, attempt, child, SyncStatusStore.ChildResult.SUCCESS))
        val completed = freshStore().status(first, SyncStatusStore.Service.CONTACTS)
        assertFalse(completed.latestGenerationIncomplete)
        assertNotNull(completed.lastSuccessAt)
        assertNotEquals(SyncStatusStore.FailureCategory.STORAGE, completed.lastFailureCategory)
    }

    @Test fun `failed begin commit does not issue an unpersisted attempt`() {
        val child = child("book")
        val completedAttempt = started(store.beginContacts(first, setOf(child)))
        assertEquals(SyncStatusStore.ChildWrite.RECORDED, store.recordContactsChild(first, completedAttempt, child, SyncStatusStore.ChildResult.SUCCESS))
        val oldSuccess = store.status(first, SyncStatusStore.Service.CONTACTS).lastSuccessAt
        storage.failNextCommit = true
        assertEquals(SyncStatusStore.ContactsStart.StorageFailure, store.beginContacts(first, setOf(child)))
        val failedClosed = freshStore().status(first, SyncStatusStore.Service.CONTACTS)
        assertEquals(SyncStatusStore.FailureCategory.STORAGE, failedClosed.lastFailureCategory)
        assertEquals(oldSuccess, failedClosed.lastSuccessAt)
        assertTrue(failedClosed.latestGenerationIncomplete)
    }

    @Test fun `malformed contacts generation cannot expose historical success`() {
        val child = child("book")
        val attempt = started(store.beginContacts(first, setOf(child)))
        assertEquals(SyncStatusStore.ChildWrite.RECORDED, store.recordContactsChild(first, attempt, child, SyncStatusStore.ChildResult.SUCCESS))
        val contactsKey = storage.values.keys.single { it.endsWith(".CONTACTS") }
        val outcomeParts = storage.values.getValue(contactsKey).split('|', limit = 6).take(4)
        storage.values[contactsKey] = outcomeParts.joinToString("|") + "|attempt-without-children|;"

        val failedClosed = store.status(first, SyncStatusStore.Service.CONTACTS)
        assertEquals(SyncStatusStore.FailureCategory.STORAGE, failedClosed.lastFailureCategory)
        assertTrue(failedClosed.lastFailureAt!! > failedClosed.lastSuccessAt!!)
    }

    @Test fun `contacts failure removal zero children and unexpected children cannot produce success`() {
        val childOne = child("book-one")
        val childTwo = child("book-two")
        val attempt = started(store.beginContacts(first, setOf(childOne)))
        assertEquals(SyncStatusStore.ChildWrite.REJECTED, store.recordContactsChild(first, attempt, childTwo, SyncStatusStore.ChildResult.SUCCESS))
        assertTrue(store.recordContactsChildRemoved(first, childOne))
        assertEquals(SyncStatusStore.FailureCategory.CHILD_REMOVED, store.status(first, SyncStatusStore.Service.CONTACTS).lastFailureCategory)

        assertEquals(SyncStatusStore.ContactsStart.SetupRequired, store.beginContacts(second, emptySet()))
        assertEquals(SyncStatusStore.FailureCategory.SETUP_REQUIRED, store.status(second, SyncStatusStore.Service.CONTACTS).lastFailureCategory)
    }

    @Test fun `new contacts generation supersedes incomplete old attempt`() {
        val child = child("book")
        val oldAttempt = started(store.beginContacts(first, setOf(child)))
        val currentAttempt = started(store.beginContacts(first, setOf(child)))
        assertEquals(SyncStatusStore.ChildWrite.REJECTED, store.recordContactsChild(first, oldAttempt, child, SyncStatusStore.ChildResult.SUCCESS))
        assertEquals(SyncStatusStore.ChildWrite.RECORDED, store.recordContactsChild(first, currentAttempt, child, SyncStatusStore.ChildResult.SUCCESS))
    }

    @Test fun `parent failure atomically terminates generation and rejects late child success`() {
        val child = child("book")
        val attempt = started(store.beginContacts(first, setOf(child)))
        assertTrue(store.failContactsParent(first))
        assertEquals(SyncStatusStore.ChildWrite.REJECTED, store.recordContactsChild(first, attempt, child, SyncStatusStore.ChildResult.SUCCESS))
        assertEquals(SyncStatusStore.FailureCategory.PARENT_REFRESH, store.status(first, SyncStatusStore.Service.CONTACTS).lastFailureCategory)
    }

    @Test fun `exact identity clears after account data vanished and readd remains isolated`() {
        store.recordSuccess(first, SyncStatusStore.Service.TASKS, 1)
        store.recordSuccess(second, SyncStatusStore.Service.TASKS, 2)
        val removedIdentity = store.identity(first)
        mainKeys.remove(first) // models AccountManager user data disappearing after removal
        assertTrue(store.clear(removedIdentity))
        assertEquals(2L, store.status(second, SyncStatusStore.Service.TASKS).lastSuccessAt)
        assertEquals(SyncStatusStore.Status(), store.status(readdedFirst, SyncStatusStore.Service.TASKS))
        assertFalse(storage.values.keys.any { it.contains("first-generation") })
    }

    @Test fun `failed clear preserves evidence for a safe retry`() {
        store.recordSuccess(first, SyncStatusStore.Service.TASKS, 1)
        val identity = store.identity(first)
        storage.failNextCommit = true
        assertFalse(store.clear(identity))
        val failed = freshStore().status(first, SyncStatusStore.Service.TASKS)
        assertEquals(1L, failed.lastSuccessAt)
        assertEquals(SyncStatusStore.FailureCategory.STORAGE, failed.lastFailureCategory)
        assertTrue(store.clear(identity))
        assertEquals(SyncStatusStore.Status(), freshStore().status(first, SyncStatusStore.Service.TASKS))
    }

    @Test fun `total disk failure remains failed closed in process and reports failure`() {
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.TASKS, 1))
        storage.failAllCommits = true
        assertFalse(store.recordFailure(first, SyncStatusStore.Service.TASKS, SyncStatusStore.FailureCategory.NETWORK, 2))
        assertEquals(SyncStatusStore.FailureCategory.STORAGE, store.status(first, SyncStatusStore.Service.TASKS).lastFailureCategory)
    }
}
