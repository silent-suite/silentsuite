package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.accounts.AccountManager
import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.utils.AndroidCompat
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SyncStatusRuntimeTest {
    @Test fun contactsAttemptExtraRoundTripsAtProviderBoundary() {
        val extras = Bundle()
        putContactsAttempt(extras, "opaque-attempt")
        assertEquals("opaque-attempt", contactsAttempt(extras))
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
