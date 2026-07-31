/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Activity
import android.app.Dialog
import android.os.Bundle
import androidx.fragment.app.DialogFragment
import io.silentsuite.sync.*
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.utils.ProgressDialogHelper
import io.silentsuite.sync.ui.setup.BaseConfigurationFinder.Configuration
import io.silentsuite.sync.ui.ActiveAccountManager
import io.silentsuite.sync.ui.AccountActivity
import io.silentsuite.sync.ui.ExactAccountIdentity
import java.util.logging.Level

class CreateAccountFragment : DialogFragment() {
    private var failureRecoveryScheduled = false

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        isCancelable = false
        return ProgressDialogHelper.createIndeterminate(
            requireContext(),
            R.string.setting_up_encryption,
            getString(R.string.setting_up_encryption_content)
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val config = SetupSecretHolder.getPendingConfiguration()
        if (config == null) {
            Logger.log.severe("Setup configuration expired before account creation")
            notifyRecoverableFailure(R.string.setup_state_expired)
            dismissAllowingStateLoss()
            return
        }

        val activity = requireActivity()
        val creationId = java.util.UUID.randomUUID().toString()
        val attempt = try {
            afterCreationIdIssuedForTest?.invoke(creationId)
            createAccount(config.userName, config, creationId)
        } catch (e: Exception) {
            // A lifecycle callback must never propagate an account-creation exception. The
            // durable evidence determines whether retry is safe; do not retain its message.
            Logger.log.log(Level.SEVERE, "Account creation failed: ${e.javaClass.name}")
            recoverFromUnexpectedFailure(config.userName, creationId)
        }
        if (attempt is CreationAttempt.SettingsResolution) {
            startActivity(PostLoginSetupActivity.newIntent(requireContext(), attempt.account, null)); notifyAccountCreationFailed(); dismissAllowingStateLoss()
        } else if (attempt is CreationAttempt.Recovery) {
            startActivity(PostLoginSetupActivity.newIntent(requireContext(), attempt.account, attempt.creationId))
            notifyAccountCreationFailed()
            dismissAllowingStateLoss()
        } else if (attempt is CreationAttempt.Created || attempt is CreationAttempt.Completed) {
            val account = when (attempt) { is CreationAttempt.Created -> attempt.account; is CreationAttempt.Completed -> attempt.account; else -> error("unreachable") }
            val expectedId = when (attempt) { is CreationAttempt.Created -> attempt.creationId; is CreationAttempt.Completed -> attempt.creationId; else -> error("unreachable") }
            val accountManager = AccountManager.get(requireContext())
            val verifiedId = accountManager.getUserData(account, AccountSettings.KEY_CREATION_ID)
            if (verifiedId != expectedId) {
                startActivity(PostLoginSetupActivity.newIntent(requireContext(), account, null))
                notifyAccountCreationFailed()
                dismissAllowingStateLoss()
                return
            }
            val kind = if (attempt is CreationAttempt.Completed) AccountCreationCompletionDispatcher.Kind.Dashboard else AccountCreationCompletionDispatcher.Kind.Setup
            val dispatched = AccountCreationCompletionDispatcher(object : AccountCreationCompletionDispatcher.Seams {
                override fun stageExact(name: String, type: String, id: String) =
                    accountManager.getUserData(account, AccountSettings.KEY_CREATION_ID) == id &&
                        ((activity as? LoginActivity)?.onAccountCreated(account, id) ?: true)
                override fun openSetup() { startActivity(PostLoginSetupActivity.newIntent(requireContext(), account, expectedId)) }
                override fun openDashboard() { startActivity(AccountActivity.newIntent(requireContext(), account, expectedId)) }
                override fun finish() { activity.setResult(Activity.RESULT_OK); SetupSecretHolder.clearCredentialsAndConfiguration(); activity.finish() }
            }).dispatch(kind, account.name, account.type, expectedId)
            if (!dispatched) { notifyRecoverableFailure(R.string.setup_account_busy_retry); dismissAllowingStateLoss() }
        } else if (attempt == CreationAttempt.RetryCredentials) {
            // A collision is retryable.  The authenticator flow remains live and therefore
            // must not receive cancellation merely because this add attempt lost a race.
            notifyRecoverableFailure(R.string.setup_account_busy_retry)
            dismissAllowingStateLoss()
        } else {
            // Issue #119: addAccountExplicitly returned false (e.g. partial-state collision
            // with a previously removed account row that AccountManager hasn't fully
            // garbage-collected). Previously this branch silently no-op'd, leaving the user
            // staring at a frozen "setting up encryption" progress dialog. Log the failure
            // and dismiss the dialog so the operator notices and the user can retry.
            Logger.log.log(Level.SEVERE, "addAccountExplicitly returned false")
            notifyRecoverableFailure(R.string.login_account_creation_failed_retry)
            dismissAllowingStateLoss()
        }
    }

