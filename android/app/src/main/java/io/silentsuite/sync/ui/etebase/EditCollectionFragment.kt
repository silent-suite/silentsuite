package io.silentsuite.sync.ui.etebase

import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.text.TextUtils
import android.text.Editable
import android.text.TextWatcher
import android.view.*
import android.widget.EditText
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.fragment.app.viewModels
import androidx.lifecycle.ViewModel
import androidx.fragment.app.commit
import com.etebase.client.Collection
import com.etebase.client.exceptions.EtebaseException
import io.silentsuite.sync.CachedCollection
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.ui.BaseActivity
import org.apache.commons.lang3.StringUtils
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import yuku.ambilwarna.AmbilWarnaDialog

class EditCollectionFragment : Fragment() {
    private val model: AccountViewModel by activityViewModels()
    private val collectionModel: CollectionViewModel by activityViewModels()
    private val itemsModel: ItemsViewModel by activityViewModels()
    private val loadingModel: LoadingViewModel by activityViewModels()
    private val draft: CollectionDraftViewModel by viewModels()

    private var isCreating: Boolean = false

    private val cachedCollection: CachedCollection
        get() = requireNotNull(collectionModel.value) { "Collection is not loaded" }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val identity = CollectionLifecycleIdentity.from(arguments)
        if (identity == null || !identity.validate(requireContext()) ||
            (identity.collectionUid == null) != requireArguments().getBoolean(ARG_IS_CREATING)) {
            requireActivity().finish()
            return
        }
        isCreating = requireArguments().getBoolean(ARG_IS_CREATING)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val ret = inflater.inflate(R.layout.activity_create_collection, container, false)
        setHasOptionsMenu(true)

