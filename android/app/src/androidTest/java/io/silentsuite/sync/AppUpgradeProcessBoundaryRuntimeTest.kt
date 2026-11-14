package io.silentsuite.sync

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.core.content.ContextCompat
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The upgrade migrations across a real in-place reinstall (run-registry-process-boundary.sh). The
 * first step stores app version 2 and adds an account in a running app process. The script revokes
 * the calendar and contacts permissions and reinstalls the APK over the existing data. The second
 * step, in the first process after that, finds the app started and the version not advanced, since
 * the oldest migration needs those providers. The script grants the permissions again, and the third
 * step, in a fresh process, finds the migration done. Only the script runs these steps, in this
 * order; they are not part of the focused runtime ledger.
 */
class AppUpgradeProcessBoundaryRuntimeTest {

    private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun seedsAnOldAppVersionAndAnAccountBeforeTheUpgrade() {
        val manager = AccountManager.get(context)
        assertTrue("the upgrade account was added",
            manager.addAccountExplicitly(account(), null, Bundle().apply {
                putString(AccountSettings.KEY_SETTINGS_VERSION, AccountSettings.CURRENT_VERSION.toString())
            }))
        // Never synced: the steps observe only start-up.
        for (adapter in ContentResolver.getSyncAdapterTypes().filter { it.accountType == App.accountType })
            ContentResolver.setIsSyncable(account(), adapter.authority, 0)
        // Version 2 is below the provider-wide etag migration (< 7) and the hint migration (< 10).
        assertTrue(context.getSharedPreferences(APP_PREFS, Context.MODE_PRIVATE).edit()
            .putInt(VERSION_KEY, SEEDED_VERSION).commit())
        assertTrue(context.getSharedPreferences(HINT_PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(HINT, false).commit())
        assertEquals(SEEDED_VERSION, storedVersion())
        assertFalse(hintSeen())
    }

    @Test fun withoutCalendarAndContactsPermissionsTheAppStartsAndKeepsTheOldVersion() {
        assertFalse("fixture: the calendar permission is revoked", granted(Manifest.permission.READ_CALENDAR))
        assertTrue("fixture: the upgrade account exists", AccountManager.get(context).getAccountsByType(App.accountType).contains(account()))
        // Reaching this point means Application.onCreate returned in this process.
        assertEquals("FEATURE: the version isn't advanced past the unfinished migration", SEEDED_VERSION, storedVersion())
    }

    @Test fun afterTheGrantTheUpgradeMigrationCompletesInAFreshProcess() {
        try {
            assertTrue("fixture: the calendar permission is granted again", granted(Manifest.permission.READ_CALENDAR))
            assertEquals("FEATURE: the stored app version is this build's after the upgrade",
                BuildConfig.VERSION_CODE, storedVersion())
            assertTrue("FEATURE: the migration for versions below 10 ran", hintSeen())
        } finally {
            val manager = AccountManager.get(context)
            if (manager.getAccountsByType(App.accountType).contains(account()))
                assertTrue("the upgrade account was removed", manager.removeAccountExplicitly(account()))
        }
    }

    private fun account() = Account(ACCOUNT_NAME, App.accountType)

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun storedVersion() = context.getSharedPreferences(APP_PREFS, Context.MODE_PRIVATE).getInt(VERSION_KEY, 0)

    /** Read directly, as the app's hint store keeps it (prefs "hints"). */
    private fun hintSeen() = context.getSharedPreferences(HINT_PREFS, Context.MODE_PRIVATE).getBoolean(HINT, false)

    private companion object {
        const val APP_PREFS = "app"
        const val VERSION_KEY = "version"
        const val HINT_PREFS = "hints"
        const val HINT = "AddAccount"
        const val SEEDED_VERSION = 2
        const val ACCOUNT_NAME = "upgrade-boundary@example.invalid"
    }
}
