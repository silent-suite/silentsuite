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

        if (savedInstanceState == null) {
            val credentials = SetupSecretHolder.getLoginCredentials()
            if (credentials == null) {
                Logger.log.warning("Setup login credentials expired before configuration detection")
                SetupSecretHolder.clearLoginCredentials()
                parentFragmentManager.beginTransaction()
                        .add(NothingDetectedFragment.newInstance(getString(R.string.setup_state_expired)), null)
                        .commitAllowingStateLoss()
                dismissAllowingStateLoss()
            } else {
                findConfiguration(credentials)
            }
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
            if (data.isFailed) {
                Logger.log.warning("Failed login configuration ${data.error?.javaClass?.name}")
                // no service found: show error message
                requireFragmentManager().beginTransaction()
                        .add(NothingDetectedFragment.newInstance(data.error!!.localizedMessage), null)
                        .commitAllowingStateLoss()
            } else {
                Logger.log.info("Found Etebase account")
                requireFragmentManager().beginTransaction()
                        .replace(android.R.id.content, CreateAccountFragment.newInstance(data))
                        .addToBackStack(null)
                        .commitAllowingStateLoss()
            }
        } else
            Logger.log.severe("Configuration detection failed")

        SetupSecretHolder.clearLoginCredentials()
        dismissAllowingStateLoss()
    }

    class NothingDetectedFragment : DialogFragment() {

        override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
            return MaterialAlertDialogBuilder(requireActivity())
                    .setTitle(R.string.setting_up_encryption)
                    .setIcon(R.drawable.ic_error_dark)
                    .setMessage(requireArguments().getString(KEY_LOGS))
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
        fun newInstance(): DetectConfigurationFragment = DetectConfigurationFragment()
    }
}
