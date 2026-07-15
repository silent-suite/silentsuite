package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import com.etebase.client.Account as EtebaseAccount
import com.etebase.client.Client
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.ui.ActiveAccountManager
import java.net.URI
import java.util.UUID

/**
 * Raw legacy migration.  This deliberately never constructs [AccountSettings]: its constructor
 * performs a best-effort mutating migration and swallows failures, which is not a durable
 * migration boundary.  Every write below is individually read back.
 */
object PostLoginSetupMigration {
    const val MIGRATION_VERSION = 1

    data class LegacyRow(
        val version: String?, val username: String?, val uri: String?, val session: String?,
        val pendingCreation: Boolean
    )
    data class Row(val key: String, val legacy: LegacyRow, val state: String?, val creationId: String?)

    /** Injectable raw store: JVM tests can exercise failure/restart ordering without AccountManager. */
    interface Store {
        fun marker(): Int
        fun rows(): List<Row>
        fun write(row: Row, key: String, value: String?): Boolean
        fun recordRecovery(row: Row): Boolean
        fun writeMarker(version: Int): Boolean
    }

    fun isBootstrapped(context: Context): Boolean =
        context.getSharedPreferences("post_login_setup_migration", Context.MODE_PRIVATE)
            .getInt("version", 0) == MIGRATION_VERSION

    /**
     * AccountManager state is the preferred user-visible recovery marker, but the exact
     * compare-owned registry record is the durable fallback when user-data persistence fails.
     */
    internal fun persistPendingRecovery(writeState: () -> Boolean, updateRegistry: () -> Boolean): Boolean {
        writeState()
        return updateRegistry()
    }

    fun classify(row: LegacyRow, sessionParses: (String, String?) -> Boolean = { session, uri ->
        locallyParseSession(session, uri)
    }): PostLoginSetupState {
        if (row.pendingCreation || row.username.isNullOrBlank() || row.session.isNullOrBlank())
            return PostLoginSetupState.RECOVERY_REQUIRED
        if (row.version?.toIntOrNull() !in 0..AccountSettings.CURRENT_VERSION)
            return PostLoginSetupState.RECOVERY_REQUIRED
        if (row.uri != null) {
            val uri = runCatching { URI(row.uri) }.getOrNull()
            if (uri == null || !uri.isAbsolute || uri.host.isNullOrBlank() || uri.scheme !in setOf("http", "https"))
                return PostLoginSetupState.RECOVERY_REQUIRED
        }
        return if (sessionParses(row.session, row.uri)) PostLoginSetupState.COMPLETE else PostLoginSetupState.RECOVERY_REQUIRED
    }

    /** Returns false unless every row is durably classified (or durably recovery-recorded). */
    fun bootstrap(store: Store, sessionParses: (String, String?) -> Boolean = ::locallyParseSession): Boolean {
        if (store.marker() == MIGRATION_VERSION) return true
        for (row in store.rows()) {
            var working = row
            // addAccountExplicitly may have returned true just before a process death. Without
            // the exact creation ID this row is not owned, so only the registry is allowed to
            // record recovery; AccountManager user data must remain untouched for Settings.
            if (row.legacy.pendingCreation && row.creationId.isNullOrBlank()) {
                if (!store.recordRecovery(row)) return false
                continue
            }
            // A matching owned row is repaired by the creation recovery path, not recast as
            // legacy. In particular, preserve a durable ACCOUNT_CREATED boundary so the
            // authenticator handoff can be recovered after process death.
            if (row.legacy.pendingCreation) continue
            // A historical state without a durable generation is not safe to trust: a
            // removed/re-added same-name row could otherwise inherit it.
            if (!row.legacy.pendingCreation && !row.creationId.isNullOrBlank() &&
                PostLoginSetupState.values().any { it.name == row.state }) continue
            var state = classify(row.legacy, sessionParses)
            // Supported historic versions are explicitly upgraded and read back before restore.
            if (state == PostLoginSetupState.COMPLETE && row.legacy.version != AccountSettings.CURRENT_VERSION.toString() &&
                !store.write(row, AccountSettings.KEY_SETTINGS_VERSION, AccountSettings.CURRENT_VERSION.toString())) {
                state = PostLoginSetupState.RECOVERY_REQUIRED
            }
            // Account.restore is local-only and is intentionally checked after raw migration writes.
            if (state == PostLoginSetupState.COMPLETE && !sessionParses(requireNotNull(row.legacy.session), row.legacy.uri))
                state = PostLoginSetupState.RECOVERY_REQUIRED
            if (working.creationId.isNullOrBlank()) {
                val generated = UUID.randomUUID().toString()
                if (!store.write(working, AccountSettings.KEY_CREATION_ID, generated)) return false
                working = working.copy(creationId = generated)
            }
            if (!store.write(working, AccountSettings.KEY_POST_LOGIN_SETUP_STATE, state.name) && !store.recordRecovery(working))
                return false
        }
        return store.writeMarker(MIGRATION_VERSION) && store.marker() == MIGRATION_VERSION
    }

