package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.app.ActivityCompat
import androidx.lifecycle.observe
import at.bitfire.ical4android.TaskProvider.ProviderName
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.resource.LocalTaskList
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.ui.AccountActivity
import io.silentsuite.sync.ui.BaseActivity
import java.util.UUID

/** Resumes a durable setup row. It deliberately accepts no credentials or session extra. */
class PostLoginSetupActivity : BaseActivity() {
    private val model: PostLoginSetupViewModel by viewModels()
    private lateinit var account: Account
    private lateinit var accountManager: AccountManager
    private var accountCreationId: String? = null
    private var missingCreationId = false

    /**
     * ActivityResultRegistry retains the platform-result association across recreation. Denial
     * evidence is admitted to the retained model only from this callback and only for the exact
     * account generation that launched the request.
     */
    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        if (!::account.isInitialized || !::accountManager.isInitialized) return@registerForActivityResult
        if (exactAccount() == null) return@registerForActivityResult
        val returned = PostLoginSetupOrchestrator.Integration.values().mapNotNull { integration ->
            val permissions = allPermissionsFor(integration)
            val explicitResults = results.filterKeys(permissions::contains)
            val expectedPermissions = permissionsFor(integration)
            val evidence = when {
                explicitResults.isEmpty() -> null
                explicitResults.values.any { granted -> !granted } && permissions.any {
                    ActivityCompat.shouldShowRequestPermissionRationale(this, it)
                } -> PostLoginSetupOrchestrator.PermissionEvidence.DENIED_CAN_ASK_RETURNED
                explicitResults.values.any { granted -> !granted } ->
                    PostLoginSetupOrchestrator.PermissionEvidence.DENIED_BLOCKED_RETURNED
                (expectedPermissions.isEmpty() || expectedPermissions.all(results::containsKey)) &&
                    explicitResults.values.all { granted -> granted } ->
                    PostLoginSetupOrchestrator.PermissionEvidence.GRANTED
                else -> null
            }
            evidence?.let { integration to it }
        }.toMap()
        if (returned.isEmpty()) return@registerForActivityResult
        model.recordReturnedPermissionEvidence(returned)
        if (!persistReturnedPermissionDenials(returned)) {
            render()
            return@registerForActivityResult
        }
        model.submitUserDecision(PostLoginSetupOrchestrator.UserDecision.CONTINUE)
        resumeSetupWork()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        accountManager = AccountManager.get(this)
        val supplied = intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)
        if (supplied == null || supplied.type != App.accountType) {
            finish()
            return
        }
        account = supplied
        accountCreationId = intent.getStringExtra(EXTRA_CREATION_ID)?.takeIf { it.isNotBlank() }
        missingCreationId = accountCreationId == null

        if (missingCreationId && account !in accountManager.getAccountsByType(App.accountType)) {
            finish()
            return
        }

        val creationId = accountCreationId
        if (creationId != null) {
            val record = registry().get(account.type, account.name)
            val ownsRecovery = AccountCreationRegistry.owns(record, creationId)
            val rowExists = account in accountManager.getAccountsByType(App.accountType)
            val durableState = state()
            when {
                !rowExists && ownsRecovery ->
                    model.initializeRecovery(account, creationId)
                rowExists &&
                    (durableState == PostLoginSetupState.CREATING ||
                        durableState == PostLoginSetupState.RECOVERY_REQUIRED) &&
                    ownsRecovery ->
                    model.initializeRecovery(account, creationId)
                exactAccount() != null && (record == null || ownsRecovery) ->
                    model.initialize(account)
            }
        }

        setContentView(R.layout.activity_post_login_setup)
        findViewById<Button>(R.id.setup_done).setOnClickListener {
            submit(PostLoginSetupOrchestrator.UserDecision.DONE)
        }
        findViewById<Button>(R.id.setup_continue_limited).setOnClickListener {
            if (
                state() == PostLoginSetupState.ACCOUNT_CREATED &&
                model.syncConfigurationOutcome() ==
                PostLoginSetupOrchestrator.SyncConfigurationOutcome.FAILED
            ) {
                model.retrySyncConfiguration()
                model.clearUserDecision()
                resumeSetupWork()
                return@setOnClickListener
            }
            model.prepareReturnedPermissionRetry(
                permissionEvidence().filterValues {
                    it == PostLoginSetupOrchestrator.PermissionEvidence.DENIED_CAN_ASK_RETURNED
                }.keys
            )
            submit(PostLoginSetupOrchestrator.UserDecision.CONTINUE)
        }
        findViewById<Button>(R.id.setup_skip_integrations).setOnClickListener {
            submit(PostLoginSetupOrchestrator.UserDecision.SKIP_INTEGRATIONS)
        }
        findViewById<Button>(R.id.setup_remove_incomplete).setOnClickListener {
            submit(PostLoginSetupOrchestrator.UserDecision.REMOVE_INCOMPLETE)
        }
        findViewById<Button>(R.id.setup_retry_inventory).setOnClickListener {
            if (
                SetupContinuationPolicy.permits(
                    state(),
                    model.inventoryOutcome,
                    SetupContinuationPolicy.Action.RetryInventory,
                )
            ) {
                model.prepareInventoryRetry()
                submit(PostLoginSetupOrchestrator.UserDecision.RETRY_INVENTORY)
            }
        }
        findViewById<Button>(R.id.setup_resolve_ambiguity).setOnClickListener {
            openAndroidSettings()
        }
        model.collections.observe(this) {
            render()
            resumeSetupWork()
        }
        model.recoveryRemoval.observe(this) { removal ->
            render()
            if (
                removal == RecoveryRemovalCoordinator.State.Removed &&
                lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED) &&
                model.consumeRecoveryRemovalRoute()
            ) {
                returnToLogin()
            }
        }
        render()
    }

    override fun onResume() {
        super.onResume()
        render()
        resumeSetupWork()
    }

    private fun submit(decision: PostLoginSetupOrchestrator.UserDecision) {
        model.submitUserDecision(decision)
        resumeSetupWork()
    }

    /** The ViewModel is the single retained serializer; this Activity only supplies one drain. */
    private fun resumeSetupWork() {
        if (safeWorkPausedForTest || missingCreationId || !::account.isInitialized) return
        model.resumeSafeWork {
            var keepDraining = true
            var decisions = 0
            while (keepDraining && decisions++ < MAX_SAFE_DECISIONS_PER_DRAIN) {
                val input = orchestrationInput()
                val decision = PostLoginSetupOrchestrator.decide(input)
                keepDraining = execute(input, decision)
            }
            render()
        }
    }

    private fun orchestrationInput(): PostLoginSetupOrchestrator.Input {
        val ownership = ownership()
        return PostLoginSetupOrchestrator.Input(
            state = state(),
            ownership = ownership,
            syncConfiguration = model.syncConfigurationOutcome(),
            inventory = model.inventoryOutcome,
            userDecision = model.pendingUserDecision(),
            permissions = if (ownership == PostLoginSetupOrchestrator.Ownership.EXACT) {
                permissionEvidence()
            } else {
                emptyMap()
            },
            initialSyncRequestId =
                if (ownership == PostLoginSetupOrchestrator.Ownership.EXACT) {
                    AccountSettings.initialSyncRequestId(accountManager, account)
                } else {
                    null
                },
        )
    }

    private fun execute(
        input: PostLoginSetupOrchestrator.Input,
        decision: PostLoginSetupOrchestrator.Decision,
    ): Boolean {
        /*
         * Keep state-specific effects together: the pure decision selects the effect, while each
         * branch validates the exact generation immediately before performing it.
         */
        when (input.state) {
            PostLoginSetupState.ACCOUNT_CREATED -> when (decision) {
                PostLoginSetupOrchestrator.Decision.ConfigureAndroidSync -> {
                    if (exactAccount() == null) return true
                    val configured =
                        PostLoginSyncConfigurator.configure(applicationContext, account)
                    if (exactAccount() == null) return true
                    model.recordSyncConfiguration(configured)
                    return true
                }
                is PostLoginSetupOrchestrator.Decision.PersistState ->
                    if (decision.state == PostLoginSetupState.COLLECTIONS) {
                        return write(PostLoginSetupState.COLLECTIONS)
                    }
                else -> Unit
            }
            PostLoginSetupState.COLLECTIONS -> when (decision) {
                PostLoginSetupOrchestrator.Decision.LoadInventory -> {
                    if (exactAccount() == null) return true
                    model.inventoryAndCreate(applicationContext, account, accountCreationId)
                    return false
                }
                is PostLoginSetupOrchestrator.Decision.PersistState ->
                    if (decision.state == PostLoginSetupState.PERMISSIONS) {
                        return write(PostLoginSetupState.PERMISSIONS)
                    }
                else -> Unit
            }
            else -> Unit
        }

        return when (decision) {
            PostLoginSetupOrchestrator.Decision.RequireRecovery -> {
                val creationId = accountCreationId ?: return false
                if (
                    exactAccount() == null ||
                    !AccountCreationRegistry.owns(
                        registry().get(account.type, account.name),
                        creationId,
                    )
                ) {
                    true
                } else {
                    write(PostLoginSetupState.RECOVERY_REQUIRED)
                }
            }
            PostLoginSetupOrchestrator.Decision.ConfigureAndroidSync -> false
            is PostLoginSetupOrchestrator.Decision.PersistState -> write(decision.state)
            PostLoginSetupOrchestrator.Decision.LoadInventory -> {
                if (exactAccount() == null) return true
                model.inventoryAndCreate(applicationContext, account, accountCreationId)
                false
            }
            PostLoginSetupOrchestrator.Decision.WaitForInventory,
            PostLoginSetupOrchestrator.Decision.ShowInventoryRecovery,
            PostLoginSetupOrchestrator.Decision.AwaitIntegrationDecision,
            PostLoginSetupOrchestrator.Decision.ShowSyncConfigurationFailure,
            is PostLoginSetupOrchestrator.Decision.ShowReturnedDenials,
            PostLoginSetupOrchestrator.Decision.AwaitDone,
            PostLoginSetupOrchestrator.Decision.ShowRecovery,
            PostLoginSetupOrchestrator.Decision.ResolveInAndroidSettings -> false
            PostLoginSetupOrchestrator.Decision.IgnoreUserDecision -> {
                model.clearUserDecision()
                true
            }
            is PostLoginSetupOrchestrator.Decision.RequestPermissions -> {
                requestPermissions(decision.integrations)
                false
            }
            is PostLoginSetupOrchestrator.Decision.BeginInitialSync ->
                beginInitialSync(decision.limited)
            PostLoginSetupOrchestrator.Decision.PrepareInitialSyncRequestId ->
                prepareInitialSyncRequestId()
            is PostLoginSetupOrchestrator.Decision.DispatchInitialSync ->
                dispatchInitialSync(decision.requestId)
            is PostLoginSetupOrchestrator.Decision.ClearInitialSyncRequestId -> {
                if (exactAccount() == null) return true
                val durable = state()
                if (
                    durable != PostLoginSetupState.READY &&
                    durable != PostLoginSetupState.COMPLETE
                ) {
                    false
                } else {
                    AccountSettings.clearInitialSyncRequestId(
                        accountManager,
                        account,
                        decision.requestId,
                    ) && exactAccount() != null
                }
            }
            PostLoginSetupOrchestrator.Decision.OpenDashboard -> {
                val exact = exactAccount() ?: return true
                val creationId = accountCreationId ?: return false
                startActivity(AccountActivity.newIntent(this, exact, creationId))
                if (exactAccount() == null) return false
                finish()
                false
            }
            PostLoginSetupOrchestrator.Decision.ClearOwnedRecordAndReturnToLogin -> {
                model.clearUserDecision()
                model.beginRecoveryRemoval()
                false
            }
            PostLoginSetupOrchestrator.Decision.ReturnToLogin -> {
                returnToLogin()
                false
            }
            PostLoginSetupOrchestrator.Decision.RemoveIncompleteAccount -> {
                model.clearUserDecision()
                model.beginRecoveryRemoval()
                false
            }
        }
    }

    private fun beginInitialSync(limited: Boolean): Boolean {
        if (exactAccount() == null) return true
        val marker = if (limited) "true" else null
        if (
            !AccountSettings.writeVerified(
                accountManager,
                account,
                AccountSettings.KEY_LIMITED_INTEGRATIONS,
                marker,
            )
        ) {
            return false
        }
        if (exactAccount() == null) return true
        if (!write(PostLoginSetupState.INITIAL_SYNC)) return false
        model.clearUserDecision()
        return true
    }

    private fun prepareInitialSyncRequestId(): Boolean {
        if (exactAccount() == null) return true
        if (AccountSettings.initialSyncRequestId(accountManager, account) != null) return true
        val requestId = UUID.randomUUID().toString()
        if (exactAccount() == null) return true
        return AccountSettings.writeInitialSyncRequestId(
            accountManager,
            account,
            requestId,
        ) && exactAccount() != null &&
            AccountSettings.initialSyncRequestId(accountManager, account) == requestId
    }

    private fun dispatchInitialSync(requestId: String): Boolean {
        if (exactAccount() == null) return true
        if (AccountSettings.initialSyncRequestId(accountManager, account) != requestId) return true
        try {
            requestSync(applicationContext, account, explicitRequestId = requestId)
        } catch (_: Exception) {
            return false
        }
        if (exactAccount() == null) return true
        if (AccountSettings.initialSyncRequestId(accountManager, account) != requestId) return false
        if (!write(PostLoginSetupState.READY)) return false
        if (exactAccount() == null) return true
        return state() == PostLoginSetupState.READY
    }

    private fun requestPermissions(
        integrations: Set<PostLoginSetupOrchestrator.Integration>,
    ) {
        if (model.launchedPermissionIntegrations().isNotEmpty()) return
        val wanted = integrations
            .flatMap(::permissionsFor)
            .distinct()
            .filterNot(::permissionGranted)
        if (wanted.isEmpty()) {
            model.clearUserDecision()
            resumeSetupWork()
            return
        }
        if (exactAccount() == null) return
        model.markPermissionLaunch(integrations)
        try {
            permissionLauncher.launch(wanted.toTypedArray())
        } catch (_: RuntimeException) {
            model.clearPermissionLaunchWithoutResult()
        }
    }

    private fun permissionEvidence(): Map<
        PostLoginSetupOrchestrator.Integration,
        PostLoginSetupOrchestrator.PermissionEvidence
    > {
        model.permissionEvidenceOverrideForTest()?.let { override ->
            return buildMap {
                PostLoginSetupOrchestrator.Integration.values().forEach { integration ->
                    override.getString(integration.name)?.let { encoded ->
                        val evidence = when (encoded) {
                            "UNKNOWN" ->
                                PostLoginSetupOrchestrator.PermissionEvidence
                                    .UNKNOWN_AFTER_LAUNCH_WITHOUT_RESULT
                            else -> runCatching {
                                PostLoginSetupOrchestrator.PermissionEvidence.valueOf(encoded)
                            }.getOrNull()
                        }
                        if (evidence != null) put(integration, evidence)
                    }
                }
                if (override.getBoolean("NO_TASK_PROVIDER", false)) {
                    put(
                        PostLoginSetupOrchestrator.Integration.TASKS,
                        PostLoginSetupOrchestrator.PermissionEvidence.NO_PROVIDER,
                    )
                }
            }
        }

        val returned = model.returnedPermissionEvidence()
        val retrying = model.retryPermissionIntegrations()
        val persistedDenials = AccountSettings.contextualPermissionDenials(
            accountManager,
            account,
        )
        val launched = model.launchedPermissionIntegrations()
        return activeIntegrations().associateWith { integration ->
            val permissions = permissionsFor(integration)
            when {
                integration == PostLoginSetupOrchestrator.Integration.TASKS &&
                    permissions.isEmpty() ->
                    PostLoginSetupOrchestrator.PermissionEvidence.NO_PROVIDER
                permissions.isNotEmpty() && permissions.all(::permissionGranted) ->
                    PostLoginSetupOrchestrator.PermissionEvidence.GRANTED
                integration in retrying ->
                    PostLoginSetupOrchestrator.PermissionEvidence.NEWLY_ELIGIBLE
                returned[integration] != null -> returned.getValue(integration)
                integration.name in persistedDenials && permissions.any {
                    ActivityCompat.shouldShowRequestPermissionRationale(this, it)
                } -> PostLoginSetupOrchestrator.PermissionEvidence.DENIED_CAN_ASK_RETURNED
                integration.name in persistedDenials ->
                    PostLoginSetupOrchestrator.PermissionEvidence.DENIED_BLOCKED_RETURNED
                integration in launched ->
                    PostLoginSetupOrchestrator.PermissionEvidence
                        .UNKNOWN_AFTER_LAUNCH_WITHOUT_RESULT
                else -> PostLoginSetupOrchestrator.PermissionEvidence.NEWLY_ELIGIBLE
            }
        }
    }

    private fun persistReturnedPermissionDenials(
        returned: Map<
            PostLoginSetupOrchestrator.Integration,
            PostLoginSetupOrchestrator.PermissionEvidence
        >,
    ): Boolean {
        if (exactAccount() == null) return false
        val denials = AccountSettings.contextualPermissionDenials(accountManager, account)
            .toMutableSet()
        returned.forEach { (integration, evidence) ->
            if (evidence == PostLoginSetupOrchestrator.PermissionEvidence.GRANTED) {
                denials.remove(integration.name)
            } else {
                denials.add(integration.name)
            }
        }
        if (exactAccount() == null) return false
        if (!AccountSettings.writeContextualPermissionDenials(accountManager, account, denials)) {
            return false
        }
        if (exactAccount() == null) return false
        return AccountSettings.contextualPermissionDenials(accountManager, account) == denials
    }

    private fun activeIntegrations(): Set<PostLoginSetupOrchestrator.Integration> =
        buildSet {
            if (Constants.ETEBASE_TYPE_CALENDAR in model.integrationCollectionTypes) {
                add(PostLoginSetupOrchestrator.Integration.CALENDAR)
            }
            if (Constants.ETEBASE_TYPE_ADDRESS_BOOK in model.integrationCollectionTypes) {
                add(PostLoginSetupOrchestrator.Integration.CONTACTS)
            }
            if (Constants.ETEBASE_TYPE_TASKS in model.integrationCollectionTypes) {
                add(PostLoginSetupOrchestrator.Integration.TASKS)
            }
        }

    private fun permissionsFor(
        integration: PostLoginSetupOrchestrator.Integration,
    ): List<String> = when (integration) {
        PostLoginSetupOrchestrator.Integration.CALENDAR -> ContextualPermissionPlan.CALENDAR
        PostLoginSetupOrchestrator.Integration.CONTACTS -> ContextualPermissionPlan.CONTACTS
        PostLoginSetupOrchestrator.Integration.TASKS ->
            listOf(ProviderName.OpenTasks, ProviderName.TasksOrg)
                .filter { LocalTaskList.tasksProviderAvailable(this, it) }
                .flatMap { it.permissions.toList() }
                .distinct()
    }

    private fun allPermissionsFor(
        integration: PostLoginSetupOrchestrator.Integration,
    ): List<String> = when (integration) {
        PostLoginSetupOrchestrator.Integration.CALENDAR -> ContextualPermissionPlan.CALENDAR
        PostLoginSetupOrchestrator.Integration.CONTACTS -> ContextualPermissionPlan.CONTACTS
        PostLoginSetupOrchestrator.Integration.TASKS ->
            listOf(ProviderName.OpenTasks, ProviderName.TasksOrg)
                .flatMap { it.permissions.toList() }
                .distinct()
    }

    private fun permissionGranted(permission: String): Boolean =
        ActivityCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun ownership(): PostLoginSetupOrchestrator.Ownership {
        val creationId = accountCreationId
            ?: return PostLoginSetupOrchestrator.Ownership.MISSING_GENERATION
        val record = registry().get(account.type, account.name)
        val registryOwns = AccountCreationRegistry.owns(record, creationId)
        val rowExists = account in accountManager.getAccountsByType(App.accountType)
        if (!rowExists) {
            return if (registryOwns) {
                PostLoginSetupOrchestrator.Ownership.OWNED_ROW_MISSING
            } else {
                PostLoginSetupOrchestrator.Ownership.UNOWNED_ROW_MISSING
            }
        }
        if (exactAccount() == null || (record != null && !registryOwns)) {
            return PostLoginSetupOrchestrator.Ownership.GENERATION_MISMATCH
        }
        if (
            (state() == PostLoginSetupState.CREATING ||
                state() == PostLoginSetupState.RECOVERY_REQUIRED) &&
            !registryOwns
        ) {
            return PostLoginSetupOrchestrator.Ownership.GENERATION_MISMATCH
        }
        return PostLoginSetupOrchestrator.Ownership.EXACT
    }

    private fun exactAccount(): Account? =
        ExactAccountRouting.validate(
            account,
            accountCreationId,
            App.accountType,
            accountManager,
        )

    private fun state(): PostLoginSetupState =
        AccountSettings.setupState(
            accountManager,
            account,
            PostLoginSetupMigration.isBootstrapped(this),
        ) ?: PostLoginSetupState.RECOVERY_REQUIRED

    private fun write(next: PostLoginSetupState): Boolean {
        if (exactAccount() == null) return false
        if (!AccountSettings.writeSetupState(accountManager, account, next)) return false
        if (exactAccount() == null) return false
        return state() == next
    }

    private fun render() {
        val current = state()
        val permissions =
            if (::accountManager.isInitialized && ownership() ==
                PostLoginSetupOrchestrator.Ownership.EXACT
            ) {
                permissionEvidence()
            } else {
                emptyMap()
            }
        val condition = presentationCondition(current, permissions)
        val noTaskProvider =
            permissions[PostLoginSetupOrchestrator.Integration.TASKS] ==
                PostLoginSetupOrchestrator.PermissionEvidence.NO_PROVIDER
        val presentation = presentationFor(current, condition, noTaskProvider)

        findViewById<TextView>(R.id.setup_title).setText(titleResource(presentation.title))
        findViewById<TextView>(R.id.setup_body).setText(bodyResource(presentation.body))
        findViewById<TextView>(R.id.setup_stage_connect).isSelected =
            presentation.stage == PostLoginSetupPresentation.Stage.CONNECT
        findViewById<TextView>(R.id.setup_stage_prepare).isSelected =
            presentation.stage == PostLoginSetupPresentation.Stage.PREPARE
        findViewById<TextView>(R.id.setup_stage_ready).isSelected =
            presentation.stage == PostLoginSetupPresentation.Stage.READY

        val exact = ownership() == PostLoginSetupOrchestrator.Ownership.EXACT
        val permitsContinue = exact && SetupContinuationPolicy.permits(
            current,
            model.inventoryOutcome,
            SetupContinuationPolicy.Action.Continue,
        )
        val permitsSkip = exact && SetupContinuationPolicy.permits(
            current,
            model.inventoryOutcome,
            SetupContinuationPolicy.Action.SkipIntegrations,
        )
        findViewById<Button>(R.id.setup_done).visibility =
            visible(exact && current == PostLoginSetupState.READY)
        findViewById<Button>(R.id.setup_skip_integrations).visibility =
            visible(permitsSkip)
        findViewById<Button>(R.id.setup_continue_limited).visibility = visible(
            exact && (
                permitsContinue ||
                    current == PostLoginSetupState.ACCOUNT_CREATED &&
                    model.syncConfigurationOutcome() ==
                    PostLoginSetupOrchestrator.SyncConfigurationOutcome.FAILED
                )
        )
        findViewById<Button>(R.id.setup_retry_inventory).visibility = visible(
            exact && SetupContinuationPolicy.permits(
                current,
                model.inventoryOutcome,
                SetupContinuationPolicy.Action.RetryInventory,
            )
        )
        val removal = model.recoveryRemoval.value
        findViewById<Button>(R.id.setup_remove_incomplete).visibility = visible(
            current == PostLoginSetupState.RECOVERY_REQUIRED &&
                removal != null &&
                ownership() != PostLoginSetupOrchestrator.Ownership.GENERATION_MISMATCH &&
                ownership() != PostLoginSetupOrchestrator.Ownership.MISSING_GENERATION
        )
        findViewById<Button>(R.id.setup_remove_incomplete).isEnabled =
            removal != RecoveryRemovalCoordinator.State.Pending
        findViewById<Button>(R.id.setup_resolve_ambiguity).visibility = visible(
            ownership() == PostLoginSetupOrchestrator.Ownership.GENERATION_MISMATCH ||
                ownership() == PostLoginSetupOrchestrator.Ownership.MISSING_GENERATION ||
                condition == PostLoginSetupPresentationCondition.PERMISSION_BLOCKED
        )

        val status = findViewById<TextView>(R.id.setup_status)
        status.text = when {
            condition == PostLoginSetupPresentationCondition.SYNC_CONFIGURATION_FAILED ->
                getString(R.string.post_login_setup_sync_retry)
            current == PostLoginSetupState.READY -> readySummary()
            noTaskProvider -> getString(R.string.post_login_no_task_provider)
            else -> ""
        }
        status.visibility = visible(status.text.isNotEmpty())
    }

    private fun presentationCondition(
        current: PostLoginSetupState,
        permissions: Map<
            PostLoginSetupOrchestrator.Integration,
            PostLoginSetupOrchestrator.PermissionEvidence
        >,
    ): PostLoginSetupPresentationCondition = when {
        ownership() == PostLoginSetupOrchestrator.Ownership.GENERATION_MISMATCH ||
            ownership() == PostLoginSetupOrchestrator.Ownership.MISSING_GENERATION ->
            PostLoginSetupPresentationCondition.AMBIGUOUS
        current == PostLoginSetupState.ACCOUNT_CREATED &&
            model.syncConfigurationOutcome() ==
            PostLoginSetupOrchestrator.SyncConfigurationOutcome.FAILED ->
            PostLoginSetupPresentationCondition.SYNC_CONFIGURATION_FAILED
        current == PostLoginSetupState.PERMISSIONS &&
            model.inventoryOutcome == PostLoginSetupOrchestrator.InventoryOutcome.LOADING ->
            PostLoginSetupPresentationCondition.INVENTORY_LOADING
        (current == PostLoginSetupState.COLLECTIONS ||
            current == PostLoginSetupState.PERMISSIONS) &&
            model.inventoryOutcome == PostLoginSetupOrchestrator.InventoryOutcome.RECOVERY ->
            PostLoginSetupPresentationCondition.INVENTORY_RECOVERY
        permissions.values.any {
            it == PostLoginSetupOrchestrator.PermissionEvidence.DENIED_BLOCKED_RETURNED
        } -> PostLoginSetupPresentationCondition.PERMISSION_BLOCKED
        permissions.values.any {
            it == PostLoginSetupOrchestrator.PermissionEvidence.DENIED_CAN_ASK_RETURNED
        } -> PostLoginSetupPresentationCondition.PERMISSION_DENIED
        current == PostLoginSetupState.RECOVERY_REQUIRED &&
            model.recoveryRemoval.value == RecoveryRemovalCoordinator.State.Pending ->
            PostLoginSetupPresentationCondition.REMOVAL_PENDING
        current == PostLoginSetupState.RECOVERY_REQUIRED &&
            model.recoveryRemoval.value == RecoveryRemovalCoordinator.State.Failed ->
            PostLoginSetupPresentationCondition.REMOVAL_FAILED
        else -> PostLoginSetupPresentationCondition.DEFAULT
    }

    private fun titleResource(title: PostLoginSetupPresentation.Title): Int = when (title) {
        PostLoginSetupPresentation.Title.CREATING -> R.string.post_login_creating_title
        PostLoginSetupPresentation.Title.ACCOUNT_CREATED ->
            R.string.post_login_account_created_title
        PostLoginSetupPresentation.Title.SYNC_CONFIGURATION_FAILED ->
            R.string.post_login_sync_configuration_failed_title
        PostLoginSetupPresentation.Title.COLLECTIONS -> R.string.post_login_collections_title
        PostLoginSetupPresentation.Title.COLLECTIONS_FAILED ->
            R.string.post_login_collections_failed_title
        PostLoginSetupPresentation.Title.PERMISSIONS_LOADING ->
            R.string.post_login_permissions_loading_title
        PostLoginSetupPresentation.Title.PERMISSIONS -> R.string.post_login_permissions_title
        PostLoginSetupPresentation.Title.INITIAL_SYNC -> R.string.post_login_initial_sync_title
        PostLoginSetupPresentation.Title.READY -> R.string.post_login_ready_title
        PostLoginSetupPresentation.Title.COMPLETE -> R.string.post_login_complete_title
        PostLoginSetupPresentation.Title.PERMISSION_DENIED ->
            R.string.post_login_permission_denied_title
        PostLoginSetupPresentation.Title.PERMISSION_BLOCKED ->
            R.string.post_login_permission_blocked_title
        PostLoginSetupPresentation.Title.REMOVAL_FAILED ->
            R.string.post_login_removal_failed_title
        PostLoginSetupPresentation.Title.AMBIGUOUS -> R.string.post_login_ambiguous_title
    }

    private fun bodyResource(body: PostLoginSetupPresentation.Body): Int = when (body) {
        PostLoginSetupPresentation.Body.CREATING -> R.string.post_login_creating_body
        PostLoginSetupPresentation.Body.ACCOUNT_CREATED ->
            R.string.post_login_account_created_body
        PostLoginSetupPresentation.Body.SYNC_CONFIGURATION_FAILED ->
            R.string.post_login_sync_configuration_failed_body
        PostLoginSetupPresentation.Body.COLLECTIONS -> R.string.post_login_collections_body
        PostLoginSetupPresentation.Body.COLLECTIONS_FAILED ->
            R.string.post_login_collections_failed_body
        PostLoginSetupPresentation.Body.PERMISSIONS_LOADING ->
            R.string.post_login_permissions_loading_body
        PostLoginSetupPresentation.Body.PERMISSIONS -> R.string.post_login_permissions_body
        PostLoginSetupPresentation.Body.PERMISSION_DENIED ->
            R.string.post_login_permission_denied_body
        PostLoginSetupPresentation.Body.PERMISSION_BLOCKED ->
            R.string.post_login_permission_blocked_body
        PostLoginSetupPresentation.Body.NO_TASK_PROVIDER -> R.string.post_login_no_task_provider
        PostLoginSetupPresentation.Body.INITIAL_SYNC -> R.string.post_login_initial_sync_body
        PostLoginSetupPresentation.Body.READY -> R.string.post_login_ready_body
        PostLoginSetupPresentation.Body.COMPLETE -> R.string.post_login_complete_body
        PostLoginSetupPresentation.Body.RECOVERY -> R.string.post_login_recovery_body
        PostLoginSetupPresentation.Body.REMOVAL_PENDING ->
            R.string.post_login_removal_pending_body
        PostLoginSetupPresentation.Body.REMOVAL_FAILED ->
            R.string.post_login_removal_failed_body
        PostLoginSetupPresentation.Body.AMBIGUOUS -> R.string.post_login_ambiguous_body
    }

    private fun readySummary(): String {
        val limits = mutableListOf(getString(R.string.post_login_setup_ready_requested))
        if (!android.content.ContentResolver.getMasterSyncAutomatically()) {
            limits += getString(R.string.post_login_setup_limit_master_sync)
        }
        val qualifying = model.integrationCollectionTypes
        if (
            Constants.ETEBASE_TYPE_CALENDAR in qualifying &&
            !permissionGranted(android.Manifest.permission.READ_CALENDAR)
        ) {
            limits += getString(R.string.post_login_setup_limit_calendar)
        }
        if (
            Constants.ETEBASE_TYPE_ADDRESS_BOOK in qualifying &&
            !permissionGranted(android.Manifest.permission.READ_CONTACTS)
        ) {
            limits += getString(R.string.post_login_setup_limit_contacts)
        }
        if (
            Constants.ETEBASE_TYPE_TASKS in qualifying &&
            listOf(ProviderName.OpenTasks, ProviderName.TasksOrg).none {
                LocalTaskList.tasksProviderAvailable(this, it)
            }
        ) {
            limits += getString(R.string.post_login_setup_limit_tasks)
        }
        if (!ConnectivityPolicy.isConnected(this)) {
            limits += getString(R.string.post_login_setup_limit_offline)
        }
        return limits.joinToString(" ")
    }

    private fun openAndroidSettings() {
        if (ownership() == PostLoginSetupOrchestrator.Ownership.EXACT) {
            if (exactAccount() == null) return
            startActivity(
                Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:$packageName"),
                )
            )
        } else {
            startActivity(Intent(Settings.ACTION_SYNC_SETTINGS))
        }
    }

    private fun returnToLogin() {
        startActivity(
            Intent(this, LoginActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            )
        )
        finish()
    }

    private fun registry(): AccountCreationRegistry =
        AccountCreationRegistry.open(applicationContext)

    private fun visible(visible: Boolean): Int = if (visible) View.VISIBLE else View.GONE

    companion object {
        private const val EXTRA_ACCOUNT = "post_login_setup_account"
        private const val EXTRA_CREATION_ID = "post_login_setup_creation_id"
        private const val MAX_SAFE_DECISIONS_PER_DRAIN = 24
        @JvmField internal var safeWorkPausedForTest = false

        fun newIntent(context: Context, account: Account, creationId: String?) =
            Intent(context, PostLoginSetupActivity::class.java)
                .putExtra(EXTRA_ACCOUNT, account)
                .putExtra(EXTRA_CREATION_ID, creationId)
    }
}
