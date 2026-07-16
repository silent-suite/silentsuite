package io.silentsuite.sync.ui.etebase

import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.TextView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.fragment.app.ListFragment
import androidx.fragment.app.activityViewModels
import androidx.fragment.app.viewModels
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.observe
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.CollectionMember
import com.etebase.client.FetchOptions
import io.silentsuite.sync.CachedCollection
import io.silentsuite.sync.R
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.*

class CollectionMembersListFragment : ListFragment(), AdapterView.OnItemClickListener {
    private val model: AccountViewModel by activityViewModels()
    private val collectionModel: CollectionViewModel by activityViewModels()
    private val membersModel: CollectionMembersViewModel by viewModels()

    private var emptyTextView: TextView? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val view = inflater.inflate(R.layout.collection_members_list, container, false)

        //This is instead of setEmptyText() function because of Google bug
        //See: https://code.google.com/p/android/issues/detail?id=21742
        emptyTextView = view.findViewById<TextView>(android.R.id.empty)
        return view
    }

    private fun setListAdapterMembers(members: List<RuntimeMember>) {
        val context = context
        if (context != null) {
            val listAdapter = MembersListAdapter(context)
            setListAdapter(listAdapter)

            listAdapter.addAll(members)

            emptyTextView!!.setText(R.string.collection_members_list_empty)
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val identity = CollectionLifecycleIdentity.from(parentFragment?.arguments)
        if (identity != null) {
            runtimeFixture(requireContext(), identity)?.let { fixture ->
                setListAdapterMembers(fixture.members)
                emptyTextView!!.setText(R.string.collection_members_list_empty)
                listView.onItemClickListener = this
                return
            }
        }

        model.observe(viewLifecycleOwner) {
            collectionModel.observe(viewLifecycleOwner) { cachedCollection ->
                val identity = CollectionLifecycleIdentity.from(parentFragment?.arguments)
                if (identity == null || !identity.validate(requireContext()) ||
                    identity.account != it.account || identity.collectionUid != cachedCollection.col.uid ||
                    identity.collectionType != cachedCollection.collectionType) {
                    requireActivity().finish()
                    return@observe
                }
                membersModel.loadMembers(requireContext().applicationContext, identity, it, cachedCollection)
            }
        }

        membersModel.observe(viewLifecycleOwner) {
            setListAdapterMembers(it)
        }

        listView.onItemClickListener = this
    }

    override fun onDestroyView() {
        super.onDestroyView()

        membersModel.cancelLoad()
    }

    override fun onItemClick(parent: AdapterView<*>, view: View, position: Int, id: Long) {
        val member = listAdapter?.getItem(position) as RuntimeMember

        if (member.accessLevel == CollectionAccessLevel.Admin) {
            MaterialAlertDialogBuilder(requireActivity())
                    .setIcon(R.drawable.ic_error_dark)
                    .setTitle(R.string.collection_members_remove_title)
                    .setMessage(R.string.collection_members_remove_admin)
                    .setNegativeButton(android.R.string.ok) { _, _ -> }.show()
            return
        }

        MaterialAlertDialogBuilder(requireActivity())
                .setIcon(R.drawable.ic_info_dark)
                .setTitle(R.string.collection_members_remove_title)
                .setMessage(getString(R.string.collection_members_remove, member.username))
                .setPositiveButton(android.R.string.yes) { _, _ ->
                    val identity = CollectionLifecycleIdentity.from(parentFragment?.arguments)
                    if (identity == null || !identity.validate(requireContext())) {
                        requireActivity().finish()
                        return@setPositiveButton
                    }
                    if (runtimeFixture(requireContext(), identity) != null) {
                        membersModel.removeFixtureMember(
                            requireContext().applicationContext, identity, member.username
                        )
                        return@setPositiveButton
                    }
                    membersModel.removeMember(
                        requireContext().applicationContext,
                        identity,
                        model.value!!,
                        collectionModel.value!!,
                        member.username
                    )
                }
                .setNegativeButton(android.R.string.no) { _, _ -> }.show()
    }

    internal inner class MembersListAdapter(context: Context) : ArrayAdapter<RuntimeMember>(context, R.layout.collection_members_list_item) {

        override fun getView(position: Int, _v: View?, parent: ViewGroup): View {
            var v = _v
            if (v == null)
                v = LayoutInflater.from(context).inflate(R.layout.collection_members_list_item, parent, false)

            val member = getItem(position)

            val tv = v!!.findViewById<View>(R.id.title) as TextView
            tv.text = member!!.username

            // FIXME: Also mark admins
            val readOnly = v.findViewById<View>(R.id.read_only)
            readOnly.visibility = if (member.accessLevel == CollectionAccessLevel.ReadOnly) View.VISIBLE else View.GONE
            v.contentDescription = getString(
                when (member.accessLevel) {
                    CollectionAccessLevel.ReadOnly -> R.string.collection_member_accessibility_read_only
                    CollectionAccessLevel.Admin -> R.string.collection_member_accessibility_admin
                    else -> R.string.collection_member_accessibility
                },
                member.username
            )
            tv.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            readOnly.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO

            return v
        }
    }
}

