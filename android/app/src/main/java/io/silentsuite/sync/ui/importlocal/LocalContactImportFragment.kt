package io.silentsuite.sync.ui.importlocal

import android.accounts.Account
import android.app.Dialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.provider.ContactsContract
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.fragment.app.commit
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import io.silentsuite.sync.R
import io.silentsuite.sync.Constants
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.App
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.utils.ProgressDialogHelper
import io.silentsuite.sync.ui.etebase.CollectionLifecycleIdentity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.*


class LocalContactImportFragment : Fragment() {
    private lateinit var account: Account
    private lateinit var uid: String
    private var importInProgress = false

    private var recyclerView: RecyclerView? = null
    private var phoneOnlyNotice: TextView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val identity = CollectionLifecycleIdentity.from(arguments)
        if (identity?.collectionUid == null || !identity.validate(requireContext()) ||
            identity.collectionType != Constants.ETEBASE_TYPE_ADDRESS_BOOK) {
            requireActivity().finish()
            return
        }
        account = identity.account
        uid = identity.collectionUid
        retainInstance = true
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val view = inflater.inflate(R.layout.fragment_local_contact_import, container, false)

        recyclerView = view.findViewById<View>(R.id.recyclerView) as RecyclerView
        phoneOnlyNotice = view.findViewById(R.id.phone_only_notice)

