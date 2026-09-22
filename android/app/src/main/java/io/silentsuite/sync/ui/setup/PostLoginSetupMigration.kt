package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.SharedPreferences
import com.etebase.client.Account as EtebaseAccount
import com.etebase.client.Client
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.ui.ActiveAccountManager
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.Phase
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.Reason
import java.net.URI
import java.util.UUID

/**
 * Raw legacy migration.  This deliberately never constructs [AccountSettings]: its constructor
 * performs a best-effort mutating migration and swallows failures, which is not a durable
 * migration boundary.  Every write below is individually read back.
 */
object PostLoginSetupMigration {
    const val MIGRATION_VERSION = 1

    /** Serializes every production bootstrap in this process; runs never overlap. */
    private val BOOTSTRAP_LOCK = Any()

    data class LegacyRow(
        val version: String?, val username: String?, val uri: String?, val session: String?,
        val pendingCreation: Boolean
    )
    data class Row(val key: String, val legacy: LegacyRow, val state: String?, val creationId: String?)

    /** Injectable raw row store: JVM tests can exercise classification without marker publication. */
    interface RowStore {
        fun rows(): List<Row>
        fun write(row: Row, key: String, value: String?): Boolean
        fun recordRecovery(row: Row): Boolean
    }

    /** Injectable full store: JVM tests can exercise failure/restart ordering without AccountManager. */
    interface Store : RowStore {
        fun marker(): Int
        fun writeMarker(version: Int): Boolean
    }

    /**
     * Injectable startup reconciliation seam. [H] is an opaque located row handle so JVM tests
     * can exercise every fail-closed branch without AccountManager.
     */
    internal interface ReconcileOps<H : Any> {
        fun records(): List<AccountCreationRegistry.Record>?
        fun locate(record: AccountCreationRegistry.Record): H?
        fun creationId(row: H): String?
        fun state(row: H): PostLoginSetupState?
        fun clearOwned(record: AccountCreationRegistry.Record): Boolean
        fun quarantine(record: AccountCreationRegistry.Record): Boolean
        fun activate(record: AccountCreationRegistry.Record): Boolean
        fun writeRecoveryState(row: H): Boolean
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
    internal fun classifyRows(store: RowStore, sessionParses: (String, String?) -> Boolean = ::locallyParseSession): Boolean =
        classifyRowsOutcome(store, sessionParses = sessionParses) == Reason.NONE

