/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.app.Activity
import android.content.*
import android.content.ContentResolver.SYNC_OBSERVER_TYPE_ACTIVE
import android.content.ContentResolver.SYNC_OBSERVER_TYPE_SETTINGS
import android.net.Uri
import android.os.Bundle
import android.os.IBinder
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.text.TextUtils
import android.text.format.DateUtils
import android.view.*
import android.widget.*
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.annotation.VisibleForTesting
import androidx.appcompat.app.ActionBarDrawerToggle
import androidx.appcompat.app.AppCompatDelegate
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.appcompat.widget.Toolbar
import androidx.core.content.ContextCompat
import androidx.core.view.GravityCompat
import androidx.core.view.ViewCompat
import androidx.drawerlayout.widget.DrawerLayout
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
import io.silentsuite.sync.*
import io.silentsuite.sync.Constants.ETEBASE_TYPE_ADDRESS_BOOK
import io.silentsuite.sync.Constants.ETEBASE_TYPE_CALENDAR
import io.silentsuite.sync.Constants.ETEBASE_TYPE_TASKS
import io.silentsuite.sync.Constants.KEY_ACCOUNT
import io.silentsuite.sync.billing.BillingManager
import io.silentsuite.sync.dataexport.AndroidDataExporter
import io.silentsuite.sync.dataexport.AndroidExportKind
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.account.*
import io.silentsuite.sync.ui.etebase.CollectionActivity
import io.silentsuite.sync.ui.etebase.InvitationsActivity
import io.silentsuite.sync.ui.setup.LoginActivity
import io.silentsuite.sync.ui.settings.SettingsCategory
import io.silentsuite.sync.ui.settings.AppPreferences
import io.silentsuite.sync.utils.TaskProviderHandling
import io.silentsuite.sync.utils.NotificationUtils
import io.silentsuite.sync.utils.packageInstalled
import com.google.android.material.navigation.NavigationView
import com.google.android.material.snackbar.Snackbar
// Modified by Silent Suite - ACRA removed, will be replaced with Sentry in Phase 2
import androidx.lifecycle.viewModelScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.io.OutputStream
import java.util.logging.Level

class AccountActivity : BaseActivity(), Toolbar.OnMenuItemClickListener, PopupMenu.OnMenuItemClickListener, Refreshable, NavigationView.OnNavigationItemSelectedListener, SyncStatusObserver {
    private val model: AccountInfoViewModel by viewModels()
    private val signOutModel: CurrentAccountSignOutViewModel by viewModels()

    private lateinit var account: Account
    private lateinit var accountCreationId: String
    private lateinit var settings: AccountSettings
    private var accountInfo: AccountInfo? = null

    internal val hasDeliveredAccountInfo: Boolean
        get() = accountInfo != null
    internal var accountInfoDeliveryCount: Int = 0
        private set

    internal var listCalDAV: ListView? = null
    internal var listCardDAV: ListView? = null
    internal var listTaskDAV: ListView? = null

    internal val openTasksPackage = "org.dmfs.tasks"
    internal val tasksOrgPackage = "org.tasks"

    private var syncStatusSnackbar: Snackbar? = null
    private var signOutErrorSnackbar: Snackbar? = null
    private var syncStatusObserver: Any? = null
    private var syncActiveObserver: Any? = null
    private var swipeRefreshLayout: SwipeRefreshLayout? = null
    private var accountListExpanded = false
    private var pendingExportKind: AndroidExportKind? = null
    private var signOutOnly = false
    private var renderedSignOutErrorId = 0L
    private var signOutCompletionHandled = false
    private lateinit var notificationPermissionFlow: NotificationPermissionFlow

