package io.silentsuite.sync.ui

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.view.View
import android.widget.ListView
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.preference.SwitchPreferenceCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.material.navigation.NavigationView
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.NotesSyncPolicy
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.account.SyncLifecycleWindows
import io.silentsuite.sync.ui.etebase.CollectionActivity
import io.silentsuite.sync.ui.notes.NoteContent
import io.silentsuite.sync.ui.notes.NoteListFragment
import io.silentsuite.sync.ui.notes.NoteViewFragment
import io.silentsuite.sync.ui.notes.NotebookListFragment
import io.silentsuite.sync.ui.notes.NotebookRow
import io.silentsuite.sync.ui.notes.NotesActivity
import io.silentsuite.sync.ui.notes.NotesRuntimeFixture
import io.silentsuite.sync.ui.notes.notesFixtureOverride
import io.silentsuite.sync.ui.settings.SettingsCategory
import io.silentsuite.sync.ui.setup.PostLoginSetupState
import io.silentsuite.sync.utils.AndroidCompat
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Notes (experimental) runtime contracts: the per-account toggle, the dashboard's conditional
 * fourth service, shared and read-only notebooks in the Notes screen, and exact-generation plus
 * sign-out protections for the in-app sync job. Every test is offline: the network job is
 * replaced by a seam and the Notes screen reads process-local fixtures.
 */
@RunWith(AndroidJUnit4::class)
class NotesRuntimeTest {
    private val generation = "notes-generation"

