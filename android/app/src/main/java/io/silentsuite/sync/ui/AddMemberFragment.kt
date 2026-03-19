package io.silentsuite.sync.ui

import android.accounts.Account
import android.os.Bundle
import androidx.fragment.app.DialogFragment
import io.silentsuite.sync.Constants
import io.silentsuite.sync.model.CollectionInfo

/**
 * Legacy stub — was used only by EteSync v1 journal-based member addition.
 * Scheduled for removal in story A1.2.
 */
class AddMemberFragment : DialogFragment() {

    companion object {
        private const val KEY_MEMBER = "memberEmail"
        private const val KEY_READ_ONLY = "readOnly"

        fun newInstance(account: Account, info: CollectionInfo, email: String, readOnly: Boolean): AddMemberFragment {
            val frag = AddMemberFragment()
            val args = Bundle(1)
            args.putParcelable(Constants.KEY_ACCOUNT, account)
            args.putSerializable(Constants.KEY_COLLECTION_INFO, info)
            args.putString(KEY_MEMBER, email)
            args.putBoolean(KEY_READ_ONLY, readOnly)
            frag.arguments = args
            return frag
        }
    }
}
