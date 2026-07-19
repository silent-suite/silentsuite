package io.silentsuite.sync.syncadapter

import android.accounts.Account
import at.bitfire.ical4android.TaskProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderBoundaryPolicyTest {
    private fun aggregate(vararg outcomes: SyncManager.ProviderOutcome) = outcomes.fold(
        DirectProviderAggregate.NONE,
        ::aggregateDirectProviderOutcome,
    )

    @Test fun `empty and all skipped providers are not success`() {
        assertEquals(DirectProviderAggregate.NONE, aggregate())
        assertEquals(DirectProviderAggregate.NONE, aggregate(SyncManager.ProviderOutcome.SKIPPED, SyncManager.ProviderOutcome.SKIPPED))
    }

    @Test fun `success requires a completed provider and failure survives later cancellation`() {
        assertEquals(DirectProviderAggregate.SUCCESS, aggregate(SyncManager.ProviderOutcome.SUCCESS))
        assertEquals(DirectProviderAggregate.CANCELLED, aggregate(SyncManager.ProviderOutcome.CANCELLED))
        assertEquals(
            DirectProviderAggregate.FAILURE,
            aggregate(SyncManager.ProviderOutcome.FAILURE, SyncManager.ProviderOutcome.CANCELLED),
        )
    }

    @Test fun `outer completion recording preserves known failure despite cancellation`() {
        val before = SyncCompletionSnapshot(0, 0, 0, 0, false, false)
        val cancelledAfterIoFailure = SyncCompletionSnapshot(0, 1, 0, 0, false, true)
        assertEquals(
            CompletedOutcome.NETWORK_FAILURE,
            classifyCompletedOutcome(before, cancelledAfterIoFailure, false),
        )
        assertEquals(
            CompletedOutcome.PROVIDER_FAILURE,
            classifyCompletedOutcome(before, before.copy(fullSyncRequested = true), true),
        )
    }

    @Test fun `both supported task wrappers use the shared task adapter policy`() {
        assertTrue(TASK_OUTCOME_PROVIDERS.containsAll(setOf(
            TaskProvider.ProviderName.OpenTasks,
            TaskProvider.ProviderName.TasksOrg,
        )))
    }

    @Test fun `contacts child outcome requires exact main mapping and propagated attempt`() {
        val main = Account("main", "main-type")
        val target = contactsChildTarget(main, "attempt")
        assertSame(main, target?.mainAccount)
        assertEquals("attempt", target?.attemptId)
        assertEquals(null, contactsChildTarget(main, null))
        assertEquals(null, contactsChildTarget(null, "attempt"))
    }

    @Test fun `request correlation extras round trip without becoming identity`() {
        val extras = android.os.Bundle()
        putSyncRequestId(extras, "opaque-request")
        assertEquals("opaque-request", syncRequestId(extras))
    }

    @Test fun `contacts parent and child extras retain the same admitted attempt`() {
        val extras = android.os.Bundle()
        putSyncAttempt(extras, "parent-attempt")
        putContactsAttempt(extras, syncAttempt(extras)!!)
        assertEquals("parent-attempt", contactsAttempt(extras))
        assertEquals("parent-attempt", syncAttempt(extras))
    }

    @Test fun `cancelled completion is classified before any fabricated terminal`() {
        val before = SyncCompletionSnapshot(0, 0, 0, 0, false, false)
        assertEquals(CompletedOutcome.CANCELLED,
            classifyCompletedOutcome(before, before.copy(fullSyncRequested = true), false))
    }

    @Test fun `real cancellation completion ignores stale cleanup and retries failed cleanup`() {
        val main = Account("main", "main-type")
        val child = Account("child", "child-type")
        val storage = MemoryStorage()
        val store = boundaryStore(storage, main, child)
        var retries = 0
        fun cancel(attempt: String) = persistCompletedOutcomeAtAdapterBoundary(
            CompletedOutcome.CANCELLED,
            { error("cancellation must not fabricate failure") },
            { error("cancellation must not fabricate success") },
            { store.finishWithoutOutcomeResult(main, SyncStatusStore.Service.CALENDAR, attempt) },
            { retries++ },
        )
        assertTrue(store.beginAttempt(main, SyncStatusStore.Service.CALENDAR, "current-cancel", 1, null))
        cancel("stale-cancel")
        assertEquals(0, retries)
        assertEquals("current-cancel", store.status(main, SyncStatusStore.Service.CALENDAR).activeAttemptId)
        storage.failNext = true
        cancel("current-cancel")
        assertEquals(1, retries)
        assertEquals("current-cancel", store.status(main, SyncStatusStore.Service.CALENDAR).activeAttemptId)
        cancel("current-cancel")
        assertEquals(null, store.status(main, SyncStatusStore.Service.CALENDAR).activeAttemptId)
    }

    @Test fun `contacts adapters share parent generation and preserve child success or failure`() {
        val main = Account("main", "main-type")
        val child = Account("child", "child-type")
        val storage = MemoryStorage()
        val store = boundaryStore(storage, main, child)

        assertTrue(store.beginAttempt(main, SyncStatusStore.Service.CONTACTS, "parent-success", 9, null))
        assertEquals(SyncStatusStore.ContactsStart.Started("parent-success"),
            attachContactsChildrenAtAdapterBoundary(store, main, "parent-success", setOf(child), 10))
        val successExtras = android.os.Bundle().also { putContactsAttempt(it, "parent-success") }
        assertEquals(SyncStatusStore.MutationResult.RECORDED, recordContactsChildAtAdapterBoundary(store,
            requireNotNull(contactsChildTarget(main, contactsAttempt(successExtras))), child,
            SyncStatusStore.ChildResult.SUCCESS, timestamp = 11))
        assertEquals(11L, store.status(main, SyncStatusStore.Service.CONTACTS).lastSuccessAt)
        assertFalse(store.status(main, SyncStatusStore.Service.CONTACTS).latestGenerationIncomplete)

        assertTrue(store.beginAttempt(main, SyncStatusStore.Service.CONTACTS, "parent-failure", 19, null))
        assertEquals(SyncStatusStore.ContactsStart.Started("parent-failure"),
            attachContactsChildrenAtAdapterBoundary(store, main, "parent-failure", setOf(child), 20))
        val failureExtras = android.os.Bundle().also { putContactsAttempt(it, "parent-failure") }
        assertEquals(SyncStatusStore.MutationResult.RECORDED, recordContactsChildAtAdapterBoundary(store,
            requireNotNull(contactsChildTarget(main, contactsAttempt(failureExtras))), child,
            SyncStatusStore.ChildResult.FAILURE, SyncStatusStore.FailureCategory.PROVIDER, 21))
        assertEquals(SyncStatusStore.FailureCategory.PROVIDER,
            store.status(main, SyncStatusStore.Service.CONTACTS).lastFailureCategory)
    }

    @Test fun `failed contacts admission repairs at attachment and aggregates real child outcomes`() {
        val main = Account("main", "main-type")
        val firstChild = Account("first", "child-type")
        val secondChild = Account("second", "child-type")
        val storage = MemoryStorage()
        val store = boundaryStore(storage, main, firstChild, secondChild)

        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            store.beginAttemptResult(main, SyncStatusStore.Service.CONTACTS, "failed-admission", 10, null))
        assertEquals(SyncStatusStore.ContactsStart.Started("failed-admission"),
            attachContactsChildrenAtAdapterBoundary(store, main, "failed-admission", setOf(firstChild, secondChild), 11))
        val target = contactsChildTarget(main, "failed-admission")!!
        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            recordContactsChildAtAdapterBoundary(store, target, firstChild, SyncStatusStore.ChildResult.SUCCESS, timestamp = 12))
        assertEquals(1, store.status(main, SyncStatusStore.Service.CONTACTS).pendingChildren)
        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            recordContactsChildAtAdapterBoundary(store, target, secondChild, SyncStatusStore.ChildResult.FAILURE,
                SyncStatusStore.FailureCategory.NETWORK, 13))
        val terminal = store.status(main, SyncStatusStore.Service.CONTACTS)
        assertEquals(SyncStatusStore.FailureCategory.NETWORK, terminal.lastFailureCategory)
        assertFalse(terminal.structuralStorageFailure)
        assertFalse(terminal.latestGenerationIncomplete)
    }

    @Test fun `provider attachment repair terminalizes its correlated request`() {
        val main = Account("main", "main-type")
        val child = Account("child", "child-type")
        val storage = MemoryStorage()
        val store = boundaryStore(storage, main, child)

        assertTrue(store.recordRequested(main, setOf(SyncStatusStore.Service.CONTACTS), "provider-request", 10))
        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            store.beginAttemptResult(main, SyncStatusStore.Service.CONTACTS, "provider-attempt", 11, "provider-request"))
        assertEquals(SyncStatusStore.ContactsStart.Started("provider-attempt"),
            attachContactsChildrenAtAdapterBoundary(store, main, "provider-attempt", setOf(child), 12, "provider-request"))
        assertEquals("provider-request", store.status(main, SyncStatusStore.Service.CONTACTS).attemptRequestId)
        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            recordContactsChildAtAdapterBoundary(store, contactsChildTarget(main, "provider-attempt")!!,
                child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 13))
        assertEquals(null, store.status(main, SyncStatusStore.Service.CONTACTS).activeRequestId)
    }

    @Test fun `failed admission pre attachment parent failure clears its matching request`() {
        val main = Account("main", "main-type")
        val storage = MemoryStorage()
        val store = boundaryStore(storage, main)

        assertTrue(store.recordRequested(main, setOf(SyncStatusStore.Service.CONTACTS), "parent-request", 10))
        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            store.beginAttemptResult(main, SyncStatusStore.Service.CONTACTS, "parent-attempt", 11, "parent-request"))
        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            store.failContactsParentResult(main, "parent-attempt", "parent-request"))
        val terminal = store.status(main, SyncStatusStore.Service.CONTACTS)
        assertEquals(SyncStatusStore.FailureCategory.PARENT_REFRESH, terminal.lastFailureCategory)
        assertEquals(null, terminal.activeAttemptId)
        assertEquals(null, terminal.activeRequestId)
    }

    @Test fun `failed contacts admission repair cannot replace a newer generation`() {
        val main = Account("main", "main-type")
        val child = Account("child", "child-type")
        val storage = MemoryStorage()
        val store = boundaryStore(storage, main, child)

        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            store.beginAttemptResult(main, SyncStatusStore.Service.CONTACTS, "old-failed", 10, null))
        assertTrue(store.beginAttempt(main, SyncStatusStore.Service.CONTACTS, "new-current", 11, null))
        assertEquals(SyncStatusStore.ContactsStart.StorageFailure,
            attachContactsChildrenAtAdapterBoundary(store, main, "old-failed", setOf(child), 12))
        assertEquals("new-current", store.status(main, SyncStatusStore.Service.CONTACTS).activeAttemptId)
    }

    @Test fun `repaired contacts final commit reports persistence retry and remains repairable`() {
        val main = Account("main", "main-type")
        val child = Account("child", "child-type")
        val storage = MemoryStorage()
        val store = boundaryStore(storage, main, child)
        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            store.beginAttemptResult(main, SyncStatusStore.Service.CONTACTS, "repair-final", 10, null))
        assertEquals(SyncStatusStore.ContactsStart.Started("repair-final"),
            attachContactsChildrenAtAdapterBoundary(store, main, "repair-final", setOf(child), 11))
        val target = contactsChildTarget(main, "repair-final")!!
        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            recordContactsChildAtAdapterBoundary(store, target, child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 12))
        assertEquals("repair-final", store.status(main, SyncStatusStore.Service.CONTACTS).activeAttemptId)
        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            recordContactsChildAtAdapterBoundary(store, target, child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 12))
        assertEquals(12L, store.status(main, SyncStatusStore.Service.CONTACTS).lastSuccessAt)
    }

    @Test fun `contacts parent child skip cancel and failed cleanup signal retry without fabricating terminals`() {
        val main = Account("main", "main-type")
        val child = Account("child", "child-type")
        val storage = MemoryStorage()
        val store = boundaryStore(storage, main, child)
        assertTrue(store.recordSuccess(main, SyncStatusStore.Service.CALENDAR, 1))
        assertTrue(store.beginAttempt(main, SyncStatusStore.Service.CALENDAR, "parent-cancel", 2, null))
        assertTrue(finishWithoutOutcomeAtAdapterBoundary(store, main, SyncStatusStore.Service.CALENDAR, "parent-cancel"))
        assertEquals(1L, store.status(main, SyncStatusStore.Service.CALENDAR).lastSuccessAt)
        assertEquals(null, store.status(main, SyncStatusStore.Service.CALENDAR).activeAttemptId)

        assertTrue(store.beginAttempt(main, SyncStatusStore.Service.CONTACTS, "child-skip", 2, null))
        assertEquals(SyncStatusStore.ContactsStart.Started("child-skip"),
            attachContactsChildrenAtAdapterBoundary(store, main, "child-skip", setOf(child), 3))
        val skipped = contactsChildTarget(main, "child-skip")!!
        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            recordContactsChildAtAdapterBoundary(store, skipped, child, SyncStatusStore.ChildResult.SKIPPED, timestamp = 4))
        assertEquals(null, store.status(main, SyncStatusStore.Service.CONTACTS).activeAttemptId)
        assertEquals(null, store.status(main, SyncStatusStore.Service.CONTACTS).lastFailureAt)

        assertTrue(store.beginAttempt(main, SyncStatusStore.Service.CONTACTS, "cleanup-retry", 4, null))
        assertEquals(SyncStatusStore.ContactsStart.Started("cleanup-retry"),
            attachContactsChildrenAtAdapterBoundary(store, main, "cleanup-retry", setOf(child), 5))
        storage.failNext = true
        val retry = contactsChildTarget(main, "cleanup-retry")!!
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            recordContactsChildAtAdapterBoundary(store, retry, child, SyncStatusStore.ChildResult.SKIPPED, timestamp = 6))
        assertEquals("cleanup-retry", store.status(main, SyncStatusStore.Service.CONTACTS).activeAttemptId)
        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            recordContactsChildAtAdapterBoundary(store, retry, child, SyncStatusStore.ChildResult.SKIPPED, timestamp = 6))
        assertEquals(null, store.status(main, SyncStatusStore.Service.CONTACTS).activeAttemptId)
    }

    @Test fun `contacts terminal paths preserve frozen v1 terminal evidence`() {
        val main = Account("main", "main-type")
        val child = Account("child", "child-type")
        val storage = MemoryStorage()
        val store = boundaryStore(storage, main, child)
        val cases = listOf(
            SyncStatusStore.ChildResult.SUCCESS to null,
            SyncStatusStore.ChildResult.FAILURE to SyncStatusStore.FailureCategory.NETWORK,
            SyncStatusStore.ChildResult.REMOVED to SyncStatusStore.FailureCategory.CHILD_REMOVED,
        )
        cases.forEachIndexed { index, (result, category) ->
            val attempt = "frozen-$index"
            assertTrue(store.beginAttempt(main, SyncStatusStore.Service.CONTACTS, attempt, index.toLong(), null))
            assertEquals(SyncStatusStore.ContactsStart.Started(attempt),
                attachContactsChildrenAtAdapterBoundary(store, main, attempt, setOf(child), index.toLong()))
            assertEquals(SyncStatusStore.MutationResult.RECORDED,
                recordContactsChildAtAdapterBoundary(store, contactsChildTarget(main, attempt)!!, child,
                result, category ?: SyncStatusStore.FailureCategory.PROVIDER, index.toLong() + 1))
            val shadow = storage.values.entries.single { it.key.startsWith("status.") && it.key.endsWith(".CONTACTS") }
            val frozen = FrozenBaselineV1StatusReader(storage::get).status(shadow.key, contacts = true)
            assertEquals(store.status(main, SyncStatusStore.Service.CONTACTS).lastSuccessAt, frozen.successAt)
            assertEquals(store.status(main, SyncStatusStore.Service.CONTACTS).lastFailureCategory?.name, frozen.failureCategory)
        }
    }

    private class MemoryStorage : SyncStatusStore.Storage {
        val values = mutableMapOf<String, String>()
        var failNext = false
        override fun get(key: String) = values[key]
        override fun commit(puts: Map<String, String>, removes: Set<String>): Boolean {
            if (failNext) {
                failNext = false
                return false
            }
            removes.forEach(values::remove)
            values.putAll(puts)
            return true
        }
    }

    private fun boundaryStore(storage: MemoryStorage, main: Account, vararg children: Account) = SyncStatusStore(storage,
        mainAccountKey = { "main-generation" },
        childAccountKey = { account ->
            require(account in children)
            val marker = children.indexOf(account).toString(16)
            marker.repeat(64)
        },
    )
}