    fun bootstrap(context: Context): Boolean {
        val manager = AccountManager.get(context)
        val registry = AccountCreationRegistry.open(context)
        // Unknown ownership data is a fail-closed bootstrap error; do not reinterpret its rows
        // as legacy and mutate them.
        if (registry.records() == null) return false
        val prefs = context.getSharedPreferences("post_login_setup_migration", Context.MODE_PRIVATE)
        val migrated = bootstrap(object : Store {
            private val accounts get() = manager.getAccountsByType(App.accountType)
            // Raw classification intentionally cannot publish the global admission marker.
            override fun marker() = 0
            override fun rows() = accounts.map { account ->
                Row("${account.type}\u0000${account.name}", LegacyRow(
                    manager.getUserData(account, AccountSettings.KEY_SETTINGS_VERSION),
                    manager.getUserData(account, AccountSettings.KEY_USERNAME),
                    manager.getUserData(account, AccountSettings.KEY_URI),
                    manager.getUserData(account, AccountSettings.KEY_ETEBASE_SESSION),
                    registry.get(account.type, account.name) != null
                ), manager.getUserData(account, AccountSettings.KEY_POST_LOGIN_SETUP_STATE),
                    manager.getUserData(account, AccountSettings.KEY_CREATION_ID))
            }
            private fun account(row: Row): Account? = accounts.firstOrNull { "${it.type}\u0000${it.name}" == row.key }
            override fun write(row: Row, key: String, value: String?): Boolean = account(row)?.let {
                AccountSettings.writeVerified(manager, it, key, value)
            } ?: false
            override fun recordRecovery(row: Row): Boolean {
                val account = account(row) ?: return false
                val current = registry.get(account.type, account.name)
                return if (current != null) registry.updateOwned(current.copy(phase = AccountCreationRegistry.Phase.RECOVERY_REQUIRED))
                else registry.prepare(AccountCreationRegistry.Record(account.name, row.creationId ?: return false,
                    AccountCreationRegistry.Phase.RECOVERY_REQUIRED, System.currentTimeMillis(), account.type))
            }
            override fun writeMarker(version: Int) = version == MIGRATION_VERSION
        })
        return PostLoginBootstrapCoordinator.run(
            classifyRows = { migrated },
            reconcilePending = { reconcilePendingCreationRows(context, manager, registry) },
            commitMarker = { prefs.edit().putInt("version", MIGRATION_VERSION).commit() && prefs.getInt("version", 0) == MIGRATION_VERSION }
        )
    }

    /**
     * Startup repair is deliberately ownership-first. No-ID and mismatched rows are visible to
     * Android Settings but are never modified or removed by the app; only an exact owned row is
     * eligible for post-boundary activation/registry cleanup.
     */
    private fun reconcilePendingCreationRows(context: Context, manager: AccountManager,
                                              registry: AccountCreationRegistry): Boolean {
        val records = registry.records() ?: return false
        for (record in records) {
            val account = manager.getAccountsByType(record.accountType).firstOrNull { it.name == record.accountName }
            if (account == null) {
                if (!registry.clearOwned(record.accountType, record.accountName, record.creationId)) return false
                continue
            }
            val creationId = manager.getUserData(account, AccountSettings.KEY_CREATION_ID)
            if (creationId != record.creationId) {
                // Compare-owned registry quarantine; do not mutate the ambiguous row.
                if (!registry.updateOwned(record.copy(phase = AccountCreationRegistry.Phase.RECOVERY_REQUIRED))) return false
                continue
            }
            val state = AccountSettings.setupState(manager, account, true)
            if (state in setOf(PostLoginSetupState.ACCOUNT_CREATED, PostLoginSetupState.COLLECTIONS,
                    PostLoginSetupState.PERMISSIONS, PostLoginSetupState.INITIAL_SYNC,
                    PostLoginSetupState.READY, PostLoginSetupState.COMPLETE)) {
                if (!ActiveAccountManager.setActiveAccount(context, account) ||
                    !registry.clearOwned(record.accountType, record.accountName, record.creationId)) return false
            } else {
                // API 21 removal is asynchronous. Keep exact-owned partial rows quarantined
                // for explicit Settings/user recovery instead of pretending removal completed.
                // A verified AccountManager state is preferred, but a durable exact registry
                // record is sufficient to finish bootstrap when user-data persistence fails.
                if (!persistPendingRecovery(
                        writeState = { AccountSettings.writeSetupState(manager, account, PostLoginSetupState.RECOVERY_REQUIRED) },
                        updateRegistry = { registry.updateOwned(record.copy(phase = AccountCreationRegistry.Phase.RECOVERY_REQUIRED)) }
                    )) return false
            }
        }
        return true
    }

    /** Account.restore parses the established signed session locally; it never makes a request. */
    private fun locallyParseSession(session: String, uri: String?): Boolean = runCatching {
        EtebaseAccount.restore(Client.create(HttpClient.sharedClient, uri ?: Constants.etebaseServiceUrl), session, null)
        true
    }.getOrDefault(false)
}
