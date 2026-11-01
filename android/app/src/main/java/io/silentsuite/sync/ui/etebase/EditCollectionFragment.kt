package io.silentsuite.sync.ui.etebase

import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.text.TextUtils
import android.text.Editable
import android.text.TextWatcher
import android.view.*
import android.widget.EditText
import android.widget.Toast
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
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.ProcessIncarnation
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.After
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Answer
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Ended
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Kind
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Next
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Start
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Step
import org.apache.commons.lang3.StringUtils
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
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
        (activity as? BaseActivity?)?.supportActionBar?.setTitle(if (isCreating) createTitleFor(fixture.type) else R.string.edit_collection)
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

    private fun createTitleFor(collectionType: String): Int = when (collectionType) {
        Constants.ETEBASE_TYPE_TASKS -> R.string.create_tasklist
        Constants.ETEBASE_TYPE_ADDRESS_BOOK -> R.string.create_addressbook
        Constants.ETEBASE_TYPE_NOTES -> R.string.create_notebook
        else -> R.string.create_calendar
    }

    fun updateTitle() {
        cachedCollection.let {
            val titleId = if (isCreating) createTitleFor(cachedCollection.collectionType) else R.string.edit_collection
            (activity as? BaseActivity?)?.supportActionBar?.setTitle(titleId)
        }
    }

    private fun initUi(v: View) {
        val title = v.findViewById<EditText>(R.id.display_name)
        val desc = v.findViewById<EditText>(R.id.description)
        title.isSaveEnabled = false
        desc.isSaveEnabled = false

        val meta = cachedCollection.meta
        draft.initialize(meta.name.orEmpty(), meta.description, LocalCalendar.parseColorOrNull(meta.color) ?: LocalCalendar.defaultColor)
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
            Constants.ETEBASE_TYPE_NOTES -> {
                title.setHint(R.string.create_notebook_display_name_hint)

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
        val identity = CollectionLifecycleIdentity.from(arguments)
        if (identity != null && identity.collectionType == Constants.ETEBASE_TYPE_NOTES) {
            askBeforeNotebookDelete(identity)
            return
        }
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
                    // Delete a copy, so a delete that fails leaves the screen's collection as it was for a Save.
                    val onScreen = cachedCollection.col
                    val colMgr = model.value!!.colMgr
                    val col = colMgr.cacheLoad(colMgr.cacheSave(onScreen))
                    val meta = col.meta
                    meta.mtime = System.currentTimeMillis()
                    col.meta = meta
                    col.delete()
                    if (!uploadCollection(identity, applicationContext, col)) return@withContext false
                    // The server has the delete. A screen that outlives this call (after a rotation) keeps
                    // onScreen, so it is marked deleted too and a Save there cannot bring the collection back.
                    onScreen.delete()
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

    // ---- the delete of a Notes notebook, which counts its unsynced Notes changes first ----

    /**
     * Delete for a Notes notebook. Its unsynced Notes changes are counted on IO first, under the loading guard, which
     * is released before a dialog shows. With none, today's question is asked; otherwise their count, with Sync now
     * or Cancel, and then the separate confirmation ([NotebookLeaveOrDeletePolicy]). Other types never come here.
     */
    private fun askBeforeNotebookDelete(identity: CollectionLifecycleIdentity) {
        if (!identity.validate(requireContext())) {
            requireActivity().finish()
            return
        }
        if (loadingModel.isLoading || !notebookLoaded(identity)) return
        loadingModel.setLoading(true)
        val applicationContext = requireContext().applicationContext
        lifecycleScope.launch {
            val now = try {
                withContext(Dispatchers.IO) { NotebookLeaveOrDelete.count(applicationContext, identity) }
            } finally {
                loadingModel.setLoading(false)
            }
            if (!isAdded) return@launch
            when (val start = NotebookLeaveOrDeletePolicy.start(now)) {
                Start.Plain -> showNotebookStep(identity, Step.PLAIN, UnsyncedNotes.NOTHING)
                is Start.ShowCount -> showNotebookStep(identity, Step.COUNT, start.shown)
            }
        }
    }

    /** Whether this screen's account and collection are loaded, and are the ones [identity] names. */
    private fun notebookLoaded(identity: CollectionLifecycleIdentity): Boolean {
        val collection = collectionModel.value ?: return false
        return identity.account == model.value?.account && identity.collectionType == collection.collectionType &&
            identity.collectionUid == collection.col.uid
    }

    private fun showNotebookStep(
        identity: CollectionLifecycleIdentity,
        step: Step,
        shown: UnsyncedNotes,
        failure: String? = null,
        kept: Boolean = false,
    ) = NotebookLeaveOrDeleteDialogFragment.show(this, identity, Kind.DELETE, step, shown, failure, kept)

    /**
     * Every answer of the notebook dialogs arrives here, and one for another notebook does nothing. The one more
     * question needs only the notebook; any other answer is taken only while this screen's account and collection are
     * loaded and are the ones the dialog was shown for, which after a restart they may not be yet: otherwise it is
     * dropped, and the user taps again. [shownIn] is the token of the app process that made the dialog
     * ([ProcessIncarnation]): an answer from a dialog that Android restored in a new process, or from one with no
     * token, counts the notebook again and asks again, and never syncs, confirms, goes on or discards.
     */
    internal fun onNotebookAnswer(
        identity: CollectionLifecycleIdentity,
        step: Step,
        answer: Answer,
        shown: UnsyncedNotes,
        shownIn: String?,
    ) {
        if (identity != CollectionLifecycleIdentity.from(arguments)) return
        // A dialog made in another app process, as one Android restores after the process ended, or one with no
        // token: whatever its answer, the notebook is counted again and asked again.
        val fromThisProcess = ProcessIncarnation.isCurrent(shownIn)
        if (step == Step.AGAIN) {
            answerAgain(identity, answer, shown, fromThisProcess)
            return
        }
        if (!identity.validate(requireContext())) {
            requireActivity().finish()
            return
        }
        if (!notebookLoaded(identity)) return
        when (val next = NotebookLeaveOrDeletePolicy.answered(answer, shown, fromThisProcess)) {
            Next.SyncNotes -> syncNotebookNow(identity)
            is Next.ShowDiscard -> showNotebookStep(identity, Step.DISCARD, next.shown)
            is Next.Proceed -> deleteNotebook(identity, next.shown)
            Next.Close -> activity?.finish()
            // Counted again on IO, and today's question or the count shown again, in a dialog made in this process.
            Next.CountAgain -> askBeforeNotebookDelete(identity)
        }
    }

    /**
     * The delete of a Notes notebook once [shown] was confirmed, or today's question answered with nothing unsynced,
     * on IO in the order of [NotebookLeaveOrDelete.remove]. The server call deletes a copy of the collection, so a call
     * that fails leaves this screen's collection as it was, and a Save cannot delete it without a count. Once the call
     * went through, the screen's own collection is marked deleted as well, so a Save cannot bring the notebook back.
     * The discard comes after that, and before the Notes run that requestSync starts. The result is posted from inside
     * the IO block, so it can show after the screen is gone too.
     */
    private fun deleteNotebook(identity: CollectionLifecycleIdentity, shown: UnsyncedNotes) {
        if (!identity.validate(requireContext())) {
            requireActivity().finish()
            return
        }
        if (loadingModel.isLoading) return
        loadingModel.setLoading(true)
        val applicationContext = requireContext().applicationContext
        var askAgain: UnsyncedNotes? = null
        // Read on IO right before the server call: while a clear or a discard of the store has stopped in this
        // process, a failure of the call does not say that nothing was deleted.
        var stoppedBefore = false
        lifecycleScope.launch {
            try {
                val after = withContext(Dispatchers.IO) {
                    val ended = NotebookLeaveOrDelete.remove(shown,
                        validate = { identity.validate(applicationContext) },
                        count = { NotebookLeaveOrDelete.count(applicationContext, identity) },
                        running = { NotebookLeaveOrDelete.running(identity) },
                        cancel = { NotebookLeaveOrDelete.cancel(identity) },
                        server = {
                            stoppedBefore = NotebookLeaveOrDelete.stopped(applicationContext, identity)
                            val colMgr = model.value!!.colMgr
                            val col = colMgr.cacheLoad(colMgr.cacheSave(cachedCollection.col))
                            val meta = col.meta
                            meta.mtime = System.currentTimeMillis()
                            col.meta = meta
                            col.delete()
                            val uploaded = uploadCollection(identity, applicationContext, col)
                            // Once the server has the delete, the screen's own collection is marked deleted too, and
                            // never uploaded: a screen this block outlives, after a rotation or Back, keeps it deleted
                            // on a Save.
                            if (uploaded) cachedCollection.col.delete()
                            uploaded
                        },
                        discard = { NotebookLeaveOrDelete.discard(applicationContext, identity, it) })
                    // As before, once the server call went through.
                    val removed = ended is Ended.Removed || ended is Ended.DiscardFailed
                    if (removed && identity.validate(applicationContext)) {
                        requestSync(applicationContext, model.value!!.account)
                    }
                    NotebookLeaveOrDeletePolicy.after(ended, askedAgain = false).also {
                        if (it is After.Say) NotebookLeaveOrDelete.postResult(applicationContext, it.text)
                        if (it is After.AskAgainAfter) askAgain = it.now
                    }
                }
                when (after) {
                    is After.ShowCount -> showNotebookStep(identity, Step.COUNT, after.now)
                    is After.AskAgainAfter -> if (!showNotebookStep(identity, Step.AGAIN, after.now)) {
                        NotebookLeaveOrDelete.postResult(applicationContext, R.string.notes_notebook_kept_changed)
                        activity?.finish()
                    }
                    After.Quiet, is After.Say -> activity?.finish()
                }
            } catch (e: CancellationException) {
                // The block ran to its end and this screen is gone, though after a rotation the activity shows a new
                // one, so the one more question cannot be asked.
                if (askAgain != null) {
                    NotebookLeaveOrDelete.postResult(applicationContext, R.string.notes_notebook_kept_changed)
                }
                throw e
            } catch (e: EtebaseException) {
                Logger.log.warning("Notebook delete failed: ${e.javaClass.name}")
                NotebookLeaveOrDeleteDialogFragment.failed(this@EditCollectionFragment, applicationContext, identity,
                    Kind.DELETE, e.localizedMessage, kept = shown.anything, stopped = stoppedBefore)
            } finally {
                loadingModel.setLoading(false)
            }
        }
    }

    /**
     * The answer to the one more question, after the delete went through: either button closes the screen. One from a
     * dialog made in another app process discards nothing, and the notebook is counted again ([askAgainOnceMore]).
     */
    private fun answerAgain(
        identity: CollectionLifecycleIdentity,
        answer: Answer,
        now: UnsyncedNotes,
        fromThisProcess: Boolean,
    ) {
        val next = NotebookLeaveOrDeletePolicy.answered(answer, now, fromThisProcess)
        if (next == Next.CountAgain) {
            askAgainOnceMore(identity)
            return
        }
        if (next !is Next.Proceed) {
            activity?.finish()
            return
        }
        loadingModel.setLoading(true)
        val applicationContext = requireContext().applicationContext
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val ended = NotebookLeaveOrDelete.again(now, validate = { identity.validate(applicationContext) },
                        discard = { NotebookLeaveOrDelete.discard(applicationContext, identity, it) })
                    val after = NotebookLeaveOrDeletePolicy.after(ended, askedAgain = true)
                    if (after is After.Say) NotebookLeaveOrDelete.postResult(applicationContext, after.text)
                }
            } finally {
                loadingModel.setLoading(false)
                activity?.finish()
            }
        }
    }

    /**
     * The one more question answered in a dialog made in another app process, after the delete went through: nothing is
     * discarded. The notebook is counted again on IO, and the question is asked again for what it holds now, in a
     * dialog made in this process, while the store lists. Otherwise the screen closes, and says that nothing was
     * deleted when anything is there.
     */
    private fun askAgainOnceMore(identity: CollectionLifecycleIdentity) {
        if (!identity.validate(requireContext())) {
            requireActivity().finish()
            return
        }
        if (loadingModel.isLoading) return
        loadingModel.setLoading(true)
        val applicationContext = requireContext().applicationContext
        lifecycleScope.launch {
            val now = try {
                withContext(Dispatchers.IO) { NotebookLeaveOrDelete.count(applicationContext, identity) }
            } finally {
                loadingModel.setLoading(false)
            }
            if (now.anything && now.listed && showNotebookStep(identity, Step.AGAIN, now)) return@launch
            if (now.anything) {
                NotebookLeaveOrDelete.postResult(applicationContext, R.string.notes_notebook_nothing_deleted)
            }
            activity?.finish()
        }
    }

    private fun syncNotebookNow(identity: CollectionLifecycleIdentity) {
        when (NotebookLeaveOrDelete.syncNotesNow(requireContext(), identity)) {
            NotebookLeaveOrDelete.SyncAsked.ASKED ->
                Toast.makeText(requireContext(), R.string.notes_notebook_sync_asked, Toast.LENGTH_LONG).show()
            NotebookLeaveOrDelete.SyncAsked.NOTES_OFF ->
                Toast.makeText(requireContext(), R.string.notes_sync_now_notes_off, Toast.LENGTH_LONG).show()
            NotebookLeaveOrDelete.SyncAsked.NOT_ASKED -> Unit
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
                Constants.ETEBASE_TYPE_CALENDAR, Constants.ETEBASE_TYPE_TASKS, Constants.ETEBASE_TYPE_NOTES -> {
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
