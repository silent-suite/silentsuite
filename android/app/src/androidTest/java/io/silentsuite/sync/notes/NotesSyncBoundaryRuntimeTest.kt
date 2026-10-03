package io.silentsuite.sync.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.CalendarContract
import android.widget.ListView
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import at.bitfire.ical4android.TaskProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.etebase.client.Client
import com.etebase.client.Collection
import com.etebase.client.Item
import com.etebase.client.ItemMetadata
import com.etebase.client.User
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.syncadapter.CollectionListRefresh
import io.silentsuite.sync.syncadapter.EXTRA_FORCE_COLLECTION_REFRESH
import io.silentsuite.sync.syncadapter.StaleSyncRunException
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.syncadapter.requestSyncDispatchOverride
import io.silentsuite.sync.ui.AndroidCurrentAccountSignOut
import io.silentsuite.sync.ui.CurrentAccountSignOutCoordinator
import io.silentsuite.sync.ui.CurrentAccountSignOutState
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.notes.NoteContent
import io.silentsuite.sync.ui.notes.NoteListFragment
import io.silentsuite.sync.ui.notes.NoteViewFragment
import io.silentsuite.sync.ui.notes.NotebookListFragment
import io.silentsuite.sync.ui.notes.NotesActivity
import io.silentsuite.sync.ui.notes.NotesLoad
import io.silentsuite.sync.ui.notes.NotesLoader
import io.silentsuite.sync.ui.notes.notesFixtureOverride
import io.silentsuite.sync.utils.AndroidCompat
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.logging.Handler
import java.util.logging.LogRecord
import kotlin.concurrent.thread

/**
 * The Notes job, the shared collection refresh and the Notes screens' loader, run for real
 * (coordinator, runner, refresh, loader, Etebase binding, local cache, account store, status store)
 * against an in-process stand-in for the server ([FakeEtebaseServer]) that serves real encrypted
 * notebooks and notes a page at a time and can hold a request in flight. The sync cases hold one
 * request, change something while it is in flight, release it, and check exactly what was written.
 * The loader cases read what a real sync cached, with no fixture in between.
 */
