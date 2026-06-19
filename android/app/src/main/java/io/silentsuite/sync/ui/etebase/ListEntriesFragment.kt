package io.silentsuite.sync.ui.etebase

import android.accounts.Account
import android.content.ContentResolver
import android.content.Context
import android.os.Bundle
import android.os.Parcelable
import android.provider.CalendarContract
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.ImageView
import android.widget.TextView
import androidx.fragment.app.ListFragment
import androidx.fragment.app.activityViewModels
import androidx.fragment.app.commit
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.android.material.snackbar.Snackbar
import io.silentsuite.sync.App
import io.silentsuite.sync.CachedCollection
import io.silentsuite.sync.CachedItem
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.utils.TaskProviderHandling
import java.text.SimpleDateFormat


class ListEntriesFragment : ListFragment(), AdapterView.OnItemClickListener {
    private val accountModel: AccountViewModel by activityViewModels()
    private val collectionModel: CollectionViewModel by activityViewModels()
    private val itemsModel: ItemsViewModel by activityViewModels()
    private var state: Parcelable? = null

    private var emptyTextView: TextView? = null
    private var swipeRefreshLayout: SwipeRefreshLayout? = null
    private var syncStatusObserver: Any? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val view = inflater.inflate(R.layout.journal_viewer_list, container, false)

        //This is instead of setEmptyText() function because of Google bug
        //See: https://code.google.com/p/android/issues/detail?id=21742
        emptyTextView = view.findViewById<View>(android.R.id.empty) as TextView
        swipeRefreshLayout = view.findViewById(R.id.swipe_refresh)

        return view
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        var restored = false

        collectionModel.observe(this) { col ->
            itemsModel.observe(this) {
                val entries = it.sortedByDescending { item ->
                    item.meta.mtime ?: 0
                }
                val listAdapter = EntriesListAdapter(requireContext(), col)
                setListAdapter(listAdapter)

                listAdapter.addAll(entries)

                if(!restored && (state != null)) {
                    listView.onRestoreInstanceState(state)
                    restored = true
                }

                emptyTextView!!.text = getString(emptyTextRes(requireContext(), col.collectionType))
            }
        }

        listView.onItemClickListener = this

