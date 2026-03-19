package io.silentsuite.sync.ui

import android.accounts.Account
import android.app.Dialog
import android.os.Bundle
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.DialogFragment
import io.silentsuite.sync.model.CollectionInfo

/**
 * Legacy stub — was used only by EteSync v1 journal-based collection deletion.
 * Etebase equivalent: ui/etebase/EditCollectionFragment.kt
 * Scheduled for removal in story A1.2.
 */
class DeleteCollectionFragment : DialogFragment() {

    class ConfirmDeleteCollectionFragment : DialogFragment() {

        override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
            return AlertDialog.Builder(requireContext())
                    .setMessage("Legacy fragment — not functional")
                    .setPositiveButton(android.R.string.ok) { _, _ -> dismiss() }
                    .create()
        }

        companion object {
            fun newInstance(account: Account, collectionInfo: CollectionInfo): ConfirmDeleteCollectionFragment {
                val frag = ConfirmDeleteCollectionFragment()
                val args = Bundle(2)
                args.putParcelable(ARG_ACCOUNT, account)
                args.putSerializable(ARG_COLLECTION_INFO, collectionInfo)
                frag.arguments = args
                return frag
            }
        }
    }

    companion object {
        protected const val ARG_ACCOUNT = "account"
        protected const val ARG_COLLECTION_INFO = "collectionInfo"
    }
}
