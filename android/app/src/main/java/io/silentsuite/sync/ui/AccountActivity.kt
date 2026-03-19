/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.content.*
import android.content.ContentResolver.SYNC_OBSERVER_TYPE_ACTIVE
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.text.TextUtils
import android.view.*
import android.widget.*
import androidx.activity.viewModels
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.widget.Toolbar
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.observe
import at.bitfire.ical4android.TaskProvider.Companion.TASK_PROVIDERS
import at.bitfire.vcard4android.ContactsStorageException
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.CollectionManager
import com.etebase.client.Utils
import com.etebase.client.exceptions.EtebaseException
import io.silentsuite.sync.*
import io.silentsuite.sync.Constants.ETEBASE_TYPE_ADDRESS_BOOK
import io.silentsuite.sync.Constants.ETEBASE_TYPE_CALENDAR
import io.silentsuite.sync.Constants.ETEBASE_TYPE_TASKS
import io.silentsuite.sync.Constants.KEY_ACCOUNT
import io.silentsuite.sync.billing.BillingManager
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.ui.etebase.CollectionActivity
import io.silentsuite.sync.ui.etebase.InvitationsActivity
import io.silentsuite.sync.utils.HintManager
import io.silentsuite.sync.utils.ShowcaseBuilder
import io.silentsuite.sync.utils.packageInstalled
import com.google.android.material.snackbar.Snackbar
// Modified by Silent Suite - ACRA removed, will be replaced with Sentry in Phase 2
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tourguide.tourguide.ToolTip
import java.util.logging.Level

class AccountActivity : BaseActivity(), Toolbar.OnMenuItemClickListener, PopupMenu.OnMenuItemClickListener, Refreshable {
    private val model: AccountInfoViewModel by viewModels()

    private lateinit var account: Account
    private lateinit var settings: AccountSettings
    private var accountInfo: AccountInfo? = null

    internal var listCalDAV: ListView? = null
    internal var listCardDAV: ListView? = null
    internal var listTaskDAV: ListView? = null

    internal val openTasksPackage = "org.dmfs.tasks"
    internal val tasksOrgPackage = "org.tasks"

    private val onItemClickListener = AdapterView.OnItemClickListener { parent, view, position, _ ->
        val list = parent as ListView
        val adapter = list.adapter as ArrayAdapter<*>
        val info = adapter.getItem(position) as CollectionListItemInfo

        startActivity(CollectionActivity.newIntent(this@AccountActivity, account, info.uid))
    }

