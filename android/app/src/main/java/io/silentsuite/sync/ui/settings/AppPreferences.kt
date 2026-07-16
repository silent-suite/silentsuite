package io.silentsuite.sync.ui.settings

import android.content.Context
import android.content.SharedPreferences
import androidx.appcompat.app.AppCompatDelegate
import androidx.preference.PreferenceManager

internal enum class MigrationCommitStage { CANONICAL, DEFAULT_ALIASES, MARKER }

/**
 * Validates the host-only value accepted by [java.net.InetSocketAddress].
 * A proxy port is stored separately, so a scheme, path, user info, or embedded port must not
 * silently become part of the host value.
 */
internal object ProxySettingsValidation {
    fun isValidHost(value: String): Boolean = try {
        val uri = java.net.URI("http://$value")
        value.isNotBlank() &&
            value.none(Char::isWhitespace) &&
            uri.host != null &&
            uri.userInfo == null &&
            uri.port == -1 &&
            uri.path.isNullOrEmpty() &&
            uri.query == null &&
            uri.fragment == null
    } catch (_: java.net.URISyntaxException) {
        false
    }

    fun parsePort(value: String): Int? = value.toIntOrNull()?.takeIf { it in 1..65535 }
}

/** Typed owner of global app preferences. Account-scoped values never belong here. */
class AppPreferences(context: Context) {
    private val appContext = context.applicationContext
    internal val sharedPreferences: SharedPreferences =
        appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    init {
        migrate(appContext, sharedPreferences)
    }

    var themeMode: Int
        get() = sharedPreferences.getInt(KEY_THEME_MODE, AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)
        set(value) { sharedPreferences.edit().putInt(KEY_THEME_MODE, value).apply() }

    var forcedLanguage: String
        get() = sharedPreferences.getString(KEY_FORCE_LANGUAGE, DEFAULT_LANGUAGE) ?: DEFAULT_LANGUAGE
        set(value) { sharedPreferences.edit().putString(KEY_FORCE_LANGUAGE, value).apply() }

    var overrideProxy: Boolean
        get() = sharedPreferences.getBoolean(KEY_OVERRIDE_PROXY, false)
        set(value) { sharedPreferences.edit().putBoolean(KEY_OVERRIDE_PROXY, value).apply() }

    var proxyHost: String
        get() = sharedPreferences.getString(KEY_PROXY_HOST, DEFAULT_PROXY_HOST) ?: DEFAULT_PROXY_HOST
        set(value) { sharedPreferences.edit().putString(KEY_PROXY_HOST, value).apply() }

    var proxyPort: Int
        get() = sharedPreferences.getInt(KEY_PROXY_PORT, DEFAULT_PROXY_PORT)
        set(value) { sharedPreferences.edit().putInt(KEY_PROXY_PORT, value).apply() }

    var distrustSystemCertificates: Boolean
        get() = sharedPreferences.getBoolean(KEY_DISTRUST_SYSTEM_CERTS, false)
        set(value) { sharedPreferences.edit().putBoolean(KEY_DISTRUST_SYSTEM_CERTS, value).apply() }

    var preferTasksOrg: Boolean
        get() = sharedPreferences.getBoolean(KEY_PREFER_TASKSORG, false)
        set(value) { sharedPreferences.edit().putBoolean(KEY_PREFER_TASKSORG, value).apply() }

    var showChangeNotification: Boolean
        get() = sharedPreferences.getBoolean(KEY_CHANGE_NOTIFICATION, true)
        set(value) { sharedPreferences.edit().putBoolean(KEY_CHANGE_NOTIFICATION, value).apply() }

    var logToFile: Boolean
        get() = sharedPreferences.getBoolean(KEY_LOG_TO_FILE, false)
        set(value) { sharedPreferences.edit().putBoolean(KEY_LOG_TO_FILE, value).apply() }

    var verboseLogging: Boolean
        get() = sharedPreferences.getBoolean(KEY_LOG_VERBOSE, false)
        set(value) { sharedPreferences.edit().putBoolean(KEY_LOG_VERBOSE, value).apply() }

