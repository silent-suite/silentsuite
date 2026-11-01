package io.silentsuite.sync.birthdays

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderClient
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.SyncResult
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import at.bitfire.ical4android.TaskProvider
import com.etebase.client.Client
import com.etebase.client.Collection
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.ItemMetadata
import com.etebase.client.User
import com.etebase.client.exceptions.ConflictException
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.notes.FakeEtebaseServer
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.syncadapter.CalendarSyncManager
import io.silentsuite.sync.syncadapter.CollectionListRefresh
import io.silentsuite.sync.syncadapter.SyncManager
import io.silentsuite.sync.syncadapter.requestSyncDispatchOverride
import io.silentsuite.sync.utils.AndroidCompat
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The Birthdays calendar at its real boundaries: the pinned Etebase Java binding (real JNI), the
 * shared collection refresh, the account's local cache, `LocalCalendar` in the platform
 * CalendarProvider and the calendar adapter's own `CalendarSyncManager.performSync()`, against the
 * in-process [FakeEtebaseServer] the Notes boundary test uses. Its root-dependency check mirrors the
 * project server's `ItemBatchIn.validate_db` (`server/etebase_server/fastapi/routers/collection.py:158-200`),
 * already proven against the real server in S0.
 *
 * Methods documented as CONTROL exercise primitives that already exist and are expected to pass. Every
 * other method is a FEATURE regression whose first failing assertion names missing Birthdays
 * behaviour (message prefix "FEATURE"); its fixture steps and preconditions are plain assertions that
 * must pass first, so a fixture problem never reads as a feature RED.
 *
 * Each method registers its own uniquely named account (where it needs one) with every adapter
 * unsyncable and master sync off, so no platform sync reaches the stand-in server, and removes it,
 * its calendars and its cache afterwards whatever fails.
 */
