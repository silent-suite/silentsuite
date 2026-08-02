/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.setup

import android.app.Dialog
import android.os.Bundle
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.fragment.app.DialogFragment
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.utils.ProgressDialogHelper
import io.silentsuite.sync.ui.setup.BaseConfigurationFinder.Configuration
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class DetectConfigurationFragment : DialogFragment() {
    private var lease: SetupSecretHolder.OwnerLease? = null
    private var operation: SetupSecretHolder.OperationToken? = null
    private var started = false

    internal fun ownsActivePresentation(host: LoginActivity, admittedLease: SetupSecretHolder.OwnerLease): Boolean {
        val currentOperation = operation ?: return false
        return isAdded && !isRemoving && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED) &&
            lease == admittedLease && host.isSetupOperationCurrent(currentOperation)
    }

    internal fun hasValidRestoredAuthority(admittedLease: SetupSecretHolder.OwnerLease): Boolean =
        parseLeaseRef()?.let(SetupSecretHolder::resolve) == admittedLease

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
    }

    override fun onStart() {
        super.onStart()
        if (started) return
        started = true

        Logger.log.fine("DetectConfigurationFragment: loading")
        val host = activity as? LoginActivity
        if (host?.isAccountEntryAdmissionPublished() != true) {
            dismissAllowingStateLoss()
            return
        }
        val admittedLease = host?.setupLease()
        lease = parseLeaseRef()?.let(SetupSecretHolder::resolve)
        operation = if (host != null) lease?.takeIf { it == admittedLease }?.let(host::beginSetupOperation) else null
        val currentOperation = operation
        val credentials = currentOperation?.credentials
        if (host == null || admittedLease == null || currentOperation == null) {
            Logger.log.warning("Setup login credentials expired before configuration detection")
            dismissAllowingStateLoss()
        } else if (credentials == null) {
            if (host.commitSetupOperation(
                    currentOperation,
                    SetupSecretHolder.CommitKind.HOLDER_MUTATION,
                    SetupSecretHolder.CommitKind.UI_PUBLICATION,
                    SetupSecretHolder.CommitKind.DISMISSAL,
                )) SetupSecretHolder.clearCredentialsAndConfiguration(admittedLease)
            notifySubmissionFailed()
            parentFragmentManager.beginTransaction()
                    .add(NothingDetectedFragment.newInstance(R.string.setup_state_expired), null)
                    .commitAllowingStateLoss()
            dismissAllowingStateLoss()
        } else {
            // Credentials live only in process memory. Restarting detection is safe after a
            // recreated dialog and avoids restoring a non-running progress indicator.
            findConfiguration(credentials)
        }
    }

    private fun findConfiguration(credentials: LoginCredentials) {
        lifecycleScope.launch {
            val data = try {
                withContext(Dispatchers.IO) {
                    BaseConfigurationFinder(requireContext(), credentials).findInitialConfiguration()
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                Logger.log.warning("Configuration detection failed: ${e.javaClass.name}")
                null
            }
            onLoadFinished(data)
        }
    }

    private fun onLoadFinished(data: Configuration?) {
        val currentLease = lease
        val currentOperation = operation
        val host = activity as? LoginActivity
        if (currentLease == null || currentOperation == null || host == null ||
            !host.isSetupOperationCurrent(currentOperation)) return
        val success = data != null && !data.isFailed
        val commits = if (success) arrayOf(
            SetupSecretHolder.CommitKind.HOLDER_MUTATION,
            SetupSecretHolder.CommitKind.FRAGMENT_COMMIT,
            SetupSecretHolder.CommitKind.DISMISSAL,
        ) else arrayOf(
            SetupSecretHolder.CommitKind.HOLDER_MUTATION,
            SetupSecretHolder.CommitKind.UI_PUBLICATION,
            SetupSecretHolder.CommitKind.DISMISSAL,
        )
        if (!host.commitSetupOperation(currentOperation, *commits)) return
        if (data != null) {
            if (data.isFailed) {
                Logger.log.warning("Failed login configuration ${data.error?.javaClass?.name}")
                // no service found: show error message
                requireFragmentManager().beginTransaction()
                        .add(NothingDetectedFragment.newInstance(messageResource(data.error)), null)
                        .commitAllowingStateLoss()
            } else {
                Logger.log.info("Found Etebase account")
                if (!SetupSecretHolder.setPendingConfiguration(currentLease, data)) return
                requireFragmentManager().beginTransaction()
                        .replace(
                            android.R.id.content,
                            CreateAccountFragment.newInstance(SetupSecretHolder.reference(currentLease)),
                            LoginActivity.CREATE_ACCOUNT_TAG,
                        )
                        .addToBackStack(LoginActivity.CREDENTIALS_TO_CREATOR_BACK_STACK)
                        .commitAllowingStateLoss()
            }
        } else {
            Logger.log.severe("Configuration detection failed")
            requireFragmentManager().beginTransaction()
                .add(NothingDetectedFragment.newInstance(R.string.login_error_generic), null)
                .commitAllowingStateLoss()
        }

        if (data == null || data.isFailed)
            SetupSecretHolder.clearCredentialsAndConfiguration(currentLease)
        else
            SetupSecretHolder.clearLoginCredentials(currentLease)
        if (data == null || data.isFailed)
            notifySubmissionFailed()
        dismissAllowingStateLoss()
    }

    private fun notifySubmissionFailed() {
        (parentFragmentManager.findFragmentById(android.R.id.content) as? LoginCredentialsFragment)
            ?.onSubmissionFailed()
    }

    private fun messageResource(error: Throwable?): Int = when (LoginFailureMessagePolicy.messageFor(error)) {
        LoginFailureMessagePolicy.Message.Authentication -> R.string.login_wrong_username_or_password
        LoginFailureMessagePolicy.Message.Connection -> R.string.login_connection_error
        LoginFailureMessagePolicy.Message.Generic -> R.string.login_error_generic
    }

    private fun parseLeaseRef(): SetupSecretHolder.LeaseRefV1? {
        val args = arguments ?: return null
        if ((args.get(ARG_LEASE_VERSION) as? Int) != SetupSecretHolder.LEASE_REF_VERSION) return null
        val ownerId = args.getString(ARG_LEASE_OWNER)?.takeIf { it.isNotBlank() } ?: return null
        val generation = (args.get(ARG_LEASE_GENERATION) as? Long)?.takeIf { it > 0 } ?: return null
        val kind = runCatching { SetupSecretHolder.LeaseKind.valueOf(args.getString(ARG_LEASE_KIND).orEmpty()) }.getOrNull()
            ?: return null
        if (kind != SetupSecretHolder.LeaseKind.LOGIN) return null
        return SetupSecretHolder.LeaseRefV1(ownerId, generation, kind)
    }

    class NothingDetectedFragment : DialogFragment() {

        override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
            return MaterialAlertDialogBuilder(requireActivity())
                    .setTitle(R.string.setting_up_encryption)
                    .setIcon(R.drawable.ic_error_dark)
                    .setMessage(requireArguments().getInt(KEY_MESSAGE_RES))
                    .setPositiveButton(android.R.string.ok) { dialog, which ->
                        // dismiss
                    }
                    .create()
        }

        companion object {
            private const val KEY_MESSAGE_RES = "message_res"

            fun newInstance(messageRes: Int): NothingDetectedFragment {
                val args = Bundle()
                args.putInt(KEY_MESSAGE_RES, messageRes)
                val fragment = NothingDetectedFragment()
                fragment.arguments = args
                return fragment
            }
        }
    }

    companion object {
        private const val ARG_LEASE_VERSION = "lease_ref_version"
        private const val ARG_LEASE_OWNER = "lease_owner_v1"
        private const val ARG_LEASE_GENERATION = "lease_generation_v1"
        private const val ARG_LEASE_KIND = "lease_kind_v1"

        fun newInstance(reference: SetupSecretHolder.LeaseRefV1): DetectConfigurationFragment =
            DetectConfigurationFragment().apply {
                arguments = Bundle(4).apply {
                    putInt(ARG_LEASE_VERSION, SetupSecretHolder.LEASE_REF_VERSION)
                    putString(ARG_LEASE_OWNER, reference.ownerId)
                    putLong(ARG_LEASE_GENERATION, reference.generation)
                    putString(ARG_LEASE_KIND, reference.kind.name)
                }
            }
    }
}
