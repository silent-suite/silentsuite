package io.silentsuite.sync.ui.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppPreferencesTest {
    @Test
    fun migrationPreservesEveryPreviouslyAuthoritativeValueAndRemovesAliases() {
        val app = mutableMapOf<String, Any?>(
            "theme_mode" to 2,
            "forceLanguage" to "de",
            "overrideProxy" to true,
            "overrideProxyHost" to "proxy.example",
            "overrideProxyPort" to "8443",
            "distrustSystemCerts" to true
        )
        val defaults = mutableMapOf<String, Any?>(
            "preferTasksOrg" to true,
            "show_change_notification" to false,
            "log_to_file" to true,
            "log_verbose" to true,
            // These stale duplicates must not beat the values consumed before migration.
            "override_proxy" to false,
            "select_language" to "fr"
        )

        AppPreferenceMigration.migrate(app, defaults)

        assertEquals(2, app[AppPreferences.KEY_THEME_MODE])
        assertEquals("de", app[AppPreferences.KEY_FORCE_LANGUAGE])
        assertEquals(true, app[AppPreferences.KEY_OVERRIDE_PROXY])
        assertEquals("proxy.example", app[AppPreferences.KEY_PROXY_HOST])
        assertEquals(8443, app[AppPreferences.KEY_PROXY_PORT])
        assertEquals(true, app[AppPreferences.KEY_DISTRUST_SYSTEM_CERTS])
        assertEquals(true, app[AppPreferences.KEY_PREFER_TASKSORG])
        assertEquals(false, app[AppPreferences.KEY_CHANGE_NOTIFICATION])
        assertEquals(true, app[AppPreferences.KEY_LOG_TO_FILE])
        assertEquals(true, app[AppPreferences.KEY_LOG_VERBOSE])
        assertTrue(app[AppPreferences.KEY_MIGRATION_COMPLETE] == true)
        assertFalse(app.containsKey("forceLanguage"))
        assertFalse(app.containsKey("overrideProxy"))
        assertFalse(defaults.containsKey("preferTasksOrg"))
        assertFalse(defaults.containsKey("override_proxy"))
        assertFalse(defaults.containsKey("log_to_file"))
    }

    @Test
    fun migrationFallsBackToDuplicateValuesWhenLegacyAuthoritativeKeyWasNeverWritten() {
        val app = mutableMapOf<String, Any?>()
        val defaults = mutableMapOf<String, Any?>(
            "theme_mode" to "1",
            "select_language" to "es",
            "proxy_port" to "not-a-port",
            "prefer_tasksorg" to false
        )

        AppPreferenceMigration.migrate(app, defaults)

        assertEquals(1, app[AppPreferences.KEY_THEME_MODE])
        assertEquals("es", app[AppPreferences.KEY_FORCE_LANGUAGE])
        assertEquals(AppPreferences.DEFAULT_PROXY_PORT, app[AppPreferences.KEY_PROXY_PORT])
        assertEquals(false, app[AppPreferences.KEY_PREFER_TASKSORG])
    }

    @Test
    fun invalidAuthoritativeProxyPortFallsThroughToValidDuplicate() {
        val app = mutableMapOf<String, Any?>("overrideProxyPort" to "not-a-port")
        val defaults = mutableMapOf<String, Any?>("proxy_port" to "9050")

        AppPreferenceMigration.migrate(app, defaults)

        assertEquals(9050, app[AppPreferences.KEY_PROXY_PORT])
    }

    @Test
    fun completedMigrationIsIdempotentAndNeverOverwritesCanonicalValues() {
        val app = mutableMapOf<String, Any?>(
            AppPreferences.KEY_MIGRATION_COMPLETE to true,
            AppPreferences.KEY_OVERRIDE_PROXY to true
        )
        val defaults = mutableMapOf<String, Any?>("override_proxy" to false)

        AppPreferenceMigration.migrate(app, defaults)

        assertEquals(true, app[AppPreferences.KEY_OVERRIDE_PROXY])
        assertEquals(false, defaults["override_proxy"])
    }

    @Test
    fun proxyHostValidationAcceptsOnlyHostValues() {
        listOf("proxy.example", "127.0.0.1", "[::1]").forEach {
            assertTrue("Expected valid proxy host: $it", ProxySettingsValidation.isValidHost(it))
        }
        listOf("", "proxy.example:8080", "http://proxy.example", "user@proxy.example", "proxy.example/path", "bad host").forEach {
            assertFalse("Expected invalid proxy host: $it", ProxySettingsValidation.isValidHost(it))
        }
    }

    @Test
    fun proxyPortValidationAcceptsInclusiveBoundsAndRejectsInvalidInput() {
        assertEquals(1, ProxySettingsValidation.parsePort("1"))
        assertEquals(65535, ProxySettingsValidation.parsePort("65535"))
        listOf("0", "65536", "-1", "", "not-a-port").forEach {
            assertEquals("Expected invalid proxy port: $it", null, ProxySettingsValidation.parsePort(it))
        }
    }
}
