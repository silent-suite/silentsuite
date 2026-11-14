package io.silentsuite.sync

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The upgrade migrations across a real in-place reinstall (run-registry-process-boundary.sh): the
 * first step stores an older app version in a running app process, the script reinstalls the APK
 * over the existing data, and the second step, in a fresh process, finds the migration done. Only
 * the script runs these steps, in this order; they are not part of the focused runtime ledger.
 */
class AppUpgradeProcessBoundaryRuntimeTest {

    private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun seedsAnOlderAppVersionBeforeTheUpgrade() {
        // Version 9 is below the "AddAccount" hint migration (fromVersion < 10) and above the
        // provider-wide etag migration (fromVersion < 7), so only the hint shows whether it ran.
        assertTrue(context.getSharedPreferences(APP_PREFS, Context.MODE_PRIVATE).edit()
            .putInt(VERSION_KEY, SEEDED_VERSION).commit())
        assertTrue(context.getSharedPreferences(HINT_PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(HINT, false).commit())
        assertEquals(SEEDED_VERSION, context.getSharedPreferences(APP_PREFS, Context.MODE_PRIVATE).getInt(VERSION_KEY, 0))
        assertFalse(hintSeen())
    }

    @Test fun upgradeMigrationHasRunInTheFirstProcessAfterTheReinstall() {
        assertEquals("FEATURE: the stored app version is this build's after the upgrade",
            BuildConfig.VERSION_CODE, context.getSharedPreferences(APP_PREFS, Context.MODE_PRIVATE).getInt(VERSION_KEY, 0))
        assertTrue("FEATURE: the migration for versions below 10 ran", hintSeen())
    }

    /** Read directly, as the app's hint store keeps it (prefs "hints"). */
    private fun hintSeen() = context.getSharedPreferences(HINT_PREFS, Context.MODE_PRIVATE).getBoolean(HINT, false)

    private companion object {
        const val APP_PREFS = "app"
        const val VERSION_KEY = "version"
        const val HINT_PREFS = "hints"
        const val HINT = "AddAccount"
        const val SEEDED_VERSION = 9
    }
}
