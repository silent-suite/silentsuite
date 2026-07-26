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

class LoginCredentialsChangeFragment : DialogFragment() {
    private lateinit var account: Account

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

        if (savedInstanceState == null) {
            val credentials = SetupSecretHolder.getLoginCredentials()
            if (credentials == null) {
                Logger.log.warning("Updated login credentials expired before configuration detection")
                SetupSecretHolder.clearProcessOnlySecrets()
                parentFragmentManager.beginTransaction()
                        .add(DetectConfigurationFragment.NothingDetectedFragment.newInstance(R.string.setup_state_expired), null)
                        .commitAllowingStateLoss()
                dismissAllowingStateLoss()
            } else {
                findConfiguration(credentials)
            }
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
                Logger.log.warning("Updated configuration detection failed: ${e.javaClass.name}")
                null
            }
            onLoadFinished(data)
        }
    }

    private fun onLoadFinished(data: Configuration?) {
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
                    SetupSecretHolder.clearProcessOnlySecrets()
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

        SetupSecretHolder.clearProcessOnlySecrets()
        dismissAllowingStateLoss()
    }

    private fun messageResource(error: Throwable?): Int = when (LoginFailureMessagePolicy.messageFor(error)) {
        LoginFailureMessagePolicy.Message.Authentication -> R.string.login_wrong_username_or_password
        LoginFailureMessagePolicy.Message.Connection -> R.string.login_connection_error
        LoginFailureMessagePolicy.Message.Generic -> R.string.login_error_generic
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

        fun newInstance(account: Account, credentials: LoginCredentials): LoginCredentialsChangeFragment {
            SetupSecretHolder.setLoginCredentials(credentials)
            val frag = LoginCredentialsChangeFragment()
            val args = Bundle(1)
            args.putParcelable(ARG_ACCOUNT, account)
            frag.arguments = args
            return frag
        }
    }
}