        return ret
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        runtimeFixture(requireContext(), requireNotNull(CollectionLifecycleIdentity.from(arguments)))?.let {
            initFixtureUi(view, it)
            return
        }
        collectionModel.observe(viewLifecycleOwner) { collection ->
            val identity = CollectionLifecycleIdentity.from(arguments)
            if (identity == null || identity.account != model.value?.account || identity.collectionType != collection.collectionType ||
                (identity.collectionUid != null && identity.collectionUid != collection.col.uid)) {
                requireActivity().finish()
                return@observe
            }
            updateTitle()
            initUi(view)
        }
    }

    private fun initFixtureUi(v: View, fixture: RuntimeCollectionFixture) {
        (activity as? BaseActivity?)?.supportActionBar?.setTitle(if (isCreating) R.string.create_calendar else R.string.edit_collection)
        val title = v.findViewById<EditText>(R.id.display_name)
        val desc = v.findViewById<EditText>(R.id.description)
        title.isSaveEnabled = false
        desc.isSaveEnabled = false
        draft.initialize(fixture.name, fixture.description, fixture.color)
        title.setText(draft.name)
        desc.setText(draft.description)
        title.addTextChangedListener(DraftWatcher { draft.name = it })
        desc.addTextChangedListener(DraftWatcher { draft.description = it })
        val color = v.findViewById<View>(R.id.color)
        if (fixture.type == Constants.ETEBASE_TYPE_ADDRESS_BOOK) v.findViewById<View>(R.id.color_group).visibility = View.GONE
        else color.setBackgroundColor(draft.color)
    }

    fun updateTitle() {
        cachedCollection.let {
            var titleId: Int = R.string.create_calendar
            if (isCreating) {
                when (cachedCollection.collectionType) {
                    Constants.ETEBASE_TYPE_CALENDAR -> {
                        titleId = R.string.create_calendar
                    }
                    Constants.ETEBASE_TYPE_TASKS -> {
                        titleId = R.string.create_tasklist
                    }
                    Constants.ETEBASE_TYPE_ADDRESS_BOOK -> {
                        titleId = R.string.create_addressbook
                    }
                }
            } else {
                titleId = R.string.edit_collection
            }
            (activity as? BaseActivity?)?.supportActionBar?.setTitle(titleId)
        }
    }

    private fun initUi(v: View) {
        val title = v.findViewById<EditText>(R.id.display_name)
        val desc = v.findViewById<EditText>(R.id.description)
        title.isSaveEnabled = false
        desc.isSaveEnabled = false

        val meta = cachedCollection.meta
        draft.initialize(meta.name.orEmpty(), meta.description, LocalCalendar.parseColor(meta.color))
        title.setText(draft.name)
        desc.setText(draft.description)
        title.addTextChangedListener(DraftWatcher { draft.name = it })
        desc.addTextChangedListener(DraftWatcher { draft.description = it })

        val colorSquare = v.findViewById<View>(R.id.color)
        when (cachedCollection.collectionType) {
            Constants.ETEBASE_TYPE_CALENDAR -> {
                title.setHint(R.string.create_calendar_display_name_hint)

                val color = draft.color
                colorSquare.setBackgroundColor(color)
                colorSquare.setOnClickListener {
                    AmbilWarnaDialog(context, (colorSquare.background as ColorDrawable).color, true, object : AmbilWarnaDialog.OnAmbilWarnaListener {
                        override fun onCancel(dialog: AmbilWarnaDialog) {}

                        override fun onOk(dialog: AmbilWarnaDialog, color: Int) {
                            colorSquare.setBackgroundColor(color)
                            draft.color = color
                        }
                    }).show()
                }
            }
            Constants.ETEBASE_TYPE_TASKS -> {
                title.setHint(R.string.create_tasklist_display_name_hint)

                val color = draft.color
                colorSquare.setBackgroundColor(color)
                colorSquare.setOnClickListener {
                    AmbilWarnaDialog(context, (colorSquare.background as ColorDrawable).color, true, object : AmbilWarnaDialog.OnAmbilWarnaListener {
                        override fun onCancel(dialog: AmbilWarnaDialog) {}

                        override fun onOk(dialog: AmbilWarnaDialog, color: Int) {
                            colorSquare.setBackgroundColor(color)
                            draft.color = color
                        }
                    }).show()
                }
            }
            Constants.ETEBASE_TYPE_ADDRESS_BOOK -> {
                title.setHint(R.string.create_addressbook_display_name_hint)

                val colorGroup = v.findViewById<View>(R.id.color_group)
                colorGroup.visibility = View.GONE
            }
        }
    }

    override fun onCreateOptionsMenu(menu: Menu, inflater: MenuInflater) {
        super.onCreateOptionsMenu(menu, inflater)
        inflater.inflate(R.menu.fragment_edit_collection, menu)
        if (isCreating) {
            menu.findItem(R.id.on_delete).setVisible(false)
        }
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.on_delete -> {
                deleteColection()
            }
            R.id.on_save -> {
                saveCollection()
            }
        }
        return super.onOptionsItemSelected(item)
    }

    private fun deleteColection() {
        val meta = cachedCollection.meta
        val name = meta.name

        MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.delete_collection_confirm_title)
                .setMessage(getString(R.string.delete_collection_confirm_warning, name))
                .setPositiveButton(android.R.string.yes) { dialog, _ ->
                    doDeleteCollection()
                    dialog.dismiss()
                }
                .setNegativeButton(android.R.string.no) { _, _ -> }
                .show()
    }

    private fun doDeleteCollection() {
        val identity = requireNotNull(CollectionLifecycleIdentity.from(arguments))
        if (!identity.validate(requireContext())) {
            requireActivity().finish()
            return
        }
        if (loadingModel.isLoading) return
        loadingModel.setLoading(true)
        val applicationContext = requireContext().applicationContext
        lifecycleScope.launch {
            try {
                val deleted = withContext(Dispatchers.IO) {
                    if (!identity.validate(applicationContext)) return@withContext false
                    val col = cachedCollection.col
                    val meta = col.meta
                    meta.mtime = System.currentTimeMillis()
                    col.meta = meta
                    col.delete()
                    if (!uploadCollection(identity, applicationContext, col)) return@withContext false
                    if (!identity.validate(applicationContext)) return@withContext false
                    requestSync(applicationContext, model.value!!.account)
                    true
                }
                if (!deleted) {
                    activity?.finish()
                    return@launch
                }
                activity?.finish()
            } catch (e: EtebaseException) {
                Logger.log.warning("Collection edit failed: ${e.javaClass.name}")
                context?.let { context ->
                    MaterialAlertDialogBuilder(context)
                            .setIcon(R.drawable.ic_info_dark)
                            .setTitle(R.string.exception)
                            .setMessage(e.localizedMessage)
                            .setPositiveButton(android.R.string.yes) { _, _ -> }.show()
                }
            } finally {
                loadingModel.setLoading(false)
            }
        }
    }

    private fun saveCollection() {
        val identity = requireNotNull(CollectionLifecycleIdentity.from(arguments))
        if (!identity.validate(requireContext())) {
            requireActivity().finish()
            return
        }
        if (loadingModel.isLoading) return
        if (runtimeFixture(requireContext(), identity) != null) {
            saveFixtureCollection(identity)
            return
        }
        var ok = true

        val meta = cachedCollection.meta
        val v = requireView()

        var edit = v.findViewById<EditText>(R.id.display_name)
        meta.name = edit.text.toString()
        if (TextUtils.isEmpty(meta.name)) {
            edit.error = getString(R.string.create_collection_display_name_required)
            ok = false
        }

        edit = v.findViewById<EditText>(R.id.description)
        meta.description = StringUtils.trimToNull(edit.text.toString())

        meta.mtime = System.currentTimeMillis()

        if (ok) {
            when (cachedCollection.collectionType) {
                Constants.ETEBASE_TYPE_CALENDAR, Constants.ETEBASE_TYPE_TASKS -> {
                    val view = v.findViewById<View>(R.id.color)
                    val color = (view.background as ColorDrawable).color
                    meta.color = String.format("#%06X", 0xFFFFFF and color)
                }
                Constants.ETEBASE_TYPE_ADDRESS_BOOK -> {
                }
            }

            loadingModel.setLoading(true)
            val applicationContext = requireContext().applicationContext
            lifecycleScope.launch {
                try {
                    val colUid = withContext(Dispatchers.IO) {
                        if (!identity.validate(applicationContext)) return@withContext null
                        val col = cachedCollection.col
                        col.meta = meta
                        if (!uploadCollection(identity, applicationContext, col)) return@withContext null
                        if (!identity.validate(applicationContext)) return@withContext null
                        requestSync(applicationContext, model.value!!.account)
                        col.uid
                    }
                    if (colUid == null) {
                        activity?.finish()
                        return@launch
                    }
                    collectionModel.loadCollection(applicationContext, identity.account, identity.creationId, model.value!!, colUid)
                    if (isCreating) {
                        // Load the items since we just created it
                        itemsModel.loadItems(applicationContext, identity.account, identity.creationId, colUid, model.value!!, cachedCollection)
                        parentFragmentManager.commit {
                            val identity = CollectionLifecycleIdentity.existing(
                                model.value!!.account,
                                identity.creationId,
                                colUid,
                                cachedCollection.collectionType
                            )
                            replace(R.id.fragment_container, ViewCollectionFragment.newInstance(identity))
                        }
                    } else {
                        parentFragmentManager.popBackStack()
                    }
                } catch (e: EtebaseException) {
                    val context = context
                    if (context != null) {
                        MaterialAlertDialogBuilder(requireContext())
                                .setIcon(R.drawable.ic_info_dark)
                                .setTitle(R.string.exception)
                                .setMessage(e.localizedMessage)
                                .setPositiveButton(android.R.string.yes) { _, _ -> }.show()
                    }
                } finally {
                    loadingModel.setLoading(false)
                }
            }
        }
    }

    private fun saveFixtureCollection(identity: CollectionLifecycleIdentity) {
        val view = requireView()
        val name = view.findViewById<EditText>(R.id.display_name).text.toString()
        if (name.isEmpty()) {
            view.findViewById<EditText>(R.id.display_name).error = getString(R.string.create_collection_display_name_required)
            return
        }
        val description = StringUtils.trimToNull(view.findViewById<EditText>(R.id.description).text.toString())
        val color = view.findViewById<View>(R.id.color).let { (it.background as? ColorDrawable)?.color ?: draft.color }
        loadingModel.setLoading(true)
        val applicationContext = requireContext().applicationContext
        lifecycleScope.launch {
            try {
                val uid = withContext(Dispatchers.IO) {
                    if (!identity.validate(applicationContext)) null else collectionMutationOverride?.invoke(
                        applicationContext, identity, RuntimeCollectionMutation(name, description, color, isCreating))
                }
                if (uid == null || !identity.validate(applicationContext)) { activity?.finish(); return@launch }
                val destination = CollectionLifecycleIdentity.existing(identity.account, identity.creationId, uid, identity.collectionType)
                if (isCreating) parentFragmentManager.commit {
                    replace(R.id.fragment_container, ViewCollectionFragment.newInstance(destination))
                } else parentFragmentManager.popBackStack()
            } finally {
                loadingModel.setLoading(false)
            }
        }
    }

    /** Revalidate immediately before the remote upload and local-cache mutation. */
    private fun uploadCollection(
        identity: CollectionLifecycleIdentity,
        applicationContext: android.content.Context,
        col: Collection
    ): Boolean {
        if (!identity.validate(applicationContext)) return false
        val accountHolder = model.value!!
        if (identity.account != accountHolder.account) return false
        val etebaseLocalCache = accountHolder.etebaseLocalCache
        val colMgr = accountHolder.colMgr
        colMgr.upload(col)
        if (!identity.validate(applicationContext)) return false
        synchronized(etebaseLocalCache) {
            etebaseLocalCache.collectionSet(colMgr, col)
        }
        return true
    }

    companion object {
        private const val ARG_IS_CREATING = "collection.edit.isCreating"

        fun newInstance(identity: CollectionLifecycleIdentity, isCreating: Boolean = false) =
            EditCollectionFragment().apply {
                arguments = identity.toBundle().apply { putBoolean(ARG_IS_CREATING, isCreating) }
            }
    }
}

class CollectionDraftViewModel : ViewModel() {
    var name = ""
    var description: String? = null
    var color = 0
    private var initialized = false

    fun initialize(name: String, description: String?, color: Int) {
        if (initialized) return
        initialized = true
        this.name = name
        this.description = description
        this.color = color
    }
}

private class DraftWatcher(private val changed: (String) -> Unit) : TextWatcher {
    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = changed(s?.toString().orEmpty())
    override fun afterTextChanged(s: Editable?) = Unit
}