        recyclerView!!.layoutManager = LinearLayoutManager(activity)
        recyclerView!!.addItemDecoration(DividerItemDecoration(requireActivity()))
        return view
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        if (!::account.isInitialized) return
        // ImportActivity asks before opening this picker; access can still be gone after a restart.
        if (!DeviceImportAccess.granted(requireContext(), DeviceImport.permissionsFor(Constants.ETEBASE_TYPE_ADDRESS_BOOK))) {
            DeviceImportAccess.refuse(this, R.string.import_device_access_missing)
            return
        }
        showSourcesIfDestinationWritable()
    }

    /** Lists the other accounts only for an existing, writable destination address book on this phone. */
    private fun showSourcesIfDestinationWritable() {
        val destination = try {
            val provider = requireContext().contentResolver.acquireContentProviderClient(ContactsContract.RawContacts.CONTENT_URI)
                ?: return DeviceImportAccess.refuse(this, R.string.import_device_destination_missing)
            try {
                DeviceImporter.destinationAddressBook(requireContext(), account, provider, uid)
            } finally {
                provider.release()
            }
        } catch (e: SecurityException) {
            DeviceImportAccess.refuse(this, R.string.import_device_access_missing)
            return
        }
        DeviceImportAccess.destinationProblem(destination)?.let { problem ->
            DeviceImportAccess.refuse(this, problem)
            return
        }
        importAccount()
    }

    protected fun importAccount() {
        val sourceAccounts = ArrayList<Account>()
        val phoneOnly: Int
        try {
            val resolver = requireContext().contentResolver
            val ownAccountTypes = setOf(App.accountType, App.addressBookAccountType)
            resolver.query(ContactsContract.RawContacts.CONTENT_URI,
                    arrayOf(ContactsContract.RawContacts.ACCOUNT_NAME, ContactsContract.RawContacts.ACCOUNT_TYPE),
                    "${ContactsContract.RawContacts.DELETED}=0", null,
                    ContactsContract.RawContacts.ACCOUNT_NAME + " ASC, " + ContactsContract.RawContacts.ACCOUNT_TYPE)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val accountName = cursor.getString(0)
                    val accountType = cursor.getString(1)
                    if (accountName.isNullOrBlank() || !DeviceImport.isImportSource(accountType, ownAccountTypes))
                        continue
                    val sourceAccount = Account(accountName, accountType!!)
                    if (sourceAccounts.lastOrNull() != sourceAccount)
                        sourceAccounts.add(sourceAccount)
                }
            }
            phoneOnly = DeviceImporter.phoneOnlyContactCount(resolver)
        } catch (e: SecurityException) {
            Logger.log.warning("Contacts access missing for device import")
            return
        }

        // Contacts in no account are not imported here; say so instead of leaving them out silently.
        phoneOnlyNotice?.apply {
            visibility = if (phoneOnly > 0) View.VISIBLE else View.GONE
            text = resources.getQuantityString(R.plurals.import_device_phone_only_contacts, phoneOnly, phoneOnly)
        }

        // The adapter only shows names; the import reads through its own provider client.
        val localAddressBooks = sourceAccounts.map { LocalAddressBook(requireContext(), it, null) }
        recyclerView!!.adapter = ImportContactAdapter(requireContext(), localAddressBooks, object : OnAccountSelected {
            override fun accountSelected(index: Int) {
                importContacts(localAddressBooks[index])
            }
        })
    }

    private fun importContacts(localAddressBook: LocalAddressBook) {
        val identity = CollectionLifecycleIdentity.from(arguments)
        if (identity == null || !identity.validate(requireContext())) {
            requireActivity().finish()
            return
        }
        if (importInProgress) return
        importInProgress = true
        val progressDialog = ProgressDialogHelper.createHorizontal(
            requireContext(),
            R.string.import_dialog_title,
            getString(R.string.import_dialog_adding_entries),
            iconRes = R.drawable.ic_import_export_black
        )
        progressDialog.show()
        val applicationContext = requireContext().applicationContext

        lifecycleScope.launch {
            val result = try {
                withContext(Dispatchers.IO) { doImportContacts(localAddressBook, progressDialog, identity, applicationContext) }
            } finally {
                importInProgress = false
            }

            val currentActivity = activity
            if (currentActivity == null) {
                Logger.log.warning("Activity is null on import.")
                return@launch
            }

            if (progressDialog.isShowing && !currentActivity.isDestroyed && !currentActivity.isFinishing) {
                progressDialog.dismiss()
            }
            onImportResult(result)
        }
    }

    private fun doImportContacts(
        localAddressBook: LocalAddressBook,
        progressDialog: Dialog,
        identity: CollectionLifecycleIdentity,
        applicationContext: Context,
    ): ResultFragment.ImportResult {
        try {
            if (!identity.validate(applicationContext)) return staleImportResult()
            val provider = applicationContext.contentResolver.acquireContentProviderClient(ContactsContract.RawContacts.CONTENT_URI)
                ?: throw Exception("Could not acquire contacts provider")
            try {
                val addressBook = when (val destination = DeviceImporter.destinationAddressBook(applicationContext, account, provider, uid)) {
                    is DeviceImporter.Destination.Ready -> destination.collection
                    else -> return ResultFragment.ImportResult().apply {
                        e = Exception("Destination is missing or read-only")
                        failureMessage = DeviceImportAccess.destinationProblem(destination)?.let { applicationContext.getString(it) }
                    }
                }
                val source = LocalAddressBook(applicationContext, localAddressBook.account, provider)
                val progressBar = ProgressDialogHelper.getProgressBar(progressDialog)
                val result = DeviceImporter.copyContacts(source, addressBook,
                    stillCurrent = { identity.validate(applicationContext) },
                    progress = { done, total ->
                        activity?.runOnUiThread {
                            progressBar.max = total
                            progressBar.progress = done
                        }
                    })
                if (!identity.validate(applicationContext)) return staleImportResult()
                return result
            } finally {
                provider.release()
            }
        } catch (e: DeviceImporter.StaleRoute) {
            return staleImportResult()
        } catch (e: SecurityException) {
            return ResultFragment.ImportResult().apply {
                this.e = e
                failureMessage = applicationContext.getString(R.string.import_device_access_removed)
            }
        } catch (e: Exception) {
            Logger.log.warning("Device contacts import failed: ${e.javaClass.name}")
            return ResultFragment.ImportResult().apply { this.e = e }
        }
    }

    private fun staleImportResult() = ResultFragment.ImportResult().apply {
        e = Exception("The account route is no longer valid.")
    }

    fun onImportResult(importResult: ResultFragment.ImportResult) {
        val fragment = ResultFragment.newInstance(importResult)
        parentFragmentManager.commit(true) {
            add(fragment, "importResult")
        }
    }

    class ImportContactAdapter
    /**
     * Initialize the dataset of the Adapter.
     *
     * @param addressBooks containing the data to populate views to be used by RecyclerView.
     */
    (context: Context, private val mAddressBooks: List<LocalAddressBook>, private val mOnAccountSelected: OnAccountSelected) : RecyclerView.Adapter<ImportContactAdapter.ViewHolder>() {
        private val accountResolver: AccountResolver

        /**
         * Provide a reference to the enumType of views that you are using (custom ViewHolder)
         */
        class ViewHolder(v: View, onAccountSelected: OnAccountSelected) : RecyclerView.ViewHolder(v) {
            internal val titleTextView: TextView
            internal val descTextView: TextView
            internal val iconImageView: ImageView

            init {
                // Define click listener for the ViewHolder's View.
                v.setOnClickListener { onAccountSelected.accountSelected(adapterPosition) }
                titleTextView = v.findViewById<View>(R.id.title) as TextView
                descTextView = v.findViewById<View>(R.id.description) as TextView
                iconImageView = v.findViewById<View>(R.id.icon) as ImageView
            }
        }

        init {
            accountResolver = AccountResolver(context)
        }

        // Create new views (invoked by the layout manager)
        override fun onCreateViewHolder(viewGroup: ViewGroup, viewType: Int): ViewHolder {
            // Create a new view.
            val v = LayoutInflater.from(viewGroup.context)
                    .inflate(R.layout.import_content_list_account, viewGroup, false)

            return ViewHolder(v, mOnAccountSelected)
        }

        override fun onBindViewHolder(viewHolder: ViewHolder, position: Int) {
            viewHolder.titleTextView.text = mAddressBooks[position].account.name
            val accountInfo = accountResolver.resolve(mAddressBooks[position].account.type)
            viewHolder.descTextView.text = accountInfo.name
            viewHolder.iconImageView.setImageDrawable(accountInfo.icon)
        }

        override fun getItemCount(): Int {
            return mAddressBooks.size
        }

        companion object {
            private val TAG = "ImportContactAdapter"
        }
    }

    interface OnAccountSelected {
        fun accountSelected(index: Int)
    }

    class DividerItemDecoration(context: Context) : RecyclerView.ItemDecoration() {

        private val mDivider: Drawable?

        init {
            val a = context.obtainStyledAttributes(ATTRS)
            mDivider = a.getDrawable(0)
            a.recycle()
        }

        override fun onDrawOver(c: Canvas, parent: RecyclerView, state: RecyclerView.State) {
            drawVertical(c, parent)
        }

        fun drawVertical(c: Canvas, parent: RecyclerView) {
            val left = parent.paddingLeft
            val right = parent.width - parent.paddingRight

            val childCount = parent.childCount
            for (i in 0 until childCount) {
                val child = parent.getChildAt(i)
                val params = child
                        .layoutParams as RecyclerView.LayoutParams
                val top = child.bottom + params.bottomMargin
                val bottom = top + mDivider!!.intrinsicHeight
                mDivider.setBounds(left, top, right, bottom)
                mDivider.draw(c)
            }
        }

        override fun getItemOffsets(outRect: Rect, view: View, parent: RecyclerView, state: RecyclerView.State) {
            outRect.set(0, 0, 0, mDivider!!.intrinsicHeight)
        }

        companion object {

            private val ATTRS = intArrayOf(android.R.attr.listDivider)
        }
    }

    companion object {

        fun newInstance(identity: CollectionLifecycleIdentity) = LocalContactImportFragment().apply {
            requireNotNull(identity.collectionUid)
            arguments = identity.toBundle()
        }

    }
}
