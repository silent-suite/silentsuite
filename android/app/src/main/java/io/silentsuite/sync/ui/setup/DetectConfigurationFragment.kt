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

        Logger.log.fine("DetectConfigurationFragment: loading")

        val credentials = SetupSecretHolder.getLoginCredentials()
        if (credentials == null) {
            Logger.log.warning("Setup login credentials expired before configuration detection")
            SetupSecretHolder.clearLoginCredentials()
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
        if (data != null) {
            if (data.isFailed) {
                Logger.log.warning("Failed login configuration ${data.error?.javaClass?.name}")
                // no service found: show error message
                requireFragmentManager().beginTransaction()
                        .add(NothingDetectedFragment.newInstance(messageResource(data.error)), null)
                        .commitAllowingStateLoss()
            } else {
                Logger.log.info("Found Etebase account")
                requireFragmentManager().beginTransaction()
                        .replace(android.R.id.content, CreateAccountFragment.newInstance(data))
                        .addToBackStack(null)
                        .commitAllowingStateLoss()
            }
        } else {
            Logger.log.severe("Configuration detection failed")
            requireFragmentManager().beginTransaction()
                .add(NothingDetectedFragment.newInstance(R.string.login_error_generic), null)
                .commitAllowingStateLoss()
        }

        if (data == null || data.isFailed)
            SetupSecretHolder.clearProcessOnlySecrets()
        else
            SetupSecretHolder.clearLoginCredentials()
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
        fun newInstance(): DetectConfigurationFragment = DetectConfigurationFragment()
    }
}