    companion object {
        const val PREFERENCES_NAME = "app_settings"
        const val KEY_MIGRATION_COMPLETE = "typed_preferences_migration_v1"
        const val KEY_THEME_MODE = "theme_mode"
        const val KEY_FORCE_LANGUAGE = "force_language"
        const val KEY_OVERRIDE_PROXY = "override_proxy"
        const val KEY_PROXY_HOST = "proxy_host"
        const val KEY_PROXY_PORT = "proxy_port"
        const val KEY_DISTRUST_SYSTEM_CERTS = "distrust_system_certs"
        const val KEY_PREFER_TASKSORG = "prefer_tasksorg"
        const val KEY_CHANGE_NOTIFICATION = "show_change_notification"
        const val KEY_LOG_TO_FILE = "log_to_file"
        const val KEY_LOG_VERBOSE = "log_verbose"
        const val DEFAULT_PROXY_HOST = "localhost"
        const val DEFAULT_PROXY_PORT = 8118
        const val DEFAULT_LANGUAGE = "default"

        /** Runs synchronously so all process-start consumers see one canonical value set. */
        internal fun migrate(
            context: Context,
            app: SharedPreferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE),
            defaults: SharedPreferences = PreferenceManager.getDefaultSharedPreferences(context),
            commit: (MigrationCommitStage, SharedPreferences.Editor) -> Boolean = { _, editor -> editor.commit() }
        ) {
            if (app.getBoolean(KEY_MIGRATION_COMPLETE, false)) return
            val beforeApp = app.all.toMutableMap<String, Any?>()
            val beforeDefaults = defaults.all.toMutableMap<String, Any?>()
            val migratedApp = beforeApp.toMutableMap()
            val migratedDefaults = beforeDefaults.toMutableMap()
            AppPreferenceMigration.migrate(migratedApp, migratedDefaults)

            // Canonical values land first. The marker is written only after both stores commit,
            // making interruption safe: a partial run simply repeats from canonical fallbacks.
            if (!writeDiff(app, beforeApp, migratedApp, MigrationCommitStage.CANONICAL,
                    commit, exclude = setOf(KEY_MIGRATION_COMPLETE))) return
            if (!writeDiff(defaults, beforeDefaults, migratedDefaults,
                    MigrationCommitStage.DEFAULT_ALIASES, commit)) return
            commit(MigrationCommitStage.MARKER,
                app.edit().putBoolean(KEY_MIGRATION_COMPLETE, true))
        }

        private fun writeDiff(
            preferences: SharedPreferences,
            before: Map<String, Any?>,
            after: Map<String, Any?>,
            stage: MigrationCommitStage,
            commit: (MigrationCommitStage, SharedPreferences.Editor) -> Boolean,
            exclude: Set<String> = emptySet()
        ): Boolean {
            val editor = preferences.edit()
            (before.keys - after.keys - exclude).forEach(editor::remove)
            after.forEach { (key, value) ->
                if (key in exclude || before[key] == value) return@forEach
                when (value) {
                    is Boolean -> editor.putBoolean(key, value)
                    is Int -> editor.putInt(key, value)
                    is Long -> editor.putLong(key, value)
                    is Float -> editor.putFloat(key, value)
                    is String -> editor.putString(key, value)
                    is Set<*> -> @Suppress("UNCHECKED_CAST") editor.putStringSet(key, value as Set<String>)
                    null -> editor.remove(key)
                }
            }
            return commit(stage, editor)
        }
    }
}