    /**
     * Same classification as [classifyRows]; names the first boundary that could not be made durable.
     * [onRowClassified] and [onSessionParse] only count work for the startup diagnostic report.
     */
    internal fun classifyRowsOutcome(
        store: RowStore,
        onRowClassified: () -> Unit = {},
        onSessionParse: () -> Unit = {},
        sessionParses: (String, String?) -> Boolean = ::locallyParseSession,
    ): Reason {
        val countedSessionParses: (String, String?) -> Boolean = { session, uri ->
            onSessionParse()
            sessionParses(session, uri)
        }
        for (row in store.rows()) {
            var working = row
            // addAccountExplicitly may have returned true just before a process death. Without
            // the exact creation ID this row is not owned, so only the registry is allowed to
            // record recovery; AccountManager user data must remain untouched for Settings.
            if (row.legacy.pendingCreation && row.creationId.isNullOrBlank()) {
                if (!store.recordRecovery(row)) return Reason.CLASSIFY_PENDING_ROW_RECOVERY_FAILED
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
            onRowClassified()
            var state = classify(row.legacy, countedSessionParses)
            // Supported historic versions are explicitly upgraded and read back before restore.
            if (state == PostLoginSetupState.COMPLETE && row.legacy.version != AccountSettings.CURRENT_VERSION.toString() &&
                !store.write(row, AccountSettings.KEY_SETTINGS_VERSION, AccountSettings.CURRENT_VERSION.toString())) {
                state = PostLoginSetupState.RECOVERY_REQUIRED
            }
            // Account.restore is local-only and is intentionally checked after raw migration writes.
            if (state == PostLoginSetupState.COMPLETE && !countedSessionParses(requireNotNull(row.legacy.session), row.legacy.uri))
                state = PostLoginSetupState.RECOVERY_REQUIRED
            if (working.creationId.isNullOrBlank()) {
                val generated = UUID.randomUUID().toString()
                if (!store.write(working, AccountSettings.KEY_CREATION_ID, generated)) return Reason.CLASSIFY_CREATION_ID_WRITE_FAILED
                working = working.copy(creationId = generated)
            }
            if (!store.write(working, AccountSettings.KEY_POST_LOGIN_SETUP_STATE, state.name) && !store.recordRecovery(working))
                return Reason.CLASSIFY_STATE_RECOVERY_FAILED
        }
        return Reason.NONE
    }

    /** Runs row classification and then publishes its durable full-bootstrap marker. */
    fun bootstrap(store: Store, sessionParses: (String, String?) -> Boolean = ::locallyParseSession): Boolean {
        if (store.marker() == MIGRATION_VERSION) return true
        if (!classifyRows(store, sessionParses)) return false
        return store.writeMarker(MIGRATION_VERSION) && store.marker() == MIGRATION_VERSION
    }

    /** Boolean compatibility view of [bootstrapOutcome]. */
    fun bootstrap(context: Context): Boolean = bootstrapOutcome(context).succeeded

    /**
     * Production bootstrap. Always reconciles and re-commits the marker (no marker short-circuit),
     * and never throws: an unexpected exception becomes a typed outcome without its message.
     * The optional callbacks only count classification work; they never change the outcome.
     */
    fun bootstrapOutcome(
        context: Context,
        onRowClassified: () -> Unit = {},
        onSessionParse: () -> Unit = {},
    ): PostLoginStartupOutcome = synchronized(BOOTSTRAP_LOCK) {
        try {
            runBootstrap(context, onRowClassified, onSessionParse)
        } catch (error: Exception) {
            PostLoginStartupOutcome.exception(Phase.REGISTRY_READ, error)
        }
    }

    private fun runBootstrap(context: Context, onRowClassified: () -> Unit,
                             onSessionParse: () -> Unit): PostLoginStartupOutcome {
        val manager = AccountManager.get(context)
        val registry = AccountCreationRegistry.open(context)
        // Unknown ownership data is a fail-closed bootstrap error; do not reinterpret its rows
        // as legacy and mutate them. The same single read also names the rejecting decode step.
        val initial = registry.readResult()
        if (initial.records == null)
            return PostLoginStartupOutcome(Phase.REGISTRY_READ, Reason.REGISTRY_UNREADABLE, registryDecode = initial.status)
        val prefs = context.getSharedPreferences("post_login_setup_migration", Context.MODE_PRIVATE)
        val rows = object : RowStore {
            private val accounts get() = manager.getAccountsByType(App.accountType)
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
        }
        return PostLoginBootstrapCoordinator.evaluate(
            classifyRows = { classifyRowsOutcome(rows, onRowClassified, onSessionParse) },
            reconcilePending = { reconcilePendingCreationRows(context, manager, registry) },
            commitMarker = { commitMarker(prefs) }
        )
    }

    private fun commitMarker(prefs: SharedPreferences): Reason = when {
        !prefs.edit().putInt("version", MIGRATION_VERSION).commit() -> Reason.MARKER_COMMIT_FAILED
        prefs.getInt("version", 0) != MIGRATION_VERSION -> Reason.MARKER_READBACK_FAILED
        else -> Reason.NONE
    }

    /**
     * Startup repair is deliberately ownership-first. No-ID and mismatched rows are visible to
     * Android Settings but are never modified or removed by the app; only an exact owned row is
     * eligible for post-boundary activation/registry cleanup.
     */
    private fun reconcilePendingCreationRows(context: Context, manager: AccountManager,
                                              registry: AccountCreationRegistry): Reason =
        reconcileRecords(object : ReconcileOps<Account> {
            override fun records() = registry.records()
            override fun locate(record: AccountCreationRegistry.Record) =
                manager.getAccountsByType(record.accountType).firstOrNull { it.name == record.accountName }
            override fun creationId(row: Account): String? = manager.getUserData(row, AccountSettings.KEY_CREATION_ID)
            override fun state(row: Account) = AccountSettings.setupState(manager, row, true)
            override fun clearOwned(record: AccountCreationRegistry.Record) =
                registry.clearOwned(record.accountType, record.accountName, record.creationId)
            override fun quarantine(record: AccountCreationRegistry.Record) =
                registry.updateOwned(record.copy(phase = AccountCreationRegistry.Phase.RECOVERY_REQUIRED))
            override fun activate(record: AccountCreationRegistry.Record) = ActiveAccountManager.setActiveAccount(
                context,
                ExactAccountIdentity(record.accountType, record.accountName, record.creationId)
            )
            override fun writeRecoveryState(row: Account) =
                AccountSettings.writeSetupState(manager, row, PostLoginSetupState.RECOVERY_REQUIRED)
        })

    internal fun <H : Any> reconcileRecords(ops: ReconcileOps<H>): Reason {
        val records = ops.records() ?: return Reason.RECONCILE_REGISTRY_UNREADABLE
        for (record in records) {
            val row = ops.locate(record)
            if (row == null) {
                if (!ops.clearOwned(record)) return Reason.RECONCILE_CLEAR_MISSING_ROW_FAILED
                continue
            }
            if (ops.creationId(row) != record.creationId) {
                // Compare-owned registry quarantine; do not mutate the ambiguous row.
                if (!ops.quarantine(record)) return Reason.RECONCILE_QUARANTINE_MISMATCH_FAILED
                continue
            }
            val state = ops.state(row)
            if (state in setOf(PostLoginSetupState.ACCOUNT_CREATED, PostLoginSetupState.COLLECTIONS,
                    PostLoginSetupState.PERMISSIONS, PostLoginSetupState.INITIAL_SYNC,
                    PostLoginSetupState.READY, PostLoginSetupState.COMPLETE)) {
                if (!ops.activate(record)) return Reason.RECONCILE_ACTIVATE_FAILED
                if (!ops.clearOwned(record)) return Reason.RECONCILE_CLEAR_OWNED_FAILED
            } else {
                // API 21 removal is asynchronous. Keep exact-owned partial rows quarantined
                // for explicit Settings/user recovery instead of pretending removal completed.
                // A verified AccountManager state is preferred, but a durable exact registry
                // record is sufficient to finish bootstrap when user-data persistence fails.
                if (!persistPendingRecovery(
                        writeState = { ops.writeRecoveryState(row) },
                        updateRegistry = { ops.quarantine(record) }
                    )) return Reason.RECONCILE_RECOVERY_RECORD_FAILED
            }
        }
        return Reason.NONE
    }

    /** Account.restore parses the established signed session locally; it never makes a request. */
    private fun locallyParseSession(session: String, uri: String?): Boolean = runCatching {
        EtebaseAccount.restore(Client.create(HttpClient.sharedClient, uri ?: Constants.etebaseServiceUrl), session, null)
        true
    }.getOrDefault(false)
}