    private val formattedFingerprint: String?
        get() {
            try {
                val etebase = EtebaseLocalCache.getEtebase(this, HttpClient.sharedClient, settings)
                val invitationManager = etebase.invitationManager
                return Utils.prettyFingerprint(invitationManager.pubkey)
            } catch (e: Exception) {
                e.printStackTrace()
                return e.localizedMessage
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        account = intent.getParcelableExtra(EXTRA_ACCOUNT)!!
        title = account.name
        settings = AccountSettings(this, account)

        // TODO(Phase2): Set username in Sentry crash reporting context

        setContentView(R.layout.activity_account)

        val icMenu = ContextCompat.getDrawable(this, R.drawable.ic_menu_light)

        // CardDAV toolbar
        val tbCardDAV = findViewById<View>(R.id.carddav_menu) as Toolbar
        tbCardDAV.overflowIcon = icMenu
        tbCardDAV.inflateMenu(R.menu.carddav_actions)
        tbCardDAV.setOnMenuItemClickListener(this)
        tbCardDAV.setTitle(R.string.settings_carddav)

        // CalDAV toolbar
        val tbCalDAV = findViewById<View>(R.id.caldav_menu) as Toolbar
        tbCalDAV.overflowIcon = icMenu
        tbCalDAV.inflateMenu(R.menu.caldav_actions)
        tbCalDAV.setOnMenuItemClickListener(this)
        tbCalDAV.setTitle(R.string.settings_caldav)

        // TaskDAV toolbar
        val tbTaskDAV = findViewById<View>(R.id.taskdav_menu) as Toolbar
        tbTaskDAV.overflowIcon = icMenu
        tbTaskDAV.inflateMenu(R.menu.taskdav_actions)
        tbTaskDAV.setOnMenuItemClickListener(this)
        tbTaskDAV.setTitle(R.string.settings_taskdav)
        if (!packageInstalled(this, tasksOrgPackage)) {
            val tasksInstallMenuItem = tbTaskDAV.menu.findItem(R.id.install_tasksorg)
            tasksInstallMenuItem.setVisible(true)
        }
        if (!packageInstalled(this, openTasksPackage)) {
            val tasksInstallMenuItem = tbTaskDAV.menu.findItem(R.id.install_opentasks)
            tasksInstallMenuItem.setVisible(true)
        }

        // Load subscription status
        loadSubscriptionStatus()

        // load CardDAV/CalDAV journals
        if (savedInstanceState == null) {
            model.initialize(this, account)
            model.loadAccount()
            model.observe(this) {
                updateUi(it)
            }
        }

        if (!HintManager.getHintSeen(this, HINT_VIEW_COLLECTION)) {
            ShowcaseBuilder.getBuilder(this)
                    .setToolTip(ToolTip().setTitle(getString(R.string.tourguide_title)).setDescription(getString(R.string.account_showcase_view_collection)))
                    .playOn(tbCardDAV)
            HintManager.setHintSeen(this, HINT_VIEW_COLLECTION, true)
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.activity_account, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.sync_now -> requestSync()
            R.id.settings -> {
                startActivity(Intent(this, AppSettingsActivity::class.java))
            }
            R.id.delete_account -> AlertDialog.Builder(this@AccountActivity)
                    .setIcon(R.drawable.ic_error_dark)
                    .setTitle(R.string.account_delete_confirmation_title)
                    .setMessage(R.string.account_delete_confirmation_text)
                    .setNegativeButton(android.R.string.no, null)
                    .setPositiveButton(android.R.string.yes) { _, _ -> deleteAccount() }
                    .show()
            R.id.show_fingerprint -> {
                val view = layoutInflater.inflate(R.layout.fingerprint_alertdialog, null)
                view.findViewById<View>(R.id.body).visibility = View.GONE
                (view.findViewById<View>(R.id.fingerprint) as TextView).text = formattedFingerprint
                val dialog = AlertDialog.Builder(this@AccountActivity)
                        .setIcon(R.drawable.ic_fingerprint_dark)
                        .setTitle(R.string.show_fingperprint_title)
                        .setView(view)
                        .setPositiveButton(android.R.string.yes) { _, _ -> }.create()
                dialog.show()
            }
            R.id.invitations -> {
                val intent = InvitationsActivity.newIntent(this, account)
                startActivity(intent)
            }
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    fun installPackage(packagename: String) {
        val fdroidPackageName = "org.fdroid.fdroid"
        val gplayPackageName = "com.android.vending"
        val intent = Intent(Intent.ACTION_VIEW).apply {
            data = Uri.parse(
                    "https://f-droid.org/en/packages/$packagename/")
        }
        if (packageInstalled(this, fdroidPackageName)) {
            intent.setPackage(fdroidPackageName)
        } else if (packageInstalled(this, gplayPackageName)) {
            intent.apply {
                data = Uri.parse(
                        "https://play.google.com/store/apps/details?id=$packagename")
                setPackage(gplayPackageName)
            }
        }
        startActivity(intent)
    }

    override fun onMenuItemClick(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.create_calendar -> {
                startActivity(CollectionActivity.newCreateCollectionIntent(this@AccountActivity, account, ETEBASE_TYPE_CALENDAR))
            }
            R.id.create_tasklist -> {
                startActivity(CollectionActivity.newCreateCollectionIntent(this@AccountActivity, account, ETEBASE_TYPE_TASKS))
            }
            R.id.create_addressbook -> {
                startActivity(CollectionActivity.newCreateCollectionIntent(this@AccountActivity, account, ETEBASE_TYPE_ADDRESS_BOOK))
            }
            R.id.install_tasksorg ->  {
                installPackage(tasksOrgPackage)
            }
            R.id.install_opentasks ->  {
                installPackage(openTasksPackage)
            }
        }
        return false
    }

    /* LOADERS AND LOADED DATA */

    class AccountInfo {
        internal var carddav: ServiceInfo? = null
        internal var caldav: ServiceInfo? = null
        internal var taskdav: ServiceInfo? = null

        class ServiceInfo {
            internal var refreshing: Boolean = false

            internal var infos: List<CollectionListItemInfo>? = null
        }
    }

    override fun refresh() {
        model.loadAccount()
    }

    fun updateUi(info: AccountInfo) {
        accountInfo = info

        if (info.carddav != null) {
            val progress = findViewById<View>(R.id.carddav_refreshing) as ProgressBar
            progress.visibility = if (info.carddav!!.refreshing) View.VISIBLE else View.GONE

            listCardDAV = findViewById<View>(R.id.address_books) as ListView
            listCardDAV!!.isEnabled = !info.carddav!!.refreshing
            listCardDAV!!.setAlpha(if (info.carddav!!.refreshing) 0.5f else 1f)

            val adapter = CollectionListAdapter(this, account)
            adapter.addAll(info.carddav!!.infos!!)
            listCardDAV!!.adapter = adapter
            listCardDAV!!.onItemClickListener = onItemClickListener
        }

        if (info.caldav != null) {
            val progress = findViewById<View>(R.id.caldav_refreshing) as ProgressBar
            progress.visibility = if (info.caldav!!.refreshing) View.VISIBLE else View.GONE

            listCalDAV = findViewById<View>(R.id.calendars) as ListView
            listCalDAV!!.isEnabled = !info.caldav!!.refreshing
            listCalDAV!!.setAlpha(if (info.caldav!!.refreshing) 0.5f else 1f)

            val adapter = CollectionListAdapter(this, account)
            adapter.addAll(info.caldav!!.infos!!)
            listCalDAV!!.adapter = adapter
            listCalDAV!!.onItemClickListener = onItemClickListener
        }

        if (info.taskdav != null) {
            val progress = findViewById<View>(R.id.taskdav_refreshing) as ProgressBar
            progress.visibility = if (info.taskdav!!.refreshing) View.VISIBLE else View.GONE

            listTaskDAV = findViewById<View>(R.id.tasklists) as ListView
            listTaskDAV!!.isEnabled = !info.taskdav!!.refreshing
            listTaskDAV!!.setAlpha(if (info.taskdav!!.refreshing) 0.5f else 1f)

            val adapter = CollectionListAdapter(this, account)
            adapter.addAll(info.taskdav!!.infos!!)
            listTaskDAV!!.adapter = adapter
            listTaskDAV!!.onItemClickListener = onItemClickListener

            if (!packageInstalled(this, tasksOrgPackage) && !packageInstalled(this, openTasksPackage)) {
                val opentasksWarning = findViewById<View>(R.id.taskdav_opentasks_warning)
                opentasksWarning.visibility = View.VISIBLE
            }
        }
    }


    class AccountInfoViewModel : ViewModel(), AccountUpdateService.RefreshingStatusListener, ServiceConnection, SyncStatusObserver {
        private val holder = MutableLiveData<AccountActivity.AccountInfo>()
        private lateinit var context: Context
        private lateinit var account: Account
        private var davService: AccountUpdateService.InfoBinder? = null
        private var syncStatusListener: Any? = null

        fun initialize(context: Context, account: Account) {
            this.context = context
            this.account = account

            syncStatusListener = ContentResolver.addStatusChangeListener(SYNC_OBSERVER_TYPE_ACTIVE, this)

            context.bindService(Intent(context, AccountUpdateService::class.java), this, Context.BIND_AUTO_CREATE)
        }

        fun loadAccount() {
            viewModelScope.launch {
                val info = withContext(Dispatchers.IO) {
                    doLoad()
                }
                holder.value = info
            }
        }

        override fun onCleared() {
            davService?.removeRefreshingStatusListener(this)
            context.unbindService(this)

            if (syncStatusListener != null) {
                ContentResolver.removeStatusChangeListener(syncStatusListener)
                syncStatusListener = null
            }
        }

        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            davService = service as AccountUpdateService.InfoBinder
            davService!!.addRefreshingStatusListener(this, false)

            loadAccount()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            davService = null
        }

        override fun onDavRefreshStatusChanged(id: Long, refreshing: Boolean) {
            loadAccount()
        }

        override fun onStatusChanged(which: Int) {
            loadAccount()
        }

        private fun getCollections(etebaseLocalCache: EtebaseLocalCache, colMgr: CollectionManager, type: CollectionInfo.Type): List<CollectionListItemInfo> {
            val strType = when (type) {
                CollectionInfo.Type.ADDRESS_BOOK -> ETEBASE_TYPE_ADDRESS_BOOK
                CollectionInfo.Type.CALENDAR -> ETEBASE_TYPE_CALENDAR
                CollectionInfo.Type.TASKS -> ETEBASE_TYPE_TASKS
            }

            synchronized(etebaseLocalCache) {
                return etebaseLocalCache.collectionList(colMgr).map {
                    val meta = it.meta
                    val collectionType = it.collectionType

                    if (strType != collectionType) {
                        return@map null
                    }

                    val accessLevel = it.col.accessLevel
                    val isReadOnly = accessLevel == CollectionAccessLevel.ReadOnly
                    val isAdmin = accessLevel == CollectionAccessLevel.Admin

                    val metaColor = meta.color
                    val color = if (!metaColor.isNullOrBlank()) LocalCalendar.parseColor(metaColor) else null
                    CollectionListItemInfo(it.col.uid, type, meta.name!!, meta.description
                            ?: "", color, isReadOnly, isAdmin)
                }.filterNotNull()
            }
        }

        private fun doLoad(): AccountActivity.AccountInfo {
            val info = AccountActivity.AccountInfo()
            val settings: AccountSettings
            try {
                settings = AccountSettings(context, account)
            } catch (e: InvalidAccountException) {
                return info
            }

            val etebaseLocalCache = EtebaseLocalCache.getInstance(context, account.name)
            val httpClient = HttpClient.Builder(context).build().okHttpClient
            val etebase = EtebaseLocalCache.getEtebase(context, httpClient, settings)
            val colMgr = etebase.collectionManager

            info.carddav = AccountInfo.ServiceInfo()
            info.carddav!!.refreshing = ContentResolver.isSyncActive(account, App.addressBooksAuthority)
            info.carddav!!.infos = getCollections(etebaseLocalCache, colMgr, CollectionInfo.Type.ADDRESS_BOOK)

            val accountManager = AccountManager.get(context)
            for (addrBookAccount in accountManager.getAccountsByType(App.addressBookAccountType)) {
                val addressBook = LocalAddressBook(context, addrBookAccount, null)
                try {
                    if (account == addressBook.mainAccount)
                        info.carddav!!.refreshing = info.carddav!!.refreshing or ContentResolver.isSyncActive(addrBookAccount, ContactsContract.AUTHORITY)
                } catch (e: ContactsStorageException) {
                }

            }

            info.caldav = AccountInfo.ServiceInfo()
            info.caldav!!.refreshing = ContentResolver.isSyncActive(account, CalendarContract.AUTHORITY)
            info.caldav!!.infos = getCollections(etebaseLocalCache, colMgr, CollectionInfo.Type.CALENDAR)

            info.taskdav = AccountInfo.ServiceInfo()
            info.taskdav!!.refreshing = TASK_PROVIDERS.any {
                ContentResolver.isSyncActive(account, it.authority)
            }
            info.taskdav!!.infos = getCollections(etebaseLocalCache, colMgr, CollectionInfo.Type.TASKS)

            return info
        }

        fun observe(owner: LifecycleOwner, observer: (AccountActivity.AccountInfo) -> Unit) =
                holder.observe(owner, observer)

        val value: AccountActivity.AccountInfo?
            get() = holder.value
    }


    /* LIST ADAPTERS */

    data class CollectionListItemInfo(val uid: String, val enumType: CollectionInfo.Type, val displayName: String, val description: String, val color: Int?, val isReadOnly: Boolean, val isAdmin: Boolean)

    class CollectionListAdapter(context: Context, private val account: Account) : ArrayAdapter<CollectionListItemInfo>(context, R.layout.account_collection_item) {

        override fun getView(position: Int, _v: View?, parent: ViewGroup): View {
            var v = _v
            if (v == null)
                v = LayoutInflater.from(context).inflate(R.layout.account_collection_item, parent, false)

            val info = getItem(position)!!

            var tv = v!!.findViewById<View>(R.id.title) as TextView
            tv.text = if (TextUtils.isEmpty(info.displayName)) info.uid else info.displayName

            tv = v.findViewById<View>(R.id.description) as TextView
            if (TextUtils.isEmpty(info.description))
                tv.visibility = View.GONE
            else {
                tv.visibility = View.VISIBLE
                tv.text = info.description
            }

            val vColor = v.findViewById<View>(R.id.color)
            if (info.enumType == CollectionInfo.Type.ADDRESS_BOOK) {
                vColor.visibility = View.GONE
            } else {
                vColor.setBackgroundColor(info.color ?: LocalCalendar.defaultColor)
            }

            val readOnly = v.findViewById<View>(R.id.read_only)
            readOnly.visibility = if (info.isReadOnly) View.VISIBLE else View.GONE

            val shared = v.findViewById<View>(R.id.shared)
            val isOwner = info.isAdmin
            shared.visibility = if (isOwner) View.GONE else View.VISIBLE

            return v
        }
    }

    /* USER ACTIONS */

    private fun deleteAccount() {
        val accountManager = AccountManager.get(this)
        val settings = AccountSettings(this@AccountActivity, account)

        lifecycleScope.launch {
            withContext(Dispatchers.IO) {
                EtebaseLocalCache.clearUserCache(this@AccountActivity, account.name)

                try {
                    val httpClient = HttpClient.Builder(this@AccountActivity).build()
                    val etebase = EtebaseLocalCache.getEtebase(this@AccountActivity, httpClient.okHttpClient, settings)
                    etebase.logout()
                } catch(e: EtebaseException) {
                    // Ignore failures for now
                    Logger.log.warning(e.toString())
                }
            }
        }

        if (Build.VERSION.SDK_INT >= 22)
            accountManager.removeAccount(account, this, { future ->
                try {
                    if (future.result.getBoolean(AccountManager.KEY_BOOLEAN_RESULT))
                        finish()
                } catch(e: Exception) {
                    Logger.log.log(Level.SEVERE, "Couldn't remove account", e)
                }
            }, null)
        else
            accountManager.removeAccount(account, { future ->
                try {
                    if (future.result)
                        finish()
                } catch (e: Exception) {
                    Logger.log.log(Level.SEVERE, "Couldn't remove account", e)
                }
            }, null)
    }


    private fun requestSync() {
        requestSync(applicationContext, account)
        Snackbar.make(findViewById(R.id.parent), R.string.account_synchronizing_now, Snackbar.LENGTH_LONG).show()
    }

    private fun loadSubscriptionStatus() {
        val planView = findViewById<TextView>(R.id.subscription_plan)
        val statusView = findViewById<TextView>(R.id.subscription_status)
        val trialView = findViewById<TextView>(R.id.subscription_trial)
        val actionButton = findViewById<com.google.android.material.button.MaterialButton>(R.id.subscription_action)

        // Show loading state
        planView.text = getString(R.string.subscription_loading)
        statusView.visibility = View.GONE

        lifecycleScope.launch {
            val status = withContext(Dispatchers.IO) {
                BillingManager.getInstance().getSubscriptionStatus(this@AccountActivity, account)
            }
            updateSubscriptionUi(status, planView, statusView, trialView, actionButton)
        }
    }

    private fun updateSubscriptionUi(
        status: BillingManager.SubscriptionStatus,
        planView: TextView,
        statusView: TextView,
        trialView: TextView,
        actionButton: com.google.android.material.button.MaterialButton
    ) {
        // Plan name
        planView.text = status.displayPlan

        // Status line
        statusView.visibility = View.VISIBLE
        when {
            status.isActive -> {
                val renewalText = status.renewalDate?.let { date ->
                    try {
                        val parsed = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US).parse(date)
                        val formatted = java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(parsed!!)
                        getString(R.string.subscription_renews, formatted)
                    } catch (e: Exception) {
                        getString(R.string.subscription_status_active)
                    }
                } ?: getString(R.string.subscription_status_active)
                statusView.text = renewalText
                statusView.setTextColor(planView.currentTextColor)
            }
            status.isTrial -> {
                statusView.text = getString(R.string.subscription_status_trialing)
                statusView.setTextColor(planView.currentTextColor)
                // Show trial days
                status.trialDaysRemaining?.let { days ->
                    trialView.visibility = View.VISIBLE
                    trialView.text = getString(R.string.subscription_trial_days, days)
                }
            }
            status.isPastDue -> {
                statusView.text = getString(R.string.subscription_status_past_due)
                statusView.setTextColor(ContextCompat.getColor(this, android.R.color.holo_orange_dark))
            }
            status.isExpiredOrCancelled -> {
                statusView.text = if (status.status == "cancelled")
                    getString(R.string.subscription_status_cancelled)
                else
                    getString(R.string.subscription_status_expired)
                statusView.setTextColor(ContextCompat.getColor(this, android.R.color.holo_red_dark))
                // Show reactivate button
                actionButton.visibility = View.VISIBLE
                actionButton.text = getString(R.string.subscription_reactivate)
                actionButton.setOnClickListener {
                    startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(BillingManager.BILLING_MANAGE_URL)))
                }
            }
            status.isUnknown -> {
                statusView.text = getString(R.string.subscription_status_unknown)
                statusView.setTextColor(planView.currentTextColor)
            }
        }
    }

    companion object {
        val EXTRA_ACCOUNT = "account"
        private val HINT_VIEW_COLLECTION = "ViewCollection"
    }

}
