package io.silentsuite.sync.ui

import android.accounts.Account
import android.os.Bundle
import androidx.fragment.app.DialogFragment
import io.silentsuite.sync.Constants
import io.silentsuite.sync.model.CollectionInfo

/**
 * Legacy stub — was used only by EteSync v1 journal-based member removal.
 * Scheduled for removal in story A1.2.
 */
class RemoveMemberFragment : DialogFragment() {

    companion object {
        private const val KEY_MEMBER = "memberEmail"

        fun newInstance(account: Account, info: CollectionInfo, email: String): RemoveMemberFragment {
            val frag = RemoveMemberFragment()
            val args = Bundle(1)
            args.putParcelable(Constants.KEY_ACCOUNT, account)
            args.putSerializable(Constants.KEY_COLLECTION_INFO, info)
            args.putString(KEY_MEMBER, email)
            frag.arguments = args
            return frag
        }
    }
}
