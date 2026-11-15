package io.silentsuite.sync.notes

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.DialogInterface
import android.content.SyncResult
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.CalendarContract
import android.system.Os
import android.system.OsConstants
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import at.bitfire.ical4android.TaskProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.etebase.client.Client
import com.etebase.client.Collection
import com.etebase.client.Item
import com.etebase.client.ItemManager
import com.etebase.client.ItemMetadata
import com.etebase.client.User
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.notes.edit.HeldReason
import io.silentsuite.sync.notes.edit.NoteMetaCodec
import io.silentsuite.sync.notes.edit.NotePushPolicy
import io.silentsuite.sync.notes.edit.PendingCodec
import io.silentsuite.sync.notes.edit.PendingEntry
import io.silentsuite.sync.notes.edit.PendingNotesDiscardPermits
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.syncadapter.CalendarSyncManager
import io.silentsuite.sync.syncadapter.CollectionListRefresh
import io.silentsuite.sync.syncadapter.CollectionRefreshIncompleteException
import io.silentsuite.sync.syncadapter.EXTRA_FORCE_COLLECTION_REFRESH
import io.silentsuite.sync.syncadapter.StaleSyncRunException
import io.silentsuite.sync.syncadapter.SyncManager
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.syncadapter.requestSyncDispatchOverride
import io.silentsuite.sync.syncadapter.syncConditionsAllow
import io.silentsuite.sync.ui.ActiveAccountManager
import io.silentsuite.sync.ui.AndroidCurrentAccountSignOut
import io.silentsuite.sync.ui.CurrentAccountSignOutCoordinator
import io.silentsuite.sync.ui.CurrentAccountSignOutState
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.NotesLastActiveRecord
import io.silentsuite.sync.ui.NotesStartupSweep
import io.silentsuite.sync.ui.PendingNotesRemovalGuard
import io.silentsuite.sync.ui.ProcessIncarnation
import io.silentsuite.sync.ui.UnsyncedNotesStores
import io.silentsuite.sync.ui.notes.HeldTextFragment
import io.silentsuite.sync.ui.notes.HeldTextRow
import io.silentsuite.sync.ui.notes.NoteContent
import io.silentsuite.sync.ui.notes.NoteEditorViewModel
import io.silentsuite.sync.ui.notes.PendingUnavailable
import io.silentsuite.sync.ui.notes.SaveResult
import io.silentsuite.sync.ui.notes.NoteListFragment
import io.silentsuite.sync.ui.notes.NoteRow
import io.silentsuite.sync.ui.notes.NoteSync
import io.silentsuite.sync.ui.notes.NoteViewFragment
import io.silentsuite.sync.ui.notes.NotebookListFragment
import io.silentsuite.sync.ui.notes.NotebookOverview
import io.silentsuite.sync.ui.notes.NotesActivity
import io.silentsuite.sync.ui.notes.NotesLoad
import io.silentsuite.sync.ui.notes.NotesLoader
import io.silentsuite.sync.ui.notes.notesFixtureOverride
import io.silentsuite.sync.utils.AndroidCompat
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.logging.Handler
import java.util.logging.LogRecord
import kotlin.concurrent.thread

/**
 * The Notes job, the shared collection refresh and the Notes screens' loader, run for real
 * (coordinator, runner, refresh, loader, Etebase binding, local cache, account store, status store)
 * against an in-process stand-in for the server ([FakeEtebaseServer]) that serves real encrypted
 * notebooks and notes a page at a time, can hold a request in flight, can make a listing never
 * finish, and checks etags on upload as the project's server does. Most sync cases hold one request,
 * change something while it is in flight, release it, and check exactly what was written. The stall
 * cases make a listing never finish and check where each paging loop stops and how the next run
 * recovers; one of them runs the calendar adapter's own sync manager against a local calendar. The
 * loader cases read what a real sync cached, with no fixture in between. The push cases save into
 * the pending store by note uid, with no editor open, then check what a real run sent, what the
 * server and the cache hold afterwards, and what the run recorded, against a server that behaves
 * and one that misbehaves in a given way. One of them opens an editor handle before its run, so
 * that the push leaves a landed record to look at. Three of them hold the upload in flight and
 * cancel the run, switch Notes off, sign out or replace the account before its answer arrives.
 * Four cases give a notebook's notes listing a 404 while the notebook may still be there; two of
 * them hold the fetch of the notebook that would confirm it, and cancel the run, switch Notes off
 * or replace the account before its answer arrives.
 * Two cases pin what the device's network reads as, run by run, and check which runs the two Notes
 * network settings and the account's own Wi-Fi rule admit. The second ends with two steps that
 * take the pin off and read the device's own network; both are written to pass on any network.
 * Every other case runs with the reading pinned to Wi-Fi, so none of its assertions depends on
 * the network of the device. Some cases also read the pending store's files
 * from disk: none holds a title, a text or a notebook name in plain form, and they are still there, byte for byte, after a cache clear and
 * after a same-name account replaced the one that saved them. One case runs the startup sweep
 * ([NotesStartupSweep]) over the stores of removed accounts, and checks which it removed and which
 * it kept byte for byte. One case sends nothing: it compares
 * the raw metadata codec with the binding's typed encoder and decoder
 * ([NoteMetaBindingComparison]), on a notebook that is never uploaded.
 * Ten cases drive the note editor through the real screens, its view model and its store calls: a
 * new note off Wi-Fi, a conflicted copy, access lost while editing, a save that lands while a Discard
 * is asked, no editing while a discard is unfinished or the local text cannot be read, sign-out with
 * the editor open, a save during a run, undo, other clients' metadata, and font scale 2. Each of
 * them shows with [MainThreadStoreProbe] that no store call ran on the main thread.
 */
@RunWith(AndroidJUnit4::class)
class NotesSyncBoundaryRuntimeTest {
    /** For the one case that runs the calendar adapter's own item fetch against a local calendar. */
    @get:Rule
    val calendarPermissions: GrantPermissionRule =
        GrantPermissionRule.grant(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager = AccountManager.get(context)
    private val fake = FakeEtebaseServer()
    private val names = mutableSetOf<String>()
    private val dispatched = CopyOnWriteArrayList<Bundle>()
    private var previousMasterSync = true

    /** The notebooks this test uploaded, as the server side holds them, by uid. */
    private val uploaded = HashMap<String, Collection>()

    /** The pending stores this test opened, cleared when it ends. */
    private val stores = CopyOnWriteArrayList<PendingNotesStore>()

    /** The NOTES status of the account the last manual run was started for, as it was right before that run. */
    private var statusBeforeRun: SyncStatusStore.Status? = null

    /**
     * Android 5 and 6 handle an account change on system_server's main thread by walking
     * SyncManager's list of running syncs, which its handler thread changes without a lock
     * (android-5.0.2_r1 SyncManager.java:189, 231-240, 268-288, 2699, 2880; moved to the handler
     * thread in 7.0). A platform sync that starts or ends meanwhile throws there and restarts the
     * whole system. With master sync off, the only syncs the platform starts for this class's
     * accounts are the task adapters' initialization syncs, so on those releases every account is
     * unsyncable before its account-change broadcast is handled, and every account change here waits
     * until no platform sync runs.
     */
    private val syncManagerRacesAccountChanges = Build.VERSION.SDK_INT < Build.VERSION_CODES.N
    private val taskAuthorities = TaskProvider.TASK_PROVIDERS.map { it.authority }
    /** Task adapters first: they are the only ones the platform starts while master sync is off. */
    private val adapterAuthorities = taskAuthorities + listOf(CalendarContract.AUTHORITY, App.addressBooksAuthority)

    /** The server side as the test sees it: the same Etebase user, talking to the same stand-in. */
    private val server by lazy {
        com.etebase.client.Account.restore(Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl), session, null)
    }

    @Before fun setUp() {
        // The startup sweep of this process is over before a case makes a store folder.
        runBlocking { NotesStartupSweep.startup?.join() }
        previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        // No platform adapter sync may reach the stand-in server while a test holds a request.
        ContentResolver.setMasterSyncAutomatically(false)
        HttpClient.testInterceptor = fake
        requestSyncDispatchOverride = { _, _, extras -> dispatched += Bundle(extras) }
        // Every case starts with the network reading pinned to Wi-Fi, so its runs do not decide on
        // the device's own network. A case may pin another reading, and one case takes the pin off
        // for its last two steps.
        check(NotesNetwork.readingOverride == null) { "another test left the network reading pinned" }
        NotesNetwork.readingOverride = { NotesNetworkPolicy.Reading(NotesNetworkPolicy.Connection.WIFI) }
    }

    @After fun tearDown() {
        fake.releaseAll()
        for (name in names) NotesSyncCoordinator.cancelAccount(App.accountType, name)
        val drained = NotesSyncCoordinator.drainForTesting(30_000)
        // The process-wide hooks are restored whatever fails here, so one failure cannot spread to
        // the other classes that run in the same instrumentation process.
        val problems = mutableListOf<Throwable>()
        try {
            // Only a sign-out clears the pending store, and most cases end without one.
            for (store in stores) runCatching { store.clearAll() }.exceptionOrNull()?.let(problems::add)
            for (name in names) {
                runCatching { removeAccount(Account(name, App.accountType)) }.exceptionOrNull()?.let(problems::add)
                runCatching {
                    EtebaseLocalCache.clearUserCache(context, name)
                    forgetLastListing(name)
                }.exceptionOrNull()?.let(problems::add)
            }
            // No platform sync started for this class's accounts is left running for the next class.
            runCatching { awaitSyncManagerQuiet() }.exceptionOrNull()?.let(problems::add)
        } finally {
            HttpClient.testInterceptor = null
            requestSyncDispatchOverride = null
            PendingNotesStore.listFilesForTesting = null
            NotesNetwork.readingOverride = null
            ContentResolver.setMasterSyncAutomatically(previousMasterSync)
        }
        assertTrue("the Notes thread finished", drained)
        problems.firstOrNull()?.let { throw it }
    }

