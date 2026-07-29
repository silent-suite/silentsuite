package io.silentsuite.sync.syncadapter

import android.accounts.Account
import java.util.IdentityHashMap
import java.security.MessageDigest
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

class SyncStatusStoreTest {
    private class MemoryStorage : SyncStatusStore.Storage {
        val values = mutableMapOf<String, String>()
        var failNext = false
        var failAll = false
        var commits = 0
        override fun get(key: String) = values[key]
        override fun commit(puts: Map<String, String>, removes: Set<String>): Boolean {
            commits++
            if (failAll || failNext) { failNext = false; return false }
            removes.forEach(values::remove); values.putAll(puts); return true
        }
    }

    private val storage = MemoryStorage()
    private val first = Account("first@example.invalid", "main")
    private val second = Account("second@example.invalid", "main")
    private val readded = Account("first@example.invalid", "main")
    private val children = IdentityHashMap<Account, String>()
    private val store = SyncStatusStore(storage,
        mainAccountKey = { when {
            it === first -> "first-generation"
            it === second -> "second-generation"
            else -> "replacement-generation"
        } },
        childAccountKey = { children[it] ?: error("missing child") })
    private fun child(id: String, generation: String = id) = Account(id, "child").also {
        children[it] = MessageDigest.getInstance("SHA-256").digest(generation.toByteArray()).joinToString("") { byte -> "%02x".format(byte) }
    }
    private fun begin(children: Set<Account>, attempt: String = "attempt") =
        store.beginContacts(first, children, startedAt = 10, attemptId = attempt) as SyncStatusStore.ContactsStart.Started

    private fun freshStore() = SyncStatusStore(storage,
        mainAccountKey = { when {
            it === first -> "first-generation"
            it === second -> "second-generation"
            else -> "replacement-generation"
        } },
        childAccountKey = { children[it] ?: error("missing child") })

