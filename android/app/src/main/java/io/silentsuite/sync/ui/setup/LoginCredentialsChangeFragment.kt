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
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.DialogFragment
import androidx.lifecycle.lifecycleScope
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.InvalidAccountException
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.ui.DebugInfoActivity
import io.silentsuite.sync.utils.ProgressDialogHelper
import io.silentsuite.sync.ui.setup.BaseConfigurationFinder.Configuration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.logging.Level

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
            val credentials = requireArguments().getParcelable<LoginCredentials>(ARG_LOGIN_CREDENTIALS)!!
            findConfiguration(credentials)
        }
    }

    private fun findConfiguration(credentials: LoginCredentials) {
        lifecycleScope.launch {
            val data = withContext(Dispatchers.IO) {
                BaseConfigurationFinder(requireContext(), credentials).findInitialConfiguration()
            }
            onLoadFinished(data)
        }
    }

    private fun onLoadFinished(data: Configuration?) {
        if (data != null) {
            if (data.isFailed)
            // no service found: show error message
                parentFragmentManager.beginTransaction()
                        .add(NothingDetectedFragment.newInstance(data.error!!.localizedMessage), null)
                        .commitAllowingStateLoss()
            else {
                val settings: AccountSettings

                try {
                    settings = AccountSettings(requireActivity(), account)
                } catch (e: InvalidAccountException) {
                    Logger.log.log(Level.INFO, "Account is invalid or doesn't exist (anymore)", e)
                    requireActivity().finish()
                    return
                }

                settings.etebaseSession = data.etebaseSession
            }
        } else
            Logger.log.severe("Configuration detection failed")

        dismissAllowingStateLoss()
    }


    class NothingDetectedFragment : DialogFragment() {

        override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
            return AlertDialog.Builder(requireActivity())
                    .setTitle(R.string.setting_up_encryption)
                    .setIcon(R.drawable.ic_error_dark)
                    .setMessage(R.string.login_wrong_username_or_password)
                    .setNeutralButton(R.string.login_view_logs) { dialog, which ->
                        val intent = DebugInfoActivity.newIntent(context, this::class.toString())
                        intent.putExtra(DebugInfoActivity.KEY_LOGS, requireArguments().getString(KEY_LOGS))
                        startActivity(intent)
                    }
                    .setPositiveButton(android.R.string.ok) { dialog, which ->
                        // dismiss
                    }
                    .create()
        }

        companion object {
            private val KEY_LOGS = "logs"

            fun newInstance(logs: String): NothingDetectedFragment {
                val args = Bundle()
                args.putString(KEY_LOGS, logs)
                val fragment = NothingDetectedFragment()
                fragment.arguments = args
                return fragment
            }
        }
    }

    companion object {
        protected val ARG_LOGIN_CREDENTIALS = "credentials"
        protected val ARG_ACCOUNT = "account"

        fun newInstance(account: Account, credentials: LoginCredentials): LoginCredentialsChangeFragment {
            val frag = LoginCredentialsChangeFragment()
            val args = Bundle(1)
            args.putParcelable(ARG_ACCOUNT, account)
            args.putParcelable(ARG_LOGIN_CREDENTIALS, credentials)
            frag.arguments = args
            return frag
        }
    }
}
