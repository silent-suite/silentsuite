package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.accounts.AccountManager
import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.ui.account.AccountDashboardInput
import io.silentsuite.sync.ui.account.AccountDashboardLabel
import io.silentsuite.sync.ui.account.presentAccountDashboard
import io.silentsuite.sync.ui.account.reduceAccountDashboardState
import io.silentsuite.sync.utils.AndroidCompat
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SyncStatusRuntimeTest {
    @Test fun v1EvidenceReadsCompatiblyAndV2MutationStaysExactAndPrivate() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val preferences = context.getSharedPreferences("sync_status_v1", 0)
        preferences.edit().clear().commit()
        val account = Account("runtime-v2-${System.nanoTime()}@example.invalid", App.accountType)
        val manager = AccountManager.get(context)
        check(manager.addAccountExplicitly(account, null, null))
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "runtime-v2-generation"))
        try {
            val store = SyncStatusStore(context)
            // A v1-only process must still read the frozen terminal shadow before the next v2 write.
            assertTrue(store.recordSuccess(account, SyncStatusStore.Service.CALENDAR, 10))
            preferences.all.keys.filter { it.startsWith("status_v2.") }.forEach { preferences.edit().remove(it).commit() }
            assertEquals(10L, SyncStatusStore(context).status(account, SyncStatusStore.Service.CALENDAR).lastSuccessAt)
            assertTrue(store.recordFailure(account, SyncStatusStore.Service.CALENDAR,
                SyncStatusStore.FailureCategory.INTERRUPTED, 11))
            assertTrue(preferences.all.keys.any { it.startsWith("status_v2.") })
            assertTrue(preferences.all.keys.any { it.startsWith("status.") })
            assertFalse(preferences.all.toString().contains(account.name))
        } finally {
            AndroidCompat.removeAccount(manager, account)
            preferences.edit().clear().commit()
        }
    }

    @Test fun manualRequestPersistsBeforeDispatchAndMatchingTerminalClearsLifecycle() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val preferences = context.getSharedPreferences("sync_status_v1", 0)
        val manager = AccountManager.get(context)
        val account = Account("runtime-request-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(account, null, null))
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "runtime-request-generation"))
        try {
            val store = SyncStatusStore(context)
            val historicalFailureAt = System.currentTimeMillis() - 10_000
            assertTrue(store.recordFailure(account, SyncStatusStore.Service.CALENDAR,
                SyncStatusStore.FailureCategory.NETWORK, historicalFailureAt))
            val dispatched = mutableListOf<String>()
            requestSyncDispatchOverride = { _, authority, _ ->
                // The dispatcher is deliberately held here: evidence must be visible before a
                // real adapter can complete and replace it.
                assertEquals("runtime-request", store.status(account,
                    SyncStatusStore.Service.CALENDAR).activeRequestId)
                dispatched += authority
            }
            val beforeRequest = System.currentTimeMillis()
            requestSync(context, account, explicitRequestId = "runtime-request")
            val afterRequest = System.currentTimeMillis()
            val requested = store.status(account, SyncStatusStore.Service.CALENDAR)
            assertEquals("runtime-request", requested.activeRequestId)
            assertTrue(requireNotNull(requested.requestedAt) in beforeRequest..afterRequest)
            assertTrue(requireNotNull(requested.requestedAt) > historicalFailureAt)
            assertEquals(AccountDashboardLabel.REQUESTED, presentAccountDashboard(
                reduceAccountDashboardState(AccountDashboardInput(
                    loaded = true, running = false, pending = false, setupComplete = true,
                    masterSyncEnabled = true, permissionReady = true, providerReady = true,
                    collectionsAvailable = true, status = requested,
                )), requested.requestedAt
            ).label)
            assertTrue(dispatched.isNotEmpty())
            val extras = Bundle().also { putSyncAttempt(it, "runtime-attempt") }
            assertEquals("runtime-attempt", syncAttempt(extras))
            val attemptAt = System.currentTimeMillis()
            assertTrue(store.beginAttempt(account, SyncStatusStore.Service.CALENDAR, "runtime-attempt", attemptAt, "runtime-request"))
            val terminalAt = System.currentTimeMillis()
            assertTrue(store.recordSuccess(account, SyncStatusStore.Service.CALENDAR, "runtime-attempt", terminalAt))
            assertNull(store.status(account, SyncStatusStore.Service.CALENDAR).activeRequestId)
            assertNull(store.status(account, SyncStatusStore.Service.CALENDAR).activeAttemptId)

            val child = Account("runtime-contacts-child", "child")
            val mainIdentity = store.identity(account)
            val childIdentity = store.childIdentity(child, "runtime-child-generation")
            assertTrue(store.beginAttempt(account, SyncStatusStore.Service.CONTACTS, "contacts-success",
                System.currentTimeMillis(), "runtime-request"))
            assertEquals(SyncStatusStore.ContactsStart.Started("contacts-success"),
                attachContactsChildrenAtAdapterBoundary(store, mainIdentity, "contacts-success", setOf(childIdentity),
                    System.currentTimeMillis()))
            val childSuccess = contactsChildTarget(mainIdentity, "contacts-success", childIdentity)!!
            assertEquals(SyncStatusStore.MutationResult.RECORDED,
                recordContactsChildAtAdapterBoundary(store, childSuccess,
                    SyncStatusStore.ChildResult.SUCCESS, timestamp = System.currentTimeMillis()))
            assertTrue(store.beginAttempt(account, SyncStatusStore.Service.CONTACTS, "contacts-failure",
                System.currentTimeMillis(), null))
            assertEquals(SyncStatusStore.ContactsStart.Started("contacts-failure"),
                attachContactsChildrenAtAdapterBoundary(store, mainIdentity, "contacts-failure", setOf(childIdentity),
                    System.currentTimeMillis()))
            val childFailure = contactsChildTarget(mainIdentity, "contacts-failure", childIdentity)!!
            assertEquals(SyncStatusStore.MutationResult.RECORDED,
                recordContactsChildAtAdapterBoundary(store, childFailure,
                    SyncStatusStore.ChildResult.FAILURE, SyncStatusStore.FailureCategory.PROVIDER,
                    System.currentTimeMillis()))
            assertEquals(SyncStatusStore.FailureCategory.PROVIDER,
                store.status(account, SyncStatusStore.Service.CONTACTS).lastFailureCategory)
        } finally {
            requestSyncDispatchOverride = null
            AndroidCompat.removeAccount(manager, account)
            preferences.edit().clear().commit()
        }
    }

    @Test fun contactsAttemptExtraRoundTripsAtProviderBoundary() {
        val extras = Bundle()
        val mainIdentity = SyncStatusStore.identityFromStorageKey("a".repeat(64))!!
        val childIdentity = SyncStatusStore.childIdentityFromStorageKey("b".repeat(64))!!
        putContactsTarget(extras, mainIdentity, "opaque-attempt", childIdentity)
        val target = requireNotNull(contactsChildTarget(extras))
        assertEquals("opaque-attempt", target.attemptId)
        assertEquals(mainIdentity, target.mainIdentity)
        assertEquals(childIdentity, target.childIdentity)
    }

    @Test fun requestAndParentChildCorrelationExtrasRoundTripAtAndroidBoundary() {
        val requestExtras = Bundle()
        putSyncRequestId(requestExtras, "opaque-request")
        assertEquals("opaque-request", syncRequestId(requestExtras))

        val attemptExtras = Bundle()
        putSyncAttempt(attemptExtras, "parent-attempt")
        putContactsParent(attemptExtras, SyncStatusStore.identityFromStorageKey("c".repeat(64))!!,
            requireNotNull(syncAttempt(attemptExtras)))
        assertEquals("parent-attempt", contactsAttempt(attemptExtras))
        assertEquals("parent-attempt", syncAttempt(attemptExtras))
    }

    @Test fun persistedEvidenceIsExactAccountGenerationScopedAndContainsNoAccountName() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val preferences = context.getSharedPreferences("sync_status_v1", 0)
        preferences.edit().clear().commit()
        val first = Account("runtime-first-${System.nanoTime()}@example.invalid", App.accountType)
        val second = Account("runtime-second-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(first, null, null))
        check(manager.addAccountExplicitly(second, null, null))
        check(AccountSettings.writeVerified(manager, first, AccountSettings.KEY_CREATION_ID, "generation-one"))
        check(AccountSettings.writeVerified(manager, second, AccountSettings.KEY_CREATION_ID, "generation-two"))
        try {
            val store = SyncStatusStore(context)
            store.recordSuccess(first, SyncStatusStore.Service.CALENDAR, 100)
            store.recordFailure(second, SyncStatusStore.Service.CALENDAR, SyncStatusStore.FailureCategory.PERMISSION, 200)

            assertEquals(100L, store.status(first, SyncStatusStore.Service.CALENDAR).lastSuccessAt)
            assertNull(store.status(first, SyncStatusStore.Service.CALENDAR).lastFailureAt)
            assertEquals(SyncStatusStore.FailureCategory.PERMISSION, store.status(second, SyncStatusStore.Service.CALENDAR).lastFailureCategory)
            val persisted = preferences.all.toString()
            assertFalse(persisted.contains(first.name))
            assertFalse(persisted.contains(second.name))
            assertFalse(persisted.contains("generation-one"))
            assertFalse(persisted.contains("generation-two"))

            val removedIdentity = store.identity(first)
            val recordsBeforeRemoval = preferences.all.size
            AndroidCompat.removeAccount(manager, first)
            val removalDeadline = android.os.SystemClock.uptimeMillis() + 5000
            while (manager.getAccountsByType(App.accountType).any { it == first } &&
                android.os.SystemClock.uptimeMillis() < removalDeadline) {
                android.os.SystemClock.sleep(25)
            }
            assertTrue(manager.getAccountsByType(App.accountType).none { it == first })
            assertTrue(store.clear(removedIdentity))
            assertTrue(preferences.all.size < recordsBeforeRemoval)
            check(manager.addAccountExplicitly(first, null, null))
            check(AccountSettings.writeVerified(manager, first, AccountSettings.KEY_CREATION_ID, "generation-readded"))
            assertEquals(SyncStatusStore.Status(), SyncStatusStore(context).status(first, SyncStatusStore.Service.CALENDAR))
        } finally {
            AndroidCompat.removeAccount(manager, first)
            AndroidCompat.removeAccount(manager, second)
            preferences.edit().clear().commit()
            val cleanupDeadline = android.os.SystemClock.uptimeMillis() + 5000
            while (manager.getAccountsByType(App.accountType).any { it == first || it == second } &&
                android.os.SystemClock.uptimeMillis() < cleanupDeadline) {
                android.os.SystemClock.sleep(25)
            }
            assertTrue(manager.getAccountsByType(App.accountType).none { it == first || it == second })
        }
    }
}
