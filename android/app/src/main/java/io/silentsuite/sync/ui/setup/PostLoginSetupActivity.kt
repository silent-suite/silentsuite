package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.activity.viewModels
import androidx.core.app.ActivityCompat
import androidx.lifecycle.observe
import at.bitfire.ical4android.TaskProvider.ProviderName
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.resource.LocalTaskList
import io.silentsuite.sync.ui.AccountActivity
import io.silentsuite.sync.ui.ActiveAccountManager
import io.silentsuite.sync.ui.BaseActivity

/** Resumes a durable setup row. It deliberately accepts no credentials or session extra. */
class PostLoginSetupActivity : BaseActivity() {
    private val model: PostLoginSetupViewModel by viewModels()
    private lateinit var account: Account
    private lateinit var accountManager: AccountManager
    private lateinit var accountCreationId: String
    private var ambiguousOwnership = false
    private var missingCreationId = false
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        accountManager = AccountManager.get(this)
        val supplied = intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)
        val expectedCreationId = intent.getStringExtra(EXTRA_CREATION_ID)
        if (supplied == null || supplied.type != App.accountType) { finish(); return }
        if (expectedCreationId.isNullOrBlank()) {
            // A caller without exact generation evidence is resolution-only even when a
            // same-name row has a generation; it must never adopt or mutate that row.
            if (supplied in accountManager.getAccountsByType(App.accountType)) {
                account=supplied; missingCreationId=true; ambiguousOwnership=true; setContentView(R.layout.activity_post_login_setup)
                findViewById<Button>(R.id.setup_resolve_ambiguity).setOnClickListener { startActivity(Intent(android.provider.Settings.ACTION_SYNC_SETTINGS)) }
                render(); return
            }
            finish(); return
        }
        val record = AccountCreationRegistry.open(applicationContext).get(supplied.type, supplied.name)
        val registryOwns = AccountCreationRegistry.owns(record, expectedCreationId)
        ambiguousOwnership = record != null && !registryOwns
        val exact = ExactAccountRouting.validate(supplied, expectedCreationId, App.accountType, accountManager)
        val cleanupOnly = exact == null && supplied !in accountManager.getAccountsByType(App.accountType) && registryOwns
        account = exact ?: supplied.takeIf { cleanupOnly } ?: run { finish(); return }
        accountCreationId = expectedCreationId
        // Recovery removal is an app-owned mutation only with a matching durable registry owner.
        if (!cleanupOnly && state() == PostLoginSetupState.RECOVERY_REQUIRED && !registryOwns)
            ambiguousOwnership = true
        if (!cleanupOnly && state() == PostLoginSetupState.CREATING && registryOwns &&
            !AccountSettings.writeSetupState(accountManager, account, PostLoginSetupState.RECOVERY_REQUIRED))
            ambiguousOwnership = true
        if (ambiguousOwnership) {
            setContentView(R.layout.activity_post_login_setup)
            findViewById<Button>(R.id.setup_resolve_ambiguity).setOnClickListener { startActivity(Intent(android.provider.Settings.ACTION_SYNC_SETTINGS)) }
            render(); return
        }
        if (!cleanupOnly && AccountSettings.setupState(accountManager, account, PostLoginSetupMigration.isBootstrapped(this)) == PostLoginSetupState.CREATING && !registryOwns) {
            startActivity(Intent(this, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            finish(); return
        }
        if (cleanupOnly || (!cleanupOnly && state() == PostLoginSetupState.RECOVERY_REQUIRED))
            model.initializeRecovery(account, expectedCreationId)
        else model.initialize(account)
        setContentView(R.layout.activity_post_login_setup)
        findViewById<Button>(R.id.setup_done).setOnClickListener { done() }
        findViewById<Button>(R.id.setup_continue_limited).setOnClickListener { advance() }
        findViewById<Button>(R.id.setup_skip_integrations).setOnClickListener { continueWithoutIntegrations() }
        findViewById<Button>(R.id.setup_remove_incomplete).setOnClickListener { removeIncomplete() }
        findViewById<Button>(R.id.setup_retry_inventory).setOnClickListener { if (SetupContinuationPolicy.permits(state(), model.inventoryOutcome, SetupContinuationPolicy.Action.RetryInventory)) model.inventoryAndCreate(applicationContext, account) }
        model.collections.observe(this) { result ->
            when (result) {
                is PostLoginSetupViewModel.CollectionsResult.Ready -> {
                    // LiveData re-delivers after recreation; never regress a later durable step.
                    if (!result.limited && state() == PostLoginSetupState.COLLECTIONS)
                        AccountSettings.writeSetupState(accountManager, account, PostLoginSetupState.PERMISSIONS)
                    render()
                }
                PostLoginSetupViewModel.CollectionsResult.RecoveryRequired -> render()
                PostLoginSetupViewModel.CollectionsResult.Working -> render()
            }
        }
        model.recoveryRemoval.observe(this) {
            render()
            if (it == RecoveryRemovalCoordinator.State.Removed && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED) && model.consumeRecoveryRemovalRoute())
                startActivity(Intent(this, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)).also { finish() }
        }
        render()
    }
    override fun onResume() {
        super.onResume()
        if (ambiguousOwnership) { render(); return }
        // ViewModel facts are intentionally non-durable; rebuild them from the exact account's
        // remote inventory before making a contextual permission decision after restart.
        if ((state() == PostLoginSetupState.PERMISSIONS || state() == PostLoginSetupState.READY) && !model.inventoryLoaded)
            model.inventoryAndCreate(applicationContext, account)
        render()
    }
    private fun state() = AccountSettings.setupState(accountManager, account,
        PostLoginSetupMigration.isBootstrapped(this)) ?: PostLoginSetupState.RECOVERY_REQUIRED
    private fun advance() {
        if (ambiguousOwnership) return
        when (state()) {
            PostLoginSetupState.CREATING -> render()
            PostLoginSetupState.ACCOUNT_CREATED -> write(PostLoginSetupState.COLLECTIONS)
            PostLoginSetupState.COLLECTIONS -> if (model.limitedContinuation) write(PostLoginSetupState.PERMISSIONS)
                else model.inventoryAndCreate(applicationContext, account)
            PostLoginSetupState.PERMISSIONS -> {
                if (!SetupContinuationPolicy.permits(state(), model.inventoryOutcome, SetupContinuationPolicy.Action.Continue)) return
                if (!model.inventoryLoaded) {
                    model.inventoryAndCreate(applicationContext, account)
                    return
                }
                if (requestContextualPermissions()) return
                // Permission denial is an explicit supported limited-integration path. The state
                // has no permission truth and is recomputed on every resume.
                if (write(PostLoginSetupState.INITIAL_SYNC)) {
                    requestSync(applicationContext, account)
                    write(PostLoginSetupState.READY)
                }
            }
            PostLoginSetupState.INITIAL_SYNC -> {
                requestSync(applicationContext, account)
                write(PostLoginSetupState.READY)
            }
            PostLoginSetupState.READY, PostLoginSetupState.COMPLETE, PostLoginSetupState.RECOVERY_REQUIRED -> render()
        }
    }

    private fun write(next: PostLoginSetupState): Boolean =
        AccountSettings.writeSetupState(accountManager, account, next).also { render() }

    /** @return true while a platform request owns the interaction; no state is claimed yet. */
    private fun requestContextualPermissions(): Boolean {
        AccountSettings.writeVerified(accountManager, account, AccountSettings.KEY_LIMITED_INTEGRATIONS, null)
        val taskPermissions = listOf(ProviderName.OpenTasks, ProviderName.TasksOrg)
            .filter { LocalTaskList.tasksProviderAvailable(this, it) }
            .flatMap { it.permissions.toList() }
        val wanted = ContextualPermissionPlan.requested(
            ContextualPermissionPlan.Inputs(model.integrationCollectionTypes, taskPermissions))
            .filter { ActivityCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (wanted.isEmpty()) return false
        ActivityCompat.requestPermissions(this, wanted.toTypedArray(), REQUEST_CONTEXTUAL_PERMISSIONS)
        return true
    }
    private fun continueWithoutIntegrations() {
        if (ambiguousOwnership) return
        if (state() == PostLoginSetupState.RECOVERY_REQUIRED) {
            return
        }
        if (!SetupContinuationPolicy.permits(state(), model.inventoryOutcome, SetupContinuationPolicy.Action.SkipIntegrations)) return
        if (!AccountSettings.writeVerified(accountManager, account, AccountSettings.KEY_LIMITED_INTEGRATIONS, "true")) return
        if (write(PostLoginSetupState.INITIAL_SYNC)) {
            requestSync(applicationContext, account)
            write(PostLoginSetupState.READY)
        }
    }
    private fun removeIncomplete() { if (!ambiguousOwnership) model.beginRecoveryRemoval() }
    private fun done() {
        if (state() != PostLoginSetupState.READY) return
        if (ExactAccountRouting.validate(account, accountCreationId, App.accountType, accountManager) == null) return
        if (!AccountSettings.writeSetupState(accountManager, account, PostLoginSetupState.COMPLETE)) return
        if (ExactAccountRouting.validate(account, accountCreationId, App.accountType, accountManager) == null) return
        val creationId = accountCreationId
        startActivity(AccountActivity.newIntent(this, account, creationId)); finish()
    }
    private fun render() {
        val current = state()
        if (ambiguousOwnership) {
            findViewById<TextView>(R.id.setup_status).text = getString(R.string.post_login_setup_recovery)
            listOf(R.id.setup_done,R.id.setup_skip_integrations,R.id.setup_remove_incomplete,R.id.setup_continue_limited,R.id.setup_retry_inventory).forEach { findViewById<Button>(it).visibility=View.GONE }
            findViewById<Button>(R.id.setup_resolve_ambiguity).visibility=View.VISIBLE
            return
        }
        findViewById<TextView>(R.id.setup_status).text = when (current) {
            PostLoginSetupState.PERMISSIONS -> getString(R.string.post_login_setup_permissions)
            PostLoginSetupState.READY -> readySummary()
            PostLoginSetupState.RECOVERY_REQUIRED -> getString(R.string.post_login_setup_recovery)
            else -> getString(R.string.post_login_setup_status, current.name)
        }
        findViewById<Button>(R.id.setup_done).visibility = if (current == PostLoginSetupState.READY) View.VISIBLE else View.GONE
        val permits = SetupContinuationPolicy.permits(current, model.inventoryOutcome, SetupContinuationPolicy.Action.SkipIntegrations)
        findViewById<Button>(R.id.setup_skip_integrations).visibility = if (permits) View.VISIBLE else View.GONE
        findViewById<Button>(R.id.setup_remove_incomplete).visibility = if (current == PostLoginSetupState.RECOVERY_REQUIRED && model.recoveryRemoval.value != null) View.VISIBLE else View.GONE
        findViewById<Button>(R.id.setup_retry_inventory).visibility = if (SetupContinuationPolicy.permits(current, model.inventoryOutcome, SetupContinuationPolicy.Action.RetryInventory)) View.VISIBLE else View.GONE
        findViewById<Button>(R.id.setup_resolve_ambiguity).visibility = View.GONE
        val removalState = model.recoveryRemoval.value
        findViewById<Button>(R.id.setup_remove_incomplete).isEnabled = removalState != RecoveryRemovalCoordinator.State.Pending
        if (current == PostLoginSetupState.RECOVERY_REQUIRED && removalState == RecoveryRemovalCoordinator.State.Pending)
            findViewById<TextView>(R.id.setup_status).text = getString(R.string.post_login_setup_removal_pending)
        if (current == PostLoginSetupState.RECOVERY_REQUIRED && removalState == RecoveryRemovalCoordinator.State.Failed)
            findViewById<TextView>(R.id.setup_status).text = getString(R.string.post_login_setup_removal_failed)
        findViewById<Button>(R.id.setup_continue_limited).visibility = if (current == PostLoginSetupState.PERMISSIONS && permits) View.VISIBLE else if (current == PostLoginSetupState.READY || current == PostLoginSetupState.COMPLETE || current == PostLoginSetupState.RECOVERY_REQUIRED || current == PostLoginSetupState.CREATING) View.GONE else View.VISIBLE
    }
    private fun readySummary(): String {
        val limits = mutableListOf(getString(R.string.post_login_setup_ready_requested))
        if (!android.content.ContentResolver.getMasterSyncAutomatically()) limits += getString(R.string.post_login_setup_limit_master_sync)
        val qualifying = model.integrationCollectionTypes
        val calendarDenied = ActivityCompat.checkSelfPermission(this, android.Manifest.permission.READ_CALENDAR) != PackageManager.PERMISSION_GRANTED
        val contactsDenied = ActivityCompat.checkSelfPermission(this, android.Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED
        if (io.silentsuite.sync.Constants.ETEBASE_TYPE_CALENDAR in qualifying && calendarDenied) limits += getString(R.string.post_login_setup_limit_calendar)
        if (io.silentsuite.sync.Constants.ETEBASE_TYPE_ADDRESS_BOOK in qualifying && contactsDenied) limits += getString(R.string.post_login_setup_limit_contacts)
        if (io.silentsuite.sync.Constants.ETEBASE_TYPE_TASKS in qualifying && listOf(ProviderName.OpenTasks, ProviderName.TasksOrg).none { LocalTaskList.tasksProviderAvailable(this, it) })
            limits += getString(R.string.post_login_setup_limit_tasks)
        if (!ConnectivityPolicy.isConnected(this)) limits += getString(R.string.post_login_setup_limit_offline)
        return limits.joinToString(" ")
    }
    companion object {
        private const val EXTRA_ACCOUNT = "post_login_setup_account"
        private const val EXTRA_CREATION_ID = "post_login_setup_creation_id"
        private const val REQUEST_CONTEXTUAL_PERMISSIONS = 7007
        fun newIntent(context: Context, account: Account, creationId: String?) = Intent(context, PostLoginSetupActivity::class.java)
            .putExtra(EXTRA_ACCOUNT, account)
            .putExtra(EXTRA_CREATION_ID, creationId)
    }
}
