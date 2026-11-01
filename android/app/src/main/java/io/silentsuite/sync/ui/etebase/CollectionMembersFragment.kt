package io.silentsuite.sync.ui.etebase

import android.app.Dialog
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.ViewModel
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.Utils
import com.etebase.client.exceptions.EtebaseException
import com.etebase.client.exceptions.NotFoundException
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
import io.silentsuite.sync.utils.ProgressDialogHelper
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

class CollectionMembersFragment : Fragment() {
    private val model: AccountViewModel by activityViewModels()
    private val collectionModel: CollectionViewModel by activityViewModels()
    private val loadingModel: LoadingViewModel by activityViewModels()
    private val memberActions: MemberActionViewModel by activityViewModels()
    private var isAdmin: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val identity = CollectionLifecycleIdentity.from(arguments)
        if (identity?.collectionUid == null || !identity.validate(requireContext())) {
            requireActivity().finish()
            return
        }
        isAdmin = requireArguments().getBoolean(ARG_IS_ADMIN)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val ret = if (isAdmin) {
            inflater.inflate(R.layout.etebase_view_collection_members, container, false)
        } else {
            inflater.inflate(R.layout.etebase_view_collection_members_no_access, container, false)
        }

        return ret
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        runtimeFixture(requireContext(), requireNotNull(CollectionLifecycleIdentity.from(arguments)))?.let { fixture ->
            (activity as? BaseActivity?)?.supportActionBar?.setTitle(R.string.collection_members_title)
            initFixtureUi(view, fixture)
            return
        }
        collectionModel.observe(viewLifecycleOwner) {
            val identity = CollectionLifecycleIdentity.from(arguments)
            if (identity == null || identity.account != model.value?.account ||
                identity.collectionUid != it.col.uid || identity.collectionType != it.collectionType ||
                isAdmin != (it.col.accessLevel == CollectionAccessLevel.Admin)) {
                requireActivity().finish()
                return@observe
            }
            (activity as? BaseActivity?)?.supportActionBar?.setTitle(R.string.collection_members_title)
            initUi(view, it)
        }
    }

    private fun initFixtureUi(v: View, fixture: RuntimeCollectionFixture) {
        v.findViewById<View>(R.id.color).apply {
            visibility = if (fixture.type == Constants.ETEBASE_TYPE_ADDRESS_BOOK) View.GONE else View.VISIBLE
            setBackgroundColor(fixture.color)
        }
        v.findViewById<TextView>(R.id.display_name).text = fixture.name
        v.findViewById<TextView>(R.id.description).text = fixture.description
        v.findViewById<View>(R.id.progressBar).visibility = View.GONE
    }

    private fun initUi(v: View, cachedCollection: CachedCollection) {
        val meta = cachedCollection.meta
        val collectionType = cachedCollection.collectionType
        val colorSquare = v.findViewById<View>(R.id.color)
        val color = LocalCalendar.parseColorOrNull(meta.color) ?: LocalCalendar.defaultColor
        when (collectionType) {
            Constants.ETEBASE_TYPE_CALENDAR -> {
                colorSquare.setBackgroundColor(color)
            }
            Constants.ETEBASE_TYPE_TASKS -> {
                colorSquare.setBackgroundColor(color)
            }
            Constants.ETEBASE_TYPE_ADDRESS_BOOK -> {
                colorSquare.visibility = View.GONE
            }
            Constants.ETEBASE_TYPE_NOTES -> {
                colorSquare.setBackgroundColor(color)
            }
        }

        val title = v.findViewById<View>(R.id.display_name) as TextView
        title.text = meta.name

        val desc = v.findViewById<View>(R.id.description) as TextView
        desc.text = meta.description

        if (isAdmin) {
            v.findViewById<View>(R.id.add_member).setOnClickListener {
                addMemberClicked()
            }
        } else {
            v.findViewById<Button>(R.id.leave).setOnClickListener {
                val identity = CollectionLifecycleIdentity.from(arguments)
                if (identity != null && identity.collectionType == Constants.ETEBASE_TYPE_NOTES) {
                    askBeforeNotebookLeave(identity, leavesWhenNothing = true)
                    return@setOnClickListener
                }
                if (identity == null || !identity.validate(requireContext())) {
                    requireActivity().finish()
                    return@setOnClickListener
                }
                if (loadingModel.isLoading) return@setOnClickListener
                loadingModel.setLoading(true)
                val applicationContext = requireContext().applicationContext
                lifecycleScope.launch {
                    try {
                        val left = withContext(Dispatchers.IO) {
                            if (!identity.validate(applicationContext)) return@withContext false
                            val membersManager = model.value!!.colMgr.getMemberManager(cachedCollection.col)
                            membersManager.leave()
                            if (!identity.validate(applicationContext)) return@withContext false
                            requestSync(applicationContext, model.value!!.account)
                            true
                        }
                        if (!left) {
                            activity?.finish()
                            return@launch
                        }
                        activity?.finish()
                    } finally {
                        loadingModel.setLoading(false)
                    }
                }
            }
        }

        v.findViewById<View>(R.id.progressBar).visibility = View.GONE
    }

    // ---- the leave of a Notes notebook, which counts its unsynced Notes changes first ----

    /**
     * Leave for a Notes notebook. Its unsynced Notes changes are counted on IO first, under the loading guard, which
     * is released before a dialog shows. With none, the notebook is left at once, as before, when [leavesWhenNothing];
     * for an answer counted again, from a dialog made in another app process, it is not, and the user taps again.
     * Otherwise their count is shown, with Sync now or Cancel, and then the separate confirmation
     * ([NotebookLeaveOrDeletePolicy]). Other types never come here.
     */
    private fun askBeforeNotebookLeave(identity: CollectionLifecycleIdentity, leavesWhenNothing: Boolean) {
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
                Start.Plain -> if (leavesWhenNothing) leaveNotebook(identity, UnsyncedNotes.NOTHING)
                is Start.ShowCount -> showNotebookStep(identity, Step.COUNT, start.shown)
            }
        }
    }

    /** Whether this screen's account and collection are loaded, and are the ones [identity] names. */
    private fun notebookLoaded(identity: CollectionLifecycleIdentity): Boolean {
        val collection = collectionModel.value ?: return false
        return identity.account == model.value?.account && identity.collectionUid == collection.col.uid &&
            identity.collectionType == collection.collectionType &&
            isAdmin == (collection.col.accessLevel == CollectionAccessLevel.Admin)
    }

    private fun showNotebookStep(identity: CollectionLifecycleIdentity, step: Step, shown: UnsyncedNotes) =
        NotebookLeaveOrDeleteDialogFragment.show(this, identity, Kind.LEAVE, step, shown)

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
            is Next.Proceed -> leaveNotebook(identity, next.shown)
            Next.Close -> activity?.finish()
            // Counted again on IO, and the count shown again, in a dialog made in this process; with nothing unsynced,
            // no leave begins.
            Next.CountAgain -> askBeforeNotebookLeave(identity, leavesWhenNothing = false)
        }
    }

    /**
     * The leave of a Notes notebook once [shown] was confirmed, or at once with nothing unsynced, on IO in the order of
     * [NotebookLeaveOrDelete.remove]. The discard comes once the server removed the membership, and before the Notes
     * run that requestSync starts. The result is posted from inside the IO block, so it can show after the screen is
     * gone too. A leave that fails shows its error, and the screen stays; for other types a leave has no such catch.
     */
    private fun leaveNotebook(identity: CollectionLifecycleIdentity, shown: UnsyncedNotes) {
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
                            val membersManager = model.value!!.colMgr.getMemberManager(collectionModel.value!!.col)
                            membersManager.leave()
                            true
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
                // For a Notes notebook only, until the maintainer decides on a catch for every type.
                Logger.log.warning("Notebook leave failed: ${e.javaClass.name}")
                NotebookLeaveOrDeleteDialogFragment.failed(this@CollectionMembersFragment, applicationContext,
                    identity, Kind.LEAVE, e.localizedMessage, kept = shown.anything, stopped = stoppedBefore)
            } finally {
                loadingModel.setLoading(false)
            }
        }
    }

    /**
     * The answer to the one more question, after the leave went through: either button closes the screen. One from a
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
     * The one more question answered in a dialog made in another app process, after the leave went through: nothing is
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

    private fun addMemberClicked() {
        val view = View.inflate(requireContext(), R.layout.add_member_fragment, null)
        view.findViewById<EditText>(R.id.username).isSaveEnabled = false
        val dialog = MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.collection_members_add)
                .setIcon(R.drawable.ic_account_add_dark)
                .setPositiveButton(android.R.string.yes) { _, _ ->
                    val identity = CollectionLifecycleIdentity.from(arguments)
                    if (identity == null || !identity.validate(requireContext())) {
                        requireActivity().finish()
                        return@setPositiveButton
                    }
                    val username = view.findViewById<EditText>(R.id.username).text.toString()
                    val readOnly = view.findViewById<CheckBox>(R.id.read_only).isChecked

                    val frag = AddMemberFragment.newInstance(
                        identity,
                        memberActions.put(username, if (readOnly) CollectionAccessLevel.ReadOnly else CollectionAccessLevel.ReadWrite)
                    )
                    frag.show(childFragmentManager, null)
                }
                .setNegativeButton(android.R.string.no) { _, _ -> }
        dialog.setView(view)
        dialog.show()
    }

    companion object {
        private const val ARG_IS_ADMIN = "collection.members.isAdmin"

        fun newInstance(identity: CollectionLifecycleIdentity, isAdmin: Boolean) = CollectionMembersFragment().apply {
            arguments = identity.toBundle().apply { putBoolean(ARG_IS_ADMIN, isAdmin) }
        }
    }
}

class AddMemberFragment : DialogFragment() {
    private val accountModel: AccountViewModel by activityViewModels()
    private val collectionModel: CollectionViewModel by activityViewModels()
    private val loadingModel: LoadingViewModel by activityViewModels()
    private val memberActions: MemberActionViewModel by activityViewModels()
    private var username = ""
    private var accessLevel = CollectionAccessLevel.ReadOnly
    private var actionAvailable = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val identity = CollectionLifecycleIdentity.from(arguments)
        val token = arguments?.getString(ARG_ACTION_TOKEN)
        val action = token?.let(memberActions::get)
        if (identity?.collectionUid == null || !identity.validate(requireContext()) || action == null) {
            token?.let(memberActions::remove)
            dismissAllowingStateLoss()
            return
        }
        username = action.username
        accessLevel = action.accessLevel
        actionAvailable = true
    }

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        isCancelable = false
        val progress = ProgressDialogHelper.createIndeterminate(
            requireContext(),
            R.string.collection_members_adding,
            getString(R.string.please_wait)
        )
        if (!actionAvailable) {
            progress.setOnShowListener { dismissAllowingStateLoss() }
            return progress
        }

        lifecycleScope.launch {
            val identity = CollectionLifecycleIdentity.from(arguments)
            val accountHolder = accountModel.value
            val cachedCollection = collectionModel.value
            if (identity == null || !identity.validate(requireContext()) ||
                accountHolder == null || cachedCollection == null ||
                identity.account != accountHolder.account || identity.collectionUid != cachedCollection.col.uid ||
                identity.collectionType != cachedCollection.collectionType) {
                clearAction()
                dismissAllowingStateLoss()
                return@launch
            }
            val invitationManager = accountHolder.etebase.invitationManager
            try {
                val applicationContext = requireContext().applicationContext
                val profile = withContext(Dispatchers.IO) {
                    if (!identity.validate(applicationContext)) return@withContext null
                    invitationManager.fetchUserProfile(username)
                }
                if (profile == null) {
                    clearAction()
                    activity?.finish()
                    return@launch
                }
                val fingerprint = Utils.prettyFingerprint(profile.pubkey)
                val view = LayoutInflater.from(context).inflate(R.layout.fingerprint_alertdialog, null)
                (view.findViewById<View>(R.id.body) as TextView).text = getString(R.string.trust_fingerprint_body, username)
                (view.findViewById<View>(R.id.fingerprint) as TextView).text = fingerprint
                MaterialAlertDialogBuilder(requireContext())
                        .setIcon(R.drawable.ic_fingerprint_dark)
                        .setTitle(R.string.trust_fingerprint_title)
                        .setView(view)
                        .setPositiveButton(android.R.string.ok) { _, _ ->
                            if (!identity.validate(requireContext())) {
                                clearAction()
                                requireActivity().finish()
                                return@setPositiveButton
                            }
                            if (loadingModel.isLoading) return@setPositiveButton
                            loadingModel.setLoading(true)
                            val applicationContext = requireContext().applicationContext
                            lifecycleScope.launch {
                                try {
                                    val invited = withContext(Dispatchers.IO) {
                                        if (!identity.validate(applicationContext)) return@withContext false
                                        invitationManager.invite(cachedCollection.col, username, profile.pubkey, accessLevel)
                                        true
                                    }
                                    if (!invited) {
                                        clearAction()
                                        activity?.finish()
                                        return@launch
                                    }
                                    MaterialAlertDialogBuilder(requireContext())
                                        .setTitle(R.string.collection_members_add)
                                        .setIcon(R.drawable.ic_account_add_dark)
                                        .setMessage(R.string.collection_members_add_success)
                                        .setPositiveButton(android.R.string.yes) { _, _ -> }
                                        .show()
                                    dismiss()
                                    clearAction()
                                } catch (e: EtebaseException) {
                                    handleError(e.localizedMessage)
                                } finally {
                                    loadingModel.setLoading(false)
                                }
                            }
                        }
                        .setNegativeButton(android.R.string.cancel) { _, _ ->
                            clearAction()
                            dismiss()
                        }.show()
            } catch (e: NotFoundException) {
                handleError(getString(R.string.collection_members_error_user_not_found, username))
            } catch (e: EtebaseException) {
                handleError(e.localizedMessage)
            }
        }

        return progress
    }

    private fun handleError(message: String) {
        MaterialAlertDialogBuilder(requireContext())
                .setIcon(R.drawable.ic_error_dark)
                .setTitle(R.string.collection_members_add_error)
                .setMessage(message)
                .setPositiveButton(android.R.string.yes) { _, _ -> }.show()
        clearAction()
        dismiss()
    }

    private fun clearAction() {
        arguments?.getString(ARG_ACTION_TOKEN)?.let(memberActions::remove)
        actionAvailable = false
    }

    companion object {
        private const val ARG_ACTION_TOKEN = "collection.members.actionToken"

        fun newInstance(identity: CollectionLifecycleIdentity, actionToken: String) =
            AddMemberFragment().apply {
                arguments = identity.toBundle().apply {
                    putString(ARG_ACTION_TOKEN, actionToken)
                }
            }
    }
}

class MemberActionViewModel : ViewModel() {
    data class Action(val username: String, val accessLevel: CollectionAccessLevel)
    private val actions = mutableMapOf<String, Action>()

    fun put(username: String, accessLevel: CollectionAccessLevel): String =
        UUID.randomUUID().toString().also { actions[it] = Action(username, accessLevel) }

    fun get(token: String): Action? = actions[token]
    fun remove(token: String) { actions.remove(token) }
}
