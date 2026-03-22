/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.setup

import android.app.Dialog
import android.app.ProgressDialog
import android.os.Bundle
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.DialogFragment
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.ui.setup.BaseConfigurationFinder.Configuration
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class DetectConfigurationFragment : DialogFragment() {

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val progress = ProgressDialog(activity)
        progress.setTitle(R.string.setting_up_encryption)
        progress.setMessage(getString(R.string.setting_up_encryption_content))
        progress.isIndeterminate = true
        progress.setCanceledOnTouchOutside(false)
        isCancelable = false
        return progress
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Logger.log.fine("DetectConfigurationFragment: loading")

        if (savedInstanceState == null) {
            findConfiguration(requireArguments().getParcelable(ARG_LOGIN_CREDENTIALS)!!)
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
                Logger.log.warning("Failed login configuration ${data.error?.localizedMessage}")
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

        dismissAllowingStateLoss()
    }

    class NothingDetectedFragment : DialogFragment() {

        override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
            return AlertDialog.Builder(requireActivity())
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
        protected val ARG_LOGIN_CREDENTIALS = "credentials"

        fun newInstance(credentials: LoginCredentials): DetectConfigurationFragment {
            val frag = DetectConfigurationFragment()
            val args = Bundle(1)
            args.putParcelable(ARG_LOGIN_CREDENTIALS, credentials)
            frag.arguments = args
            return frag
        }
    }
}