    /** Restores the login surface before one bounded, resource-backed failure dialog is shown. */
    private fun notifyRecoverableFailure(messageRes: Int) {
        SetupSecretHolder.clearCredentialsAndConfiguration()
        if (failureRecoveryScheduled) return
        failureRecoveryScheduled = true
        val manager = parentFragmentManager
        // CreateAccountFragment replaced the credentials fragment and put it on the back stack.
        // Defer the synchronous pop until this lifecycle transaction is complete; FragmentManager
        // rejects nested execution from onCreate. The login content is restored before the dialog.
        val host = activity ?: return
        host.window.decorView.post {
            if (host.isFinishing || host.isDestroyed || manager.isStateSaved || manager.isDestroyed) return@post
            try {
                manager.popBackStackImmediate()
                (manager.findFragmentById(android.R.id.content) as? LoginCredentialsFragment)
                    ?.onSubmissionFailed()
                if (manager.findFragmentByTag(RETRY_ERROR_TAG) == null)
                    DetectConfigurationFragment.NothingDetectedFragment.newInstance(messageRes)
                        .show(manager, RETRY_ERROR_TAG)
            } catch (e: Exception) {
                Logger.log.warning("Unable to restore login after account creation failure: ${e.javaClass.name}")
            }
        }
    }

    private fun notifyAccountCreationFailed() {
        SetupSecretHolder.clearCredentialsAndConfiguration()
        // LoginCredentialsFragment is retained in FragmentManager's active fragments while
        // this dialog replaces the content and is on the back stack. Reset it directly rather
        // than serializing state through Android saved state or relying on newer Fragment APIs.
        parentFragmentManager.fragments.filterIsInstance<LoginCredentialsFragment>()
            .forEach { it.onSubmissionFailed() }
        // A failure before the durable ACCOUNT_CREATED boundary cannot be reported as an
        // Android Settings success. finish() is idempotent in the response controller.
        (activity as? LoginActivity)?.cancelBeforeAccountCreated()
    }

    @Throws(InvalidAccountException::class)
    protected fun createAccount(accountName: String, config: Configuration, creationId: String): CreationAttempt {
        synchronized(CREATION_LOCK) {
            if (!App.postLoginBootstrapSucceeded || !PostLoginSetupMigration.isBootstrapped(requireContext())) return CreationAttempt.Failed
            val account = Account(accountName, App.accountType)
            val accountManager = AccountManager.get(context)
            val registry = AccountCreationRegistry.open(requireContext())
            val fields = listOf(
                AccountSettings.KEY_URI to config.url?.toString(),
                AccountSettings.KEY_USERNAME to config.userName,
                AccountSettings.KEY_SETTINGS_VERSION to AccountSettings.CURRENT_VERSION.toString(),
                AccountSettings.KEY_ETEBASE_SESSION to config.etebaseSession
            )
            val coordinator = AccountCreationCoordinator(object : AccountCreationCoordinator.Seams {
                override fun rowExists() = accountManager.getAccountsByType(App.accountType).contains(account)
                override fun prepare(id: String) = registry.prepare(AccountCreationRegistry.Record(accountName, id,
                    AccountCreationRegistry.Phase.PREPARED, System.currentTimeMillis(), App.accountType))
                override fun add() = accountManager.addAccountExplicitly(account, null, null)
                override fun writeAndReadBack(key: String, value: String?) =
                    AccountSettings.writeVerified(accountManager, account, key, value)
                override fun phase(id: String, phase: AccountCreationRegistry.Phase) = registry.updateOwned(
                    AccountCreationRegistry.Record(accountName, id, phase, System.currentTimeMillis(), App.accountType))
                override fun activateAndReadBack() = ActiveAccountManager.setActiveAccount(
                    requireContext(),
                    ExactAccountIdentity(App.accountType, accountName, creationId),
                )
                override fun clear(id: String) = registry.clearOwned(App.accountType, accountName, id)
                override fun quarantine(id: String) = PostLoginSetupMigration.persistPendingRecovery(
                    writeState = {
                        AccountSettings.writeSetupState(accountManager, account, PostLoginSetupState.RECOVERY_REQUIRED)
                    },
                    updateRegistry = {
                        registry.updateOwned(AccountCreationRegistry.Record(accountName, id,
                            AccountCreationRegistry.Phase.RECOVERY_REQUIRED, System.currentTimeMillis(), App.accountType))
                    }
                )
            })
            return when (val result = coordinator.create(creationId, fields)) {
                AccountCreationCoordinator.Result.CREATED -> CreationAttempt.Created(account, creationId)
                AccountCreationCoordinator.Result.ACCOUNT_CREATED_QUARANTINED ->
                    creationAttemptFromDurableEvidence(account, accountManager, registry, creationId)
                AccountCreationCoordinator.Result.EXISTS_OR_BUSY,
                AccountCreationCoordinator.Result.NOT_ADDED,
                AccountCreationCoordinator.Result.QUARANTINED,
                AccountCreationCoordinator.Result.QUARANTINE_FAILED ->
                    creationAttemptFromDurableEvidence(account, accountManager, registry, creationId)
            }
        }
    }

