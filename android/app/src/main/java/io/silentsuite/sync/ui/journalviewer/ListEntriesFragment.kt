package io.silentsuite.sync.ui.journalviewer

import android.accounts.Account
import android.os.Bundle
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import androidx.fragment.app.ListFragment
import io.silentsuite.sync.R
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.ui.ViewCollectionActivity

/**
 * Legacy stub — was used only by EteSync v1 journal entry listing.
 * Scheduled for removal in story A1.2.
 */
class ListEntriesFragment : ListFragment() {

    companion object {
        protected val EXTRA_COLLECTION_INFO = "collectionInfo"

        fun newInstance(account: Account, info: CollectionInfo): ListEntriesFragment {
            val frag = ListEntriesFragment()
            val args = Bundle(1)
            args.putParcelable(ViewCollectionActivity.EXTRA_ACCOUNT, account)
            args.putSerializable(EXTRA_COLLECTION_INFO, info)
            frag.arguments = args
            return frag
        }

        fun setJournalEntryView(v: View, info: CollectionInfo, syncEntry: Any?) {
            // Legacy stub — no-op
            val tv = v.findViewById<View>(R.id.title) as? TextView
            tv?.text = "Legacy entry"

            val desc = v.findViewById<View>(R.id.description) as? TextView
            desc?.text = ""

            val action = v.findViewById<View>(R.id.action) as? ImageView
            // no-op
        }
    }
}