@RunWith(AndroidJUnit4::class)
class NotesSyncBoundaryRuntimeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager = AccountManager.get(context)
    private val fake = FakeEtebaseServer()
    private val names = mutableSetOf<String>()
    private val dispatched = CopyOnWriteArrayList<Bundle>()
    private var previousMasterSync = true

    /** The notebooks this test uploaded, as the server side holds them, by uid. */
    private val uploaded = HashMap<String, Collection>()

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
        previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        // No platform adapter sync may reach the stand-in server while a test holds a request.
        ContentResolver.setMasterSyncAutomatically(false)
        HttpClient.testInterceptor = fake
        requestSyncDispatchOverride = { _, _, extras -> dispatched += Bundle(extras) }
    }

    @After fun tearDown() {
        fake.releaseAll()
        for (name in names) NotesSyncCoordinator.cancelAccount(App.accountType, name)
        val drained = NotesSyncCoordinator.drainForTesting(30_000)
        // The process-wide hooks are restored whatever fails here, so one failure cannot spread to
        // the other classes that run in the same instrumentation process.
        val problems = mutableListOf<Throwable>()
        try {
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
        val notebook = uploadNotebook("Shared before the swap")
        // Three pages of notes.
        uploadNotes(notebook, "One", "Two", "Three", "Four", "Five")
        fake.itemPageSize = 2

        // 1. The collection list is in flight when the account is removed and a same-name one added.
        val listing = fake.hold("POST", LIST)
        NotesSyncCoordinator.request(context, account, "gen-1", NotesSyncPolicy.Trigger.MANUAL)
        listing.awaitArrival()
        replaceAccount(account, "gen-2")
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
        // The waiting listing holds its own account's cache, so only the coordinator is asked about it.
        assertTrue("the first account's run is still waiting for its answer", NotesSyncCoordinator.isActive(slowIdentity))

        listing.release()
        awaitSettled(slowIdentity)
        assertEquals(setOf("One"), cachedNotes(slow, notebook))
        assertNotNull(status(slow, "gen-slow").lastSuccessAt)
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
            assertEquals(listOf("Listed first"), (shown as NotesLoad.Loaded).value.map { it.name })
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
        uploadNotebook("Home")
        uploadUndecodableNotebook()
        val agendaBody = "# Monday\n- budget\n- hiring"
        uploadNote(work, "Old plan", "First line of the old plan", mtime = 1_000L)
        val agenda = uploadNote(work, "Agenda", agendaBody, mtime = 2_000L)
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
            waitUntil("the cached notes to show") { noteList(scenario)?.renderedNotes?.map { it.title } == listOf("Agenda", "Old plan") }
            assertEquals(listOf("Monday", "First line of the old plan"), noteList(scenario)!!.renderedNotes.map { it.preview })
            scenario.onActivity { activity ->
                assertEquals("Work", activity.title.toString())
                val list = activity.findViewById<ListView>(R.id.notes_list)
                list.performItemClick(list.adapter.getView(0, null, list), 0, 0)
            }
            waitUntil("the cached note to show") { noteView(scenario)?.renderedNote != null }
            assertEquals(NoteContent(agenda.uid, "Agenda", agendaBody, 2_000L), noteView(scenario)!!.renderedNote)
            scenario.onActivity { activity ->
                assertEquals("Agenda", activity.findViewById<TextView>(R.id.note_title).text.toString())
                assertEquals(agendaBody, activity.findViewById<TextView>(R.id.note_body).text.toString())
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
        assertEquals(listOf("Replacement notebook"), (theirNotebooks as NotesLoad.Loaded).value.map { it.name })
        val theirNote = NotesLoader.note(context, account, "gen-new", notebook, note.uid)
        assertEquals(NoteContent(note.uid, "Replacement note", "Replacement body", 2_000L), (theirNote as NotesLoad.Loaded).value)
    }

    // ---- helpers ----

    private fun newAccount(generation: String, name: String = "notes-boundary-${System.nanoTime()}@example.invalid",
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
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
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
     * The app's own sign-out, as the account drawer runs it: cancel sync, remove the account, clear
     * its cache and its status.
     */
    private fun signOut(account: Account, generation: String) {
        awaitSyncManagerQuiet()
        val completed = CountDownLatch(1)
        val coordinator = CurrentAccountSignOutCoordinator(AndroidCurrentAccountSignOut(context, account, generation)) { state ->
            if (state is CurrentAccountSignOutState.Complete) completed.countDown()
        }
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

    /** Uploads one note per title, each as its own change, so the server lists them in this order. */
    private fun uploadNotes(notebook: String, vararg titles: String) {
        titles.forEachIndexed { index, title -> uploadNote(notebook, title, "Body of $title", mtime = 1_000L + index) }
    }

    private fun cache(account: Account) = EtebaseLocalCache.getInstance(context, account.name)

    private fun listCursor(account: Account): String? = cache(account).let { synchronized(it) { it.loadStoken() } }

    private fun notebookCursor(account: Account, uid: String): String? = cache(account).let { synchronized(it) { it.collectionLoadStoken(uid) } }

    private fun cachedNotebooks(account: Account): Set<String> = cache(account).let { cache ->
        synchronized(cache) { cache.collections(server.collectionManager, type = Constants.ETEBASE_TYPE_NOTES).mapTo(HashSet()) { it.uid } }
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

    private fun noteView(scenario: ActivityScenario<NotesActivity>) = fragment(scenario) as? NoteViewFragment

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

    companion object {
        private val LIST = Regex("collection/list_multi/")
        private val ITEMS = Regex("collection/[^/]+/item/")
        private const val QUIET_MILLIS = 300L

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
