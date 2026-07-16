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
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.utils.ProgressDialogHelper
import androidx.lifecycle.lifecycleScope
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
        val color = LocalCalendar.parseColor(meta.color)
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
