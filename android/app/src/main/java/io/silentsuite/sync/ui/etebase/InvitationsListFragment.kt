package io.silentsuite.sync.ui.etebase

import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.fragment.app.ListFragment
import androidx.fragment.app.activityViewModels
import androidx.fragment.app.viewModels
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.observe
import androidx.lifecycle.lifecycleScope
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.FetchOptions
import com.etebase.client.SignedInvitation
import com.etebase.client.Utils
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.syncadapter.requestSync
import kotlinx.coroutines.CancellationException
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.*

internal data class RuntimeInvitation(
    val id: String, val fromUsername: String, val accessLevel: CollectionAccessLevel, val fingerprint: String
)
internal enum class RuntimeInvitationAction { ACCEPT, REJECT }
@Volatile internal var invitationsOverride: ((InvitationLifecycleIdentity) -> List<RuntimeInvitation>)? = null
@Volatile internal var invitationActionOverride:
    ((Context, InvitationLifecycleIdentity, String, RuntimeInvitationAction) -> Result<Unit>)? = null
internal data class InvitationRow(val runtime: RuntimeInvitation, private val signedInvitation: SignedInvitation? = null) {
    internal fun realInvitation() = signedInvitation
}

class InvitationsListFragment : ListFragment(), AdapterView.OnItemClickListener {
    private val model: AccountViewModel by activityViewModels()
    private val invitationsModel: InvitationsViewModel by viewModels()

    private var emptyTextView: TextView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val identity = InvitationLifecycleIdentity.from(arguments)
        if (identity == null || !identity.validate(requireContext())) {
            requireActivity().finish()
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val view = inflater.inflate(R.layout.invitations_list, container, false)

        //This is instead of setEmptyText() function because of Google bug
        //See: https://code.google.com/p/android/issues/detail?id=21742
        emptyTextView = view.findViewById<TextView>(android.R.id.empty)
        return view
    }

    private fun setListAdapterInvitations(invitations: List<InvitationRow>) {
        val context = context
        if (context != null) {
            val listAdapter = InvitationsListAdapter(context)
            setListAdapter(listAdapter)

            listAdapter.addAll(invitations)

            emptyTextView!!.setText(R.string.invitations_list_empty)
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val identity = requireNotNull(InvitationLifecycleIdentity.from(arguments))
        invitationsOverride?.let { override ->
            setListAdapterInvitations(override(identity).map { InvitationRow(it) })
            emptyTextView!!.setText(R.string.invitations_list_empty)
            listView.onItemClickListener = this
            return
        }

        model.observe(viewLifecycleOwner) { accountHolder ->
            val identity = InvitationLifecycleIdentity.from(arguments)
            if (identity == null || identity.account != accountHolder.account || !identity.validate(requireContext())) {
                requireActivity().finish()
                return@observe
            }
            invitationsModel.loadInvitations(requireContext().applicationContext, identity, accountHolder)
        }

        invitationsModel.observe(viewLifecycleOwner) {
            setListAdapterInvitations(it)
        }

        listView.onItemClickListener = this
    }

    override fun onDestroyView() {
        super.onDestroyView()

        invitationsModel.cancelLoad()
    }

    override fun onItemClick(parent: AdapterView<*>, view_: View, position: Int, id: Long) {
        val invitation = listAdapter?.getItem(position) as InvitationRow
        val identity = InvitationLifecycleIdentity.from(arguments)
        if (identity == null || !identity.validate(requireContext())) {
            requireActivity().finish()
            return
        }
        val fingerprint = invitation.runtime.fingerprint
        val view = layoutInflater.inflate(R.layout.invitation_alert_dialog, null)
        view.findViewById<TextView>(R.id.body).text = getString(R.string.invitations_accept_reject_dialog)
        view.findViewById<TextView>(R.id.fingerprint).text = fingerprint
        val applicationContext = requireContext().applicationContext

        MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.invitations_title)
                .setIcon(R.drawable.ic_email_black)
                .setView(view)
                .setNegativeButton(R.string.invitations_reject) { _, _ ->
                    if (invitation.realInvitation() == null) completeFixtureAction(applicationContext, identity, invitation, RuntimeInvitationAction.REJECT)
                    else invitationsModel.reject(applicationContext, identity, model.value!!, invitation.realInvitation()!!)
                }
                .setPositiveButton(R.string.invitations_accept) { _, _ ->
                    if (invitation.realInvitation() == null) {
                        completeFixtureAction(applicationContext, identity, invitation, RuntimeInvitationAction.ACCEPT)
                        return@setPositiveButton
                    }
                    val accountHolder = model.value!!
                    val account = accountHolder.account
                    invitationsModel.accept(applicationContext, identity, accountHolder, invitation.realInvitation()!!) { result ->
                        result.onSuccess {
                            if (!identity.validate(applicationContext)) {
                                activity?.finish()
                                return@onSuccess
                            }
                            requestSync(applicationContext, account, forceCollectionRefresh = true)
                            Toast.makeText(applicationContext, R.string.invitations_accept_success_syncing, Toast.LENGTH_LONG).show()
                            activity?.finish()
                        }.onFailure {
                            Logger.log.warning("Invitation acceptance failed: ${it.javaClass.name}")
                            context?.let { fragmentContext ->
                                Toast.makeText(fragmentContext, R.string.invitations_accept_error, Toast.LENGTH_LONG).show()
                            }
                        }
                    }
                }
                .show()
    }