class CollectionMembersViewModel : ViewModel() {
    private val members = MutableLiveData<List<RuntimeMember>>()
    private var asyncTask: Job? = null

    fun loadMembers(
        applicationContext: Context,
        identity: CollectionLifecycleIdentity,
        accountCollectionHolder: AccountHolder,
        cachedCollection: CachedCollection
    ) {
        asyncTask = viewModelScope.launch {
            val ret = withContext(Dispatchers.IO) {
                if (!identity.validate(applicationContext) || identity.account != accountCollectionHolder.account ||
                    identity.collectionUid != cachedCollection.col.uid || identity.collectionType != cachedCollection.collectionType)
                    return@withContext null
                val result = LinkedList<CollectionMember>()
                val col = cachedCollection.col
                val memberManager = accountCollectionHolder.colMgr.getMemberManager(col)
                var iterator: String? = null
                var done = false
                while (!done) {
                    if (!identity.validate(applicationContext)) return@withContext null
                    val chunk = memberManager.list(FetchOptions().iterator(iterator).limit(30))
                    if (!identity.validate(applicationContext)) return@withContext null
                    iterator = chunk.stoken
                    done = chunk.isDone

                    result.addAll(chunk.data)
                }
                result.map { RuntimeMember(it.username, it.accessLevel) }
            }
            if (ret != null && identity.validate(applicationContext) &&
                identity.account == accountCollectionHolder.account && identity.collectionUid == cachedCollection.col.uid &&
                identity.collectionType == cachedCollection.collectionType)
                members.value = ret
        }
    }

    fun removeMember(
        applicationContext: Context,
        identity: CollectionLifecycleIdentity,
        accountCollectionHolder: AccountHolder,
        cachedCollection: CachedCollection,
        username: String
    ) {
        viewModelScope.launch {
            val removed = withContext(Dispatchers.IO) {
                if (!identity.validate(applicationContext) ||
                    identity.account != accountCollectionHolder.account ||
                    identity.collectionUid != cachedCollection.col.uid ||
                    identity.collectionType != cachedCollection.collectionType)
                    return@withContext false
                val fixture = runtimeFixture(applicationContext, identity)
                if (fixture != null) {
                    memberRemoveOverride?.invoke(applicationContext, identity, username) == true
                } else {
                    val col = cachedCollection.col
                    val memberManager = accountCollectionHolder.colMgr.getMemberManager(col)
                    memberManager.remove(username)
                    identity.validate(applicationContext) && identity.account == accountCollectionHolder.account &&
                        identity.collectionUid == cachedCollection.col.uid && identity.collectionType == cachedCollection.collectionType
                }
            }
            if (removed && identity.validate(applicationContext) &&
                identity.account == accountCollectionHolder.account && identity.collectionUid == cachedCollection.col.uid &&
                identity.collectionType == cachedCollection.collectionType) {
                members.value = members.value.orEmpty().filter { it.username != username }
            }
        }
    }

    fun removeFixtureMember(applicationContext: Context, identity: CollectionLifecycleIdentity, username: String) {
        viewModelScope.launch {
            val membersAfterRemoval = withContext(Dispatchers.IO) {
                if (!identity.validate(applicationContext)) return@withContext null
                if (memberRemoveOverride?.invoke(applicationContext, identity, username) != true) return@withContext null
                // The fixture may change while its operation is in flight. Re-read only
                // after validating the exact account generation before publishing it.
                if (!identity.validate(applicationContext)) return@withContext null
                runtimeFixture(applicationContext, identity)?.members
            }
            if (membersAfterRemoval != null && identity.validate(applicationContext)) {
                members.value = membersAfterRemoval
            }
        }
    }

    fun cancelLoad() {
        asyncTask?.cancel()
    }

    internal fun observe(owner: LifecycleOwner, observer: (List<RuntimeMember>) -> Unit) =
            members.observe(owner, observer)
}

@Volatile
internal var memberRemoveOverride: ((Context, CollectionLifecycleIdentity, String) -> Boolean)? = null
