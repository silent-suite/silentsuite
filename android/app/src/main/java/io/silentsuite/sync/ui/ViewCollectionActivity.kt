package io.silentsuite.sync.ui

import android.accounts.Account
import android.content.Context
import android.content.Intent
import android.os.Bundle
import io.silentsuite.sync.model.CollectionInfo

/**
 * Legacy stub — was used only by EteSync v1 collection viewing.
 * Etebase equivalent: ui/etebase/CollectionActivity.kt
 * Scheduled for removal in story A1.2.
 */
class ViewCollectionActivity : BaseActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Legacy activity — finish immediately
        finish()
    }

    companion object {
        val EXTRA_ACCOUNT = "account"
        val EXTRA_COLLECTION_INFO = "collectionInfo"

        fun newIntent(context: Context, account: Account, info: CollectionInfo): Intent {
            val intent = Intent(context, ViewCollectionActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            intent.putExtra(EXTRA_COLLECTION_INFO, info)
            return intent
        }
    }
}