    @Test fun notesToggleIsExactAccountScopedAndSyncsImmediately() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val first = Account("notes-first-${System.nanoTime()}@example.invalid", App.accountType)
        val second = Account("notes-second-${System.nanoTime()}@example.invalid", App.accountType)
        listOf(first, second).forEachIndexed { index, account ->
            check(manager.addAccountExplicitly(account, null, null))
            AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "notes-settings-$index"))
        }
        val effects = mutableListOf<Triple<Account, String, Boolean>>()
        AppSettingsActivity.notesToggleEffectOverride = { _, account, creationId, enabled -> effects += Triple(account, creationId, enabled) }
        try {
            ActivityScenario.launch<AppSettingsActivity>(
                AppSettingsActivity.newIntent(context, second, "notes-settings-1", SettingsCategory.ACCOUNT)
            ).use { scenario ->
                scenario.onActivity { activity ->
                    val toggle = notesToggle(activity)
                    assertTrue(toggle.isEnabled)
                    assertFalse(toggle.isChecked)
                    toggle.performClick()
                }
                assertTrue(AccountSettings.notesEnabled(manager, second))
                assertFalse("the sibling account keeps its own opt-in", AccountSettings.notesEnabled(manager, first))
                assertEquals(listOf(Triple(second, "notes-settings-1", true)), effects)
                scenario.recreate()
                val toggleAfterClick = AtomicReference("")
                scenario.onActivity { activity ->
                    val toggle = notesToggle(activity)
                    assertTrue("the opt-in survives recreation", toggle.isChecked)
                    toggle.performClick()
                    toggleAfterClick.set("checked=${toggle.isChecked} enabled=${toggle.isEnabled} selected=${activity.selectedAccount} " +
                        "exact=${activity.exactSelectedAccount()} raw=${manager.getUserData(second, AccountSettings.KEY_NOTES_ENABLED)}")
                }
                assertEquals("turning Notes off routes through the same exact-account listener; ${toggleAfterClick.get()}",
                    listOf(Triple(second, "notes-settings-1", true), Triple(second, "notes-settings-1", false)), effects)
                assertFalse("Notes stays enabled after turning it off; ${toggleAfterClick.get()}", AccountSettings.notesEnabled(manager, second))
                assertFalse(NotesSyncCoordinator.isPending(ExactAccountIdentity(second.type, second.name, "notes-settings-1")))
            }
        } finally {
            AppSettingsActivity.notesToggleEffectOverride = null
            removeAccountAndWait(manager, first)
            removeAccountAndWait(manager, second)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    @Test fun notesDashboardJoinsOverallStatusOnlyWhileEnabled() {
        val notesEnabledPhase = AtomicBoolean(false)
        AccountActivity.AccountInfoViewModel.lifecycleWindowsOverride =
            SyncLifecycleWindows(interruptionAfterMillis = Long.MAX_VALUE)
        withDashboardAccount(loaderOverride = { loaderContext, exact, _ ->
            val store = SyncStatusStore(loaderContext)
            AccountActivity.AccountInfo().apply {
                caldav = service(CollectionInfo.Type.CALENDAR, store.status(exact, SyncStatusStore.Service.CALENDAR))
                carddav = service(CollectionInfo.Type.ADDRESS_BOOK, store.status(exact, SyncStatusStore.Service.CONTACTS))
                taskdav = service(CollectionInfo.Type.TASKS, store.status(exact, SyncStatusStore.Service.TASKS))
                notesEnabled = notesEnabledPhase.get()
                if (notesEnabled) notes = service(CollectionInfo.Type.NOTES, store.status(exact, SyncStatusStore.Service.NOTES))
            }
        }) { context, account, scenario ->
            val manager = AccountManager.get(context)
            val store = SyncStatusStore(context)
            val now = System.currentTimeMillis()
            val checking = context.getString(R.string.dashboard_status_checking)
            val requested = context.getString(R.string.dashboard_status_requested)
            // Notes evidence exists in the store, but a disabled service must not shape the overall
            // status: "Sync requested" is a current state that would otherwise outrank everything.
            assertTrue(store.recordRequested(account, setOf(SyncStatusStore.Service.NOTES), "notes-request", now))
            scenario.onActivity { it.refresh() }
            waitForText(scenario, R.id.dashboard_overall_status) { it != checking && it != requested }
            val overallWhileDisabled = AtomicReference("")
            scenario.onActivity { activity ->
                overallWhileDisabled.set(activity.findViewById<TextView>(R.id.dashboard_overall_status).text.toString())
                assertEquals(View.GONE, activity.findViewById<View>(R.id.notes_service_module).visibility)
                assertEquals(View.GONE, activity.findViewById<View>(R.id.notes).visibility)
                assertFalse(activity.findViewById<NavigationView>(R.id.nav_view).menu.findItem(R.id.nav_notes).isVisible)
            }

            check(AccountSettings.writeNotesEnabled(manager, account, true))
            notesEnabledPhase.set(true)
            scenario.onActivity { it.refresh() }
            waitForText(scenario, R.id.dashboard_overall_status) { it == requested }
            waitForText(scenario, R.id.notes_status) { it == requested }
            scenario.onActivity { activity ->
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.notes_service_module).visibility)
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.notes).visibility)
                assertTrue(activity.findViewById<NavigationView>(R.id.nav_view).menu.findItem(R.id.nav_notes).isVisible)
                assertEquals(1, activity.listNotes!!.adapter.count)
            }

            assertEquals(SyncStatusStore.MutationResult.RECORDED,
                store.beginAttemptResult(account, SyncStatusStore.Service.NOTES, "notes-attempt", now + 1, "notes-request"))
            scenario.onActivity { it.refresh() }
            val settling = context.getString(R.string.dashboard_status_settling)
            waitForText(scenario, R.id.notes_status) { it == settling }
            assertEquals(SyncStatusStore.MutationResult.RECORDED,
                store.recordSuccessResult(account, SyncStatusStore.Service.NOTES, "notes-attempt", "notes-request", now + 2))
            scenario.onActivity { it.refresh() }
            val synced = context.getString(R.string.dashboard_status_synced)
            waitForText(scenario, R.id.notes_status) { it == synced }
            // With Notes settled, the overall status returns to whatever the other services show.
            waitForText(scenario, R.id.dashboard_overall_status) { it == overallWhileDisabled.get() }

            // Recreation keeps the enabled surfaces and never flashes generic attention.
            scenario.recreate()
            waitForModel(scenario)
            scenario.onActivity { activity ->
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.notes_service_module).visibility)
                assertFalse(activity.findViewById<TextView>(R.id.dashboard_overall_status).text.toString()
                    .contains("Needs attention", ignoreCase = true))
            }
        }
    }

    @Test fun sharedNotebooksRenderMarkersAndRouteToExactNotebookAndNotes() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("notes-shared-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(account, null, null))
        AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
        check(AccountSettings.writeNotesEnabled(manager, account, true))
        val own = NotebookRow("nb-own", "Personal Notes", "", 0xff10b981.toInt(), readOnly = false, shared = false)
        val shared = NotebookRow("nb-shared", "Team notes", "Shared by a colleague", 0xff059669.toInt(), readOnly = true, shared = true)
        val notes = mapOf("nb-shared" to listOf(
            NoteContent("note-old", "Older note", "# Older\nFirst line of the older note", 1_000L),
            NoteContent("note-new", "Newer note", "- item one\n- item two", 2_000L),
        ))
        notesFixtureOverride = { _, exact, creationId ->
            if (exact == account && creationId == generation) NotesRuntimeFixture(listOf(own, shared), notes) else null
        }
        NotesSyncCoordinator.runnerOverride = { _, _, _, _ -> }
        val routes = mutableListOf<Intent>()
        NotebookListFragment.notebookRouteLauncherOverride = { routes += Intent(it) }
        try {
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, generation)).use { scenario ->
                waitUntil("notebooks rendered") { notebookFragment(scenario)?.renderedNotebooks?.size == 2 }
                scenario.onActivity { activity ->
                    val list = activity.findViewById<ListView>(R.id.notebooks_list)
                    assertEquals(2, list.adapter.count)
                    val ownRow = list.adapter.getView(0, null, list)
                    assertEquals(View.GONE, ownRow.findViewById<View>(R.id.read_only).visibility)
                    assertEquals(View.GONE, ownRow.findViewById<View>(R.id.shared).visibility)
                    val sharedRow = list.adapter.getView(1, null, list)
                    assertEquals("Team notes", sharedRow.findViewById<TextView>(R.id.title).text.toString())
                    assertEquals(View.VISIBLE, sharedRow.findViewById<View>(R.id.read_only).visibility)
                    assertEquals(View.VISIBLE, sharedRow.findViewById<View>(R.id.shared).visibility)
                    assertTrue(list.onItemLongClickListener.onItemLongClick(list, sharedRow, 1, 1))
                }
                assertEquals(1, routes.size)
                assertEquals(account, routes.single().getParcelableExtra<Account>(CollectionActivity.EXTRA_ACCOUNT))
                assertEquals(generation, routes.single().getStringExtra(CollectionActivity.EXTRA_CREATION_ID))
                assertEquals("nb-shared", routes.single().getStringExtra(CollectionActivity.EXTRA_COLLECTION_UID))

                scenario.onActivity { activity ->
                    val list = activity.findViewById<ListView>(R.id.notebooks_list)
                    list.performItemClick(list.adapter.getView(1, null, list), 1, 1)
                }
                waitUntil("notes rendered") { noteListFragment(scenario)?.renderedNotes?.size == 2 }
                scenario.onActivity { activity ->
                    val fragment = noteListFragment(scenario)!!
                    assertEquals(listOf("note-new", "note-old"), fragment.renderedNotes.map { it.uid })
                    assertEquals("item one", fragment.renderedNotes.first().preview)
                    assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.note_list_read_only).visibility)
                    assertEquals("Team notes", activity.title.toString())
                    val list = activity.findViewById<ListView>(R.id.notes_list)
                    list.performItemClick(list.adapter.getView(0, null, list), 0, 0)
                }
                waitUntil("note rendered") { noteViewFragment(scenario)?.renderedNote != null }
                scenario.onActivity { activity ->
                    assertEquals("- item one\n- item two", activity.findViewById<TextView>(R.id.note_body).text.toString())
                    assertEquals("Newer note", activity.title.toString())
                }
                scenario.recreate()
                waitUntil("note rendered after recreation") { noteViewFragment(scenario)?.renderedNote?.uid == "note-new" }
                scenario.onActivity { activity ->
                    assertEquals("Newer note", activity.findViewById<TextView>(R.id.note_title).text.toString())
                }
            }
        } finally {
            notesFixtureOverride = null
            NotesSyncCoordinator.runnerOverride = null
            NotebookListFragment.notebookRouteLauncherOverride = null
            NotesSyncCoordinator.cancelAccount(account.type, account.name)
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    @Test fun notesRouteRejectsStaleGenerationAndSignOutCancelsTheRunningSync() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("notes-stale-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(account, null, null))
        AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
        check(AccountSettings.writeNotesEnabled(manager, account, true))
        notesFixtureOverride = { _, exact, creationId ->
            if (exact == account && creationId == generation) NotesRuntimeFixture(
                listOf(NotebookRow("nb", "Personal Notes", "", null, readOnly = false, shared = false)), emptyMap()) else null
        }
        val started = CountDownLatch(2)
        val interrupted = CountDownLatch(1)
        val firstRunManual = AtomicReference<Boolean?>(null)
        NotesSyncCoordinator.runnerOverride = { _, _, _, request ->
            val first = started.count == 2L
            started.countDown()
            if (first) {
                firstRunManual.set(request.manual)
                try {
                    Thread.sleep(30_000)
                } catch (_: InterruptedException) {
                    interrupted.countDown()
                    // A real run unwinds through non-interruptible native calls; keep this task alive
                    // so a request that arrives right after cancellation queues behind it.
                    val until = android.os.SystemClock.uptimeMillis() + 500
                    while (android.os.SystemClock.uptimeMillis() < until) Thread.yield()
                }
            }
        }
        val identity = ExactAccountIdentity(account.type, account.name, generation)
        try {
            // A stale or replaced generation never reaches the Notes screen.
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "stale-generation")).use { scenario ->
                waitUntil("stale route finished") { scenario.state == Lifecycle.State.DESTROYED }
            }
            assertFalse(NotesSyncCoordinator.isPending(identity) || NotesSyncCoordinator.isActive(identity))

            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, generation)).use { scenario ->
                waitUntil("notebooks rendered") { notebookFragment(scenario)?.renderedNotebooks?.size == 1 }
                waitUntil("opening the screen starts the Notes job") { started.count == 1L }
                waitUntil("run request recorded") { firstRunManual.get() != null }
                assertEquals("opening the screen is automatic and honors Wi-Fi-only", false, firstRunManual.get())
                assertFalse("the job must still be sleeping before cancellation", interrupted.await(200, TimeUnit.MILLISECONDS))
                assertTrue("job active after start: ${NotesSyncCoordinator.snapshotForTesting(identity)}",
                    NotesSyncCoordinator.isActive(identity))

                // Sign-out cancels at the account-name boundary and interrupts the running job.
                NotesSyncCoordinator.cancelAccount(account.type, account.name)
                assertTrue("cancellation interrupts the job", interrupted.await(10, TimeUnit.SECONDS))
                assertFalse(NotesSyncCoordinator.isActive(identity) || NotesSyncCoordinator.isPending(identity))

                // A request that lands while the cancelled run is still unwinding must not be lost:
                // the settled slot belongs to the new request, not to the run that was cancelled.
                assertEquals(NotesSyncPolicy.Decision.START,
                    NotesSyncCoordinator.request(context, account, generation, NotesSyncPolicy.Trigger.SCREEN))
                assertTrue("the follow-up request runs after the cancelled task unwinds: " +
                    NotesSyncCoordinator.snapshotForTesting(identity), started.await(10, TimeUnit.SECONDS))
                waitUntil("follow-up run settles") { !NotesSyncCoordinator.isActive(identity) && !NotesSyncCoordinator.isPending(identity) }
            }

            // A same-name replacement generation must not adopt the retained route: the durable
            // Intent for the old generation is rejected the way a framework relaunch would see it.
            removeAccountAndWait(manager, account)
            check(manager.addAccountExplicitly(account, null, null))
            AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "replacement-generation"))
            check(AccountSettings.writeNotesEnabled(manager, account, true))
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, generation)).use { relaunched ->
                waitUntil("replacement generation rejected") { relaunched.state == Lifecycle.State.DESTROYED }
            }
            assertFalse(NotesSyncCoordinator.isPending(identity) || NotesSyncCoordinator.isActive(identity))
        } finally {
            notesFixtureOverride = null
            NotesSyncCoordinator.runnerOverride = null
            NotesSyncCoordinator.cancelAccount(account.type, account.name)
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    private fun notesToggle(activity: AppSettingsActivity): SwitchPreferenceCompat {
        activity.supportFragmentManager.executePendingTransactions()
        val fragment = activity.supportFragmentManager.findFragmentById(android.R.id.content) as AppSettingsActivity.CategoryFragment
        return fragment.findPreference("notes_enabled")!!
    }

    private fun notebookFragment(scenario: ActivityScenario<NotesActivity>): NotebookListFragment? {
        var fragment: NotebookListFragment? = null
        scenario.onActivity { fragment = it.supportFragmentManager.findFragmentById(R.id.fragment_container) as? NotebookListFragment }
        return fragment
    }

    private fun noteListFragment(scenario: ActivityScenario<NotesActivity>): NoteListFragment? {
        var fragment: NoteListFragment? = null
        scenario.onActivity { fragment = it.supportFragmentManager.findFragmentById(R.id.fragment_container) as? NoteListFragment }
        return fragment
    }

    private fun noteViewFragment(scenario: ActivityScenario<NotesActivity>): NoteViewFragment? {
        var fragment: NoteViewFragment? = null
        scenario.onActivity { fragment = it.supportFragmentManager.findFragmentById(R.id.fragment_container) as? NoteViewFragment }
        return fragment
    }

    private fun withDashboardAccount(
        loaderOverride: (Context, Account, String) -> AccountActivity.AccountInfo,
        block: (Context, Account, ActivityScenario<AccountActivity>) -> Unit,
    ) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("notes-dashboard-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(account, null, null))
        AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
        check(AccountSettings.writeSetupState(manager, account, PostLoginSetupState.COMPLETE))
        grantCorePermissions(context)
        val previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        ContentResolver.setMasterSyncAutomatically(true)
        context.getSharedPreferences("sync_status_v1", 0).edit().clear().commit()
        val previousBootstrap = App.postLoginBootstrapSucceeded
        App.postLoginBootstrapSucceeded = true
        AccountActivity.collectionIntentLauncherOverride = { }
        AccountActivity.syncActiveOverride = { false }
        AccountActivity.syncRequestOverride = { _, _ -> }
        AccountActivity.AccountInfoViewModel.accountLoaderOverride = loaderOverride
        NotesSyncCoordinator.runnerOverride = { _, _, _, _ -> }
        try {
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(context, account)).use { scenario ->
                waitForModel(scenario)
                block(context, account, scenario)
            }
        } finally {
            AccountActivity.AccountInfoViewModel.accountLoaderOverride = null
            AccountActivity.AccountInfoViewModel.lifecycleWindowsOverride = null
            AccountActivity.AccountInfoViewModel.lifecycleNowOverride = null
            AccountActivity.collectionIntentLauncherOverride = null
            AccountActivity.syncRequestOverride = null
            AccountActivity.syncActiveOverride = null
            NotesSyncCoordinator.runnerOverride = null
            NotesSyncCoordinator.cancelAccount(account.type, account.name)
            App.postLoginBootstrapSucceeded = previousBootstrap
            ContentResolver.setMasterSyncAutomatically(false)
            try {
                removeAccountAndWait(manager, account)
            } finally {
                ContentResolver.setMasterSyncAutomatically(previousMasterSync)
            }
            ActiveAccountManager.clearActiveAccount(context)
            context.getSharedPreferences("sync_status_v1", 0).edit().clear().commit()
        }
    }

    private fun service(type: CollectionInfo.Type, status: SyncStatusStore.Status) =
        AccountActivity.AccountInfo.ServiceInfo().apply {
            this.status = status
            infos = listOf(AccountActivity.CollectionListItemInfo(
                "uid-${type.name}", type, type.name, "",
                if (type == CollectionInfo.Type.ADDRESS_BOOK) null else 0xff10b981.toInt(),
                isReadOnly = false, isAdmin = true,
            ))
        }

    private fun removeAccountAndWait(manager: AccountManager, account: Account) {
        val previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        ContentResolver.setMasterSyncAutomatically(false)
        try {
            if (account !in manager.getAccountsByType(account.type)) return
            val removed = CountDownLatch(1)
            var confirmed = false
            AndroidCompat.removeAccount(manager, account) {
                confirmed = it
                removed.countDown()
            }
            assertTrue("account removal callback timed out", removed.await(10, TimeUnit.SECONDS))
            assertTrue("account removal was not confirmed", confirmed)
            assertFalse("account row remained after confirmed removal", account in manager.getAccountsByType(account.type))
        } finally {
            ContentResolver.setMasterSyncAutomatically(previousMasterSync)
        }
    }

    private fun waitForModel(scenario: ActivityScenario<AccountActivity>) {
        waitUntil("dashboard model delivered") {
            var delivered = false
            scenario.onActivity { delivered = it.hasDeliveredAccountInfo }
            delivered
        }
    }

    private fun waitForText(scenario: ActivityScenario<AccountActivity>, viewId: Int, predicate: (String) -> Boolean) {
        val observed = AtomicReference("")
        try {
            waitUntil("dashboard text") {
                scenario.onActivity { observed.set(it.findViewById<TextView>(viewId).text.toString()) }
                predicate(observed.get())
            }
        } catch (e: AssertionError) {
            throw AssertionError("Dashboard text did not reach the expected state; last observed '${observed.get()}'", e)
        }
    }

    private fun waitUntil(description: String, timeoutMillis: Long = 10_000, predicate: () -> Boolean) {
        val deadline = android.os.SystemClock.uptimeMillis() + timeoutMillis
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            if (predicate()) return
            android.os.SystemClock.sleep(50)
        }
        throw AssertionError("Timed out waiting for $description")
    }

    private fun grantCorePermissions(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val permissions = mutableListOf(
            Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR,
            Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS,
        )
        // Granting the notification permission keeps the system prompt from pausing the dashboard.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) permissions += Manifest.permission.POST_NOTIFICATIONS
        permissions.forEach {
            InstrumentationRegistry.getInstrumentation().uiAutomation
                .executeShellCommand("pm grant ${context.packageName} $it").close()
        }
    }
}
