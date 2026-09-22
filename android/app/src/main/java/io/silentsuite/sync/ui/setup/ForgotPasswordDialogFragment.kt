package io.silentsuite.sync.ui.setup

import android.app.Dialog
import android.os.Bundle
import androidx.fragment.app.DialogFragment
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.R

/** Password help stays local and survives configuration changes without holding credentials. */
class ForgotPasswordDialogFragment : DialogFragment() {
    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog =
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.login_forgot_password)
            .setMessage(R.string.login_forgot_password_message)
            .setPositiveButton(android.R.string.ok, null)
            .create()

    companion object {
        const val TAG = "forgot-password-help"
    }
}
