package io.silentsuite.sync.syncadapter

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderClient
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.SyncResult
import android.net.Uri
import android.os.Bundle
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import at.bitfire.ical4android.TaskProvider
import com.etebase.client.Client
import com.etebase.client.ItemMetadata
import com.etebase.client.User
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.notes.FakeEtebaseServer
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.utils.AndroidCompat
import net.fortuna.ical4j.model.TimeZoneRegistryFactory
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The calendar adapter's one-time listing from the start (internal #887), run through the real
 * [CalendarSyncManager], Etebase binding, local cache and calendar provider against the in-process
 * [FakeEtebaseServer]. Each case first syncs a calendar for real, then puts it in the state an older
 * app version left behind: no time zone rules marker, and event rows whose instants were written with
 * ical4j's bundled 2020 rules, at the etag the server still holds and with the item cursor saved.
 *
 * One case checks that only a listing that reaches its done page sets the marker, that the replay
 * rewrites the stale row without uploading anything, and that the next run lists from the saved cursor
 * again. Two cases check that an unchanged event whose exception was changed or deleted on this device
 * is not rewritten by the replay. One case checks that the minified app creates the registry
 * that reads the device's rules.
 */
@RunWith(AndroidJUnit4::class)
class CalendarTimeZoneReplayRuntimeTest {
    @get:Rule
    val calendarPermissions: GrantPermissionRule =
        GrantPermissionRule.grant(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager = AccountManager.get(context)
    private val fake = FakeEtebaseServer()
    private val accounts = mutableListOf<Account>()
    private var provider: ContentProviderClient? = null
    private var previousMasterSync = true

    /** The server side as the test sees it: the same Etebase user, talking to the same stand-in. */
    private val server by lazy {
        com.etebase.client.Account.restore(Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl), session, null)
    }

    @Before fun setUp() {
        previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        // No platform adapter sync may reach the stand-in server or touch the calendar meanwhile.
        ContentResolver.setMasterSyncAutomatically(false)
        HttpClient.testInterceptor = fake
        requestSyncDispatchOverride = { _, _, _ -> }
    }

    @After fun tearDown() {
        fake.releaseAll()
        val problems = mutableListOf<Throwable>()
        try {
            for (account in accounts) {
                runCatching { deleteCalendars(account) }.exceptionOrNull()?.let(problems::add)
                runCatching { removeAccount(account) }.exceptionOrNull()?.let(problems::add)
                runCatching {
                    EtebaseLocalCache.clearUserCache(context, account.name)
                    CollectionListRefresh.collectionLastFetchMap.keys.filter { it.startsWith("${account.name}\u0000") }
                        .forEach { CollectionListRefresh.collectionLastFetchMap.remove(it) }
                }.exceptionOrNull()?.let(problems::add)
            }
        } finally {
            runCatching { provider?.close() }
            HttpClient.testInterceptor = null
            requestSyncDispatchOverride = null
            ContentResolver.setMasterSyncAutomatically(previousMasterSync)
        }
        problems.firstOrNull()?.let { throw it }
    }

