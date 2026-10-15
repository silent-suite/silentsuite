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
import androidx.preference.ListPreference
import androidx.preference.SwitchPreferenceCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.material.navigation.NavigationView
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.notes.NotesNetwork
import io.silentsuite.sync.notes.NotesNetworkPolicy
import io.silentsuite.sync.notes.NotesNetworkPolicy.NoticePart
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.NotesSyncPolicy
import io.silentsuite.sync.notes.edit.HeldReason
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.account.SyncLifecycleWindows
import io.silentsuite.sync.ui.etebase.CollectionActivity
import io.silentsuite.sync.ui.notes.NoteContent
import io.silentsuite.sync.ui.notes.NoteListFragment
import io.silentsuite.sync.ui.notes.NoteSync
import io.silentsuite.sync.ui.notes.NoteViewFragment
import io.silentsuite.sync.ui.notes.NotebookListFragment
import io.silentsuite.sync.ui.notes.NotebookRow
import io.silentsuite.sync.ui.notes.NotebookOverview
import io.silentsuite.sync.ui.notes.NotesActivity
import io.silentsuite.sync.ui.notes.NotesEmptyState
import io.silentsuite.sync.ui.notes.NotesLoad
import io.silentsuite.sync.ui.notes.NotesLoader
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
 * replaced by a seam and the Notes screen reads process-local fixtures. The notebook list also
 * reads which network the device reports, for its network line; every case that opens the list
 * pins that reading and takes the pin off again.
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
                    // The two network rows under the switch: off with it, and showing the defaults.
                    val automatic = notesNetworkRow(activity, "notes_automatic_network")
                    val syncNow = notesNetworkRow(activity, "notes_sync_now_network")
                    assertFalse("the automatic row is disabled while Notes is off", automatic.isEnabled)
                    assertFalse("the Sync now row is disabled while Notes is off", syncNow.isEnabled)
                    assertEquals("WIFI_ONLY", automatic.value)
                    assertEquals("ANY_NETWORK", syncNow.value)
                    assertEquals("the sentence under the automatic row is the one for its default",
                        activity.getString(R.string.settings_notes_automatic_network_wifi), automatic.summary?.toString())
                    assertEquals("the sentence under the Sync now row is the one for its default",
                        activity.getString(R.string.settings_notes_sync_now_network_any), syncNow.summary?.toString())
                    toggle.performClick()
                    assertTrue("the automatic row is enabled once Notes is on", automatic.isEnabled)
                    assertTrue("the Sync now row is enabled once Notes is on", syncNow.isEnabled)
                    // What the row's dialog does with a choice: ask the listener, then keep the value.
                    assertTrue(automatic.callChangeListener("ANY_NETWORK"))
                    automatic.value = "ANY_NETWORK"
                    assertEquals("the sentence under the automatic row follows the accepted change",
                        activity.getString(R.string.settings_notes_automatic_network_any), automatic.summary?.toString())
                    assertTrue(syncNow.callChangeListener("WIFI_ONLY"))
                    syncNow.value = "WIFI_ONLY"
                    assertEquals("the sentence under the Sync now row follows the accepted change",
                        activity.getString(R.string.settings_notes_sync_now_network_wifi), syncNow.summary?.toString())
                    assertFalse("a value that is not a choice is refused", automatic.callChangeListener("SOMETHING"))
                }
                assertTrue(AccountSettings.notesEnabled(manager, second))
                assertFalse("the sibling account keeps its own opt-in", AccountSettings.notesEnabled(manager, first))
                assertEquals(listOf(Triple(second, "notes-settings-1", true)), effects)
                assertEquals(NotesNetworkPolicy.Settings(NotesNetworkPolicy.Allowed.ANY_NETWORK, NotesNetworkPolicy.Allowed.WIFI_ONLY),
                    AccountSettings.notesNetworkSettings(manager, second))
                assertEquals("the sibling account keeps its own network settings",
                    NotesNetworkPolicy.Settings.DEFAULT, AccountSettings.notesNetworkSettings(manager, first))
                scenario.recreate()
                val toggleAfterClick = AtomicReference("")
                scenario.onActivity { activity ->
                    val toggle = notesToggle(activity)
                    assertTrue("the opt-in survives recreation", toggle.isChecked)
                    val automatic = notesNetworkRow(activity, "notes_automatic_network")
                    val syncNow = notesNetworkRow(activity, "notes_sync_now_network")
                    // After recreation the preference library restores each row's own saved value. The
                    // fresh screen opened after this one is what shows the read of the account row.
                    assertEquals("after recreation the automatic row has the value the preference library saved", "ANY_NETWORK", automatic.value)
                    assertEquals("after recreation the Sync now row has the value the preference library saved", "WIFI_ONLY", syncNow.value)
                    assertEquals("the sentence under the automatic row after recreation",
                        activity.getString(R.string.settings_notes_automatic_network_any), automatic.summary?.toString())
                    assertEquals("the sentence under the Sync now row after recreation",
                        activity.getString(R.string.settings_notes_sync_now_network_wifi), syncNow.summary?.toString())
                    toggle.performClick()
                    toggleAfterClick.set("checked=${toggle.isChecked} enabled=${toggle.isEnabled} selected=${activity.selectedAccount} " +
                        "exact=${activity.exactSelectedAccount()} raw=${manager.getUserData(second, AccountSettings.KEY_NOTES_ENABLED)}")
                }
                assertEquals("turning Notes off routes through the same exact-account listener; ${toggleAfterClick.get()}",
                    listOf(Triple(second, "notes-settings-1", true), Triple(second, "notes-settings-1", false)), effects)
                assertFalse("Notes stays enabled after turning it off; ${toggleAfterClick.get()}", AccountSettings.notesEnabled(manager, second))
                scenario.onActivity { activity ->
                    assertFalse("the automatic row is disabled again", notesNetworkRow(activity, "notes_automatic_network").isEnabled)
                    assertFalse("the Sync now row is disabled again", notesNetworkRow(activity, "notes_sync_now_network").isEnabled)
                }
                assertEquals("turning Notes off keeps the network choices",
                    NotesNetworkPolicy.Settings(NotesNetworkPolicy.Allowed.ANY_NETWORK, NotesNetworkPolicy.Allowed.WIFI_ONLY),
                    AccountSettings.notesNetworkSettings(manager, second))
                assertFalse(NotesSyncCoordinator.isPending(ExactAccountIdentity(second.type, second.name, "notes-settings-1")))
            }
            // A new screen for the same account has no saved state, so what its two rows show is what
            // it read from the account row.
            ActivityScenario.launch<AppSettingsActivity>(
                AppSettingsActivity.newIntent(context, second, "notes-settings-1", SettingsCategory.ACCOUNT)
            ).use { fresh ->
                fresh.onActivity { activity ->
                    val automatic = notesNetworkRow(activity, "notes_automatic_network")
                    val syncNow = notesNetworkRow(activity, "notes_sync_now_network")
                    assertEquals("a new screen shows the stored automatic choice", "ANY_NETWORK", automatic.value)
                    assertEquals("a new screen shows the stored Sync now choice", "WIFI_ONLY", syncNow.value)
                    assertEquals("a new screen shows the sentence for the stored automatic choice",
                        activity.getString(R.string.settings_notes_automatic_network_any), automatic.summary?.toString())
                    assertEquals("a new screen shows the sentence for the stored Sync now choice",
                        activity.getString(R.string.settings_notes_sync_now_network_wifi), syncNow.summary?.toString())
                }
            }
        } finally {
            AppSettingsActivity.notesToggleEffectOverride = null
            removeAccountAndWait(manager, first)
            removeAccountAndWait(manager, second)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    @Test fun loaderReadsLocalChangesFirstAndKeepsThemWhenTheCacheCannotBeRead() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("notes-pending-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(account, null, null))
        AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
        check(AccountSettings.writeNotesEnabled(manager, account, true))
        // No Etebase session is stored, so everything after the pending store read fails, the way a
        // damaged session or cache would. The real loader runs against the real store for this exact
        // account generation, written through the device's own rename and directory sync.
        val store = PendingNotesStore.forIdentity(context, account.type, account.name, generation)
        assertTrue("outside backup and device transfer",
            store.dir.canonicalPath.startsWith(context.noBackupFilesDir.canonicalPath + java.io.File.separator))
        store.saveLocal("waiting", "nb", "r1", byteArrayOf(1), isCreate = true)
        store.saveLocal("held", "nb", "r1", byteArrayOf(2), isCreate = true)
        store.saveLocal("held", "nb", "r2", byteArrayOf(3), isCreate = true)
        check(store.hold("held", HeldReason.READ_ONLY, now = 1) == PendingNotesStore.HoldOutcome.HELD)
        assertFalse("no uncommitted write is left behind", store.dir.listFiles()!!.any { it.name.endsWith(".new") })
        try {
            // The notebook list still leads to the local changes: both count as unsynced text.
            assertEquals(NotesLoad.Loaded(NotebookOverview(emptyList(), unsyncedText = 2, failed = true)),
                NotesLoader.notebooks(context, account, generation))
            // One notebook's notes need the cache, so that screen reports the failure.
            assertEquals(NotesLoad.Failed, NotesLoader.notebook(context, account, generation, "nb"))
        } finally {
            store.clearAll()
            removeAccountAndWait(manager, account)
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
        val own = NotebookRow("nb-own", "Personal Notes", "Drafts and lists", 0xff10b981.toInt(), readOnly = false, shared = false, waiting = 2)
        val shared = NotebookRow("nb-shared", "Team notes", "Shared by a colleague", 0xff059669.toInt(), readOnly = true, shared = true)
        val notes = mapOf(
            "nb-shared" to listOf(
                NoteContent("note-old", "Older note", "# Older\nFirst line of the older note", 1_000L),
                NoteContent("note-new", "Newer note", "- item one\n- item two", 2_000L),
            ),
            // Pending changes as the loader's overlay reports them in a writable notebook.
            "nb-own" to listOf(
                NoteContent("note-local", "Local edit", "Changed on this device", 3_000L, NoteSync.WAITING, pendingVersion = 4),
                NoteContent("note-bad", "Server copy", "Server text", 500L, NoteSync.LOCAL_UNREADABLE, pendingVersion = 5),
            ),
        )
        val identity = ExactAccountIdentity(account.type, account.name, generation)
        // The cache starts empty, as it is before the first Notes sync fills it.
        val rows = AtomicReference(emptyList<NotebookRow>())
        val loads = java.util.concurrent.atomic.AtomicInteger()
        notesFixtureOverride = { _, exact, creationId ->
            loads.incrementAndGet()
            if (exact == account && creationId == generation) {
                NotesRuntimeFixture(rows.get(), notes, unsyncedText = 3, unreadable = mapOf("nb-shared" to 1))
            } else {
                null
            }
        }
        NotesSyncCoordinator.runnerOverride = { _, _, _, _ -> }
        val routes = mutableListOf<Intent>()
        NotebookListFragment.notebookRouteLauncherOverride = { routes += Intent(it) }
        try {
            // The list reads the network for its network line. Pinned to Wi-Fi, so nothing here
            // depends on the network of the device: with the defaults the list then says nothing.
            assertNull("another test left the network reading pinned", NotesNetwork.readingOverride)
            NotesNetwork.readingOverride = { NotesNetworkPolicy.Reading(NotesNetworkPolicy.Connection.WIFI) }
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, generation)).use { scenario ->
                // Before any Notes sync has succeeded, an empty cache is not "no notebooks": no
                // create prompt, and pull to refresh stays available.
                waitUntil("unsynced empty state") { notebookFragment(scenario)?.renderedEmptyState == NotesEmptyState.NOT_SYNCED }
                scenario.onActivity { activity ->
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.notebooks_create).visibility)
                    assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.notebooks_refresh).visibility)
                    assertEquals(activity.getString(R.string.notes_not_synced),
                        activity.findViewById<TextView>(R.id.notebooks_empty_text).text.toString())
                }
                // Once a Notes sync has succeeded, the same empty cache means there are none.
                check(SyncStatusStore(context).recordSuccess(account, SyncStatusStore.Service.NOTES))
                NotesSyncCoordinator.request(context, account, generation, NotesSyncPolicy.Trigger.SCREEN)
                waitUntil("synced empty state") { notebookFragment(scenario)?.renderedEmptyState == NotesEmptyState.EMPTY }
                var adapterBeforeRows: android.widget.ListAdapter? = null
                scenario.onActivity { activity ->
                    assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.notebooks_create).visibility)
                    adapterBeforeRows = activity.findViewById<ListView>(R.id.notebooks_list).adapter
                }

                // Enough notebooks that the list scrolls, so the kept position can be checked.
                val fillers = (0 until 60).map { NotebookRow("nb-fill-$it", "Filler $it", "", null, readOnly = false, shared = false) }
                rows.set(listOf(own, shared) + fillers)
                NotesSyncCoordinator.request(context, account, generation, NotesSyncPolicy.Trigger.SCREEN)
                waitUntil("notebooks rendered") { notebookFragment(scenario)?.renderedNotebooks?.size == 62 }
                scenario.onActivity { activity ->
                    val list = activity.findViewById<ListView>(R.id.notebooks_list)
                    assertTrue("a reload after sync updates the list's adapter in place, which keeps the scroll position",
                        adapterBeforeRows === list.adapter)
                    assertNull(notebookFragment(scenario)?.renderedEmptyState)
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.notebooks_empty).visibility)
                    assertEquals(62, list.adapter.count)
                    val ownRow = list.adapter.getView(0, null, list)
                    assertEquals(View.GONE, ownRow.findViewById<View>(R.id.read_only).visibility)
                    assertEquals(View.GONE, ownRow.findViewById<View>(R.id.shared).visibility)
                    // The count comes first: the row shows at most two lines of description.
                    assertEquals("2 changes not synced yet\nDrafts and lists", ownRow.findViewById<TextView>(R.id.description).text.toString())
                    assertTrue(ownRow.contentDescription.toString().contains("2 changes not synced yet"))
                    val unsynced = activity.findViewById<TextView>(R.id.notebooks_unsynced)
                    assertEquals(View.VISIBLE, unsynced.visibility)
                    assertEquals("Unsynced text (3)", unsynced.text.toString())
                    assertEquals(3, notebookFragment(scenario)!!.renderedUnsyncedText)
                    assertTrue("on Wi-Fi with the defaults the list says nothing about the network, also while changes wait",
                        notebookFragment(scenario)!!.renderedNetworkNotice.isEmpty())
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.notebooks_network_notice).visibility)
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

                scenario.onActivity { it.findViewById<ListView>(R.id.notebooks_list).setSelection(20) }
                waitUntil("notebook list scrolled") { notebookListPosition(scenario) == 20 }
                // A sync while the list is scrolled reloads it and must not move it.
                val loadsBeforeSync = loads.get()
                NotesSyncCoordinator.request(context, account, generation, NotesSyncPolicy.Trigger.SCREEN)
                waitUntil("sync after scrolling settled") {
                    !NotesSyncCoordinator.isActive(identity) && !NotesSyncCoordinator.isPending(identity) &&
                        loads.get() > loadsBeforeSync
                }
                repeat(10) {
                    assertEquals("the list stays where the user scrolled it", 20, notebookListPosition(scenario))
                    android.os.SystemClock.sleep(100)
                }

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
                    val unreadable = activity.findViewById<TextView>(R.id.notes_unreadable)
                    assertEquals(View.VISIBLE, unreadable.visibility)
                    assertEquals("1 item in this notebook could not be read", unreadable.text.toString())
                    val list = activity.findViewById<ListView>(R.id.notes_list)
                    assertEquals(View.GONE, list.adapter.getView(0, null, list).findViewById<View>(R.id.note_sync).visibility)
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
                    assertFalse(activity.findViewById<TextView>(R.id.note_meta).text.toString().contains("Not synced yet"))
                }

                // Back to the notebooks, through a recreation while they were on the back stack: the
                // list comes back where the user left it.
                scenario.onActivity { it.onSupportNavigateUp() }
                waitUntil("notes rendered after going back") { noteListFragment(scenario)?.renderedNotes?.size == 2 }
                scenario.onActivity { it.onSupportNavigateUp() }
                waitUntil("notebooks rendered after going back") { notebookFragment(scenario)?.renderedNotebooks?.size == 62 }
                waitUntil("notebook list position restored") { notebookListPosition(scenario) == 20 }

                // A writable notebook with local changes: each row says so, and so does the viewer.
                scenario.onActivity { activity ->
                    val list = activity.findViewById<ListView>(R.id.notebooks_list)
                    list.performItemClick(list.adapter.getView(0, null, list), 0, 0)
                }
                waitUntil("own notes rendered") { noteListFragment(scenario)?.renderedNotes?.map { it.uid } == listOf("note-local", "note-bad") }
                scenario.onActivity { activity ->
                    val list = activity.findViewById<ListView>(R.id.notes_list)
                    val waiting = list.adapter.getView(0, null, list).findViewById<TextView>(R.id.note_sync)
                    assertEquals(View.VISIBLE, waiting.visibility)
                    assertEquals("Not synced yet", waiting.text.toString())
                    val unreadableChange = list.adapter.getView(1, null, list).findViewById<TextView>(R.id.note_sync)
                    assertEquals(View.VISIBLE, unreadableChange.visibility)
                    assertEquals("A local change could not be read", unreadableChange.text.toString())
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.notes_unreadable).visibility)
                    list.performItemClick(list.adapter.getView(0, null, list), 0, 0)
                }
                waitUntil("pending note rendered") { noteViewFragment(scenario)?.renderedNote?.uid == "note-local" }
                scenario.onActivity { activity ->
                    assertTrue(activity.findViewById<TextView>(R.id.note_meta).text.toString().contains("Not synced yet"))
                    assertEquals("Changed on this device", activity.findViewById<TextView>(R.id.note_body).text.toString())
                    assertEquals(4L, noteViewFragment(scenario)!!.renderedNote!!.pendingVersion)
                }
            }

            // With no notebook left, local text still has its way in next to the empty state.
            notesFixtureOverride = { _, exact, creationId ->
                if (exact == account && creationId == generation) NotesRuntimeFixture(emptyList(), emptyMap(), unsyncedText = 1) else null
            }
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, generation)).use { scenario ->
                waitUntil("empty notebook list rendered") { notebookFragment(scenario)?.renderedUnsyncedText == 1 }
                scenario.onActivity { activity ->
                    assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.notebooks_empty).visibility)
                    val unsynced = activity.findViewById<TextView>(R.id.notebooks_unsynced)
                    assertEquals(View.VISIBLE, unsynced.visibility)
                    assertEquals("Unsynced text (1)", unsynced.text.toString())
                }
            }
        } finally {
            NotesNetwork.readingOverride = null
            notesFixtureOverride = null
            NotesSyncCoordinator.runnerOverride = null
            NotebookListFragment.notebookRouteLauncherOverride = null
            NotesSyncCoordinator.cancelAccount(account.type, account.name)
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
        assertNull("this case leaves the network reading as it found it", NotesNetwork.readingOverride)
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
        val firstRunUnwound = AtomicBoolean(false)
        val followUpStartedAfterTheFirstUnwound = AtomicReference<Boolean?>(null)
        NotesSyncCoordinator.runnerOverride = { _, _, _, request ->
            val first = started.count == 2L
            if (!first) followUpStartedAfterTheFirstUnwound.set(firstRunUnwound.get())
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
                    firstRunUnwound.set(true)
                }
            }
        }
        val identity = ExactAccountIdentity(account.type, account.name, generation)
        try {
            // The list reads the network for its network line. Pinned to Wi-Fi, so nothing here
            // depends on the network of the device.
            assertNull("another test left the network reading pinned", NotesNetwork.readingOverride)
            NotesNetwork.readingOverride = { NotesNetworkPolicy.Reading(NotesNetworkPolicy.Connection.WIFI) }
            // A stale or replaced generation never reaches the Notes screen.
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "stale-generation")).use { scenario ->
                waitUntil("stale route finished") { scenario.state == Lifecycle.State.DESTROYED }
            }
            assertFalse(NotesSyncCoordinator.isPending(identity) || NotesSyncCoordinator.isActive(identity))

            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, generation)).use { scenario ->
                waitUntil("notebooks rendered") { notebookFragment(scenario)?.renderedNotebooks?.size == 1 }
                assertTrue("on Wi-Fi with the defaults the list says nothing about the network",
                    notebookFragment(scenario)!!.renderedNetworkNotice.isEmpty())
                waitUntil("opening the screen starts the Notes job") { started.count == 1L }
                waitUntil("run request recorded") { firstRunManual.get() != null }
                assertEquals("opening the screen is automatic, not a run the user started", false, firstRunManual.get())
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
                assertEquals("the follow-up started only once the cancelled run had unwound",
                    true, followUpStartedAfterTheFirstUnwound.get())
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
            NotesNetwork.readingOverride = null
            notesFixtureOverride = null
            NotesSyncCoordinator.runnerOverride = null
            NotesSyncCoordinator.cancelAccount(account.type, account.name)
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
        assertNull("this case leaves the network reading as it found it", NotesNetwork.readingOverride)
    }

    @Test fun theNotebookListSaysWhyNotesDoNotSyncByThemselvesAndWhetherPullingDownWould() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("notes-notice-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(account, null, null))
        AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
        check(AccountSettings.writeNotesEnabled(manager, account, true))
        val settings = AccountSettings(context, account)
        val waitingRow = NotebookRow("nb", "Personal Notes", "", null, readOnly = false, shared = false, waiting = 2)
        val rows = AtomicReference(listOf(waitingRow))
        // One change sits under Unsynced text in every step. The line counts the notebook rows only.
        notesFixtureOverride = { _, exact, creationId ->
            if (exact == account && creationId == generation) NotesRuntimeFixture(rows.get(), emptyMap(), unsyncedText = 1) else null
        }
        // The run is a stand-in, so the gate never runs here: the list is the only reader of the network.
        NotesSyncCoordinator.runnerOverride = { _, _, _, _ -> }
        // The pinned reading gives the Wi-Fi name only when the list asks for it, and keeps each ask.
        val asked = java.util.concurrent.CopyOnWriteArrayList<Boolean>()
        fun pin(connection: NotesNetworkPolicy.Connection, name: String? = null) {
            NotesNetwork.readingOverride = { withWifiName ->
                asked += withWifiName
                NotesNetworkPolicy.Reading(connection, name.takeIf { withWifiName })
            }
        }
        val wifi = NotesNetworkPolicy.Connection.WIFI
        val other = NotesNetworkPolicy.Connection.OTHER
        // The test's own list of which text belongs to which sentence.
        val texts = mapOf(
            NoticePart.CHANGES_WAITING to R.string.notes_network_changes_waiting,
            NoticePart.MAY_BE_OUT_OF_DATE to R.string.notes_network_may_be_out_of_date,
            NoticePart.NOTES_SETTING to R.string.notes_network_notes_setting,
            NoticePart.ACCOUNT_WIFI_ONLY to R.string.notes_network_account_wifi_only,
            NoticePart.NO_WIFI_REPORTED to R.string.notes_network_no_wifi_reported,
            NoticePart.ACCOUNT_NETWORK_NAME to R.string.notes_network_account_network_name,
            NoticePart.TRY_NOW to R.string.notes_network_try_now,
            NoticePart.SYNC_NOW_NEEDS_WIFI to R.string.notes_network_sync_now_needs_wifi,
        )
        // Waits until the list has rendered exactly these sentences, then reads the line itself. Every
        // step below expects other sentences than the step before it, so the wait can only end on a
        // render made after the step changed something. A step changes the settings and the pinned
        // reading first and the notebook rows last: a load reads the rows before it reads the network.
        fun awaitLine(scenario: ActivityScenario<NotesActivity>, step: String, vararg expected: NoticePart) {
            try {
                waitUntil(step) { notebookFragment(scenario)?.renderedNetworkNotice == expected.toList() }
            } catch (e: AssertionError) {
                throw AssertionError("$step: the list last rendered ${notebookFragment(scenario)?.renderedNetworkNotice}", e)
            }
            scenario.onActivity { activity ->
                val line = activity.findViewById<TextView>(R.id.notebooks_network_notice)
                assertEquals(step, if (expected.isEmpty()) View.GONE else View.VISIBLE, line.visibility)
                if (expected.isNotEmpty()) {
                    assertEquals(step, expected.joinToString(" ") { activity.getString(texts.getValue(it)) }, line.text.toString())
                }
            }
        }
        // The end of the stand-in run reloads the list, as the end of any run does.
        fun reload() {
            NotesSyncCoordinator.request(context, account, generation, NotesSyncPolicy.Trigger.SCREEN)
        }
        try {
            assertNull("another test left the network reading pinned", NotesNetwork.readingOverride)
            pin(wifi)
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, generation)).use { scenario ->
                // 1. On Wi-Fi with the defaults nothing is said, also while changes wait.
                waitUntil("step 1: the notebook to show") { notebookFragment(scenario)?.renderedNotebooks?.size == 1 }
                awaitLine(scenario, "step 1: on Wi-Fi with the defaults, changes waiting")

                // 2. Off Wi-Fi with the defaults, changes waiting: the Notes setting, what Android reports,
                // and the pull down as an attempt.
                pin(other)
                reload()
                awaitLine(scenario, "step 2: off Wi-Fi with the defaults, changes waiting",
                    NoticePart.CHANGES_WAITING, NoticePart.NOTES_SETTING, NoticePart.NO_WIFI_REPORTED, NoticePart.TRY_NOW)

                // 3. Sync now on Wi-Fi only as well: the last sentence says so, and offers the pull down
                // for Wi-Fi only. No run is requested in this step; the screen is left and shown again.
                check(AccountSettings.writeNotesSyncNowNetwork(manager, account, NotesNetworkPolicy.Allowed.WIFI_ONLY))
                scenario.moveToState(Lifecycle.State.CREATED)
                scenario.moveToState(Lifecycle.State.RESUMED)
                awaitLine(scenario, "step 3: Sync now on Wi-Fi only as well",
                    NoticePart.CHANGES_WAITING, NoticePart.NOTES_SETTING, NoticePart.NO_WIFI_REPORTED, NoticePart.SYNC_NOW_NEEDS_WIFI)

                // 4. The account's own switch on, and Sync now on any network again: both rules are
                // named, the Notes setting first.
                settings.setSyncWiFiOnly(true)
                check(AccountSettings.writeNotesSyncNowNetwork(manager, account, NotesNetworkPolicy.Allowed.ANY_NETWORK))
                reload()
                awaitLine(scenario, "step 4: the Notes setting and the account switch",
                    NoticePart.CHANGES_WAITING, NoticePart.NOTES_SETTING, NoticePart.ACCOUNT_WIFI_ONLY, NoticePart.NO_WIFI_REPORTED,
                    NoticePart.TRY_NOW)

                // 5. Automatic sync on any network, no active network reported, and nothing waiting: the
                // account switch alone, in the words for nothing waiting. No active network is not
                // proof of no connection, so the pull down is still offered.
                check(AccountSettings.writeNotesAutomaticNetwork(manager, account, NotesNetworkPolicy.Allowed.ANY_NETWORK))
                pin(NotesNetworkPolicy.Connection.NONE)
                rows.set(listOf(waitingRow.copy(waiting = 0)))
                reload()
                awaitLine(scenario, "step 5: nothing waiting, no active network reported, the account switch on",
                    NoticePart.MAY_BE_OUT_OF_DATE, NoticePart.ACCOUNT_WIFI_ONLY, NoticePart.NO_WIFI_REPORTED, NoticePart.TRY_NOW)
                // Up to here the account never had a network name.
                assertTrue("with no network name on the account the list never asked for the Wi-Fi name: $asked",
                    asked.isNotEmpty() && asked.none { it })

                // 6. A network name on the account, and Wi-Fi under another name: the name sentence, and
                // nothing says that Wi-Fi is missing.
                settings.syncWifiOnlySSID = "home"
                pin(wifi, "\"cafe\"")
                reload()
                awaitLine(scenario, "step 6: Wi-Fi under another name than the account's",
                    NoticePart.MAY_BE_OUT_OF_DATE, NoticePart.ACCOUNT_NETWORK_NAME, NoticePart.TRY_NOW)

                // 7. Wi-Fi under the account's own name: no line. The pinned reading gives the name only
                // when it is asked for, so this also shows that the list asks for it.
                pin(wifi, "\"home\"")
                reload()
                awaitLine(scenario, "step 7: Wi-Fi under the account's own name")

                // 8. Changes waiting again, off Wi-Fi: the account switch in the words for waiting changes.
                pin(other)
                rows.set(listOf(waitingRow))
                reload()
                awaitLine(scenario, "step 8: changes waiting, off Wi-Fi, the account switch on",
                    NoticePart.CHANGES_WAITING, NoticePart.ACCOUNT_WIFI_ONLY, NoticePart.NO_WIFI_REPORTED, NoticePart.TRY_NOW)

                // 9. The platform's answer cannot be read: no line, no crash, and the notebook still shows.
                NotesNetwork.readingOverride = { throw IllegalStateException("the reading fails in this step") }
                reload()
                awaitLine(scenario, "step 9: a reading that fails")
                assertEquals("the notebook still shows after a reading that failed", 1, notebookFragment(scenario)?.renderedNotebooks?.size)
                assertEquals("the screen is still open", Lifecycle.State.RESUMED, scenario.state)

                // 10. The reading works again, every rule is on, and no notebook is left: the line stays
                // above the empty list.
                check(AccountSettings.writeNotesAutomaticNetwork(manager, account, NotesNetworkPolicy.Allowed.WIFI_ONLY))
                check(AccountSettings.writeNotesSyncNowNetwork(manager, account, NotesNetworkPolicy.Allowed.WIFI_ONLY))
                pin(other)
                rows.set(emptyList())
                reload()
                awaitLine(scenario, "step 10: every rule on, above an empty list",
                    NoticePart.MAY_BE_OUT_OF_DATE, NoticePart.NOTES_SETTING, NoticePart.ACCOUNT_WIFI_ONLY, NoticePart.NO_WIFI_REPORTED,
                    NoticePart.SYNC_NOW_NEEDS_WIFI)
                scenario.onActivity { activity ->
                    assertEquals("the empty list shows under the line", View.VISIBLE, activity.findViewById<View>(R.id.notebooks_empty).visibility)
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.notebooks_hint).visibility)
                }

                // 11. Back on Wi-Fi under the account's name: the line goes at the next reload.
                pin(wifi, "\"home\"")
                reload()
                awaitLine(scenario, "step 11: back on Wi-Fi")

                // 12. The account row is gone: there is nothing to read, and the screen closes. The
                // fixture still answers for the removed account, so this load reads the network for a
                // row that is gone, as a real load does when the account goes between its two reads.
                removeAccountAndWait(manager, account)
                assertNull("with the account row gone there is no reading", NotesLoader.network(context, account))
                reload()
                waitUntil("step 12: the screen to close once its account is gone") { scenario.state == Lifecycle.State.DESTROYED }
            }
        } finally {
            NotesNetwork.readingOverride = null
            notesFixtureOverride = null
            NotesSyncCoordinator.runnerOverride = null
            NotesSyncCoordinator.cancelAccount(account.type, account.name)
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
        assertNull("this case leaves the network reading as it found it", NotesNetwork.readingOverride)
    }

    private fun notesToggle(activity: AppSettingsActivity): SwitchPreferenceCompat {
        activity.supportFragmentManager.executePendingTransactions()
        val fragment = activity.supportFragmentManager.findFragmentById(android.R.id.content) as AppSettingsActivity.CategoryFragment
        return fragment.findPreference("notes_enabled")!!
    }

    private fun notesNetworkRow(activity: AppSettingsActivity, key: String): ListPreference {
        activity.supportFragmentManager.executePendingTransactions()
        val fragment = activity.supportFragmentManager.findFragmentById(android.R.id.content) as AppSettingsActivity.CategoryFragment
        return fragment.findPreference<ListPreference>(key)!!
    }

    private fun notebookListPosition(scenario: ActivityScenario<NotesActivity>): Int {
        var position = -1
        scenario.onActivity { position = it.findViewById<ListView?>(R.id.notebooks_list)?.firstVisiblePosition ?: -1 }
        return position
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
