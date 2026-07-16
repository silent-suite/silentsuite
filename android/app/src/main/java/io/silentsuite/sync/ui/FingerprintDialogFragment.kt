package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.DialogFragment
import com.etebase.client.Utils
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.setup.ExactAccountRouting

/** Recreation-safe, exact-generation fingerprint surface. The public fingerprint is not secret. */
class FingerprintDialogFragment : DialogFragment() {
    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val account = arguments?.getParcelable<Account>(ARG_ACCOUNT)
        val creationId = arguments?.getString(ARG_CREATION_ID)?.takeIf { it.isNotBlank() }
        val exactAccount = ExactAccountRouting.validate(
            account,
            creationId,
            App.accountType,
            AccountManager.get(requireContext())
        )
        if (exactAccount == null) {
            requireActivity().finish()
            return MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.show_fingperprint_title)
                .setMessage(R.string.fingerprint_unavailable)
                .setPositiveButton(android.R.string.ok, null)
                .create()
        }

        val fingerprint = runCatching {
            val context = requireContext()
            val value = fingerprintProviderOverride?.invoke(context, exactAccount) ?: run {
                val settings = AccountSettings(context, exactAccount)
                val etebase = EtebaseLocalCache.getEtebase(context, HttpClient.sharedClient, settings)
                Utils.prettyFingerprint(etebase.invitationManager.pubkey)
            }
            value.takeIf {
                ExactAccountRouting.validate(
                    exactAccount,
                    requireNotNull(creationId),
                    App.accountType,
                    AccountManager.get(context)
                ) == exactAccount
            }
        }.getOrNull()
        val displayFingerprint = fingerprint ?: getString(R.string.fingerprint_unavailable)
        val view = layoutInflater.inflate(R.layout.fingerprint_alertdialog, null)
        view.findViewById<View>(R.id.body).visibility = View.GONE
        view.findViewById<TextView>(R.id.fingerprint).text = displayFingerprint

        return MaterialAlertDialogBuilder(requireContext())
            .setIcon(R.drawable.ic_fingerprint_dark)
            .setTitle(R.string.show_fingperprint_title)
            .setView(view)
            .setNeutralButton(R.string.copy_fingerprint) { _, _ ->
                if (fingerprint == null) {
                    Toast.makeText(requireContext(), R.string.fingerprint_unavailable, Toast.LENGTH_SHORT).show()
                } else {
                    val context = context ?: return@setNeutralButton
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    if (ExactAccountRouting.validate(
                            exactAccount,
                            requireNotNull(creationId),
                            App.accountType,
                            AccountManager.get(context)
                        ) != exactAccount) {
                        Toast.makeText(context, R.string.fingerprint_unavailable, Toast.LENGTH_SHORT).show()
                        dismissAllowingStateLoss()
                        return@setNeutralButton
                    }
                    clipboard.setPrimaryClip(ClipData.newPlainText(getString(R.string.fingerprint_clipboard_label), fingerprint))
                    Toast.makeText(context, R.string.fingerprint_copied, Toast.LENGTH_SHORT).show()
                }
            }
            .setPositiveButton(android.R.string.ok, null)
            .create()
    }

    companion object {
        const val TAG = "fingerprint"
        private const val ARG_ACCOUNT = "fingerprint.account"
        private const val ARG_CREATION_ID = "fingerprint.creationId"

        /** Credential-free runtime seam; production always leaves this null. */
        internal var fingerprintProviderOverride: ((Context, Account) -> String)? = null

        fun newInstance(account: Account, creationId: String) = FingerprintDialogFragment().apply {
            arguments = Bundle(2).apply {
                putParcelable(ARG_ACCOUNT, account)
                putString(ARG_CREATION_ID, creationId)
            }
        }
    }
}