    @Test fun `v2 terminals write exact private v1 shadows and clear both faults atomically`() {
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 10))
        assertTrue(storage.values.keys.any { it.startsWith("status_v2.") })
        assertTrue(storage.values.keys.any { it.startsWith("status.") })
        assertFalse(storage.values.toString().contains("first@example.invalid"))
        storage.values.keys.filter { it.startsWith("status") }.forEach { storage.values["fault.$it"] = "1|20|STORAGE" }
        assertTrue(store.recordFailure(first, SyncStatusStore.Service.CALENDAR, SyncStatusStore.FailureCategory.INTERRUPTED, 30))
        assertFalse(storage.values.keys.any { it.startsWith("fault.") && it.endsWith(".CALENDAR") })
        val shadow = storage.values.entries.single { it.key.startsWith("status.") && it.key.endsWith(".CALENDAR") }.value
        assertTrue(shadow.endsWith("|UNKNOWN"))
    }

    @Test fun `request mutation is multi service atomic and terminal only clears matching lifecycle`() {
        assertTrue(store.recordRequested(first, setOf(SyncStatusStore.Service.CALENDAR, SyncStatusStore.Service.TASKS), "request", 10))
        assertEquals("request", store.status(first, SyncStatusStore.Service.CALENDAR).activeRequestId)
        assertEquals("request", store.status(first, SyncStatusStore.Service.TASKS).activeRequestId)
        assertTrue(store.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "calendar", 11, "request"))
        assertFalse(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, "old", 12))
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, "calendar", 12))
        assertNull(store.status(first, SyncStatusStore.Service.CALENDAR).activeAttemptId)
        assertEquals("request", store.status(first, SyncStatusStore.Service.TASKS).activeRequestId)
    }

    @Test fun `cancelled attempt retains terminal history and stale work expires only without authority`() {
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 1))
        assertTrue(store.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "attempt", 2, null))
        assertTrue(store.finishWithoutOutcome(first, SyncStatusStore.Service.CALENDAR, "attempt"))
        assertEquals(1L, store.status(first, SyncStatusStore.Service.CALENDAR).lastSuccessAt)
        assertTrue(store.recordRequested(first, setOf(SyncStatusStore.Service.CALENDAR), "request", 3))
        assertTrue(store.expireStale(first, SyncStatusStore.Service.CALENDAR, 3 + 30L * 60L * 1000L,
            platformActive = true, platformPending = false))
        assertEquals("request", store.status(first, SyncStatusStore.Service.CALENDAR).activeRequestId)
        assertTrue(store.expireStale(first, SyncStatusStore.Service.CALENDAR, 3 + 30L * 60L * 1000L,
            platformActive = false, platformPending = false))
        val expired = store.status(first, SyncStatusStore.Service.CALENDAR)
        assertEquals(SyncStatusStore.FailureCategory.INTERRUPTED, expired.lastFailureCategory)
        assertNull(expired.activeRequestId)
        assertNull(expired.requestedAt)
    }

    @Test fun `old request and attempt never expire while either platform authority fact remains`() {
        data class Lifecycle(val name: String, val begin: (SyncStatusStore) -> Boolean)
        val lifecycles = listOf(
            Lifecycle("request") { it.recordRequested(first, setOf(SyncStatusStore.Service.CALENDAR), "old-request", 1) },
            Lifecycle("attempt") { it.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "old-attempt", 1, null) },
        )
        val authorityFacts = listOf(
            true to false,
            false to true,
        )
        lifecycles.forEach { lifecycle ->
            authorityFacts.forEach { (platformActive, platformPending) ->
                storage.values.clear()
                assertTrue(lifecycle.begin(store))
                assertTrue(store.expireStale(first, SyncStatusStore.Service.CALENDAR, 31,
                    platformActive, platformPending, interruptionAfterMillis = 30))
                val status = store.status(first, SyncStatusStore.Service.CALENDAR)
                assertTrue("${lifecycle.name} must remain with active=$platformActive pending=$platformPending",
                    status.activeRequestId != null || status.activeAttemptId != null)
                assertNotEquals(SyncStatusStore.FailureCategory.INTERRUPTED, status.lastFailureCategory)
            }
        }
    }

    @Test fun `future timestamps rebase then receive a full interruption window`() {
        assertTrue(store.recordRequested(first, setOf(SyncStatusStore.Service.CALENDAR), "request", 100))
        assertTrue(store.rebaseFutureLifecycle(first, SyncStatusStore.Service.CALENDAR, 10))
        assertEquals(10L, store.status(first, SyncStatusStore.Service.CALENDAR).requestedAt)
        assertTrue(store.expireStale(first, SyncStatusStore.Service.CALENDAR, 39, false, false, 30))
        assertNotEquals(SyncStatusStore.FailureCategory.INTERRUPTED, store.status(first, SyncStatusStore.Service.CALENDAR).lastFailureCategory)
        assertTrue(store.expireStale(first, SyncStatusStore.Service.CALENDAR, 40, false, false, 30))
        assertEquals(SyncStatusStore.FailureCategory.INTERRUPTED, store.status(first, SyncStatusStore.Service.CALENDAR).lastFailureCategory)
    }

    @Test fun `typed lifecycle mutations distinguish stale work from persistence failure and repair failed admission`() {
        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            store.beginAttemptResult(first, SyncStatusStore.Service.CALENDAR, "current", 10, null))
        assertEquals(SyncStatusStore.MutationResult.REJECTED,
            store.recordSuccessResult(first, SyncStatusStore.Service.CALENDAR, "stale", null, 11))
        assertEquals("current", store.status(first, SyncStatusStore.Service.CALENDAR).activeAttemptId)
        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            store.finishWithoutOutcomeResult(first, SyncStatusStore.Service.CALENDAR, "current"))

        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            store.beginAttemptResult(first, SyncStatusStore.Service.TASKS, "repair", 20, "repair-request"))
        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            store.recordSuccessResult(first, SyncStatusStore.Service.TASKS, "repair", "repair-request", 21))
        assertEquals(21L, store.status(first, SyncStatusStore.Service.TASKS).lastSuccessAt)

        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            store.beginAttemptResult(first, SyncStatusStore.Service.CALENDAR, "direct-repair", 22, null))
        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            store.recordSuccessResult(first, SyncStatusStore.Service.CALENDAR, "direct-repair", null, 23))
        assertEquals(23L, store.status(first, SyncStatusStore.Service.CALENDAR).lastSuccessAt)

        assertEquals(SyncStatusStore.MutationResult.RECORDED,
            store.beginAttemptResult(first, SyncStatusStore.Service.TASKS, "persistence", 30, null))
        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            store.finishWithoutOutcomeResult(first, SyncStatusStore.Service.TASKS, "persistence"))
    }

    @Test fun `failed future rebase never expires the old future timestamp`() {
        assertTrue(store.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "future-attempt", 100, null))
        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            store.rebaseFutureLifecycleResult(first, SyncStatusStore.Service.CALENDAR, 10))
        assertEquals(SyncStatusStore.MutationResult.REJECTED,
            store.expireStaleResult(first, SyncStatusStore.Service.CALENDAR, 10_000, false, false, 30))
        assertEquals("future-attempt", store.status(first, SyncStatusStore.Service.CALENDAR).activeAttemptId)
    }

    @Test fun `contacts parent children share one generation and late children are rejected`() {
        val one = child("one"); val two = child("two")
        val old = begin(setOf(one), "old")
        val current = begin(setOf(one, two), "current")
        assertEquals(SyncStatusStore.ChildWrite.REJECTED, store.recordContactsChild(first, old.attemptId, one, SyncStatusStore.ChildResult.SUCCESS))
        assertEquals(SyncStatusStore.ChildWrite.RECORDED, store.recordContactsChild(first, current.attemptId, one, SyncStatusStore.ChildResult.FAILURE,
            SyncStatusStore.FailureCategory.NETWORK, 20))
        assertTrue(store.status(first, SyncStatusStore.Service.CONTACTS).latestGenerationIncomplete)
        assertEquals(SyncStatusStore.ChildWrite.RECORDED, store.recordContactsChild(first, current.attemptId, two, SyncStatusStore.ChildResult.SUCCESS,
            timestamp = 21))
        assertEquals(SyncStatusStore.FailureCategory.NETWORK, store.status(first, SyncStatusStore.Service.CONTACTS).lastFailureCategory)
        assertFalse(store.status(first, SyncStatusStore.Service.CONTACTS).latestGenerationIncomplete)
    }

    @Test fun `same name child replacement rejects every stale captured generation close`() {
        val oldChild = child("same-name-child", "old-child-generation")
        val replacementChild = child("same-name-child", "replacement-child-generation")
        val mainIdentity = store.identity(first)
        val oldIdentity = requireNotNull(store.childIdentity(oldChild))
        val replacementIdentity = requireNotNull(store.childIdentity(replacementChild))
        assertNotEquals(oldIdentity, replacementIdentity)

        SyncStatusStore.ChildResult.values().forEachIndexed { index, result ->
            val attempt = "replacement-parent-$index"
            val startedAt = 10L + index * 10
            assertTrue(store.beginAttempt(first, SyncStatusStore.Service.CONTACTS, attempt, startedAt, null))
            assertEquals(SyncStatusStore.ContactsStart.Started(attempt),
                store.attachContactsChildren(mainIdentity, attempt, setOf(replacementIdentity), startedAt + 1))
            assertEquals("stale $result must not close the replacement child",
                SyncStatusStore.ChildWrite.REJECTED,
                store.recordContactsChild(mainIdentity, attempt, oldIdentity, result, timestamp = startedAt + 2))
            assertEquals(SyncStatusStore.ChildWrite.RECORDED,
                store.recordContactsChild(mainIdentity, attempt, replacementIdentity, result,
                    SyncStatusStore.FailureCategory.PROVIDER, startedAt + 3))
            assertNull(store.status(first, SyncStatusStore.Service.CONTACTS).activeAttemptId)
        }
    }

    @Test fun `contacts start supersedes an older generation without accepting its terminals`() {
        val child = child("superseded-child")
        val old = begin(setOf(child), "old-parent")
        val current = begin(setOf(child), "current-parent")
        assertEquals("current-parent", current.attemptId)
        assertEquals(SyncStatusStore.ChildWrite.REJECTED,
            store.recordContactsChild(first, old.attemptId, child, SyncStatusStore.ChildResult.SUCCESS))
        assertFalse(store.failContactsParent(first, old.attemptId))
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, current.attemptId, child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 12))
    }

    @Test fun `failed request is repaired by correlated adapter admission and terminal`() {
        storage.failNext = true
        assertFalse(store.recordRequested(first, setOf(SyncStatusStore.Service.CALENDAR), "repair-request", 10))
        assertTrue(store.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "repair-attempt", 11, "repair-request"))
        assertEquals("repair-request", store.status(first, SyncStatusStore.Service.CALENDAR).activeRequestId)
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, "repair-attempt", 12))
        val repaired = store.status(first, SyncStatusStore.Service.CALENDAR)
        assertEquals(12L, repaired.lastSuccessAt)
        assertFalse(repaired.structuralStorageFailure)
    }

    @Test fun `contacts attachment repair restores matching request correlation only`() {
        val child = child("correlated-child")
        assertTrue(store.recordRequested(first, setOf(SyncStatusStore.Service.CONTACTS), "contacts-request", 10))
        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            store.beginAttemptResult(first, SyncStatusStore.Service.CONTACTS, "contacts-attempt", 11, "contacts-request"))
        assertEquals(SyncStatusStore.ContactsStart.Started("contacts-attempt"),
            store.attachContactsChildren(first, "contacts-attempt", setOf(child), 12, "contacts-request"))
        assertEquals("contacts-request", store.status(first, SyncStatusStore.Service.CONTACTS).attemptRequestId)
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, "contacts-attempt", child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 13))
        assertEquals(null, store.status(first, SyncStatusStore.Service.CONTACTS).activeRequestId)

        assertTrue(store.recordRequested(first, setOf(SyncStatusStore.Service.CONTACTS), "unrelated-request", 20))
        storage.failNext = true
        assertEquals(SyncStatusStore.MutationResult.STORAGE_FAILURE,
            store.beginAttemptResult(first, SyncStatusStore.Service.CONTACTS, "direct-attempt", 21, null))
        assertEquals(SyncStatusStore.ContactsStart.Started("direct-attempt"),
            store.attachContactsChildren(first, "direct-attempt", setOf(child), 22, null))
        assertEquals(null, store.status(first, SyncStatusStore.Service.CONTACTS).attemptRequestId)
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, "direct-attempt", child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 23))
        assertEquals("unrelated-request", store.status(first, SyncStatusStore.Service.CONTACTS).activeRequestId)
    }

    @Test fun `malformed v2 fails closed while v1 history stays exact and clear removes both namespaces`() {
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 5))
        val v2 = storage.values.keys.single { it.startsWith("status_v2.") }
        storage.values[v2] = "malformed"
        val status = store.status(first, SyncStatusStore.Service.CALENDAR)
        assertEquals(5L, status.lastSuccessAt)
        assertEquals(SyncStatusStore.FailureCategory.STORAGE, status.lastFailureCategory)
        assertTrue(status.structuralStorageFailure)
        assertTrue(store.clear(store.identity(first)))
        assertTrue(storage.values.isEmpty())
        assertEquals(SyncStatusStore.Status(), store.status(readded, SyncStatusStore.Service.CALENDAR))
    }

    @Test fun `failed terminal commit retains both faults and successful replay repairs both`() {
        assertTrue(store.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "attempt", 1, null))
        storage.failNext = true
        assertFalse(store.recordFailure(first, SyncStatusStore.Service.CALENDAR, "attempt", SyncStatusStore.FailureCategory.NETWORK, 2))
        assertTrue(storage.values.keys.any { it.startsWith("fault.status_v2.") })
        assertTrue(storage.values.keys.any { it.startsWith("fault.status.") })
        assertTrue(store.recordFailure(first, SyncStatusStore.Service.CALENDAR, "attempt", SyncStatusStore.FailureCategory.NETWORK, 2))
        assertFalse(storage.values.keys.any { it.startsWith("fault.") })
    }

    @Test fun `restored direct outcomes stay atomic isolated exact and private`() {
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 50))
        val before = storage.commits
        assertTrue(store.recordFailure(second, SyncStatusStore.Service.TASKS,
            SyncStatusStore.FailureCategory.NETWORK, 50))
        assertEquals(before + 1, storage.commits)
        assertEquals(50L, store.status(first, SyncStatusStore.Service.CALENDAR).lastSuccessAt)
        assertEquals(SyncStatusStore.FailureCategory.NETWORK,
            store.status(second, SyncStatusStore.Service.TASKS).lastFailureCategory)
        assertFalse(storage.values.toString().contains("example.invalid"))

        assertTrue(store.recordFailure(first, SyncStatusStore.Service.CALENDAR,
            SyncStatusStore.FailureCategory.PERMISSION, 50))
        assertEquals(50L, store.status(first, SyncStatusStore.Service.CALENDAR).lastFailureAt)
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 50))
        assertEquals(50L, store.status(first, SyncStatusStore.Service.CALENDAR).lastSuccessAt)
    }

    @Test fun `forbidden persisted values excludes every prohibited raw fixture payload`() {
        val forbidden = listOf("secret-account", "raw-creation", "https://server.invalid/private", "collection-name",
            "session-token", "credential-value", "exception-message", "provider-payload")
        val privateAccount = Account(forbidden[0], forbidden[1])
        val privateChild = Account(forbidden[3], forbidden[7])
        val privateStore = SyncStatusStore(storage, mainAccountKey = { "b".repeat(64) },
            childAccountKey = { "c".repeat(64) })
        assertTrue(privateStore.recordRequested(privateAccount, setOf(SyncStatusStore.Service.CALENDAR), "opaque-request", 10))
        assertTrue(privateStore.beginAttempt(privateAccount, SyncStatusStore.Service.CALENDAR, "opaque-attempt", 11, "opaque-request"))
        assertTrue(privateStore.recordSuccess(privateAccount, SyncStatusStore.Service.CALENDAR, "opaque-attempt", 12))
        val contacts = privateStore.beginContacts(privateAccount, setOf(privateChild), startedAt = 13, attemptId = "opaque-parent")
            as SyncStatusStore.ContactsStart.Started
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            privateStore.recordContactsChild(privateAccount, contacts.attemptId, privateChild, SyncStatusStore.ChildResult.SUCCESS, timestamp = 14))
        val persisted = storage.values.entries.joinToString("|") { "${it.key}|${it.value}" }
        forbidden.forEach { assertFalse("persisted raw fixture: $it", persisted.contains(it)) }
    }

    @Test fun `v2 terminal timestamps stay exact while revision orders interruption success and failure`() {
        assertTrue(store.recordFailure(first, SyncStatusStore.Service.CALENDAR,
            SyncStatusStore.FailureCategory.INTERRUPTED, 50))
        assertEquals(50L, store.status(first, SyncStatusStore.Service.CALENDAR).lastTerminalAt)
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 50))
        assertEquals(50L, store.status(first, SyncStatusStore.Service.CALENDAR).lastTerminalAt)
        assertEquals(SyncStatusStore.TerminalResult.SUCCESS,
            store.status(first, SyncStatusStore.Service.CALENDAR).lastTerminalResult)
        assertTrue(store.recordFailure(first, SyncStatusStore.Service.CALENDAR,
            SyncStatusStore.FailureCategory.NETWORK, 1))
        assertEquals(1L, store.status(first, SyncStatusStore.Service.CALENDAR).lastTerminalAt)
        assertEquals(SyncStatusStore.TerminalResult.FAILURE,
            store.status(first, SyncStatusStore.Service.CALENDAR).lastTerminalResult)
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, Long.MAX_VALUE))
        assertEquals(Long.MAX_VALUE, store.status(first, SyncStatusStore.Service.CALENDAR).lastTerminalAt)
        assertTrue(store.recordFailure(first, SyncStatusStore.Service.CALENDAR,
            SyncStatusStore.FailureCategory.NETWORK, Long.MAX_VALUE))
        assertEquals(Long.MAX_VALUE, store.status(first, SyncStatusStore.Service.CALENDAR).lastTerminalAt)
        assertEquals(SyncStatusStore.TerminalResult.FAILURE,
            store.status(first, SyncStatusStore.Service.CALENDAR).lastTerminalResult)
    }

    @Test fun `legacy epoch zero stays a terminal through v2 mutation`() {
        storage.values["status.first-generation.CALENDAR"] = "1|0||"
        val legacy = store.status(first, SyncStatusStore.Service.CALENDAR)
        assertEquals(0L, legacy.lastSuccessAt)
        assertEquals(0L, legacy.lastTerminalAt)
        assertEquals(SyncStatusStore.TerminalResult.SUCCESS, legacy.lastTerminalResult)

        assertTrue(store.recordFailure(first, SyncStatusStore.Service.CALENDAR,
            SyncStatusStore.FailureCategory.NETWORK, 0))
        val mutated = store.status(first, SyncStatusStore.Service.CALENDAR)
        assertEquals(0L, mutated.lastSuccessAt)
        assertEquals(0L, mutated.lastFailureAt)
        assertEquals(0L, mutated.lastTerminalAt)
        assertEquals(SyncStatusStore.TerminalResult.FAILURE, mutated.lastTerminalResult)
        // V1 is a terminal-only rollback shadow; v2 retains the exact epoch-zero history above.
        assertEquals("1||1|NETWORK", storage.values["status.first-generation.CALENDAR"])
    }

    @Test fun `frozen shadows order interruption success failure backward and saturation`() {
        assertTrue(store.recordFailure(first, SyncStatusStore.Service.CALENDAR,
            SyncStatusStore.FailureCategory.INTERRUPTED, 50))
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 1))
        assertTrue(store.recordFailure(first, SyncStatusStore.Service.CALENDAR,
            SyncStatusStore.FailureCategory.NETWORK, 1))
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, Long.MAX_VALUE))
        val frozen = FrozenBaselineV1StatusReader(storage::get).status("status.first-generation.CALENDAR", false)
        assertEquals(Long.MAX_VALUE, frozen.successAt)
        assertNull(frozen.failureAt)
        assertNull(frozen.failureCategory)
    }

    @Test fun `all categories write frozen valid v1 shadows including interrupted`() {
        SyncStatusStore.FailureCategory.values().forEachIndexed { index, category ->
            val account = Account("shadow-$index", "main")
            val identity = "shadow-$index-${UUID.randomUUID()}"
            val keyed = SyncStatusStore(storage,
                mainAccountKey = { identity }, childAccountKey = { "child" })
            assertTrue(keyed.recordFailure(account, SyncStatusStore.Service.CALENDAR, category, index.toLong()))
            val shadowKey = "status.$identity.CALENDAR"
            val shadow = storage.values.getValue(shadowKey)
            assertTrue(shadow.startsWith("1|"))
            if (category == SyncStatusStore.FailureCategory.INTERRUPTED) assertTrue(shadow.endsWith("|UNKNOWN"))
            storage.values.remove("status_v2.$identity.CALENDAR")
            val legacy = keyed.status(account, SyncStatusStore.Service.CALENDAR)
            assertEquals(if (category == SyncStatusStore.FailureCategory.INTERRUPTED)
                SyncStatusStore.FailureCategory.UNKNOWN else category, legacy.lastFailureCategory)
        }
    }

    @Test fun `malformed v2 overrides valid missing and malformed v1 terminal history`() {
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, Long.MAX_VALUE))
        val v2 = storage.values.keys.single { it.startsWith("status_v2.") }
        val v1 = storage.values.keys.single { it.startsWith("status.") }
        storage.values[v2] = "malformed"
        assertTrue(freshStore().status(first, SyncStatusStore.Service.CALENDAR).structuralStorageFailure)
        storage.values.remove(v1)
        assertTrue(freshStore().status(first, SyncStatusStore.Service.CALENDAR).structuralStorageFailure)
        storage.values[v1] = "broken"
        assertTrue(freshStore().status(first, SyncStatusStore.Service.CALENDAR).structuralStorageFailure)
    }

    @Test fun `unmatched attempts and parent failures cannot overwrite newer evidence`() {
        assertTrue(store.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "old", 1, null))
        assertTrue(store.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "new", 2, null))
        assertFalse(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, "old", 3))
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, "new", 3))

        val child = child("exact-parent")
        val old = begin(setOf(child), "parent-old")
        val current = begin(setOf(child), "parent-current")
        assertFalse(store.failContactsParent(first, old.attemptId))
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, current.attemptId, child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 4))
    }

    @Test fun `background cancellation preserves an unrelated requested lifecycle`() {
        assertTrue(store.recordRequested(first, setOf(SyncStatusStore.Service.CALENDAR), "request", 1))
        assertTrue(store.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "background", 2, null))
        assertTrue(store.finishWithoutOutcome(first, SyncStatusStore.Service.CALENDAR, "background"))
        assertEquals("request", store.status(first, SyncStatusStore.Service.CALENDAR).activeRequestId)
    }

    @Test fun `background success and failure preserve an unrelated requested lifecycle`() {
        listOf(true, false).forEach { success ->
            assertTrue(store.recordRequested(first, setOf(SyncStatusStore.Service.CALENDAR), "manual-$success", 10))
            assertTrue(store.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "background-$success", 11, null))
            val wrote = if (success) store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, "background-$success", 12)
            else store.recordFailure(first, SyncStatusStore.Service.CALENDAR, "background-$success", SyncStatusStore.FailureCategory.NETWORK, 12)
            assertTrue(wrote)
            assertEquals("manual-$success", store.status(first, SyncStatusStore.Service.CALENDAR).activeRequestId)
        }
    }

    @Test fun `failed request and clear commits retain fail closed evidence for retry`() {
        storage.failNext = true
        assertFalse(store.recordRequested(first, setOf(SyncStatusStore.Service.CALENDAR), "request", 1))
        assertTrue(store.status(first, SyncStatusStore.Service.CALENDAR).structuralStorageFailure)
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 2))
        val identity = store.identity(first)
        storage.failNext = true
        assertFalse(store.clear(identity))
        assertTrue(freshStore().status(first, SyncStatusStore.Service.CALENDAR).structuralStorageFailure)
        assertTrue(store.clear(identity))
    }

    @Test fun `failed direct outcome and malformed fault sentinel remain fail closed until repair`() {
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 50))
        storage.failNext = true
        assertFalse(store.recordFailure(first, SyncStatusStore.Service.CALENDAR,
            SyncStatusStore.FailureCategory.PERMISSION, 60))
        assertTrue(freshStore().status(first, SyncStatusStore.Service.CALENDAR).structuralStorageFailure)
        storage.values.keys.filter { it.startsWith("fault.") }.forEach { storage.values[it] = "malformed" }
        assertTrue(freshStore().status(first, SyncStatusStore.Service.CALENDAR).structuralStorageFailure)
        assertTrue(store.recordFailure(first, SyncStatusStore.Service.CALENDAR,
            SyncStatusStore.FailureCategory.PERMISSION, 60))
        assertEquals(SyncStatusStore.FailureCategory.PERMISSION,
            freshStore().status(first, SyncStatusStore.Service.CALENDAR).lastFailureCategory)
    }

    @Test fun `seeded v1 shadows and faults repair through the frozen direct and contacts status path`() {
        storage.values["status.first-generation.CALENDAR"] = "1|100||"
        storage.values["fault.status.first-generation.CALENDAR"] = "1|10|STORAGE"
        val directBeforeRepair = FrozenBaselineV1StatusReader(storage::get)
            .status("status.first-generation.CALENDAR", false)
        assertEquals(100L, directBeforeRepair.successAt)
        assertEquals(10L, directBeforeRepair.failureAt)
        assertEquals("STORAGE", directBeforeRepair.failureCategory)
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 11))
        assertFalse(storage.values.containsKey("fault.status.first-generation.CALENDAR"))
        val directAfterRepair = FrozenBaselineV1StatusReader(storage::get)
            .status("status.first-generation.CALENDAR", false)
        assertEquals(101L, directAfterRepair.successAt)
        assertNull(directAfterRepair.failureAt)

        val child = child("seeded-contacts-fault")
        val childKey = children.getValue(child)
        storage.values["status.first-generation.CONTACTS"] = "1|100|||completed|$childKey;$childKey:SUCCESS"
        storage.values["fault.status.first-generation.CONTACTS"] = "1|10|STORAGE"
        val contactsBeforeRepair = FrozenBaselineV1StatusReader(storage::get)
            .status("status.first-generation.CONTACTS", true)
        assertEquals(100L, contactsBeforeRepair.successAt)
        assertEquals(10L, contactsBeforeRepair.failureAt)
        assertEquals("STORAGE", contactsBeforeRepair.failureCategory)
        assertTrue(contactsBeforeRepair.incomplete)
        val attempt = begin(setOf(child), "seeded-contacts-parent")
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, attempt.attemptId, child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 12))
        assertFalse(storage.values.containsKey("fault.status.first-generation.CONTACTS"))
        val contactsAfterRepair = FrozenBaselineV1StatusReader(storage::get)
            .status("status.first-generation.CONTACTS", true)
        assertEquals(101L, contactsAfterRepair.successAt)
        assertNull(contactsAfterRepair.failureAt)
        assertFalse(contactsAfterRepair.incomplete)
    }

    @Test fun `frozen v1 status preserves baseline malformed contacts and fault behavior`() {
        val child = "a".repeat(64)
        val frozen = FrozenBaselineV1StatusReader(storage::get)

        storage.values["status.first-generation.CONTACTS"] = "1|7|||attempt|$child;$child:SKIPPED"
        val ignoredMalformedTerminal = frozen.status("status.first-generation.CONTACTS", true)
        assertEquals(7L, ignoredMalformedTerminal.successAt)
        assertNull(ignoredMalformedTerminal.failureCategory)
        assertTrue(ignoredMalformedTerminal.incomplete)

        storage.values["status.first-generation.CALENDAR"] = "1|7||"
        storage.values["fault.status.first-generation.CALENDAR"] =
            "1|${System.currentTimeMillis() + 10 * 60 * 1000L}|STORAGE"
        val futureFault = frozen.status("status.first-generation.CALENDAR", false)
        assertEquals(8L, futureFault.failureAt)
        assertEquals("STORAGE", futureFault.failureCategory)

        storage.values["status.first-generation.CONTACTS"] = "1||100|NETWORK|completed|$child;$child:SUCCESS"
        storage.values["fault.status.first-generation.CONTACTS"] = "1|99|STORAGE"
        val orderedFault = frozen.status("status.first-generation.CONTACTS", true)
        assertEquals(99L, orderedFault.failureAt)
        assertEquals("STORAGE", orderedFault.failureCategory)
        assertTrue(orderedFault.incomplete)
    }

    @Test fun `production faults are ordered after retained v1 shadows`() {
        storage.values["status.first-generation.TASKS"] = "1|${Long.MAX_VALUE}||"
        storage.failNext = true
        assertFalse(store.recordRequested(first, setOf(SyncStatusStore.Service.TASKS), "request", 1))
        assertEquals("1|${Long.MAX_VALUE}|STORAGE",
            storage.values["fault.status_v2.first-generation.TASKS"])
        val status = store.status(first, SyncStatusStore.Service.TASKS)
        assertEquals(Long.MAX_VALUE, status.lastFailureAt)
        assertEquals(SyncStatusStore.FailureCategory.STORAGE, status.lastFailureCategory)
    }

    @Test fun `dual in-process v1 and v2 terminal faults remain visible when fault persistence fails`() {
        assertTrue(store.recordSuccess(first, SyncStatusStore.Service.TASKS, 1))
        storage.failAll = true
        assertFalse(store.recordFailure(first, SyncStatusStore.Service.TASKS,
            SyncStatusStore.FailureCategory.NETWORK, 2))
        assertFalse(storage.values.keys.any { it.startsWith("fault.") })
        assertTrue(store.status(first, SyncStatusStore.Service.TASKS).structuralStorageFailure)
    }

    @Test fun `latest contacts generation remains incomplete over historical success`() {
        val one = child("historical-one")
        val completed = begin(setOf(one), "completed")
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, completed.attemptId, one, SyncStatusStore.ChildResult.SUCCESS, timestamp = 11))
        val priorSuccess = store.status(first, SyncStatusStore.Service.CONTACTS).lastSuccessAt
        val two = child("historical-two")
        begin(setOf(one, two), "next")
        val pending = store.status(first, SyncStatusStore.Service.CONTACTS)
        assertEquals(priorSuccess, pending.lastSuccessAt)
        assertTrue(pending.latestGenerationIncomplete)
        assertEquals(2, pending.pendingChildren)
    }

    @Test fun `contacts status snapshots the exact generation once`() {
        val child = child("snapshot")
        val attempt = begin(setOf(child), "snapshot-attempt")
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, attempt.attemptId, child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 11))
        var lookups = 0
        val snapshotStore = SyncStatusStore(storage,
            mainAccountKey = {
                lookups++
                if (lookups == 1) "first-generation" else "replacement-generation"
            },
            childAccountKey = { children[it] ?: error("missing child") })
        assertNotNull(snapshotStore.status(first, SyncStatusStore.Service.CONTACTS).lastSuccessAt)
        assertEquals(1, lookups)
    }

    @Test fun `contacts terminal is atomic and storage failure permits replay`() {
        val child = child("atomic")
        val attempt = begin(setOf(child), "atomic-attempt")
        storage.failNext = true
        assertEquals(SyncStatusStore.ChildWrite.STORAGE_FAILURE,
            store.recordContactsChild(first, attempt.attemptId, child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 11))
        assertTrue(freshStore().status(first, SyncStatusStore.Service.CONTACTS).structuralStorageFailure)
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, attempt.attemptId, child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 11))
        assertFalse(freshStore().status(first, SyncStatusStore.Service.CONTACTS).latestGenerationIncomplete)
    }

    @Test fun `failed contacts admission does not issue an unpersisted generation`() {
        val child = child("admission")
        storage.failNext = true
        assertEquals(SyncStatusStore.ContactsStart.StorageFailure,
            store.beginContacts(first, setOf(child), startedAt = 10, attemptId = "admission-attempt"))
        assertTrue(freshStore().status(first, SyncStatusStore.Service.CONTACTS).structuralStorageFailure)
    }

    @Test fun `parent failure terminates only its generation and rejects late children`() {
        val child = child("parent-failure")
        val attempt = begin(setOf(child), "parent-failure-attempt")
        assertTrue(store.failContactsParent(first, attempt.attemptId))
        assertEquals(SyncStatusStore.ChildWrite.REJECTED,
            store.recordContactsChild(first, attempt.attemptId, child, SyncStatusStore.ChildResult.SUCCESS))
        assertEquals(SyncStatusStore.FailureCategory.PARENT_REFRESH,
            store.status(first, SyncStatusStore.Service.CONTACTS).lastFailureCategory)
    }

    @Test fun `malformed contacts v2 cannot expose historical success`() {
        val child = child("malformed")
        val attempt = begin(setOf(child), "malformed-attempt")
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, attempt.attemptId, child, SyncStatusStore.ChildResult.SUCCESS, timestamp = 11))
        val key = storage.values.keys.single { it.startsWith("status_v2.") && it.endsWith(".CONTACTS") }
        storage.values[key] = "2|1|||||||||||not-a-generation"
        assertTrue(store.status(first, SyncStatusStore.Service.CONTACTS).structuralStorageFailure)
    }

    @Test fun `contacts removal empty children and unexpected children cannot report success`() {
        val expected = child("expected")
        val unexpected = child("unexpected")
        val attempt = begin(setOf(expected), "remove-attempt")
        assertEquals(SyncStatusStore.ChildWrite.REJECTED,
            store.recordContactsChild(first, attempt.attemptId, unexpected, SyncStatusStore.ChildResult.SUCCESS))
        assertTrue(store.recordContactsChildRemoved(first, expected))
        assertEquals(SyncStatusStore.FailureCategory.CHILD_REMOVED,
            store.status(first, SyncStatusStore.Service.CONTACTS).lastFailureCategory)
        assertEquals(SyncStatusStore.ContactsStart.SetupRequired,
            store.beginContacts(second, emptySet(), startedAt = 10, attemptId = "empty"))
        assertEquals(SyncStatusStore.FailureCategory.SETUP_REQUIRED,
            store.status(second, SyncStatusStore.Service.CONTACTS).lastFailureCategory)
    }

    @Test fun `contacts skipped children close only their matching generation without a terminal`() {
        val firstChild = child("skip-one")
        val secondChild = child("skip-two")
        val attempt = begin(setOf(firstChild, secondChild), "skip-parent")
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, attempt.attemptId, firstChild, SyncStatusStore.ChildResult.SKIPPED))
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, attempt.attemptId, secondChild, SyncStatusStore.ChildResult.SUCCESS))
        val status = store.status(first, SyncStatusStore.Service.CONTACTS)
        assertFalse(status.latestGenerationIncomplete)
        assertNull(status.lastTerminalAt)
        assertNull(status.activeAttemptId)
    }

    @Test fun `partial contacts expiry writes a terminal v1 shadow without fabricating children`() {
        val one = child("expiry-one")
        val two = child("expiry-two")
        val attempt = begin(setOf(one, two), "expiry-parent")
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, attempt.attemptId, one, SyncStatusStore.ChildResult.SUCCESS, timestamp = 11))
        assertTrue(store.expireStale(first, SyncStatusStore.Service.CONTACTS, 40, false, false, 30))
        val frozen = FrozenBaselineV1StatusReader(storage::get).status("status.first-generation.CONTACTS", true)
        assertFalse(frozen.incomplete)
        assertEquals("UNKNOWN", frozen.failureCategory)
        assertFalse(storage.values.getValue("status.first-generation.CONTACTS").contains(children[two]!!))
    }

    @Test fun `frozen v1 reader accepts every produced shadow and completed contacts generation`() {
        SyncStatusStore.FailureCategory.values().forEachIndexed { index, category ->
            val account = Account("frozen-$index", "main")
            val identity = "frozen-$index"
            val keyed = SyncStatusStore(storage, mainAccountKey = { identity }, childAccountKey = { "a".repeat(64) })
            assertTrue(keyed.recordFailure(account, SyncStatusStore.Service.CALENDAR, category, index.toLong()))
            val frozen = FrozenBaselineV1StatusReader(storage::get).status("status.$identity.CALENDAR", false)
            assertEquals(if (category == SyncStatusStore.FailureCategory.INTERRUPTED) "UNKNOWN" else category.name,
                frozen.failureCategory)
        }
        val contact = child("frozen-contact")
        val attempt = begin(setOf(contact), "frozen-contacts")
        assertEquals(SyncStatusStore.ChildWrite.RECORDED,
            store.recordContactsChild(first, attempt.attemptId, contact, SyncStatusStore.ChildResult.SUCCESS, timestamp = 20))
        val frozen = FrozenBaselineV1StatusReader(storage::get).status("status.first-generation.CONTACTS", true)
        assertFalse(frozen.incomplete)
        assertEquals(20L, frozen.successAt)
    }

    @Test fun `frozen v1 contacts parser rejects malformed terminal membership`() {
        storage.values["status.first-generation.CONTACTS"] = "1|1|||attempt|${"a".repeat(64)};${"b".repeat(64)}:SUCCESS"
        assertTrue(store.status(first, SyncStatusStore.Service.CONTACTS).structuralStorageFailure)
        storage.values["status.first-generation.CONTACTS"] = "1|1|||attempt|${"a".repeat(64)},${"a".repeat(64)};"
        assertTrue(store.status(first, SyncStatusStore.Service.CONTACTS).structuralStorageFailure)
    }

    @Test fun `v2 rejects orphaned historical outcomes and contacts data without an attempt`() {
        storage.values["status_v2.first-generation.CALENDAR"] = "2|1|1||||||||||"
        assertTrue(store.status(first, SyncStatusStore.Service.CALENDAR).structuralStorageFailure)
        storage.values["status_v2.first-generation.CONTACTS"] = "2|1|||||||||||${"a".repeat(64)};"
        assertTrue(store.status(first, SyncStatusStore.Service.CONTACTS).structuralStorageFailure)
    }

    @Test fun `v2 rejects impossible lifecycle opaque identifiers and contacts child pairs`() {
        val hash = "a".repeat(64)
        fun record(
            service: SyncStatusStore.Service,
            request: String = "",
            requestedAt: String = "",
            attempt: String = "",
            attemptAt: String = "",
            attemptRequest: String = "",
            contacts: String = "",
        ) {
            storage.values["status_v2.first-generation.${service.name}"] = listOf(
                "2", "1", "", "", "", "", "", request, requestedAt, attempt, attemptAt, attemptRequest, contacts,
            ).joinToString("|")
            assertTrue("$service record should fail closed", freshStore().status(first, service).structuralStorageFailure)
            storage.values.clear()
        }

        record(SyncStatusStore.Service.CALENDAR, request = "request", requestedAt = "1", attemptRequest = "request")
        record(SyncStatusStore.Service.CALENDAR, request = "raw request", requestedAt = "1")
        record(SyncStatusStore.Service.CALENDAR, attempt = "https://attempt.invalid", attemptAt = "1")
        record(SyncStatusStore.Service.CONTACTS, attempt = "parent", attemptAt = "1", contacts = "$hash;$hash:SUCCESS:")
        record(SyncStatusStore.Service.CONTACTS, attempt = "parent", attemptAt = "1", contacts = "not-a-sha256;")
        record(SyncStatusStore.Service.CONTACTS, attempt = "parent", attemptAt = "1", contacts = "$hash;$hash:REMOVED:NETWORK")
        record(SyncStatusStore.Service.CONTACTS, attempt = "parent", attemptAt = "1", contacts = "$hash;$hash:FAILURE:CHILD_REMOVED")
    }

    @Test fun `writers reject unsafe opaque IDs child keys and direct active contacts terminals`() {
        fun assertRejected(write: () -> Unit) {
            try {
                write()
                fail("expected invalid lifecycle input to be rejected")
            } catch (_: IllegalArgumentException) {
            }
        }
        assertRejected { store.recordRequested(first, setOf(SyncStatusStore.Service.CALENDAR), "raw request", 1) }
        assertRejected { store.recordRequested(first, setOf(SyncStatusStore.Service.CALENDAR), "request|delimiter", 1) }
        assertRejected { store.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "raw attempt", 1, null) }
        assertRejected { store.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "attempt;delimiter", 1, null) }

        val unsafeChild = Account("unsafe-child", "child")
        children[unsafeChild] = "not-a-sha256"
        assertRejected { store.beginContacts(first, setOf(unsafeChild), startedAt = 1, attemptId = "parent") }

        val child = child("direct-terminal")
        val attempt = begin(setOf(child), "direct-parent")
        assertRejected { store.recordSuccess(first, SyncStatusStore.Service.CONTACTS, attempt.attemptId, 2) }
        assertRejected {
            store.recordFailure(first, SyncStatusStore.Service.CONTACTS, attempt.attemptId,
                SyncStatusStore.FailureCategory.NETWORK, 2)
        }
    }

    @Test fun `confirmed child removal snapshots main identity once`() {
        val child = child("one-lookup")
        begin(setOf(child), "one-lookup-attempt")
        var lookups = 0
        val changingStore = SyncStatusStore(storage,
            mainAccountKey = { if (lookups++ == 0) "first-generation" else "replacement-generation" },
            childAccountKey = { children[it] ?: error("missing child") })
        val identity = changingStore.identity(first)
        assertTrue(changingStore.recordContactsChildRemoved(identity, child))
        assertEquals(1, lookups)
        assertEquals(SyncStatusStore.FailureCategory.CHILD_REMOVED,
            store.status(first, SyncStatusStore.Service.CONTACTS).lastFailureCategory)
    }

    @Test fun `request attempt terminal finish rebase expiry and clear capture exact identity once`() {
        fun changingStore(counter: IntArray) = SyncStatusStore(storage,
            mainAccountKey = { if (counter[0]++ == 0) "first-generation" else "replacement-generation" },
            childAccountKey = { children[it] ?: "d".repeat(64) })
        fun assertOne(action: (SyncStatusStore) -> Unit) {
            val counter = intArrayOf(0)
            action(changingStore(counter))
            assertEquals(1, counter[0])
        }
        assertOne { it.recordRequested(first, setOf(SyncStatusStore.Service.TASKS), "one-request", 1) }
        assertOne { it.beginAttempt(first, SyncStatusStore.Service.CALENDAR, "one-attempt", 1, null) }
        assertOne { it.recordSuccess(first, SyncStatusStore.Service.TASKS, 1) }

        val seed = SyncStatusStore(storage, mainAccountKey = { "first-generation" }, childAccountKey = { "d".repeat(64) })
        assertTrue(seed.beginAttempt(first, SyncStatusStore.Service.CONTACTS, "finish-attempt", 1, null))
        assertOne { it.finishWithoutOutcome(first, SyncStatusStore.Service.CONTACTS, "finish-attempt") }
        assertTrue(seed.recordRequested(first, setOf(SyncStatusStore.Service.CALENDAR), "rebase-request", 100))
        assertOne { it.rebaseFutureLifecycle(first, SyncStatusStore.Service.CALENDAR, 10) }
        assertOne { it.expireStale(first, SyncStatusStore.Service.CALENDAR, 40, false, false, 30) }
        val captured = seed.identity(first)
        assertTrue(seed.clear(captured))
    }

    @Test fun `confirmed child removal and exact clear preserve generation isolation`() {
        val child = child("remove-snapshot")
        val attempt = begin(setOf(child), "remove-snapshot-attempt")
        assertEquals("remove-snapshot-attempt", attempt.attemptId)
        assertTrue(store.recordContactsChildRemoved(first, child))
        assertTrue(store.recordSuccess(second, SyncStatusStore.Service.TASKS, 2))
        val removed = store.identity(first)
        assertTrue(store.clear(removed))
        assertEquals(2L, store.status(second, SyncStatusStore.Service.TASKS).lastSuccessAt)
        assertEquals(SyncStatusStore.Status(), store.status(readded, SyncStatusStore.Service.TASKS))
    }
}
