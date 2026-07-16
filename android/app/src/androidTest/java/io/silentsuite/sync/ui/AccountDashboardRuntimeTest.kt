package io.silentsuite.sync.ui

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.Intent
import android.os.Build
import android.view.View
import android.widget.TextView
import androidx.appcompat.widget.Toolbar
import androidx.core.view.ViewCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.etebase.CollectionActivity
import io.silentsuite.sync.ui.setup.PostLoginSetupState
import io.silentsuite.sync.utils.AndroidCompat
import java.net.URI
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
        withDashboardAccount { _, account, scenario ->
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
        }
    }

    private fun withDashboardAccount(block: (android.content.Context, Account, ActivityScenario<AccountActivity>) -> Unit) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("dashboard-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(account, null, null))
        AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
        check(AccountSettings.writeSetupState(manager, account, PostLoginSetupState.COMPLETE))
        grantCorePermissions(context)
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
        AccountActivity.AccountInfoViewModel.accountLoaderOverride = { loaderContext, exact ->
            check(exact == account)
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
            App.postLoginBootstrapSucceeded = previousBootstrap
            AndroidCompat.removeAccount(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
            context.getSharedPreferences("sync_status_v1", 0).edit().clear().commit()
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
        repeat(50) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            var count = previous
            scenario.onActivity { count = it.accountInfoDeliveryCount }
            if (count > previous) return
            android.os.SystemClock.sleep(50)
        }
        throw AssertionError("Dashboard model was not delivered again")
    }

    private fun waitForText(scenario: ActivityScenario<AccountActivity>, viewId: Int, predicate: (String) -> Boolean) {
        repeat(50) {
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