/** Pure migration policy, separated from Android storage for deterministic JVM coverage. */
internal object AppPreferenceMigration {
    fun migrate(app: MutableMap<String, Any?>, defaults: MutableMap<String, Any?>) {
        if (app[AppPreferences.KEY_MIGRATION_COMPLETE] == true) return

        canonical(app, defaults, AppPreferences.KEY_THEME_MODE,
            sources = listOf(app to "theme_mode", defaults to "theme_mode"), transform = ::intValue)
        canonical(app, defaults, AppPreferences.KEY_FORCE_LANGUAGE,
            sources = listOf(app to "forceLanguage", app to "force_language", defaults to "select_language", defaults to "forceLanguage"), transform = ::stringValue)
        canonical(app, defaults, AppPreferences.KEY_OVERRIDE_PROXY,
            sources = listOf(app to "overrideProxy", app to "override_proxy", defaults to "override_proxy", defaults to "overrideProxy"), transform = ::booleanValue)
        canonical(app, defaults, AppPreferences.KEY_PROXY_HOST,
            sources = listOf(app to "overrideProxyHost", app to "proxy_host", defaults to "proxy_host", defaults to "overrideProxyHost"), transform = ::stringValue)
        canonical(app, defaults, AppPreferences.KEY_PROXY_PORT,
            sources = listOf(app to "overrideProxyPort", app to "proxy_port", defaults to "proxy_port", defaults to "overrideProxyPort"),
            transform = { intValue(it)?.takeIf { port -> port in 1..65535 } })
        // Apply the product default only after every authoritative/duplicate source was tried.
        // Doing this inside the transform would stop firstNotNullOfOrNull too early.
        if (intValue(app[AppPreferences.KEY_PROXY_PORT])?.takeIf { it in 1..65535 } == null)
            app[AppPreferences.KEY_PROXY_PORT] = AppPreferences.DEFAULT_PROXY_PORT
        canonical(app, defaults, AppPreferences.KEY_DISTRUST_SYSTEM_CERTS,
            sources = listOf(app to "distrustSystemCerts", app to "distrust_system_certs", defaults to "distrust_system_certs", defaults to "distrustSystemCerts"), transform = ::booleanValue)
        canonical(app, defaults, AppPreferences.KEY_PREFER_TASKSORG,
            sources = listOf(defaults to "preferTasksOrg", defaults to "prefer_tasksorg", app to "preferTasksOrg", app to "prefer_tasksorg"), transform = ::booleanValue)
        canonical(app, defaults, AppPreferences.KEY_CHANGE_NOTIFICATION,
            sources = listOf(defaults to "show_change_notification", app to "show_change_notification"), transform = ::booleanValue)
        canonical(app, defaults, AppPreferences.KEY_LOG_TO_FILE,
            sources = listOf(defaults to "log_to_file", defaults to "logToExternalStorage", app to "logToExternalStorage", app to "log_to_file"), transform = ::booleanValue)
        canonical(app, defaults, AppPreferences.KEY_LOG_VERBOSE,
            sources = listOf(defaults to "log_verbose", app to "log_verbose"), transform = ::booleanValue)

        val managed = setOf(
            "theme_mode", "forceLanguage", "force_language", "select_language",
            "overrideProxy", "override_proxy", "overrideProxyHost", "proxy_host",
            "overrideProxyPort", "proxy_port", "distrustSystemCerts", "distrust_system_certs",
            "preferTasksOrg", "prefer_tasksorg", "show_change_notification",
            "logToExternalStorage", "log_to_file", "log_verbose"
        )
        managed.forEach(defaults::remove)
        val aliases = managed - setOf(
            AppPreferences.KEY_THEME_MODE, AppPreferences.KEY_FORCE_LANGUAGE,
            AppPreferences.KEY_OVERRIDE_PROXY, AppPreferences.KEY_PROXY_HOST,
            AppPreferences.KEY_PROXY_PORT, AppPreferences.KEY_DISTRUST_SYSTEM_CERTS,
            AppPreferences.KEY_PREFER_TASKSORG, AppPreferences.KEY_CHANGE_NOTIFICATION,
            AppPreferences.KEY_LOG_TO_FILE, AppPreferences.KEY_LOG_VERBOSE
        )
        aliases.forEach(app::remove)
        app[AppPreferences.KEY_MIGRATION_COMPLETE] = true
    }

    private fun canonical(
        app: MutableMap<String, Any?>,
        defaults: MutableMap<String, Any?>,
        key: String,
        sources: List<Pair<MutableMap<String, Any?>, String>>,
        transform: (Any?) -> Any?
    ) {
        val value = sources.firstNotNullOfOrNull { (store, sourceKey) ->
            if (store.containsKey(sourceKey)) transform(store[sourceKey]) else null
        }
        if (value != null) app[key] = value
    }

    private fun booleanValue(value: Any?): Boolean? = when (value) {
        is Boolean -> value
        is String -> value.toBooleanStrictOrNull()
        else -> null
    }

    private fun intValue(value: Any?): Int? = when (value) {
        is Int -> value
        is Number -> value.toInt()
        is String -> value.toIntOrNull()
        else -> null
    }

    private fun stringValue(value: Any?): String? = value as? String
}
