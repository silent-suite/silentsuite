package io.silentsuite.sync.ui

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.Intent
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.appcompat.widget.Toolbar
import androidx.core.view.ViewCompat
import com.google.android.material.navigation.NavigationView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.dataexport.AndroidExportKind
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.etebase.CollectionActivity
import io.silentsuite.sync.ui.setup.PostLoginSetupState
import io.silentsuite.sync.utils.AndroidCompat
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AccountDashboardRuntimeTest {
    private val generation = "dashboard-generation"
    private val launchedCollectionIntents = mutableListOf<Intent>()
    private val syncRequests = mutableListOf<Pair<Account, String?>>()

    @Test
    fun truthfulDashboardTransitionsUseDurableEvidenceAndDedupeAcrossRecreation() {
        withDashboardAccount { context, account, scenario ->
            var deliveryCount = 0
            scenario.onActivity { activity ->
                assertEquals(account.name, activity.findViewById<TextView>(R.id.dashboard_account_identity).text.toString())
                assertEquals("Never synced", activity.findViewById<TextView>(R.id.caldav_status).text.toString())
                assertFalse(activity.findViewById<View>(R.id.subscription_card).isShown)
                deliveryCount = activity.accountInfoDeliveryCount
                activity.refresh()
            }
            waitForDeliveryAfter(scenario, deliveryCount)
            scenario.onActivity { activity ->
                assertEquals(ViewCompat.ACCESSIBILITY_LIVE_REGION_NONE,
                    ViewCompat.getAccessibilityLiveRegion(activity.findViewById(R.id.dashboard_status_row)))
            }

            val store = SyncStatusStore(context)
            assertTrue(store.recordSuccess(account, SyncStatusStore.Service.CALENDAR, 100))
            scenario.onActivity { it.refresh() }
            waitForText(scenario, R.id.caldav_status) { it.startsWith("Synced") }
            scenario.onActivity { activity ->
                assertTrue(activity.findViewById<TextView>(R.id.caldav_status).text.toString().startsWith("Synced"))
                assertEquals(ViewCompat.ACCESSIBILITY_LIVE_REGION_POLITE,
                    ViewCompat.getAccessibilityLiveRegion(activity.findViewById(R.id.dashboard_status_row)))
            }

            assertTrue(store.recordFailure(account, SyncStatusStore.Service.CALENDAR,
                SyncStatusStore.FailureCategory.NETWORK, 200))
            scenario.onActivity { it.refresh() }
            waitForText(scenario, R.id.caldav_status) { it == "Needs attention" }
            scenario.onActivity { activity ->
                assertEquals("Needs attention", activity.findViewById<TextView>(R.id.caldav_status).text.toString())
                assertEquals(ViewCompat.ACCESSIBILITY_LIVE_REGION_POLITE,
                    ViewCompat.getAccessibilityLiveRegion(activity.findViewById(R.id.dashboard_status_row)))
            }

            scenario.recreate()
            waitForModel(scenario)
            scenario.onActivity { activity ->
                assertEquals(account.name, activity.title.toString())
                assertEquals(account.name, activity.findViewById<TextView>(R.id.dashboard_account_identity).text.toString())
                assertEquals(generation, activity.intent.getStringExtra(AccountActivity.EXTRA_CREATION_ID))
                assertEquals("Needs attention", activity.findViewById<TextView>(R.id.caldav_status).text.toString())
                assertEquals(ViewCompat.ACCESSIBILITY_LIVE_REGION_NONE,
                    ViewCompat.getAccessibilityLiveRegion(activity.findViewById(R.id.dashboard_status_row)))
            }
        }
    }

    @Test
    fun serviceModulesAndCompleteActionsPreserveMetadataAndExactAccountRouting() {
        withDashboardAccount { context, account, scenario ->
            scenario.onActivity { activity ->
                val calendarModule = activity.findViewById<View>(R.id.calendar_service_module)
                val contactsModule = activity.findViewById<View>(R.id.contacts_service_module)
                val tasksModule = activity.findViewById<View>(R.id.tasks_service_module)
                val calendarCollections = activity.findViewById<View>(R.id.caldav)
                assertTrue(calendarModule.top < contactsModule.top)
                assertTrue(contactsModule.top < tasksModule.top)
                assertTrue(tasksModule.top < calendarCollections.top)
                listOf(calendarModule, contactsModule, tasksModule).forEach {
                    assertFalse(it.isClickable)
                    assertFalse(it.hasOnClickListeners())
                }

                val calendarList = activity.listCalDAV!!
                val row = calendarList.adapter.getView(0, null, calendarList)
                assertEquals("Private calendar", row.findViewById<TextView>(R.id.title).text.toString())
                assertEquals("Personal events", row.findViewById<TextView>(R.id.description).text.toString())
                assertEquals(View.VISIBLE, row.findViewById<View>(R.id.color).visibility)
                assertEquals(View.VISIBLE, row.findViewById<View>(R.id.read_only).visibility)
                assertTrue(row.contentDescription.toString().contains("Read-only collection"))
                assertTrue(activity.findViewById<View>(R.id.account_swipe_refresh).isShown)
                assertTrue(activity.findViewById<View>(R.id.dashboard_context_action).isShown)

                // Invoke collection management and creation through the production listeners. The
                // launch seam captures both intents before a destination Activity can load a session.
                assertTrue(calendarList.performItemClick(row, 0, calendarList.adapter.getItemId(0)))
                val createCalendar = requireNotNull(
                    activity.findViewById<Toolbar>(R.id.caldav_menu).menu.findItem(R.id.create_calendar)
                )
                activity.onMenuItemClick(createCalendar)

                // Invoke the explicit toolbar sync control. The seam prevents provider scheduling
                // while proving the exact account selected by the production action.
                val syncNow = requireNotNull(
                    activity.findViewById<Toolbar>(R.id.toolbar).menu.findItem(R.id.sync_now)
                )
                assertTrue(syncNow.isVisible)
                assertTrue(activity.onOptionsItemSelected(syncNow))
            }

            assertEquals(2, launchedCollectionIntents.size)
            val manage = launchedCollectionIntents[0]
            assertEquals(CollectionActivity::class.java.name, manage.component?.className)
            assertEquals(account,
                manage.getParcelableExtra<Account>(CollectionActivity.EXTRA_ACCOUNT))
            assertEquals(generation,
                manage.getStringExtra(CollectionActivity.EXTRA_CREATION_ID))
            assertEquals("uid-CALENDAR",
                manage.getStringExtra(CollectionActivity.EXTRA_COLLECTION_UID))
            assertFalse(manage.hasExtra(CollectionActivity.EXTRA_COLLECTION_TYPE))

            val create = launchedCollectionIntents[1]
            assertEquals(CollectionActivity::class.java.name, create.component?.className)
            assertEquals(account,
                create.getParcelableExtra<Account>(CollectionActivity.EXTRA_ACCOUNT))
            assertEquals(generation,
                create.getStringExtra(CollectionActivity.EXTRA_CREATION_ID))
            assertEquals(Constants.ETEBASE_TYPE_CALENDAR,
                create.getStringExtra(CollectionActivity.EXTRA_COLLECTION_TYPE))
            assertFalse(create.hasExtra(CollectionActivity.EXTRA_COLLECTION_UID))

            assertEquals(listOf(account to generation), syncRequests)

            val manager = AccountManager.get(context)
            scenario.onActivity { activity ->
                assertFalse(activity.hasObservedRetainedGenerationInvalidation())
            }
            removeAccountAndWait(manager, account)
            waitForRetainedGenerationInvalidation(scenario)
            val replacementGeneration = "dashboard-replacement-generation"
            assertTrue(manager.addAccountExplicitly(account, null, Bundle().apply {
                putString(AccountSettings.KEY_CREATION_ID, replacementGeneration)
            }))
            val replacementRow = manager.getAccountsByType(account.type)
                .single { it.name == account.name }
            assertEquals(replacementGeneration,
                manager.getUserData(replacementRow, AccountSettings.KEY_CREATION_ID))
            launchedCollectionIntents.clear()
            syncRequests.clear()

            scenario.onActivity { activity ->
                val calendarList = activity.listCalDAV!!
                val row = calendarList.adapter.getView(0, null, calendarList)
                assertTrue(calendarList.performItemClick(row, 0, calendarList.adapter.getItemId(0)))
                activity.onMenuItemClick(requireNotNull(
                    activity.findViewById<Toolbar>(R.id.caldav_menu).menu.findItem(R.id.create_calendar)
                ))
                assertTrue(activity.onOptionsItemSelected(requireNotNull(
                    activity.findViewById<Toolbar>(R.id.toolbar).menu.findItem(R.id.sync_now)
                )))
            }

            assertTrue(launchedCollectionIntents.isEmpty())
            assertTrue(syncRequests.isEmpty())
            assertTrue(account in manager.getAccountsByType(account.type))
        }
    }

    @Test
    fun retainedLoadRejectsSameNameReplacementBeforePublication() {
        withDashboardAccount { context, account, scenario ->
            val loaderStarted = CountDownLatch(1)
            val releaseLoader = CountDownLatch(1)
            val blockLoader = AtomicBoolean(false)
            AccountActivity.AccountInfoViewModel.accountLoaderOverride = { loaderContext, exact, creationId ->
                check(exact == account)
                check(creationId == generation)
                if (blockLoader.get()) {
                    loaderStarted.countDown()
                    check(releaseLoader.await(10, TimeUnit.SECONDS))
                }
                val store = SyncStatusStore(loaderContext)
                AccountActivity.AccountInfo().apply {
                    caldav = service(CollectionInfo.Type.CALENDAR,
                        store.status(exact, SyncStatusStore.Service.CALENDAR))
                }
            }
            try {
                var deliveriesBefore = 0
                scenario.onActivity { activity ->
                    deliveriesBefore = activity.accountInfoDeliveryCount
                    blockLoader.set(true)
                    activity.refresh()
                }
                assertTrue("generation-bound load never began", loaderStarted.await(10, TimeUnit.SECONDS))

                val manager = AccountManager.get(context)
                removeAccountAndWait(manager, account)
                waitForRetainedGenerationInvalidation(scenario)
                assertTrue(manager.addAccountExplicitly(account, null, Bundle().apply {
                    putString(AccountSettings.KEY_CREATION_ID, "load-replacement-generation")
                }))
                releaseLoader.countDown()
                assertNoAdditionalDelivery(scenario, deliveriesBefore)
            } finally {
                // Never leave the deterministic IO seam blocked if an assertion fails.
                releaseLoader.countDown()
            }
        }
    }

    @Test
    fun initialLoadFailurePublishesTerminalErrorAndRefreshFailureRetainsValidDashboard() {
        val fail = AtomicBoolean(true)
        val loadAttempts = AtomicInteger(0)
        withDashboardAccount(loaderOverride = { loaderContext, exact, creationId ->
            loadAttempts.incrementAndGet()
            check(creationId == generation)
            if (fail.get()) throw IllegalStateException("deterministic initial failure")
            val store = SyncStatusStore(loaderContext)
            AccountActivity.AccountInfo().apply {
                caldav = service(CollectionInfo.Type.CALENDAR, store.status(exact, SyncStatusStore.Service.CALENDAR))
                carddav = service(CollectionInfo.Type.ADDRESS_BOOK, store.status(exact, SyncStatusStore.Service.CONTACTS))
                taskdav = service(CollectionInfo.Type.TASKS, store.status(exact, SyncStatusStore.Service.TASKS))
            }
        }) { _, _, scenario ->
            waitForModel(scenario)
            var deliveriesBefore = 0
            scenario.onActivity { activity ->
                assertEquals("Needs attention", activity.findViewById<TextView>(R.id.dashboard_overall_status).text.toString())
                fail.set(false)
                deliveriesBefore = activity.accountInfoDeliveryCount
                activity.refresh()
            }
            waitForDeliveryAfter(scenario, deliveriesBefore)
            waitForText(scenario, R.id.caldav_status) { it == "Never synced" }
            val attemptsBeforeFailure = loadAttempts.get()
            scenario.onActivity { activity ->
                fail.set(true)
                activity.refresh()
            }
            waitUntil("failed dashboard refresh attempt") {
                loadAttempts.get() > attemptsBeforeFailure
            }
            scenario.onActivity { activity ->
                assertEquals("Never synced", activity.findViewById<TextView>(R.id.caldav_status).text.toString())
            }
        }
    }

    @Test
    fun retainedSurfaceRejectsReplacementBeforePrivateActionsAndRoutes() {
        withDashboardAccount { context, account, scenario ->
            val fingerprints = mutableListOf<String>()
            val routes = mutableListOf<Intent>()
            val exportDocuments = mutableListOf<Intent>()
            var exports = 0
            var billingReads = 0
            var permissionRequests = 0
            var permissionRemediations = 0
            var masterSyncEnables = 0
            AccountActivity.fingerprintLoaderOverride = { _, _, creationId ->
                fingerprints += creationId
                "private-fingerprint"
            }
            AccountActivity.accountRouteLauncherOverride = { routes += Intent(it) }
            AccountActivity.exportDocumentLauncherOverride = { exportDocuments += Intent(it) }
            AccountActivity.exportWriterOverride = { _, _, _, _, _ -> exports += 1 }
            AccountActivity.billingStatusOverride = { _, _, _ ->
                billingReads += 1
                io.silentsuite.sync.billing.BillingManager.SubscriptionStatus(
                    "past_due", null, null, null, null)
            }
            AccountActivity.permissionRequestOverride = { permissionRequests += 1 }
            AccountActivity.permissionRemediationLauncherOverride = { permissionRemediations += 1 }
            AccountActivity.masterSyncEnableOverride = { masterSyncEnables += 1 }
            val masterSyncWasEnabled = android.content.ContentResolver.getMasterSyncAutomatically()
            try {
                lateinit var renderedEnableSync: View
                lateinit var renderedPermissionFix: View
                scenario.onActivity { activity ->
                    // Keep a picker result pending, then replace the generation before it
                    // returns. The writer seam proves the result cannot read or write data.
                    activity.beginExportForTesting(AndroidExportKind.CALENDAR)
                    activity.renderDashboardActionForTesting(io.silentsuite.sync.ui.account.AccountDashboardAction.FIX_PERMISSIONS)
                    renderedPermissionFix = activity.findViewById(R.id.dashboard_context_action)
                    android.content.ContentResolver.setMasterSyncAutomatically(false)
                    activity.onStatusChanged(0)
                }
                waitUntil("global sync Snackbar action") {
                    var action: View? = null
                    scenario.onActivity { activity ->
                        action = activity.findViewById(com.google.android.material.R.id.snackbar_action)
                    }
                    action?.also { renderedEnableSync = it } != null
                }
                assertEquals(1, exportDocuments.size)
                exportDocuments.clear()
                val manager = AccountManager.get(context)
                removeAccountAndWait(manager, account)
                waitForRetainedGenerationInvalidation(scenario)
                assertTrue(manager.addAccountExplicitly(account, null, Bundle().apply {
                    putString(AccountSettings.KEY_CREATION_ID, "retained-surface-replacement")
                }))

                scenario.onActivity { activity ->
                    renderedEnableSync.performClick()
                    renderedPermissionFix.performClick()
                    activity.continueRuntimePermissionsForTesting()
                    val toolbar = activity.findViewById<Toolbar>(R.id.toolbar)
                    assertTrue(activity.onOptionsItemSelected(requireNotNull(
                        toolbar.menu.findItem(R.id.account_show_fingerprint))))
                    assertTrue(activity.onOptionsItemSelected(requireNotNull(
                        toolbar.menu.findItem(R.id.account_export_data))))
                    activity.deliverActivityResultForTesting(7501, android.app.Activity.RESULT_OK, Intent().apply {
                        data = android.net.Uri.parse("content://stale-export")
                    })
                    val navigation = activity.findViewById<NavigationView>(R.id.nav_view)
                    activity.onNavigationItemSelected(requireNotNull(
                        navigation.menu.findItem(R.id.nav_app_settings)))
                    activity.onNavigationItemSelected(requireNotNull(
                        navigation.menu.findItem(R.id.nav_invitations)))
                    activity.reloadSubscriptionStatusForTesting()
                }
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                assertTrue("stale Activity read a replacement fingerprint", fingerprints.isEmpty())
                assertTrue("stale Activity launched a replacement route", routes.isEmpty())
                assertTrue("stale Activity opened an export document", exportDocuments.isEmpty())
                assertEquals("stale Activity wrote replacement export data", 0, exports)
                assertEquals("stale Activity read replacement billing state", 0, billingReads)
                assertEquals("stale Activity requested runtime permissions", 0, permissionRequests)
                assertEquals("stale Activity launched permission remediation", 0, permissionRemediations)
                assertEquals("stale Activity enabled global sync", 0, masterSyncEnables)
            } finally {
                AccountActivity.fingerprintLoaderOverride = null
                AccountActivity.accountRouteLauncherOverride = null
                AccountActivity.exportDocumentLauncherOverride = null
                AccountActivity.exportWriterOverride = null
                AccountActivity.billingStatusOverride = null
                AccountActivity.permissionRequestOverride = null
                AccountActivity.permissionRemediationLauncherOverride = null
                AccountActivity.masterSyncEnableOverride = null
                android.content.ContentResolver.setMasterSyncAutomatically(masterSyncWasEnabled)
            }
        }
    }

    @Test
    fun dashboardExportCompletionPreservesExactDashboardAfterRecreation() {
        withDashboardAccount { context, account, scenario ->
            val launched = mutableListOf<Intent>()
            val writes = mutableListOf<Pair<Account, String>>()
            AccountActivity.exportDocumentLauncherOverride = { launched += Intent(it) }
            AccountActivity.exportWriterOverride = { _, exact, creationId, _, _ ->
                writes += exact to creationId
            }
            try {
                scenario.onActivity { it.beginExportForTesting(AndroidExportKind.CALENDAR) }
                assertEquals(1, launched.size)
                assertEquals(Intent.ACTION_CREATE_DOCUMENT, launched.single().action)
                scenario.recreate()
                waitForModel(scenario)
                scenario.onActivity { activity ->
                    assertEquals(account.name, activity.findViewById<TextView>(R.id.dashboard_account_identity).text.toString())
                    activity.deliverActivityResultForTesting(7501, android.app.Activity.RESULT_OK, Intent().apply {
                        data = android.net.Uri.fromFile(java.io.File(context.cacheDir, "dashboard-export.json"))
                    })
                }
                waitUntil("exact dashboard export completion") { writes.size == 1 }
                waitUntil("rendered dashboard export success") {
                    var rendered = false
                    scenario.onActivity { activity ->
                        rendered = activity.findViewById<TextView>(com.google.android.material.R.id.snackbar_text)
                            ?.text?.toString() == activity.getString(R.string.export_data_success)
                    }
                    rendered
                }
                assertEquals(listOf(account to generation), writes)
                scenario.onActivity { activity ->
                    assertEquals(account.name, activity.findViewById<TextView>(R.id.dashboard_account_identity).text.toString())
                    assertTrue(activity.hasDeliveredAccountInfo)
                }
            } finally {
                AccountActivity.exportDocumentLauncherOverride = null
                AccountActivity.exportWriterOverride = null
            }
        }
    }

    private fun withDashboardAccount(
        loaderOverride: ((Context, Account, String) -> AccountActivity.AccountInfo)? = null,
        block: (android.content.Context, Account, ActivityScenario<AccountActivity>) -> Unit,
    ) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("dashboard-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(account, null, null))
        AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
        check(AccountSettings.writeSetupState(manager, account, PostLoginSetupState.COMPLETE))
        grantCorePermissions(context)
        val previousMasterSync = android.content.ContentResolver.getMasterSyncAutomatically()
        android.content.ContentResolver.setMasterSyncAutomatically(true)
        context.getSharedPreferences("sync_status_v1", 0).edit().clear().commit()
        val previousBootstrap = App.postLoginBootstrapSucceeded
        App.postLoginBootstrapSucceeded = true
        launchedCollectionIntents.clear()
        syncRequests.clear()
        AccountActivity.collectionIntentLauncherOverride = { launchedCollectionIntents += Intent(it) }
        AccountActivity.syncActiveOverride = { false }
        AccountActivity.syncRequestOverride = { _, exact ->
            syncRequests += exact to manager.getUserData(exact, AccountSettings.KEY_CREATION_ID)
        }
        AccountActivity.AccountInfoViewModel.accountLoaderOverride = loaderOverride ?: { loaderContext, exact, creationId ->
            check(exact == account)
            check(creationId == generation)
            val store = SyncStatusStore(loaderContext)
            AccountActivity.AccountInfo().apply {
                caldav = service(CollectionInfo.Type.CALENDAR, store.status(exact, SyncStatusStore.Service.CALENDAR))
                carddav = service(CollectionInfo.Type.ADDRESS_BOOK, store.status(exact, SyncStatusStore.Service.CONTACTS))
                taskdav = service(CollectionInfo.Type.TASKS, store.status(exact, SyncStatusStore.Service.TASKS))
            }
        }
        try {
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(context, account)).use { scenario ->
                waitForModel(scenario)
                block(context, account, scenario)
            }
        } finally {
            AccountActivity.AccountInfoViewModel.accountLoaderOverride = null
            AccountActivity.collectionIntentLauncherOverride = null
            AccountActivity.syncRequestOverride = null
            AccountActivity.syncActiveOverride = null
            AccountActivity.fingerprintLoaderOverride = null
            AccountActivity.exportDocumentLauncherOverride = null
            AccountActivity.exportWriterOverride = null
            AccountActivity.billingStatusOverride = null
            AccountActivity.accountRouteLauncherOverride = null
            android.content.ContentResolver.setMasterSyncAutomatically(previousMasterSync)
            App.postLoginBootstrapSucceeded = previousBootstrap
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
            context.getSharedPreferences("sync_status_v1", 0).edit().clear().commit()
        }
    }

    private fun removeAccountAndWait(manager: AccountManager, account: Account) {
        if (account !in manager.getAccountsByType(account.type)) {
            assertFalse("account row remained during teardown", account in manager.getAccountsByType(account.type))
            return
        }
        val removed = CountDownLatch(1)
        var confirmed = false
        AndroidCompat.removeAccount(manager, account) {
            confirmed = it
            removed.countDown()
        }
        assertTrue("account removal callback timed out", removed.await(10, TimeUnit.SECONDS))
        assertTrue("account removal was not confirmed", confirmed)
        assertFalse("account row remained after confirmed removal", account in manager.getAccountsByType(account.type))
    }

    private fun waitForRetainedGenerationInvalidation(scenario: ActivityScenario<AccountActivity>) {
        repeat(100) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            var observed = false
            scenario.onActivity { observed = it.hasObservedRetainedGenerationInvalidation() }
            if (observed) return
            android.os.SystemClock.sleep(50)
        }
        throw AssertionError("retained OnAccountsUpdateListener did not observe generation absence")
    }

    private fun assertNoAdditionalDelivery(scenario: ActivityScenario<AccountActivity>, deliveriesBefore: Int) {
        repeat(20) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            var deliveries = deliveriesBefore
            scenario.onActivity { deliveries = it.accountInfoDeliveryCount }
            assertEquals("replacement generation published dashboard data", deliveriesBefore, deliveries)
            android.os.SystemClock.sleep(25)
        }
    }

    private fun service(type: CollectionInfo.Type, status: SyncStatusStore.Status) =
        AccountActivity.AccountInfo.ServiceInfo().apply {
            this.status = status
            infos = listOf(AccountActivity.CollectionListItemInfo(
                "uid-${type.name}", type,
                if (type == CollectionInfo.Type.CALENDAR) "Private calendar" else type.name,
                if (type == CollectionInfo.Type.CALENDAR) "Personal events" else "",
                if (type == CollectionInfo.Type.ADDRESS_BOOK) null else 0xff10b981.toInt(),
                isReadOnly = type == CollectionInfo.Type.CALENDAR,
                isAdmin = true,
            ))
        }

    private fun waitForModel(scenario: ActivityScenario<AccountActivity>) {
        repeat(50) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            var delivered = false
            scenario.onActivity { delivered = it.hasDeliveredAccountInfo }
            if (delivered) return
            android.os.SystemClock.sleep(50)
        }
        throw AssertionError("Dashboard model was not delivered")
    }

    private fun waitForDeliveryAfter(scenario: ActivityScenario<AccountActivity>, previous: Int) {
        repeat(200) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            var count = previous
            scenario.onActivity { count = it.accountInfoDeliveryCount }
            if (count > previous) return
            android.os.SystemClock.sleep(50)
        }
        throw AssertionError("Dashboard model was not delivered again")
    }

    private fun waitUntil(description: String, timeoutMillis: Long = 10_000, predicate: () -> Boolean) {
        val deadline = android.os.SystemClock.uptimeMillis() + timeoutMillis
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            if (predicate()) return
            android.os.SystemClock.sleep(50)
        }
        throw AssertionError("Timed out waiting for $description")
    }

    private fun waitForText(scenario: ActivityScenario<AccountActivity>, viewId: Int, predicate: (String) -> Boolean) {
        repeat(200) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            var text = ""
            scenario.onActivity { text = it.findViewById<TextView>(viewId).text.toString() }
            if (predicate(text)) return
            android.os.SystemClock.sleep(50)
        }
        throw AssertionError("Dashboard text did not reach expected state")
    }

    private fun grantCorePermissions(context: android.content.Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        listOf(
            Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR,
            Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS,
        ).forEach {
            InstrumentationRegistry.getInstrumentation().uiAutomation
                .executeShellCommand("pm grant ${context.packageName} $it").close()
        }
    }
}
