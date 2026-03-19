package io.silentsuite.sync.ui

import android.accounts.Account
import android.os.Bundle
import androidx.fragment.app.ListFragment
import io.silentsuite.sync.Constants
import io.silentsuite.sync.model.CollectionInfo

/**
 * Legacy stub — was used only by EteSync v1 journal-based member management.
 * Etebase equivalent: ui/etebase/CollectionMembersListFragment.kt
 * Scheduled for removal in story A1.2.
 */
class CollectionMembersListFragment : ListFragment(), Refreshable {

    override fun refresh() {
        // no-op: legacy stub
    }

    companion object {

        fun newInstance(account: Account, info: CollectionInfo): CollectionMembersListFragment {
            val frag = CollectionMembersListFragment()
            val args = Bundle(1)
            args.putParcelable(Constants.KEY_ACCOUNT, account)
            args.putSerializable(Constants.KEY_COLLECTION_INFO, info)
            frag.arguments = args
            return frag
        }
    }
}