    @Test fun aCalendarWithoutTheMarkerIsReadAgainOnceAndOnlyAFinishedListingSetsIt() {
        // Correct is whatever the device's own rules say (16:00Z/17:00Z with tzdata 2022f or newer; older
        // system images such as API 29's still have summer time). Stale is an hour off, as ical4j's
        // bundled 2020 rules converted 10:00 and 11:00 on current devices.
        val mexicoCity = ZoneId.of("America/Mexico_City")
        val correctStart = LocalDateTime.of(2026, 7, 15, 10, 0).atZone(mexicoCity).toInstant().toEpochMilli()
        val correctEnd = LocalDateTime.of(2026, 7, 15, 11, 0).atZone(mexicoCity).toInstant().toEpochMilli()
        val staleStart = correctStart - HOUR
        val staleEnd = correctEnd - HOUR

        val f = seed("gen-tz-replay", listOf(MEXICO_CITY_EVENT, BERLIN_EVENT))
        val (staleUid, controlUid) = f.itemUids
        val seeded = master(f, staleUid)
        assertEquals("the first sync used the device's rules", correctStart, seeded.dtStart)
        assertEquals(correctEnd, seeded.dtEnd)
        val etag = checkNotNull(seeded.eTag) { "the seeding sync stored the etag" }
        val control = master(f, controlUid)
        assertEquals("the control event is unaffected by any rule change", Instant.parse("2026-07-15T08:00:00Z").toEpochMilli(), control.dtStart)
        assertEquals(Instant.parse("2026-07-15T09:00:00Z").toEpochMilli(), control.dtEnd)

        // The state an older app version left behind.
        clearMarker(f)
        makeStale(f, seeded.id, staleStart, staleEnd)

        // Run 1: the listing from the start never reaches its done page.
        fake.stallItemList(f.calendarUid, FakeEtebaseServer.Stall.SAME_CURSOR)
        val first = fake.requests.size
        assertEquals(SyncManager.ProviderOutcome.FAILURE, sync(f))
        assertTrue("run 1 listed from the start: ${itemLists(f, first)}", itemLists(f, first).any { !it.contains("stoken=") })
        assertFalse("a listing that never finished leaves the marker absent", f.calendar.timeZoneRulesCurrent())

        // Run 2: the listing finishes. Run 1 applied the page it got, so the row is made stale again first.
        fake.stallItemList(f.calendarUid, null)
        makeStale(f, seeded.id, staleStart, staleEnd)
        val second = fake.requests.size
        val uploadsBefore = fake.uploadSizes.size
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(f))
        assertTrue("run 2 listed from the start: ${itemLists(f, second)}", itemLists(f, second).any { !it.contains("stoken=") })
        val corrected = master(f, staleUid)
        assertEquals("the same row was rewritten", seeded.id, corrected.id)
        assertEquals("corrected start", correctStart, corrected.dtStart)
        assertEquals("corrected end", correctEnd, corrected.dtEnd)
        assertEquals("the etag is unchanged", etag, corrected.eTag)
        assertEquals("the corrected row is clean", 0, corrected.dirty)
        val controlAfter = master(f, controlUid)
        assertEquals("the control event is unchanged", control, controlAfter)
        assertEquals("the control event is clean", 0, controlAfter.dirty)
        assertEquals("the replay uploaded nothing", emptyList<String>(), uploads(second))
        assertEquals("no upload reached the server", uploadsBefore, fake.uploadSizes.size)
        assertTrue("the marker is set once the listing finished", f.calendar.timeZoneRulesCurrent())
        assertEquals("the cursor of the done page is saved", fake.itemStoken(f.calendarUid), cursor(f))

