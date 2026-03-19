package io.silentsuite.sync.ui

import android.accounts.Account
import android.content.Context
import android.content.Intent
import android.os.Bundle
import io.silentsuite.sync.model.CollectionInfo

/**
 * Legacy CollectionMembersActivity stub.
 * The Etebase equivalent is in ui/etebase/CollectionMembersListFragment.kt.
 * This class is kept only for the companion newIntent() method; it finishes immediately.
 */
class CollectionMembersActivity : BaseActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Legacy screen — finish immediately
        finish()
    }

    companion object {
        val EXTRA_ACCOUNT = "account"
        val EXTRA_COLLECTION_INFO = "collectionInfo"

        fun newIntent(context: Context, account: Account, info: CollectionInfo): Intent {
            val intent = Intent(context, CollectionMembersActivity::class.java)
            intent.putExtra(CollectionMembersActivity.EXTRA_ACCOUNT, account)
            intent.putExtra(CollectionMembersActivity.EXTRA_COLLECTION_INFO, info)
            return intent
        }
    }
}
