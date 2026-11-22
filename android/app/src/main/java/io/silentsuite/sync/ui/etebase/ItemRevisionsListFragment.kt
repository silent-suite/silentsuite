package io.silentsuite.sync.ui.etebase

import android.content.Context
import android.os.Bundle
import android.os.Parcelable
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.ListFragment
import androidx.fragment.app.activityViewModels
import androidx.fragment.app.commit
import androidx.fragment.app.viewModels
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.observe
import com.etebase.client.FetchOptions
import io.silentsuite.sync.CachedCollection
import io.silentsuite.sync.CachedItem
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.ui.etebase.ListEntriesFragment.Companion.setItemView
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.*


class ItemRevisionsListFragment : ListFragment(), AdapterView.OnItemClickListener {
    private val model: AccountViewModel by activityViewModels()
    private val revisionsModel: RevisionsViewModel by viewModels()
    private var state: Parcelable? = null

    private lateinit var cachedCollection: CachedCollection
    private lateinit var cachedItem: CachedItem

    private var emptyTextView: TextView? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val view = inflater.inflate(R.layout.journal_viewer_list, container, false)

        //This is instead of setEmptyText() function because of Google bug
        //See: https://code.google.com/p/android/issues/detail?id=21742
        emptyTextView = view.findViewById<View>(android.R.id.empty) as TextView

        return view
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        var restored = false

        revisionsModel.loadRevisions(model.value!!, cachedCollection, cachedItem)
        revisionsModel.observe(this) {
            val entries = it.sortedByDescending { item ->
                item.meta.mtime ?: 0
            }
            val listAdapter = EntriesListAdapter(requireContext(), cachedCollection)
            setListAdapter(listAdapter)

            listAdapter.addAll(entries)

            if(!restored && (state != null)) {
                listView.onRestoreInstanceState(state)
                restored = true
            }

            emptyTextView!!.text = getString(R.string.journal_revisions_list_empty)
        }
        revisionsModel.observeLoadFailed(viewLifecycleOwner) { failed ->
            if (!failed) return@observeLoadFailed
            emptyTextView?.setText(R.string.journal_revisions_load_error)
            // Rows from an earlier load hide the empty text, so the failure is said where it shows.
            if ((listAdapter?.count ?: 0) > 0)
                Toast.makeText(requireContext(), R.string.journal_revisions_load_error, Toast.LENGTH_LONG).show()
        }

        listView.onItemClickListener = this
    }
    override fun onPause() {
        state = listView.onSaveInstanceState()
        super.onPause()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        revisionsModel.cancelLoad()
    }

    override fun onItemClick(parent: AdapterView<*>, view: View, position: Int, id: Long) {
        val item = listAdapter?.getItem(position) as CachedItem
        activity?.supportFragmentManager?.commit {
            // The revision opens in the same item screen, so restoring it keeps the exact identity
            // and the contacts confirmation and read-only checks.
            replace(R.id.fragment_container, CollectionItemFragment.newInstance(item,
                CollectionLifecycleIdentity.from(parentFragment?.arguments)))
            addToBackStack(null)
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
        fun newInstance(cachedCollection: CachedCollection, cachedItem: CachedItem): ItemRevisionsListFragment {
            val ret = ItemRevisionsListFragment()
            ret.cachedCollection = cachedCollection
            ret.cachedItem = cachedItem
            return ret
        }
    }
}


class RevisionsViewModel : ViewModel() {
    private val revisions = MutableLiveData<List<CachedItem>>()
    private val loadFailed = MutableLiveData<Boolean>()
    private var asyncTask: Job? = null

    fun loadRevisions(accountCollectionHolder: AccountHolder, cachedCollection: CachedCollection, cachedItem: CachedItem) {
        // Only the latest load's outcome counts: a failure before it is not shown again.
        loadFailed.value = false
        asyncTask = viewModelScope.launch {
            val ret = try { withContext(Dispatchers.IO) {
                val result = LinkedList<CachedItem>()
                val col = cachedCollection.col
                val itemManager = accountCollectionHolder.colMgr.getItemManager(col)
                var iterator: String? = null
                var done = false
                while (!done) {
                    val chunk = itemManager.itemRevisions(cachedItem.item, FetchOptions().iterator(iterator).limit(30))
                    iterator = chunk.iterator
                    done = chunk.isDone

                    result.addAll(chunk.data.map { CachedItem(it, it.meta, it.contentString) })
                }
                result
            } } catch (e: Exception) {
                // Offline or a server error: say so on the screen instead of crashing.
                if (e is CancellationException) throw e
                Logger.log.warning("Loading revisions failed: ${e.javaClass.name}")
                loadFailed.value = true
                return@launch
            }
            revisions.value = ret
        }
    }

    fun cancelLoad() {
        asyncTask?.cancel()
    }

    fun observe(owner: LifecycleOwner, observer: (List<CachedItem>) -> Unit) =
            revisions.observe(owner, observer)

    fun observeLoadFailed(owner: LifecycleOwner, observer: (Boolean) -> Unit) =
            loadFailed.observe(owner, observer)
}