    // ActivityResultRegistry keeps this registration across recreation and delivers an outstanding
    // platform result to the recreated Activity.  Do not replace this with onRequestPermissionsResult:
    // it would lose the association while the Android 13 dialog owns the window.
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        dispatchNotificationPermissionAction(notificationPermissionFlow.onNotificationResult())
    }

    private val onItemClickListener = AdapterView.OnItemClickListener { parent, view, position, _ ->
        val list = parent as ListView
        val adapter = list.adapter as ArrayAdapter<*>
        val info = adapter.getItem(position) as CollectionListItemInfo

        launchCollectionIntent(CollectionActivity.newIntent(this@AccountActivity, account, accountCreationId, info.uid))
    }

    private fun formattedFingerprint(): String? {
        if (!exactAccountStillCurrent()) return null
        try {
            val fingerprint = fingerprintLoaderOverride?.invoke(this, account, accountCreationId)
                ?: EtebaseLocalCache.getEtebase(this, HttpClient.sharedClient, settings).let { etebase ->
                    if (!exactAccountStillCurrent()) return null
                    Utils.prettyFingerprint(etebase.invitationManager.pubkey)
                }
            return fingerprint?.takeIf { exactAccountStillCurrent() }
        } catch (e: Exception) {
            e.printStackTrace()
            return null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // If no accounts exist, go straight to login/signup
        val accountManager = AccountManager.get(this)
        if (accountManager.getAccountsByType(App.accountType).isEmpty()) {
            val intent = Intent(this, LoginActivity::class.java)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            finish()
            return
        }

        // An explicit stale/wrong-type parcel is never allowed to fall back to another account.
        val explicit = intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)
        val expectedCreationId = intent.getStringExtra(EXTRA_CREATION_ID)
        if (explicit != null && !expectedCreationId.isNullOrBlank() &&
            signOutModel.owns(explicit, expectedCreationId) && signOutModel.hasStarted()) {
            attachRetainedSignOut()
            return
        }
        val resolved = io.silentsuite.sync.ui.setup.ExactAccountRouting.validate(
            explicit, expectedCreationId, App.accountType, accountManager)
            ?: if (explicit == null) ActiveAccountManager.getActiveAccount(this) else null
        if (resolved == null) {
                // Safety net — should not happen since we checked above
                val intent = Intent(this, LoginActivity::class.java)
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                finish()
            return
        }
        account = resolved

        // Dashboard/startup permissions are only valid after the exact row has been explicitly
        // completed. READY is intentionally resumable and must show the setup surface instead.
        if (!App.postLoginBootstrapSucceeded || AccountSettings.setupState(accountManager, account,
                bootstrapped = io.silentsuite.sync.ui.setup.PostLoginSetupMigration.isBootstrapped(this)) != io.silentsuite.sync.ui.setup.PostLoginSetupState.COMPLETE) {
            startActivity(io.silentsuite.sync.ui.setup.PostLoginSetupActivity.newIntent(this, account))
            finish()
            return
        }

        // Save as active account
        if (!ActiveAccountManager.setActiveAccount(this, account)) {
            finish()
            return
        }

        title = account.name
        val creationId = accountManager.getUserData(account, AccountSettings.KEY_CREATION_ID)
        if (creationId.isNullOrBlank()) { finish(); return }
        if (io.silentsuite.sync.ui.setup.ExactAccountRouting.validate(
                account, creationId, App.accountType, accountManager) == null) { finish(); return }
        accountCreationId = creationId
        signOutModel.initialize(account, creationId)
        if (!exactAccountStillCurrent()) { finish(); return }
        settings = AccountSettings(this, account)
        if (!exactAccountStillCurrent()) { finish(); return }
        pendingExportKind = savedInstanceState?.getString(KEY_PENDING_EXPORT_KIND)?.let { name ->
            runCatching { AndroidExportKind.valueOf(name) }.getOrNull()
        }
        // This marker belongs to the Activity Result registration, rather than the global
        // "asked once" preference. Restore it before any resume work can begin.
        notificationPermissionFlow = NotificationPermissionFlow(
            savedInstanceState?.getBoolean(KEY_NOTIFICATION_PERMISSION_PENDING, false) ?: false,
            savedInstanceState?.getBoolean(KEY_STARTUP_PERMISSION_FLOW_STARTED, false) ?: false
        )

        // TODO(Phase2): Set username in Sentry crash reporting context

        setContentView(R.layout.activity_account)
        findViewById<TextView>(R.id.dashboard_account_identity).text = account.name

        // Setup toolbar
        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)

        // Setup drawer
        val drawer = findViewById<DrawerLayout>(R.id.drawer_layout)
        val toggle = ActionBarDrawerToggle(
            this, drawer, toolbar, R.string.navigation_drawer_open, R.string.navigation_drawer_close)
        drawer.addDrawerListener(toggle)
        toggle.syncState()

        // Setup navigation view
        val navigationView = findViewById<NavigationView>(R.id.nav_view)
        navigationView.setNavigationItemSelectedListener(this)

        // Pull-to-refresh: trigger a manual sync for the account (issue #297).
        swipeRefreshLayout = findViewById(R.id.account_swipe_refresh)
        swipeRefreshLayout?.apply {
            setColorSchemeResources(
                    R.color.teal400, R.color.teal500, R.color.teal600, R.color.teal700)
            setOnRefreshListener { onAccountSwipeRefresh() }
        }

        // Setup nav header with account switcher
        setupNavHeader(navigationView)
        signOutModel.state.observe(this) { renderSignOutState(it) }

        // Back press closes drawer first
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val drawerLayout = findViewById<DrawerLayout>(R.id.drawer_layout)
                if (drawerLayout.isDrawerOpen(GravityCompat.START))
                    drawerLayout.closeDrawer(GravityCompat.START)
                else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

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
        val tasksOrgInstalled = packageInstalled(this, tasksOrgPackage)
        val openTasksInstalled = packageInstalled(this, openTasksPackage)
        if (!tasksOrgInstalled) {
            val tasksInstallMenuItem = tbTaskDAV.menu.findItem(R.id.install_tasksorg)
            tasksInstallMenuItem.setVisible(true)
        }
        if (!openTasksInstalled) {
            val tasksInstallMenuItem = tbTaskDAV.menu.findItem(R.id.install_opentasks)
            tasksInstallMenuItem.setVisible(true)
        }

        // Load subscription status
        loadSubscriptionStatus()

        // The ViewModel survives rotation, but each Activity must observe its LiveData.
        // A fresh ViewModel after process death still needs initialization even when Android
        // supplies saved instance state.
        model.initialize(this, account, accountCreationId)
        model.observe(this) {
            updateUi(it)
        }
        if (model.value == null) {
            model.loadAccount()
        }

        requestStartupPermissions()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (signOutOnly) return
        pendingExportKind?.let { outState.putString(KEY_PENDING_EXPORT_KIND, it.name) }
        outState.putBoolean(KEY_NOTIFICATION_PERMISSION_PENDING, notificationPermissionFlow.notificationRequestPending)
        outState.putBoolean(KEY_STARTUP_PERMISSION_FLOW_STARTED, notificationPermissionFlow.runtimePermissionFlowStarted)
    }

    private fun requestStartupPermissions() {
        // An outstanding RequestPermission contract is reattached by ActivityResultRegistry. It
        // must keep exclusive ownership of runtime permission UI until its callback arrives.
        dispatchNotificationPermissionAction(notificationPermissionFlow.start(NotificationUtils.shouldRequestPermission(this)))
    }

    private fun dispatchNotificationPermissionAction(action: NotificationPermissionFlow.Action) {
        when (action) {
            NotificationPermissionFlow.Action.LAUNCH_NOTIFICATION_REQUEST -> {
                if (!exactAccountStillCurrent()) return
                NotificationUtils.markPermissionRequested(this)
                if (!exactAccountStillCurrent()) return
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            NotificationPermissionFlow.Action.CONTINUE_RUNTIME_PERMISSIONS -> {
                if (!exactAccountStillCurrent()) return
                val limitedIntegrations = AccountSettings.limitedIntegrations(AccountManager.get(this), account)
                if (!limitedIntegrations && exactAccountStillCurrent())
                    permissionRequestOverride?.invoke(this) ?: PermissionsActivity.requestAllPermissions(this)
            }
            NotificationPermissionFlow.Action.WAIT_FOR_NOTIFICATION_RESULT,
            NotificationPermissionFlow.Action.NONE -> Unit
        }
    }

    @VisibleForTesting
    internal fun continueRuntimePermissionsForTesting() =
        dispatchNotificationPermissionAction(NotificationPermissionFlow.Action.CONTINUE_RUNTIME_PERMISSIONS)

    private fun setupNavHeader(navigationView: NavigationView) {
        val headerView = navigationView.getHeaderView(0)
        val userEmailView = headerView?.findViewById<TextView>(R.id.nav_user_email)
        val dropdownArrow = headerView?.findViewById<ImageView>(R.id.nav_account_dropdown)
        val accountListContainer = headerView?.findViewById<LinearLayout>(R.id.nav_account_list)
        val accountHeader = headerView?.findViewById<LinearLayout>(R.id.nav_account_header)
        val addAccountRow = headerView?.findViewById<LinearLayout>(R.id.nav_add_account_row)

        // Display current account email
        userEmailView?.text = account.name

        val accountManager = AccountManager.get(this)
        val accounts = accountManager.getAccountsByType(App.accountType)

        dropdownArrow?.visibility = if (AccountSwitcherPolicy.canExpand(accounts.size)) View.VISIBLE else View.GONE
        accountHeader?.contentDescription = getString(R.string.account_switcher_description, account.name)
        fun renderExpansion() {
            accountListContainer?.visibility = if (accountListExpanded) View.VISIBLE else View.GONE
            dropdownArrow?.rotation = if (accountListExpanded) 180f else 0f
            accountHeader?.let { ViewCompat.setStateDescription(it, getString(if (accountListExpanded)
                R.string.account_switcher_expanded else R.string.account_switcher_collapsed)) }
        }
        accountHeader?.setOnClickListener {
            accountListExpanded = !accountListExpanded
            renderExpansion()
        }
        renderExpansion()
        buildAccountList(accountListContainer, accounts)

        // Add account row
        addAccountRow?.setOnClickListener {
            startActivity(Intent(this, LoginActivity::class.java))
        }
    }

    private fun buildAccountList(container: LinearLayout?, accounts: Array<Account>) {
        if (container == null) return

        // Remove any previously added account rows (keep the divider and add-account row)
        // Remove all views except the last two (divider + add account row)
        while (container.childCount > 2) {
            container.removeViewAt(0)
        }

        val manager = AccountManager.get(this)
        val ordered = accounts.mapNotNull { acc ->
            manager.getUserData(acc, AccountSettings.KEY_CREATION_ID)?.takeIf(String::isNotBlank)?.let {
                ExactAccountIdentity(acc.type, acc.name, it) to acc
            }
        }.sortedWith(compareBy({ it.first.name }, { it.first.creationId }, { it.first.type }))
        val rowIds = accountRowViewIds(ordered.map { it.first })
        for ((identity, acc) in ordered) {
            val row = LayoutInflater.from(this).inflate(R.layout.nav_account_row, container, false)
            row.id = rowIds.getValue(identity)
            val textView = row.findViewById<TextView>(R.id.nav_account_name)
            val currentIndicator = row.findViewById<View>(R.id.nav_account_current_indicator)
            textView.text = acc.name
            val isCurrent = identity.type == account.type && identity.name == account.name &&
                identity.creationId == manager.getUserData(account, AccountSettings.KEY_CREATION_ID)
            row.isSelected = isCurrent
            row.contentDescription = getString(R.string.account_switcher_account_description, acc.name)
            ViewCompat.setStateDescription(row, getString(if (isCurrent)
                R.string.account_switcher_current else R.string.account_switcher_not_current))
            currentIndicator.visibility = if (isCurrent) View.VISIBLE else View.INVISIBLE

            row.setOnClickListener {
                if (!isCurrent) {
                    if (!ActiveAccountManager.setActiveAccount(this, acc)) return@setOnClickListener
                    // Recreate activity with new account
                    val intent = newIntent(this, acc)
                    intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(intent)
                    finish()
                }
            }

            // Insert before the divider (at position 0)
            container.addView(row, container.childCount - 2)
        }
    }

    override fun onResume() {
        super.onResume()
        if (signOutOnly) return
        onStatusChanged(SYNC_OBSERVER_TYPE_SETTINGS)
        syncStatusObserver = ContentResolver.addStatusChangeListener(SYNC_OBSERVER_TYPE_SETTINGS, this)
        // Drive the pull-to-refresh spinner from active sync state so it clears
        // reliably when the sync finishes (success or error).
        syncActiveObserver = ContentResolver.addStatusChangeListener(SYNC_OBSERVER_TYPE_ACTIVE) { _ ->
            swipeRefreshLayout?.post { updateSwipeRefreshState() }
        }
        updateSwipeRefreshState()
    }

    override fun onPause() {
        super.onPause()
        if (syncStatusObserver != null) {
            ContentResolver.removeStatusChangeListener(syncStatusObserver)
            syncStatusObserver = null
        }
        syncActiveObserver?.let { ContentResolver.removeStatusChangeListener(it) }
        syncActiveObserver = null
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        if (signOutOnly) return false
        menuInflater.inflate(R.menu.activity_account, menu)
        val busy = signOutModel.state.value is CurrentAccountSignOutState.Removing ||
            signOutModel.state.value is CurrentAccountSignOutState.CleaningUp
        menu.findItem(R.id.nav_logout)?.isEnabled = !busy
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.sync_now -> {
                requestSync()
                true
            }
            R.id.account_show_fingerprint -> { showFingerprintDialog(); true }
            R.id.account_export_data -> { showExportDialog(); true }
            else -> super.onOptionsItemSelected(item)
        }
    }

    private fun showFingerprintDialog() {
        if (!exactAccountStillCurrent()) return
        if (supportFragmentManager.findFragmentByTag(FingerprintDialogFragment.TAG) == null) {
            FingerprintDialogFragment.newInstance(account, accountCreationId)
                .show(supportFragmentManager, FingerprintDialogFragment.TAG)
        }
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
                launchCollectionIntent(CollectionActivity.newCreateCollectionIntent(this@AccountActivity, account, accountCreationId, ETEBASE_TYPE_CALENDAR))
            }
            R.id.create_tasklist -> {
                launchCollectionIntent(CollectionActivity.newCreateCollectionIntent(this@AccountActivity, account, accountCreationId, ETEBASE_TYPE_TASKS))
            }
            R.id.create_addressbook -> {
                launchCollectionIntent(CollectionActivity.newCreateCollectionIntent(this@AccountActivity, account, accountCreationId, ETEBASE_TYPE_ADDRESS_BOOK))
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

    // NavigationView drawer item handling (moved from AccountsActivity)
    override fun onNavigationItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.nav_about -> startActivity(Intent(this, AboutActivity::class.java))
            R.id.nav_app_settings -> launchExactAccountRoute(
                AppSettingsActivity.newIntent(this, account, accountCreationId))
            R.id.nav_invitations -> launchExactAccountRoute(
                InvitationsActivity.newIntent(this, account, accountCreationId))
            R.id.nav_logout -> confirmLogout()
            R.id.nav_sync_overview -> Unit
        }

        val drawer = findViewById<DrawerLayout>(R.id.drawer_layout)
        drawer.closeDrawer(GravityCompat.START)
        return true
    }

    private fun showExportDialog() {
        if (!exactAccountStillCurrent()) return
        val exportKinds = AndroidExportKind.values()
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.export_data_title)
            .setItems(exportKinds.map { it.displayName }.toTypedArray()) { _, which ->
                createExportDocument(exportKinds[which])
            }
            .show()
    }

    private fun createExportDocument(kind: AndroidExportKind) {
        if (!exactAccountStillCurrent()) return
        pendingExportKind = kind
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = kind.mimeType
            putExtra(Intent.EXTRA_TITLE, AndroidDataExporter.suggestedFileName(kind))
        }
        exportDocumentLauncherOverride?.invoke(intent) ?: startActivityForResult(intent, REQUEST_CREATE_EXPORT_DOCUMENT)
    }

    @VisibleForTesting
    internal fun beginExportForTesting(kind: AndroidExportKind) = createExportDocument(kind)

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_CREATE_EXPORT_DOCUMENT)
            return

        val kind = pendingExportKind.also { pendingExportKind = null } ?: return
        val uri = if (resultCode == Activity.RESULT_OK) data?.data else null
        if (uri == null)
            return
        if (!exactAccountStillCurrent()) return

        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    // Recheck after the document picker returned and immediately before every
                    // private-cache/content or external-write boundary.
                    if (!exactAccountStillCurrent()) return@withContext false
                    val outputStream = contentResolver.openOutputStream(uri)
                        ?: throw IOException("Could not open export destination")
                    outputStream.use {
                        if (!exactAccountStillCurrent()) return@withContext false
                        (exportWriterOverride ?: { context: Context, exact: Account, creationId: String,
                            exportKind: AndroidExportKind, stream: OutputStream ->
                            AndroidDataExporter.writeExport(context, exact, creationId, exportKind, stream)
                        })(this@AccountActivity, account, accountCreationId, kind, it)
                    }
                    exactAccountStillCurrent()
                }
                .takeIf { it && exactAccountStillCurrent() } ?: return@launch
                Snackbar.make(findViewById(R.id.coordinator), R.string.export_data_success, Snackbar.LENGTH_LONG).show()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                Logger.log.log(Level.SEVERE, "Android data export failed", e)
                if (!exactAccountStillCurrent()) return@launch
                Snackbar.make(findViewById(R.id.coordinator), R.string.export_data_failed, Snackbar.LENGTH_LONG).show()
            }
        }
    }

    @VisibleForTesting
    internal fun deliverActivityResultForTesting(requestCode: Int, resultCode: Int, data: Intent?) =
        onActivityResult(requestCode, resultCode, data)

    // SyncStatusObserver (moved from AccountsActivity)
    override fun onStatusChanged(which: Int) {
        if (!exactAccountStillCurrent()) return
        runOnUiThread {
            if (!exactAccountStillCurrent()) return@runOnUiThread
            if (syncStatusSnackbar != null) {
                syncStatusSnackbar!!.dismiss()
                syncStatusSnackbar = null
            }

            if (!ContentResolver.getMasterSyncAutomatically()) {
                syncStatusSnackbar = Snackbar.make(findViewById(R.id.coordinator), R.string.accounts_global_sync_disabled, Snackbar.LENGTH_INDEFINITE)
                        .setAction(R.string.accounts_global_sync_enable) {
                            if (!exactAccountStillCurrent()) return@setAction
                            masterSyncEnableOverride?.invoke() ?: ContentResolver.setMasterSyncAutomatically(true)
                            if (!exactAccountStillCurrent()) return@setAction
                            model.loadAccount()
                        }
                syncStatusSnackbar!!.show()
            }
            model.loadAccount()
        }
    }

    private fun confirmLogout() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.account_delete_confirmation_title)
            .setMessage(R.string.account_delete_confirmation_text)
            .setPositiveButton(R.string.navigation_drawer_logout) { _, _ ->
                signOutModel.begin()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun showThemeDialog() {
        val themes = arrayOf(
            getString(R.string.settings_theme_light),
            getString(R.string.settings_theme_dark),
            getString(R.string.settings_theme_system)
        )
        val prefs = AppPreferences(this)
        val currentMode = prefs.themeMode
        val checkedItem = when (currentMode) {
            AppCompatDelegate.MODE_NIGHT_NO -> 0
            AppCompatDelegate.MODE_NIGHT_YES -> 1
            else -> 2
        }

        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.navigation_drawer_theme)
            .setSingleChoiceItems(themes, checkedItem) { dialog, which ->
                val mode = when (which) {
                    0 -> AppCompatDelegate.MODE_NIGHT_NO
                    1 -> AppCompatDelegate.MODE_NIGHT_YES
                    else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
                }
                prefs.themeMode = mode
                AppCompatDelegate.setDefaultNightMode(mode)
                dialog.dismiss()
            }
            .show()
    }

    private fun attachRetainedSignOut() {
        signOutOnly = true
        setContentView(R.layout.activity_account)
        signOutModel.state.observe(this) { renderSignOutState(it) }
    }

    private fun renderSignOutState(state: CurrentAccountSignOutState) {
        invalidateOptionsMenu()
        findViewById<NavigationView>(R.id.nav_view).menu.findItem(R.id.nav_logout)?.isEnabled =
            state !is CurrentAccountSignOutState.Removing && state !is CurrentAccountSignOutState.CleaningUp
        val errorId = when (state) {
            is CurrentAccountSignOutState.RemovalFailed -> state.errorId
            is CurrentAccountSignOutState.CleanupFailed -> state.errorId
            else -> null
        }
        if (errorId != null && errorId > renderedSignOutErrorId) {
            renderedSignOutErrorId = errorId
            signOutErrorSnackbar?.dismiss()
            val message = if (state is CurrentAccountSignOutState.CleanupFailed)
                R.string.account_sign_out_cleanup_failed else R.string.account_sign_out_failed
            signOutErrorSnackbar = Snackbar.make(findViewById(R.id.coordinator), message, Snackbar.LENGTH_INDEFINITE)
                .setAction(R.string.retry) { signOutModel.begin() }.also { it.show() }
        }
        if (state is CurrentAccountSignOutState.Complete && !signOutCompletionHandled) {
            signOutCompletionHandled = true
            signOutErrorSnackbar?.dismiss()
            val replacement = state.replacement
            val intent = if (replacement == null) Intent(this, LoginActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
            } else newIntent(
                this,
                Account(replacement.name, replacement.type),
                replacement.creationId,
            ).apply {
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            finish()
        }
    }

    /* LOADERS AND LOADED DATA */

    class AccountInfo {
        internal var loadFailed: Boolean = false
        internal var carddav: ServiceInfo? = null
        internal var caldav: ServiceInfo? = null
        internal var taskdav: ServiceInfo? = null

        class ServiceInfo {
            internal var refreshing: Boolean = false
            internal var status: SyncStatusStore.Status? = null

            internal var infos: List<CollectionListItemInfo>? = null
        }
    }

    override fun refresh() {
        model.loadAccount()
    }

    fun updateUi(info: AccountInfo) {
        accountInfo = info
        accountInfoDeliveryCount++

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
            val hasTaskProvider = hasSupportedTaskProvider()

            listTaskDAV = findViewById<View>(R.id.tasklists) as ListView
            listTaskDAV!!.isEnabled = !info.taskdav!!.refreshing
            listTaskDAV!!.setAlpha(if (info.taskdav!!.refreshing) 0.5f else 1f)

            val adapter = CollectionListAdapter(this, account)
            adapter.addAll(info.taskdav!!.infos!!)
            listTaskDAV!!.adapter = adapter
            listTaskDAV!!.onItemClickListener = onItemClickListener

            val opentasksWarning = findViewById<View>(R.id.taskdav_opentasks_warning)
            opentasksWarning.visibility = if (hasTaskProvider) View.GONE else View.VISIBLE
        }
        renderDashboard(info)
    }

    private data class DashboardServiceUi(
        val title: Int,
        val statusView: Int,
        val detailView: Int,
        val iconView: Int,
        val rowView: Int,
        val collectionView: Int,
        val destination: Int,
        val model: AccountDashboardModel,
        val status: SyncStatusStore.Status?,
    )

    private fun renderDashboard(info: AccountInfo) {
        val master = ContentResolver.getMasterSyncAutomatically()
        val manager = AccountManager.get(this)
        val setupComplete = AccountSettings.setupState(manager, account,
            io.silentsuite.sync.ui.setup.PostLoginSetupMigration.isBootstrapped(this)) ==
            io.silentsuite.sync.ui.setup.PostLoginSetupState.COMPLETE
        val calendarPermissions = permissionsReady(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
        val contactsPermissions = permissionsReady(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)
        val taskProvider = TaskProviderHandling.getWantedTaskSyncProvider(this)
        val taskPermissions = taskProvider?.permissions?.all { permission ->
            ContextCompat.checkSelfPermission(this, permission) == android.content.pm.PackageManager.PERMISSION_GRANTED
        } ?: true

        fun reduce(service: AccountInfo.ServiceInfo?, permission: Boolean, provider: Boolean = true) =
            reduceAccountDashboardState(AccountDashboardInput(
                loaded = service != null,
                loadFailed = info.loadFailed,
                running = service?.refreshing == true,
                setupComplete = setupComplete,
                masterSyncEnabled = master,
                permissionReady = permission,
                providerReady = provider,
                collectionsAvailable = service?.infos?.isNotEmpty() == true,
                status = service?.status,
            ))

        val services = listOf(
            DashboardServiceUi(R.string.settings_caldav, R.id.caldav_status, R.id.caldav_status_detail,
                R.id.caldav_status_icon, R.id.caldav_status_row, R.id.caldav, R.string.dashboard_calendar_destination,
                reduce(info.caldav, calendarPermissions), info.caldav?.status),
            DashboardServiceUi(R.string.settings_carddav, R.id.carddav_status, R.id.carddav_status_detail,
                R.id.carddav_status_icon, R.id.carddav_status_row, R.id.carddav, R.string.dashboard_contacts_destination,
                reduce(info.carddav, contactsPermissions), info.carddav?.status),
            DashboardServiceUi(R.string.settings_taskdav, R.id.taskdav_status, R.id.taskdav_status_detail,
                R.id.taskdav_status_icon, R.id.taskdav_status_row, R.id.taskdav, R.string.dashboard_tasks_destination,
                reduce(info.taskdav, taskPermissions, taskProvider != null), info.taskdav?.status),
        )
        services.forEach(::renderServiceStatus)

        val latest = latestMeaningfulResult(services.map { it.status })
        val overall = presentAccountDashboard(aggregateAccountDashboard(services.map { it.model }), latest?.timestamp)
        val statusText = dashboardStatusText(overall)
        val detailText = latest?.let { result ->
            val relative = relativeTime(result.timestamp)
            getString(if (result.success) R.string.dashboard_last_success else R.string.dashboard_last_issue, relative)
        } ?: getString(R.string.dashboard_waiting_for_results)
        val statusView = findViewById<TextView>(R.id.dashboard_overall_status)
        val detailView = findViewById<TextView>(R.id.dashboard_last_result)
        val row = findViewById<View>(R.id.dashboard_status_row)
        val shouldAnnounce = model.shouldAnnounce(overall)
        ViewCompat.setAccessibilityLiveRegion(row, if (shouldAnnounce)
            ViewCompat.ACCESSIBILITY_LIVE_REGION_POLITE else ViewCompat.ACCESSIBILITY_LIVE_REGION_NONE)
        statusView.text = statusText
        detailView.text = detailText
        row.contentDescription = "$statusText. $detailText"
        applyDashboardVisual(findViewById(R.id.dashboard_status_icon), statusView, overall)
        renderDashboardAction(overall.action,
            services.firstOrNull { it.model.state == AccountDashboardState.SETUP_REQUIRED }?.collectionView)
    }

    private fun renderServiceStatus(service: DashboardServiceUi) {
        val result = latestMeaningfulResult(listOf(service.status))
        val presentation = presentAccountDashboard(service.model, result?.timestamp)
        val statusText = dashboardStatusText(presentation)
        val detailText = result?.let {
            getString(if (it.success) R.string.dashboard_last_success else R.string.dashboard_last_issue, relativeTime(it.timestamp))
        } ?: getString(service.destination)
        val statusView = findViewById<TextView>(service.statusView)
        statusView.text = statusText
        findViewById<TextView>(service.detailView).text = detailText
        findViewById<View>(service.rowView).contentDescription =
            "${getString(service.title)}. $statusText. $detailText"
        applyDashboardVisual(findViewById(service.iconView), statusView, presentation)
    }

    private fun dashboardStatusText(presentation: AccountDashboardPresentation): String = when (presentation.label) {
        AccountDashboardLabel.CHECKING -> getString(R.string.dashboard_status_checking)
        AccountDashboardLabel.SYNCING -> getString(R.string.dashboard_status_syncing)
        AccountDashboardLabel.NEVER_SYNCED -> getString(R.string.dashboard_status_never_synced)
        AccountDashboardLabel.SYNCED -> getString(R.string.dashboard_status_synced,
            presentation.lastMeaningfulAt?.let(::relativeTime) ?: getString(R.string.dashboard_recently))
        AccountDashboardLabel.NEEDS_ATTENTION -> getString(R.string.dashboard_status_needs_attention)
        AccountDashboardLabel.SYNC_PAUSED -> getString(R.string.dashboard_status_paused)
        AccountDashboardLabel.PERMISSION_NEEDED -> getString(R.string.dashboard_status_permission_needed)
        AccountDashboardLabel.TASK_APP_NEEDED -> getString(R.string.dashboard_status_task_app_needed)
        AccountDashboardLabel.SETUP_NEEDED -> getString(R.string.dashboard_status_setup_needed)
    }

    private fun relativeTime(timestamp: Long): CharSequence = DateUtils.getRelativeTimeSpanString(
        timestamp, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE)

    private fun applyDashboardVisual(icon: ImageView, text: TextView, presentation: AccountDashboardPresentation) {
        icon.setImageResource(when (presentation.icon) {
            AccountDashboardIcon.PROGRESS, AccountDashboardIcon.SYNC -> R.drawable.ic_sync_dark
            AccountDashboardIcon.HISTORY -> R.drawable.ic_status_history
            AccountDashboardIcon.SUCCESS -> R.drawable.ic_status_success
            AccountDashboardIcon.WARNING -> R.drawable.ic_error_dark
            AccountDashboardIcon.PAUSED -> R.drawable.ic_status_paused
            AccountDashboardIcon.PERMISSION -> R.drawable.ic_status_permission
            AccountDashboardIcon.PROVIDER -> R.drawable.ic_status_provider
        })
        val color = ContextCompat.getColor(this, when (presentation.tone) {
            AccountDashboardTone.NEUTRAL -> R.color.semantic_outline
            AccountDashboardTone.PRIMARY -> R.color.semantic_primary
            AccountDashboardTone.SUCCESS -> R.color.semantic_success
            AccountDashboardTone.WARNING -> R.color.semantic_warning
            AccountDashboardTone.ERROR -> R.color.semantic_error
        })
        icon.setColorFilter(color)
        text.setTextColor(color)
    }

    private fun renderDashboardAction(action: AccountDashboardAction, setupTarget: Int?) {
        val button = findViewById<com.google.android.material.button.MaterialButton>(R.id.dashboard_context_action)
        button.visibility = if (action == AccountDashboardAction.NONE) View.GONE else View.VISIBLE
        button.setText(when (action) {
            AccountDashboardAction.NONE -> R.string.account_synchronize_now
            AccountDashboardAction.SYNC_NOW -> R.string.account_synchronize_now
            AccountDashboardAction.RETRY_SYNC -> R.string.dashboard_retry_sync
            AccountDashboardAction.ENABLE_SYNC -> R.string.dashboard_enable_sync
            AccountDashboardAction.FIX_PERMISSIONS -> R.string.dashboard_fix_permissions
            AccountDashboardAction.INSTALL_TASK_APP -> R.string.dashboard_install_task_app
            AccountDashboardAction.REVIEW_SETUP -> R.string.dashboard_review_setup
        })
        button.setOnClickListener {
            when (action) {
                AccountDashboardAction.NONE -> Unit
                AccountDashboardAction.SYNC_NOW, AccountDashboardAction.RETRY_SYNC -> requestSync()
                AccountDashboardAction.ENABLE_SYNC -> {
                    if (!exactAccountStillCurrent()) return@setOnClickListener
                    masterSyncEnableOverride?.invoke() ?: ContentResolver.setMasterSyncAutomatically(true)
                    if (!exactAccountStillCurrent()) return@setOnClickListener
                    model.loadAccount()
                }
                AccountDashboardAction.FIX_PERMISSIONS -> {
                    if (!exactAccountStillCurrent()) return@setOnClickListener
                    val intent = Intent(this, PermissionsActivity::class.java)
                    permissionRemediationLauncherOverride?.invoke(intent) ?: startActivity(intent)
                }
                AccountDashboardAction.INSTALL_TASK_APP -> installPackage(tasksOrgPackage)
                AccountDashboardAction.REVIEW_SETUP -> setupTarget?.let { target ->
                    findViewById<ScrollView>(R.id.parent).smoothScrollTo(0, findViewById<View>(target).top)
                }
            }
        }
    }

    @VisibleForTesting
    internal fun renderDashboardActionForTesting(action: AccountDashboardAction) =
        renderDashboardAction(action, null)

    private fun permissionsReady(vararg permissions: String) = permissions.all {
        ContextCompat.checkSelfPermission(this, it) == android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    private fun hasSupportedTaskProvider() =
            TaskProviderHandling.getWantedTaskSyncProvider(this) != null


    class AccountInfoViewModel : ViewModel(), AccountUpdateService.RefreshingStatusListener, ServiceConnection, SyncStatusObserver {
        private val holder = MutableLiveData<AccountActivity.AccountInfo>()
        private lateinit var context: Context
        private lateinit var account: Account
        private lateinit var accountCreationId: String
        private var davService: AccountUpdateService.InfoBinder? = null
        private var syncStatusListener: Any? = null
        private var serviceBound = false
        private var initializedIdentity: ExactAccountIdentity? = null
        private val dashboardTransitionDeduper = MeaningfulDashboardTransitionDeduper()
        private val latestLoad = LatestRequestWins<AccountActivity.AccountInfo>()
        private var loadJob: Job? = null
        @Volatile private var cleared = false

        fun shouldAnnounce(presentation: AccountDashboardPresentation) =
            dashboardTransitionDeduper.shouldAnnounce(presentation)

        fun initialize(context: Context, account: Account, creationId: String) {
            require(creationId.isNotBlank()) { "Account creation ID must be nonblank" }
            val identity = ExactAccountIdentity(account.type, account.name, creationId)
            if (initializedIdentity == identity)
                return
            check(initializedIdentity == null) { "AccountInfoViewModel cannot be reused for another exact account" }
            this.context = context.applicationContext
            this.account = account
            this.accountCreationId = creationId
            initializedIdentity = identity

            syncStatusListener = ContentResolver.addStatusChangeListener(SYNC_OBSERVER_TYPE_ACTIVE, this)

            context.bindService(Intent(context, AccountUpdateService::class.java), this, Context.BIND_AUTO_CREATE)
        }

        @Synchronized
        fun loadAccount() {
            if (cleared) return
            val request = latestLoad.begin()
            loadJob?.cancel()
            loadJob = viewModelScope.launch {
                var ordinaryFailure = false
                val info = try {
                    withContext(Dispatchers.IO) {
                        if (exactGenerationStillCurrent()) doLoad() else null
                    }
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    Logger.log.log(Level.SEVERE, "AccountInfoViewModel.loadAccount failed", e)
                    ordinaryFailure = true
                    null
                }
                // The IO loader validates after private reads. Validate on the publishing thread
                // too, so a replacement between completion and delivery cannot update this UI.
                if (info != null && !cleared && exactGenerationStillCurrent()) {
                    latestLoad.publishIfLatest(request, info) { holder.value = it }
                } else if (ordinaryFailure && !cleared && exactGenerationStillCurrent() && holder.value == null) {
                    // An initial ordinary failure is terminal evidence, not perpetual loading.
                    // Refresh failures retain the last valid dashboard instead.
                    latestLoad.publishIfLatest(request, AccountActivity.AccountInfo().apply {
                        loadFailed = true
                    }) { holder.value = it }
                }
            }
        }

        override fun onCleared() {
            synchronized(this) {
                cleared = true
                // Cancellation alone is insufficient for blocking IO. Invalidate first so a
                // completion already returning to the main dispatcher cannot publish afterward.
                latestLoad.invalidate()
                loadJob?.cancel()
                loadJob = null
            }
            davService?.removeRefreshingStatusListener(this)
            if (serviceBound) {
                try {
                    context.unbindService(this)
                } catch (e: IllegalArgumentException) {
                    // The service connection can be reported as connected while Android
                    // has already dropped the registration during fast activity teardown.
                    Logger.log.fine("Account update service was already unbound")
                } finally {
                    serviceBound = false
                }
            }

            if (syncStatusListener != null) {
                ContentResolver.removeStatusChangeListener(syncStatusListener)
                syncStatusListener = null
            }
        }

        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            serviceBound = true
            davService = service as AccountUpdateService.InfoBinder
            davService!!.addRefreshingStatusListener(this, false)

            loadAccount()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            davService = null
            serviceBound = false
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
                return etebaseLocalCache.collectionList(colMgr)
                    .filter { it.collectionType == strType }
                    .map {
                        val meta = it.meta
                        val accessLevel = it.col.accessLevel
                        val isReadOnly = accessLevel == CollectionAccessLevel.ReadOnly
                        val isAdmin = accessLevel == CollectionAccessLevel.Admin

                        val metaColor = meta.color
                        val color = if (!metaColor.isNullOrBlank()) LocalCalendar.parseColor(metaColor) else null
                        CollectionListItemInfo(it.col.uid, type, meta.name!!, meta.description
                                ?: "", color, isReadOnly, isAdmin)
                    }
            }
        }

        private fun exactGenerationStillCurrent() =
            io.silentsuite.sync.ui.setup.ExactAccountRouting.validate(
                account, accountCreationId, App.accountType, AccountManager.get(context)
            ) != null

        private fun doLoad(): AccountActivity.AccountInfo? {
            accountLoaderOverride?.let { loader ->
                // Test loaders represent the complete private-load boundary and receive the
                // retained generation explicitly, never a name-keyed re-read.
                if (!exactGenerationStillCurrent()) return null
                return loader(context, account, accountCreationId)
                    .takeIf { exactGenerationStillCurrent() }
            }
            val info = AccountActivity.AccountInfo()
            val settings: AccountSettings
            val etebaseLocalCache: EtebaseLocalCache
            val colMgr: CollectionManager
            try {
                // Settings/cache/session are account-name keyed. A same-name replacement must
                // never be allowed to supply data to this retained generation.
                if (!exactGenerationStillCurrent()) return null
                settings = AccountSettings(context, account)
                if (!exactGenerationStillCurrent()) return null
                etebaseLocalCache = EtebaseLocalCache.getInstance(context, account.name)
                if (!exactGenerationStillCurrent()) return null
                val httpClient = HttpClient.Builder(context).build().okHttpClient
                // Issue #119: getEtebase throws IllegalStateException when userData hasn't yet
                // propagated (first-login race) or when the persisted session is genuinely
                // missing. Previously this propagated to viewModelScope.launch and crashed the
                // app via the default uncaught-exception handler. Preserve any prior successful
                // dashboard model; an ordinary current-generation failure must not synthesize an
                // empty model over it.
                if (!exactGenerationStillCurrent()) return null
                val etebase = EtebaseLocalCache.getEtebase(context, httpClient, settings)
                colMgr = etebase.collectionManager
            } catch (e: InvalidAccountException) {
                throw AccountLoadFailure(e)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                Logger.log.log(Level.SEVERE, "AccountInfoViewModel.doLoad failed", e)
                throw AccountLoadFailure(e)
            }

            // Revalidate immediately before status and collection reads from this session/cache.
            if (!exactGenerationStillCurrent()) return null
            val statusStore = SyncStatusStore(context)
            info.carddav = AccountInfo.ServiceInfo()
            info.carddav!!.refreshing = ContentResolver.isSyncActive(account, App.addressBooksAuthority)
            if (!exactGenerationStillCurrent()) return null
            info.carddav!!.status = statusStore.status(account, SyncStatusStore.Service.CONTACTS)
            if (!exactGenerationStillCurrent()) return null
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
            if (!exactGenerationStillCurrent()) return null
            info.caldav!!.status = statusStore.status(account, SyncStatusStore.Service.CALENDAR)
            if (!exactGenerationStillCurrent()) return null
            info.caldav!!.infos = getCollections(etebaseLocalCache, colMgr, CollectionInfo.Type.CALENDAR)

            info.taskdav = AccountInfo.ServiceInfo()
            info.taskdav!!.refreshing = TASK_PROVIDERS.any {
                ContentResolver.isSyncActive(account, it.authority)
            }
            if (!exactGenerationStillCurrent()) return null
            info.taskdav!!.status = statusStore.status(account, SyncStatusStore.Service.TASKS)
            if (!exactGenerationStillCurrent()) return null
            info.taskdav!!.infos = getCollections(etebaseLocalCache, colMgr, CollectionInfo.Type.TASKS)

            // This runs on Dispatchers.IO immediately after the final private read and before
            // the result can reach the publisher.
            return info.takeIf { exactGenerationStillCurrent() }
        }

        fun observe(owner: LifecycleOwner, observer: (AccountActivity.AccountInfo) -> Unit) =
                holder.observe(owner, observer)

        val value: AccountActivity.AccountInfo?
            get() = holder.value

        companion object {
            /** Deterministic no-network instrumentation seam; production leaves this null. */
            @VisibleForTesting
            @JvmField internal var accountLoaderOverride:
                ((Context, Account, String) -> AccountActivity.AccountInfo)? = null
        }

        private class AccountLoadFailure(cause: Throwable) : Exception(cause)
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

            val spoken = mutableListOf(if (TextUtils.isEmpty(info.displayName)) info.uid else info.displayName)
            if (info.description.isNotBlank()) spoken += info.description
            if (info.isReadOnly) spoken += context.getString(R.string.account_collection_read_only_indicator)
            if (!isOwner) spoken += context.getString(R.string.account_collection_shared_indicator)
            v.contentDescription = spoken.joinToString(". ")
            ViewCompat.setImportantForAccessibility(v, ViewCompat.IMPORTANT_FOR_ACCESSIBILITY_YES)
            listOf(R.id.title, R.id.description, R.id.shared, R.id.read_only, R.id.color).forEach { child ->
                ViewCompat.setImportantForAccessibility(v.findViewById(child), ViewCompat.IMPORTANT_FOR_ACCESSIBILITY_NO)
            }

            return v
        }
    }

    /* USER ACTIONS */

    private fun launchCollectionIntent(intent: Intent) {
        if (!exactAccountStillCurrent()) return
        collectionIntentLauncherOverride?.invoke(intent) ?: startActivity(intent)
    }

    private fun launchExactAccountRoute(intent: Intent) {
        if (!exactAccountStillCurrent()) return
        accountRouteLauncherOverride?.invoke(intent) ?: startActivity(intent)
    }

    private fun requestSync() {
        if (!exactAccountStillCurrent()) return
        if (isSyncActive()) return        // don't stack a duplicate concurrent sync
        syncRequestOverride?.invoke(applicationContext, account)
            ?: requestSync(applicationContext, account)
        Snackbar.make(findViewById(R.id.coordinator), R.string.account_synchronizing_now, Snackbar.LENGTH_LONG).show()
    }

    private fun exactAccountStillCurrent() =
        signOutModel.ownsCurrentGeneration() &&
        io.silentsuite.sync.ui.setup.ExactAccountRouting.validate(
            account,
            accountCreationId,
            App.accountType,
            AccountManager.get(this)
        ) != null

    @VisibleForTesting
    internal fun hasObservedRetainedGenerationInvalidation() =
        signOutModel.hasObservedMainGenerationInvalidation()

    /** Pull-to-refresh handler for the account screen. */
    private fun onAccountSwipeRefresh() {
        if (!ContentResolver.getMasterSyncAutomatically()) {
            // onStatusChanged (SETTINGS observer) already surfaces this state via a Snackbar.
            swipeRefreshLayout?.isRefreshing = false
            return
        }
        requestSync()
    }

    /** Syncs the refresh indicator with the current sync state (called by the ACTIVE observer). */
    private fun updateSwipeRefreshState() {
        if (!exactAccountStillCurrent()) {
            swipeRefreshLayout?.isRefreshing = false
            return
        }
        swipeRefreshLayout?.isRefreshing = isSyncActive()
    }

    private fun isSyncActive(): Boolean {
        if (!exactAccountStillCurrent()) return false
        syncActiveOverride?.let { return it(account) }
        val authorities = mutableListOf(App.addressBooksAuthority, CalendarContract.AUTHORITY)
        TaskProviderHandling.getWantedTaskSyncProvider(this)?.authority?.let { authorities.add(it) }
        return authorities.any { ContentResolver.isSyncActive(account, it) }
    }

    private fun loadSubscriptionStatus() {
        val subscriptionCard = findViewById<View>(R.id.subscription_card)
        val planView = findViewById<TextView>(R.id.subscription_plan)
        val statusView = findViewById<TextView>(R.id.subscription_status)
        val trialView = findViewById<TextView>(R.id.subscription_trial)
        val actionButton = findViewById<com.google.android.material.button.MaterialButton>(R.id.subscription_action)

        // Unknown, healthy and routine plan state never occupies the sync overview.
        subscriptionCard.visibility = View.GONE

        lifecycleScope.launch {
            val status = withContext(Dispatchers.IO) {
                if (!exactAccountStillCurrent()) return@withContext null
                val loaded = billingStatusOverride?.invoke(this@AccountActivity, account, accountCreationId)
                    ?: BillingManager.getInstance().getSubscriptionStatus(
                        this@AccountActivity, account, accountCreationId)
                loaded?.takeIf { exactAccountStillCurrent() }
            }
            if (!exactAccountStillCurrent() || status == null) return@launch

            if (status.isUnknown || (!status.isPastDue && !status.isExpiredOrCancelled)) {
                return@launch
            }

            if (!exactAccountStillCurrent()) return@launch
            updateSubscriptionUi(status, planView, statusView, trialView, actionButton)
            if (!exactAccountStillCurrent()) return@launch
            subscriptionCard.visibility = View.VISIBLE
        }
    }

    @VisibleForTesting
    internal fun reloadSubscriptionStatusForTesting() = loadSubscriptionStatus()

    private fun updateSubscriptionUi(
        status: BillingManager.SubscriptionStatus,
        planView: TextView,
        statusView: TextView,
        trialView: TextView,
        actionButton: com.google.android.material.button.MaterialButton
    ) {
        planView.setText(R.string.dashboard_billing_attention)
        trialView.visibility = View.GONE
        statusView.visibility = View.VISIBLE
        statusView.text = when {
            status.isPastDue -> getString(R.string.subscription_status_past_due)
            status.status == "cancelled" -> getString(R.string.subscription_status_cancelled)
            else -> getString(R.string.subscription_status_expired)
        }
        statusView.setTextColor(ContextCompat.getColor(this, R.color.semantic_warning))
        actionButton.visibility = View.VISIBLE
        actionButton.setText(R.string.dashboard_open_account_settings)
        actionButton.setOnClickListener {
            launchExactAccountRoute(AppSettingsActivity.newIntent(this, account, accountCreationId))
        }
    }

    companion object {
        val EXTRA_ACCOUNT = "account"
        internal const val EXTRA_CREATION_ID = AppSettingsActivity.EXTRA_CREATION_ID
        private const val REQUEST_CREATE_EXPORT_DOCUMENT = 7501
        private const val KEY_PENDING_EXPORT_KIND = "pendingExportKind"
        private const val KEY_NOTIFICATION_PERMISSION_PENDING = "notification_permission_pending"
        private const val KEY_STARTUP_PERMISSION_FLOW_STARTED = "startup_permission_flow_started"
        private const val ACCOUNT_ROW_ID_MIN = 0x02000000
        private const val ACCOUNT_ROW_ID_MAX = 0x02ffffff
        internal fun accountRowViewId(identity: ExactAccountIdentity) =
            ACCOUNT_ROW_ID_MIN or (identity.hashCode() and 0x00ffffff)

        internal fun accountRowViewIds(identities: List<ExactAccountIdentity>): Map<ExactAccountIdentity, Int> {
            val used = mutableSetOf<Int>()
            return AccountSwitcherPolicy.ordered(identities).associateWith { identity ->
                var rowId = accountRowViewId(identity)
                while (!used.add(rowId))
                    rowId = if (rowId == ACCOUNT_ROW_ID_MAX) ACCOUNT_ROW_ID_MIN else rowId + 1
                rowId
            }
        }
        fun newIntent(context: Context, account: Account): Intent = Intent(context, AccountActivity::class.java)
            .putExtra(EXTRA_ACCOUNT, account)
            .putExtra(EXTRA_CREATION_ID, AccountManager.get(context).getUserData(account, AccountSettings.KEY_CREATION_ID))

        fun newIntent(context: Context, account: Account, creationId: String): Intent {
            require(creationId.isNotBlank()) { "Account creation ID must be nonblank" }
            return Intent(context, AccountActivity::class.java)
                .putExtra(EXTRA_ACCOUNT, account)
                .putExtra(EXTRA_CREATION_ID, creationId)
        }

        /** No-network instrumentation seams; production leaves all three null. */
        @VisibleForTesting
        @JvmField internal var collectionIntentLauncherOverride: ((Intent) -> Unit)? = null
        @VisibleForTesting
        @JvmField internal var syncRequestOverride: ((Context, Account) -> Unit)? = null
        @VisibleForTesting
        @JvmField internal var syncActiveOverride: ((Account) -> Boolean)? = null
        @VisibleForTesting
        @JvmField internal var fingerprintLoaderOverride: ((Context, Account, String) -> String?)? = null
        @VisibleForTesting
        @JvmField internal var exportDocumentLauncherOverride: ((Intent) -> Unit)? = null
        @VisibleForTesting
        @JvmField internal var exportWriterOverride: ((Context, Account, String, AndroidExportKind, OutputStream) -> Unit)? = null
        @VisibleForTesting
        @JvmField internal var billingStatusOverride: ((Context, Account, String) -> BillingManager.SubscriptionStatus)? = null
        @VisibleForTesting
        @JvmField internal var accountRouteLauncherOverride: ((Intent) -> Unit)? = null
        @VisibleForTesting
        @JvmField internal var permissionRequestOverride: ((android.app.Activity) -> Unit)? = null
        @VisibleForTesting
        @JvmField internal var permissionRemediationLauncherOverride: ((Intent) -> Unit)? = null
        @VisibleForTesting
        @JvmField internal var masterSyncEnableOverride: (() -> Unit)? = null
    }

}