    /**
     * Routes all interrupted-creation outcomes from the current durable row and generation
     * evidence. This total router deliberately fails closed once it has observed a row.
     */
    private fun recoverFromUnexpectedFailure(accountName: String, creationId: String): CreationAttempt {
        val account = Account(accountName, App.accountType)
        val manager = AccountManager.get(requireContext())
        var rowObserved = false
        return try {
            rowObserved = account in manager.getAccountsByType(account.type)
            if (!rowObserved)
                CreationAttempt.RetryCredentials
            else
                creationAttemptFromDurableEvidence(
                    account,
                    manager,
                    AccountCreationRegistry.open(requireContext()),
                    creationId,
                )
        } catch (e: Exception) {
            // Once a row has been observed, incomplete registry/state inspection cannot safely
            // downgrade the outcome to credential retry or adopt that row as this generation.
            if (rowObserved) CreationAttempt.SettingsResolution(account) else CreationAttempt.RetryCredentials
        }
    }

    private fun creationAttemptFromDurableEvidence(
        account: Account,
        manager: AccountManager,
        registry: AccountCreationRegistry,
        expectedCreationId: String,
    ): CreationAttempt {
        var rowObserved = false
        return try {
            val rowPresent = account in manager.getAccountsByType(account.type)
            rowObserved = rowPresent
            val id = if (rowPresent) manager.getUserData(account, AccountSettings.KEY_CREATION_ID) else null
            val expectedMatches = id == expectedCreationId
            val registryOwns = rowPresent && id != null && expectedMatches && AccountCreationRegistry.owns(
                registry.get(account.type, account.name), id)
            when (DurableCreationAttemptPolicy.outcome(DurableCreationAttemptPolicy.Evidence(
                rowPresent, id, registryOwns,
                if (registryOwns) AccountSettings.setupState(manager, account, PostLoginSetupMigration.isBootstrapped(requireContext())) else null
            ))) {
                DurableCreationAttemptPolicy.Outcome.RetryCredentials -> CreationAttempt.RetryCredentials
                DurableCreationAttemptPolicy.Outcome.SettingsResolution -> CreationAttempt.SettingsResolution(account)
                DurableCreationAttemptPolicy.Outcome.Recovery -> CreationAttempt.Recovery(account, requireNotNull(id))
                DurableCreationAttemptPolicy.Outcome.Created -> CreationAttempt.Created(account, requireNotNull(id))
                DurableCreationAttemptPolicy.Outcome.Completed -> CreationAttempt.Completed(account, requireNotNull(id))
            }
        } catch (e: Exception) {
            // The row was observed. An incomplete inspection must never turn it into retry.
            if (rowObserved) CreationAttempt.SettingsResolution(account) else CreationAttempt.RetryCredentials
        }
    }

    sealed class CreationAttempt {
        data class Created(val account: Account, val creationId: String) : CreationAttempt()
        data class Completed(val account: Account, val creationId: String) : CreationAttempt()
        data class Recovery(val account: Account, val creationId: String) : CreationAttempt()
        data class SettingsResolution(val account: Account) : CreationAttempt()
        object RetryCredentials : CreationAttempt()
        object Failed : CreationAttempt()
    }

    companion object {
        private val CREATION_LOCK = Any()
        private const val RETRY_ERROR_TAG = "account_creation_retry_error"
        @JvmField internal var afterCreationIdIssuedForTest: ((String) -> Unit)? = null
        fun newInstance(config: Configuration): CreateAccountFragment {
            SetupSecretHolder.setPendingConfiguration(config)
            return CreateAccountFragment()
        }
    }
}
