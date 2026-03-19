package io.silentsuite.sync.ui

import android.accounts.Account
import android.os.Bundle
import androidx.fragment.app.DialogFragment
import io.silentsuite.sync.model.CollectionInfo

/**
 * Legacy stub — was used only by EteSync v1 journal-based collection creation.
 * Etebase equivalent: ui/etebase/EditCollectionFragment.kt
 * Scheduled for removal in story A1.2.
 */
class CreateCollectionFragment : DialogFragment() {

    companion object {
        private const val ARG_ACCOUNT = "account"
        private const val ARG_COLLECTION_INFO = "collectionInfo"

        fun newInstance(account: Account, info: CollectionInfo): CreateCollectionFragment {
            val frag = CreateCollectionFragment()
            val args = Bundle(2)
            args.putParcelable(ARG_ACCOUNT, account)
            args.putSerializable(ARG_COLLECTION_INFO, info)
            frag.arguments = args
            return frag
        }
    }
}
