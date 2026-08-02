/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.app.Dialog
import android.os.Bundle
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.fragment.app.DialogFragment
import androidx.lifecycle.lifecycleScope
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.InvalidAccountException
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.utils.ProgressDialogHelper
import io.silentsuite.sync.ui.DebugInfoActivity
import io.silentsuite.sync.ui.setup.BaseConfigurationFinder.Configuration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

class LoginCredentialsChangeFragment : DialogFragment() {
    private lateinit var account: Account
    private var lease: SetupSecretHolder.OwnerLease? = null
    private var bindingToken: SetupSecretHolder.BindingToken? = null
    private var operation: SetupSecretHolder.OperationToken? = null
    private var started = false
    private val instanceNonce = UUID.randomUUID().toString()

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
        account = requireArguments().getParcelable(ARG_ACCOUNT)!!
    }

    override fun onStart() {
        super.onStart()
        if (started) return
        started = true

        lease = parseLeaseRef()?.let(SetupSecretHolder::resolve)
        bindingToken = lease?.let { SetupSecretHolder.bind(it, this, instanceNonce) }
        operation = lease?.let(SetupSecretHolder::beginOperation)
        val credentials = operation?.credentials
        if (bindingToken == null || credentials == null) {
            Logger.log.warning("Updated login credentials expired before configuration detection")
            if (bindingToken == null)
                lease?.let(SetupSecretHolder::retireUnboundOrRebinding)
            else
                bindingToken?.let { SetupSecretHolder.releaseBinding(it, this, changingConfigurations = false) }
            bindingToken = null
            parentFragmentManager.beginTransaction()
                    .add(DetectConfigurationFragment.NothingDetectedFragment.newInstance(R.string.setup_state_expired), null)
                    .commitAllowingStateLoss()
            dismissAllowingStateLoss()
        } else {
            findConfiguration(credentials)
        }
    }

    override fun onDestroy() {
        bindingToken?.let {
            SetupSecretHolder.releaseBinding(it, this, activity?.isChangingConfigurations == true)
        }
        bindingToken = null
        super.onDestroy()
    }

    private fun findConfiguration(credentials: LoginCredentials) {
        lifecycleScope.launch {
            val data = try {
                withContext(Dispatchers.IO) {
                    BaseConfigurationFinder(requireContext(), credentials).findInitialConfiguration()
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                Logger.log.warning("Updated configuration detection failed: ${e.javaClass.name}")
                null
            }
            onLoadFinished(data)
        }
    }

    private fun onLoadFinished(data: Configuration?) {
        val currentLease = lease
        val currentBinding = bindingToken
        val currentOperation = operation
        if (currentLease == null || currentBinding == null || currentOperation == null ||
            !SetupSecretHolder.compareBinding(currentBinding, this) ||
            !SetupSecretHolder.compareOperation(currentOperation)) return
        if (!listOf(
                SetupSecretHolder.CommitKind.SETTINGS_WRITE,
                SetupSecretHolder.CommitKind.HOLDER_MUTATION,
                SetupSecretHolder.CommitKind.UI_PUBLICATION,
                SetupSecretHolder.CommitKind.DISMISSAL,
            ).all { SetupSecretHolder.commitIfCurrent(currentOperation, it) }) return
        if (data != null) {
            if (data.isFailed)
            // no service found: show error message
                parentFragmentManager.beginTransaction()
                        .add(NothingDetectedFragment.newInstance(messageResource(data.error)), null)
                        .commitAllowingStateLoss()
            else {
                val settings: AccountSettings

                try {
                    settings = AccountSettings(requireActivity(), account)
                } catch (e: InvalidAccountException) {
                    Logger.log.info("Account is invalid or doesn't exist (anymore): ${e.javaClass.name}")
                    lease?.let(SetupSecretHolder::revoke)
                    requireActivity().finish()
                    return
                }

                try {
                    settings.etebaseSession = data.etebaseSession
                } catch (e: Exception) {
                    Logger.log.warning("Updated credentials could not be saved: ${e.javaClass.name}")
                    parentFragmentManager.beginTransaction()
                        .add(NothingDetectedFragment.newInstance(R.string.login_error_generic), null)
                        .commitAllowingStateLoss()
                }
            }
        } else {
            Logger.log.severe("Configuration detection failed")
            parentFragmentManager.beginTransaction()
                .add(NothingDetectedFragment.newInstance(R.string.login_error_generic), null)
                .commitAllowingStateLoss()
        }

        SetupSecretHolder.revoke(currentLease)
        dismissAllowingStateLoss()
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
        val kind = runCatching {
            SetupSecretHolder.LeaseKind.valueOf(args.getString(ARG_LEASE_KIND).orEmpty())
        }.getOrNull() ?: return null
        if (kind != SetupSecretHolder.LeaseKind.CREDENTIAL_CHANGE) return null
        return SetupSecretHolder.LeaseRefV1(ownerId, generation, kind)
    }


    class NothingDetectedFragment : DialogFragment() {

        override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
            return MaterialAlertDialogBuilder(requireActivity())
                    .setTitle(R.string.setting_up_encryption)
                    .setIcon(R.drawable.ic_error_dark)
                    .setMessage(requireArguments().getInt(KEY_MESSAGE_RES))
                    .setNeutralButton(R.string.login_view_logs) { _, _ ->
                        startActivity(DebugInfoActivity.newIntent(requireContext(), NothingDetectedFragment::class.java.name))
                    }
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
        protected val ARG_ACCOUNT = "account"
        private const val ARG_LEASE_VERSION = "lease_ref_version"
        private const val ARG_LEASE_OWNER = "lease_owner_v1"
        private const val ARG_LEASE_GENERATION = "lease_generation_v1"
        private const val ARG_LEASE_KIND = "lease_kind_v1"

        fun newInstance(account: Account, credentials: LoginCredentials): LoginCredentialsChangeFragment {
            val lease = SetupSecretHolder.issue(
                SetupSecretHolder.LeaseKind.CREDENTIAL_CHANGE,
                credentials,
                bound = false,
            )
            val reference = SetupSecretHolder.reference(lease)
            val frag = LoginCredentialsChangeFragment()
            val args = Bundle(5)
            args.putParcelable(ARG_ACCOUNT, account)
            args.putInt(ARG_LEASE_VERSION, SetupSecretHolder.LEASE_REF_VERSION)
            args.putString(ARG_LEASE_OWNER, reference.ownerId)
            args.putLong(ARG_LEASE_GENERATION, reference.generation)
            args.putString(ARG_LEASE_KIND, reference.kind.name)
            frag.arguments = args
            return frag
        }
    }
}