        // Run 3: no replay. A row made stale again stays as it is.
        makeStale(f, seeded.id, staleStart, staleEnd)
        val third = fake.requests.size
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(f))
        assertTrue("run 3 did not list from the start: ${itemLists(f, third)}", itemLists(f, third).none { !it.contains("stoken=") })
        val untouched = master(f, staleUid)
        assertEquals("not rewritten without a replay", staleStart, untouched.dtStart)
        assertEquals(staleEnd, untouched.dtEnd)
        assertEquals(etag, untouched.eTag)
        assertEquals(0, untouched.dirty)
        assertEquals(control, master(f, controlUid))
        assertEquals("nothing uploaded", emptyList<String>(), uploads(third))
        assertTrue(f.calendar.timeZoneRulesCurrent())
    }

    @Test fun anUnchangedEventWhoseExceptionWasChangedOnThisDeviceIsNotRewrittenByTheReplay() {
        val f = seed("gen-tz-replay-dirty", listOf(RECURRING_EVENT))
        val uid = f.itemUids.single()
        val seeded = master(f, uid)
        val exception = exceptions(f).single()
        clearMarker(f)
        // The master as an older version stored it, an hour off, and the exception edited on this device.
        writeRow(f, seeded.id, ContentValues().apply { put(Events.DTSTART, seeded.dtStart - HOUR) })
        writeRow(f, exception.id, ContentValues().apply {
            put(Events.TITLE, LOCAL_TITLE)
            put(Events.DIRTY, 1)
        })
        val masterBefore = master(f, uid)
        val exceptionBefore = exceptions(f).single()
        assertEquals(seeded.dtStart - HOUR, masterBefore.dtStart)
        assertEquals("the master itself is clean", 0, masterBefore.dirty)
        assertEquals(exception.id, exceptionBefore.id)
        assertEquals(LOCAL_TITLE, exceptionBefore.title)
        assertEquals("the exception's change waits for upload", 1, exceptionBefore.dirty)

        val since = fake.requests.size
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(f))
        assertTrue("the run listed from the start: ${itemLists(f, since)}", itemLists(f, since).any { !it.contains("stoken=") })
        val masterAfter = master(f, uid)
        assertEquals("the master row was kept", masterBefore.id, masterAfter.id)
        assertEquals("the master's instants were not rewritten", masterBefore.dtStart, masterAfter.dtStart)
        assertEquals(masterBefore.eTag, masterAfter.eTag)
        assertEquals("the change now waits for upload on the master", 1, masterAfter.dirty)
        val exceptionAfter = exceptions(f).single()
        assertEquals("the exception row was not recreated", exceptionBefore.id, exceptionAfter.id)
        assertEquals("the exception keeps its local change", LOCAL_TITLE, exceptionAfter.title)
        assertTrue("the replay itself finished", f.calendar.timeZoneRulesCurrent())
    }

    @Test fun anUnchangedEventWhoseExceptionWasDeletedOnThisDeviceIsNotRewrittenByTheReplay() {
        val f = seed("gen-tz-replay-deleted", listOf(RECURRING_EVENT))
        val uid = f.itemUids.single()
        val seeded = master(f, uid)
        val exception = exceptions(f).single()
        clearMarker(f)
        writeRow(f, seeded.id, ContentValues().apply { put(Events.DTSTART, seeded.dtStart - HOUR) })
        // Deleted on this device and not yet uploaded.
        writeRow(f, exception.id, ContentValues().apply {
            put(Events.DELETED, 1)
            put(Events.DIRTY, 1)
        })
        val masterBefore = master(f, uid)
        assertEquals(seeded.dtStart - HOUR, masterBefore.dtStart)
        assertEquals("the master itself is clean", 0, masterBefore.dirty)
        assertEquals("the exception is marked deleted", 1, exceptions(f).single().deleted)

        val since = fake.requests.size
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(f))
        assertTrue("the run listed from the start: ${itemLists(f, since)}", itemLists(f, since).any { !it.contains("stoken=") })
        val masterAfter = master(f, uid)
        assertEquals("the master row was kept", masterBefore.id, masterAfter.id)
        assertEquals("the master's instants were not rewritten", masterBefore.dtStart, masterAfter.dtStart)
        assertEquals(masterBefore.eTag, masterAfter.eTag)
        assertEquals("the deletion now waits for upload on the master", 1, masterAfter.dirty)
        assertEquals("the deleted exception was not recreated from the server copy", emptyList<Row>(), exceptions(f))
        assertTrue("the replay itself finished", f.calendar.timeZoneRulesCurrent())
    }

    @Test fun theMinifiedAppReadsTimeZonesThroughTheSystemRulesRegistry() {
        // A string, not the class: the check is that the name in ical4j.properties survives minification.
        assertEquals("at.bitfire.ical4android.SystemTimeZoneRegistryFactory", TimeZoneRegistryFactory.getInstance().javaClass.name)
    }

    // ---- helpers ----

    private class Fixture(
        val account: Account,
        val settings: AccountSettings,
        val calendarUid: String,
        val calendar: LocalCalendar,
        /** The server's item uids, which are the rows' _SYNC_IDs, in upload order. */
        val itemUids: List<String>,
    )

    private data class Row(
        val id: Long,
        val dtStart: Long,
        val dtEnd: Long?,
        val eTag: String?,
        val dirty: Int,
        val deleted: Int,
        val title: String?,
    )

    /**
     * A calendar on the stand-in server holding [contents], one item each, listed into the account's
     * cache and synced once for real, which writes the rows, caches the items and saves the cursor.
     */
    private fun seed(generation: String, contents: List<String>): Fixture {
        val account = newAccount(generation)
        val settings = AccountSettings(context, account)
        val colMgr = server.collectionManager
        val remote = colMgr.create(Constants.ETEBASE_TYPE_CALENDAR, ItemMetadata().apply { name = "Time zone replay" }, "")
        colMgr.upload(remote)
        val itemMgr = colMgr.getItemManager(remote)
        val itemUids = contents.mapIndexed { index, content ->
            val item = itemMgr.create(ItemMetadata().apply {
                name = "event-$index"
                mtime = 1_000L + index
            }, content)
            itemMgr.batch(arrayOf(item))
            item.uid
        }
        // Listed after the items exist, so the cached collection's cursor is the one a full fetch ends at.
        HttpClient.Builder(context, settings).setForeground(false).build().use {
            CollectionListRefresh.run(context, account, settings, it.okHttpClient, forceRefresh = true, creationId = generation)
        }
        val client = calendarProvider()
        val cached = EtebaseLocalCache.getInstance(context, account.name).let { synchronized(it) { it.collectionGet(colMgr, remote.uid) } }
        LocalCalendar.create(account, client, cached)
        val calendar = checkNotNull(LocalCalendar.findByName(account, client, LocalCalendar.Factory, remote.uid))
        val fixture = Fixture(account, settings, remote.uid, calendar, itemUids)
        assertEquals("the seeding sync succeeded", SyncManager.ProviderOutcome.SUCCESS, sync(fixture))
        assertTrue("the seeding sync set the marker", calendar.timeZoneRulesCurrent())
        assertEquals(fake.itemStoken(remote.uid), cursor(fixture))
        return fixture
    }

    /** The calendar adapter's own sync, as its sync service runs it. */
    private fun sync(f: Fixture): SyncManager.ProviderOutcome =
        CalendarSyncManager(context, f.account, f.settings, Bundle(), CalendarContract.AUTHORITY, SyncResult(),
            f.calendar, fake.baseUrl.toHttpUrl()).use { it.performSync() }

    /** As a calendar synced before the time zone fix: the marker column is empty. */
    private fun clearMarker(f: Fixture) {
        val values = ContentValues().apply { putNull(LocalCalendar.COLUMN_TIME_ZONE_RULES) }
        assertEquals(1, calendarProvider().update(syncAdapter(ContentUris.withAppendedId(Calendars.CONTENT_URI, f.calendar.id), f.account), values, null, null))
        assertFalse("the marker reads back as absent", f.calendar.timeZoneRulesCurrent())
    }

    /** Writes the instants the bundled 2020 rules gave, as the sync adapter, so the row stays clean. */
    private fun makeStale(f: Fixture, id: Long, start: Long, end: Long) {
        writeRow(f, id, ContentValues().apply {
            put(Events.DTSTART, start)
            put(Events.DTEND, end)
        })
        val row = rows(f, "${Events._ID}=?", arrayOf(id.toString())).single()
        assertEquals(start, row.dtStart)
        assertEquals(end, row.dtEnd)
        assertEquals("a stale row is clean", 0, row.dirty)
    }

    private fun writeRow(f: Fixture, id: Long, values: ContentValues) {
        assertEquals(1, calendarProvider().update(syncAdapter(ContentUris.withAppendedId(Events.CONTENT_URI, id), f.account), values, null, null))
    }

    private fun master(f: Fixture, fileName: String): Row =
        rows(f, "${Events._SYNC_ID}=? AND ${Events.ORIGINAL_ID} IS NULL", arrayOf(fileName)).single()

    private fun exceptions(f: Fixture): List<Row> = rows(f, "${Events.ORIGINAL_ID} IS NOT NULL", emptyArray())

    private fun rows(f: Fixture, selection: String, args: Array<String>): List<Row> {
        val projection = arrayOf(Events._ID, Events.DTSTART, Events.DTEND, ETAG, Events.DIRTY, Events.DELETED, Events.TITLE)
        val result = mutableListOf<Row>()
        checkNotNull(calendarProvider().query(syncAdapter(Events.CONTENT_URI, f.account), projection,
            "${Events.CALENDAR_ID}=? AND ($selection)", arrayOf(f.calendar.id.toString()) + args, "${Events._ID} ASC")).use { cursor ->
            while (cursor.moveToNext()) {
                result += Row(
                    id = cursor.getLong(0),
                    dtStart = cursor.getLong(1),
                    dtEnd = if (cursor.isNull(2)) null else cursor.getLong(2),
                    eTag = cursor.getString(3),
                    dirty = cursor.getInt(4),
                    deleted = cursor.getInt(5),
                    title = cursor.getString(6),
                )
            }
        }
        return result
    }

    /** Requests listing the calendar's items, with their query. */
    private fun itemLists(f: Fixture, since: Int) =
        fake.requests.drop(since).filter { it.substringBefore('?') == "GET collection/${f.calendarUid}/item/" }

    /** Every item upload since request [since]. */
    private fun uploads(since: Int) = fake.requests.drop(since).filter { UPLOAD.matches(it.substringBefore('?')) }

    private fun cursor(f: Fixture): String? =
        EtebaseLocalCache.getInstance(context, f.account.name).let { synchronized(it) { it.collectionLoadStoken(f.calendarUid) } }

    private fun calendarProvider(): ContentProviderClient = provider
        ?: checkNotNull(context.contentResolver.acquireContentProviderClient(CalendarContract.AUTHORITY)).also { provider = it }

    private fun syncAdapter(uri: Uri, account: Account): Uri = uri.buildUpon()
        .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
        .appendQueryParameter(Calendars.ACCOUNT_NAME, account.name)
        .appendQueryParameter(Calendars.ACCOUNT_TYPE, account.type)
        .build()

    private fun newAccount(generation: String): Account {
        val account = Account("tz-replay-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(account, null, null))
        accounts += account
        // Nothing is scheduled or started for this account by the platform.
        for (authority in TaskProvider.TASK_PROVIDERS.map { it.authority } + listOf(CalendarContract.AUTHORITY, App.addressBooksAuthority))
            ContentResolver.setIsSyncable(account, authority, 0)
        AccountSettings.setUserData(manager, account, URI(fake.baseUrl), account.name)
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
        AccountSettings(context, account).etebaseSession = session
        check(AccountSettings.writeCollectionListTypes(manager, account, CollectionListRefresh.discoveryTypesKey))
        return account
    }

    private fun deleteCalendars(account: Account) {
        calendarProvider().delete(syncAdapter(Calendars.CONTENT_URI, account),
            "${Calendars.ACCOUNT_NAME}=? AND ${Calendars.ACCOUNT_TYPE}=?", arrayOf(account.name, account.type))
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

    companion object {
        private val UPLOAD = Regex("POST collection/[^/]+/item/(transaction|batch)/")
        private const val HOUR = 3_600_000L
        private const val LOCAL_TITLE = "Stand-up, moved on this device"

        /** The etag column [io.silentsuite.sync.resource.LocalEvent] writes. */
        private const val ETAG = Events.SYNC_DATA1

        private fun ics(vararg lines: String) =
            (listOf("BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SilentSuite//time zone replay test//EN") +
                lines + "END:VCALENDAR").joinToString("\r\n", postfix = "\r\n")

        /** No VTIMEZONE: the zone comes from the time zone registry. */
        private val MEXICO_CITY_EVENT = ics(
            "BEGIN:VEVENT",
            "UID:tz-replay-mexico-city@silentsuite.invalid",
            "DTSTAMP:20260101T000000Z",
            "DTSTART;TZID=America/Mexico_City:20260715T100000",
            "DTEND;TZID=America/Mexico_City:20260715T110000",
            "SUMMARY:Call with Mexico City",
            "END:VEVENT",
        )

        /** A zone whose 2026 rules are the same in every tzdata release since 2020. */
        private val BERLIN_EVENT = ics(
            "BEGIN:VEVENT",
            "UID:tz-replay-berlin@silentsuite.invalid",
            "DTSTAMP:20260101T000000Z",
            "DTSTART;TZID=Europe/Berlin:20260715T100000",
            "DTEND;TZID=Europe/Berlin:20260715T110000",
            "SUMMARY:Call with Berlin",
            "END:VEVENT",
        )

        /** A daily event with one moved occurrence, which the provider stores as an exception row. */
        private val RECURRING_EVENT = ics(
            "BEGIN:VEVENT",
            "UID:tz-replay-recurring@silentsuite.invalid",
            "DTSTAMP:20260101T000000Z",
            "DTSTART;TZID=America/Mexico_City:20260715T100000",
            "DTEND;TZID=America/Mexico_City:20260715T110000",
            "RRULE:FREQ=DAILY;COUNT=3",
            "SUMMARY:Stand-up",
            "END:VEVENT",
            "BEGIN:VEVENT",
            "UID:tz-replay-recurring@silentsuite.invalid",
            "DTSTAMP:20260101T000000Z",
            "RECURRENCE-ID;TZID=America/Mexico_City:20260716T100000",
            "DTSTART;TZID=America/Mexico_City:20260716T120000",
            "DTEND;TZID=America/Mexico_City:20260716T130000",
            "SUMMARY:Stand-up, moved",
            "END:VEVENT",
        )

        /**
         * One Etebase signup for the whole class: its key derivation takes seconds, and the session
         * works against any stand-in server, which keeps no state about users.
         */
        private val session: String by lazy {
            val fake = FakeEtebaseServer()
            val client = Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
            com.etebase.client.Account.signup(client, User("tz-replay-${System.nanoTime()}", "tz-replay@example.invalid"),
                "stand-in-server-only").save(null)
        }
    }
}