        swipeRefreshLayout?.apply {
            // Match the app accent palette for the refresh indicator.
            setColorSchemeResources(
                    R.color.teal400, R.color.teal500, R.color.teal600, R.color.teal700)
            setOnRefreshListener { onUserRefresh() }
            // The direct child is a FrameLayout (so the empty view can overlay the
            // ListView), so delegate scroll-up detection to the real scrollable list.
            setOnChildScrollUpCallback { _, _ -> listView.canScrollVertically(-1) }
        }
    }

    override fun onResume() {
        super.onResume()
        // Observe active sync state so the refresh indicator clears reliably when the
        // sync finishes (success or error), and reflects an already-running sync.
        syncStatusObserver = ContentResolver.addStatusChangeListener(
                ContentResolver.SYNC_OBSERVER_TYPE_ACTIVE
        ) { _ -> swipeRefreshLayout?.post { updateRefreshState() } }
        updateRefreshState()
    }

    override fun onPause() {
        state = listView.onSaveInstanceState()
        syncStatusObserver?.let { ContentResolver.removeStatusChangeListener(it) }
        syncStatusObserver = null
        super.onPause()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        swipeRefreshLayout = null
    }

    /**
     * Pull-to-refresh handler. Requests a manual sync for the account unless a sync
     * is already running for one of its authorities (no duplicate concurrent syncs).
     */
    private fun onUserRefresh() {
        val refresh = swipeRefreshLayout ?: return
        val account = accountModel.value?.account
        if (account == null) {
            refresh.isRefreshing = false
            return
        }
        if (!ContentResolver.getMasterSyncAutomatically()) {
            // System-wide sync is off; the framework would drop the request, so surface
            // the state and clear the spinner instead of leaving it spinning forever.
            refresh.isRefreshing = false
            view?.let {
                Snackbar.make(it, R.string.accounts_global_sync_disabled, Snackbar.LENGTH_LONG)
                        .setAction(R.string.accounts_global_sync_enable) {
                            ContentResolver.setMasterSyncAutomatically(true)
                        }
                        .show()
            }
            return
        }
        if (isSyncActiveForAccount(account)) {
            // A sync is already in progress; keep the spinner, the SyncStatusObserver
            // will clear it when no authority is active anymore.
            return
        }
        val context = activity?.applicationContext
        if (context == null) {
            refresh.isRefreshing = false
            return
        }
        requestSync(context, account)
    }

    /**
     * Updates the refresh indicator to match the current sync state. Called from
     * [onResume] and whenever the active-sync status changes.
     */
    private fun updateRefreshState() {
        val refresh = swipeRefreshLayout ?: return
        val account = accountModel.value?.account
        refresh.isRefreshing = account != null && isSyncActiveForAccount(account)
    }

    private fun isSyncActiveForAccount(account: Account): Boolean {
        val authorities = mutableListOf(App.addressBooksAuthority, CalendarContract.AUTHORITY)
        TaskProviderHandling.getWantedTaskSyncProvider(requireContext())?.authority?.let { authorities.add(it) }
        return authorities.any { ContentResolver.isSyncActive(account, it) }
    }

    override fun onItemClick(parent: AdapterView<*>, view: View, position: Int, id: Long) {
        val item = listAdapter?.getItem(position) as CachedItem
        activity?.supportFragmentManager?.commit {
            replace(R.id.fragment_container, CollectionItemFragment.newInstance(item))
            addToBackStack(EditCollectionFragment::class.java.name)
        }
    }

    internal inner class EntriesListAdapter(context: Context, val cachedCollection: CachedCollection) : ArrayAdapter<CachedItem>(context, R.layout.journal_viewer_list_item) {

        override fun getView(position: Int, _v: View?, parent: ViewGroup): View {
            var v = _v
            if (v == null)
                v = LayoutInflater.from(context).inflate(R.layout.journal_viewer_list_item, parent, false)!!

            val item = getItem(position)!!

            setItemView(v, cachedCollection.collectionType, item)

            /* FIXME: handle entry error:
            val entryError = data.select(EntryErrorEntity::class.java).where(EntryErrorEntity.ENTRY.eq(entryEntity)).limit(1).get().firstOrNull()
            if (entryError != null) {
                val errorIcon = v.findViewById<View>(R.id.error) as ImageView
                errorIcon.visibility = View.VISIBLE
            }
             */

            return v
        }
    }

    companion object {
        private val dateFormatter = SimpleDateFormat()
        private fun getLine(content: String?, prefix: String): String? {
            var content: String? = content ?: return null

            val start = content!!.indexOf(prefix)
            if (start >= 0) {
                val end = content.indexOf("\n", start)
                content = content.substring(start + prefix.length, end)
            } else {
                content = null
            }
            return content
        }

        fun setItemView(v: View, collectionType: String, item: CachedItem) {

            var tv = v.findViewById<View>(R.id.title) as TextView

            // FIXME: hacky way to make it show sensible info
            val prefix: String = when (collectionType) {
                Constants.ETEBASE_TYPE_CALENDAR, Constants.ETEBASE_TYPE_TASKS -> {
                    "SUMMARY:"
                }
                Constants.ETEBASE_TYPE_ADDRESS_BOOK -> {
                    "FN:"
                }
                else -> {
                    ""
                }
            }

            val fullContent = item.content
            var content = getLine(fullContent, prefix)
            content = content ?: v.context.getString(R.string.journal_item_title_unavailable)
            tv.text = content

            tv = v.findViewById<View>(R.id.description) as TextView
            val modifiedAt = item.meta.mtime
            tv.text = if (modifiedAt == null || modifiedAt <= 0L) {
                v.context.getString(R.string.journal_item_modified_unavailable)
            } else {
                v.context.getString(R.string.journal_item_modified, dateFormatter.format(modifiedAt))
            }

            val action = v.findViewById<View>(R.id.action) as ImageView
            if (item.item.isDeleted) {
                action.setImageResource(R.drawable.action_delete)
                action.contentDescription = v.context.getString(R.string.journal_item_action_deleted)
            } else {
                action.setImageResource(R.drawable.action_change)
                action.contentDescription = v.context.getString(R.string.journal_item_action_changed)
            }
        }

        private fun emptyTextRes(context: Context, collectionType: String) = when (collectionType) {
            Constants.ETEBASE_TYPE_CALENDAR -> R.string.journal_entries_list_empty_calendar
            Constants.ETEBASE_TYPE_TASKS -> {
                if (TaskProviderHandling.getWantedTaskSyncProvider(context) == null) {
                    R.string.journal_entries_list_empty_tasks_setup
                } else {
                    R.string.journal_entries_list_empty_tasks
                }
            }
            Constants.ETEBASE_TYPE_ADDRESS_BOOK -> R.string.journal_entries_list_empty_contacts
            else -> R.string.journal_entries_list_empty
        }
    }
}