@RunWith(AndroidJUnit4::class)
class BirthdayCalendarBoundaryRuntimeTest {
    @get:Rule
    val permissions: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR,
        Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS,
    )

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager = AccountManager.get(context)
    private val fake = FakeEtebaseServer()
    private val names = mutableSetOf<String>()
    private var previousMasterSync = true
    private var provider: ContentProviderClient? = null
    private val adapterAuthorities = TaskProvider.TASK_PROVIDERS.map { it.authority } +
        listOf(CalendarContract.AUTHORITY, App.addressBooksAuthority)

    /** The server side as the test sees it: the same Etebase user, talking to the same stand-in. */
    private val server by lazy {
        com.etebase.client.Account.restore(Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl), session, null)
    }

    @Before fun setUp() {
        previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        ContentResolver.setMasterSyncAutomatically(false)
        HttpClient.testInterceptor = fake
        requestSyncDispatchOverride = { _, _, _ -> }
        provider = checkNotNull(context.contentResolver.acquireContentProviderClient(CalendarContract.AUTHORITY))
    }

    @After fun tearDown() {
        fake.releaseAll()
        val problems = mutableListOf<Throwable>()
        try {
            for (name in names) {
                val account = Account(name, App.accountType)
                runCatching {
                    provider?.delete(asSyncAdapter(Calendars.CONTENT_URI, account),
                        "${Calendars.ACCOUNT_NAME}=? AND ${Calendars.ACCOUNT_TYPE}=?", arrayOf(account.name, account.type))
                }.exceptionOrNull()?.let(problems::add)
                runCatching { removeAccount(account) }.exceptionOrNull()?.let(problems::add)
                runCatching {
                    EtebaseLocalCache.clearUserCache(context, name)
                    CollectionListRefresh.collectionLastFetchMap.keys.filter { it.startsWith("$name\u0000") }
                        .forEach { CollectionListRefresh.collectionLastFetchMap.remove(it) }
                }.exceptionOrNull()?.let(problems::add)
            }
        } finally {
            runCatching { provider?.let { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) it.close() else @Suppress("DEPRECATION") it.release() } }
                .exceptionOrNull()?.let(problems::add)
            HttpClient.testInterceptor = null
            requestSyncDispatchOverride = null
            ContentResolver.setMasterSyncAutomatically(previousMasterSync)
        }
        problems.firstOrNull()?.let { throw it }
    }

    // ---- (a) the marker through the pinned SDK ----

    /** CONTROL: the pinned SDK keeps a calendar's collection content through a fresh listing and a fetch. */
    @Test fun aMarkedCalendarCreatedWithThePinnedSdkKeepsItsMarkerThroughAFreshListing() {
        val active = uploadCalendar("Birthdays", MARKER_ACTIVE)
        val retired = uploadCalendar("Birthdays (old)", MARKER_RETIRED)
        val listed = freshListing()
        assertArrayEquals(MARKER_ACTIVE.toByteArray(Charsets.UTF_8), listed.getValue(active.uid).content)
        assertArrayEquals(MARKER_RETIRED.toByteArray(Charsets.UTF_8), listed.getValue(retired.uid).content)
        assertArrayEquals(MARKER_ACTIVE.toByteArray(Charsets.UTF_8), server.collectionManager.fetch(active.uid).content)
    }

    @Test fun anActiveMarkerFromAFreshListingIsRecognisedAndARetiredOneIsNot() {
        val active = uploadCalendar("Birthdays", MARKER_ACTIVE)
        val retired = uploadCalendar("Birthdays (old)", MARKER_RETIRED)
        val ordinary = uploadCalendar("Work", "")
        val listed = freshListing()
        assertEquals("FEATURE: an active marker read through the SDK is recognised",
            BirthdayCalendar.MarkerState.ACTIVE, BirthdayCalendar.markerState(listed.getValue(active.uid).content))
        assertEquals("FEATURE: a retired marker is retired, not active",
            BirthdayCalendar.MarkerState.RETIRED, BirthdayCalendar.markerState(listed.getValue(retired.uid).content))
        assertNull("an ordinary calendar is not a Birthdays calendar", BirthdayCalendar.markerState(listed.getValue(ordinary.uid).content))
    }

    // ---- (b) and (c) the calendar provider and the calendar adapter's own sync ----

    @Test fun aLocalCalendarForAnActiveBirthdaysCalendarIsReadOnlyInTheCalendarProvider() {
        val account = newAccount("gen-bday-access")
        val retired = uploadCalendar("Birthdays (old)", MARKER_RETIRED)
        val active = uploadCalendar("Birthdays", MARKER_ACTIVE)
        refresh(account, "gen-bday-access")
        val retiredLocal = createLocal(account, retired.uid)
        val activeLocal = createLocal(account, active.uid)
        assertEquals("a retired Birthdays calendar stays an ordinary owned calendar", Calendars.CAL_ACCESS_OWNER, accessLevel(retiredLocal))
        assertEquals("FEATURE: the active Birthdays calendar is read-only in the calendar provider",
            Calendars.CAL_ACCESS_READ, accessLevel(activeLocal))
    }

    @Test fun anEditOfABirthdayEventInTheCalendarProviderIsRestoredFromTheServerWithoutAnUpload() {
        val account = newAccount("gen-bday-edit")
        val calendar = uploadCalendar("Birthdays", MARKER_ACTIVE)
        val itemUid = uploadEvent(calendar, EVENT_UID, SUMMARY)
        val local = syncedLocal(account, "gen-bday-edit", calendar)
        val row = checkNotNull(eventRow(account, local, itemUid)) { "the server's event reached the provider" }
        assertEquals(SUMMARY, row.title)
        assertEquals(0L, row.dirty)

        assertEquals("the edit reached the provider", 1, editAsCalendarApp(row.id, EDITED))
        assertEquals("a calendar app's edit marks the event dirty", 1L, eventRow(account, local, itemUid)?.dirty)

        val since = fake.requests.size
        val outcome = sync(account, local)
        assertEquals("FEATURE: an edit in the active Birthdays calendar uploads nothing", emptyList<String>(), uploadsTo(calendar.uid, since))
        val restored = checkNotNull(eventRow(account, local, itemUid)) { "the event is still in the provider" }
        assertEquals("FEATURE: the server's content is back in the provider", SUMMARY, restored.title)
        assertEquals("FEATURE: the restored event is no longer dirty", 0L, restored.dirty)
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, outcome)
        assertTrue("the server copy is unchanged", serverEvent(calendar, itemUid).contains("SUMMARY:$SUMMARY"))
    }

    @Test fun aDeleteOfABirthdayEventInTheCalendarProviderIsRestoredFromTheServerWithoutAnUpload() {
        val account = newAccount("gen-bday-delete")
        val calendar = uploadCalendar("Birthdays", MARKER_ACTIVE)
        val itemUid = uploadEvent(calendar, EVENT_UID, SUMMARY)
        val local = syncedLocal(account, "gen-bday-delete", calendar)
        val row = checkNotNull(eventRow(account, local, itemUid)) { "the server's event reached the provider" }

        assertEquals("the delete reached the provider", 1,
            context.contentResolver.delete(ContentUris.withAppendedId(Events.CONTENT_URI, row.id), null, null))
        assertEquals("a calendar app's delete leaves a deleted row for the adapter", 1L, eventRow(account, local, itemUid)?.deleted)

        val since = fake.requests.size
        val outcome = sync(account, local)
        assertEquals("FEATURE: a delete in the active Birthdays calendar uploads nothing", emptyList<String>(), uploadsTo(calendar.uid, since))
        val restored = eventRow(account, local, itemUid)
        assertTrue("FEATURE: the event is back in the provider", restored != null && restored.deleted == 0L)
        assertEquals("FEATURE: with the server's content", SUMMARY, restored?.title)
        assertEquals("FEATURE: and not dirty", 0L, restored?.dirty)
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, outcome)
        assertFalse("the server copy is not deleted", server.collectionManager.getItemManager(calendar).fetch(itemUid).isDeleted)
    }

    /** CONTROL: an edit of an ordinary owned calendar is still uploaded, so the protection is not blanket. */
    @Test fun anEditOfAnEventInAnOrdinaryCalendarIsStillUploaded() {
        val account = newAccount("gen-bday-ordinary")
        val calendar = uploadCalendar("Work", "")
        val itemUid = uploadEvent(calendar, "ordinary-event-1", "Dentist")
        val local = syncedLocal(account, "gen-bday-ordinary", calendar)
        val row = checkNotNull(eventRow(account, local, itemUid)) { "the server's event reached the provider" }
        assertEquals(1, editAsCalendarApp(row.id, EDITED))

        val since = fake.requests.size
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(account, local))
        assertTrue("the edit was uploaded", uploadsTo(calendar.uid, since).isNotEmpty())
        assertTrue("the server holds the edit", serverEvent(calendar, itemUid).contains("SUMMARY:$EDITED"))
        assertEquals(0L, eventRow(account, local, itemUid)?.dirty)
    }

    // ---- (d) the root fence ----

    /**
     * CONTROL (existing primitive, passes): the pinned SDK sends the calendar's root item as an item
     * transaction's dependency; a retirement by another client moves the root, the old fence is then
     * rejected with a conflict and writes nothing, and a fence on the fresh root lands.
     */
    @Test fun thePinnedSdkFencesAnItemWriteOnTheCalendarRootAndARetirementMakesTheFenceStale() {
        val colMgr = server.collectionManager
        val calendar = uploadCalendar("Birthdays", MARKER_ACTIVE)
        val itemMgr = colMgr.getItemManager(calendar)
        val first = itemMgr.create(eventMeta(EVENT_UID), ics(EVENT_UID, SUMMARY))
        var since = fake.uploadDeps.size
        itemMgr.transaction(arrayOf(first), arrayOf(calendar.asItem()))
        assertEquals("the root item is the dependency", listOf(listOf(calendar.uid)), fake.uploadDeps.drop(since))
        assertTrue(first.uid in fake.itemUids(calendar.uid))

        retireElsewhere(calendar.uid)
        val second = itemMgr.create(eventMeta(OTHER_EVENT_UID), ics(OTHER_EVENT_UID, OTHER_SUMMARY))
        try {
            itemMgr.transaction(arrayOf(second), arrayOf(calendar.asItem()))
            fail("a write fenced on the root from before the retirement was accepted")
        } catch (expected: ConflictException) {
        }
        assertFalse("the rejected write left nothing", second.uid in fake.itemUids(calendar.uid))

        since = fake.uploadDeps.size
        itemMgr.transaction(arrayOf(second), arrayOf(colMgr.fetch(calendar.uid).asItem()))
        assertEquals(listOf(listOf(calendar.uid)), fake.uploadDeps.drop(since))
        assertTrue("a fence on the current root lands", second.uid in fake.itemUids(calendar.uid))
    }

    @Test fun aFencedBirthdayWriteLandsWithTheCalendarRootAsItsDependency() {
        val calendar = uploadCalendar("Birthdays", MARKER_ACTIVE)
        val itemMgr = server.collectionManager.getItemManager(calendar)
        val event = itemMgr.create(eventMeta(EVENT_UID), ics(EVENT_UID, SUMMARY))
        val since = fake.uploadDeps.size
        val outcome = BirthdayReconciler.writeFenced(itemMgr, calendar, listOf(event))
        assertEquals("FEATURE: the fenced Birthdays write commits", BirthdayReconciler.WriteOutcome.COMMITTED, outcome)
        assertEquals("FEATURE: in one transaction depending on the calendar root", listOf(listOf(calendar.uid)), fake.uploadDeps.drop(since))
        assertTrue("FEATURE: the event is on the server", event.uid in fake.itemUids(calendar.uid))
    }

    @Test fun aFencedBirthdayWriteAfterRetirementIsRejectedAndWritesNothing() {
        val calendar = uploadCalendar("Birthdays", MARKER_ACTIVE)
        val itemMgr = server.collectionManager.getItemManager(calendar)
        val event = itemMgr.create(eventMeta(EVENT_UID), ics(EVENT_UID, SUMMARY))
        retireElsewhere(calendar.uid)
        val since = fake.uploadDeps.size
        val outcome = BirthdayReconciler.writeFenced(itemMgr, calendar, listOf(event))
        assertEquals("FEATURE: a write fenced on the pre-retirement root reports a conflict",
            BirthdayReconciler.WriteOutcome.CONFLICT, outcome)
        assertEquals("FEATURE: it was sent fenced on the calendar root", listOf(listOf(calendar.uid)), fake.uploadDeps.drop(since))
        assertFalse("nothing was written", event.uid in fake.itemUids(calendar.uid))
    }

    /** CONTROL (existing primitive, passes): the pinned SDK reads a calendar's complete member list. */
    @Test fun theMemberListOfAnOwnedCalendarIsReadCompletelyThroughThePinnedSdk() {
        val calendar = uploadCalendar("Birthdays", MARKER_ACTIVE)
        fake.setMembers(calendar.uid, listOf(username to 1L))
        val members = server.collectionManager.getMemberManager(calendar).list()
        assertTrue(members.isDone)
        assertEquals(listOf(username to CollectionAccessLevel.Admin), members.data.map { it.username to it.accessLevel })
    }

    // ---- fixture ----

    private class Row(val id: Long, val title: String?, val dirty: Long, val deleted: Long)

    private fun uploadCalendar(name: String, content: String): Collection {
        val colMgr = server.collectionManager
        val calendar = colMgr.create(Constants.ETEBASE_TYPE_CALENDAR, ItemMetadata().apply { this.name = name }, content)
        colMgr.upload(calendar)
        return calendar
    }

    private fun eventMeta(eventUid: String) = ItemMetadata().apply {
        name = eventUid
        mtime = 1_000L
    }

    private fun uploadEvent(calendar: Collection, eventUid: String, summary: String): String {
        val itemMgr = server.collectionManager.getItemManager(calendar)
        val item = itemMgr.create(eventMeta(eventUid), ics(eventUid, summary))
        itemMgr.batch(arrayOf(item))
        return item.uid
    }

    /** Another client switches the marker to retired with a collection update, which moves the root revision. */
    private fun retireElsewhere(calendarUid: String) {
        val colMgr = server.collectionManager
        val other = colMgr.fetch(calendarUid)
        other.setContent(MARKER_RETIRED)
        colMgr.upload(other)
    }

    private fun freshListing(): Map<String, Collection> {
        val listed = server.collectionManager.list(Constants.ETEBASE_TYPE_CALENDAR)
        assertTrue("the listing is complete", listed.isDone)
        return listed.data.associateBy { it.uid }
    }

    private fun serverEvent(calendar: Collection, itemUid: String) =
        String(server.collectionManager.getItemManager(calendar).fetch(itemUid).content, Charsets.UTF_8)

    private fun uploadsTo(calendarUid: String, since: Int) = fake.requests.drop(since).filter {
        it.startsWith("POST collection/$calendarUid/item/transaction/") || it.startsWith("POST collection/$calendarUid/item/batch/")
    }

    private fun newAccount(generation: String): Account {
        val account = Account("birthday-boundary-${System.nanoTime()}@example.invalid", App.accountType)
        names += account.name
        check(manager.addAccountExplicitly(account, null, null))
        for (authority in adapterAuthorities) ContentResolver.setIsSyncable(account, authority, 0)
        AccountSettings.setUserData(manager, account, URI(fake.baseUrl), account.name)
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
        AccountSettings(context, account).etebaseSession = session
        return account
    }

    private fun removeAccount(account: Account) {
        if (account !in manager.getAccountsByType(account.type)) return
        val removed = CountDownLatch(1)
        var confirmed = false
        AndroidCompat.removeAccount(manager, account) {
            confirmed = it
            removed.countDown()
        }
        assertTrue("account removal callback timed out", removed.await(10, TimeUnit.SECONDS))
        assertTrue("account removal was not confirmed", confirmed)
    }

    private fun cache(account: Account) = EtebaseLocalCache.getInstance(context, account.name)

    /** The shared collection refresh, from scratch, as the app runs it. */
    private fun refresh(account: Account, generation: String) {
        val settings = AccountSettings(context, account)
        HttpClient.Builder(context, settings).setForeground(false).build().use {
            CollectionListRefresh.run(context, account, settings, it.okHttpClient, forceRefresh = true, creationId = generation)
        }
    }

    private fun createLocal(account: Account, calendarUid: String): LocalCalendar {
        val provider = checkNotNull(provider)
        val cached = cache(account).let { synchronized(it) { it.collectionGet(server.collectionManager, calendarUid) } }
        LocalCalendar.create(account, provider, cached)
        return checkNotNull(LocalCalendar.findByName(account, provider, LocalCalendar.Factory, calendarUid))
    }

    /** Refresh, local calendar, and a first successful adapter sync that brings the server's events in. */
    private fun syncedLocal(account: Account, generation: String, calendar: Collection): LocalCalendar {
        refresh(account, generation)
        val local = createLocal(account, calendar.uid)
        assertEquals("the first sync succeeds", SyncManager.ProviderOutcome.SUCCESS, sync(account, local))
        return local
    }

    /** The calendar adapter's own sync, as its sync service runs it. */
    private fun sync(account: Account, calendar: LocalCalendar): SyncManager.ProviderOutcome =
        CalendarSyncManager(context, account, AccountSettings(context, account), Bundle(), CalendarContract.AUTHORITY, SyncResult(),
            calendar, fake.baseUrl.toHttpUrl()).use { it.performSync() }

    /** An edit through the plain provider URI, as a calendar app makes it (not as the sync adapter). */
    private fun editAsCalendarApp(eventId: Long, title: String) = context.contentResolver.update(
        ContentUris.withAppendedId(Events.CONTENT_URI, eventId), ContentValues().apply { put(Events.TITLE, title) }, null, null)

    private fun accessLevel(calendar: LocalCalendar): Int =
        checkNotNull(checkNotNull(provider).query(ContentUris.withAppendedId(Calendars.CONTENT_URI, calendar.id),
            arrayOf(Calendars.CALENDAR_ACCESS_LEVEL), null, null, null)).use {
            check(it.moveToFirst()) { "the calendar row exists" }
            it.getInt(0)
        }

    /** The event row for [fileName], deleted rows included, read as the sync adapter so nothing is hidden. */
    private fun eventRow(account: Account, calendar: LocalCalendar, fileName: String): Row? =
        checkNotNull(checkNotNull(provider).query(asSyncAdapter(Events.CONTENT_URI, account),
            arrayOf(Events._ID, Events.TITLE, Events.DIRTY, Events.DELETED),
            "${Events.CALENDAR_ID}=? AND ${Events._SYNC_ID}=?", arrayOf(calendar.id.toString(), fileName), null)).use {
            check(it.count <= 1) { "one row per event file name" }
            if (it.moveToFirst()) Row(it.getLong(0), it.getString(1), it.getLong(2), it.getLong(3)) else null
        }

    private fun asSyncAdapter(uri: Uri, account: Account): Uri = uri.buildUpon()
        .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
        .appendQueryParameter(Calendars.ACCOUNT_NAME, account.name)
        .appendQueryParameter(Calendars.ACCOUNT_TYPE, account.type)
        .build()

    companion object {
        /** The shared-v1 marker bytes (`contracts/birthday-calendar/v1-vectors.json`, marker vectors 1 and 2). */
        private const val MARKER_ACTIVE = "{\"type\":\"silentsuite.birthdays\",\"v\":1,\"state\":\"active\"}"
        private const val MARKER_RETIRED = "{\"type\":\"silentsuite.birthdays\",\"v\":1,\"state\":\"retired\"}"

        /** Identity vector 1 and 2 UIDs; the event texts are fixtures, not generator output. */
        private const val EVENT_UID = "ss-bday1-c8970a5b3457981540f4ee428f84a1f4"
        private const val OTHER_EVENT_UID = "ss-bday1-1615be37fbc2437021b9d4f73fdac5e2"
        private const val SUMMARY = "🎂 Ada Lovelace"
        private const val OTHER_SUMMARY = "🎂 Lee"
        private const val EDITED = "Edited by a calendar app"

        private fun ics(uid: String, summary: String) =
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SilentSuite//Birthdays v1//EN\r\nBEGIN:VEVENT\r\nUID:$uid\r\n" +
                "DTSTAMP:19720101T000000Z\r\nDTSTART;VALUE=DATE:19721210\r\nDTEND;VALUE=DATE:19721211\r\nRRULE:FREQ=YEARLY\r\n" +
                "SUMMARY:$summary\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

        private val username = "birthday-boundary-${System.nanoTime()}"

        /** One Etebase signup for the whole class; the session works against any stand-in server. */
        private val session: String by lazy {
            val fake = FakeEtebaseServer()
            val client = Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
            com.etebase.client.Account.signup(client, User(username, "birthday-boundary@example.invalid"), "stand-in-server-only").save(null)
        }
    }
}