    @Test fun forcedRefreshAfterAnInvitationReachesNotesWhicheverJobRunsFirst() {
        val account = newAccount("gen-force")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-force")
        // A first Notes sync saves the list cursor that a later listing would start from.
        NotesSyncCoordinator.request(context, account, "gen-force", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertNotNull(listCursor(account))

        // 1. Notes runs first and alone: the adapters' forced syncs are dispatched but never run.
        val first = uploadNotebook("Accepted first")
        fake.acceptedFromInvitation(first)
        val before = status(account, "gen-force")
        var mark = fake.requests.size
        requestSync(context, account, forceCollectionRefresh = true)
        awaitSettled(identity)
        assertTrue("every adapter was asked to force its refresh",
            dispatched.isNotEmpty() && dispatched.all { it.getBoolean(EXTRA_FORCE_COLLECTION_REFRESH) })
        assertTrue("Notes listed from scratch, although its last listing was seconds ago", listings(mark).any(::fromScratch))
        assertTrue(first in cachedNotebooks(account))
        assertEquals("the accepted notebook's notes were fetched", fake.itemStoken(first), notebookCursor(account, first))
        status(account, "gen-force").let {
            assertTrue("the forced run itself succeeded: $it", it.lastSuccessAt!! > before.lastSuccessAt!!)
            assertNull(it.lastFailureAt)
            assertNull(it.activeAttemptId)
        }

        // 2. The acceptance arrives while an ordinary Notes run is already listing from the cursor.
        forgetLastListing(account.name)
        val second = uploadNotebook("Accepted during a run")
        fake.acceptedFromInvitation(second)
        val listing = fake.hold("POST", LIST)
        mark = fake.requests.size
        NotesSyncCoordinator.request(context, account, "gen-force", NotesSyncPolicy.Trigger.SCREEN_OPEN)
        listing.awaitArrival()
        requestSync(context, account, forceCollectionRefresh = true)
        listing.release()
        awaitSettled(identity)
        val listed = listings(mark)
        assertFalse("the run in progress listed from its cursor", fromScratch(listed.first()))
        assertTrue("the follow-up it queued listed from scratch", listed.drop(1).any(::fromScratch))
        assertEquals(fake.itemStoken(second), notebookCursor(account, second))

        // 3. For comparison, an adapter's forced refresh runs first, then an ordinary Notes run.
        val third = uploadNotebook("Accepted, adapter first")
        fake.acceptedFromInvitation(third)
        val settings = AccountSettings(context, account)
        HttpClient.Builder(context, settings).setForeground(false).build().use {
            CollectionListRefresh.run(context, account, settings, it.okHttpClient, forceRefresh = true, creationId = "gen-force")
        }
        NotesSyncCoordinator.request(context, account, "gen-force", NotesSyncPolicy.Trigger.SCREEN)
        awaitSettled(identity)
        assertEquals(fake.itemStoken(third), notebookCursor(account, third))

        // 4. A forced refresh still applies what is pending under the saved cursor. A listing from
        // scratch never reports a lost membership, so without that a notebook this account lost
        // since its last listing would stay cached for good.
        fake.removeMembership(first)
        requestSync(context, account, forceCollectionRefresh = true)
        awaitSettled(identity)
        assertFalse("the lost notebook was dropped", first in cachedNotebooks(account))
        assertTrue(second in cachedNotebooks(account))
    }

    @Test fun aSameNameAccountThatReplacedTheOldOneGetsNothingFromTheOldRunsInFlightRequests() {
        val name = "notes-boundary-${System.nanoTime()}@example.invalid"
        val account = newAccount("gen-1", name, discoveryKey = false)
        // Both Notes network settings are moved off their defaults for the account that will be replaced.
        check(AccountSettings.writeNotesAutomaticNetwork(manager, account, NotesNetworkPolicy.Allowed.ANY_NETWORK))
        check(AccountSettings.writeNotesSyncNowNetwork(manager, account, NotesNetworkPolicy.Allowed.WIFI_ONLY))
        val notebook = uploadNotebook("Shared before the swap")
        // Three pages of notes.
        uploadNotes(notebook, "One", "Two", "Three", "Four", "Five")
        fake.itemPageSize = 2

        // 1. The collection list is in flight when the account is removed and a same-name one added.
        val listing = fake.hold("POST", LIST)
        NotesSyncCoordinator.request(context, account, "gen-1", NotesSyncPolicy.Trigger.MANUAL)
        listing.awaitArrival()
        replaceAccount(account, "gen-2")
        assertEquals("the replacement starts from the default network settings",
            NotesNetworkPolicy.Settings.DEFAULT, AccountSettings.notesNetworkSettings(manager, account))
        listing.release()
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertNull("no list cursor was saved", listCursor(account))
        assertTrue("no collection was cached", cachedNotebooks(account).isEmpty())
        assertNull("the replacement's discovery key was not written", AccountSettings.collectionListTypes(manager, account))
        assertTrue("no listing time was recorded", lastListingKeys(name).isEmpty())
        assertEquals("the replacement's status is untouched", SyncStatusStore.Status(), status(account, "gen-2"))
        assertClosedWithoutOutcome(status(account, "gen-1"))

        // 2. The notebook's second page of notes is in flight when the account is replaced again.
        val page = fake.hold("GET", ITEMS, skip = 1)
        NotesSyncCoordinator.request(context, account, "gen-2", NotesSyncPolicy.Trigger.MANUAL)
        page.awaitArrival()
        assertTrue("the listing before the pages was written while its generation was current", notebook in cachedNotebooks(account))
        assertEquals("so was the first page of notes", setOf("One", "Two"), cachedNotes(account, notebook))
        replaceAccount(account, "gen-3")
        page.release()
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertNothingWrittenFrom(page, account, notebook, alreadyCached = setOf("One", "Two"))
        assertEquals(SyncStatusStore.Status(), status(account, "gen-3"))
        assertClosedWithoutOutcome(status(account, "gen-2"))

        // 3. The shared refresh as the adapters call it, with no Notes job involved.
        val adapterListing = fake.hold("POST", LIST)
        val cursorBefore = listCursor(account)
        val failure = AtomicReference<Throwable?>()
        val settings = AccountSettings(context, account)
        val adapter = thread {
            try {
                HttpClient.Builder(context, settings).setForeground(false).build().use {
                    CollectionListRefresh.run(context, account, settings, it.okHttpClient, forceRefresh = true, creationId = "gen-3")
                }
            } catch (t: Throwable) {
                failure.set(t)
            }
        }
        adapterListing.awaitArrival()
        replaceAccount(account, "gen-4")
        adapterListing.release()
        adapter.join(30_000)
        assertTrue("the old refresh stopped as stale: ${failure.get()}", failure.get() is StaleSyncRunException)
        assertEquals("the list cursor did not move", cursorBefore, listCursor(account))
        assertNull(AccountSettings.collectionListTypes(manager, account))
        assertTrue(lastListingKeys(name).none { it.endsWith("gen-4") || it.endsWith("gen-3") })

        // 4. Unsynced text (#709: a new account with the same name must not overwrite old drafts or
        // inherit them). The account saves an edit and is then replaced as in steps 1 to 3: removed
        // and added again under the same name. Neither the old store nor the cache is cleared by that.
        val draft = uploadNote(notebook, "Kept on the server", "Server text", mtime = 9_000L)
        syncNow(account, "gen-4")
        assertTrue("the run fetched the pages that were left and the new note", "Kept on the server" in cachedNotes(account, notebook))
        editLocally(account, "gen-4", notebook, draft.uid, OLD_DRAFT_TITLE, OLD_DRAFT_BODY, mtime = 10_000L)
        val oldStore = pending(account, "gen-4")
        val seenByOwner = (NotesLoader.note(context, account, "gen-4", notebook, draft.uid) as NotesLoad.Loaded).value
        assertEquals("the old account sees its draft", listOf(OLD_DRAFT_TITLE, OLD_DRAFT_BODY, NoteSync.WAITING),
            listOf(seenByOwner.title, seenByOwner.body, seenByOwner.sync))
        val oldFiles = filesOnDisk(oldStore)
        assertEquals(setOf("${draft.uid}.note", "$notebook.notebook", "sequence"), oldFiles.keys)

        replaceAccount(account, "gen-5")
        val newStore = pending(account, "gen-5")
        assertFalse("a directory of its own", newStore.dir.canonicalPath == oldStore.dir.canonicalPath)
        assertEquals("next to the old one", oldStore.dir.parentFile, newStore.dir.parentFile)
        // Not inherited: by the store, by the loader the screens use, or by a sync run.
        assertEquals(PendingNotesStore.Observed(PendingNotesStore.Read.Missing, 0), newStore.observe(draft.uid))
        assertTrue(newStore.snapshot { true }.let { it.headers.isEmpty() && it.entries.isEmpty() && it.unreadable.isEmpty() })
        assertNull(newStore.notebook(notebook))
        assertEquals(NotesLoad.Stale, NotesLoader.note(context, account, "gen-4", notebook, draft.uid))
        val overview = (NotesLoader.notebooks(context, account, "gen-5") as NotesLoad.Loaded).value
        assertEquals("no unsynced text", 0, overview.unsyncedText)
        assertTrue("no waiting change on any notebook", overview.notebooks.all { it.waiting == 0 })
        assertEquals("the server's copy, with no local change over it",
            NoteContent(draft.uid, "Kept on the server", "Server text", 9_000L, writable = true),
            (NotesLoader.note(context, account, "gen-5", notebook, draft.uid) as NotesLoad.Loaded).value)
        val beforeRun = fake.requests.size
        syncNow(account, "gen-5")
        assertEquals("the replacement's run uploads nothing", emptyList<String>(), uploads(beforeRun))
        assertEquals("Server text", itemManager(notebook).fetch(draft.uid).contentString)

        // Not overwritten: the replacement saves the same note, and the old account's files are as they were.
        editLocally(account, "gen-5", notebook, draft.uid, "Replacement title", "Replacement text", mtime = 11_000L)
        assertSameFiles("the old account's store", oldFiles, filesOnDisk(oldStore))
        val theirs = (newStore.read(draft.uid) as PendingNotesStore.Read.Present).entry
        assertEquals("Replacement text", decryptThroughStoredCopy(newStore, theirs).contentString)
        // Nor when the replacement pushes that save.
        val beforePush = fake.requests.size
        syncNow(account, "gen-5")
        assertEquals("the replacement's push", listOf(transactionOf(notebook)), uploads(beforePush))
        assertEquals("Replacement text", itemManager(notebook).fetch(draft.uid).contentString)
        assertSameFiles("the old account's store after the replacement's push", oldFiles, filesOnDisk(oldStore))
        // Both accounts of this class use one Etebase session, so the old draft would decrypt for the
        // replacement. The directory per creation id is the only thing that keeps it out of reach.
        val old = (oldStore.read(draft.uid) as PendingNotesStore.Read.Present).entry
        assertEquals(OLD_DRAFT_BODY, decryptThroughStoredCopy(oldStore, old).contentString)
    }

    @Test fun aCancelledOrSwitchedOffRunWritesNothingAfterItsInFlightRequest() {
        val account = newAccount("gen-stop")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-stop")
        val notebook = uploadNotebook("Mine")
        // Four pages of notes. Every held page below has another page after it, so a run that went
        // on after its held page would be seen asking for the next one.
        uploadNotes(notebook, "One", "Two", "Three", "Four", "Five", "Six", "Seven")
        fake.itemPageSize = 2

        // 1. Sign-out cancels the run while the second page of notes is in flight. Like a blocking
        // socket read, the request does not stop for the interrupt; its answer arrives afterwards.
        val page = fake.hold("GET", ITEMS, skip = 1)
        NotesSyncCoordinator.request(context, account, "gen-stop", NotesSyncPolicy.Trigger.MANUAL)
        page.awaitArrival()
        NotesSyncCoordinator.cancelAccount(account.type, account.name)
        page.release()
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertNothingWrittenFrom(page, account, notebook, alreadyCached = setOf("One", "Two"))
        assertClosedWithoutOutcome(status(account, "gen-stop"))

        // The same when the network stack swallows the interrupt: then only the cancelled
        // schedule, not the thread's interrupt, can stop the write. This run starts at the saved
        // cursor, so the second page it asks for is the notebook's third.
        val swallowed = fake.hold("GET", ITEMS, swallowInterrupt = true, skip = 1)
        NotesSyncCoordinator.request(context, account, "gen-stop", NotesSyncPolicy.Trigger.MANUAL)
        swallowed.awaitArrival()
        NotesSyncCoordinator.cancelAccount(account.type, account.name)
        swallowed.release()
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertNothingWrittenFrom(swallowed, account, notebook, alreadyCached = setOf("One", "Two", "Three", "Four"))
        assertClosedWithoutOutcome(status(account, "gen-stop"))

        // The next run is not affected: it fetches the rest and writes normally.
        NotesSyncCoordinator.request(context, account, "gen-stop", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertEquals(setOf("One", "Two", "Three", "Four", "Five", "Six", "Seven"), cachedNotes(account, notebook))
        assertEquals(fake.itemStoken(notebook), notebookCursor(account, notebook))
        val succeeded = status(account, "gen-stop").lastSuccessAt
        assertNotNull(succeeded)

        // 2. Notes is switched off while a page is in flight, with no cancellation reaching the run.
        uploadNotes(notebook, "Eight", "Nine", "Ten", "Eleven", "Twelve")
        forgetLastListing(account.name)
        val secondPage = fake.hold("GET", ITEMS, skip = 1)
        NotesSyncCoordinator.request(context, account, "gen-stop", NotesSyncPolicy.Trigger.MANUAL)
        secondPage.awaitArrival()
        assertTrue(AccountSettings.writeNotesEnabled(manager, account, false))
        secondPage.release()
        awaitSettled(identity)
        assertNothingWrittenFrom(secondPage, account, notebook,
            alreadyCached = setOf("One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"))
        status(account, "gen-stop").let {
            assertEquals("no success was recorded for the switched-off run", succeeded, it.lastSuccessAt)
            assertNull(it.lastFailureAt)
            assertNull(it.activeAttemptId)
        }

        // 3. Switched off the way the settings screen does it (flag, then cancel) while the second
        // page of the collection list is in flight.
        assertTrue(AccountSettings.writeNotesEnabled(manager, account, true))
        forgetLastListing(account.name)
        val firstListed = uploadNotebook("Added elsewhere")
        val secondListed = uploadNotebook("Added after that")
        val thirdListed = uploadNotebook("Added last")
        fake.collectionPageSize = 1
        val listing = fake.hold("POST", LIST, skip = 1)
        NotesSyncCoordinator.request(context, account, "gen-stop", NotesSyncPolicy.Trigger.MANUAL)
        listing.awaitArrival()
        assertTrue(AccountSettings.writeNotesEnabled(manager, account, false))
        NotesSyncCoordinator.cancel(identity)
        listing.release()
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertTrue("the page before the held one was written while the run was wanted", firstListed in cachedNotebooks(account))
        assertFalse("the held page was not written", secondListed in cachedNotebooks(account))
        assertFalse("nor was the page after it", thirdListed in cachedNotebooks(account))
        assertEquals("the list cursor did not move past the held page", cursorOf(listing), listCursor(account))
        assertEquals("no list page was requested after the held one", listing.request, listings(0).last())
    }

    @Test fun aRequestHeldForOneAccountDoesNotDelayAnotherAccountsSync() {
        val slow = newAccount("gen-slow")
        val slowIdentity = ExactAccountIdentity(slow.type, slow.name, "gen-slow")
        val other = newAccount("gen-other")
        val notebook = uploadNotebook("Seen by both")
        uploadNotes(notebook, "One")

        // The first account's collection list hangs, as a slow or stalled connection would leave it.
        val listing = fake.hold("POST", LIST)
        NotesSyncCoordinator.request(context, slow, "gen-slow", NotesSyncPolicy.Trigger.MANUAL)
        listing.awaitArrival()

        NotesSyncCoordinator.request(context, other, "gen-other", NotesSyncPolicy.Trigger.MANUAL)
        waitUntil("the other account's sync to finish while the first is still waiting") {
            status(other, "gen-other").lastSuccessAt != null
        }
        assertEquals(setOf("One"), cachedNotes(other, notebook))
        // The coordinator, not the cache, says whether the first account's run is still going.
        assertTrue("the first account's run is still waiting for its answer", NotesSyncCoordinator.isActive(slowIdentity))

        listing.release()
        awaitSettled(slowIdentity)
        assertEquals(setOf("One"), cachedNotes(slow, notebook))
        assertNotNull(status(slow, "gen-slow").lastSuccessAt)
    }

    @Test fun aForcedRefreshCutShortByForegroundEditsIsStillOwedToTheNextNotesRun() {
        val account = newAccount("gen-owed")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-owed")
        val mine = uploadNotebook("Mine")
        // A first Notes sync saves the list cursor; the discovery key is already the current one.
        NotesSyncCoordinator.request(context, account, "gen-owed", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        val cursorBefore = listCursor(account)
        assertNotNull(cursorBefore)
        val before = status(account, "gen-owed")
        assertNotNull(before.lastSuccessAt)

        // An invitation is accepted: only a listing from scratch shows the notebook. The forced
        // sync that follows first lists from the saved cursor, and each of its three answers is
        // overtaken by an edit this device uploads and caches, so the refresh stops there, before
        // the listing from scratch.
        val accepted = uploadNotebook("Accepted")
        fake.acceptedFromInvitation(accepted)
        var mark = fake.requests.size
        val parked = List(3) { fake.hold("POST", LIST, answerFirst = true) }
        requestSync(context, account, forceCollectionRefresh = true)
        try {
            parked.forEachIndexed { index, answer ->
                answer.awaitArrival()
                readWhileHeld("this device's edit") { renameAsEditingDoes(account, mine, "Mine, edit ${index + 1}", cacheIt = true) }
                answer.release()
            }
        } finally {
            parked.forEach { it.release() }
        }
        awaitSettled(identity)
        assertEquals("the forced run asked three times from the saved cursor and never from scratch",
            listOf(cursorBefore, cursorBefore, cursorBefore), listings(mark).map(::cursorIn))
        assertFalse("the accepted notebook is not cached yet", accepted in cachedNotebooks(account))
        assertEquals("the list cursor did not move", cursorBefore, listCursor(account))
        status(account, "gen-owed").let {
            assertEquals("a run whose collection listing was cut short recorded no success: $it", before.lastSuccessAt, it.lastSuccessAt)
            assertNull("no attempt left open: $it", it.activeAttemptId)
        }

        // The next ordinary request still owes the listing from scratch, makes it, and completes.
        mark = fake.requests.size
        NotesSyncCoordinator.request(context, account, "gen-owed", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertTrue("the owed listing from scratch was made: ${listings(mark)}", listings(mark).any(::fromScratch))
        assertTrue("the accepted notebook was cached", accepted in cachedNotebooks(account))
        assertEquals("the accepted notebook's notes were fetched", fake.itemStoken(accepted), notebookCursor(account, accepted))
        assertEquals("Mine, edit 3", cachedNotebookName(account, mine))
        assertFalse("the cursor moved on", listCursor(account) == cursorBefore)
        status(account, "gen-owed").let {
            assertTrue("the completed run succeeded: $it", it.lastSuccessAt!! > before.lastSuccessAt!!)
            assertNull(it.activeAttemptId)
        }

        // With nothing owed any more, a further ordinary run lists from its cursor again.
        forgetLastListing(account.name)
        mark = fake.requests.size
        NotesSyncCoordinator.request(context, account, "gen-owed", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertTrue("an ordinary listing followed: ${listings(mark)}", listings(mark).isNotEmpty() && listings(mark).none(::fromScratch))
    }

    @Test fun aHeldCollectionListLeavesItsAccountsCacheOpenToOtherReaders() {
        val name = "notes-boundary-${System.nanoTime()}@example.invalid"
        val account = newAccount("gen-open", name)
        val first = uploadNotebook("Listed first")
        val second = uploadNotebook("Listed second")
        fake.collectionPageSize = 1

        // 1. The second page of the collection list hangs, as a slow or stalled connection would
        // leave it. Everything else that reads this account's cache still gets in, and sees exactly
        // what the first page published.
        val listing = fake.hold("POST", LIST, skip = 1)
        val refresh = BackgroundRefresh(account, "gen-open")
        try {
            listing.awaitArrival()
            assertEquals("the first page's cursor was published before the second page was asked for",
                cursorOf(listing), readWhileHeld("a read of the list cursor") { listCursor(account) })
            assertEquals(setOf(first), readWhileHeld("a read of the cached collections") { cachedNotebooks(account) })
            val shown = readWhileHeld("the Notes screen's load") { NotesLoader.notebooks(context, account, "gen-open") }
            assertEquals(listOf("Listed first"), (shown as NotesLoad.Loaded).value.notebooks.map { it.name })
            assertTrue("the refresh is still waiting for its answer", refresh.thread.isAlive)
        } finally {
            listing.release()
        }
        assertNull("the refresh finished normally", refresh.await())
        assertEquals("the held page was written, its generation still being current", setOf(first, second), cachedNotebooks(account))
        val published = listCursor(account)
        assertNotNull(published)
        assertFalse("the cursor moved on past the held page", published == cursorOf(listing))
        assertTrue("the listing time was recorded for this generation", lastListingKeys(name).any { it.endsWith("gen-open") })

        // 2. A listing is in flight when a same-name account replaces this one. Readers still get in
        // meanwhile, and the answer that arrives afterwards is not written.
        val third = uploadNotebook("Added before the swap")
        forgetLastListing(name)
        val late = fake.hold("POST", LIST)
        val stale = BackgroundRefresh(account, "gen-open")
        try {
            late.awaitArrival()
            replaceAccount(account, "gen-next")
            assertEquals(published, readWhileHeld("a read of the list cursor after the swap") { listCursor(account) })
        } finally {
            late.release()
        }
        assertTrue("the old refresh stopped as stale: ${stale.await()}", stale.await() is StaleSyncRunException)
        assertEquals("the list cursor did not move", published, listCursor(account))
        assertFalse("the late page was not written", third in cachedNotebooks(account))
        assertNull("the replacement's discovery key was not written", AccountSettings.collectionListTypes(manager, account))
        assertTrue("no listing time was recorded", lastListingKeys(name).isEmpty())

        // The replacement's own refresh is not affected: it lists and writes normally.
        assertNull(BackgroundRefresh(account, "gen-next").await())
        assertEquals(setOf(first, second, third), cachedNotebooks(account))
        assertEquals(CollectionListRefresh.discoveryTypesKey, AccountSettings.collectionListTypes(manager, account))
    }

    @Test fun aListAnswerBuiltBeforeAForegroundEditDoesNotReplaceTheEditInTheCache() {
        val account = newAccount("gen-edit")
        val notebook = uploadNotebook("First name")
        assertNull(BackgroundRefresh(account, "gen-edit").await())
        assertEquals("First name", cachedNotebookName(account, notebook))

        // 1. For comparison, nothing is written here while a list answer is on its way back. Another
        // device renamed the notebook; the answer carrying that is built, parked, and then arrives.
        renameAsEditingDoes(account, notebook, "Renamed elsewhere", cacheIt = false)
        forgetLastListing(account.name)
        val unopposed = fake.hold("POST", LIST, answerFirst = true)
        val plain = BackgroundRefresh(account, "gen-edit")
        try {
            unopposed.awaitArrival()
            assertEquals("the answer is built but has not arrived", "First name",
                readWhileHeld("a read of the cached notebook") { cachedNotebookName(account, notebook) })
        } finally {
            unopposed.release()
        }
        assertNull(plain.await())
        assertEquals("the other device's rename was cached", "Renamed elsewhere", cachedNotebookName(account, notebook))

        // 2. The other device renames it again and the answer carrying that revision is built and
        // parked. Before it arrives, this device edits the notebook the way the edit screen saves:
        // upload, then cache the uploaded revision under the cache's monitor. The server now holds
        // this device's revision, so the parked answer is out of date when it gets here.
        renameAsEditingDoes(account, notebook, "Renamed elsewhere again", cacheIt = false)
        forgetLastListing(account.name)
        val mark = fake.requests.size
        val outdated = fake.hold("POST", LIST, answerFirst = true)
        val late = BackgroundRefresh(account, "gen-edit")
        try {
            outdated.awaitArrival()
            assertEquals("exactly the parked list request was sent", listOf(outdated.request), listings(mark))
            readWhileHeld("this device's edit") { renameAsEditingDoes(account, notebook, "Renamed here", cacheIt = true) }
            assertEquals("the edit was cached", "Renamed here", cachedNotebookName(account, notebook))
        } finally {
            outdated.release()
        }
        assertNull("the refresh finished normally", late.await())
        assertEquals("the answer built before the edit did not put the older revision back",
            "Renamed here", cachedNotebookName(account, notebook))

        // The next ordinary refresh agrees with the server, which holds this device's revision.
        forgetLastListing(account.name)
        assertNull(BackgroundRefresh(account, "gen-edit").await())
        assertEquals("Renamed here", cachedNotebookName(account, notebook))
    }

    @Test fun aListPageOvertakenByForegroundEditsIsAskedForAgainAFewTimesAndThenLeftForTheNextRefresh() {
        val account = newAccount("gen-again")
        val kept = uploadNotebook("Kept")
        val lost = uploadNotebook("Lost elsewhere")
        assertNull(BackgroundRefresh(account, "gen-again").await())
        assertEquals(setOf(kept, lost), cachedNotebooks(account))

        // 1. An answer that reports a lost membership is built and parked, and this device edits
        // another notebook before it arrives. The page is asked for again from the same cursor, and
        // that answer is applied: the lost notebook goes, the edit stays.
        fake.removeMembership(lost)
        forgetLastListing(account.name)
        var mark = fake.requests.size
        val removal = fake.hold("POST", LIST, answerFirst = true)
        val refresh = BackgroundRefresh(account, "gen-again")
        try {
            removal.awaitArrival()
            readWhileHeld("this device's edit") { renameAsEditingDoes(account, kept, "Kept, renamed here", cacheIt = true) }
        } finally {
            removal.release()
        }
        assertNull("the refresh finished normally", refresh.await())
        assertEquals("the page was asked for once more, from the same cursor",
            listOf(cursorOf(removal), cursorOf(removal)), listings(mark).map(::cursorIn))
        assertEquals("the lost notebook was dropped", setOf(kept), cachedNotebooks(account))
        assertEquals("Kept, renamed here", cachedNotebookName(account, kept))
        assertTrue("the listing time was recorded", lastListingKeys(account.name).any { it.endsWith("gen-again") })

        // 2. Every answer for a page is overtaken by another edit here. The refresh asks three
        // times, then reports incompletion, without moving the cursor and without recording a
        // listing time, so the next refresh lists again.
        forgetLastListing(account.name)
        val cursorBefore = listCursor(account)
        mark = fake.requests.size
        val parked = List(3) { fake.hold("POST", LIST, answerFirst = true) }
        val crowded = BackgroundRefresh(account, "gen-again")
        try {
            parked.forEachIndexed { index, answer ->
                answer.awaitArrival()
                readWhileHeld("this device's edit") { renameAsEditingDoes(account, kept, "Edit ${index + 1}", cacheIt = true) }
                answer.release()
            }
        } finally {
            parked.forEach { it.release() }
        }
        assertTrue("the refresh reports truthful incompletion", crowded.await() is CollectionRefreshIncompleteException)
        assertEquals("the page was asked for three times, from the same cursor",
            listOf(cursorBefore, cursorBefore, cursorBefore), listings(mark).map(::cursorIn))
        assertEquals("the list cursor did not move", cursorBefore, listCursor(account))
        assertEquals("the last edit is what is cached", "Edit 3", cachedNotebookName(account, kept))
        assertTrue("no listing time was recorded", lastListingKeys(account.name).isEmpty())

        // The next refresh is not affected: it lists, writes and records its time normally.
        assertNull(BackgroundRefresh(account, "gen-again").await())
        assertEquals("Edit 3", cachedNotebookName(account, kept))
        assertFalse("the cursor moved on", listCursor(account) == cursorBefore)
        assertTrue(lastListingKeys(account.name).any { it.endsWith("gen-again") })
    }

    @Test fun aReaskedCollectionPageDoesNotLookLikeAStallButAnAppliedRepeatedCursorDoes() {
        val account = newAccount("gen-retry-stall")
        val edited = uploadNotebook("First name")
        assertNull(BackgroundRefresh(account, "gen-retry-stall").await())
        val saved = listCursor(account)
        assertNotNull(saved)

        // 1. A listing of several pages. The answer to its first page is built and parked, and this
        // device edits a notebook before it arrives, so that page is asked for again from the same
        // cursor. Asking twice from one cursor is not a listing that fails to move on: the page was
        // not applied the first time, and the listing goes on to its end.
        fake.collectionPageSize = 1
        val added = listOf(uploadNotebook("Added one"), uploadNotebook("Added two"), uploadNotebook("Added three"))
        forgetLastListing(account.name)
        var mark = fake.requests.size
        val overtaken = fake.hold("POST", LIST, answerFirst = true)
        val paged = BackgroundRefresh(account, "gen-retry-stall")
        try {
            overtaken.awaitArrival()
            readWhileHeld("this device's edit") { renameAsEditingDoes(account, edited, "Renamed here", cacheIt = true) }
        } finally {
            overtaken.release()
        }
        val pagedOutcome = paged.await()
        assertNull("a page asked for again was not taken for a stalled listing: $pagedOutcome", pagedOutcome)
        val pagedCursors = listings(mark).map(::cursorIn)
        assertEquals("the first page was asked for twice, from the saved cursor: $pagedCursors",
            listOf(saved, saved), pagedCursors.take(2))
        val laterCursors = pagedCursors.drop(2)
        assertTrue("further pages followed: $pagedCursors", laterCursors.isNotEmpty())
        assertTrue("every later page was asked for from a cursor: $pagedCursors", laterCursors.none { it == null })
        assertEquals("no later page was asked for twice: $pagedCursors", laterCursors.size, laterCursors.toSet().size)
        assertFalse("no later page went back to the saved cursor: $pagedCursors", saved in laterCursors)
        assertEquals("every notebook was cached", setOf(edited) + added, cachedNotebooks(account))
        assertEquals("the edit was kept", "Renamed here", cachedNotebookName(account, edited))
        assertTrue("the listing time was recorded", lastListingKeys(account.name).any { it.endsWith("gen-retry-stall") })

        // 2. The server now answers every list request "not done" with the cursor it was asked with.
        // The first answer is overtaken by an edit here and is not applied, so it says nothing yet.
        // The page is asked for again, that answer is applied, and its cursor is the one the listing
        // started from: the listing is not moving on, and the refresh ends there.
        val before = listCursor(account)
        assertNotNull(before)
        forgetLastListing(account.name)
        fake.stalledCollectionList = FakeEtebaseServer.Stall.SAME_CURSOR
        mark = fake.requests.size
        val ignored = fake.hold("POST", LIST, answerFirst = true)
        val stalled = BackgroundRefresh(account, "gen-retry-stall")
        try {
            ignored.awaitArrival()
            readWhileHeld("this device's edit") { renameAsEditingDoes(account, edited, "Renamed again", cacheIt = true) }
        } finally {
            ignored.release()
        }
        val stalledOutcome = stalled.await()
        assertTrue("the refresh ended as a stalled listing: $stalledOutcome",
            stalledOutcome is io.silentsuite.sync.syncadapter.PagedListingStalledException)
        assertEquals("one answer was overtaken, and the one applied after it ended the listing",
            listOf(before, before), listings(mark).map(::cursorIn))
        assertEquals("the list cursor did not move", before, listCursor(account))
        assertTrue("no listing time was recorded", lastListingKeys(account.name).isEmpty())
        assertEquals("the edit was kept", "Renamed again", cachedNotebookName(account, edited))

        // Once the server answers properly again, the next refresh lists and completes as usual.
        fake.stalledCollectionList = null
        forgetLastListing(account.name)
        val recovered = BackgroundRefresh(account, "gen-retry-stall").await()
        assertNull("the next refresh finished normally: $recovered", recovered)
        assertEquals("Renamed again", cachedNotebookName(account, edited))
        assertEquals(setOf(edited) + added, cachedNotebooks(account))
        assertTrue("the listing time was recorded", lastListingKeys(account.name).any { it.endsWith("gen-retry-stall") })
    }

    @Test fun aNotebookWhoseNotesListingAnswersNotFoundWhileItStillExistsIsAFailureNotALostNotebook() {
        val account = newAccount("gen-item-404")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-item-404")
        val unlistable = uploadNotebook("Notes cannot be listed")
        val sibling = uploadNotebook("Sibling")
        uploadNotes(unlistable, "One")
        uploadNotes(sibling, "Two")

        // 1. The listing of one notebook's notes answers 404, but the notebook is still there: the
        // collection list still shows it and it can still be fetched by its uid. That is not a lost
        // notebook. Its sibling still syncs, it stays cached, and the run is not a success.
        fake.answerItemListNotFound(unlistable, true)
        val confirmMark = fake.requests.size
        NotesSyncCoordinator.request(context, account, "gen-item-404", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertTrue("the notes listing was asked for and answered 404", itemRequests(unlistable).isNotEmpty())
        assertEquals("the sibling's notes were synced", setOf("Two"), cachedNotes(account, sibling))
        assertEquals("the sibling's cursor was saved", fake.itemStoken(sibling), notebookCursor(account, sibling))
        assertTrue("the notebook is still cached", unlistable in cachedNotebooks(account))
        assertNull("no cursor was saved for the notebook whose notes could not be listed", notebookCursor(account, unlistable))
        status(account, "gen-item-404").let {
            assertNull("a run that could not list an existing notebook's notes recorded no success: $it", it.lastSuccessAt)
            assertNotNull("it recorded a failure: $it", it.lastFailureAt)
            assertNull("no attempt left open: $it", it.activeAttemptId)
        }
        assertEquals("the notebook itself was fetched to confirm it is still there", 1, notebookFetches(confirmMark, unlistable))

        // Once the listing answers again, the next run fetches that notebook's notes and succeeds.
        fake.answerItemListNotFound(unlistable, false)
        forgetLastListing(account.name)
        NotesSyncCoordinator.request(context, account, "gen-item-404", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertEquals(setOf("One"), cachedNotes(account, unlistable))
        assertEquals(fake.itemStoken(unlistable), notebookCursor(account, unlistable))
        val recovered = status(account, "gen-item-404").lastSuccessAt
        assertNotNull("the recovered run succeeded", recovered)

        // 2. For comparison, a notebook that really is gone. Its notes changed, and the list answer
        // that says so is built before the account loses the notebook and arrives after. The notes
        // listing then answers 404 and so does the notebook itself: it is skipped, the sibling is
        // unaffected, and the run is a success.
        uploadNotes(unlistable, "Three")
        forgetLastListing(account.name)
        val asked = itemRequests(unlistable).size
        val goneMark = fake.requests.size
        val listing = fake.hold("POST", LIST, answerFirst = true)
        NotesSyncCoordinator.request(context, account, "gen-item-404", NotesSyncPolicy.Trigger.MANUAL)
        try {
            listing.awaitArrival()
            fake.removeMembership(unlistable)
        } finally {
            listing.release()
        }
        awaitSettled(identity)
        assertTrue("the gone notebook's notes listing was asked for", itemRequests(unlistable).size > asked)
        assertEquals("nothing new was cached for the gone notebook", setOf("One"), cachedNotes(account, unlistable))
        assertEquals(setOf("Two"), cachedNotes(account, sibling))
        status(account, "gen-item-404").let {
            assertTrue("a run that only skipped a lost notebook succeeded: $it", it.lastSuccessAt!! > recovered!!)
            assertNull("no attempt left open: $it", it.activeAttemptId)
        }
        assertEquals("the gone notebook was fetched to confirm it is gone", 1, notebookFetches(goneMark, unlistable))
    }

    @Test fun aNotebookWhoseExistenceCannotBeConfirmedAfterANotesListing404IsStillAFailure() {
        val account = newAccount("gen-item-404-unconfirmed")
        val unconfirmed = uploadNotebook("Existence cannot be confirmed")
        val sibling = uploadNotebook("Sibling")
        uploadNotes(unconfirmed, "One")
        uploadNotes(sibling, "Two")
        val before = syncedThenChangedOnServer(account, "gen-item-404-unconfirmed", unconfirmed, "Changed elsewhere")

        // The notes listing answers 404, and the fetch of the notebook that would confirm whether it
        // is still there fails too. A failed read is no proof the notebook is gone: the run is a failure.
        fake.answerItemListNotFound(unconfirmed, true)
        fake.answer("GET", Regex("collection/$unconfirmed/"), 500)
        val mark = fake.requests.size
        syncNow(account, "gen-item-404-unconfirmed")
        status(account, "gen-item-404-unconfirmed").let {
            assertEquals("a run whose notebook could not be confirmed recorded no new success: $it",
                before.status.lastSuccessAt, it.lastSuccessAt)
            assertTrue("it recorded a failure: $it", (it.lastFailureAt ?: 0L) > (before.status.lastFailureAt ?: 0L))
            assertNull("no attempt left open: $it", it.activeAttemptId)
        }
        val requests = fake.requests.drop(mark)
        val listed = requests.indexOfFirst { it.startsWith("POST collection/list_multi/") }
        val notesAsked = requests.indexOfFirst { it.startsWith("GET collection/$unconfirmed/item/") }
        assertTrue("the collection list was refreshed, then the notes were asked for: $requests", listed in 0 until notesAsked)
        assertEquals("the notebook itself was fetched once", 1, notebookFetches(mark, unconfirmed))
        assertEquals("the notebook's cursor did not move", before.cursor, notebookCursor(account, unconfirmed))
        assertEquals("nothing was fetched into the cache", before.notes, cachedNotes(account, unconfirmed))
        assertTrue("the notebook is still cached", unconfirmed in cachedNotebooks(account))

        // Once both answer again, the next run fetches the change and succeeds.
        fake.answerItemListNotFound(unconfirmed, false)
        val failed = status(account, "gen-item-404-unconfirmed")
        syncNow(account, "gen-item-404-unconfirmed")
        assertTrue("Changed elsewhere" in cachedNotes(account, unconfirmed))
        assertEquals(fake.itemStoken(unconfirmed), notebookCursor(account, unconfirmed))
        status(account, "gen-item-404-unconfirmed").let {
            assertTrue("the recovered run succeeded: $it", (it.lastSuccessAt ?: 0L) > (failed.lastSuccessAt ?: 0L))
            assertNull(it.activeAttemptId)
        }
    }

    @Test fun aNotebookCheckHeldAcrossCancellationRecordsNothingAndSendsNothingMore() {
        val account = newAccount("gen-check-cancel")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-check-cancel")
        val checked = uploadNotebook("Checked while cancelled")
        val sibling = uploadNotebook("Sibling")
        uploadNotes(checked, "One")
        uploadNotes(sibling, "Two")
        val before = syncedThenChangedOnServer(account, "gen-check-cancel", checked, "Changed elsewhere")

        // 1. The notes listing answers 404, and the fetch of the notebook that would confirm it is held.
        // The run is cancelled while it waits, the interrupt is swallowed, and the answer that then
        // arrives is an error that would end the whole run. The cancelled run records nothing.
        fake.answerItemListNotFound(checked, true)
        val confirming = fake.hold("GET", Regex("collection/$checked/"), swallowInterrupt = true)
        fake.answer("GET", Regex("collection/$checked/"), 503)
        val mark = fake.requests.size
        var through = -1
        try {
            startManualRun(account, "gen-check-cancel")
            confirming.awaitArrival()
            val heldAt = SystemClock.uptimeMillis()
            assertEquals("the held request is the fetch of the notebook", "GET collection/$checked/", confirming.request)
            through = fake.requests.size
            NotesSyncCoordinator.cancel(identity)
            release(confirming, heldAt)
        } finally {
            confirming.release()
        }
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertEquals("no request of any kind followed the held fetch", emptyList<String>(), fake.requests.drop(through))
        assertUnchangedBy("the cancelled run", account, "gen-check-cancel", checked, before)
        endNotebookCheckPhase(checked, mark)

        // 2. Notes is turned off while the fetch is held, and the notebook's real answer arrives.
        val other = newAccount("gen-check-off")
        val offBefore = syncedThenChangedOnServer(other, "gen-check-off", checked, "Changed again")
        fake.answerItemListNotFound(checked, true)
        val held = fake.hold("GET", Regex("collection/$checked/"), swallowInterrupt = true)
        val offMark = fake.requests.size
        var offThrough = -1
        try {
            startManualRun(other, "gen-check-off")
            held.awaitArrival()
            val heldAt = SystemClock.uptimeMillis()
            assertEquals("the held request is the fetch of the notebook", "GET collection/$checked/", held.request)
            offThrough = fake.requests.size
            assertTrue(AccountSettings.writeNotesEnabled(manager, other, false))
            release(held, heldAt)
        } finally {
            held.release()
        }
        try {
            assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
            assertEquals("no request of any kind followed the held fetch", emptyList<String>(), fake.requests.drop(offThrough))
            assertUnchangedBy("the run of an account whose Notes were turned off", other, "gen-check-off", checked, offBefore)
            endNotebookCheckPhase(checked, offMark)
        } finally {
            fake.answerItemListNotFound(checked, false)
        }
    }

    @Test fun aNotebookCheckHeldAcrossAccountReplacementLeavesBothGenerationsUntouched() {
        val account = newAccount("gen-check-old")
        val checked = uploadNotebook("Checked while replaced")
        val sibling = uploadNotebook("Sibling")
        uploadNotes(checked, "One")
        uploadNotes(sibling, "Two")
        val before = syncedThenChangedOnServer(account, "gen-check-old", checked, "Changed elsewhere")

        // A. The account is removed and a same-name one added while the confirming fetch is held, and
        // the answer that then arrives is an error that would end the whole run. Neither generation
        // gets an outcome from the old run.
        fake.answerItemListNotFound(checked, true)
        val confirming = fake.hold("GET", Regex("collection/$checked/"), swallowInterrupt = true)
        fake.answer("GET", Regex("collection/$checked/"), 503)
        val mark = fake.requests.size
        var through = -1
        try {
            startManualRun(account, "gen-check-old")
            confirming.awaitArrival()
            val heldAt = SystemClock.uptimeMillis()
            assertEquals("the held request is the fetch of the notebook", "GET collection/$checked/", confirming.request)
            through = fake.requests.size
            replaceAccount(account, "gen-check-new")
            release(confirming, heldAt)
        } finally {
            confirming.release()
        }
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertEquals("no request of any kind followed the held fetch", emptyList<String>(), fake.requests.drop(through))
        assertUnchangedBy("the replaced generation's run", account, "gen-check-old", checked, before)
        assertEquals("the replacement's status is untouched", SyncStatusStore.Status(), status(account, "gen-check-new"))
        endNotebookCheckPhase(checked, mark)

        // B. The same with the notebook's real answer.
        val other = newAccount("gen-check-old2")
        val otherBefore = syncedThenChangedOnServer(other, "gen-check-old2", checked, "Changed again")
        fake.answerItemListNotFound(checked, true)
        val held = fake.hold("GET", Regex("collection/$checked/"), swallowInterrupt = true)
        val otherMark = fake.requests.size
        var otherThrough = -1
        try {
            startManualRun(other, "gen-check-old2")
            held.awaitArrival()
            val heldAt = SystemClock.uptimeMillis()
            assertEquals("the held request is the fetch of the notebook", "GET collection/$checked/", held.request)
            otherThrough = fake.requests.size
            replaceAccount(other, "gen-check-new2")
            release(held, heldAt)
        } finally {
            held.release()
        }
        try {
            assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
            assertEquals("no request of any kind followed the held fetch", emptyList<String>(), fake.requests.drop(otherThrough))
            assertUnchangedBy("the replaced generation's run", other, "gen-check-old2", checked, otherBefore)
            assertEquals("the replacement's status is untouched", SyncStatusStore.Status(), status(other, "gen-check-new2"))
            endNotebookCheckPhase(checked, otherMark)
        } finally {
            fake.answerItemListNotFound(checked, false)
        }
    }

    @Test fun concurrentRefreshesOfOneAccountListOneAtATimeAndNeverMoveTheCursorBack() {
        val account = newAccount("gen-twice")
        val notebook = uploadNotebook("Listed once")
        assertNull(BackgroundRefresh(account, "gen-twice").await())
        val saved = listCursor(account)
        assertNotNull(saved)

        // Two adapters finish together and both ask for the list while the first answer is slow.
        val added = uploadNotebook("Added since")
        forgetLastListing(account.name)
        val mark = fake.requests.size
        val listing = fake.hold("POST", LIST)
        val one = BackgroundRefresh(account, "gen-twice")
        listing.awaitArrival()
        val two = BackgroundRefresh(account, "gen-twice")
        try {
            SystemClock.sleep(1_000)
            assertEquals("the second refresh sent no list request while the first was in flight", 1, listings(mark).size)
        } finally {
            listing.release()
        }
        assertNull(one.await())
        assertNull(two.await())

        val listed = listings(mark)
        val published = listCursor(account)
        assertEquals("the first refresh listed from the saved cursor", saved, cursorIn(listed.first()))
        assertFalse("the first refresh moved the cursor on", published == saved)
        // The second either shares the first one's listing or lists again from where the first got
        // to; it never lists again from the cursor the first started with, nor puts that one back.
        assertTrue("at most one more list request followed: $listed", listed.size <= 2)
        assertTrue("a second listing continued from the first one's cursor: $listed", listed.drop(1).all { cursorIn(it) == published })
        assertEquals(setOf(notebook, added), cachedNotebooks(account))
        assertTrue(lastListingKeys(account.name).any { it.endsWith("gen-twice") })
    }

    @Test fun runsForOneAccountNameStayInOrderAcrossItsGenerations() {
        val name = "notes-boundary-${System.nanoTime()}@example.invalid"
        val account = newAccount("gen-first", name)
        val nextIdentity = ExactAccountIdentity(account.type, name, "gen-second")
        val notebook = uploadNotebook("Mine")
        uploadNotes(notebook, "One")

        // The first generation's run waits for a page of notes, which it does without holding the
        // cache, so nothing but the worker's order keeps the next generation's run behind it.
        val page = fake.hold("GET", ITEMS)
        NotesSyncCoordinator.request(context, account, "gen-first", NotesSyncPolicy.Trigger.MANUAL)
        page.awaitArrival()
        replaceAccount(account, "gen-second")
        val listing = fake.hold("POST", LIST)
        assertEquals(NotesSyncPolicy.Decision.START,
            NotesSyncCoordinator.request(context, account, "gen-second", NotesSyncPolicy.Trigger.MANUAL))
        assertFalse("the next generation's run has not started", listing.arrivesWithin(500))
        assertTrue(NotesSyncCoordinator.isPending(nextIdentity))
        assertEquals(SyncStatusStore.Status(), status(account, "gen-second"))

        page.release()
        listing.awaitArrival()
        assertClosedWithoutOutcome(status(account, "gen-first"))
        listing.release()
        awaitSettled(nextIdentity)
        assertEquals(setOf("One"), cachedNotes(account, notebook))
        assertNotNull(status(account, "gen-second").lastSuccessAt)
    }

    @Test fun signOutWhileANotesRequestIsInFlightLeavesNothingBehind() {
        val account = newAccount("gen-out")
        val notebook = uploadNotebook("Signed out of")
        // Three pages of notes.
        uploadNotes(notebook, "One", "Two", "Three", "Four", "Five")
        fake.itemPageSize = 2

        val page = fake.hold("GET", ITEMS, skip = 1)
        NotesSyncCoordinator.request(context, account, "gen-out", NotesSyncPolicy.Trigger.MANUAL)
        page.awaitArrival()
        assertEquals("the first page was cached before sign-out", setOf("One", "Two"), cachedNotes(account, notebook))
        assertNotNull("the run is recorded as in progress", status(account, "gen-out").activeAttemptId)

        // The app's own sign-out, from start to finish, while the second page is still in flight.
        signOut(account, "gen-out")
        assertFalse(account in manager.getAccountsByType(account.type))
        val identity = ExactAccountIdentity(account.type, account.name, "gen-out")
        assertFalse("sign-out cancelled the Notes run", NotesSyncCoordinator.isActive(identity) || NotesSyncCoordinator.isPending(identity))
        assertTrue("sign-out cleared the cache: ${cacheFiles(account.name)}", cacheFiles(account.name).isEmpty())
        assertEquals("sign-out cleared the status", SyncStatusStore.Status(), status(account, "gen-out"))

        page.release()
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertTrue("the late page wrote nothing: ${cacheFiles(account.name)}", cacheFiles(account.name).isEmpty())
        assertEquals("the late run recorded nothing", SyncStatusStore.Status(), status(account, "gen-out"))
        assertEquals("no page was requested after the held one", page.request, itemRequests(notebook).last())

        // A same-name account that signs in afterwards starts from nothing and syncs normally.
        val next = newAccount("gen-in", account.name, discoveryKey = false)
        val nextIdentity = ExactAccountIdentity(next.type, next.name, "gen-in")
        assertNull(listCursor(next))
        assertTrue(cachedNotebooks(next).isEmpty())
        assertEquals(SyncStatusStore.Status(), status(next, "gen-in"))
        NotesSyncCoordinator.request(context, next, "gen-in", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(nextIdentity)
        assertEquals(setOf("One", "Two", "Three", "Four", "Five"), cachedNotes(next, notebook))
        assertEquals(fake.itemStoken(notebook), notebookCursor(next, notebook))
        assertNotNull(status(next, "gen-in").lastSuccessAt)

        // The same sign-out while the collection list is in flight. A list page written late would
        // bring the cache directory back for an account that no longer exists.
        uploadNotebook("Added before the second sign-out")
        forgetLastListing(next.name)
        val listing = fake.hold("POST", LIST)
        NotesSyncCoordinator.request(context, next, "gen-in", NotesSyncPolicy.Trigger.MANUAL)
        listing.awaitArrival()
        signOut(next, "gen-in")
        assertTrue("sign-out cleared the cache: ${cacheFiles(next.name)}", cacheFiles(next.name).isEmpty())
        listing.release()
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertTrue("the late list page wrote nothing: ${cacheFiles(next.name)}", cacheFiles(next.name).isEmpty())
        assertEquals("the late run recorded nothing", SyncStatusStore.Status(), status(next, "gen-in"))
    }

    @Test fun theNotesScreensShowWhatASyncCachedReadThroughTheRealLoader() {
        val account = newAccount("gen-read")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-read")
        val work = uploadNotebook("Work")
        val home = uploadNotebook("Home")
        uploadUndecodableNotebook()
        // An item whose metadata this client cannot decode (a name that is a number), once next to
        // readable notes and once as the only item of a notebook.
        val undecodable = TestMsgPack.encode(linkedMapOf("name" to 7L, "mtime" to 100L))
        uploadRawNote(work, undecodable, "not readable here")
        uploadRawNote(home, undecodable, "not readable here either")
        val agendaBody = "# Monday\n- budget\n- hiring"
        uploadNote(work, "Old plan", "First line of the old plan", mtime = 1_000L)
        val agenda = uploadNote(work, "Agenda", agendaBody, mtime = 2_000L)
        // A title with a four-byte character, uploaded as the bytes another client writes for it. A
        // regression check only: the typed name would show the same title here.
        val cart = "Shopping 🛒"
        uploadRawNote(work, TestMsgPack.encode(linkedMapOf("name" to cart, "mtime" to 500L)), "eggs")
        // A name under unsigned integer key 1, which the typed decoder reads as the name. The raw
        // bytes give no trusted name, so the note shows as Untitled: this is what tells the raw
        // path from the typed one.
        val underKeyOne = byteArrayOf(0x82.toByte()) + TestMsgPack.encode(1L) + TestMsgPack.encode("Under key one") +
            TestMsgPack.encode("mtime") + TestMsgPack.encode(100L)
        val keyOneNote = uploadRawNote(work, underKeyOne, "kept under key one")
        // Neither of these is a note to show: an item of another type, and a deleted note.
        uploadNote(work, "Attachment", "not Markdown", mtime = 3_000L, type = "application/octet-stream")
        val deleted = uploadNote(work, "Thrown away", "gone", mtime = 4_000L)
        deleted.delete()
        itemManager(work).batch(arrayOf(deleted))
        NotesSyncCoordinator.request(context, account, "gen-read", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertNull("the screens read the real cache, not a fixture", notesFixtureOverride)

        ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-read")).use { scenario ->
            // The notebook this client cannot decode is left out; the others show by name.
            waitUntil("the cached notebooks to show") { notebookList(scenario)?.renderedNotebooks?.map { it.name } == listOf("Home", "Work") }
            scenario.onActivity { activity ->
                val list = activity.findViewById<ListView>(R.id.notebooks_list)
                list.performItemClick(list.adapter.getView(1, null, list), 1, 1)
            }
            waitUntil("the cached notes to show") {
                noteList(scenario)?.renderedNotes?.map { it.title } == listOf("Agenda", "Old plan", cart, "")
            }
            assertEquals(listOf("Monday", "First line of the old plan", "eggs", "kept under key one"),
                noteList(scenario)!!.renderedNotes.map { it.preview })
            scenario.onActivity { activity ->
                val notes = activity.findViewById<ListView>(R.id.notes_list)
                assertEquals(context.getString(R.string.notes_untitled),
                    notes.adapter.getView(3, null, notes).findViewById<TextView>(R.id.note_title).text.toString())
                val unreadable = activity.findViewById<TextView>(R.id.notes_unreadable)
                assertEquals("the undecodable item is counted", View.VISIBLE, unreadable.visibility)
                assertEquals("1 item in this notebook could not be read", unreadable.text.toString())
            }
            scenario.onActivity { activity ->
                assertEquals("Work", activity.title.toString())
                val list = activity.findViewById<ListView>(R.id.notes_list)
                list.performItemClick(list.adapter.getView(0, null, list), 0, 0)
            }
            waitUntil("the cached note to show") { noteView(scenario)?.renderedNote != null }
            // The notebook takes writes, so the note opens in the editor, with the cached text as it is stored.
            assertEquals(NoteContent(agenda.uid, "Agenda", agendaBody, 2_000L, writable = true), noteView(scenario)!!.renderedNote)
            assertTrue(noteView(scenario)!!.editing)
            scenario.onActivity { activity ->
                assertEquals("Agenda", activity.findViewById<TextView>(R.id.note_title_edit).text.toString())
                assertEquals(agendaBody, activity.findViewById<TextView>(R.id.note_body_edit).text.toString())
            }
        }
        // Opening one note reads its title from the raw bytes too.
        assertEquals("", (NotesLoader.note(context, account, "gen-read", work, keyOneNote.uid) as NotesLoad.Loaded).value.title)

        // A notebook whose only item could not be read, after a sync, is not called empty.
        ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-read")).use { scenario ->
            waitUntil("the cached notebooks to show") { notebookList(scenario)?.renderedNotebooks?.map { it.name } == listOf("Home", "Work") }
            scenario.onActivity { activity ->
                val list = activity.findViewById<ListView>(R.id.notebooks_list)
                list.performItemClick(list.adapter.getView(0, null, list), 0, 0)
            }
            waitUntil("the unreadable line to show") {
                var shown = false
                scenario.onActivity { shown = it.findViewById<View?>(R.id.notes_unreadable)?.visibility == View.VISIBLE }
                shown
            }
            assertEquals(emptyList<NoteRow>(), noteList(scenario)!!.renderedNotes)
            assertNull("no empty state", noteList(scenario)!!.renderedEmptyState)
            scenario.onActivity { activity ->
                assertEquals("Home", activity.title.toString())
                assertEquals(View.GONE, activity.findViewById<View>(R.id.notes_empty).visibility)
                assertEquals("1 item in this notebook could not be read",
                    activity.findViewById<TextView>(R.id.notes_unreadable).text.toString())
            }
        }
        awaitSettled(identity)
    }

    @Test fun aLoadCaughtByASameNameReplacementIsDiscardedAndItsScreenCloses() {
        val name = "notes-boundary-${System.nanoTime()}@example.invalid"
        val account = newAccount("gen-old", name)
        val identity = ExactAccountIdentity(account.type, name, "gen-old")
        val notebook = uploadNotebook("Old notebook")
        val note = uploadNote(notebook, "Old note", "Old body", mtime = 1_000L)
        // Skipping this notebook is what lets the test park a load in the middle of its read.
        uploadUndecodableNotebook()
        NotesSyncCoordinator.request(context, account, "gen-old", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)

        val pause = ReadPause()
        val loads = mutableListOf<BackgroundLoad<*>>()
        try {
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-old")).use { scenario ->
                waitUntil("the old account's notebook to show") {
                    notebookList(scenario)?.renderedNotebooks?.map { it.name } == listOf("Old notebook")
                }
                awaitSettled(identity)
                val shown = notebookList(scenario)!!

                // One load is parked inside its read of the cache, after every check before the read...
                Logger.log.addHandler(pause)
                loads += BackgroundLoad { NotesLoader.notebooks(context, account, "gen-old") }
                assertTrue("a load reached its read of the cache", pause.arrived.await(30, TimeUnit.SECONDS))
                // ...and the screen's own reload and two more loads wait for the cache behind it.
                scenario.moveToState(Lifecycle.State.CREATED)
                scenario.moveToState(Lifecycle.State.RESUMED)
                waitUntil("the screen's reload to wait for the cache") { anotherLoadWaitsForTheCache(loads.map { it.thread }) }
                val waiting = listOf(
                    BackgroundLoad { NotesLoader.notebook(context, account, "gen-old", notebook) },
                    BackgroundLoad { NotesLoader.note(context, account, "gen-old", notebook, note.uid) },
                )
                loads += waiting
                waitUntil("the other loads to wait for the cache") { waiting.all { it.thread.state == Thread.State.BLOCKED } }

                // The account signs out and a same-name one signs in, with its own notes under the
                // same notebook and note ids, readable with the same session.
                signOut(account, "gen-old")
                val replacement = newAccount("gen-new", name, discoveryKey = false)
                cacheReplacementNotes(replacement, notebook, note)
                pause.release.countDown()

                for (load in loads) assertEquals("the old account's load was discarded", NotesLoad.Stale, load.await())
                waitUntil("the old account's screen to close") { scenario.state == Lifecycle.State.DESTROYED }
                assertEquals("the screen never showed the replacement's notebook",
                    listOf("Old notebook"), shown.renderedNotebooks.map { it.name })
            }
        } finally {
            pause.release.countDown()
            Logger.log.removeHandler(pause)
        }

        // The replacement's notes were in the cache all along, readable by the same loader.
        val theirNotebooks = NotesLoader.notebooks(context, account, "gen-new")
        assertEquals(listOf("Replacement notebook"), (theirNotebooks as NotesLoad.Loaded).value.notebooks.map { it.name })
        val theirNote = NotesLoader.note(context, account, "gen-new", notebook, note.uid)
        assertEquals(NoteContent(note.uid, "Replacement note", "Replacement body", 2_000L, writable = true), (theirNote as NotesLoad.Loaded).value)
    }

    @Test fun aNotebookListingThatNeverFinishesFailsAloneAndFinishesOnceTheServerRecovers() {
        val account = newAccount("gen-stall")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-stall")
        val stuck = uploadNotebook("Stuck")
        uploadNotes(stuck, "Kept one", "Kept two")
        val fine = uploadNotebook("Fine")
        uploadNotes(fine, "Other")

        // Every answer for the first notebook says "not done" and gives back the cursor it was asked with.
        fake.stallItemList(stuck, FakeEtebaseServer.Stall.SAME_CURSOR)
        NotesSyncCoordinator.request(context, account, "gen-stall", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertEquals("one request from scratch and one with the repeated cursor, then no more: ${itemRequests(stuck)}",
            2, itemRequests(stuck).size)
        assertEquals("the pages that did arrive are kept", setOf("Kept one", "Kept two"), cachedNotes(account, stuck))
        assertEquals("the other notebook still synced", setOf("Other"), cachedNotes(account, fine))
        assertEquals(fake.itemStoken(fine), notebookCursor(account, fine))
        status(account, "gen-stall").let {
            assertNull("a run with a notebook that could not finish is not a success: $it", it.lastSuccessAt)
            assertEquals("$it", SyncStatusStore.FailureCategory.UNKNOWN, it.lastFailureCategory)
            assertNull("the attempt is closed: $it", it.activeAttemptId)
        }

        // Now every answer says "not done" and gives no cursor at all. Its one page holds a note
        // this device has not seen yet, and that note is cached before the listing is given up.
        uploadNotes(stuck, "Kept three")
        fake.stallItemList(stuck, FakeEtebaseServer.Stall.NO_CURSOR)
        NotesSyncCoordinator.request(context, account, "gen-stall", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertEquals("one more request, then no more: ${itemRequests(stuck)}", 3, itemRequests(stuck).size)
        assertEquals("the page that arrived is applied before the listing is given up",
            setOf("Kept one", "Kept two", "Kept three"), cachedNotes(account, stuck))
        assertNull(status(account, "gen-stall").lastSuccessAt)

        // A later run starts from the cursor the stalled run saved. When the server gives that one
        // back, the first answer is already the repeat.
        assertEquals("i0", notebookCursor(account, stuck))
        fake.stallItemList(stuck, FakeEtebaseServer.Stall.SAME_CURSOR)
        NotesSyncCoordinator.request(context, account, "gen-stall", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertEquals("one request from the saved cursor, then no more: ${itemRequests(stuck)}", 4, itemRequests(stuck).size)
        assertNull(status(account, "gen-stall").lastSuccessAt)

        // Once the server answers properly again, the next run finishes the notebook.
        fake.stallItemList(stuck, null)
        NotesSyncCoordinator.request(context, account, "gen-stall", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertEquals(fake.itemStoken(stuck), notebookCursor(account, stuck))
        assertEquals(setOf("Kept one", "Kept two", "Kept three"), cachedNotes(account, stuck))
        assertNotNull(status(account, "gen-stall").lastSuccessAt)
    }

    @Test fun aCollectionListThatNeverFinishesEndsTheRunAsATemporaryFailureAndTheNextRunRecovers() {
        val account = newAccount("gen-list-stall")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-list-stall")
        val notebook = uploadNotebook("Listed")
        uploadNotes(notebook, "One")

        // Every list answer says "not done" and gives back the cursor it was asked with.
        fake.stalledCollectionList = FakeEtebaseServer.Stall.SAME_CURSOR
        var before = fake.requests.size
        NotesSyncCoordinator.request(context, account, "gen-list-stall", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertEquals("one listing from scratch and one with the repeated cursor, then no more: ${listings(before)}",
            2, listings(before).size)
        assertTrue("no notebook is fetched after a listing that could not finish", itemRequests(notebook).isEmpty())
        status(account, "gen-list-stall").let {
            assertNull("$it", it.lastSuccessAt)
            assertEquals("a listing the server cannot finish is its problem, to be retried: $it",
                SyncStatusStore.FailureCategory.NETWORK, it.lastFailureCategory)
            assertNull("the attempt is closed: $it", it.activeAttemptId)
        }

        // Now every list answer says "not done" and gives no cursor at all.
        fake.stalledCollectionList = FakeEtebaseServer.Stall.NO_CURSOR
        before = fake.requests.size
        NotesSyncCoordinator.request(context, account, "gen-list-stall", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertEquals("one listing, then no more: ${listings(before)}", 1, listings(before).size)
        assertEquals(SyncStatusStore.FailureCategory.NETWORK, status(account, "gen-list-stall").lastFailureCategory)
        assertNull(status(account, "gen-list-stall").lastSuccessAt)

        // A later run starts from the cursor the stalled run saved. When the server gives that one
        // back, the first answer is already the repeat.
        fake.stalledCollectionList = FakeEtebaseServer.Stall.SAME_CURSOR
        before = fake.requests.size
        NotesSyncCoordinator.request(context, account, "gen-list-stall", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertEquals("one listing from the saved cursor, then no more: ${listings(before)}", 1, listings(before).size)
        assertNull(status(account, "gen-list-stall").lastSuccessAt)

        // Once the server answers properly again, the next run lists and syncs as usual.
        fake.stalledCollectionList = null
        NotesSyncCoordinator.request(context, account, "gen-list-stall", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertEquals(setOf("One"), cachedNotes(account, notebook))
        val succeeded = status(account, "gen-list-stall").lastSuccessAt
        assertNotNull(succeeded)

        // A forced refresh makes two listings in one run: from the saved cursor, then from scratch.
        // The first finishes and the second never does. Each listing has its own guard, and the
        // force stays owed to the next run.
        val accepted = uploadNotebook("Accepted while the list stalls")
        fake.acceptedFromInvitation(accepted)
        val fromScratchListing = fake.hold("POST", LIST, skip = 1)
        before = fake.requests.size
        NotesSyncCoordinator.request(context, account, "gen-list-stall", NotesSyncPolicy.Trigger.MANUAL, forceRefresh = true)
        fromScratchListing.awaitArrival()
        fake.stalledCollectionList = FakeEtebaseServer.Stall.SAME_CURSOR
        fromScratchListing.release()
        awaitSettled(identity)
        listings(before).let {
            assertEquals("from the saved cursor, from scratch, then once with the repeated cursor: $it", 3, it.size)
            assertFalse(fromScratch(it[0]))
            assertTrue(fromScratch(it[1]))
            assertTrue(it[2].contains("stoken=f0"))
        }
        assertTrue("the page that did arrive is kept", accepted in cachedNotebooks(account))
        assertTrue("no notebook is fetched after a listing that could not finish", itemRequests(accepted).isEmpty())
        status(account, "gen-list-stall").let {
            assertEquals("no new success: $it", succeeded, it.lastSuccessAt)
            assertEquals("$it", SyncStatusStore.FailureCategory.NETWORK, it.lastFailureCategory)
            assertNull("the attempt is closed: $it", it.activeAttemptId)
        }

        // The force is still owed: an ordinary request lists from scratch again.
        fake.stalledCollectionList = null
        before = fake.requests.size
        NotesSyncCoordinator.request(context, account, "gen-list-stall", NotesSyncPolicy.Trigger.MANUAL)
        awaitSettled(identity)
        assertTrue("the owed force listed from scratch: ${listings(before)}", listings(before).any(::fromScratch))
        assertEquals(fake.itemStoken(accepted), notebookCursor(account, accepted))
    }

    @Test fun anAdapterItemListingThatNeverFinishesEndsAsATemporaryFailureAndTheNextSyncRecovers() {
        val account = newAccount("gen-adapter-stall")
        val settings = AccountSettings(context, account)
        val colMgr = server.collectionManager
        val remote = colMgr.create(Constants.ETEBASE_TYPE_CALENDAR, ItemMetadata().apply { name = "Stuck calendar" }, "")
        colMgr.upload(remote)
        val calendarUid = remote.uid
        HttpClient.Builder(context, settings).setForeground(false).build().use {
            CollectionListRefresh.run(context, account, settings, it.okHttpClient, forceRefresh = true, creationId = "gen-adapter-stall")
        }

        val provider = checkNotNull(context.contentResolver.acquireContentProviderClient(CalendarContract.AUTHORITY))
        try {
            val cached = cache(account).let { synchronized(it) { it.collectionGet(colMgr, calendarUid) } }
            LocalCalendar.create(account, provider, cached)
            val calendar = checkNotNull(LocalCalendar.findByName(account, provider, LocalCalendar.Factory, calendarUid))
            // The calendar adapter's own item fetch, as its sync service runs it.
            fun sync(result: SyncResult) = CalendarSyncManager(context, account, settings, Bundle(), CalendarContract.AUTHORITY, result,
                calendar, fake.baseUrl.toHttpUrl()).use { it.performSync() }

            // Every answer says "not done" and gives back the cursor it was asked with.
            fake.stallItemList(calendarUid, FakeEtebaseServer.Stall.SAME_CURSOR)
            val stalled = SyncResult()
            assertEquals(SyncManager.ProviderOutcome.FAILURE, sync(stalled))
            assertEquals("one request from scratch and one with the repeated cursor, then no more: ${itemRequests(calendarUid)}",
                2, itemRequests(calendarUid).size)
            // A temporary server error: counted as an I/O error to retry later, not as a broken
            // answer, and with no error notification.
            assertEquals(1L, stalled.stats.numIoExceptions)
            assertEquals(0L, stalled.stats.numParseExceptions)
            assertEquals(Constants.DEFAULT_RETRY_DELAY, stalled.delayUntil)
            assertEquals("the page that arrived was applied and its cursor saved", "i0", notebookCursor(account, calendarUid))

            fake.stallItemList(calendarUid, null)
            val recovered = SyncResult()
            assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(recovered))
            assertEquals(0L, recovered.stats.numIoExceptions)
            assertEquals(fake.itemStoken(calendarUid), notebookCursor(account, calendarUid))
        } finally {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) provider.close() else @Suppress("DEPRECATION") provider.release()
        }
    }

    // ---- the push step: pending changes sent by a real run (design 3.3, 3.4 and 3.8) ----

    @Test fun aSavedEditIsPushedOneNotePerTransactionAndLandsInTheCache() {
        val account = newAccount("gen-push")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        val list = uploadNote(notebook, "List", "Milk", mtime = 1_500L)
        syncNow(account, "gen-push")
        editLocally(account, "gen-push", notebook, note.uid, "Plan v2", "Second draft", mtime = 2_000L)
        editLocally(account, "gen-push", notebook, list.uid, "List", "Milk and eggs", mtime = 2_500L)
        // An editor is open on the first note, so its push leaves a landed record: the other kind of file that holds a note.
        val editor = pending(account, "gen-push").editorOpened(note.uid)
        assertNothingPlainOnDisk(pending(account, "gen-push"), listOf("Plan v2", "Second draft", "Milk and eggs"))

        val since = fake.requests.size
        val sizes = fake.uploadSizes.size
        syncNow(account, "gen-push")
        // The request lines keep their query, so a sync token on a push would show here, and the
        // stand-in server answers a stale one with 409 as the project's server does.
        assertEquals("each with the etag check and no sync token", listOf(transactionOf(notebook), transactionOf(notebook)), uploads(since))
        assertEquals("one note per request", listOf(1, 1), fake.uploadSizes.drop(sizes))
        assertEquals("no conflicted copy", setOf(note.uid, list.uid), fake.itemUids(notebook))
        val onServer = itemManager(notebook).fetch(note.uid)
        assertEquals("Second draft", onServer.contentString)
        assertEquals("Plan v2", onServer.meta.name)
        assertEquals("Milk and eggs", itemManager(notebook).fetch(list.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-push").isEmpty())
        assertEquals(setOf("Plan v2", "List"), cachedNotes(account, notebook))
        assertSucceeded(status(account, "gen-push"))

        // The landed record is the uploaded note as the app itself saved it, and it goes with its editor. The copy of
        // the notebook stays.
        val afterPush = pending(account, "gen-push")
        assertEquals(setOf("${note.uid}.landed", "$notebook.notebook", "sequence"), filesOnDisk(afterPush).keys)
        assertNothingPlainOnDisk(afterPush, listOf("Plan v2", "Second draft"))
        val landed = itemManager(notebook).cacheLoad(checkNotNull(afterPush.landed(note.uid)).blob)
        assertEquals(listOf("Plan v2", "Second draft"), listOf(landed.meta.name, landed.contentString))
        afterPush.editorClosed(editor)
        assertEquals("the record goes with its editor", setOf("$notebook.notebook", "sequence"), filesOnDisk(afterPush).keys)

        // A notebook copy no entry needs stays until the store is discarded or cleared, after a run with something to
        // push, as above, and after one without: a listing can come back short and hide a note that needs it.
        val store = pending(account, "gen-push")
        val copy = checkNotNull(store.notebook(notebook))
        syncNow(account, "gen-push")
        assertArrayEquals(copy, store.notebook(notebook))
        // So does a copy whose notebook the cache does not hold.
        val uncached = "notebook-the-cache-does-not-hold"
        store.putNotebook(uncached, ByteArray(4))
        syncNow(account, "gen-push")
        assertNotNull(store.notebook(uncached))
    }

    @Test fun anEditMadeOnAnOlderCopyBecomesAConflictedCopyAndBothReachTheServer() {
        val account = newAccount("gen-conflict")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-conflict")
        editLocally(account, "gen-conflict", notebook, note.uid, "Plan", "Edited on the phone", mtime = 2_000L)
        editOnAnotherDevice(notebook, note.uid, "Edited on the web")

        val since = fake.requests.size
        val copyUpload = fake.hold("POST", TRANSACTION, skip = 1)
        startManualRun(account, "gen-conflict")
        copyUpload.awaitArrival()
        // The conflicted copy is in the store, made by the app itself, while its upload is in flight.
        val copyOnDisk = assertNothingPlainOnDisk(pending(account, "gen-conflict"),
            listOf("Plan (conflicted copy)", "conflicted copy", "Edited on the phone")).values.single()
        assertTrue("it is the copy, marked as made from a conflict: $copyOnDisk",
            copyOnDisk.fromConflict && copyOnDisk.isCreate && copyOnDisk.origin == null && copyOnDisk.noteUid != note.uid)
        val copyItem = decryptThroughStoredCopy(pending(account, "gen-conflict"), copyOnDisk)
        assertEquals(listOf("Plan (conflicted copy)", "Edited on the phone"), listOf(copyItem.meta.name, copyItem.contentString))
        copyUpload.release()
        awaitSettled(ExactAccountIdentity(account.type, account.name, "gen-conflict"))
        // The refused push, the server copy, and the new note, pushed in the run that made it.
        assertEquals(listOf(transactionOf(notebook), transactionOf(notebook)), uploads(since))
        assertEquals("the server copy was fetched once", 1,
            fake.requests.drop(since).count { it.substringBefore('?') == "GET collection/$notebook/item/${note.uid}/" })
        val onServer = fake.itemUids(notebook)
        assertEquals("the server version stays, and the phone's text has a note of its own", 2, onServer.size)
        assertEquals("Edited on the web", itemManager(notebook).fetch(note.uid).contentString)
        val copy = itemManager(notebook).fetch((onServer - note.uid).single())
        assertEquals("Plan (conflicted copy)", copy.meta.name)
        assertEquals("Edited on the phone", copy.contentString)
        @Suppress("UNCHECKED_CAST")
        assertEquals("fresh metadata, as the web's move writes", setOf("name", "mtime"), (TestMsgPack.decode(copy.metaRaw) as Map<String, Any?>).keys)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-conflict").isEmpty())
        assertEquals(setOf("Plan", "Plan (conflicted copy)"), cachedNotes(account, notebook))
        assertSucceeded(status(account, "gen-conflict"))
    }

    @Test fun aLostAnswerFollowedByAnotherSaveIsRebasedNotCopied() {
        val account = newAccount("gen-lost")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-lost")
        editLocally(account, "gen-lost", notebook, note.uid, "Plan", "First phone edit", mtime = 2_000L)
        fake.loseAnswer("POST", TRANSACTION)
        syncNow(account, "gen-lost")
        assertEquals("the upload landed", "First phone edit", itemManager(notebook).fetch(note.uid).contentString)
        assertEquals("a dropped connection is a network failure", SyncStatusStore.FailureCategory.NETWORK,
            status(account, "gen-lost").lastFailureCategory)

        // The user saves again before the next run: the new text is still based on the copy from
        // before the upload whose answer was lost.
        // Its title has a character above U+FFFF, so the rebase and its read-back carry one on every lane.
        val cart = "Plan \uD83D\uDED2"
        editLocally(account, "gen-lost", notebook, note.uid, cart, "Second phone edit", mtime = 3_000L)
        val store = pending(account, "gen-lost")
        val saved = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
        val since = fake.requests.size
        val rebasedPush = fake.hold("POST", TRANSACTION, skip = 1)
        startManualRun(account, "gen-lost")
        rebasedPush.awaitArrival()
        // The rebased entry is in the store, built by the app itself, while its upload is in flight.
        val rebased = assertNothingPlainOnDisk(store, listOf("Second phone edit")).getValue(note.uid)
        assertTrue("it is the rebase result, not the entry the save wrote: $rebased",
            rebased.version > saved.version && rebased.revision != saved.revision && saved.revision in rebased.sent)
        assertEquals("Second phone edit", decryptThroughStoredCopy(store, rebased).contentString)
        rebasedPush.release()
        awaitSettled(ExactAccountIdentity(account.type, account.name, "gen-lost"))
        assertEquals("a conflict with our own upload, then the rebased push",
            listOf(transactionOf(notebook), transactionOf(notebook)), uploads(since))
        assertEquals("no conflicted copy", setOf(note.uid), fake.itemUids(notebook))
        val landed = itemManager(notebook).fetch(note.uid)
        assertEquals("Second phone edit", landed.contentString)
        assertEquals("the title went through the rebase and its read-back, read here from the raw bytes", cart,
            NoteMetaCodec.peek(landed.metaRaw)?.name)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-lost").isEmpty())
        assertSucceeded(status(account, "gen-lost"))
    }

    @Test fun anEditOfANoteDeletedElsewhereBecomesANewNoteWithItsOwnTitleAndTheDeletionStays() {
        val account = newAccount("gen-gone")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        val keep = uploadNote(notebook, "Keep", "Stays", mtime = 1_500L)
        syncNow(account, "gen-gone")
        editLocally(account, "gen-gone", notebook, note.uid, "Plan v2", "Edited on the phone", mtime = 2_000L)
        // Deleted on another device: the server's copy is a deleted item, and this account's cache does not know it yet.
        note.delete()
        itemManager(notebook).batch(arrayOf(note))
        val deletion = note.etag
        assertEquals(setOf("Plan", "Keep"), cachedNotes(account, notebook))

        val since = fake.requests.size
        val newUpload = fake.hold("POST", TRANSACTION, skip = 1)
        startManualRun(account, "gen-gone")
        newUpload.awaitArrival()
        // The deleted note has left the cached list already, through the push step's own cache write and
        // not the fetch, which comes after it. The new note is in the store, made by the app itself,
        // while its upload is in flight.
        assertTrue("the fetch has not run yet",
            fake.requests.drop(since).none { it.substringBefore('?') == "GET collection/$notebook/item/" })
        assertEquals("the deleted note is no longer listed", setOf("Keep"), cachedNotes(account, notebook))
        val newOnDisk = assertNothingPlainOnDisk(pending(account, "gen-gone"), listOf("Plan v2", "Edited on the phone")).values.single()
        assertTrue("it is the new note, marked as made from a conflict: $newOnDisk",
            newOnDisk.fromConflict && newOnDisk.isCreate && newOnDisk.origin == null && newOnDisk.noteUid != note.uid)
        val newItem = decryptThroughStoredCopy(pending(account, "gen-gone"), newOnDisk)
        assertEquals(listOf("Plan v2", "Edited on the phone"), listOf(newItem.meta.name, newItem.contentString))
        newUpload.release()
        awaitSettled(ExactAccountIdentity(account.type, account.name, "gen-gone"))
        // The refused push, the server copy, and the new note, pushed in the run that made it.
        val serverCopy = "GET collection/$notebook/item/${note.uid}/"
        assertEquals(listOf(transactionOf(notebook), serverCopy, transactionOf(notebook)),
            fake.requests.drop(since).filter { it.substringBefore('?') == serverCopy || UPLOAD.matches(it.substringBefore('?')) })
        val onServer = fake.itemUids(notebook)
        assertEquals("the deleted note, the other note, and the phone's text as a note of its own", 3, onServer.size)
        val gone = itemManager(notebook).fetch(note.uid)
        assertTrue("the note deleted elsewhere stays deleted", gone.isDeleted)
        assertEquals("at the revision the other device left: nothing was uploaded over it", deletion, gone.etag)
        val created = itemManager(notebook).fetch((onServer - note.uid - keep.uid).single())
        assertEquals("its own title, not a conflicted copy's", "Plan v2", created.meta.name)
        assertEquals("Edited on the phone", created.contentString)
        @Suppress("UNCHECKED_CAST")
        assertEquals("fresh metadata, as the web's move writes", setOf("name", "mtime"), (TestMsgPack.decode(created.metaRaw) as Map<String, Any?>).keys)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-gone").isEmpty())
        assertEquals(setOf("Keep", "Plan v2"), cachedNotes(account, notebook))
        assertSucceeded(status(account, "gen-gone"))
    }

    @Test fun aChangeInANotebookNowReadOnlyIsHeldWithoutAnUpload() {
        val account = newAccount("gen-readonly")
        val notebook = uploadNotebook("Shared")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-readonly")
        // Saved without a copy of its notebook, as if writing that copy had failed: the run writes one.
        editLocally(account, "gen-readonly", notebook, note.uid, "Plan", "Edited before access changed", mtime = 2_000L,
            withNotebookCopy = false)
        assertNull(pending(account, "gen-readonly").notebook(notebook))
        fake.setAccessLevel(notebook, 0L)

        val since = fake.requests.size
        syncNow(account, "gen-readonly")
        assertEquals("nothing was uploaded", emptyList<String>(), uploads(since))
        val held = pending(account, "gen-readonly").read(note.uid) as PendingNotesStore.Read.Present
        assertEquals(PendingEntry.State.HELD, held.entry.state)
        assertEquals(HeldReason.READ_ONLY, held.entry.held!!.reason)
        assertNotNull("the run kept a copy of the notebook, so the held text can still be decrypted",
            pending(account, "gen-readonly").notebook(notebook))
        assertEquals("First draft", itemManager(notebook).fetch(note.uid).contentString)
        assertSucceeded(status(account, "gen-readonly"))

        // Separate from the fetched cache (#709). The Etebase cache is cleared and seen to be empty, a
        // file put into each of Android's cache directories is seen to go, and the held text stays,
        // byte for byte, with the copy of its notebook, and still decrypts.
        val store = pending(account, "gen-readonly")
        assertStoreOutsideEveryCache(store, account.name)
        val before = filesOnDisk(store)
        clearEveryCache(account)
        assertTrue("nothing is cached any more", cachedNotebooks(account).isEmpty())
        assertSameFiles("the store after the cache clear", before, filesOnDisk(store))
        val kept = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
        assertEquals("Edited before access changed", decryptThroughStoredCopy(store, kept).contentString)
        assertEquals("the way to the text stays on screen with no notebook cached",
            NotesLoad.Loaded(NotebookOverview(emptyList(), unsyncedText = 1)), NotesLoader.notebooks(context, account, "gen-readonly"))

        // A cache refresh from nothing: the next run fetches the server's copy again and writes nothing over the draft.
        syncNow(account, "gen-readonly")
        assertEquals(setOf("Plan"), cachedNotes(account, notebook))
        assertArrayEquals("the entry file is as it was", before.getValue("${note.uid}.note"), filesOnDisk(store).getValue("${note.uid}.note"))
        assertEquals("Edited before access changed", decryptThroughStoredCopy(store, kept).contentString)
        assertSucceeded(status(account, "gen-readonly"))

        // The copy stays while every listing of the store leaves out the held note, as File.listFiles can when reading
        // the directory fails partway the same way each time. The run then sees nothing waiting.
        val copy = checkNotNull(store.notebook(notebook))
        PendingNotesStore.listFilesForTesting = { d ->
            if (d == store.dir) d.listFiles()?.filter { it.name != "${note.uid}.note" }?.toTypedArray() else d.listFiles()
        }
        try {
            syncNow(account, "gen-readonly")
        } finally {
            PendingNotesStore.listFilesForTesting = null
        }
        assertArrayEquals("the copy the held note needs stays, byte for byte", copy, store.notebook(notebook))
        // The owner then removes this account from the notebook, and the next run's collection refresh drops it before
        // anything lists the note again. The copy is the only key left, and the held text still decrypts through it.
        fake.removeMembership(notebook)
        syncNow(account, "gen-readonly")
        assertFalse("the notebook is no longer cached", notebook in cachedNotebooks(account))
        assertEquals(PendingEntry.State.HELD, (store.read(note.uid) as PendingNotesStore.Read.Present).entry.state)
        assertEquals("Edited before access changed", decryptThroughStoredCopy(store, kept).contentString)
    }

    @Test fun aSingle403OnAPushIsConfirmedAndHoldsNothing() {
        val account = newAccount("gen-403")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-403")
        editLocally(account, "gen-403", notebook, note.uid, "Plan", "Phone edit", mtime = 2_000L)
        fake.answer("POST", TRANSACTION, 403)

        val since = fake.requests.size
        syncNow(account, "gen-403")
        assertEquals("one confirming fetch of the notebook", 1, notebookFetches(since, notebook))
        val entry = (pending(account, "gen-403").read(note.uid) as PendingNotesStore.Read.Present).entry
        assertEquals("still writable, so nothing is held", PendingEntry.State.UPSERT, entry.state)
        assertEquals(1, entry.failureCount)
        assertEquals(SyncStatusStore.FailureCategory.UNKNOWN, status(account, "gen-403").lastFailureCategory)

        // A server that behaves takes the same change on the next run.
        syncNow(account, "gen-403")
        assertEquals("Phone edit", itemManager(notebook).fetch(note.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-403").isEmpty())
        assertSucceeded(status(account, "gen-403"))
    }

    @Test fun aDroppedConnectionEndsThePushStepAndTheFetchStillRuns() {
        val account = newAccount("gen-drop")
        val first = uploadNotebook("First")
        val second = uploadNotebook("Second")
        val a = uploadNote(first, "A", "a", mtime = 1_000L)
        val b = uploadNote(second, "B", "b", mtime = 1_000L)
        syncNow(account, "gen-drop")
        editLocally(account, "gen-drop", first, a.uid, "A", "a edited", mtime = 2_000L)
        editLocally(account, "gen-drop", second, b.uid, "B", "b edited", mtime = 2_000L)
        uploadNote(first, "From the web", "new", mtime = 3_000L)
        fake.answer("POST", TRANSACTION, code = null)

        val since = fake.requests.size
        syncNow(account, "gen-drop")
        assertEquals("the oldest change went first, and the dropped connection ended the step",
            listOf(transactionOf(first)), uploads(since))
        assertTrue("the fetch still ran", "From the web" in cachedNotes(account, first))
        assertEquals(SyncStatusStore.FailureCategory.NETWORK, status(account, "gen-drop").lastFailureCategory)
        val store = pending(account, "gen-drop")
        assertEquals(1, (store.read(a.uid) as PendingNotesStore.Read.Present).entry.failureCount)
        assertEquals("never tried, so nothing recorded", 0, (store.read(b.uid) as PendingNotesStore.Read.Present).entry.failureCount)

        // Both are saved again, which resets every failure count and leaves A the older change. The
        // note whose request ended the step still goes last in the next run.
        editLocally(account, "gen-drop", first, a.uid, "A", "a edited again", mtime = 4_000L)
        editLocally(account, "gen-drop", second, b.uid, "B", "b edited again", mtime = 4_000L)
        val again = fake.requests.size
        syncNow(account, "gen-drop")
        assertEquals(listOf(transactionOf(second), transactionOf(first)), uploads(again))
        assertEquals("a edited again", itemManager(first).fetch(a.uid).contentString)
        assertEquals("b edited again", itemManager(second).fetch(b.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-drop").isEmpty())
        assertSucceeded(status(account, "gen-drop"))
    }

    @Test fun aConflictWhoseServerCopyCannotBeFetchedMakesNoCopyUntilItCan() {
        val account = newAccount("gen-nofetch")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-nofetch")
        editLocally(account, "gen-nofetch", notebook, note.uid, "Plan", "Edited on the phone", mtime = 2_000L)
        editOnAnotherDevice(notebook, note.uid, "Edited on the web")
        fake.answer("GET", Regex("collection/$notebook/item/${note.uid}/"), 500)

        syncNow(account, "gen-nofetch")
        assertEquals("never resolved without the server copy", setOf(note.uid), fake.itemUids(notebook))
        val entry = (pending(account, "gen-nofetch").read(note.uid) as PendingNotesStore.Read.Present).entry
        assertEquals(1, entry.failureCount)
        assertEquals(NotePushPolicy.FailureKind.TRANSIENT.name, entry.lastFailureCategory)
        assertEquals(SyncStatusStore.FailureCategory.NETWORK, status(account, "gen-nofetch").lastFailureCategory)
        // A cache refresh does not overwrite a draft (#709): this run's fetch put the web's text into
        // the cache, and the phone's text is still in the store.
        assertEquals("Edited on the web", cachedBody(account, notebook, note.uid))
        assertEquals("Edited on the phone", itemManager(notebook).cacheLoad(entry.blob).contentString)

        syncNow(account, "gen-nofetch")
        assertEquals("resolved once the copy could be fetched", 2, fake.itemUids(notebook).size)
        assertEquals("Edited on the web", itemManager(notebook).fetch(note.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-nofetch").isEmpty())
        assertSucceeded(status(account, "gen-nofetch"))
    }

    @Test fun aPushRefusedAfterItsNotebookTurnedReadOnlyIsConfirmedAndHeld() {
        val account = newAccount("gen-403-ro")
        val notebook = uploadNotebook(STORE_CHECK_NOTEBOOK)
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-403-ro")
        editLocally(account, "gen-403-ro", notebook, note.uid, STORE_CHECK_TITLE, STORE_CHECK_BODY, mtime = 2_000L)

        // The pending store on disk while the change waits (#709: keep the pending store encrypted).
        val store = pending(account, "gen-403-ro")
        val texts = listOf(STORE_CHECK_TITLE, STORE_CHECK_BODY, STORE_CHECK_NOTEBOOK)
        val waiting = assertNothingPlainOnDisk(store, texts).getValue(note.uid)
        assertEquals(setOf("${note.uid}.note", "$notebook.notebook", "sequence"), filesOnDisk(store).keys)
        // What is readable is the header of design 3.1 and nothing a user typed: uids, the state, the
        // version counter and the revision. Every other header field is at its default.
        val plain = PendingEntry(note.uid, notebook, PendingEntry.State.UPSERT, waiting.version, waiting.revision, isCreate = false, blob = waiting.blob)
        assertEquals(plain, waiting)
        // The scan reports what is plain: the note's uid, which is in the header, and a text in either UTF-16 form.
        val reported = runCatching { assertNothingPlainOnDisk(store, listOf(note.uid)) }.exceptionOrNull()
        assertTrue("the scan reports what is plain: $reported",
            reported is AssertionError && reported.message.orEmpty().contains("${note.uid}.note holds '${note.uid}' in plain text"))
        for (utf16 in listOf(Charsets.UTF_16LE, Charsets.UTF_16BE)) {
            val asBlob = PendingCodec.encodeEntry(waiting.copy(blob = STORE_CHECK_BODY.toByteArray(utf16)))
            assertTrue("the forms looked for include $utf16", plainForms(STORE_CHECK_BODY).any { asBlob.holds(it) })
        }
        val decrypted = decryptThroughStoredCopy(store, waiting)
        assertEquals("the title is in the file, encrypted", STORE_CHECK_TITLE, decrypted.meta.name)
        assertEquals("and so is the text", STORE_CHECK_BODY, decrypted.contentString)
        // Encrypted, not only encoded: with another notebook's key the same blob does not read.
        val otherNotebook = server.collectionManager.create(Constants.ETEBASE_TYPE_NOTES, ItemMetadata().apply { name = "Other" }, "")
        val withOtherKey = runCatching { server.collectionManager.getItemManager(otherNotebook).cacheLoad(waiting.blob).contentString }
        assertTrue("the text does not read with another notebook's key: $withOtherKey", withOtherKey.isFailure)

        // Made read-only after this run's listing: only the push and the notebook fetch can see it.
        val since = fake.requests.size
        val push = fake.hold("POST", TRANSACTION)
        startManualRun(account, "gen-403-ro")
        push.awaitArrival()
        // While the upload is in flight the header also names the revision that was sent, and nothing else changed.
        assertEquals(plain.copy(sent = listOf(waiting.revision)), assertNothingPlainOnDisk(store, texts).getValue(note.uid))
        fake.setAccessLevel(notebook, 0L)
        push.release()
        awaitSettled(ExactAccountIdentity(account.type, account.name, "gen-403-ro"))
        assertEquals(listOf(transactionOf(notebook)), uploads(since))
        assertEquals("one confirming fetch of the notebook", 1, notebookFetches(since, notebook))
        val held = (pending(account, "gen-403-ro").read(note.uid) as PendingNotesStore.Read.Present).entry
        assertEquals(PendingEntry.State.HELD, held.state)
        assertEquals(HeldReason.READ_ONLY, held.held!!.reason)
        val heldOnDisk = assertNothingPlainOnDisk(store, texts).getValue(note.uid)
        assertEquals("held text has the same plain header, plus the reason by name and the time",
            plain.copy(state = PendingEntry.State.HELD, sent = listOf(waiting.revision),
                held = PendingEntry.Held(HeldReason.READ_ONLY, heldOnDisk.held!!.at)),
            heldOnDisk)
        assertTrue("the reason is readable in the file", filesOnDisk(store).getValue("${note.uid}.note").holds("READ_ONLY".toByteArray()))
        assertEquals(STORE_CHECK_BODY, decryptThroughStoredCopy(store, heldOnDisk).contentString)
        assertEquals("the notebook's name is in the copy the run wrote, and reads through the binding", STORE_CHECK_NOTEBOOK,
            server.collectionManager.cacheLoad(checkNotNull(store.notebook(notebook))).meta.name)
        assertEquals("First draft", itemManager(notebook).fetch(note.uid).contentString)
        assertSucceeded(status(account, "gen-403-ro"))

        // Last, so that neither can hide a check above: the revision the binding reports for the stored
        // blob, and the file modes, which the store leaves to the platform.
        assertEquals("the header's revision is the blob's own revision uid", decrypted.etag, waiting.revision)
        assertClosedToOtherUsers(store)
    }

    @Test fun aPushRefusedAfterAccessWasLostIsConfirmedAndTheNotebookLeavesTheCache() {
        val account = newAccount("gen-404")
        val notebook = uploadNotebook("Shared")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-404")
        editLocally(account, "gen-404", notebook, note.uid, "Plan", "Phone edit", mtime = 2_000L)

        val since = fake.requests.size
        val push = fake.hold("POST", TRANSACTION)
        startManualRun(account, "gen-404")
        push.awaitArrival()
        fake.removeMembership(notebook)
        push.release()
        awaitSettled(ExactAccountIdentity(account.type, account.name, "gen-404"))
        assertEquals(listOf(transactionOf(notebook)), uploads(since))
        assertEquals("one confirming fetch of the notebook", 1, notebookFetches(since, notebook))
        val store = pending(account, "gen-404")
        val held = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
        assertEquals(PendingEntry.State.HELD, held.state)
        assertEquals(HeldReason.LOST_ACCESS, held.held!!.reason)
        assertFalse("the notebook is no longer listed as writable", notebook in cachedNotebooks(account))
        assertNotNull("its copy stays, so the held text can still be decrypted", store.notebook(notebook))
        assertEquals("and through that copy it does decrypt", "Phone edit", decryptThroughStoredCopy(store, held).contentString)
        assertSucceeded(status(account, "gen-404"))
    }

    @Test fun anAutomaticRunLeavesAChangeInBackoffAndCarriesItsFailure() {
        val account = newAccount("gen-skip")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-skip")
        val first = uploadNotebook("First")
        val second = uploadNotebook("Second")
        val a = uploadNote(first, "A", "a", mtime = 1_000L)
        val b = uploadNote(second, "B", "b", mtime = 1_000L)
        syncNow(account, "gen-skip")
        editLocally(account, "gen-skip", first, a.uid, "A", "a edited", mtime = 2_000L)
        editLocally(account, "gen-skip", second, b.uid, "B", "b edited", mtime = 2_000L)
        fake.answer("POST", TRANSACTION, code = null)
        syncNow(account, "gen-skip")
        val store = pending(account, "gen-skip")
        val failed = (store.read(a.uid) as PendingNotesStore.Read.Present).entry
        val before = status(account, "gen-skip")

        // Opening the screen is not the user asking to sync: A sits out its backoff.
        val since = fake.requests.size
        NotesSyncCoordinator.request(context, account, "gen-skip", NotesSyncPolicy.Trigger.SCREEN_OPEN)
        awaitSettled(identity)
        assertEquals(listOf(transactionOf(second)), uploads(since))
        val skipped = (store.read(a.uid) as PendingNotesStore.Read.Present).entry
        assertEquals("the skip adds nothing to A's failures", failed.failureCount, skipped.failureCount)
        assertEquals(failed.lastFailureAt, skipped.lastFailureAt)
        val after = status(account, "gen-skip")
        assertEquals("the run records A's failure, not success", SyncStatusStore.TerminalResult.FAILURE, after.lastTerminalResult)
        assertEquals(SyncStatusStore.FailureCategory.NETWORK, after.lastFailureCategory)
        assertTrue("recorded by this run", after.lastFailureAt!! > before.lastFailureAt!!)

        // A run the user starts tries it at once.
        syncNow(account, "gen-skip")
        assertEquals("a edited", itemManager(first).fetch(a.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-skip").isEmpty())
        assertSucceeded(status(account, "gen-skip"))
    }

    @Test fun aRunTheNetworkSettingsRefuseAsksNothingAndRecordsNothingAndAnAttemptThatFailsIsStillAFailure() {
        val account = newAccount("gen-net")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-net")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-net")
        var mtime = 2_000L
        fun edit(text: String) = editLocally(account, "gen-net", notebook, note.uid, "Plan", text, mtime++)
        fun pin(connection: NotesNetworkPolicy.Connection) {
            NotesNetwork.readingOverride = { NotesNetworkPolicy.Reading(connection) }
        }
        fun open(force: Boolean = false) {
            NotesSyncCoordinator.request(context, account, "gen-net", NotesSyncPolicy.Trigger.SCREEN_OPEN, forceRefresh = force)
        }

        // 1. Not Wi-Fi, with the defaults: opening Notes is refused (row A2).
        edit("edit 1")
        pin(NotesNetworkPolicy.Connection.OTHER)
        assertRefused(account, "gen-net", note.uid, "opening Notes off Wi-Fi") { open() }

        // 2. No active network: refused as well, and no network failure is recorded (row A3, answer 5 on #709).
        pin(NotesNetworkPolicy.Connection.NONE)
        assertRefused(account, "gen-net", note.uid, "opening Notes with no active network") { open() }

        // 3. The run after an adapter sync, as the adapters ask for it.
        pin(NotesNetworkPolicy.Connection.OTHER)
        assertRefused(account, "gen-net", note.uid, "the run after an adapter sync off Wi-Fi") {
            NotesSyncCoordinator.piggybackAfterAdapterSync(context, account, "gen-net")
        }

        // 4. A forced refresh that is refused stays owed.
        assertRefused(account, "gen-net", note.uid, "a forced automatic run off Wi-Fi") { open(force = true) }

        // 5. Pull to refresh on the same network is a run the user starts (row E2): it sends the change,
        // and it makes the full listing the refused run still owed.
        statusBeforeRun = status(account, "gen-net")
        val mark = fake.requests.size
        NotesSyncCoordinator.request(context, account, "gen-net", NotesSyncPolicy.Trigger.SCREEN)
        awaitSettled(identity)
        assertEquals("pull to refresh off Wi-Fi sends the waiting change", listOf(transactionOf(notebook)), uploads(mark))
        assertTrue("and lists from scratch, as the refused run could not", listings(mark).any(::fromScratch))
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-net").isEmpty())
        assertSucceeded(status(account, "gen-net"))

        // 6. With automatic sync allowed on any network, opening Notes off Wi-Fi sends (row A10).
        check(AccountSettings.writeNotesAutomaticNetwork(manager, account, NotesNetworkPolicy.Allowed.ANY_NETWORK))
        edit("edit 2")
        assertSent(account, "gen-net", notebook, "opening Notes off Wi-Fi with automatic sync on any network") { open() }
        // The run after an adapter sync is admitted on the same terms. So the refusal of step 3 was
        // a run that started and was refused, not a run that never started.
        edit("edit 2, after an adapter sync")
        assertSent(account, "gen-net", notebook, "the run after an adapter sync off Wi-Fi with automatic sync on any network") {
            NotesSyncCoordinator.piggybackAfterAdapterSync(context, account, "gen-net")
        }

        // 7. With Sync now on Wi-Fi only, the dashboard's Sync now off Wi-Fi is refused and its request is
        // closed (row E5). The automatic setting, still on any network, is not looked at.
        check(AccountSettings.writeNotesSyncNowNetwork(manager, account, NotesNetworkPolicy.Allowed.WIFI_ONLY))
        edit("edit 3")
        assertRefused(account, "gen-net", note.uid, "Sync now off Wi-Fi with Sync now on Wi-Fi only") { requestSync(context, account) }

        // 8. Sync now on any network again, and no active network: the run is attempted, and an attempt
        // that fails is a failure (row E3, answer 5 on #709).
        check(AccountSettings.writeNotesSyncNowNetwork(manager, account, NotesNetworkPolicy.Allowed.ANY_NETWORK))
        pin(NotesNetworkPolicy.Connection.NONE)
        fake.answer("POST", TRANSACTION, code = null)
        val before = status(account, "gen-net")
        syncNow(account, "gen-net")
        val failed = status(account, "gen-net")
        assertEquals("an attempted run that fails is a failure", SyncStatusStore.TerminalResult.FAILURE, failed.lastTerminalResult)
        assertEquals(SyncStatusStore.FailureCategory.NETWORK, failed.lastFailureCategory)
        assertTrue("recorded by this run", (failed.lastFailureAt ?: 0L) > (before.lastFailureAt ?: 0L))

        // 9. On Wi-Fi a run the user starts sends it.
        pin(NotesNetworkPolicy.Connection.WIFI)
        syncNow(account, "gen-net")
        assertEquals("edit 3", itemManager(notebook).fetch(note.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-net").isEmpty())
        assertSucceeded(status(account, "gen-net"))

        // 10. Sync now on Wi-Fi only again, and the dashboard's Sync now off Wi-Fi while an automatic run
        // is in flight: the tap's own run is refused and records nothing, and the run in flight keeps its
        // attempt and records its success.
        check(AccountSettings.writeNotesSyncNowNetwork(manager, account, NotesNetworkPolicy.Allowed.WIFI_ONLY))
        pin(NotesNetworkPolicy.Connection.OTHER)
        edit("edit 4")
        val beforeTap = status(account, "gen-net")
        forgetLastListing(account.name)
        // The automatic run is held at its upload, after it listed. Forgetting that listing before the
        // tap means a run of the tap that the network rule wrongly let through would list again.
        val upload = fake.hold("POST", TRANSACTION)
        val tapMark = fake.requests.size
        open()
        upload.awaitArrival()
        val inFlight = checkNotNull(status(account, "gen-net").activeAttemptId) { "the automatic run has its attempt" }
        forgetLastListing(account.name)
        requestSync(context, account)
        assertEquals("the tap leaves the run in flight its attempt", inFlight, status(account, "gen-net").activeAttemptId)
        upload.release()
        awaitSettled(identity)
        assertEquals("the automatic run sent the change", listOf(transactionOf(notebook)), uploads(tapMark))
        assertEquals("the refused run of the tap asked the server nothing", 1, listings(tapMark).size)
        status(account, "gen-net").let {
            assertEquals("the run in flight recorded its success: $it", SyncStatusStore.TerminalResult.SUCCESS, it.lastTerminalResult)
            assertTrue("recorded after the tap: $it", (it.lastSuccessAt ?: 0L) > (beforeTap.lastSuccessAt ?: 0L))
            assertNull("no attempt left open: $it", it.activeAttemptId)
            assertNull("the refused run closed the tap's request: $it", it.activeRequestId)
        }

        // 11. Wi-Fi drops between the tap and its run, and the upload of the automatic run in flight fails:
        // the tap's run is refused off Wi-Fi, and the failure of the run in flight is on record.
        pin(NotesNetworkPolicy.Connection.WIFI)
        edit("edit 5")
        fake.answer("POST", TRANSACTION, code = null)
        val beforeDrop = status(account, "gen-net")
        forgetLastListing(account.name)
        val heldListing = fake.hold("POST", LIST)
        open()
        heldListing.awaitArrival()
        requestSync(context, account)
        pin(NotesNetworkPolicy.Connection.OTHER)
        heldListing.release()
        awaitSettled(identity)
        status(account, "gen-net").let {
            assertEquals("the run in flight recorded its failure: $it", SyncStatusStore.TerminalResult.FAILURE, it.lastTerminalResult)
            assertEquals(SyncStatusStore.FailureCategory.NETWORK, it.lastFailureCategory)
            assertTrue("recorded after the tap: $it", (it.lastFailureAt ?: 0L) > (beforeDrop.lastFailureAt ?: 0L))
            assertNull("no attempt left open: $it", it.activeAttemptId)
            assertNull("the refused run closed the tap's request: $it", it.activeRequestId)
        }
        // Back on Wi-Fi with Sync now on any network, a run the user starts sends edit 5.
        check(AccountSettings.writeNotesSyncNowNetwork(manager, account, NotesNetworkPolicy.Allowed.ANY_NETWORK))
        pin(NotesNetworkPolicy.Connection.WIFI)
        syncNow(account, "gen-net")
        assertEquals("edit 5", itemManager(notebook).fetch(note.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-net").isEmpty())
        assertSucceeded(status(account, "gen-net"))
    }

    @Test fun anAutomaticRunAlsoNeedsTheAccountsOwnWifiSwitchAndNoSavedNetworkNameAndARunTheUserStartsDoesNot() {
        val account = newAccount("gen-acct")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-acct")
        // Automatic sync on any network, so that only the account's own rule decides below.
        check(AccountSettings.writeNotesAutomaticNetwork(manager, account, NotesNetworkPolicy.Allowed.ANY_NETWORK))
        val settings = AccountSettings(context, account)
        settings.setSyncWiFiOnly(true)
        var mtime = 2_000L
        fun edit(text: String) = editLocally(account, "gen-acct", notebook, note.uid, "Plan", text, mtime++)
        fun open() {
            NotesSyncCoordinator.request(context, account, "gen-acct", NotesSyncPolicy.Trigger.SCREEN_OPEN)
        }
        // The pinned reading is the connection alone: nothing in Notes reads a Wi-Fi name (#971).
        fun pin(connection: NotesNetworkPolicy.Connection) {
            NotesNetwork.readingOverride = { NotesNetworkPolicy.Reading(connection) }
        }
        val wifi = NotesNetworkPolicy.Connection.WIFI
        val other = NotesNetworkPolicy.Connection.OTHER
        val none = NotesNetworkPolicy.Connection.NONE

        // 1. The switch on, no network name: refused off Wi-Fi and with no active network, sent on Wi-Fi
        // (rows A13, A14, A12).
        edit("edit 1")
        pin(other)
        assertRefused(account, "gen-acct", note.uid, "an automatic run off Wi-Fi with the account switch on") { open() }
        pin(none)
        assertRefused(account, "gen-acct", note.uid, "an automatic run with no active network and the account switch on") { open() }
        pin(wifi)
        assertSent(account, "gen-acct", notebook, "an automatic run on Wi-Fi with the account switch on") { open() }

        // 2. A network name saved with the switch refuses on every network, Wi-Fi included (rows A15,
        // A16, and A13 and A14 with a name), and the network is not read for that run: Android gives
        // this app no Wi-Fi names, so the name cannot be checked (#971). The pinned reading is Wi-Fi,
        // which the switch alone admits (step 1), and it counts every read.
        settings.syncWifiOnlySSID = "home"
        edit("edit 2")
        val reads = AtomicInteger()
        NotesNetwork.readingOverride = { reads.incrementAndGet(); NotesNetworkPolicy.Reading(wifi) }
        assertRefused(account, "gen-acct", note.uid, "an automatic run on Wi-Fi with a saved network name") { open() }
        assertEquals("the network is not read for an automatic run a saved network name refuses", 0, reads.get())

        // 3. A run the user starts does not look at the account's rule: not at the switch off Wi-Fi
        // (row E2 with the switch on), not at the saved name on Wi-Fi (row E7).
        pin(other)
        assertSent(account, "gen-acct", notebook, "pull to refresh off Wi-Fi with the account switch on and a saved name") {
            NotesSyncCoordinator.request(context, account, "gen-acct", NotesSyncPolicy.Trigger.SCREEN)
        }
        edit("edit 2, second")
        pin(wifi)
        assertSent(account, "gen-acct", notebook, "pull to refresh on Wi-Fi with a saved network name") {
            NotesSyncCoordinator.request(context, account, "gen-acct", NotesSyncPolicy.Trigger.SCREEN)
        }

        // 4. With the name removed, the switch alone decides again: an automatic run on Wi-Fi is sent
        // (row A12). Removing it is the way out the notice names.
        settings.syncWifiOnlySSID = null
        edit("edit 3")
        pin(wifi)
        assertSent(account, "gen-acct", notebook, "an automatic run on Wi-Fi once the saved network name is removed") { open() }

        // 5. The switch off with a name left over: the name means nothing (row A17).
        settings.setSyncWiFiOnly(false)
        settings.syncWifiOnlySSID = "home"
        edit("edit 4")
        pin(other)
        assertSent(account, "gen-acct", notebook, "an automatic run off Wi-Fi with the switch off and a name left over") { open() }

        // 6. Both rules on (row A5).
        check(AccountSettings.writeNotesAutomaticNetwork(manager, account, NotesNetworkPolicy.Allowed.WIFI_ONLY))
        settings.setSyncWiFiOnly(true)
        settings.syncWifiOnlySSID = null
        edit("edit 5")
        pin(other)
        assertRefused(account, "gen-acct", note.uid, "an automatic run off Wi-Fi with both rules on") { open() }

        // 7. No pin: the production reading, on whatever network this device has, against the adapters'
        // own function. It passes on any network and records which one it was. A name no network has
        // is refused by both, whichever network this is.
        NotesNetwork.readingOverride = null
        check(AccountSettings.writeNotesAutomaticNetwork(manager, account, NotesNetworkPolicy.Allowed.ANY_NETWORK))
        val real = NotesNetwork.read(context)
        val compared = mutableListOf<String>()
        for ((wifiOnly, name) in listOf(false to null, true to null, true to "notes-test-no-such-network")) {
            settings.setSyncWiFiOnly(wifiOnly)
            settings.syncWifiOnlySSID = name
            val adapters = runCatching { syncConditionsAllow(context, settings) }.getOrDefault(false)
            val notes = NotesNetwork.verdict(context, manager, account, settings, explicit = false).run
            assertEquals("Notes and the adapters agree on the account's rule (switch $wifiOnly, name set ${name != null})", adapters, notes)
            compared += "switch=$wifiOnly nameSet=${name != null} allowed=$adapters"
        }
        // No network name in this line: fixed words, flags and the API level only.
        android.util.Log.i("NotesNetworkReading", "sdk=${Build.VERSION.SDK_INT} connection=${real.connection} " +
            "compared: ${compared.joinToString("; ")}")

        // 8. Still no pin: a real run through the gate on the Notes worker, with nothing restricting
        // it. It reads this device's own network there and is admitted on any network.
        settings.setSyncWiFiOnly(false)
        settings.syncWifiOnlySSID = null
        assertSent(account, "gen-acct", notebook, "an automatic run with no pin and nothing restricting it") { open() }
    }

    @Test fun aServerCopyThatIsAnotherNoteResolvesNothing() {
        val account = newAccount("gen-swap")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        val other = uploadNote(notebook, "Other", "Other text", mtime = 1_500L)
        syncNow(account, "gen-swap")
        editLocally(account, "gen-swap", notebook, note.uid, "Plan", "Edited on the phone", mtime = 2_000L)
        // Edited elsewhere, so the push gets a 409, and the server copy comes back as another note.
        editOnAnotherDevice(notebook, note.uid, "Edited on the web")
        fake.answerAsFor("GET", "collection/$notebook/item/${note.uid}/", "collection/$notebook/item/${other.uid}/")

        syncNow(account, "gen-swap")
        val entry = (pending(account, "gen-swap").read(note.uid) as PendingNotesStore.Read.Present).entry
        assertEquals("the edit is still waiting", PendingEntry.State.UPSERT, entry.state)
        assertEquals(1, entry.failureCount)
        assertEquals(NotePushPolicy.FailureKind.TRANSIENT.name, entry.lastFailureCategory)
        assertEquals(setOf(note.uid, other.uid), fake.itemUids(notebook))
        assertEquals("Edited on the web", itemManager(notebook).fetch(note.uid).contentString)
        assertEquals(SyncStatusStore.FailureCategory.NETWORK, status(account, "gen-swap").lastFailureCategory)

        // With the note's own copy, the conflict is settled as any edit against an edit made elsewhere (design 3.4).
        syncNow(account, "gen-swap")
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-swap").isEmpty())
        val onServer = fake.itemUids(notebook)
        assertEquals("the phone's text has a note of its own", 3, onServer.size)
        assertEquals("Edited on the web", itemManager(notebook).fetch(note.uid).contentString)
        assertEquals("Edited on the phone", itemManager(notebook).fetch((onServer - note.uid - other.uid).single()).contentString)
        assertEquals(setOf("Plan", "Other", "Plan (conflicted copy)"), cachedNotes(account, notebook))
        assertSucceeded(status(account, "gen-swap"))
    }

    @Test fun aPendingStoreThatCannotBeReadIsAStorageFailureAndTheFetchStillRuns() {
        val account = newAccount("gen-unreadable")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        // A second notebook, for the last step, where changes in both wait.
        val home = uploadNotebook("Home")
        val list = uploadNote(home, "List", "Milk", mtime = 1_500L)
        syncNow(account, "gen-unreadable")
        editLocally(account, "gen-unreadable", notebook, note.uid, "Plan", "Phone edit", mtime = 2_000L)
        // The store's version counter ("sequence") becomes something that cannot be read, as after a damaged restore.
        val sequence = File(PendingNotesStore.identityDir(context.noBackupFilesDir, account.type, account.name, "gen-unreadable"), "sequence")
        assertTrue(sequence.delete() && sequence.mkdir())
        uploadNote(notebook, "From the web", "New", mtime = 3_000L)

        val since = fake.requests.size
        syncNow(account, "gen-unreadable")
        assertEquals("nothing was pushed", emptyList<String>(), uploads(since))
        assertTrue("the fetch still ran", "From the web" in cachedNotes(account, notebook))
        assertEquals(SyncStatusStore.FailureCategory.STORAGE, status(account, "gen-unreadable").lastFailureCategory)

        // Once the counter can be read again, the change goes out.
        assertTrue(sequence.delete())
        syncNow(account, "gen-unreadable")
        assertEquals("Phone edit", itemManager(notebook).fetch(note.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-unreadable").isEmpty())
        assertSucceeded(status(account, "gen-unreadable"))

        // A listing of the store that fails is a storage failure as well. Read as an empty store, the run
        // would find nothing waiting and record success while both changes still wait.
        editLocally(account, "gen-unreadable", notebook, note.uid, "Plan", "Second phone edit", mtime = 4_000L)
        editLocally(account, "gen-unreadable", home, list.uid, "List", "Milk and bread", mtime = 4_500L)
        uploadNote(notebook, "Also from the web", "Newer", mtime = 5_000L)
        val storeDir = sequence.parentFile!!
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == storeDir.name) null else d.listFiles() }
        val unlisted = fake.requests.size
        try {
            syncNow(account, "gen-unreadable")
        } finally {
            PendingNotesStore.listFilesForTesting = null
        }
        assertEquals("nothing was pushed", emptyList<String>(), uploads(unlisted))
        assertTrue("the fetch still ran", "Also from the web" in cachedNotes(account, notebook))
        status(account, "gen-unreadable").let {
            assertEquals("a failure, not a success: $it", SyncStatusStore.TerminalResult.FAILURE, it.lastTerminalResult)
            assertEquals(SyncStatusStore.FailureCategory.STORAGE, it.lastFailureCategory)
        }
        // Both changes are still there, nothing was counted against them, and their notebook copies stay.
        val store = pending(account, "gen-unreadable")
        for (uid in listOf(note.uid, list.uid)) {
            assertEquals(uid, 0, (store.read(uid) as PendingNotesStore.Read.Present).entry.failureCount)
        }
        assertNotNull(store.notebook(notebook))
        assertNotNull(store.notebook(home))

        // A store folder that is a link is never followed. The folder, holding both changes, is moved aside and a
        // link to it takes its place: nothing is read or pushed through the link, nothing in the folder changes, the
        // link stays, and the run is a storage failure. The fetch still runs.
        uploadNote(notebook, "Through a link", "Newest", mtime = 6_000L)
        val aside = File(context.noBackupFilesDir, "notes-link-target-${System.nanoTime()}")
        assertTrue(storeDir.renameTo(aside))
        val heldAside = aside.listFiles()!!.associate { it.name to it.readBytes() }
        assertTrue("both changes are in it: ${heldAside.keys}",
            heldAside.keys.containsAll(setOf("${note.uid}.note", "${list.uid}.note")))
        val beforeLink = status(account, "gen-unreadable")
        val throughLink = fake.requests.size
        try {
            Os.symlink(aside.path, storeDir.path)
            syncNow(account, "gen-unreadable")
            assertEquals("nothing was pushed", emptyList<String>(), uploads(throughLink))
            assertTrue("the fetch still ran", "Through a link" in cachedNotes(account, notebook))
            status(account, "gen-unreadable").let {
                assertEquals("a failure, not a success: $it", SyncStatusStore.TerminalResult.FAILURE,
                    it.lastTerminalResult)
                assertEquals(SyncStatusStore.FailureCategory.STORAGE, it.lastFailureCategory)
                assertTrue("recorded by this run", it.lastFailureAt!! > beforeLink.lastFailureAt!!)
            }
            assertTrue("the link is still there", OsConstants.S_ISLNK(Os.lstat(storeDir.path).st_mode))
            assertEquals(aside.path, Os.readlink(storeDir.path))
            assertSameFiles("the folder the link points to", heldAside,
                aside.listFiles()!!.associate { it.name to it.readBytes() })
        } finally {
            // The store's own folder comes back, so the step below still holds.
            if (runCatching { OsConstants.S_ISLNK(Os.lstat(storeDir.path).st_mode) }.getOrDefault(false)) {
                Os.remove(storeDir.path)
            }
            aside.renameTo(storeDir)
        }
        assertSameFiles("the store's folder is back", heldAside, filesOnDisk(store))
        // Once the store can be listed again, both changes go out.
        syncNow(account, "gen-unreadable")
        assertEquals("Second phone edit", itemManager(notebook).fetch(note.uid).contentString)
        assertEquals("Milk and bread", itemManager(home).fetch(list.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-unreadable").isEmpty())
        assertSucceeded(status(account, "gen-unreadable"))
    }

    @Test fun aNotebookAnswerAboutAnotherNotebookHoldsNothing() {
        val account = newAccount("gen-swapnb")
        val notebook = uploadNotebook("Work")
        val other = uploadNotebook("Elsewhere")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-swapnb")
        editLocally(account, "gen-swapnb", notebook, note.uid, "Plan", "Phone edit", mtime = 2_000L)
        // A single 403, and a confirming fetch answered with a notebook that is read-only for this account.
        fake.setAccessLevel(other, 0L)
        fake.answer("POST", TRANSACTION, 403)
        fake.answerAsFor("GET", "collection/$notebook/", "collection/$other/")

        syncNow(account, "gen-swapnb")
        val entry = (pending(account, "gen-swapnb").read(note.uid) as PendingNotesStore.Read.Present).entry
        assertEquals("nothing is held on an answer about another notebook", PendingEntry.State.UPSERT, entry.state)
        assertEquals(1, entry.failureCount)
        assertEquals(SyncStatusStore.FailureCategory.UNKNOWN, status(account, "gen-swapnb").lastFailureCategory)

        syncNow(account, "gen-swapnb")
        assertEquals("Phone edit", itemManager(notebook).fetch(note.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-swapnb").isEmpty())
        assertSucceeded(status(account, "gen-swapnb"))
    }

    @Test fun aChangeThatCannotGoOntoMetadataThatIsNotOneMapIsHeldAndNothingIsWrittenOverIt() {
        val account = newAccount("gen-notamap")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-notamap")
        // An upload of this device lands with metadata that is well-formed msgpack but not one map, and
        // its answer is lost. The editor saves such metadata only by keeping, as it is, metadata another
        // client wrote that it cannot merge into; here it stands for a copy of ours on the server that this
        // app cannot write into.
        editLocally(account, "gen-notamap", notebook, note.uid, "Plan", "First phone edit", mtime = 2_000L, metaRaw = NOT_ONE_MAP)
        fake.loseAnswer("POST", TRANSACTION)
        syncNow(account, "gen-notamap")
        val landed = itemManager(notebook).fetch(note.uid)
        assertEquals("the upload landed", "First phone edit", landed.contentString)
        assertArrayEquals(NOT_ONE_MAP, landed.metaRaw)

        // The user saves again. Its push conflicts with our own upload, so the new text would be rebased
        // onto that copy, name and time merged into its metadata.
        editLocally(account, "gen-notamap", notebook, note.uid, "Plan", "Second phone edit", mtime = 3_000L,
            metaRaw = NoteMetaCodec.fresh("Plan", 3_000L).bytes)
        val since = fake.requests.size
        syncNow(account, "gen-notamap")
        assertEquals("the push that met the conflict, and nothing after it", listOf(transactionOf(notebook)), uploads(since))
        val onServer = itemManager(notebook).fetch(note.uid)
        assertEquals("First phone edit", onServer.contentString)
        assertArrayEquals("nothing was written over the metadata, typed or otherwise", NOT_ONE_MAP, onServer.metaRaw)
        assertEquals("and no conflicted copy was made", setOf(note.uid), fake.itemUids(notebook))
        val held = (pending(account, "gen-notamap").read(note.uid) as PendingNotesStore.Read.Present).entry
        assertEquals(PendingEntry.State.HELD, held.state)
        assertEquals(HeldReason.UNREADABLE_METADATA, held.held!!.reason)
        assertEquals("the text is kept", "Second phone edit", itemManager(notebook).cacheLoad(held.blob).contentString)
        assertEquals("no failure is counted against it", 0, held.failureCount)
        assertSucceeded(status(account, "gen-notamap"))

        // Trying again by hand changes nothing while that copy is what it is: one refused push, held again.
        assertTrue(pending(account, "gen-notamap").release(note.uid))
        val again = fake.requests.size
        syncNow(account, "gen-notamap")
        assertEquals(listOf(transactionOf(notebook)), uploads(again))
        val heldAgain = (pending(account, "gen-notamap").read(note.uid) as PendingNotesStore.Read.Present).entry
        assertEquals(PendingEntry.State.HELD, heldAgain.state)
        assertEquals(HeldReason.UNREADABLE_METADATA, heldAgain.held!!.reason)
        assertEquals("Second phone edit", itemManager(notebook).cacheLoad(heldAgain.blob).contentString)
        assertArrayEquals(NOT_ONE_MAP, itemManager(notebook).fetch(note.uid).metaRaw)
    }

    @Test fun aConflictCopyThatCannotBeMadeHoldsTheTextAndNoCopyIsUploaded() {
        val account = newAccount("gen-nocopy")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-nocopy")
        // The local edit carries metadata no decoder reads (a map cut short), so no title can be taken
        // from it for a copy. The editor saves such metadata only by keeping, as it is, metadata another
        // client wrote; here it stands for a copy that cannot be made.
        editLocally(account, "gen-nocopy", notebook, note.uid, "Plan", "Edited on the phone", mtime = 2_000L, metaRaw = CUT_SHORT_MAP)
        editOnAnotherDevice(notebook, note.uid, "Edited on the web")

        val since = fake.requests.size
        syncNow(account, "gen-nocopy")
        assertEquals("the refused push, and no copy after it", listOf(transactionOf(notebook)), uploads(since))
        assertEquals("no second note on the server", setOf(note.uid), fake.itemUids(notebook))
        assertEquals("Edited on the web", itemManager(notebook).fetch(note.uid).contentString)
        val held = (pending(account, "gen-nocopy").read(note.uid) as PendingNotesStore.Read.Present).entry
        assertEquals(PendingEntry.State.HELD, held.state)
        assertEquals(HeldReason.NOT_BUILT, held.held!!.reason)
        assertEquals("the text is kept", "Edited on the phone", itemManager(notebook).cacheLoad(held.blob).contentString)
        assertEquals("no failure is counted against it", 0, held.failureCount)
        assertNull("and no storage error is on record for it", held.lastFailureCategory)
        assertSucceeded(status(account, "gen-nocopy"))

        // Held text is not pushed: the next run sends nothing.
        val again = fake.requests.size
        syncNow(account, "gen-nocopy")
        assertEquals(emptyList<String>(), uploads(again))
        assertEquals(PendingEntry.State.HELD, (pending(account, "gen-nocopy").read(note.uid) as PendingNotesStore.Read.Present).entry.state)
    }

    @Test fun aRebasedNoteThatDoesNotReadBackIsHeldAndIsNotUploaded() {
        val account = newAccount("gen-readback")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-readback")
        // An upload of this device lands with metadata that is one well-formed map, which the raw merge
        // can write into, but with a field the typed decoder every client reads with rejects (a
        // description that is a number). Its answer is lost. The editor saves such a field only by keeping
        // metadata another client wrote as it is, when its merge does not read back.
        val oddField = TestMsgPack.encode(linkedMapOf("description" to 7L))
        editLocally(account, "gen-readback", notebook, note.uid, "Plan", "First phone edit", mtime = 2_000L, metaRaw = oddField)
        fake.loseAnswer("POST", TRANSACTION)
        syncNow(account, "gen-readback")
        assertArrayEquals("the upload landed", oddField, itemManager(notebook).fetch(note.uid).metaRaw)

        // The next save is rebased onto that copy: name and time merge into the map, and the result is
        // read back through the typed decoder before anything is sent.
        editLocally(account, "gen-readback", notebook, note.uid, "Plan", "Second phone edit", mtime = 3_000L,
            metaRaw = NoteMetaCodec.fresh("Plan", 3_000L).bytes)
        val since = fake.requests.size
        syncNow(account, "gen-readback")
        assertEquals("the push that met the conflict, and nothing after it", listOf(transactionOf(notebook)), uploads(since))
        val onServer = itemManager(notebook).fetch(note.uid)
        assertEquals("First phone edit", onServer.contentString)
        assertArrayEquals("the copy on the server is as it was", oddField, onServer.metaRaw)
        val held = (pending(account, "gen-readback").read(note.uid) as PendingNotesStore.Read.Present).entry
        assertEquals(PendingEntry.State.HELD, held.state)
        assertEquals(HeldReason.READ_BACK_FAILED, held.held!!.reason)
        assertEquals("the text is kept", "Second phone edit", itemManager(notebook).cacheLoad(held.blob).contentString)
        assertEquals("no failure is counted against it", 0, held.failureCount)
        assertSucceeded(status(account, "gen-readback"))
    }

    @Test fun aCancelledOrSwitchedOffRunWritesNothingAfterItsInFlightPush() {
        val account = newAccount("gen-push-stop")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-push-stop")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        val list = uploadNote(notebook, "List", "Milk", mtime = 1_500L)
        syncNow(account, "gen-push-stop")
        // Every held run below has two changes waiting. The plan's is the older one, so the held
        // upload is the plan's. What a run that went on would do with the list's differs: in steps 1
        // and 3, where the server takes the upload, it would be seen sending it; in step 2 the dropped
        // connection would end the push step with the plan's failure counted; in step 4 it would hold
        // both. A note is also added on the server before each of those runs, so a run that went on
        // would fetch it and move the notebook's cursor. A stop by the cancelled schedule alone, with
        // the interrupt swallowed, is shown on a dropped upload (step 2) and on the notebook fetch
        // (step 4), not on an upload the server took.

        // 1. The run is cancelled while the upload is in flight, after the server took it. Like a
        // blocking socket read, the request does not stop for the interrupt; its answer arrives afterwards.
        editLocally(account, "gen-push-stop", notebook, note.uid, "Plan", "Phone edit one", mtime = 2_000L)
        editLocally(account, "gen-push-stop", notebook, list.uid, "List", "Milk and eggs", mtime = 2_500L)
        val webOne = uploadNote(notebook, "From the web one", "Web text one", mtime = 3_000L)
        val cancelled = holdPush(account, "gen-push-stop", notebook, note.uid, applied = true)
        NotesSyncCoordinator.cancel(identity)
        release(cancelled)
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertNothingWrittenFromPush(cancelled, account, "gen-push-stop", notebook, note.uid)
        assertEquals("the upload itself landed", "Phone edit one", itemManager(notebook).fetch(note.uid).contentString)
        assertEquals("the change behind it was not sent", "Milk", itemManager(notebook).fetch(list.uid).contentString)

        // The next run is not affected. It sends the same revision again, which the server takes
        // without a change, then the list, and it fetches the note from the web: no conflicted copy.
        var again = fake.requests.size
        syncNow(account, "gen-push-stop")
        assertEquals(listOf(transactionOf(notebook), transactionOf(notebook)), uploads(again))
        assertEquals("the resent revision was taken as it is, with no fetch of the server's copy", 0,
            fake.requests.drop(again).count { it.substringBefore('?') == "GET collection/$notebook/item/${note.uid}/" })
        assertEquals("no conflicted copy", setOf(note.uid, list.uid, webOne.uid), fake.itemUids(notebook))
        assertEquals("Milk and eggs", itemManager(notebook).fetch(list.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-push-stop").isEmpty())
        assertEquals("Phone edit one", cachedBody(account, notebook, note.uid))
        assertEquals("Milk and eggs", cachedBody(account, notebook, list.uid))
        assertEquals(setOf("Plan", "List", "From the web one"), cachedNotes(account, notebook))
        assertEquals(fake.itemStoken(notebook), notebookCursor(account, notebook))
        assertSucceeded(status(account, "gen-push-stop"))

        // 2. Cancelled again, but the server never takes the upload and the network stack swallows
        // the interrupt. The connection drops, which a run that is still wanted counts as the
        // change's failure; here only the cancelled schedule, not the thread's interrupt, says stop.
        editLocally(account, "gen-push-stop", notebook, note.uid, "Plan", "Phone edit two", mtime = 4_000L)
        editLocally(account, "gen-push-stop", notebook, list.uid, "List", "Milk, eggs and tea", mtime = 4_500L)
        val webTwo = uploadNote(notebook, "From the web two", "Web text two", mtime = 5_000L)
        val dropped = holdPush(account, "gen-push-stop", notebook, note.uid, applied = false, swallowInterrupt = true)
        NotesSyncCoordinator.cancelAccount(account.type, account.name)
        release(dropped)
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertNothingWrittenFromPush(dropped, account, "gen-push-stop", notebook, note.uid)
        assertEquals("the server has the text from before", "Phone edit one", itemManager(notebook).fetch(note.uid).contentString)

        // Unlike after step 1, the held upload never landed: the next run's first upload is not a
        // resend the server already has, and both of its uploads change the server's notes.
        again = fake.requests.size
        syncNow(account, "gen-push-stop")
        assertEquals(listOf(transactionOf(notebook), transactionOf(notebook)), uploads(again))
        assertEquals("no conflicted copy", setOf(note.uid, list.uid, webOne.uid, webTwo.uid), fake.itemUids(notebook))
        assertEquals("Phone edit two", itemManager(notebook).fetch(note.uid).contentString)
        assertEquals("Milk, eggs and tea", itemManager(notebook).fetch(list.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-push-stop").isEmpty())
        assertEquals(setOf("Plan", "List", "From the web one", "From the web two"), cachedNotes(account, notebook))
        assertEquals(fake.itemStoken(notebook), notebookCursor(account, notebook))
        assertSucceeded(status(account, "gen-push-stop"))

        // 3. Notes is switched off while the upload is in flight, with no cancellation reaching the
        // run, and the server took the upload.
        editLocally(account, "gen-push-stop", notebook, note.uid, "Plan", "Phone edit three", mtime = 6_000L)
        editLocally(account, "gen-push-stop", notebook, list.uid, "List", "Milk, eggs, tea and jam", mtime = 6_500L)
        val webThree = uploadNote(notebook, "From the web three", "Web text three", mtime = 7_000L)
        val switchedOff = holdPush(account, "gen-push-stop", notebook, note.uid, applied = true)
        assertTrue(AccountSettings.writeNotesEnabled(manager, account, false))
        release(switchedOff)
        awaitSettled(identity)
        assertNothingWrittenFromPush(switchedOff, account, "gen-push-stop", notebook, note.uid)
        assertEquals("the upload itself landed", "Phone edit three", itemManager(notebook).fetch(note.uid).contentString)

        // Notes is switched on again and the plan is saved once more before the next run. That save
        // goes onto the change still waiting, so it is still based on the copy from before the upload,
        // and its push is refused. The server's copy is the revision the switched-off run sent, so
        // the save is rebased onto it and not copied.
        assertTrue(AccountSettings.writeNotesEnabled(manager, account, true))
        editLocally(account, "gen-push-stop", notebook, note.uid, "Plan", "Phone edit four", mtime = 8_000L)
        again = fake.requests.size
        syncNow(account, "gen-push-stop")
        assertEquals("the list, the refused push of the new save, and its rebased push",
            listOf(transactionOf(notebook), transactionOf(notebook), transactionOf(notebook)), uploads(again))
        assertEquals("the server copy was fetched once", 1,
            fake.requests.drop(again).count { it.substringBefore('?') == "GET collection/$notebook/item/${note.uid}/" })
        assertEquals("no conflicted copy", setOf(note.uid, list.uid, webOne.uid, webTwo.uid, webThree.uid), fake.itemUids(notebook))
        assertEquals("Phone edit four", itemManager(notebook).fetch(note.uid).contentString)
        assertEquals("Milk, eggs, tea and jam", itemManager(notebook).fetch(list.uid).contentString)
        assertTrue("nothing is left waiting", pendingHeaders(account, "gen-push-stop").isEmpty())
        assertEquals(setOf("Plan", "List", "From the web one", "From the web two", "From the web three"), cachedNotes(account, notebook))
        assertSucceeded(status(account, "gen-push-stop"))

        // 4. One step further than the fetch cases go: the upload is refused, and the run is
        // cancelled while the fetch that confirms why is in flight, which is of the notebook itself
        // and not the upload. The notebook turns read-only after this run's listing, so only the push
        // and that fetch can see it, and the interrupt is swallowed, so when the answer comes back
        // only the cancelled schedule says stop. The cancelled run must not hold what waits in the
        // notebook. This step is the last one, since it leaves the notebook read-only.
        editLocally(account, "gen-push-stop", notebook, note.uid, "Plan", "Phone edit five", mtime = 9_000L)
        editLocally(account, "gen-push-stop", notebook, list.uid, "List", "Milk only", mtime = 9_500L)
        uploadNote(notebook, "From the web four", "Web text four", mtime = 10_000L)
        val store = pending(account, "gen-push-stop")
        val waiting = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
        val stoken = fake.itemStoken(notebook)
        val cursor = notebookCursor(account, notebook)
        val cached = cachedNotes(account, notebook)
        val before = status(account, "gen-push-stop")
        val since = fake.requests.size
        val push = fake.hold("POST", TRANSACTION)
        val confirming = fake.hold("GET", Regex("collection/$notebook/"), swallowInterrupt = true)
        startManualRun(account, "gen-push-stop")
        push.awaitArrival()
        val pushHeldAt = SystemClock.uptimeMillis()
        assertEquals("the held request is the upload", transactionOf(notebook), push.request)
        assertEquals("its entry names the revision that was sent", waiting.copy(sent = listOf(waiting.revision)),
            PendingCodec.decodeEntry(filesOnDisk(store).getValue("${note.uid}.note")).orFail("${note.uid}.note"))
        fake.setAccessLevel(notebook, 0L)
        release(push, pushHeldAt)
        confirming.awaitArrival()
        val confirmingHeldAt = SystemClock.uptimeMillis()
        assertEquals("the held request is the fetch of the notebook", "GET collection/$notebook/", confirming.request)
        val through = fake.requests.size
        val whileHeld = filesOnDisk(store)
        NotesSyncCoordinator.cancel(identity)
        release(confirming, confirmingHeldAt)
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        // The first two lines are controls: once a refusal is confirmed as read-only, no run uploads
        // again or fetches the notebook twice. A run that went on shows in what follows.
        assertEquals("the refused upload, and none after it", listOf(transactionOf(notebook)), uploads(since))
        assertEquals("one confirming fetch of the notebook", 1, notebookFetches(since, notebook))
        assertEquals("no request of any kind followed that fetch", emptyList<String>(), fake.requests.drop(through))
        assertSameFiles("nothing was held or counted by the cancelled run", whileHeld, filesOnDisk(store))
        assertEquals("the notebook's cursor did not move", cursor, notebookCursor(account, notebook))
        assertEquals("the note from the web was not fetched into the cache", cached, cachedNotes(account, notebook))
        // The stand-in counts an upload before it looks at the access level, so the notes' cursor,
        // not that count, says the refused upload was not applied.
        assertEquals("the refused upload was not applied", stoken, fake.itemStoken(notebook))
        status(account, "gen-push-stop").let {
            assertEquals("no success was recorded for the cancelled run", before.lastSuccessAt, it.lastSuccessAt)
            assertEquals("no failure was recorded for it", before.lastFailureAt, it.lastFailureAt)
            assertNull("no attempt left open: $it", it.activeAttemptId)
        }

        // The next run's listing shows the notebook as read-only, so both changes are held without an
        // upload. Reading is still allowed, and the run fetches the note from the web.
        again = fake.requests.size
        syncNow(account, "gen-push-stop")
        assertEquals("nothing was uploaded", emptyList<String>(), uploads(again))
        assertEquals(cached + "From the web four", cachedNotes(account, notebook))
        for (uid in listOf(note.uid, list.uid)) {
            val held = (store.read(uid) as PendingNotesStore.Read.Present).entry
            assertEquals(PendingEntry.State.HELD, held.state)
            assertEquals(HeldReason.READ_ONLY, held.held!!.reason)
        }
        assertSucceeded(status(account, "gen-push-stop"))
    }

    @Test fun signOutWhileAPushIsInFlightLetsItsLateAnswerWriteNothing() {
        // What this case shows about the push is in the request log: one upload, and no request after
        // it but those of one run after a restart, which uploads nothing. A confirmed sign-out clears the
        // account's pending store under its lock before it removes the account, so the store's files
        // cannot be compared after it. The case checks instead that a sign-out without the confirmation
        // touches nothing, that a clear that stops keeps the account and every file, that after a restart
        // a run sends nothing that clear's permit names, records a storage failure and still fetches,
        // that a store that cannot be listed gets an acknowledgement, deletes nothing and
        // keeps the account, that the files go while the account row is still there, that the directory
        // stays gone after the late answer, and that the cleared store refuses a late save. Whether the
        // store, its permit and its acknowledgement are there is read from listings that must work, never
        // from File.exists(). The cache and status checks after the release are controls, the ones the
        // fetch case makes: the status store refuses any late write once sign-out has cleared the record,
        // whatever the push does.
        val account = newAccount("gen-push-out")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-push-out")
        val notebook = uploadNotebook("Signed out of")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        val list = uploadNote(notebook, "List", "Milk", mtime = 1_500L)
        syncNow(account, "gen-push-out")
        // Two changes wait and a note was added on the server, as in the case above. The server takes
        // the held upload, so its answer is one that a run that went on would follow directly with a
        // write into the cache, with no other request in between.
        editLocally(account, "gen-push-out", notebook, note.uid, "Plan", "Phone edit before sign-out", mtime = 2_000L)
        editLocally(account, "gen-push-out", notebook, list.uid, "List", "Milk and eggs", mtime = 2_500L)
        uploadNote(notebook, "From the web", "Web text", mtime = 3_000L)
        val held = holdPush(account, "gen-push-out", notebook, note.uid, applied = true)
        val permits = File(context.noBackupFilesDir, PendingNotesDiscardPermits.ROOT)
        val permit = File(permits, "${held.store.dir.name}.permit")
        val acknowledgement = "${held.store.dir.name}.acknowledgement"
        val notesPending = held.store.dir.parentFile!!
        fun accountPresent() = account in manager.getAccountsByType(account.type)

        // 1. Without the separate discard confirmation the sign-out is refused before anything is
        // canceled: the account stays, the run still waits for its answer, and the store is untouched.
        val unconfirmed =
            CurrentAccountSignOutCoordinator(AndroidCurrentAccountSignOut(context, account, "gen-push-out"))
        try {
            unconfirmed.begin()
            assertEquals(CurrentAccountSignOutState.Refused, unconfirmed.state)
        } finally {
            unconfirmed.close()
        }
        assertTrue("the account stays", accountPresent())
        assertTrue("the run was not canceled", NotesSyncCoordinator.isActive(identity))
        assertSameFiles("a refused sign-out touches nothing", held.files, filesOnDisk(held.store))
        assertFalse("and records no permit", permit.name in namesIn(permits))

        // 2. A confirmed sign-out whose clear stops: the account and every file of the store stay, and so
        // does the permit recorded before the clear began. The attempt canceled the run, as every
        // confirmed attempt does before it clears.
        val shown = held.store.unsynced()
        assertEquals("two changes wait", 2, shown.count)
        awaitSyncManagerQuiet()
        val stopped = CurrentAccountSignOutCoordinator(AndroidCurrentAccountSignOut(context, account, "gen-push-out"))
        PendingNotesStore.beforeClearForTesting = { throw IOException("the clear stops here") }
        try {
            stopped.confirmNotesDiscard(identity, shown)
            stopped.begin()
            assertTrue("the clear stopped: ${stopped.state}",
                stopped.state is CurrentAccountSignOutState.NotesClearFailed)
        } finally {
            PendingNotesStore.beforeClearForTesting = null
            stopped.close()
        }
        assertTrue("the account stays", accountPresent())
        assertSameFiles("every file of the store stays", held.files, filesOnDisk(held.store))
        assertTrue("the permit was recorded before the clear", permit.name in namesIn(permits))
        assertFalse("the attempt canceled the run",
            NotesSyncCoordinator.isActive(identity) || NotesSyncCoordinator.isPending(identity))
        assertStillHeld(held.heldAt)
        val permitBytes = permit.readBytes()

        // Then a restart: a new store instance takes the old one's place, here and in the steps below, and a
        // real run sends nothing the permit names. Its push step records a storage failure, nothing is
        // uploaded, and the fetch still runs. The canceled run still waits for its answer on the account's
        // own worker, so this run is made on the test's thread.
        PendingNotesStore.resetForTesting()
        val restarted = pending(account, "gen-push-out")
        assertFalse("a new instance after the restart", restarted === held.store)
        assertFalse("the note from the web is not cached yet", "From the web" in cachedNotes(account, notebook))
        forgetLastListing(account.name)
        val restartRun = fake.requests.size
        assertEquals("no request followed the held upload before this run", held.through, restartRun)
        NotesSyncRunner.run(context, account, "gen-push-out", NotesSyncRunner.Request(requestId = null, manual = true))
        assertEquals("nothing was uploaded", emptyList<String>(), uploads(restartRun))
        assertTrue("the fetch still ran", "From the web" in cachedNotes(account, notebook))
        status(account, "gen-push-out").let {
            assertEquals("a failure, not a success: $it", SyncStatusStore.TerminalResult.FAILURE, it.lastTerminalResult)
            assertEquals(SyncStatusStore.FailureCategory.STORAGE, it.lastFailureCategory)
        }
        assertEquals("the snapshot names both changes", setOf(note.uid, list.uid),
            restarted.snapshot { false }.discardConfirmed)
        // The run refreshed the notebook's copy, so the files are read again for the steps below; the
        // changes themselves are byte for byte what the stopped sign-out left.
        val kept = filesOnDisk(restarted)
        assertEquals("no file came or went", held.files.keys, kept.keys)
        for (name in held.files.keys.filter { it.endsWith(".note") }) {
            assertArrayEquals("$name is untouched", held.files.getValue(name), kept.getValue(name))
        }
        assertArrayEquals("the permit stays as it was", permitBytes, permit.readBytes())
        val afterRestart = fake.requests.size
        assertStillHeld(held.heldAt)

        // 3. A confirmed sign-out while the store's directory cannot be listed deletes nothing. What the
        // user confirmed was shown as changes that could not be counted, and the store takes it only as an
        // acknowledgement bound to its directory, never as a permit. The account stays, and its removal is
        // never asked for.
        val removals = AtomicInteger()
        PendingNotesStore.listFilesForTesting = { d -> if (d == held.store.dir) null else d.listFiles() }
        try {
            val unlisted = restarted.unsynced()
            assertTrue("the store could not be listed: $unlisted", !unlisted.listed && unlisted.unreadable)
            awaitSyncManagerQuiet()
            val real = AndroidCurrentAccountSignOut(context, account, "gen-push-out")
            val counted = object : CurrentAccountSignOutCoordinator.Seams by real {
                override fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit) {
                    removals.incrementAndGet()
                    real.removeMain(main, callback)
                }
            }
            val unlistedSignOut = CurrentAccountSignOutCoordinator(counted)
            try {
                unlistedSignOut.confirmNotesDiscard(identity, unlisted)
                unlistedSignOut.begin()
                assertEquals(CurrentAccountSignOutState.NotesClearFailed(1, notesDiscarded = false,
                    CurrentAccountSignOutState.NotesClearFailed.Acknowledgement.RECORDED), unlistedSignOut.state)
            } finally {
                unlistedSignOut.close()
            }
            assertTrue("an acknowledgement holds for the store", restarted.acknowledged())
        } finally {
            PendingNotesStore.listFilesForTesting = null
        }
        assertEquals("the removal was never asked for", 0, removals.get())
        assertTrue("the account stays", accountPresent())
        assertSameFiles("nothing was deleted", kept, filesOnDisk(restarted))
        assertTrue("the acknowledgement is a record of its own", acknowledgement in namesIn(permits))
        assertArrayEquals("the permit stays as it was", permitBytes, permit.readBytes())
        assertStillHeld(held.heldAt)

        // 4. Once the listing works again, another confirmed sign-out, with the real count, finishes it, from
        // start to finish, while the upload's answer is still held. Each file of the store goes while the
        // account row is still there, the directory is gone before the removal is asked for, and the permit
        // goes with the directory. The count's listing removed the acknowledgement.
        val rowAtEachRemoval = CopyOnWriteArrayList<Boolean>()
        val atRemoval = AtomicReference<String>()
        PendingNotesStore.beforeRemoveForTesting = { file ->
            if (file.parentFile == held.store.dir) rowAtEachRemoval += accountPresent()
        }
        try {
            signOut(account, "gen-push-out") { real ->
                object : CurrentAccountSignOutCoordinator.Seams by real {
                    override fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit) {
                        // A listing that fails reads "null" here, which the check below does not take.
                        val listed = notesPending.list()?.contains(held.store.dir.name)
                        atRemoval.set("store there: $listed, row there: ${accountPresent()}")
                        real.removeMain(main, callback)
                    }
                }
            }
        } finally {
            PendingNotesStore.beforeRemoveForTesting = null
        }
        assertTrue("files were removed", rowAtEachRemoval.isNotEmpty())
        assertTrue("each file went while the account row was there: $rowAtEachRemoval", rowAtEachRemoval.all { it })
        assertEquals("when the removal was asked for", "store there: false, row there: true", atRemoval.get())
        assertFalse(accountPresent())
        assertFalse("the store is gone", held.store.dir.name in namesIn(notesPending))
        assertFalse("the permit went with the store", permit.name in namesIn(permits))
        assertFalse("and so did the acknowledgement", acknowledgement in namesIn(permits))
        assertFalse(restarted.acknowledged())
        assertFalse("sign-out cancelled the Notes run", NotesSyncCoordinator.isActive(identity) || NotesSyncCoordinator.isPending(identity))
        assertTrue("sign-out cleared the cache: ${cacheFiles(account.name)}", cacheFiles(account.name).isEmpty())
        assertEquals("sign-out cleared the status", SyncStatusStore.Status(), status(account, "gen-push-out"))

        release(held)
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        // The late answer did not bring the store back. The cleared store stays the one instance for its
        // directory, closed, so a save that arrives late is refused too, and so is one through the instance
        // the run in flight holds, which the stopped clear closed before the restart.
        assertFalse("the store stays gone after the late answer", held.store.dir.name in namesIn(notesPending))
        assertTrue("the cleared store stays the one instance for its directory",
            restarted === PendingNotesStore.forIdentity(context, account.type, account.name, "gen-push-out"))
        for (store in listOf(restarted, held.store)) {
            assertTrue("a save that arrives late is refused", runCatching {
                store.saveLocal(note.uid, notebook, "late", ByteArray(1), isCreate = false)
            }.exceptionOrNull() is PendingNotesStore.Cleared)
        }
        assertFalse("and it does not bring the directory back", held.store.dir.name in namesIn(notesPending))
        assertEquals("one upload, and none after it", listOf(transactionOf(notebook)), uploads(held.since))
        assertEquals("no request of any kind followed the held upload but those of the run after the restart",
            emptyList<String>(), fake.requests.drop(afterRestart))
        assertEquals("the server routed that one upload", listOf(1), fake.uploadSizes.drop(held.sizes))
        assertTrue("the late answer wrote nothing into the cache: ${cacheFiles(account.name)}", cacheFiles(account.name).isEmpty())
        assertEquals("the late run recorded nothing", SyncStatusStore.Status(), status(account, "gen-push-out"))

        // A same-name account that signs in afterwards starts from nothing, with a store of its own
        // that is empty. Its run sends nothing and fetches what the server took: the plan's upload,
        // and not the list's, which never left the device. Both accounts are one Etebase user in this
        // class, which is why the new one can read it.
        val next = newAccount("gen-push-in", account.name, discoveryKey = false)
        assertNull(listCursor(next))
        assertTrue(cachedNotebooks(next).isEmpty())
        assertEquals(SyncStatusStore.Status(), status(next, "gen-push-in"))
        val newStore = pending(next, "gen-push-in")
        assertFalse("a directory of its own", newStore.dir.canonicalPath == held.store.dir.canonicalPath)
        assertEquals(PendingNotesStore.Observed(PendingNotesStore.Read.Missing, 0), newStore.observe(note.uid))
        assertTrue(newStore.snapshot { true }.let { it.headers.isEmpty() && it.entries.isEmpty() && it.unreadable.isEmpty() })
        val beforeRun = fake.requests.size
        syncNow(next, "gen-push-in")
        assertEquals("the new account's run uploads nothing", emptyList<String>(), uploads(beforeRun))
        assertEquals("the upload the server took is its copy now", "Phone edit before sign-out", cachedBody(next, notebook, note.uid))
        assertEquals("Milk", cachedBody(next, notebook, list.uid))
        assertEquals(setOf("Plan", "List", "From the web"), cachedNotes(next, notebook))
        assertEquals("no unsynced text", 0, (NotesLoader.notebooks(context, next, "gen-push-in") as NotesLoad.Loaded).value.unsyncedText)
        assertSucceeded(status(next, "gen-push-in"))
        // The old generation's clear through the real seams once more, while the row of that name is the
        // new account's and its store holds a change: the old store has nothing left, and the new
        // account's store keeps its files and its count.
        editLocally(next, "gen-push-in", notebook, list.uid, "List", "Milk and bread", mtime = 4_000L)
        val newFiles = filesOnDisk(newStore)
        val newCount = newStore.unsynced()
        assertEquals("the new account's store holds a change", 1, newCount.count)
        val oldSeams = AndroidCurrentAccountSignOut(context, account, "gen-push-out")
        assertEquals("the old generation's store has nothing left", PendingNotesStore.DiscardOutcome.Done,
            try { oldSeams.discardPendingNotes(identity, null) } finally { oldSeams.close() })
        assertSameFiles("the new account's store keeps its files", newFiles, filesOnDisk(newStore))
        assertEquals("and its count", newCount, newStore.unsynced())
    }

    @Test fun aSameNameAccountThatReplacedTheOldOneGetsNothingFromTheOldRunsInFlightPush() {
        val name = "notes-boundary-${System.nanoTime()}@example.invalid"
        val account = newAccount("gen-push-old", name)
        val oldIdentity = ExactAccountIdentity(account.type, name, "gen-push-old")
        val notebook = uploadNotebook("Shared before the swap")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        val list = uploadNote(notebook, "List", "Milk", mtime = 1_500L)
        syncNow(account, "gen-push-old")
        // Two changes wait and a note was added on the server, as in the two cases above.
        editLocally(account, "gen-push-old", notebook, note.uid, "Plan", "Phone edit before the swap", mtime = 2_000L)
        editLocally(account, "gen-push-old", notebook, list.uid, "List", "Milk and eggs", mtime = 2_500L)
        uploadNote(notebook, "From the web", "Web text", mtime = 3_000L)
        val held = holdPush(account, "gen-push-old", notebook, note.uid, applied = true)

        // The account is removed and a same-name one added while the upload's answer is held. Nothing
        // cancels the old run and Notes is on for the replacement, so only the creation id says the
        // run is not this account's. The cache, which the two share by name, is not cleared.
        replaceAccount(account, "gen-push-new")
        assertStillHeld(held.heldAt)
        assertTrue("the old run is still waiting for its answer", NotesSyncCoordinator.isActive(oldIdentity))
        release(held)
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
        assertNothingWrittenFromPush(held, account, "gen-push-old", notebook, note.uid)
        // Two controls, as in the fetch case: status is kept per account generation, and the loader
        // turns the old generation away before it reads anything.
        assertEquals("the replacement's status is untouched", SyncStatusStore.Status(), status(account, "gen-push-new"))
        assertEquals(NotesLoad.Stale, NotesLoader.note(context, account, "gen-push-old", notebook, note.uid))
        // Not inherited: the replacement's store is another directory, with nothing in it, and the
        // loader the screens use finds no unsynced text.
        val newStore = pending(account, "gen-push-new")
        assertFalse("a directory of its own", newStore.dir.canonicalPath == held.store.dir.canonicalPath)
        assertEquals(PendingNotesStore.Observed(PendingNotesStore.Read.Missing, 0), newStore.observe(note.uid))
        assertTrue(newStore.snapshot { true }.let { it.headers.isEmpty() && it.entries.isEmpty() && it.unreadable.isEmpty() })
        assertNull(newStore.notebook(notebook))
        assertEquals("no unsynced text", 0, (NotesLoader.notebooks(context, account, "gen-push-new") as NotesLoad.Loaded).value.unsyncedText)

        val beforeRun = fake.requests.size
        syncNow(account, "gen-push-new")
        assertEquals("the replacement's run uploads nothing", emptyList<String>(), uploads(beforeRun))
        // Both accounts of this class use one Etebase session, so the text the old account uploaded
        // reaches the replacement as the server's copy, fetched by the replacement's own run.
        assertEquals("Phone edit before the swap", cachedBody(account, notebook, note.uid))
        assertEquals(setOf("Plan", "List", "From the web"), cachedNotes(account, notebook))
        assertEquals("the change behind the held upload was not sent", "Milk", itemManager(notebook).fetch(list.uid).contentString)
        assertSameFiles("the old account's store after the replacement's run", held.files, filesOnDisk(held.store))

        // The replacement saves the same note and pushes it, and the old account's files are as they were.
        editLocally(account, "gen-push-new", notebook, note.uid, "Plan", "Replacement text", mtime = 4_000L)
        val beforePush = fake.requests.size
        syncNow(account, "gen-push-new")
        assertEquals("the replacement's push", listOf(transactionOf(notebook)), uploads(beforePush))
        assertEquals("Replacement text", itemManager(notebook).fetch(note.uid).contentString)
        assertSameFiles("the old account's store after the replacement's push", held.files, filesOnDisk(held.store))
        assertSucceeded(status(account, "gen-push-new"))
    }

    @Test fun theStartupSweepRemovesOnlyCleanStoresOfRemovedAccountsAndKeepsEveryStoreWithText() {
        // The app start launched this process's sweep, and setUp waited for it.
        val startup = NotesStartupSweep.startup
        assertNotNull("the app start launched the startup sweep", startup)
        assertTrue("and it is over", startup!!.isCompleted)
        // Every row on the device has a creation id that reads, and notes-pending holds no store and no other name.
        val rows = PendingNotesRemovalGuard.rows(manager)
        assertTrue("every row of the main type has a creation id that reads: $rows",
            rows != null && rows.all { it.id is PendingNotesRemovalGuard.CreationId.Readable })
        val found = PendingNotesStore.storeDirectories(context)
        assertTrue("stores left on this device: ${found.stores}, a name of another kind: ${found.unknown}",
            found.stores.isEmpty() && !found.unknown)
        // A run that goes ahead can write the record, which outlives this class in no_backup.
        val record = File(context.noBackupFilesDir, NotesLastActiveRecord.FILE)
        val recordBefore = lastActiveRecord()
        try {
            // A, whose account stays, holds a note and its notebook's copy. R1's note was saved and then
            // discarded, so its store holds a notebook copy and the counter and nothing unsynced. R2 holds a note.
            val a = newAccount("gen-sweep-a")
            val r1 = newAccount("gen-sweep-r1")
            val r2 = newAccount("gen-sweep-r2")
            val aStore = pending(a, "gen-sweep-a")
            val r1Store = pending(r1, "gen-sweep-r1")
            val r2Store = pending(r2, "gen-sweep-r2")
            assertTrue(aStore.saveLocal("a-note", "a-notebook", "r1", ByteArray(8), isCreate = false,
                notebookCopy = ByteArray(4)) is PendingNotesStore.SaveOutcome.Saved)
            assertTrue(r1Store.saveLocal("r1-note", "r1-notebook", "r1", ByteArray(8), isCreate = false)
                is PendingNotesStore.SaveOutcome.Saved)
            r1Store.discard("r1-note")
            r1Store.putNotebook("r1-notebook", ByteArray(4))
            assertTrue(r2Store.saveLocal("r2-note", "r2-notebook", "r1", ByteArray(8), isCreate = false)
                is PendingNotesStore.SaveOutcome.Saved)
            assertEquals(setOf("sequence", "r1-notebook.notebook"), filesOnDisk(r1Store).keys)
            assertFalse("R1's store holds nothing unsynced", r1Store.unsynced().anything)
            val saved = ActiveAccountManager.savedIdentity(context)
            val fixtures = listOf(aStore, r1Store, r2Store).map { it.dir.name }
            assertFalse("the active-account preference names none of them: $saved", saved != null &&
                PendingNotesStore.identityDir(context.noBackupFilesDir, App.accountType, saved.first, saved.second)
                    .name in fixtures)

            // 1. A row of the main type whose creation id does not read holds the whole run back, and nothing in
            // notes-pending, notes-discard or the record changes.
            val onDisk = sweepFilesOnDisk()
            val withoutId = newAccount(null)
            try {
                assertEquals(NotesStartupSweep.Outcome.HeldBack(NotesStartupSweep.HoldBack.ROW_WITHOUT_ID),
                    NotesStartupSweep.run(context))
            } finally {
                removeAccount(withoutId)
            }
            assertSameFiles("a run held back changes nothing", onDisk, sweepFilesOnDisk())

            // 2. Once R1 and R2 are removed, a run removes R1's clean store and keeps R2's, whose note no
            // confirmed discard covers, byte for byte. A's store, whose row is there, stays as it was.
            val aFiles = filesOnDisk(aStore)
            val r2Files = filesOnDisk(r2Store)
            removeAccount(r1)
            removeAccount(r2)
            assertEquals(NotesStartupSweep.Outcome.Swept(1, 1, 0, 0, 0), NotesStartupSweep.run(context))
            assertEquals("R1's folder is gone", PendingNotesStore.Presence.ABSENT,
                PendingNotesStore.presenceOnDevice(r1Store.dir))
            assertSameFiles("R2's store is as it was", r2Files, filesOnDisk(r2Store))
            assertEquals("and the Settings list shows its note", 1,
                UnsyncedNotesStores.read(context).rows.single { it.directory == r2Store.dir.name }.answer?.count)
            assertSameFiles("A's store is as it was", aFiles, filesOnDisk(aStore))
            assertTrue("and it takes a save", aStore.saveLocal("a-note", "a-notebook", "r2", ByteArray(8),
                isCreate = false) is PendingNotesStore.SaveOutcome.Saved)
        } finally {
            if (recordBefore == null) record.delete() else record.writeBytes(recordBefore)
        }
    }

    @Test fun theRawMetadataCodecAgreesWithTheBindingsTypedEncoderAndDecoderExceptWhereStated() {
        // Pure Kotlin first: the screens and the comparison must report hand-made differences before
        // any call into the binding.
        NoteMetaBindingComparison.selfCheck()
        val colMgr = server.collectionManager
        // Made from raw bytes and never uploaded. Every typed call is the comparison's own, behind its screens.
        val notebook = colMgr.create_raw(Constants.ETEBASE_TYPE_NOTES,
            TestMsgPack.encode(linkedMapOf("name" to "Comparison, never uploaded")), ByteArray(0))
        val sdk = Build.VERSION.SDK_INT
        val report = NoteMetaBindingComparison.run(colMgr.getItemManager(notebook), sdk)
        assertEquals(report.text(), 0, report.differences.size)
        // No difference alone does not show that the rows ran: which calls the screens kept out and how
        // many rows were compared are pinned too.
        assertEquals("the typed calls that were not made", NoteMetaBindingComparison.expectedNotSent(sdk), report.notSent)
        assertEquals("the rows that were compared", NoteMetaBindingComparison.expectedCompared(sdk), report.compared)
        assertEquals("the notebook never reached the server", emptySet<String>(), fake.collectionUids())
        assertEquals("no request names the notebook", emptyList<String>(), fake.requests.filter { notebook.uid in it })
    }

    // ---- the account's Unsynced text (design 3.5) ----

    /**
     * Held text shows on the account's Unsynced text screen with its text, decrypted from the notebook copy the store
     * keeps with the account's local keys while the server cannot be reached, and the screen sends no request to
     * show it. Copy hands a clip marked sensitive to the clipboard; the case takes it through
     * [io.silentsuite.sync.ui.notes.SensitiveClip.clipboardOverride], since the emulator mirrors the host clipboard.
     * Try again sends the text back to its notebook, where it waits, and asks for one user-started run.
     * [MainThreadStoreProbe] sees no store listing, removal or write on the main thread; it does not see other store
     * calls.
     */
    @Test fun heldTextShowsOnUnsyncedTextWithItsTextOfflineAndCopyAndTryAgainSendItBack() {
        val account = newAccount("gen-held")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-held")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "Server text", mtime = 1_000L)
        syncNow(account, "gen-held")
        editLocally(account, "gen-held", notebook, note.uid, "Plan held", "Held on this device", mtime = 2_000L)
        val store = pending(account, "gen-held")
        assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold(note.uid, HeldReason.READ_ONLY, now = 1))
        val heldEntry = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
        val heldVersion = heldEntry.version
        // The server stops: every request from here on fails, and is counted.
        val attempts = java.util.concurrent.atomic.AtomicInteger()
        HttpClient.testInterceptor = okhttp3.Interceptor {
            attempts.incrementAndGet()
            throw java.io.IOException("the server is stopped")
        }
        val copiedClip = java.util.concurrent.atomic.AtomicReference<android.content.ClipData?>()
        io.silentsuite.sync.ui.notes.SensitiveClip.clipboardOverride = { copiedClip.set(it) }
        val probe = MainThreadStoreProbe().apply { install() }
        try {
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-held")).use { scenario ->
                waitUntil("the Unsynced text row to show") { notebookList(scenario)?.renderedUnsyncedText == 1 }
                // The run that opening the screen asked for has failed against the stopped server.
                awaitSettled(identity)
                assertEquals("the held note waits on no notebook row", listOf(0), notebookList(scenario)!!.renderedNotebooks.map { it.waiting })
                scenario.onActivity { activity ->
                    val row = activity.findViewById<TextView>(R.id.notebooks_unsynced)
                    assertEquals(View.VISIBLE, row.visibility)
                    assertEquals("Unsynced text (1)", row.text.toString())
                }
                val before = attempts.get()
                scenario.onActivity { it.findViewById<View>(R.id.notebooks_unsynced).performClick() }
                waitUntil("the held text to show") { heldText(scenario)?.renderedRows?.size == 1 }
                assertEquals("showing held text needs no request", before, attempts.get())
                val shown = heldText(scenario)!!.renderedRows!!.single()
                assertEquals(HeldTextRow("${note.uid}.note", note.uid, notebook, "Work", heldVersion, HeldReason.READ_ONLY,
                    "Plan held", "Held on this device", digest = PendingNotesStore.digestOf(heldEntry.blob)), shown)
                scenario.onActivity { activity ->
                    assertEquals(activity.getString(R.string.notes_held_title), activity.title.toString())
                    assertEquals("Plan held", activity.findViewById<TextView>(R.id.held_title).text.toString())
                    assertEquals("Held on this device", activity.findViewById<TextView>(R.id.held_body).text.toString())
                    assertEquals("Its notebook is read-only for you. In Work.", activity.findViewById<TextView>(R.id.held_reason).text.toString())
                    for (id in listOf(R.id.held_copy, R.id.held_try_again, R.id.held_discard)) {
                        assertEquals(View.VISIBLE, activity.findViewById<View>(id).visibility)
                    }
                    activity.findViewById<View>(R.id.held_copy).performClick()
                }
                // The clip the screen hands to the clipboard, taken in its place: the emulator mirrors the host's
                // clipboard, which would replace it, and the platform does not hand the extra back to a reader.
                val copied = checkNotNull(copiedClip.get()) { "the text was copied" }
                assertEquals("Held on this device", copied.getItemAt(0).text.toString())
                assertEquals(context.getString(R.string.notes_held_clip_label), copied.description.label.toString())
                // Android 13 added the extra; on earlier versions the bundle still carries it, and nothing reads it.
                assertTrue("the clip is marked sensitive",
                    copied.description.extras?.getBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE) == true)

                // Try again: the text waits on its notebook again, under a new version, and one run the user
                // started is asked for. It fails against the stopped server, so the change keeps waiting.
                scenario.onActivity { it.findViewById<View>(R.id.held_try_again).performClick() }
                waitUntil("the row to leave Unsynced text") { heldText(scenario)?.renderedRows?.isEmpty() == true }
                awaitSettled(identity)
                val released = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
                assertEquals(PendingEntry.State.UPSERT, released.state)
                assertTrue("a new version", released.version > heldVersion)
                assertTrue("the run reached for the server", attempts.get() > before)
                scenario.onActivity { activity ->
                    assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.held_empty).visibility)
                    activity.onSupportNavigateUp()
                }
                waitUntil("the change to wait on its notebook") { notebookList(scenario)?.renderedNotebooks?.map { it.waiting } == listOf(1) }
                scenario.onActivity { activity ->
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.notebooks_unsynced).visibility)
                    val list = activity.findViewById<ListView>(R.id.notebooks_list)
                    assertEquals("1 change not synced yet", list.adapter.getView(0, null, list).findViewById<TextView>(R.id.description).text.toString())
                }
            }
            probe.assertNoneOnMain()
        } finally {
            probe.uninstall()
            io.silentsuite.sync.ui.notes.SensitiveClip.clipboardOverride = null
            HttpClient.testInterceptor = fake
        }
    }

    /**
     * Discard on the account's Unsynced text asks first, and deletes only the entry the confirmation showed: held
     * text that changed after the screen read it stays, and is shown to be asked again. A note file that cannot be
     * read shows with no Copy and no Try again, and is discarded on its own after its own confirmation.
     */
    @Test fun unsyncedTextDiscardsOnlyTheTextItShowedAndOffersNoCopyForAFileThatCannotBeRead() {
        val account = newAccount("gen-discard")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-discard")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "Server text", mtime = 1_000L)
        syncNow(account, "gen-discard")
        editLocally(account, "gen-discard", notebook, note.uid, "Plan", "First held text", mtime = 2_000L)
        val store = pending(account, "gen-discard")
        assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold(note.uid, HeldReason.LOST_ACCESS, now = 1))
        // A note's entry file that cannot be read, beside it.
        val damaged = "damagedNote0000000000000000000000000001"
        File(store.dir, "$damaged.note").writeBytes(byteArrayOf(0))
        val probe = MainThreadStoreProbe().apply { install() }
        try {
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-discard")).use { scenario ->
                waitUntil("the Unsynced text row to show") { notebookList(scenario)?.renderedUnsyncedText == 2 }
                awaitSettled(identity)
                scenario.onActivity { it.findViewById<View>(R.id.notebooks_unsynced).performClick() }
                waitUntil("both rows to show") { heldText(scenario)?.renderedRows?.size == 2 }
                val rows = heldText(scenario)!!.renderedRows!!
                assertEquals(setOf("$damaged.note", "${note.uid}.note"), rows.map { it.file }.toSet())
                // The cards are in the order of the rows.
                fun cardOf(activity: NotesActivity, file: String) = held(activity).renderedRows!!.indexOfFirst { it.file == file }
                fun cardOf(file: String) = heldText(scenario)!!.renderedRows!!.indexOfFirst { it.file == file }
                assertEquals("the file that cannot be read has no text", null, rows[cardOf("$damaged.note")].body)
                assertEquals("First held text", rows[cardOf("${note.uid}.note")].body)
                scenario.onActivity { activity ->
                    val cards = activity.findViewById<android.view.ViewGroup>(R.id.held_rows)
                    val unreadable = cards.getChildAt(cardOf(activity, "$damaged.note"))
                    assertEquals(activity.getString(R.string.notes_held_unreadable), unreadable.findViewById<TextView>(R.id.held_title).text.toString())
                    assertEquals("no Copy", View.GONE, unreadable.findViewById<View>(R.id.held_copy).visibility)
                    assertEquals("no Try again", View.GONE, unreadable.findViewById<View>(R.id.held_try_again).visibility)
                    assertEquals(View.VISIBLE, unreadable.findViewById<View>(R.id.held_discard).visibility)
                    // Discard of the held text: the confirmation shows, and nothing goes before it is answered.
                    cards.getChildAt(cardOf(activity, "${note.uid}.note")).findViewById<View>(R.id.held_discard).performClick()
                }
                waitUntil("the confirmation to show") { heldText(scenario)?.discardDialog?.isShowing == true }
                assertTrue("nothing deleted before the answer", store.read(note.uid) is PendingNotesStore.Read.Present)
                // A rotation or a recreation brings the confirmation back, still for the text it showed.
                scenario.recreate()
                waitUntil("the confirmation to come back") { heldText(scenario)?.discardDialog?.isShowing == true }
                assertTrue("nothing deleted by the recreation", store.read(note.uid) is PendingNotesStore.Read.Present)
                // An editor that was open when access changed saves into the held text while the confirmation shows.
                editLocally(account, "gen-discard", notebook, note.uid, "Plan", "Typed after the confirmation showed", mtime = 3_000L, intoHeld = true)
                val newer = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
                scenario.onActivity { held(it).discardDialog!!.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick() }
                waitUntil("the newer text to show") { heldText(scenario)?.renderedRows?.any { it.body == "Typed after the confirmation showed" } == true }
                assertEquals("the newer text stays", newer, (store.read(note.uid) as PendingNotesStore.Read.Present).entry)

                // Asked again with the text that is there now, it goes.
                scenario.onActivity { activity ->
                    activity.findViewById<android.view.ViewGroup>(R.id.held_rows).getChildAt(cardOf(activity, "${note.uid}.note"))
                        .findViewById<View>(R.id.held_discard).performClick()
                }
                waitUntil("the confirmation to show again") { heldText(scenario)?.discardDialog?.isShowing == true }
                // Restored in a new app process over unchanged text, its answer deletes nothing: the screen reads the
                // text again and asks again, in a confirmation of this process (the maintainer's answer on #709).
                val unchanged = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
                scenario.onActivity { activity ->
                    held(activity).childFragmentManager.executePendingTransactions()
                    val args = requireNotNull(held(activity).discardConfirmation) { "the confirmation" }.requireArguments()
                    assertEquals("made in this process", ProcessIncarnation.current(), args.getString(HeldTextFragment.ARG_PROCESS))
                    args.putString(HeldTextFragment.ARG_PROCESS, "another-app-process")
                }
                scenario.recreate()
                waitUntil("the restored confirmation to come back") { heldText(scenario)?.discardDialog?.isShowing == true }
                scenario.onActivity { held(it).discardDialog!!.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick() }
                waitUntil("the confirmation to be asked again in this process") {
                    heldText(scenario)?.discardConfirmation?.let { confirmation ->
                        confirmation.dialog?.isShowing == true &&
                            confirmation.requireArguments().getString(HeldTextFragment.ARG_PROCESS) == ProcessIncarnation.current()
                    } == true
                }
                assertEquals("nothing deleted by an answer from another process", unchanged,
                    (store.read(note.uid) as PendingNotesStore.Read.Present).entry)
                // Recreated over unchanged text, the confirmation still carries the version and the text it showed, so
                // the discard goes through: a confirmation that lost them would answer Changed and delete nothing.
                scenario.recreate()
                waitUntil("the confirmation to come back again") { heldText(scenario)?.discardDialog?.isShowing == true }
                scenario.onActivity { held(it).discardDialog!!.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick() }
                waitUntil("the held text to go") { heldText(scenario)?.renderedRows?.map { it.file } == listOf("$damaged.note") }
                assertEquals(PendingNotesStore.Read.Missing, store.read(note.uid))

                // The file that cannot be read goes on its own, after its own confirmation.
                scenario.onActivity { activity ->
                    activity.findViewById<android.view.ViewGroup>(R.id.held_rows).getChildAt(cardOf(activity, "$damaged.note"))
                        .findViewById<View>(R.id.held_discard).performClick()
                }
                waitUntil("its confirmation to show") { heldText(scenario)?.discardDialog?.isShowing == true }
                scenario.onActivity { held(it).discardDialog!!.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick() }
                waitUntil("nothing to be left") { heldText(scenario)?.renderedRows?.isEmpty() == true }
                assertFalse(File(store.dir, "$damaged.note").exists())
                scenario.onActivity { it.onSupportNavigateUp() }
                waitUntil("the notebook list to count nothing") { notebookList(scenario)?.renderedUnsyncedText == 0 }
                scenario.onActivity { activity ->
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.notebooks_unsynced).visibility)
                }
            }
            probe.assertNoneOnMain()
        } finally {
            probe.uninstall()
        }
    }

    /**
     * The Notes screens show the cached notes, with the reason, while the account's local changes cannot be read:
     * a store that cannot be listed, and a store left closed by a whole-store discard that stopped while the account
     * stays. Neither fails a screen nor closes one; main shows the cached notes in both states.
     */
    @Test fun aStoreThatCannotBeListedOrWhoseDiscardStoppedStillShowsTheCachedNotes() {
        val account = newAccount("gen-closed")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "Server text", mtime = 1_000L)
        syncNow(account, "gen-closed")
        editLocally(account, "gen-closed", notebook, note.uid, "Plan", "Local text", mtime = 2_000L)
        val store = pending(account, "gen-closed")
        try {
            // 1. The store cannot be listed: the list says so, and one notebook's notes show from the cache.
            PendingNotesStore.listFilesForTesting = { d -> if (d.canonicalPath == store.dir.canonicalPath) null else d.listFiles() }
            val overview = (NotesLoader.notebooks(context, account, "gen-closed") as NotesLoad.Loaded).value
            assertTrue("the list says the changes could not be read", overview.pendingUnreadable)
            assertEquals(listOf("Work"), overview.notebooks.map { it.name })
            val contents = NotesLoader.notebook(context, account, "gen-closed", notebook)
            assertTrue("the notebook's notes still load: $contents", contents is NotesLoad.Loaded)
            assertEquals(listOf(NoteRow(note.uid, "Plan", "Server text", 1_000L)), (contents as NotesLoad.Loaded).value.notes)
            assertEquals(PendingUnavailable.UNREADABLE, contents.value.pending)
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-closed")).use { scenario ->
                waitUntil("the notebook to show") { notebookList(scenario)?.renderedNotebooks?.size == 1 }
                scenario.onActivity { activity ->
                    val list = activity.findViewById<ListView>(R.id.notebooks_list)
                    list.performItemClick(list.adapter.getView(0, null, list), 0, 0)
                }
                waitUntil("the cached notes to show") { noteList(scenario)?.renderedNotes?.map { it.uid } == listOf(note.uid) }
                scenario.onActivity { activity ->
                    val notice = activity.findViewById<TextView>(R.id.notes_pending)
                    assertEquals(View.VISIBLE, notice.visibility)
                    assertEquals(activity.getString(R.string.notes_pending_unreadable), notice.text.toString())
                }
            }
            PendingNotesStore.listFilesForTesting = null

            // 2. A whole-store discard stops after it closed the store, and the account stays.
            val shown = store.unsynced()
            PendingNotesStore.beforeClearForTesting = { throw java.io.IOException("the discard stops here") }
            assertEquals(PendingNotesStore.DiscardOutcome.NotFinished, store.discardStore(shown))
            PendingNotesStore.beforeClearForTesting = null
            assertTrue(store.clearStopped())
            val stopped = NotesLoader.notebooks(context, account, "gen-closed")
            assertTrue("the list still loads: $stopped", stopped is NotesLoad.Loaded)
            assertTrue((stopped as NotesLoad.Loaded).value.discardStopped)
            assertEquals(listOf("Work"), stopped.value.notebooks.map { it.name })
            val notes = (NotesLoader.notebook(context, account, "gen-closed", notebook) as NotesLoad.Loaded).value
            assertEquals(listOf("Server text"), notes.notes.map { it.preview })
            assertEquals(PendingUnavailable.DISCARD_STOPPED, notes.pending)
            val one = (NotesLoader.note(context, account, "gen-closed", notebook, note.uid) as NotesLoad.Loaded).value
            assertEquals(listOf("Server text", PendingUnavailable.DISCARD_STOPPED), listOf(one.body, one.pending))
            assertEquals(PendingUnavailable.DISCARD_STOPPED,
                (NotesLoader.heldText(context, account, "gen-closed") as NotesLoad.Loaded).value.pending)
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-closed")).use { scenario ->
                waitUntil("the row to say the discard did not finish") { notebookList(scenario)?.renderedDiscardStopped == true }
                scenario.onActivity { activity ->
                    val row = activity.findViewById<TextView>(R.id.notebooks_unsynced)
                    assertEquals(View.VISIBLE, row.visibility)
                    assertEquals(activity.getString(R.string.notes_unsynced_discard_stopped), row.text.toString())
                }
                assertEquals("the screen stays open", Lifecycle.State.RESUMED, scenario.state)
            }

            // 3. After a restart the store opens again, and the stopped discard's permit still covers the text: the
            // viewer shows it as held, never as waiting, since it will not be sent.
            PendingNotesStore.resetForTesting()
            val restarted = (NotesLoader.note(context, account, "gen-closed", notebook, note.uid) as NotesLoad.Loaded).value
            assertEquals(NoteSync.HELD, restarted.sync)
        } finally {
            PendingNotesStore.listFilesForTesting = null
            PendingNotesStore.beforeClearForTesting = null
        }
    }

    /**
     * One load with every kind of local change at once. A change in a writable notebook waits on its row. Held text,
     * a change in a read-only notebook, a change in a notebook the list cannot show, and a note file that cannot be
     * read count as unsynced text, and the Unsynced text screen lists the same four. Only text a run will never send
     * offers Discard: the change in the notebook the list cannot show is still sent, so it offers neither Discard
     * nor, with its text unreadable here, Copy.
     */
    @Test fun oneLoadShowsEveryKindOfLocalChangeAndOffersDiscardOnlyForTextARunWillNotSend() {
        val account = newAccount("gen-mixed")
        val work = uploadNotebook("Work")
        val shared = uploadNotebook("Shared")
        val hidden = uploadUndecodableNotebook()
        val waiting = uploadNote(work, "Waiting", "Server waiting", mtime = 1_000L)
        val held = uploadNote(work, "Held", "Server held", mtime = 1_000L)
        val readOnly = uploadNote(shared, "Shared plan", "Server shared", mtime = 1_000L)
        fake.setAccessLevel(shared, 0L)
        syncNow(account, "gen-mixed")
        editLocally(account, "gen-mixed", work, waiting.uid, "Waiting", "Local waiting", mtime = 2_000L)
        editLocally(account, "gen-mixed", work, held.uid, "Held", "Local held", mtime = 2_000L)
        editLocally(account, "gen-mixed", shared, readOnly.uid, "Shared plan", "Local shared", mtime = 2_000L)
        val store = pending(account, "gen-mixed")
        assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold(held.uid, HeldReason.REJECTED, now = 1))
        val inHidden = "hiddenNote00000000000000000000000000001"
        store.saveLocal(inHidden, hidden, "r1", byteArrayOf(1, 2, 3), isCreate = true)
        val damaged = "damagedNote0000000000000000000000000002"
        File(store.dir, "$damaged.note").writeBytes(byteArrayOf(0))

        val overview = (NotesLoader.notebooks(context, account, "gen-mixed") as NotesLoad.Loaded).value
        assertEquals(listOf("Shared" to 0, "Work" to 1), overview.notebooks.map { it.name to it.waiting })
        assertEquals("held, read-only, not shown, unreadable", 4, overview.unsyncedText)
        val rows = (NotesLoader.heldText(context, account, "gen-mixed") as NotesLoad.Loaded).value.rows.associateBy { it.noteUid }
        assertEquals(setOf(held.uid, readOnly.uid, inHidden, damaged), rows.keys)
        fun offers(uid: String) = rows.getValue(uid).let { listOf(it.body != null, it.canTryAgain, it.canDiscard) }
        assertEquals("held text: Copy, Try again, Discard", listOf(true, true, true), offers(held.uid))
        assertEquals("read-only: Copy only, until a run holds it", listOf(true, false, false), offers(readOnly.uid))
        assertEquals("still sent: nothing to discard here", listOf(false, false, false), offers(inHidden))
        assertTrue(rows.getValue(inHidden).mayStillSync)
        assertEquals("unreadable: Discard on its own", listOf(false, false, true), offers(damaged))
        assertEquals(listOf("Local held", "Local shared"), listOf(rows.getValue(held.uid).body, rows.getValue(readOnly.uid).body))
    }

    /**
     * A whole-store discard that finishes while a load reads the cache makes the load read the local changes again:
     * the list and the notebook show the cached notes, not the text that was just discarded.
     */
    @Test fun aWholeStoreDiscardDuringALoadIsReadAgainOverTheCachedNotes() {
        val account = newAccount("gen-midload")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "Server text", mtime = 1_000L)
        syncNow(account, "gen-midload")
        editLocally(account, "gen-midload", notebook, note.uid, "Plan", "Local text", mtime = 2_000L)
        val store = pending(account, "gen-midload")
        var reads = 0
        io.silentsuite.sync.ui.notes.afterLocalChangesReadForTesting = {
            if (reads++ == 0) assertEquals(PendingNotesStore.DiscardOutcome.Done, store.discardStore(store.unsynced()))
        }
        try {
            val overview = (NotesLoader.notebooks(context, account, "gen-midload") as NotesLoad.Loaded).value
            assertEquals("the load read the store again, once", 2, reads)
            assertEquals(listOf("Work" to 0), overview.notebooks.map { it.name to it.waiting })
            assertEquals(0, overview.unsyncedText)
            val notes = (NotesLoader.notebook(context, account, "gen-midload", notebook) as NotesLoad.Loaded).value.notes
            assertEquals(listOf("Server text"), notes.map { it.preview })
        } finally {
            io.silentsuite.sync.ui.notes.afterLocalChangesReadForTesting = null
        }
    }

    /**
     * A change in a notebook the cache shows read-only offers Copy only, never Discard: a run that finds the notebook
     * writable again would send it, so a discard could race the upload, and the store refuses one
     * ([PendingNotesStore.discard]). Once a run holds the change it is held text, which no run sends without Try
     * again, and Discard is offered and works.
     */
    @Test fun aChangeInAReadOnlyNotebookOffersCopyOnlyUntilASyncHoldsIt() {
        val account = newAccount("gen-reopen")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-reopen")
        val shared = uploadNotebook("Shared")
        val note = uploadNote(shared, "Plan", "Server text", mtime = 1_000L)
        fake.setAccessLevel(shared, 0L)
        syncNow(account, "gen-reopen")
        editLocally(account, "gen-reopen", shared, note.uid, "Plan", "Local text", mtime = 2_000L)
        val store = pending(account, "gen-reopen")
        HttpClient.testInterceptor = okhttp3.Interceptor { throw java.io.IOException("the server is stopped") }
        // No run until the case asks for one, so the change stays a change, not held text.
        NotesSyncCoordinator.runnerOverride = { _, _, _, _ -> }
        try {
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-reopen")).use { scenario ->
                waitUntil("the Unsynced text row to show") { notebookList(scenario)?.renderedUnsyncedText == 1 }
                scenario.onActivity { it.findViewById<View>(R.id.notebooks_unsynced).performClick() }
                waitUntil("the change to show") { heldText(scenario)?.renderedRows?.size == 1 }
                val row = heldText(scenario)!!.renderedRows!!.single()
                assertEquals("Copy, no Try again, no Discard", listOf(true, false, false), listOf(row.canCopy, row.canTryAgain, row.canDiscard))
                scenario.onActivity { activity ->
                    assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.held_copy).visibility)
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.held_discard).visibility)
                    assertEquals("${activity.getString(R.string.notes_held_not_writable)} ${activity.getString(R.string.notes_held_notebook, "Shared")}",
                        activity.findViewById<TextView>(R.id.held_reason).text.toString())
                }
                // A run holds the change: the notebook is still read-only in the cache, and the server is stopped.
                NotesSyncCoordinator.runnerOverride = null
                NotesSyncCoordinator.request(context, account, "gen-reopen", NotesSyncPolicy.Trigger.MANUAL)
                awaitSettled(identity)
                waitUntil("the change to be held") { heldText(scenario)?.renderedRows?.singleOrNull()?.held != null }
                assertTrue("held text offers Discard", heldText(scenario)!!.renderedRows!!.single().canDiscard)
                scenario.onActivity { it.findViewById<View>(R.id.held_discard).performClick() }
                waitUntil("the confirmation to show") { heldText(scenario)?.discardDialog?.isShowing == true }
                scenario.onActivity { held(it).discardDialog!!.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick() }
                waitUntil("the screen to list nothing") { heldText(scenario)?.renderedRows?.isEmpty() == true }
                assertEquals(PendingNotesStore.Read.Missing, store.read(note.uid))
            }
        } finally {
            NotesSyncCoordinator.runnerOverride = null
            HttpClient.testInterceptor = fake
        }
    }

    // ---- the note editor, through the real screens ----

    /**
     * A note made with New note while automatic sync waits for Wi-Fi (the default settings, off Wi-Fi). The editor saves
     * it on this device, as Untitled since its title is blank, and the status line says why it waits. The Save request
     * about ten seconds later is automatic, so off Wi-Fi it asks the server nothing. On Wi-Fi, the request the editor
     * makes as it closes sends the note.
     */
    @Test fun aNewNoteMadeOffWifiIsSavedOnTheDeviceAndSentAtTheNextAllowedTriggerAsUntitled() {
        val account = newAccount("gen-new-note")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-new-note")
        val notebook = uploadNotebook("Work")
        syncNow(account, "gen-new-note")
        val store = pending(account, "gen-new-note")
        assertEquals("the defaults: automatic sync waits for Wi-Fi, and Sync now goes on any connection",
            NotesNetworkPolicy.Settings.DEFAULT, AccountSettings.notesNetworkSettings(manager, account))
        pinNetwork(NotesNetworkPolicy.Connection.OTHER)
        val runs = Runs()
        val probe = MainThreadStoreProbe().apply { install() }
        try {
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-new-note")).use { scenario ->
                // Opening the screen asks for an automatic run, which waits for Wi-Fi.
                awaitSettled(identity)
                showNotebook(scenario, "Work")
                waitUntil("New note to show") { noteList(scenario)?.offersNewNote == true }
                scenario.onActivity { activity ->
                    val button = activity.findViewById<TextView>(R.id.notes_new_note)
                    assertEquals(View.VISIBLE, button.visibility)
                    assertEquals(activity.getString(R.string.notes_new_note), button.text.toString())
                    button.performClick()
                }
                waitUntil("the editor of a new note") { onEditor(scenario) { it.editing } == true }
                val quiet = fake.requests.size
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).append("Written off Wi-Fi") }
                val saved = awaitSave(scenario, "the new note to be saved")
                assertTrue("saved on this device: $saved", saved is SaveResult.Saved)
                val waiting = "${context.getString(R.string.notes_editor_saved)}. ${context.getString(R.string.notes_editor_waiting_wifi_sync_now)}"
                waitUntil("the status line to say why it waits") { statusLine(scenario) == waiting }
                val uid = checkNotNull(onEditor(scenario) { it.editorModel.noteUid }) { "the save made the note" }
                val entry = (store.read(uid) as PendingNotesStore.Read.Present).entry
                assertTrue("a new note, waiting: $entry",
                    entry.state == PendingEntry.State.UPSERT && entry.isCreate && entry.notebookUid == notebook)
                val item = decryptThroughStoredCopy(store, entry)
                assertEquals("made as Untitled, with the typed text", listOf("Untitled", "Written off Wi-Fi"),
                    listOf(NoteMetaCodec.peek(item.metaRaw)?.name, item.contentString))

                // The Save request, about ten seconds after the save, is automatic: off Wi-Fi it is refused and asks nothing.
                val beforeRequest = runs.size
                waitUntil("the Save request") { runs.size > beforeRequest }
                awaitSettled(identity)
                assertEquals("one automatic run", listOf(false), runs.since(beforeRequest))
                assertEquals("off Wi-Fi nothing was asked of the server", emptyList<String>(), fake.requests.drop(quiet))
                assertEquals("the note still waits as it was saved", entry, (store.read(uid) as PendingNotesStore.Read.Present).entry)

                // On Wi-Fi, the request the editor makes as it closes sends the note at once.
                pinNetwork(NotesNetworkPolicy.Connection.WIFI)
                val sending = fake.requests.size
                val beforeClose = runs.size
                scenario.onActivity { it.onSupportNavigateUp() }
                waitUntil("the closing editor's run") { runs.size > beforeClose }
                awaitSettled(identity)
                assertEquals("one automatic run", listOf(false), runs.since(beforeClose))
                assertEquals("one upload", listOf(transactionOf(notebook)), uploads(sending))
                assertEquals(setOf(uid), fake.itemUids(notebook))
                val onServer = itemManager(notebook).fetch(uid)
                assertEquals(listOf("Untitled", "Written off Wi-Fi"), listOf(NoteMetaCodec.peek(onServer.metaRaw)?.name, onServer.contentString))
                assertTrue("nothing is left waiting", pendingHeaders(account, "gen-new-note").isEmpty())
                waitUntil("the list to show the note as synced") {
                    noteList(scenario)?.renderedNotes?.map { Triple(it.uid, it.title, it.sync) } == listOf(Triple(uid, "Untitled", NoteSync.SYNCED))
                }
            }
            probe.assertNoneOnMain()
        } finally {
            probe.uninstall()
            runs.uninstall()
        }
    }

    /**
     * An edit in the editor on an older copy of a note, which another device changed first, becomes a conflicted copy, and
     * both reach the server. The text the editor saved then belongs to the copy (design 3.2): the editor keeps showing it,
     * and its next save goes into the copy, never into a second copy and never over the other device's version.
     */
    @Test fun anEditorSaveOnAnOlderCopyBecomesAConflictedCopyAndTheNextSaveGoesIntoTheCopy() {
        val account = newAccount("gen-editor-conflict")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-editor-conflict")
        // The editor's saves make this account's store; registered so the class's teardown clears it.
        pending(account, "gen-editor-conflict")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-editor-conflict")
        // Only the case's own manual runs send: automatic ones wait for Wi-Fi.
        pinNetwork(NotesNetworkPolicy.Connection.OTHER)
        val runs = Runs()
        val probe = MainThreadStoreProbe().apply { install() }
        val problems = ArrayList<String>()
        try {
            var closing = 0
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-editor-conflict")).use { scenario ->
                awaitSettled(identity)
                openEditor(scenario, "Work", note.uid)
                editOnAnotherDevice(notebook, note.uid, "Edited on the web")
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).setText("Edited on the phone") }
                val first = awaitSave(scenario, "the phone's edit to be saved")
                assertTrue("saved on this device: $first", first is SaveResult.Saved)

                val since = fake.requests.size
                syncNow(account, "gen-editor-conflict")
                assertEquals("the refused push, then the copy's upload", listOf(transactionOf(notebook), transactionOf(notebook)), uploads(since))
                val onServer = fake.itemUids(notebook)
                assertEquals("the server version stays, and the phone's text has a note of its own", 2, onServer.size)
                assertEquals("Edited on the web", itemManager(notebook).fetch(note.uid).contentString)
                val copyUid = (onServer - note.uid).single()
                val copy = itemManager(notebook).fetch(copyUid)
                assertEquals(listOf("Plan (conflicted copy)", "Edited on the phone"), listOf(copy.meta.name, copy.contentString))

                // The run's end loads the clean editor again, and its status line then reads the note it is on.
                waitUntil("the editor to settle after the run") { statusLine(scenario) == context.getString(R.string.notes_editor_synced) }
                val after = checkNotNull(onEditor(scenario) { Triple(it.editorModel.noteUid, it.editorModel.core.body, it.editing) })
                Log.i(EDITOR_LOG, "after the conflict run: editor note=${after.first} original=${note.uid} copy=$copyUid " +
                    "editing=${after.third} showsCopyText=${after.second == "Edited on the phone"} showsServerText=${after.second == "Edited on the web"}")
                assertTrue("the editor stays the editor", after.third)
                if (after.second != "Edited on the phone") {
                    problems += "after the run the editor shows the original's server text, not the text it saved, which is now the copy's " +
                        "(editor on ${after.first}, copy $copyUid)"
                }
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).append(" and more") }
                val next = awaitSave(scenario, "the next save", above = first.savedVersion)
                assertTrue("saved on this device: $next", next is SaveResult.Saved)
                Log.i(EDITOR_LOG, "the next save: editor note=${onEditor(scenario) { it.editorModel.noteUid }} original=${note.uid} copy=$copyUid")

                val sinceNext = fake.requests.size
                syncNow(account, "gen-editor-conflict")
                assertEquals("one plain upload", listOf(transactionOf(notebook)), uploads(sinceNext))
                assertEquals("no second copy", setOf(note.uid, copyUid), fake.itemUids(notebook))
                val copyNow = itemManager(notebook).fetch(copyUid).contentString
                val originalNow = itemManager(notebook).fetch(note.uid).contentString
                Log.i(EDITOR_LOG, "after the next run: copyChanged=${copyNow != "Edited on the phone"} originalChanged=${originalNow != "Edited on the web"}")
                if (copyNow != "Edited on the phone and more") problems += "the next save did not go into the copy: <$copyNow>"
                if (originalNow != "Edited on the web") problems += "the next save went into the original: <$originalNow>"
                assertTrue("nothing is left waiting", pendingHeaders(account, "gen-editor-conflict").isEmpty())
                closing = runs.size
            }
            awaitClosingRun(identity, runs, closing)
            assertTrue(problems.joinToString("\n"), problems.isEmpty())
            probe.assertNoneOnMain()
        } finally {
            probe.uninstall()
            runs.uninstall()
        }
    }

    /**
     * Access is lost while the editor is open: its notebook turns read-only on the server, and a run holds the text the
     * editor saved. The editor's next save then joins the held text ([SaveResult.SavedToHolding]), the screen gives way to
     * the viewer with Open Unsynced text, and the Unsynced text screen shows everything that was typed.
     */
    @Test fun accessLostWhileEditingTurnsTheNextSaveIntoHeldTextThatUnsyncedTextShows() {
        val account = newAccount("gen-editor-lost")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-editor-lost")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-editor-lost")
        val store = pending(account, "gen-editor-lost")
        // Only the case's own manual run sends: automatic ones wait for Wi-Fi.
        pinNetwork(NotesNetworkPolicy.Connection.OTHER)
        val runs = Runs()
        val probe = MainThreadStoreProbe().apply { install() }
        val arrived = CountDownLatch(1)
        val gate = CountDownLatch(1)
        try {
            var closing = 0
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-editor-lost")).use { scenario ->
                awaitSettled(identity)
                openEditor(scenario, "Work", note.uid)
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).setText("Typed before access changed") }
                val first = awaitSave(scenario, "the first save")
                assertTrue("saved on this device: $first", first is SaveResult.Saved)

                // The notebook turns read-only, and the editor's next save waits right before the store while a run holds
                // the text the first save wrote.
                fake.setAccessLevel(notebook, 0L)
                NoteEditorViewModel.beforeSaveForTesting = {
                    arrived.countDown()
                    gate.await(30, TimeUnit.SECONDS)
                }
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).append(", and typed after") }
                assertTrue("the next save started", arrived.await(30, TimeUnit.SECONDS))
                syncNow(account, "gen-editor-lost")
                val held = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
                assertEquals("the run held the saved text", PendingEntry.State.HELD to HeldReason.READ_ONLY, held.state to held.held?.reason)
                assertEquals("under the version the editor saved", first.savedVersion, held.version)

                gate.countDown()
                val joined = awaitSave(scenario, "the next save", above = first.savedVersion)
                assertTrue("it joined the held text: $joined", joined is SaveResult.SavedToHolding)
                val now = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
                assertEquals(PendingEntry.State.HELD to joined.savedVersion, now.state to now.version)
                assertEquals("Typed before access changed, and typed after", decryptThroughStoredCopy(store, now).contentString)

                // The screen gives way to the viewer, which says why and points to Unsynced text.
                waitUntil("the viewer") { onEditor(scenario) { !it.editing && it.renderedNote?.sync == NoteSync.HELD } == true }
                scenario.onActivity { activity ->
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.note_body_edit).visibility)
                    val banner = activity.findViewById<TextView>(R.id.note_banner)
                    assertEquals(View.VISIBLE, banner.visibility)
                    assertEquals(activity.getString(R.string.notes_read_only_banner), banner.text.toString())
                    val open = activity.findViewById<View>(R.id.note_open_unsynced)
                    assertEquals(View.VISIBLE, open.visibility)
                    open.performClick()
                }
                waitUntil("Unsynced text to show the typed text") {
                    heldText(scenario)?.renderedRows?.singleOrNull()?.body == "Typed before access changed, and typed after"
                }
                val row = heldText(scenario)!!.renderedRows!!.single()
                assertEquals(listOf(note.uid, now.version, HeldReason.READ_ONLY), listOf(row.noteUid, row.version, row.held))
                scenario.onActivity { activity ->
                    assertEquals("Typed before access changed, and typed after", activity.findViewById<TextView>(R.id.held_body).text.toString())
                }
                closing = runs.size
            }
            awaitClosingRun(identity, runs, closing)
            probe.assertNoneOnMain()
        } finally {
            gate.countDown()
            NoteEditorViewModel.beforeSaveForTesting = null
            probe.uninstall()
            runs.uninstall()
        }
    }

    /**
     * An editor save lands between showing a Discard on Unsynced text and confirming it. The editor's save is held right
     * before the store while a run holds its earlier text; the user then leaves the editor for Unsynced text in the same
     * screen, which shows that text and asks for the Discard. The save then lands in the held text with a new version and
     * a new blob. The confirmation, given for the older text, deletes nothing, and the screen shows the newer text; a
     * second Discard over it goes. The second round recreates the activity between showing the confirmation and the save.
     */
    @Test fun aSaveLandingBetweenShowingADiscardAndConfirmingItDeletesNothingAndTheNewerTextIsAskedAgain() {
        val account = newAccount("gen-editor-race")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-editor-race")
        val first = uploadNotebook("First")
        val second = uploadNotebook("Second")
        val inFirst = uploadNote(first, "Plan", "Server plan", mtime = 1_000L)
        val inSecond = uploadNote(second, "List", "Server list", mtime = 1_000L)
        syncNow(account, "gen-editor-race")
        val store = pending(account, "gen-editor-race")
        // Only the case's own manual runs send: automatic ones wait for Wi-Fi.
        pinNetwork(NotesNetworkPolicy.Connection.OTHER)
        val runs = Runs()
        val probe = MainThreadStoreProbe().apply { install() }
        var gate = CountDownLatch(0)
        fun race(recreate: Boolean, name: String, notebook: String, note: Item) {
            val arrived = CountDownLatch(1)
            val saveGate = CountDownLatch(1).also { gate = it }
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-editor-race")).use { scenario ->
                awaitSettled(identity)
                openEditor(scenario, name, note.uid)
                val editor = checkNotNull(onEditor(scenario) { it.editorModel })
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).setText("Typed before the hold") }
                val saved = awaitSave(scenario, "the first save")
                assertTrue("saved on this device: $saved", saved is SaveResult.Saved)
                // The notebook turns read-only, and the editor's next save waits right before the store.
                fake.setAccessLevel(notebook, 0L)
                NoteEditorViewModel.beforeSaveForTesting = {
                    arrived.countDown()
                    saveGate.await(30, TimeUnit.SECONDS)
                }
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).append(" and during the Discard") }
                assertTrue("the next save started", arrived.await(30, TimeUnit.SECONDS))
                syncNow(account, "gen-editor-race")
                val shown = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
                assertEquals("a run held the saved text", PendingEntry.State.HELD to saved.savedVersion, shown.state to shown.version)

                // The editor's screen goes while its save is still on its way, which goes on in a step that outlives the
                // screen. Back and Up would wait for that save first, so the screen is popped directly, as a leave the user
                // did not start. Unsynced text shows the held text, and Discard asks first.
                scenario.onActivity { it.supportFragmentManager.popBackStackImmediate() }
                waitUntil("the note list") { noteList(scenario) != null }
                scenario.onActivity { it.onSupportNavigateUp() }
                waitUntil("the Unsynced text row to show") { notebookList(scenario)?.renderedUnsyncedText == 1 }
                scenario.onActivity { it.findViewById<View>(R.id.notebooks_unsynced).performClick() }
                waitUntil("the held text to show") { heldText(scenario)?.renderedRows?.singleOrNull()?.version == shown.version }
                assertEquals("Typed before the hold", heldText(scenario)!!.renderedRows!!.single().body)
                scenario.onActivity { it.findViewById<View>(R.id.held_discard).performClick() }
                waitUntil("the confirmation to show") { heldText(scenario)?.discardDialog?.isShowing == true }
                if (recreate) {
                    scenario.recreate()
                    waitUntil("the confirmation to come back") { heldText(scenario)?.discardDialog?.isShowing == true }
                }
                assertEquals("nothing deleted before the answer", shown, (store.read(note.uid) as PendingNotesStore.Read.Present).entry)

                // The editor's save lands while the confirmation shows: held text under a new version, with a new blob.
                val runsBefore = runs.size
                saveGate.countDown()
                waitUntil("the editor's save to land") {
                    ((store.read(note.uid) as? PendingNotesStore.Read.Present)?.entry?.version ?: 0L) > shown.version
                }
                var joined: SaveResult? = null
                waitUntil("the editor to take the save's answer") {
                    scenario.onActivity { joined = editor.core.lastResult }
                    joined is SaveResult.SavedToHolding
                }
                NoteEditorViewModel.beforeSaveForTesting = null
                val newer = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
                assertTrue("held, under a new version: $newer", newer.state == PendingEntry.State.HELD && newer.version == joined?.savedVersion)
                assertFalse("a new blob", PendingNotesStore.digestOf(newer.blob) == PendingNotesStore.digestOf(shown.blob))
                assertEquals("Typed before the hold and during the Discard", decryptThroughStoredCopy(store, newer).contentString)
                // The closed editor then asks for its one run, which is automatic and waits for Wi-Fi.
                waitUntil("the closed editor's run") { runs.size > runsBefore }
                awaitSettled(identity)

                // Confirmed for the older text, the Discard deletes nothing, and the screen shows the newer text.
                val rowsBefore = heldText(scenario)?.renderedRows
                scenario.onActivity { held(it).discardDialog!!.getButton(DialogInterface.BUTTON_POSITIVE).performClick() }
                waitUntil("the Discard to answer") {
                    val rows = heldText(scenario)?.renderedRows
                    rows !== rowsBefore && (store.read(note.uid) == PendingNotesStore.Read.Missing || rows?.any { it.version == newer.version } == true)
                }
                assertEquals("the confirmed Discard deleted nothing", newer, (store.read(note.uid) as? PendingNotesStore.Read.Present)?.entry)
                waitUntil("the newer text to show") {
                    heldText(scenario)?.renderedRows?.singleOrNull()?.body == "Typed before the hold and during the Discard"
                }

                // Asked again over the newer text, it goes.
                scenario.onActivity { it.findViewById<View>(R.id.held_discard).performClick() }
                waitUntil("the confirmation to show again") { heldText(scenario)?.discardDialog?.isShowing == true }
                scenario.onActivity { held(it).discardDialog!!.getButton(DialogInterface.BUTTON_POSITIVE).performClick() }
                waitUntil("the held text to go") { heldText(scenario)?.renderedRows?.isEmpty() == true }
                assertEquals(PendingNotesStore.Read.Missing, store.read(note.uid))
            }
        }
        try {
            race(recreate = false, "First", first, inFirst)
            race(recreate = true, "Second", second, inSecond)
            probe.assertNoneOnMain()
        } finally {
            gate.countDown()
            NoteEditorViewModel.beforeSaveForTesting = null
            probe.uninstall()
            runs.uninstall()
        }
    }

    /**
     * Back and Up while the editor's text is not saved on this device. The store's write of the note fails (no space), so
     * the save that each leave runs first fails too, and the screen stays and asks. Copy hands the text to the clipboard,
     * marked sensitive, and the question stays; a recreation brings it back; an answer from a question made in another app
     * process acts on nothing, and the screen asks again in this one, as it does when such a question is brought back.
     * Cancel stays, the toolbar's Up arrow asks again, and Try again while the write still fails asks again. Once the store
     * writes again, Try again saves the text and the screen leaves. In a second round, Leave anyway leaves, and the closing
     * editor's last try keeps the text once the store writes again: the question says the text may not be kept, never that
     * it is lost. In a third round, the question over a new note whose first write failed speaks of the new note.
     */
    @Test fun leavingWithTextNotSavedOnTheDeviceSavesFirstAndAsksBeforeLeavingWithoutIt() {
        val account = newAccount("gen-editor-leave")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-editor-leave")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-editor-leave")
        val store = pending(account, "gen-editor-leave")
        // Automatic runs wait for Wi-Fi, so the saved text stays in the store for the case to read.
        pinNetwork(NotesNetworkPolicy.Connection.OTHER)
        val runs = Runs()
        val probe = MainThreadStoreProbe().apply { install() }
        val failing = AtomicBoolean(false)
        val failed = AtomicInteger()
        // The write of a note's entry is cut short, as when the device runs out of space: the store's recovery deletes
        // the partial file, so nothing of that save is kept. (An intact file left by a failed rename would be committed.)
        // The case edits one note at a time, so it fails the write of the note it edits.
        probe.write = { file ->
            if (failing.get() && file.name.endsWith(".note")) {
                failed.incrementAndGet()
                File(file.parentFile, file.name + ".new").writeBytes(ByteArray(3))
                throw IOException("no space left on device")
            }
        }
        val copiedClip = AtomicReference<android.content.ClipData?>()
        io.silentsuite.sync.ui.notes.SensitiveClip.clipboardOverride = { copiedClip.set(it) }
        val typed = "Typed while the device cannot save"
        fun question(scenario: ActivityScenario<NotesActivity>): androidx.appcompat.app.AlertDialog? =
            onEditor(scenario) { it.leaveDialog?.takeIf { dialog -> dialog.isShowing } }
        fun askedIn(scenario: ActivityScenario<NotesActivity>): String? =
            onEditor(scenario) { editor -> editor.leaveDialog?.takeIf { it.isShowing }?.let {
                editor.leaveConfirmation!!.requireArguments().getString(NoteViewFragment.ARG_PROCESS) } }
        fun stays(scenario: ActivityScenario<NotesActivity>, what: String) {
            assertEquals("$what: the editor stays", true, onEditor(scenario) { it.editing })
            assertEquals("$what: the text stays", typed, onEditor(scenario) { it.editorModel.core.body })
            assertEquals("$what: nothing was written", PendingNotesStore.Read.Missing, store.read(note.uid))
        }
        try {
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-editor-leave")).use { scenario ->
                awaitSettled(identity)
                openEditor(scenario, "Work", note.uid)
                failing.set(true)
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).setText(typed) }
                waitUntil("the autosave to fail") { onEditor(scenario) { it.editorModel.core.lastResult } == SaveResult.NotSaved }

                // Back: the save runs first and fails, and the screen stays and asks.
                var before = failed.get()
                scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                waitUntil("the question") { question(scenario) != null }
                assertTrue("Back saved first", failed.get() > before)
                stays(scenario, "Back")
                scenario.onActivity { activity ->
                    val dialog = editorOf(activity).leaveDialog!!
                    assertEquals("Leave this note?", dialog.findViewById<TextView>(androidx.appcompat.R.id.alertTitle)!!.text.toString())
                    assertEquals("Your changes are not saved on this device. The last save did not work. If you leave now, they may " +
                        "not be kept. Copy them to keep them.", dialog.findViewById<TextView>(android.R.id.message)!!.text.toString())
                    assertEquals(listOf("Try again", "Copy", "Leave anyway"),
                        listOf(DialogInterface.BUTTON_POSITIVE, DialogInterface.BUTTON_NEUTRAL, DialogInterface.BUTTON_NEGATIVE).map { dialog.getButton(it).text.toString() })
                }

                // Copy: the title and the text, marked sensitive, and the question stays.
                scenario.onActivity { editorOf(it).leaveDialog!!.getButton(DialogInterface.BUTTON_NEUTRAL).performClick() }
                val copied = checkNotNull(copiedClip.get()) { "the text was copied" }
                assertEquals("Plan\n\n$typed", copied.getItemAt(0).text.toString())
                assertTrue("the clip is marked sensitive",
                    copied.description.extras?.getBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE) == true)
                assertNotNull("the question stays after Copy", question(scenario))

                // A recreation brings the question back, made in this process, over the same text.
                scenario.recreate()
                waitUntil("the question to come back") { question(scenario) != null }
                assertEquals(ProcessIncarnation.current(), askedIn(scenario))
                scenario.onActivity { assertEquals(typed, it.findViewById<EditText>(R.id.note_body_edit).text.toString()) }
                stays(scenario, "the recreation")

                // Leave anyway from a question made in another app process acts on nothing: the screen saves
                // again, and asks again in this process.
                before = failed.get()
                scenario.onActivity { activity ->
                    val editor = editorOf(activity)
                    editor.leaveConfirmation!!.requireArguments().putString(NoteViewFragment.ARG_PROCESS, "another-app-process")
                    editor.leaveDialog!!.getButton(DialogInterface.BUTTON_NEGATIVE).performClick()
                }
                waitUntil("asked again in this process") { askedIn(scenario) == ProcessIncarnation.current() }
                assertTrue("it saved again first", failed.get() > before)
                stays(scenario, "an answer from another process")

                // Brought back from another app process, the question goes, and the screen asks again in this one.
                scenario.onActivity { editorOf(it).leaveConfirmation!!.requireArguments().putString(NoteViewFragment.ARG_PROCESS, "another-app-process") }
                scenario.recreate()
                waitUntil("asked again after the recreation") { askedIn(scenario) == ProcessIncarnation.current() }
                stays(scenario, "a question from another process")

                // Cancel stays and asks nothing more; the toolbar's Up arrow saves first and asks again.
                scenario.onActivity { editorOf(it).leaveDialog!!.cancel() }
                waitUntil("the question to go") { question(scenario) == null }
                stays(scenario, "Cancel")
                before = failed.get()
                scenario.onActivity { upArrow(it).performClick() }
                waitUntil("the question after Up") { question(scenario) != null }
                assertTrue("Up saved first", failed.get() > before)
                stays(scenario, "Up")

                // Try again while the write still fails: asked again.
                before = failed.get()
                scenario.onActivity { editorOf(it).leaveDialog!!.getButton(DialogInterface.BUTTON_POSITIVE).performClick() }
                waitUntil("asked again after Try again") { failed.get() > before && question(scenario) != null }
                stays(scenario, "Try again")

                // The store writes again: Try again saves the text, and the screen leaves.
                failing.set(false)
                val closingFirst = runs.size
                scenario.onActivity { editorOf(it).leaveDialog!!.getButton(DialogInterface.BUTTON_POSITIVE).performClick() }
                waitUntil("the note list") { noteList(scenario) != null }
                val saved = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
                assertEquals(typed, decryptThroughStoredCopy(store, saved).contentString)
                awaitClosingRun(identity, runs, closingFirst)

                // Round two: a save that works, then one that fails, and Leave anyway.
                showNote(scenario, note.uid)
                waitUntil("the editor to show again") { onEditor(scenario) { it.editing } == true }
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).setText("Saved before the write failed") }
                val kept = awaitSave(scenario, "the first save of round two", above = saved.version)
                assertTrue("saved on this device: $kept", kept is SaveResult.Saved)
                failing.set(true)
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).append(", and typed after") }
                waitUntil("the next save to fail") { onEditor(scenario) { it.editorModel.core.lastResult } == SaveResult.NotSaved }
                scenario.onActivity { it.onSupportNavigateUp() }
                waitUntil("the question in round two") { question(scenario) != null }
                // The store writes again from here: leaving still saves once more, so the text is kept.
                failing.set(false)
                val closingSecond = runs.size
                scenario.onActivity { editorOf(it).leaveDialog!!.getButton(DialogInterface.BUTTON_NEGATIVE).performClick() }
                waitUntil("the note list after Leave anyway") { noteList(scenario) != null }
                awaitClosingRun(identity, runs, closingSecond)
                val after = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
                assertTrue("the closing editor saved once more", after.version > kept.savedVersion)
                assertEquals("Saved before the write failed, and typed after", decryptThroughStoredCopy(store, after).contentString)

                // Round three: a new note whose first write fails. That save gave it a uid, yet the question says the new
                // note is not saved; once the store writes again, Try again saves it and the screen leaves.
                failing.set(true)
                scenario.onActivity { it.findViewById<View>(R.id.notes_new_note).performClick() }
                waitUntil("the new note's editor") { onEditor(scenario) { it.editing && it.editorModel.noteUid == null } == true }
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).setText("A new note the device could not save") }
                waitUntil("its first save to fail") { onEditor(scenario) { it.editorModel.core.lastResult } == SaveResult.NotSaved }
                val newUid = checkNotNull(onEditor(scenario) { it.editorModel.noteUid }) { "the failed first save named the note" }
                scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                waitUntil("the question for the new note") { question(scenario) != null }
                scenario.onActivity { activity ->
                    assertEquals("This new note is not saved on this device. The last save did not work. If you leave now, it may " +
                        "not be kept. Copy it to keep it.", editorOf(activity).leaveDialog!!.findViewById<TextView>(android.R.id.message)!!.text.toString())
                }
                failing.set(false)
                val closingThird = runs.size
                scenario.onActivity { editorOf(it).leaveDialog!!.getButton(DialogInterface.BUTTON_POSITIVE).performClick() }
                waitUntil("the note list after the new note saved") { noteList(scenario) != null }
                val made = (store.read(newUid) as PendingNotesStore.Read.Present).entry
                assertEquals("A new note the device could not save", decryptThroughStoredCopy(store, made).contentString)
                awaitClosingRun(identity, runs, closingThird)
            }
            probe.assertNoneOnMain()
        } finally {
            io.silentsuite.sync.ui.notes.SensitiveClip.clipboardOverride = null
            probe.uninstall()
            runs.uninstall()
        }
    }

    /**
     * No editor and no New note while a whole-store discard is unfinished: after a restart, the permit of a discard that
     * stopped still names a file that is there, so any save would release the text it covers. The note list says why,
     * the confirmed text stays held, and a real run sends none of it. On another account, no editor over text that cannot
     * be decrypted, and none while the local changes cannot be read, when the note list offers no New note either.
     */
    @Test fun noEditorAndNoNewNoteWhileADiscardIsUnfinishedOrTheLocalTextCannotBeRead() {
        val account = newAccount("gen-gate")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-gate")
        val notebook = uploadNotebook("Work")
        val confirmed = uploadNote(notebook, "Plan", "Server plan", mtime = 1_000L)
        val untouched = uploadNote(notebook, "List", "Server list", mtime = 1_500L)
        syncNow(account, "gen-gate")
        editLocally(account, "gen-gate", notebook, confirmed.uid, "Plan", "Confirmed for the discard", mtime = 2_000L)
        val stopped = pending(account, "gen-gate")
        PendingNotesStore.beforeClearForTesting = { throw IOException("the discard stops here") }
        try {
            assertEquals(PendingNotesStore.DiscardOutcome.NotFinished, stopped.discardStore(stopped.unsynced()))
        } finally {
            PendingNotesStore.beforeClearForTesting = null
        }
        // A restart: a new instance, and the stopped discard's permit still names the confirmed text, which is there.
        PendingNotesStore.resetForTesting()
        val store = pending(account, "gen-gate")
        assertTrue("the permit names a file that is there", store.observe(untouched.uid).discardUnfinished)
        val heldFiles = filesOnDisk(store).filterKeys { it.endsWith(".note") }
        assertEquals(setOf("${confirmed.uid}.note"), heldFiles.keys)
        val why = context.getString(R.string.notes_discard_unfinished_editing)
        val probe = MainThreadStoreProbe().apply { install() }
        try {
            val since = fake.requests.size
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-gate")).use { scenario ->
                // The run opening the screen asks for is real, on Wi-Fi: it sends nothing the permit names.
                awaitSettled(identity)
                assertEquals("nothing was uploaded", emptyList<String>(), uploads(since))
                showNotebook(scenario, "Work")
                waitUntil("both notes to show") { noteList(scenario)?.renderedNotes?.size == 2 }
                assertFalse("no New note", noteList(scenario)!!.offersNewNote)
                assertEquals("the confirmed text shows as held", NoteSync.HELD,
                    noteList(scenario)!!.renderedNotes.single { it.uid == confirmed.uid }.sync)
                scenario.onActivity { activity ->
                    val banner = activity.findViewById<TextView>(R.id.note_list_read_only)
                    assertEquals(View.VISIBLE, banner.visibility)
                    assertEquals(why, banner.text.toString())
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.notes_new_note).visibility)
                }
                // Neither note opens in the editor, the one without a change of its own included.
                for (note in listOf(confirmed, untouched)) {
                    showNote(scenario, note.uid)
                    waitUntil("the viewer") { onEditor(scenario) { !it.editing && it.renderedNote != null } == true }
                    scenario.onActivity { activity ->
                        assertEquals(View.GONE, activity.findViewById<View>(R.id.note_body_edit).visibility)
                        val banner = activity.findViewById<TextView>(R.id.note_banner)
                        assertEquals(View.VISIBLE, banner.visibility)
                        assertEquals(why, banner.text.toString())
                        activity.onSupportNavigateUp()
                    }
                }
            }
            assertSameFiles("the confirmed text stays held", heldFiles, filesOnDisk(store).filterKeys { it.endsWith(".note") })
            assertTrue("and the discard is still unfinished", store.observe(confirmed.uid).let { it.discardUnfinished && it.discardConfirmed })

            // Another account: text that cannot be decrypted, and local changes that cannot be read.
            val other = newAccount("gen-gate-read")
            val otherIdentity = ExactAccountIdentity(other.type, other.name, "gen-gate-read")
            val home = uploadNotebook("Home")
            val garbled = uploadNote(home, "Garbled", "Server garbled", mtime = 1_000L)
            val plain = uploadNote(home, "Plain", "Server plain", mtime = 1_500L)
            syncNow(other, "gen-gate-read")
            val otherStore = pending(other, "gen-gate-read")
            // A change whose blob is not an item of the notebook, so its text cannot be decrypted here.
            assertTrue(otherStore.saveLocal(garbled.uid, home, "r1", byteArrayOf(1, 2, 3), isCreate = false) is PendingNotesStore.SaveOutcome.Saved)
            assertTrue("the store's counter is there", File(otherStore.dir, "sequence").isFile)
            val before = filesOnDisk(otherStore).filterKeys { it.endsWith(".note") }
            // No run while the screens show: it would hold the change it cannot build.
            val runs = Runs(real = false)
            try {
                ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, other, "gen-gate-read")).use { scenario ->
                    awaitSettled(otherIdentity)
                    showNotebook(scenario, "Home")
                    waitUntil("both notes to show") { noteList(scenario)?.renderedNotes?.size == 2 }
                    assertEquals(NoteSync.LOCAL_UNREADABLE, noteList(scenario)!!.renderedNotes.single { it.uid == garbled.uid }.sync)
                    showNote(scenario, garbled.uid)
                    waitUntil("the viewer") { onEditor(scenario) { !it.editing && it.renderedNote != null } == true }
                    assertEquals(NoteSync.LOCAL_UNREADABLE, onEditor(scenario) { it.renderedNote?.sync })
                    // The local changes cannot be read from here on: the store's listing fails, and so does its read of the counter.
                    val dir = otherStore.dir.canonicalPath
                    probe.listing = { d -> if (d.canonicalPath == dir) null else d.listFiles() }
                    probe.read = { f -> if (f.name == "sequence" && f.parentFile?.canonicalPath == dir) throw IOException("the read fails here") }
                    scenario.onActivity { activity ->
                        assertEquals(View.GONE, activity.findViewById<View>(R.id.note_body_edit).visibility)
                        activity.onSupportNavigateUp()
                    }
                    waitUntil("the list to say the changes could not be read") {
                        var said = false
                        scenario.onActivity { activity ->
                            val notice = activity.findViewById<TextView?>(R.id.notes_pending)
                            said = notice?.visibility == View.VISIBLE && notice.text.toString() == activity.getString(R.string.notes_pending_unreadable)
                        }
                        said
                    }
                    assertFalse("no New note", noteList(scenario)!!.offersNewNote)
                    scenario.onActivity { assertEquals(View.GONE, it.findViewById<View>(R.id.notes_new_note).visibility) }
                    showNote(scenario, plain.uid)
                    waitUntil("the viewer") { onEditor(scenario) { !it.editing && it.renderedNote != null } == true }
                    assertEquals(PendingUnavailable.UNREADABLE, onEditor(scenario) { it.renderedNote?.pending })
                    scenario.onActivity { assertEquals(View.GONE, it.findViewById<View>(R.id.note_body_edit).visibility) }
                    probe.listing = null
                    probe.read = null
                }
            } finally {
                runs.uninstall()
            }
            assertSameFiles("the change that cannot be decrypted stays as it was", before, filesOnDisk(otherStore).filterKeys { it.endsWith(".note") })
            probe.assertNoneOnMain()
        } finally {
            probe.uninstall()
        }
    }

    /**
     * Sign-out with the editor open. A save that lands while the sign-out counts again, before it cancels anything, is
     * counted, and the confirmation does not cover it; a save that lands between that count and the clear makes the clear,
     * under the lock every save takes, answer Changed. Both times the sign-out is refused and nothing goes: the account
     * stays, the typed text stays on screen and in the store, and the editor goes on saving.
     */
    @Test fun signOutWithAnOpenEditorRefusesWhenASaveLandsDuringItsCountAndTheTypedTextStays() {
        val account = newAccount("gen-editor-out")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-editor-out")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-editor-out")
        val store = pending(account, "gen-editor-out")
        // No run sends the change while the case signs out.
        val runs = Runs(real = false)
        val probe = MainThreadStoreProbe().apply { install() }
        try {
            var closing = 0
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-editor-out")).use { scenario ->
                awaitSettled(identity)
                openEditor(scenario, "Work", note.uid)
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).setText("Typed before sign-out") }
                var version = awaitSave(scenario, "the first save").savedVersion
                fun typeAndAwaitSave(text: String) {
                    scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).append(text) }
                    val saved = awaitSave(scenario, "the save of \"$text\"", above = version)
                    assertTrue("saved on this device: $saved", saved is SaveResult.Saved)
                    version = saved.savedVersion
                }
                fun signOutWith(wrap: (CurrentAccountSignOutCoordinator.Seams) -> CurrentAccountSignOutCoordinator.Seams): CurrentAccountSignOutState {
                    val coordinator = CurrentAccountSignOutCoordinator(wrap(AndroidCurrentAccountSignOut(context, account, "gen-editor-out")))
                    try {
                        val shown = coordinator.unsyncedNotes(identity)
                        assertEquals("the dialog counts one change", 1, shown.count)
                        coordinator.confirmNotesDiscard(identity, shown)
                        coordinator.begin()
                        return coordinator.state
                    } finally {
                        coordinator.close()
                    }
                }
                fun assertNothingWent(what: String) {
                    assertTrue("$what: the account stays", account in manager.getAccountsByType(account.type))
                    val (editing, body) = checkNotNull(onEditor(scenario) { it.editing to it.view?.findViewById<EditText>(R.id.note_body_edit)?.text?.toString() })
                    assertTrue("$what: the editor stays", editing)
                    val entry = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
                    assertEquals("$what: the text on screen is the text saved", body, decryptThroughStoredCopy(store, entry).contentString)
                }

                // 1. The editor saves while the sign-out counts again: the count sees the save, and the sign-out is refused.
                var counts = 0
                val counted = signOutWith { real ->
                    object : CurrentAccountSignOutCoordinator.Seams by real {
                        override fun unsyncedNotes(main: ExactAccountIdentity): UnsyncedNotes {
                            if (++counts == 2) typeAndAwaitSave(" one")
                            return real.unsyncedNotes(main)
                        }
                    }
                }
                assertEquals("the dialog's count, then the sign-out's own", 2, counts)
                assertEquals(CurrentAccountSignOutState.Refused, counted)
                assertNothingWent("a save during the count")

                // 2. The editor saves between that count and the clear: the clear answers Changed and deletes nothing.
                var clear: PendingNotesStore.DiscardOutcome? = null
                val changed = signOutWith { real ->
                    object : CurrentAccountSignOutCoordinator.Seams by real {
                        override fun discardPendingNotes(main: ExactAccountIdentity, confirmed: UnsyncedNotes?): PendingNotesStore.DiscardOutcome {
                            typeAndAwaitSave(" two")
                            return real.discardPendingNotes(main, confirmed).also { clear = it }
                        }
                    }
                }
                assertTrue("the clear answered Changed: $clear", clear is PendingNotesStore.DiscardOutcome.Changed)
                assertEquals(CurrentAccountSignOutState.Refused, changed)
                assertNothingWent("a save before the clear")
                assertEquals("Typed before sign-out one two",
                    onEditor(scenario) { it.view?.findViewById<EditText>(R.id.note_body_edit)?.text?.toString() })
                typeAndAwaitSave(" three")
                closing = runs.size
            }
            awaitClosingRun(identity, runs, closing)
            probe.assertNoneOnMain()
        } finally {
            probe.uninstall()
            runs.uninstall()
        }
    }

    /**
     * A save during a run queues one automatic follow-up run. The run is held at its fetch of the notebook's notes, after
     * its push step found nothing to send; the editor saves, and its Save request arrives while the run waits. Once the
     * run ends, one automatic run follows and sends the saved text.
     */
    @Test fun aSaveDuringARunQueuesOneAutomaticFollowUpRunThatSendsIt() {
        val account = newAccount("gen-editor-follow")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-editor-follow")
        // The editor's saves make this account's store; registered so the class's teardown clears it.
        pending(account, "gen-editor-follow")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "First draft", mtime = 1_000L)
        syncNow(account, "gen-editor-follow")
        val runs = Runs()
        val probe = MainThreadStoreProbe().apply { install() }
        try {
            var closing = 0
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-editor-follow")).use { scenario ->
                awaitSettled(identity)
                openEditor(scenario, "Work", note.uid)
                val before = runs.size
                val since = fake.requests.size
                // The notebook's notes changed on the server, so the run fetches them (an unchanged notebook is skipped).
                fake.touchItems(notebook)
                val fetch = fake.hold("GET", Regex("collection/$notebook/item/"))
                startManualRun(account, "gen-editor-follow")
                fetch.awaitArrival()
                val heldAt = SystemClock.uptimeMillis()
                assertEquals("the run sent nothing before its fetch", emptyList<String>(), uploads(since))
                scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).setText("Typed during the run") }
                val saved = awaitSave(scenario, "the save during the run")
                assertTrue("saved on this device: $saved", saved is SaveResult.Saved)
                // The Save request, about ten seconds after the save, arrives while the run still waits.
                waitUntil("a follow-up run to be queued") { NotesSyncCoordinator.snapshotForTesting(identity).contains("rerun=true") }
                val slot = NotesSyncCoordinator.snapshotForTesting(identity)
                assertTrue("an automatic follow-up behind the running run: $slot", slot.contains("state=RUNNING") && slot.contains("manual=false"))
                release(fetch, heldAt)
                awaitSettled(identity)
                assertEquals("the held manual run, then one automatic follow-up", listOf(true, false), runs.since(before))
                assertEquals("the follow-up sent the saved text", listOf(transactionOf(notebook)), uploads(since))
                assertEquals("Typed during the run", itemManager(notebook).fetch(note.uid).contentString)
                assertTrue("nothing is left waiting", pendingHeaders(account, "gen-editor-follow").isEmpty())
                waitUntil("the status line to say synced") { statusLine(scenario) == context.getString(R.string.notes_editor_synced) }
                closing = runs.size
            }
            awaitClosingRun(identity, runs, closing)
            probe.assertNoneOnMain()
        } finally {
            probe.uninstall()
            runs.uninstall()
        }
    }

    /**
     * Undo after a select-all delete: the deletion is saved within the autosave delay, Undo from the toolbar brings the
     * text back, the next autosave writes it, and the pending entry holds the restored text.
     */
    @Test fun undoAfterASelectAllDeleteBringsTheTextBackAndTheNextAutosaveWritesIt() {
        val account = newAccount("gen-editor-undo")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-editor-undo")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "Text the user meant to keep", mtime = 1_000L)
        syncNow(account, "gen-editor-undo")
        val store = pending(account, "gen-editor-undo")
        // No run: the pending entry stays what the editor wrote.
        val runs = Runs(real = false)
        val probe = MainThreadStoreProbe().apply { install() }
        fun menuItemEnabled(scenario: ActivityScenario<NotesActivity>, id: Int): Boolean {
            var enabled = false
            scenario.onActivity { enabled = actionBar(it).menu.findItem(id)?.isEnabled == true }
            return enabled
        }
        try {
            var closing = 0
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-editor-undo")).use { scenario ->
                awaitSettled(identity)
                openEditor(scenario, "Work", note.uid)
                // Select all and delete in the body: one edit of the field's text, as the keyboard makes it.
                scenario.onActivity { activity ->
                    val body = activity.findViewById<EditText>(R.id.note_body_edit)
                    assertEquals("Text the user meant to keep", body.text.toString())
                    body.requestFocus()
                    body.selectAll()
                    body.text.delete(body.selectionStart, body.selectionEnd)
                    assertEquals("", body.text.toString())
                }
                val deleted = awaitSave(scenario, "the deletion to be saved")
                assertTrue("saved on this device: $deleted", deleted is SaveResult.Saved)
                assertEquals("the deletion was written", "",
                    decryptThroughStoredCopy(store, (store.read(note.uid) as PendingNotesStore.Read.Present).entry).contentString)

                // Undo, from the toolbar.
                waitUntil("Undo to be offered") { menuItemEnabled(scenario, R.id.note_undo) }
                scenario.onActivity { activity ->
                    assertTrue("Undo ran", actionBar(activity).menu.performIdentifierAction(R.id.note_undo, 0))
                    assertEquals("the text is back", "Text the user meant to keep",
                        activity.findViewById<EditText>(R.id.note_body_edit).text.toString())
                }
                val restored = awaitSave(scenario, "the restored text to be saved", above = deleted.savedVersion)
                assertTrue("saved on this device: $restored", restored is SaveResult.Saved)
                val entry = (store.read(note.uid) as PendingNotesStore.Read.Present).entry
                assertEquals(restored.savedVersion, entry.version)
                val item = decryptThroughStoredCopy(store, entry)
                assertEquals("the pending entry holds the restored text", listOf("Plan", "Text the user meant to keep"),
                    listOf(NoteMetaCodec.peek(item.metaRaw)?.name, item.contentString))
                // Redo is offered now, and Undo has nothing left to undo.
                waitUntil("Redo to be offered") { menuItemEnabled(scenario, R.id.note_redo) }
                assertFalse("nothing left to undo", menuItemEnabled(scenario, R.id.note_undo))
                closing = runs.size
            }
            awaitClosingRun(identity, runs, closing)
            probe.assertNoneOnMain()
        } finally {
            probe.uninstall()
            runs.uninstall()
        }
    }

    /**
     * Hand run 4c through the editor: another client wrote fields of its own on a note (the web's description and color,
     * and a key no client here knows). The editor saves on the current revision, and after a plain push, with no 409, the
     * server's copy keeps those fields byte for byte; only the name, the time and the text change.
     */
    @Test fun anEditorSaveKeepsOtherClientsMetadataByteForByteThroughAPlainPush() {
        val account = newAccount("gen-editor-meta")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-editor-meta")
        // The editor's saves make this account's store; registered so the class's teardown clears it.
        pending(account, "gen-editor-meta")
        val notebook = uploadNotebook("Work")
        val others = linkedMapOf<String, Any?>("description" to "Written on the web", "color" to "#3366ff", "x-handrun" to "kept as it is")
        val written = linkedMapOf<String, Any?>("name" to "Plan", "mtime" to 1_000L).apply { putAll(others) }
        val note = uploadRawNote(notebook, TestMsgPack.encode(written), "Server text")
        syncNow(account, "gen-editor-meta")
        // Only the case's own manual run sends: automatic ones wait for Wi-Fi.
        pinNetwork(NotesNetworkPolicy.Connection.OTHER)
        val runs = Runs()
        val probe = MainThreadStoreProbe().apply { install() }
        try {
            var closing = 0
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-editor-meta")).use { scenario ->
                awaitSettled(identity)
                openEditor(scenario, "Work", note.uid)
                scenario.onActivity { activity ->
                    val title = activity.findViewById<EditText>(R.id.note_title_edit)
                    assertEquals("Plan", title.text.toString())
                    title.setText("Plan v2")
                    activity.findViewById<EditText>(R.id.note_body_edit).setText("Edited in the editor")
                }
                val saved = awaitSave(scenario, "the save")
                assertEquals("merged into the metadata, not kept as it was", SaveResult.Saved(saved.savedVersion, metadataKept = false), saved)

                val since = fake.requests.size
                syncNow(account, "gen-editor-meta")
                assertEquals("one plain push", listOf(transactionOf(notebook)), uploads(since))
                assertTrue("no 409: the server's copy was never fetched",
                    fake.requests.drop(since).none { it.substringBefore('?') == "GET collection/$notebook/item/${note.uid}/" })
                assertEquals("no conflicted copy", setOf(note.uid), fake.itemUids(notebook))
                assertSucceeded(status(account, "gen-editor-meta"))
                val onServer = itemManager(notebook).fetch(note.uid)
                assertEquals("Edited in the editor", onServer.contentString)
                @Suppress("UNCHECKED_CAST")
                val meta = TestMsgPack.decode(onServer.metaRaw) as Map<String, Any?>
                assertEquals("the same fields, in the same order", written.keys.toList(), meta.keys.toList())
                assertEquals("Plan v2", meta["name"])
                assertTrue("a new time: ${meta["mtime"]}", (meta["mtime"] as Number).toLong() > 1_000L)
                for ((key, value) in others) {
                    assertEquals(key, value, meta[key])
                    assertTrue("$key, byte for byte", onServer.metaRaw.holds(TestMsgPack.encode(key) + TestMsgPack.encode(value)))
                }
                closing = runs.size
            }
            awaitClosingRun(identity, runs, closing)
            probe.assertNoneOnMain()
        } finally {
            probe.uninstall()
            runs.uninstall()
        }
    }

    /**
     * The editor at font scale 2, set inside the app as the setup screen's case does: the title, the body, the status
     * line, Undo and Redo stay reachable (Undo and Redo may go to the overflow), each has its label (the fields' hints
     * and the items' titles), and the order is the title, the body, then the status line.
     */
    @Test fun theEditorAtFontScaleTwoKeepsItsFieldsStatusAndUndoRedoReachableAndLabeled() {
        val account = newAccount("gen-editor-font")
        val identity = ExactAccountIdentity(account.type, account.name, "gen-editor-font")
        // The editor's saves make this account's store; registered so the class's teardown clears it.
        pending(account, "gen-editor-font")
        val notebook = uploadNotebook("Work")
        val note = uploadNote(notebook, "Plan", "Body of the plan", mtime = 1_000L)
        syncNow(account, "gen-editor-font")
        // Off Wi-Fi, so the status line takes its longest form; no run sends anything.
        pinNetwork(NotesNetworkPolicy.Connection.OTHER)
        val runs = Runs(real = false)
        val probe = MainThreadStoreProbe().apply { install() }
        try {
            var closing = 0
            ActivityScenario.launch<NotesActivity>(NotesActivity.newIntent(context, account, "gen-editor-font")).use { scenario ->
                awaitSettled(identity)
                openEditor(scenario, "Work", note.uid)
                val unscaled = checkNotNull(onEditor(scenario) { fragment ->
                    listOf(R.id.note_title_edit, R.id.note_body_edit).map { fragment.requireView().findViewById<TextView>(it).textSize }
                })
                scenario.onActivity { it.onSupportNavigateUp() }
                // Font scale 2, set inside the app: the activity's resources take it, so the editor made from here on uses
                // it. The device's own font setting stays as it is.
                var original: Configuration? = null
                scenario.onActivity { activity ->
                    val current = Configuration(activity.resources.configuration).also { original = it }
                    @Suppress("DEPRECATION")
                    activity.resources.updateConfiguration(Configuration(current).apply { fontScale = 2f }, activity.resources.displayMetrics)
                }
                try {
                    showNote(scenario, note.uid)
                    waitUntil("the editor at font scale 2") { onEditor(scenario) { it.editing } == true }
                    scenario.onActivity { it.findViewById<EditText>(R.id.note_body_edit).append(", typed at font scale 2") }
                    val saved = awaitSave(scenario, "the save")
                    assertTrue("saved on this device: $saved", saved is SaveResult.Saved)
                    val waiting = "${context.getString(R.string.notes_editor_saved)}. ${context.getString(R.string.notes_editor_waiting_wifi_sync_now)}"
                    waitUntil("the status line") { statusLine(scenario) == waiting }
                    waitUntil("Undo to be offered") {
                        var enabled = false
                        scenario.onActivity { enabled = actionBar(it).menu.findItem(R.id.note_undo)?.isEnabled == true }
                        enabled
                    }
                    scenario.onActivity { activity ->
                        assertEquals(2f, activity.resources.configuration.fontScale)
                        val title = activity.findViewById<EditText>(R.id.note_title_edit)
                        val body = activity.findViewById<EditText>(R.id.note_body_edit)
                        val status = activity.findViewById<TextView>(R.id.note_status)
                        unscaled.zip(listOf(title, body)).forEach { (before, view) ->
                            assertTrue("the text is larger: $before px, then ${view.textSize} px", view.textSize >= before * 1.5f)
                        }
                        // Labels: the fields' hints and the items' titles.
                        assertEquals(activity.getString(R.string.notes_editor_title_hint), title.hint.toString())
                        assertEquals(activity.getString(R.string.notes_editor_body_hint), body.hint.toString())
                        // Reachable: the title and the status line in full, the body in part, with the rest in its scroll view.
                        fun visible(view: View) = view.isShown && view.getGlobalVisibleRect(Rect())
                        fun inFull(view: View): Boolean {
                            val shown = Rect()
                            return view.isShown && view.getGlobalVisibleRect(shown) && shown.width() == view.width && shown.height() == view.height
                        }
                        assertTrue("the title shows in full", inFull(title))
                        assertTrue("the body shows", visible(body))
                        assertTrue("the body scrolls", generateSequence(body.parent) { it.parent }.any { (it as? View)?.id == R.id.note_scroll })
                        assertTrue("the status line shows in full", inFull(status))
                        assertEquals("nothing of the status line is cut off", 0,
                            (0 until status.layout.lineCount).sumOf { status.layout.getEllipsisCount(it) })
                        // Undo and Redo: titled items, each a button on the toolbar or in its overflow.
                        val toolbar = actionBar(activity)
                        var overflow = false
                        for ((id, label) in listOf(R.id.note_undo to R.string.notes_editor_undo, R.id.note_redo to R.string.notes_editor_redo)) {
                            val item = checkNotNull(toolbar.menu.findItem(id)) { "${activity.getString(label)} is in the menu" }
                            assertTrue("${item.title} is offered", item.isVisible)
                            assertEquals(activity.getString(label), item.title.toString())
                            val button = activity.findViewById<View?>(id)
                            if (button != null && button.isShown) assertTrue("${item.title} shows on the toolbar", visible(button)) else overflow = true
                        }
                        Log.i(EDITOR_LOG, "font scale 2: Undo or Redo in the overflow=$overflow")
                        if (overflow) {
                            assertTrue("the overflow holds what the toolbar cannot show", toolbar.showOverflowMenu())
                            toolbar.hideOverflowMenu()
                        }
                        // Order: the keyboard goes from the title to the body, and accessibility reads the title, the body,
                        // then the status line, which announces its changes politely.
                        assertSame(body, title.focusSearch(View.FOCUS_FORWARD))
                        val read = ArrayList<View>()
                        fun visit(view: View) {
                            if (!view.isShown) return
                            if (view.isImportantForAccessibility) read += view
                            if (view is ViewGroup) for (index in 0 until view.childCount) visit(view.getChildAt(index))
                        }
                        visit(activity.findViewById(android.R.id.content))
                        assertEquals(listOf<View>(title, body, status), read.filter { it === title || it === body || it === status })
                        for (view in listOf<View>(title, body, status)) {
                            assertEquals(View.NO_ID, view.accessibilityTraversalBefore)
                            assertEquals(View.NO_ID, view.accessibilityTraversalAfter)
                        }
                        assertEquals(View.ACCESSIBILITY_LIVE_REGION_POLITE, status.accessibilityLiveRegion)
                    }
                } finally {
                    original?.let { configuration ->
                        @Suppress("DEPRECATION")
                        scenario.onActivity { it.resources.updateConfiguration(configuration, it.resources.displayMetrics) }
                    }
                }
                closing = runs.size
            }
            awaitClosingRun(identity, runs, closing)
            probe.assertNoneOnMain()
        } finally {
            probe.uninstall()
            runs.uninstall()
        }
    }

    // ---- helpers ----

    /** An account row for the stand-in server; with no [generation], a row whose creation id was never written. */
    private fun newAccount(generation: String?, name: String = "notes-boundary-${System.nanoTime()}@example.invalid",
                           discoveryKey: Boolean = true): Account {
        val account = Account(name, App.accountType)
        names += name
        awaitSyncManagerQuiet()
        // Unsyncable before the row exists, so the broadcast the add sends never finds the task
        // adapters in the unknown state that schedules their initialization syncs. Set again right
        // after, in case a broadcast still in flight dropped the then-absent name's settings.
        if (syncManagerRacesAccountChanges) silenceSyncAdapters(account)
        check(manager.addAccountExplicitly(account, null, null))
        silenceSyncAdapters(account)
        AccountSettings.setUserData(manager, account, URI(fake.baseUrl), account.name)
        if (generation != null) check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
        check(AccountSettings.writeNotesEnabled(manager, account, true))
        AccountSettings(context, account).etebaseSession = session
        // With the discovery key in place a listing starts from the saved cursor, as it does on a
        // device that has synced before; without it every listing starts from scratch.
        if (discoveryKey) check(AccountSettings.writeCollectionListTypes(manager, account, CollectionListRefresh.discoveryTypesKey))
        return account
    }

    /** Removes the account and adds a same-name one with a new generation, as a sign-out and sign-in would. */
    private fun replaceAccount(account: Account, generation: String) {
        removeAccount(account)
        newAccount(generation, account.name, discoveryKey = false)
    }

    private fun removeAccount(account: Account) {
        if (account !in manager.getAccountsByType(account.type)) return
        awaitSyncManagerQuiet()
        val removed = CountDownLatch(1)
        var confirmed = false
        AndroidCompat.removeAccount(manager, account) {
            confirmed = it
            removed.countDown()
        }
        assertTrue("account removal callback timed out", removed.await(10, TimeUnit.SECONDS))
        assertTrue("account removal was not confirmed", confirmed)
        awaitRemovalSeenBySyncManager(account)
    }

    /** Nothing is scheduled or started for [account] by any of this app's sync adapters. */
    private fun silenceSyncAdapters(account: Account) {
        for (authority in adapterAuthorities) ContentResolver.setIsSyncable(account, authority, 0)
    }

    /**
     * Before Android 7: waits until, for [QUIET_MILLIS] in a row, no platform sync runs and every
     * account of this app's type is unsyncable for every adapter of this app. That includes accounts
     * another class left behind, whose initialization syncs or queued manual retries could otherwise
     * start during an account change here. Pending operations are not waited for: at 0 they are
     * dropped before they start. There is no cancelSync either, since a cancel changes the very list
     * the broadcast walks.
     */
    private fun awaitSyncManagerQuiet() {
        if (!syncManagerRacesAccountChanges) return
        check(!ContentResolver.getMasterSyncAutomatically()) { "master sync must stay off while this class changes accounts" }
        val deadline = SystemClock.uptimeMillis() + 30_000
        var quietSince = SystemClock.uptimeMillis()
        while (true) {
            var busy = false
            for (present in manager.getAccountsByType(App.accountType)) {
                for (authority in adapterAuthorities) {
                    if (ContentResolver.getIsSyncable(present, authority) != 0) {
                        ContentResolver.setIsSyncable(present, authority, 0)
                        busy = true
                    }
                }
            }
            val running = ContentResolver.getCurrentSyncs()
            if (running.isNotEmpty()) busy = true
            val now = SystemClock.uptimeMillis()
            if (busy) quietSince = now else if (now - quietSince >= QUIET_MILLIS) return
            if (now >= deadline) throw AssertionError("platform syncs did not settle: ${running.joinToString { it.authority }}")
            SystemClock.sleep(20)
        }
    }

    /**
     * Before Android 7: waits until system_server has handled an account change after [account]
     * was removed. Handling one drops every sync setting of an absent account, so the 0 left before
     * the removal reads back as unknown. The removal's own broadcast follows at most right behind,
     * and the quiet wait and second seed in [newAccount] cover a same-name account added next.
     */
    private fun awaitRemovalSeenBySyncManager(account: Account) {
        if (!syncManagerRacesAccountChanges) return
        waitUntil("the platform to handle the removal of ${account.name}", 10_000) {
            ContentResolver.getIsSyncable(account, taskAuthorities.first()) < 0
        }
    }

    /**
     * The app's own sign-out through the coordinator and the real seams, without the screen. When the
     * store holds anything, the separate discard confirmation is given first for what it holds now, in
     * place of the answer to the second dialog. Then the coordinator counts the store again, cancels
     * sync, clears the pending store, removes the account, and clears its cache and its status.
     * [wrap] can put a check around the real seams.
     */
    private fun signOut(
        account: Account,
        generation: String,
        wrap: (CurrentAccountSignOutCoordinator.Seams) -> CurrentAccountSignOutCoordinator.Seams = { it },
    ) {
        awaitSyncManagerQuiet()
        val completed = CountDownLatch(1)
        val seams = wrap(AndroidCurrentAccountSignOut(context, account, generation))
        val coordinator = CurrentAccountSignOutCoordinator(seams) { state ->
            if (state is CurrentAccountSignOutState.Complete) completed.countDown()
        }
        val identity = ExactAccountIdentity(account.type, account.name, generation)
        val shown = coordinator.unsyncedNotes(identity)
        if (shown.anything) coordinator.confirmNotesDiscard(identity, shown)
        coordinator.begin()
        assertTrue("sign-out did not complete: ${coordinator.state}", completed.await(15, TimeUnit.SECONDS))
        awaitRemovalSeenBySyncManager(account)
    }

    private fun uploadNotebook(name: String): String {
        val colMgr = server.collectionManager
        val notebook = colMgr.create(Constants.ETEBASE_TYPE_NOTES, ItemMetadata().apply { this.name = name }, "")
        colMgr.upload(notebook)
        uploaded[notebook.uid] = notebook
        return notebook.uid
    }

    /**
     * A notebook whose metadata this client cannot decode (its name is a number), as another app
     * could write it. Sync caches it like any other; the screens leave it out.
     */
    private fun uploadUndecodableNotebook(): String {
        val colMgr = server.collectionManager
        val notebook = colMgr.create_raw(Constants.ETEBASE_TYPE_NOTES, TestMsgPack.encode(linkedMapOf("name" to 7L)), ByteArray(0))
        colMgr.upload(notebook)
        return notebook.uid
    }

    private fun itemManager(notebook: String) = server.collectionManager.getItemManager(uploaded.getValue(notebook))

    private fun uploadNote(notebook: String, title: String, body: String, mtime: Long, type: String? = null): Item {
        val itemMgr = itemManager(notebook)
        val note = itemMgr.create(ItemMetadata().apply {
            name = title
            this.mtime = mtime
            type?.let { itemType = it }
        }, body)
        itemMgr.batch(arrayOf(note))
        return note
    }

    /** A note with exactly these metadata bytes, as another client could upload it; nothing passes through a typed string. */
    private fun uploadRawNote(notebook: String, metaRaw: ByteArray, body: String): Item {
        val itemMgr = itemManager(notebook)
        val note = itemMgr.create_raw(metaRaw, body.toByteArray(Charsets.UTF_8))
        itemMgr.batch(arrayOf(note))
        return note
    }

    /** Uploads one note per title, each as its own change, so the server lists them in this order. */
    private fun uploadNotes(notebook: String, vararg titles: String) {
        titles.forEachIndexed { index, title -> uploadNote(notebook, title, "Body of $title", mtime = 1_000L + index) }
    }

    private fun cache(account: Account) = EtebaseLocalCache.getInstance(context, account.name)

    /** A manual run that lists the collections again, so a change made on the stand-in server is seen. */
    private fun syncNow(account: Account, generation: String) {
        startManualRun(account, generation)
        awaitSettled(ExactAccountIdentity(account.type, account.name, generation))
    }

    private fun startManualRun(account: Account, generation: String) {
        statusBeforeRun = status(account, generation)
        forgetLastListing(account.name)
        NotesSyncCoordinator.request(context, account, generation, NotesSyncPolicy.Trigger.MANUAL)
    }

    /** The fetches of [notebook] itself since request [since]. */
    private fun notebookFetches(since: Int, notebook: String) =
        fake.requests.drop(since).count { it.substringBefore('?') == "GET collection/$notebook/" }

    /** What a run must leave as it was: the notebook's cursor and cached notes, and the account's NOTES status. */
    private data class NotebookSnapshot(val cursor: String?, val notes: Set<String>, val status: SyncStatusStore.Status)

    /**
     * Syncs [account] once and checks that run succeeded, then changes [notebook]'s notes on the
     * stand-in server, so the next run lists that notebook's notes again. Returns what the first run left.
     */
    private fun syncedThenChangedOnServer(account: Account, generation: String, notebook: String, change: String): NotebookSnapshot {
        syncNow(account, generation)
        val synced = NotebookSnapshot(notebookCursor(account, notebook), cachedNotes(account, notebook), status(account, generation))
        assertNotNull("the first run succeeded: ${synced.status}", synced.status.lastSuccessAt)
        assertEquals("the first run fetched all of the notebook's notes", fake.itemStoken(notebook), synced.cursor)
        uploadNotes(notebook, change)
        assertFalse("the notebook's notes changed on the server", fake.itemStoken(notebook) == synced.cursor)
        return synced
    }

    /** [run] recorded neither a success nor a failure, closed its attempt, and wrote nothing for [notebook]. */
    private fun assertUnchangedBy(run: String, account: Account, generation: String, notebook: String, before: NotebookSnapshot) {
        status(account, generation).let {
            assertEquals("$run recorded no success: $it", before.status.lastSuccessAt, it.lastSuccessAt)
            assertEquals("$run recorded no failure: $it", before.status.lastFailureAt, it.lastFailureAt)
            assertNull("$run left no attempt open: $it", it.activeAttemptId)
        }
        assertEquals("the notebook's cursor did not move", before.cursor, notebookCursor(account, notebook))
        assertEquals("nothing was fetched into the cache", before.notes, cachedNotes(account, notebook))
        assertTrue("the notebook is still cached", notebook in cachedNotebooks(account))
    }

    /**
     * Ends a phase that held the fetch of [notebook]: its notes listing answers again, the held fetch was
     * the only one since [since], and a scripted answer for it was used up. Reads the request log, so it
     * goes after the phase's own request assertions.
     */
    private fun endNotebookCheckPhase(notebook: String, since: Int) {
        fake.answerItemListNotFound(notebook, false)
        assertEquals("one fetch of the notebook itself", 1, notebookFetches(since, notebook))
        // A scripted answer still waiting would be given to this fetch, and it would throw.
        assertEquals("the notebook answers its own fetch", notebook, server.collectionManager.fetch(notebook).uid)
    }

    private fun pending(account: Account, generation: String): PendingNotesStore =
        PendingNotesStore.forIdentity(context, account.type, account.name, generation).also { if (it !in stores) stores += it }

    private fun pendingHeaders(account: Account, generation: String) = pending(account, generation).snapshot { false }.headers

    // ---- the pending store on disk: the three store requirements on #709 (design 3.1) ----

    /** [text] in the encodings plain text could be written in: UTF-8 and both byte orders of UTF-16. */
    private fun plainForms(text: String): List<ByteArray> =
        listOf(Charsets.UTF_8, Charsets.UTF_16LE, Charsets.UTF_16BE).map { text.toByteArray(it) }

    private fun ByteArray.holds(needle: ByteArray): Boolean {
        require(needle.isNotEmpty())
        outer@ for (start in 0..size - needle.size) {
            for (i in needle.indices) if (this[start + i] != needle[i]) continue@outer
            return true
        }
        return false
    }

    /** Every file of the store, by name, as it is on disk right now, read without the store. */
    private fun filesOnDisk(store: PendingNotesStore): Map<String, ByteArray> {
        val listed = store.dir.listFiles().orEmpty()
        assertTrue("only files: ${listed.map { it.name }}", listed.all { it.isFile })
        return listed.associate { it.name to it.readBytes() }
    }

    /**
     * The names in [dir], read from listings that must work: of [dir], or of the directory above it when that
     * listing shows [dir] is not there. File.exists() is not asked, since it answers false for a check that
     * failed as well as for a file that is not there.
     */
    private fun namesIn(dir: File): Set<String> {
        val above = dir.parentFile!!
        val names = above.list() ?: throw AssertionError("${above.name} could not be listed")
        if (dir.name !in names) return emptySet()
        return (dir.list() ?: throw AssertionError("${dir.name} could not be listed")).toSet()
    }

    /** The startup sweep's record in no_backup as it is on disk now, or null when a listing shows it is not there. */
    private fun lastActiveRecord(): ByteArray? = File(context.noBackupFilesDir, NotesLastActiveRecord.FILE)
        .takeIf { it.name in namesIn(context.noBackupFilesDir) }?.readBytes()

    /**
     * What the startup sweep could change, as it is on disk now: every file of every store in notes-pending and every
     * file of notes-discard, by path, and the sweep's record.
     */
    private fun sweepFilesOnDisk(): Map<String, ByteArray> {
        val pendingRoot = File(context.noBackupFilesDir, PendingNotesStore.PENDING)
        val dirs = namesIn(pendingRoot).map { File(pendingRoot, it) } +
            File(context.noBackupFilesDir, PendingNotesDiscardPermits.ROOT)
        val files = dirs.flatMap { dir -> namesIn(dir).map { File(dir, it) } }.associate { it.path to it.readBytes() }
        return files + listOfNotNull(lastActiveRecord()?.let { NotesLastActiveRecord.FILE to it })
    }

    private fun assertSameFiles(what: String, expected: Map<String, ByteArray>, actual: Map<String, ByteArray>) {
        assertEquals(what, expected.keys, actual.keys)
        for ((name, bytes) in expected) assertArrayEquals("$what: $name", bytes, actual.getValue(name))
    }

    /** What a file of the store decoded to; one that does not decode fails with the codec's reason. */
    private fun <T> PendingCodec.Decoded<T>.orFail(name: String): T = when (this) {
        is PendingCodec.Decoded.Ok -> value
        is PendingCodec.Decoded.Bad -> throw AssertionError("$name does not decode: $reason")
    }

    /**
     * "Keep the pending store encrypted": reads every file of the store from disk. None holds any of
     * [texts] (a title, a text, a notebook name) as UTF-8 or UTF-16. Every file is one of the four
     * kinds the store writes and encodes again to the same bytes from what it decodes to, so it has no
     * byte that is not a header field, a blob or a checksum; a leftover temporary file fails here.
     * Returns the entries by note uid, for the caller to compare their plain headers field by field.
     */
    private fun assertNothingPlainOnDisk(store: PendingNotesStore, texts: List<String>): Map<String, PendingEntry> {
        val files = filesOnDisk(store)
        assertTrue("the store has files to check", files.isNotEmpty())
        val entries = HashMap<String, PendingEntry>()
        for ((name, bytes) in files) {
            for (text in texts) for (form in plainForms(text)) {
                assertFalse("$name holds '$text' in plain text", bytes.holds(form))
            }
            when {
                name == "sequence" -> {
                    val value = PendingCodec.decodeSequence(bytes).orFail(name)
                    assertArrayEquals(name, PendingCodec.encodeSequence(value), bytes)
                }
                name.endsWith(".note") -> {
                    val entry = PendingCodec.decodeEntry(bytes).orFail(name)
                    assertArrayEquals("$name is its header and its blob", PendingCodec.encodeEntry(entry), bytes)
                    assertEquals("named by its note's uid", "${entry.noteUid}.note", name)
                    entries[entry.noteUid] = entry
                }
                name.endsWith(".notebook") -> {
                    val (uid, blob) = PendingCodec.decodeNotebook(bytes).orFail(name)
                    assertArrayEquals(name, PendingCodec.encodeNotebook(uid, blob), bytes)
                    assertEquals("named by its notebook's uid", "$uid.notebook", name)
                }
                name.endsWith(".landed") -> {
                    val landed = PendingCodec.decodeLanded(bytes).orFail(name)
                    assertArrayEquals(name, PendingCodec.encodeLanded(landed), bytes)
                    assertEquals("named by its note's uid", "${landed.noteUid}.landed", name)
                }
                else -> throw AssertionError("a file the store's format does not account for: $name")
            }
        }
        return entries
    }

    /** No directory or file of the store is open to another user. The store sets no mode itself. */
    private fun assertClosedToOtherUsers(store: PendingNotesStore) {
        for (path in listOf(store.dir.parentFile!!, store.dir) + store.dir.listFiles().orEmpty()) {
            val mode = Os.stat(path.path).st_mode and 0x1FF
            assertEquals("${path.name} has no group or other permission: ${Integer.toOctalString(mode)}", 0, mode and 0x3F)
        }
    }

    /** A pending entry decrypted as design 3.1 says: through the notebook copy the store keeps, not through the Etebase cache. */
    private fun decryptThroughStoredCopy(store: PendingNotesStore, entry: PendingEntry): Item {
        val colMgr = server.collectionManager
        val copy = checkNotNull(store.notebook(entry.notebookUid)) { "the store keeps a copy of the notebook" }
        return colMgr.getItemManager(colMgr.cacheLoad(copy)).cacheLoad(entry.blob)
    }

    /** The text the Etebase cache holds for [note]. */
    private fun cachedBody(account: Account, notebook: String, note: String): String? = cache(account).let { cache ->
        synchronized(cache) {
            val colMgr = server.collectionManager
            val col = cache.collectionGet(colMgr, notebook).col
            cache.itemGet(colMgr.getItemManager(col), notebook, note)?.content
        }
    }

    /** The Etebase cache of the account name [name], which sign-out clears. Its path is decided by the name. */
    private fun etebaseCacheDir(name: String) = File(context.filesDir, name)

    /** The directories Android's "Clear cache" empties for an app. */
    private fun androidCacheDirs(): List<File> = buildList {
        add(context.cacheDir)
        add(context.codeCacheDir)
        addAll(context.externalCacheDirs.filterNotNull())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            val deviceProtected = context.createDeviceProtectedStorageContext()
            add(deviceProtected.cacheDir)
            add(deviceProtected.codeCacheDir)
        }
    }

    private fun File.isInside(root: File): Boolean =
        canonicalPath == root.canonicalPath || canonicalPath.startsWith(root.canonicalPath + File.separator)

    private fun assertStoreOutsideEveryCache(store: PendingNotesStore, name: String) {
        assertTrue("under the no-backup directory", store.dir.isInside(context.noBackupFilesDir))
        for (root in androidCacheDirs() + etebaseCacheDir(name)) assertFalse("the store is not under $root", store.dir.isInside(root))
    }

    /**
     * A cache clear, done as the app's own user: the Etebase cache by the call sign-out makes, then the
     * contents of every directory Android's "Clear cache" empties. The platform's own operation needs a
     * permission a test does not hold, so this deletes the same directories' contents itself.
     */
    private fun clearEveryCache(account: Account) {
        EtebaseLocalCache.clearUserCache(context, account.name)
        forgetLastListing(account.name)
        assertTrue("the Etebase cache is empty: ${cacheFiles(account.name)}", cacheFiles(account.name).isEmpty())
        // Most of these directories are empty on a test device, so a file of the test's own goes into
        // each first: the clear is then seen to reach every one of them. Nothing is asserted about a
        // directory being empty afterwards, since other threads of the process may write there.
        val dirs = androidCacheDirs()
        val markers = dirs.map { File(it, "pending-store-check").apply { writeText("x") } }
        for (dir in dirs) dir.listFiles()?.forEach { it.deleteRecursively() }
        for (marker in markers) assertFalse("the cache clear reached ${marker.parentFile}", marker.exists())
    }

    /**
     * A save by note uid, not through an editor handle, on the base design 3.2 gives a save: the new title
     * and text go onto the note's pending entry when there is one, else onto the copy this account's cache
     * holds, and the result is saved into the pending store with a copy of the notebook. No landed record
     * is kept when it is pushed, unless the case itself has an editor handle open on the note. With
     * [metaRaw], the item gets exactly those bytes as its metadata in place of the merge, for metadata no
     * save of the app would write. With [intoHeld], the save goes into held text and names the held entry's
     * version as its base, as an editor that showed that text does; a save into held text with no base writes nothing.
     */
    private fun editLocally(account: Account, generation: String, notebook: String, note: String, title: String, body: String, mtime: Long,
                            withNotebookCopy: Boolean = true, metaRaw: ByteArray? = null, intoHeld: Boolean = false) {
        val store = pending(account, generation)
        val base = if (intoHeld) (store.read(note) as PendingNotesStore.Read.Present).entry.version else null
        val (itemMgr, item, copy) = editable(account, store, notebook, note)
        item.setContent(body)
        item.setMetaRaw(metaRaw ?: (NoteMetaCodec.merge(item.metaRaw, title, mtime) as NoteMetaCodec.Merge.Merged).bytes)
        val saved = store.saveLocal(note, notebook, item.etag, itemMgr.cacheSaveWithContent(item), isCreate = false,
            notebookCopy = copy.takeIf { withNotebookCopy }, base = base)
        if (intoHeld) {
            assertTrue("the edit joined the held text: $saved", saved is PendingNotesStore.SaveOutcome.SavedToHolding)
        } else {
            assertTrue("the edit was saved: $saved", saved is PendingNotesStore.SaveOutcome.Saved)
        }
    }

    /** The item a save starts from, with its item manager and a copy of its notebook; the pending lock and the cache monitor are never held together. */
    private fun editable(account: Account, store: PendingNotesStore, notebook: String, note: String): Triple<ItemManager, Item, ByteArray> {
        val colMgr = server.collectionManager
        val entry = (store.read(note) as? PendingNotesStore.Read.Present)?.entry
        val cache = cache(account)
        val (col, cached) = synchronized(cache) {
            val col = cache.collectionGet(colMgr, notebook).col
            col to if (entry == null) checkNotNull(cache.itemGet(colMgr.getItemManager(col), notebook, note)) { "the note is cached" }.item else null
        }
        val itemMgr = colMgr.getItemManager(col)
        return Triple(itemMgr, entry?.let { itemMgr.cacheLoad(it.blob) } ?: cached!!, colMgr.cacheSave(col))
    }

    /** Another device's save: the server's copy changes, and this account's cache does not know it yet. */
    private fun editOnAnotherDevice(notebook: String, note: String, body: String) {
        val itemMgr = itemManager(notebook)
        val item = itemMgr.fetch(note)
        item.setContent(body)
        itemMgr.transaction(arrayOf(item))
    }

    /** Every item upload since request [since], as "POST collection/<uid>/item/<transaction or batch>/", with any query kept. */
    private fun uploads(since: Int) = fake.requests.drop(since).filter { UPLOAD.matches(it.substringBefore('?')) }

    private fun transactionOf(notebook: String) = "POST collection/$notebook/item/transaction/"

    /** The last manual run succeeded, and recorded so itself: a success left by an earlier run does not count. */
    private fun assertSucceeded(status: SyncStatusStore.Status) {
        assertEquals("the run succeeded: $status", SyncStatusStore.TerminalResult.SUCCESS, status.lastTerminalResult)
        assertNull("no attempt left open: $status", status.activeAttemptId)
        val before = checkNotNull(statusBeforeRun) { "no manual run was started" }
        assertTrue("the success was recorded by the last run: $status", (status.lastSuccessAt ?: 0L) > (before.lastSuccessAt ?: 0L))
    }

    private fun listCursor(account: Account): String? = cache(account).let { synchronized(it) { it.loadStoken() } }

    private fun notebookCursor(account: Account, uid: String): String? = cache(account).let { synchronized(it) { it.collectionLoadStoken(uid) } }

    private fun cachedNotebooks(account: Account): Set<String> = cache(account).let { cache ->
        synchronized(cache) { cache.collections(server.collectionManager, type = Constants.ETEBASE_TYPE_NOTES).mapTo(HashSet()) { it.uid } }
    }

    /** The name the cache holds for [notebook], or null when it is not cached. */
    private fun cachedNotebookName(account: Account, notebook: String): String? = cache(account).let { cache ->
        synchronized(cache) {
            cache.collections(server.collectionManager, type = Constants.ETEBASE_TYPE_NOTES).firstOrNull { it.uid == notebook }?.meta?.name
        }
    }

    /**
     * Renames [notebook] the way EditCollectionFragment.uploadCollection saves an edit: starting
     * from the cached revision, upload it, then (with [cacheIt]) cache the uploaded revision under
     * the cache's monitor. Without [cacheIt] only the server changes, as when another device edits.
     */
    private fun renameAsEditingDoes(account: Account, notebook: String, name: String, cacheIt: Boolean) {
        val colMgr = server.collectionManager
        val cache = cache(account)
        val col = synchronized(cache) { cache.collectionGet(colMgr, notebook).col }
        col.meta = ItemMetadata().apply { this.name = name }
        colMgr.upload(col)
        if (cacheIt) synchronized(cache) { cache.collectionSet(colMgr, col) }
    }

    /** The titles of the notes cached for [notebook]; none when the notebook itself is not cached. */
    private fun cachedNotes(account: Account, notebook: String): Set<String> = cache(account).let { cache ->
        synchronized(cache) {
            val colMgr = server.collectionManager
            val cached = cache.collections(colMgr, type = Constants.ETEBASE_TYPE_NOTES).firstOrNull { it.uid == notebook }
            if (cached == null) emptySet()
            else cache.itemList(colMgr.getItemManager(cached), notebook).mapTo(HashSet()) { it.meta.name.orEmpty() }
        }
    }

    /** Every file under the account name's cache directory, which sign-out removes. */
    private fun cacheFiles(name: String): List<String> {
        val directory = File(context.filesDir, name)
        return directory.walkTopDown().filter { it.isFile }.map { it.relativeTo(directory).path }.toList()
    }

    /** The cursor a held list or item request asked to continue from. */
    private fun cursorOf(held: FakeEtebaseServer.Hold): String? = cursorIn(held.request.orEmpty())

    /** The cursor a recorded list or item request asked to continue from. */
    private fun cursorIn(request: String): String? = Regex("[?&]stoken=([^&]+)").find(request)?.groupValues?.get(1)

    private fun itemRequests(notebook: String) = fake.requests.filter { it.startsWith("GET collection/$notebook/item/") }

    /**
     * The held page of notes was answered after its run stopped being allowed to write: the cache
     * holds only the notes written before it, the notebook's cursor still points at the held page,
     * and no page was asked for after it.
     */
    private fun assertNothingWrittenFrom(held: FakeEtebaseServer.Hold, account: Account, notebook: String, alreadyCached: Set<String>) {
        assertEquals("the held page's notes were not cached", alreadyCached, cachedNotes(account, notebook))
        assertEquals("the notebook's cursor did not move past the held page", cursorOf(held), notebookCursor(account, notebook))
        assertEquals("no page was requested after the held one", held.request, itemRequests(notebook).last())
    }

    /** A push held in flight: the hold, and what the test read before the run and while the upload was held. */
    private class HeldPush(
        val hold: FakeEtebaseServer.Hold,
        /** Whether the server took the upload before its answer was held. */
        val applied: Boolean,
        /** Where the request log stood before the run, and right after the held upload arrived. */
        val since: Int,
        val through: Int,
        /** How many uploads the stand-in had routed before the run. */
        val sizes: Int,
        val store: PendingNotesStore,
        /** The store's files while the upload was held. */
        val files: Map<String, ByteArray>,
        /** Before the run: the account's Notes status, and what the Etebase cache held for the note and its notebook. */
        val status: SyncStatusStore.Status,
        val cachedText: String?,
        val cursor: String?,
        val cachedNotes: Set<String>,
        /** When the test saw the held upload arrive. */
        val heldAt: Long,
    )

    /**
     * Starts a manual run and holds the upload of [note], which must be the change the run sends
     * first (here the oldest one waiting), and checks that the run got that far. With [applied] the
     * server takes the upload on arrival and only its answer is held; without, the upload is held
     * before the server looks at it, and on release the connection drops with nothing applied. Read
     * here for the comparison afterwards: the cache and the status before the run, the pending
     * store's files while the upload is held, and where the request log and the count of routed
     * uploads stood.
     */
    private fun holdPush(account: Account, generation: String, notebook: String, note: String, applied: Boolean,
                         swallowInterrupt: Boolean = false): HeldPush {
        val store = pending(account, generation)
        val waiting = (store.read(note) as PendingNotesStore.Read.Present).entry
        assertTrue("the change has not been sent before", waiting.sent.isEmpty())
        val cachedText = cachedBody(account, notebook, note)
        val cursor = notebookCursor(account, notebook)
        val cachedNotes = cachedNotes(account, notebook)
        val before = status(account, generation)
        val stoken = fake.itemStoken(notebook)
        val sizes = fake.uploadSizes.size
        val since = fake.requests.size
        if (!applied) fake.answer("POST", TRANSACTION, code = null)
        val hold = fake.hold("POST", TRANSACTION, swallowInterrupt = swallowInterrupt, answerFirst = applied)
        startManualRun(account, generation)
        hold.awaitArrival()
        val heldAt = SystemClock.uptimeMillis()
        assertEquals("the held request is the upload", transactionOf(notebook), hold.request)
        assertEquals("nothing was requested after it", hold.request, fake.requests.last())
        val through = fake.requests.size
        assertEquals("the server took the upload, or has not looked at it",
            if (applied) listOf(1) else emptyList<Int>(), fake.uploadSizes.drop(sizes))
        assertEquals("its notes changed, or did not", applied, fake.itemStoken(notebook) != stoken)
        assertNotNull("the run is recorded as in progress", status(account, generation).activeAttemptId)
        val files = filesOnDisk(store)
        assertEquals("the sent revision is on disk before the answer, and nothing else changed",
            waiting.copy(sent = listOf(waiting.revision)), PendingCodec.decodeEntry(files.getValue("$note.note")).orFail("$note.note"))
        return HeldPush(hold, applied, since, through, sizes, store, files, before, cachedText, cursor, cachedNotes, heldAt)
    }

    /**
     * The stand-in lets a parked request go by itself after 60 s and says nothing, and what is
     * asserted afterwards would then be about a run nothing stopped in flight. So a request that
     * arrived more than 50 s ago, which leaves room below those 60, fails here by name.
     */
    private fun assertStillHeld(heldAt: Long) {
        val age = SystemClock.uptimeMillis() - heldAt
        assertTrue("the request arrived $age ms ago, more than 50 s (the stand-in lets a parked request go by itself at 60 s)", age < 50_000)
    }

    /** Lets a held request go, unless the stand-in may already have let it go. */
    private fun release(hold: FakeEtebaseServer.Hold, heldAt: Long) {
        assertStillHeld(heldAt)
        hold.release()
    }

    private fun release(held: HeldPush) = release(held.hold, held.heldAt)

    /**
     * The held upload was answered after its run stopped being allowed to write: no other upload
     * and no request of any kind followed it, the pending store's files are byte for byte as they
     * were while it was held, the cache holds the text, the cursor and the notes it held before the
     * run, and the run recorded neither a success nor a failure. Every difference is reported, not
     * only the first. It reads the request log to its end, so it goes before any request of the test's own.
     */
    private fun assertNothingWrittenFromPush(held: HeldPush, account: Account, generation: String, notebook: String, note: String) {
        val problems = ArrayList<String>()
        fun same(what: String, expected: Any?, actual: Any?) {
            if (expected != actual) problems += "$what: expected <$expected> but was <$actual>"
        }
        same("one upload, and none after it", listOf(transactionOf(notebook)), uploads(held.since))
        same("no request of any kind followed the held upload", emptyList<String>(), fake.requests.drop(held.through))
        same("the uploads the server routed", if (held.applied) listOf(1) else emptyList<Int>(), fake.uploadSizes.drop(held.sizes))
        val files = filesOnDisk(held.store)
        same("the pending store's files", held.files.keys, files.keys)
        for ((name, bytes) in held.files) {
            val current = files[name] ?: continue
            if (current.contentEquals(bytes)) continue
            // An entry's header is plain, so what changed in it (a failure count, a hold) can be shown.
            problems += "the pending store's $name changed" +
                if (name.endsWith(".note")) ": it was ${PendingCodec.decodeEntry(bytes)} and is ${PendingCodec.decodeEntry(current)}" else ""
        }
        same("the uploaded note was not cached", held.cachedText, cachedBody(account, notebook, note))
        same("the notebook's cursor did not move", held.cursor, notebookCursor(account, notebook))
        same("no other note was fetched into the cache", held.cachedNotes, cachedNotes(account, notebook))
        val now = status(account, generation)
        same("no success was recorded", held.status.lastSuccessAt, now.lastSuccessAt)
        same("no failure was recorded", held.status.lastFailureAt, now.lastFailureAt)
        same("no attempt left open", null, now.activeAttemptId)
        assertTrue(problems.joinToString("\n"), problems.isEmpty())
    }

    /**
     * Puts a renamed copy of [notebook] and a rewritten copy of [note] into [account]'s cache, the
     * way that account's own sync would have cached them.
     */
    private fun cacheReplacementNotes(account: Account, notebook: String, note: Item) {
        val colMgr = server.collectionManager
        val collection = uploaded.getValue(notebook)
        collection.meta = ItemMetadata().apply { name = "Replacement notebook" }
        note.meta = ItemMetadata().apply {
            name = "Replacement note"
            mtime = 2_000L
        }
        note.setContent("Replacement body")
        val cache = cache(account)
        synchronized(cache) {
            cache.collectionSet(colMgr, collection)
            cache.itemSet(colMgr.getItemManager(collection), notebook, note)
        }
    }

    private fun notebookList(scenario: ActivityScenario<NotesActivity>) = fragment(scenario) as? NotebookListFragment

    private fun noteList(scenario: ActivityScenario<NotesActivity>) = fragment(scenario) as? NoteListFragment

    private fun heldText(scenario: ActivityScenario<NotesActivity>) = fragment(scenario) as? HeldTextFragment

    /** The Unsynced text screen of [activity], for use on the main thread inside onActivity. */
    private fun held(activity: NotesActivity) = activity.supportFragmentManager.findFragmentById(R.id.fragment_container) as HeldTextFragment

    private fun noteView(scenario: ActivityScenario<NotesActivity>) = fragment(scenario) as? NoteViewFragment

    /** The note screen of [activity], for use on the main thread inside onActivity. */
    private fun editorOf(activity: NotesActivity) = activity.supportFragmentManager.findFragmentById(R.id.fragment_container) as NoteViewFragment

    /** The toolbar's Up arrow, which reaches the activity as the home menu item. On the main thread. */
    private fun upArrow(activity: NotesActivity): View {
        val toolbar = actionBar(activity)
        val found = ArrayList<View>()
        toolbar.findViewsWithText(found, toolbar.navigationContentDescription, View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION)
        return found.single()
    }

    private fun fragment(scenario: ActivityScenario<NotesActivity>): androidx.fragment.app.Fragment? {
        var fragment: androidx.fragment.app.Fragment? = null
        scenario.onActivity { fragment = it.supportFragmentManager.findFragmentById(R.id.fragment_container) }
        return fragment
    }

    /**
     * Parks the first load that skips the undecodable notebook right there: inside its read of the
     * cache, holding the cache's monitor, until released. The loader logs each skipped notebook,
     * and a log handler runs on the thread that logs.
     */
    private class ReadPause : Handler() {
        private val taken = AtomicBoolean()
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)

        override fun publish(record: LogRecord) {
            if (record.message?.startsWith("Skipping a notebook that could not be decoded") == true && taken.compareAndSet(false, true)) {
                arrived.countDown()
                release.await(60, TimeUnit.SECONDS)
            }
        }

        override fun flush() = Unit

        override fun close() = Unit
    }

    /** Whether a thread other than [mine] is waiting to enter the loader's read of the cache. */
    private fun anotherLoadWaitsForTheCache(mine: List<Thread>): Boolean = Thread.getAllStackTraces().any { (thread, stack) ->
        thread !in mine && thread.state == Thread.State.BLOCKED && stack.any { it.className == NotesLoader::class.java.name }
    }

    /** One call into the loader on its own thread, as a screen makes it. */
    private class BackgroundLoad<T>(load: () -> NotesLoad<T>) {
        private val outcome = AtomicReference<Result<NotesLoad<T>>?>()
        val thread = thread(name = "notes-boundary-load") { outcome.set(runCatching(load)) }

        fun await(): NotesLoad<T> {
            thread.join(30_000)
            return checkNotNull(outcome.get()) { "the load did not finish" }.getOrThrow()
        }
    }

    /**
     * One shared collection refresh on its own thread, as a sync adapter runs it. [await] returns
     * what it threw, or null when it finished normally.
     */
    private inner class BackgroundRefresh(account: Account, generation: String) {
        private val failure = AtomicReference<Throwable?>()
        val thread = thread(name = "notes-boundary-refresh") {
            try {
                val settings = AccountSettings(context, account)
                HttpClient.Builder(context, settings).setForeground(false).build().use {
                    CollectionListRefresh.run(context, account, settings, it.okHttpClient, forceRefresh = false, creationId = generation)
                }
            } catch (t: Throwable) {
                failure.set(t)
            }
        }

        fun await(): Throwable? {
            thread.join(30_000)
            check(!thread.isAlive) { "the refresh did not finish" }
            return failure.get()
        }
    }

    /**
     * Runs [read] on its own thread, as another user of the account's cache would while a list
     * request is held, and fails if it is kept waiting instead of getting its answer.
     */
    private fun <T> readWhileHeld(what: String, read: () -> T): T {
        val outcome = AtomicReference<Result<T>?>()
        val reader = thread(name = "notes-boundary-reader") { outcome.set(runCatching(read)) }
        reader.join(10_000)
        val result = outcome.get() ?: throw AssertionError("$what was kept waiting while the collection list was in flight")
        return result.getOrThrow()
    }

    private fun status(account: Account, generation: String): SyncStatusStore.Status = SyncStatusStore(context).let {
        it.status(it.identity(account, generation), SyncStatusStore.Service.NOTES)
    }

    private fun assertClosedWithoutOutcome(status: SyncStatusStore.Status) {
        assertNull("no success: $status", status.lastSuccessAt)
        assertNull("no failure: $status", status.lastFailureAt)
        assertNull("no attempt left open: $status", status.activeAttemptId)
    }

    /** A run the network rule refuses asks the server nothing, leaves the waiting change of [note] alone, and leaves the status as it was. */
    private fun assertRefused(account: Account, generation: String, note: String, what: String, start: () -> Unit) {
        val store = pending(account, generation)
        val waiting = (store.read(note) as PendingNotesStore.Read.Present).entry
        val before = status(account, generation)
        val mark = fake.requests.size
        start()
        awaitSettled(ExactAccountIdentity(account.type, account.name, generation))
        assertEquals("$what asks the server nothing", emptyList<String>(), fake.requests.drop(mark))
        assertEquals("$what leaves the waiting change alone", waiting, (store.read(note) as PendingNotesStore.Read.Present).entry)
        assertEquals("$what records neither success nor failure", before, status(account, generation))
    }

    /** A run the network rule admits sends the one waiting change of [notebook]. */
    private fun assertSent(account: Account, generation: String, notebook: String, what: String, start: () -> Unit) {
        val mark = fake.requests.size
        start()
        awaitSettled(ExactAccountIdentity(account.type, account.name, generation))
        assertEquals("$what sends the waiting change", listOf(transactionOf(notebook)), uploads(mark))
        assertTrue("$what leaves nothing waiting", pendingHeaders(account, generation).isEmpty())
    }

    private fun listings(since: Int) = fake.requests.drop(since).filter { it.startsWith("POST collection/list_multi/") }

    private fun fromScratch(request: String) = !request.contains("stoken=")

    private fun lastListingKeys(name: String) = CollectionListRefresh.collectionLastFetchMap.keys.filter { it.startsWith("$name\u0000") }

    private fun forgetLastListing(name: String) {
        lastListingKeys(name).forEach { CollectionListRefresh.collectionLastFetchMap.remove(it) }
    }

    private fun awaitSettled(identity: ExactAccountIdentity) {
        waitUntil("Notes sync settled") { !NotesSyncCoordinator.isActive(identity) && !NotesSyncCoordinator.isPending(identity) }
        assertTrue(NotesSyncCoordinator.drainForTesting(30_000))
    }

    private fun waitUntil(description: String, timeoutMillis: Long = 30_000, predicate: () -> Boolean) {
        val deadline = android.os.SystemClock.uptimeMillis() + timeoutMillis
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            if (predicate()) return
            android.os.SystemClock.sleep(50)
        }
        throw AssertionError("Timed out waiting for $description")
    }

    // ---- the note editor's screens ----

    /** Pins what the device's network reads as, for the runs and for the editor's status line. */
    private fun pinNetwork(connection: NotesNetworkPolicy.Connection) {
        NotesNetwork.readingOverride = { NotesNetworkPolicy.Reading(connection) }
    }

    /**
     * Stands in front of the Notes runner for one case: records whether each run the coordinator starts is manual, then
     * runs it with the real runner, or not at all when [real] is false. The coordinator still admits, queues and settles
     * every run as it does for the real runner. [uninstall] takes it away.
     */
    private class Runs(private val real: Boolean = true) {
        private val manual = CopyOnWriteArrayList<Boolean>()

        init {
            NotesSyncCoordinator.runnerOverride = { appContext, account, generation, request ->
                manual += request.manual
                if (real) NotesSyncRunner.run(appContext, account, generation, request)
            }
        }

        /** How many runs started so far. */
        val size: Int get() = manual.size

        /** Whether each run from the [from]th on was manual. */
        fun since(from: Int): List<Boolean> = manual.drop(from)

        fun uninstall() {
            NotesSyncCoordinator.runnerOverride = null
        }
    }

    /**
     * Once the editor's screen closed with [runsBefore] runs started: an editor that saved anything asks for one run as it
     * closes, at once. Waits for that run, then for every run to settle, so nothing of the case is left running.
     */
    private fun awaitClosingRun(identity: ExactAccountIdentity, runs: Runs, runsBefore: Int) {
        waitUntil("the closing editor's run") { runs.size > runsBefore }
        awaitSettled(identity)
    }

    /** From the notebook list, opens the notebook named [name] once its row shows, and waits for its note list. */
    private fun showNotebook(scenario: ActivityScenario<NotesActivity>, name: String) {
        waitUntil("the notebook $name to show") {
            var clicked = false
            scenario.onActivity { activity ->
                val fragment = activity.supportFragmentManager.findFragmentById(R.id.fragment_container) as? NotebookListFragment ?: return@onActivity
                val index = fragment.renderedNotebooks.indexOfFirst { it.name == name }
                val list = activity.findViewById<ListView?>(R.id.notebooks_list) ?: return@onActivity
                if (index < 0 || list.adapter == null || list.adapter.count <= index) return@onActivity
                list.performItemClick(list.adapter.getView(index, null, list), index, index.toLong())
                clicked = true
            }
            clicked
        }
        waitUntil("the notes of $name to show") { noteList(scenario) != null }
    }

    /** From the note list, opens the note [uid] once its row shows, and waits until its screen chose the editor or the viewer. */
    private fun showNote(scenario: ActivityScenario<NotesActivity>, uid: String) {
        waitUntil("the note to show in its list") {
            var clicked = false
            scenario.onActivity { activity ->
                val fragment = activity.supportFragmentManager.findFragmentById(R.id.fragment_container) as? NoteListFragment ?: return@onActivity
                val index = fragment.renderedNotes.indexOfFirst { it.uid == uid }
                val list = activity.findViewById<ListView?>(R.id.notes_list) ?: return@onActivity
                if (index < 0 || list.adapter == null || list.adapter.count <= index) return@onActivity
                list.performItemClick(list.adapter.getView(index, null, list), index, index.toLong())
                clicked = true
            }
            clicked
        }
        waitUntil("the note's screen to open") { onEditor(scenario) { it.editorModel.opened != null } == true }
    }

    /** Opens the note [uid] of the notebook named [notebook] from the notebook list, and waits until the editor shows. */
    private fun openEditor(scenario: ActivityScenario<NotesActivity>, notebook: String, uid: String) {
        showNotebook(scenario, notebook)
        showNote(scenario, uid)
        waitUntil("the editor to show") { onEditor(scenario) { it.editing } == true }
    }

    /** [read] of the note screen, on the main thread, where the editor's text lives; null while no note screen shows. */
    private fun <T> onEditor(scenario: ActivityScenario<NotesActivity>, read: (NoteViewFragment) -> T): T? {
        var value: T? = null
        scenario.onActivity { activity ->
            (activity.supportFragmentManager.findFragmentById(R.id.fragment_container) as? NoteViewFragment)?.let { value = read(it) }
        }
        return value
    }

    /**
     * Waits until the editor has no text left to save and a save wrote a version above [above], and gives that save's
     * answer. A save that wrote nothing does not end the wait.
     */
    private fun awaitSave(scenario: ActivityScenario<NotesActivity>, what: String, above: Long = 0L): SaveResult {
        var answer: SaveResult? = null
        waitUntil(what) {
            answer = onEditor(scenario) { fragment ->
                fragment.editorModel.core.takeIf { !it.dirty && it.lastSavedVersion > above }?.lastResult
            }
            answer != null
        }
        return checkNotNull(answer)
    }

    /** The version a save wrote, or 0 for one that wrote nothing. */
    private val SaveResult.savedVersion: Long
        get() = when (this) {
            is SaveResult.Saved -> version
            is SaveResult.SavedToHolding -> version
            else -> 0L
        }

    /** The editor's status line as it shows, or null while it is hidden. */
    private fun statusLine(scenario: ActivityScenario<NotesActivity>): String? {
        var line: String? = null
        scenario.onActivity { activity ->
            activity.findViewById<TextView?>(R.id.note_status)?.takeIf { it.visibility == View.VISIBLE }?.let { line = it.text.toString() }
        }
        return line
    }

    /** The action bar's toolbar, which holds the editor's Undo and Redo. On the main thread. */
    private fun actionBar(activity: NotesActivity): androidx.appcompat.widget.Toolbar {
        fun find(view: View): androidx.appcompat.widget.Toolbar? = when (view) {
            is androidx.appcompat.widget.Toolbar -> view
            is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) }
            else -> null
        }
        return checkNotNull(find(activity.window.decorView)) { "the screen has an action bar" }
    }

    companion object {
        private val LIST = Regex("collection/list_multi/")
        private val ITEMS = Regex("collection/[^/]+/item/")
        private val TRANSACTION = Regex("collection/[^/]+/item/transaction/")
        private val UPLOAD = Regex("POST collection/[^/]+/item/(transaction|batch)/")
        private const val QUIET_MILLIS = 300L

        /** The log tag of the editor cases' own lines, which name uids and states only, never note text. */
        private const val EDITOR_LOG = "NotesEditorRuntime"

        /** Well-formed msgpack that is not a map: an array holding the string "x". */
        private val NOT_ONE_MAP = byteArrayOf(0x91.toByte(), 0xa1.toByte(), 0x78)

        /** The header of a map with one entry, and nothing after it. */
        private val CUT_SHORT_MAP = byteArrayOf(0x81.toByte())

        /**
         * What the checks of the pending store on disk look for. Long and distinctive, so a match in a
         * file is never chance, and ASCII, so the same strings work on Android 5.
         */
        private const val STORE_CHECK_NOTEBOOK = "Quarterly planning notebook of the pending store check"
        private const val STORE_CHECK_TITLE = "Title only the pending store check uses"
        private const val STORE_CHECK_BODY = "Text only the pending store check uses, line one"

        /** The draft of the account that the same-name case replaces. */
        private const val OLD_DRAFT_TITLE = "Draft title of the replaced account"
        private const val OLD_DRAFT_BODY = "Draft text of the replaced account"

        /**
         * One Etebase signup for the whole class: its key derivation takes seconds, and the session
         * works against any stand-in server, which keeps no state about users.
         */
        private val session: String by lazy {
            val fake = FakeEtebaseServer()
            val client = Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
            com.etebase.client.Account.signup(client, User("notes-boundary-${System.nanoTime()}", "notes-boundary@example.invalid"),
                "stand-in-server-only").save(null)
        }
    }
}