    private fun completeFixtureAction(context: Context, identity: InvitationLifecycleIdentity, row: InvitationRow, action: RuntimeInvitationAction) {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                if (!identity.validate(context)) Result.failure(IllegalStateException("Account generation changed"))
                else invitationActionOverride?.invoke(context, identity, row.runtime.id, action)
                    ?: Result.failure(IllegalStateException("Missing fixture action"))
            }
            if (!result.isSuccess || !identity.validate(context)) return@launch
            if (action == RuntimeInvitationAction.ACCEPT) {
                activity?.finish()
            } else {
                setListAdapterInvitations(invitationsOverride?.invoke(identity).orEmpty().map { InvitationRow(it) })
            }
        }
    }

    internal inner class InvitationsListAdapter(context: Context) : ArrayAdapter<InvitationRow>(context, R.layout.invitations_list_item) {

        override fun getView(position: Int, _v: View?, parent: ViewGroup): View {
            var v = _v
            if (v == null)
                v = LayoutInflater.from(context).inflate(R.layout.invitations_list_item, parent, false)

            val invitation = getItem(position)!!.runtime

            val tv = v!!.findViewById<View>(R.id.title) as TextView
            tv.text = getString(R.string.invitations_from, invitation.fromUsername)

            val readOnly = v.findViewById<View>(R.id.read_only)
            readOnly.visibility = if (invitation.accessLevel == CollectionAccessLevel.ReadOnly) View.VISIBLE else View.GONE
            v.contentDescription = getString(
                if (invitation.accessLevel == CollectionAccessLevel.ReadOnly)
                    R.string.invitations_accessibility_read_only
                else R.string.invitations_accessibility,
                invitation.fromUsername
            )
            tv.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            readOnly.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO

            return v
        }
    }

    companion object {
        fun newInstance(identity: InvitationLifecycleIdentity) = InvitationsListFragment().apply {
            arguments = identity.toBundle()
        }
    }
}

class InvitationsViewModel : ViewModel() {
    private val invitations = MutableLiveData<List<InvitationRow>>()
    private var asyncTask: Job? = null

    fun loadInvitations(
        applicationContext: Context,
        identity: InvitationLifecycleIdentity,
        accountCollectionHolder: AccountHolder
    ) {
        asyncTask = viewModelScope.launch {
            val ret = withContext(Dispatchers.IO) {
                if (!identity.validate(applicationContext) || identity.account != accountCollectionHolder.account)
                    return@withContext null
                val result = LinkedList<SignedInvitation>()
                val invitationManager = accountCollectionHolder.etebase.invitationManager
                var iterator: String? = null
                var done = false
                while (!done) {
                    if (!identity.validate(applicationContext)) return@withContext null
                    val chunk = invitationManager.listIncoming(FetchOptions().iterator(iterator).limit(30))
                    if (!identity.validate(applicationContext) || identity.account != accountCollectionHolder.account)
                        return@withContext null
                    iterator = chunk.stoken
                    done = chunk.isDone
                    result.addAll(chunk.data)
                }
                result.map {
                    InvitationRow(RuntimeInvitation(
                        it.uid,
                        it.fromUsername ?: applicationContext.getString(R.string.invitations_sender_unknown),
                        it.accessLevel,
                        Utils.prettyFingerprint(it.fromPubkey),
                    ), it)
                }
            }
            if (ret != null && identity.validate(applicationContext) && identity.account == accountCollectionHolder.account)
                invitations.value = ret
        }
    }

    fun accept(
        applicationContext: Context,
        identity: InvitationLifecycleIdentity,
        accountCollectionHolder: AccountHolder,
        invitation: SignedInvitation,
        onComplete: (Result<Unit>) -> Unit = {}
    ) {
        viewModelScope.launch {
            val result = try {
                val accepted = withContext(Dispatchers.IO) {
                    if (!identity.validate(applicationContext) || identity.account != accountCollectionHolder.account)
                        return@withContext false
                    accountCollectionHolder.etebase.invitationManager.accept(invitation)
                    true
                }
                if (accepted && identity.validate(applicationContext)) Result.success(Unit)
                else Result.failure(IllegalStateException("Account generation changed"))
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                Result.failure(e)
            }

            if (result.isSuccess) {
                invitations.value = invitations.value.orEmpty().filter { it.realInvitation() != invitation }
            }
            onComplete(result)
        }
    }

    fun reject(
        applicationContext: Context,
        identity: InvitationLifecycleIdentity,
        accountCollectionHolder: AccountHolder,
        invitation: SignedInvitation
    ) {
        viewModelScope.launch {
            val rejected = withContext(Dispatchers.IO) {
                if (!identity.validate(applicationContext) || identity.account != accountCollectionHolder.account)
                    return@withContext false
                accountCollectionHolder.etebase.invitationManager.reject(invitation)
                identity.validate(applicationContext) && identity.account == accountCollectionHolder.account
            }
            if (rejected) {
                invitations.value = invitations.value.orEmpty().filter { it.realInvitation() != invitation }
            }
        }
    }

    fun cancelLoad() {
        asyncTask?.cancel()
    }

    internal fun observe(owner: LifecycleOwner, observer: (List<InvitationRow>) -> Unit) =
            invitations.observe(owner, observer)
}
