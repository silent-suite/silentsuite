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
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URI
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A new item whose upload answer is lost after the server applied it. The real [CalendarSyncManager]
 * runs against the in-process [FakeEtebaseServer] (the app's [HttpClient.testInterceptor]);
 * [FakeEtebaseServer.loseAnswer] applies the upload and then drops the connection: the server has the
 * item, the device never heard so.
 *
 * SyncManager.prepareLocalItemForUpload writes the new item's uid A into the provider row before the
 * upload, and pushItems caches the item only after batch() returns. With the answer lost, A is on the
 * server but not in the cache, and the row stays dirty. The next run pushes before it lists. It used to
 * miss A in the cache and create a second item B, and the listing then brought A back as a second
 * event. Now a new item is kept on the device (EtebaseLocalCache.pendingCreateSave) until its upload is
 * confirmed, and the next run uploads that same item A again: a batch updates A when the server has it
 * and creates it when the server does not, so there is never a second item.
 */
@RunWith(AndroidJUnit4::class)
class LostBatchAnswerDuplicateRuntimeTest {
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
        fake.clearAnswers()
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

    /** CONTROL: a creation whose answer arrives makes one server item and one local event, stable on resync. */
    @Test fun controlACreationWithItsAnswerMakesOneItemAndOneEvent() {
        val (account, remote, local) = syncedEmptyCalendar("lost-batch-control")
        insertAsCalendarApp(local, "Dentist")

        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(account, local))
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(account, local))

        assertEquals("one server item", 1, liveServerItems(remote).size)
        assertEquals("one local event: ${localRows(local)}", 1, localRows(local).size)
    }

    /** CONTROL: an already-cached edit whose answer is lost reuses its item, so no duplicate appears. */
    @Test fun controlACachedEditWithALostAnswerReusesItsItem() {
        val (account, remote, local) = syncedEmptyCalendar("lost-batch-edit")
        val id = insertAsCalendarApp(local, "Dentist")
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(account, local))
        val itemUid = liveServerItems(remote).single()

        editAsCalendarApp(id, "Dentist (moved)")
        fake.loseAnswer("POST", batchOf(remote.uid))
        assertEquals("the lost answer fails the run", SyncManager.ProviderOutcome.FAILURE, sync(account, local))
        assertEquals("the scripted loss was used", 0, fake.pendingAnswers())
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(account, local))

        assertEquals("still the one original item", listOf(itemUid), liveServerItems(remote))
        assertEquals("one local event: ${localRows(local)}", 1, localRows(local).size)
    }

    /** A new event whose batch() answer is lost after the server applied it is not created twice. */
    @Test fun aNewEventWhoseBatchAnswerIsLostIsNotDuplicated() {
        val (account, remote, local) = syncedEmptyCalendar("lost-batch-create")
        val id = insertAsCalendarApp(local, "Dentist")
        val committed = loseTheCreationAnswer(account, remote, local)
        editAsCalendarApp(id, "Dentist (moved)")

        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(account, local))

        val items = liveServerItems(remote)
        val rows = localRows(local)
        val icalUids = items.map { serverEventUid(remote, it) }
        assertEquals("one server item for one event; items=$items iCalendar UIDs=$icalUids", 1, items.size)
        assertEquals("one local event; rows=$rows", 1, rows.size)
        assertEquals("the local event keeps item A", committed, rows.single().syncId)
        assertEquals("the local event is uploaded", 0L, rows.single().dirty)
        assertEquals("the server holds only item A", setOf(committed), fake.itemUids(remote.uid))
        assertTrue("item A has the edit made after the loss",
            serverContent(remote, committed).lineSequence().any { it.trim() == "SUMMARY:Dentist (moved)" })
        assertTrue("the kept copy of A is gone once A is cached", committed !in pendingCreates())
    }

    /** A new event deleted on the device after its creation answer was lost is deleted on the server too. */
    @Test fun aNewEventDeletedAfterItsBatchAnswerWasLostIsDeletedOnTheServer() {
        val (account, remote, local) = syncedEmptyCalendar("lost-batch-delete")
        val id = insertAsCalendarApp(local, "Dentist")
        val committed = loseTheCreationAnswer(account, remote, local)

        context.contentResolver.delete(ContentUris.withAppendedId(Events.CONTENT_URI, id), null, null)
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(account, local))
        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(account, local))

        assertEquals("no live server item", emptyList<String>(), liveServerItems(remote))
        assertEquals("item A itself was deleted, no other item made", setOf(committed), fake.itemUids(remote.uid))
        assertTrue("no local event: ${localRows(local)}", localRows(local).isEmpty())
        assertTrue("the kept copy of A is gone once its deletion is uploaded", committed !in pendingCreates())
    }

    /** A new event whose upload never reached the server is uploaded on the next run as the same item, once. */
    @Test fun aNewEventWhoseUploadNeverArrivedIsUploadedOnce() {
        val (account, remote, local) = syncedEmptyCalendar("lost-batch-unsent")
        insertAsCalendarApp(local, "Dentist")

        fake.answer("POST", batchOf(remote.uid), code = null)
        assertEquals("the dropped upload fails the run", SyncManager.ProviderOutcome.FAILURE, sync(account, local))
        assertEquals("the scripted drop was used", 0, fake.pendingAnswers())
        assertTrue("nothing reached the server", fake.itemUids(remote.uid).isEmpty())
        val unsent = checkNotNull(localRows(local).single().syncId) { "the row carries the unsent item's uid" }

        assertEquals(SyncManager.ProviderOutcome.SUCCESS, sync(account, local))

        val items = liveServerItems(remote)
        val rows = localRows(local)
        assertEquals("the same item was uploaded, once; items=$items", listOf(unsent), items)
        assertEquals("one local event; rows=$rows", 1, rows.size)
        assertEquals("the local event names the uploaded item", unsent, rows.single().syncId)
        assertEquals("the local event is uploaded", 0L, rows.single().dirty)
        assertTrue("the kept copy is gone once the item is cached", unsent !in pendingCreates())
    }

    // ---- fixture ----

    /** Uploads the calendar's one new event with its answer lost, and returns the item uid the server keeps. */
    private fun loseTheCreationAnswer(account: Account, remote: Collection, local: LocalCalendar): String {
        fake.loseAnswer("POST", batchOf(remote.uid))
        assertEquals("the lost answer fails the run", SyncManager.ProviderOutcome.FAILURE, sync(account, local))
        assertEquals("the scripted loss was used", 0, fake.pendingAnswers())
        val committed = liveServerItems(remote)
        assertEquals("the server applied the creation (item A)", 1, committed.size)
        val afterLoss = localRows(local).single()
        assertEquals("the row already carries A as its file name", committed.single(), afterLoss.syncId)
        assertEquals("the row is still dirty", 1L, afterLoss.dirty)
        assertTrue("A is kept on the device until its upload is confirmed", committed.single() in pendingCreates())
        return committed.single()
    }

    /** The item uids of every new item kept on the device until its upload is confirmed, all accounts. */
    private fun pendingCreates(): List<String> =
        File(context.noBackupFilesDir, "etebase-pending-creates").walkTopDown().filter { it.isFile }.map { it.name }.toList()

    private fun serverContent(calendar: Collection, itemUid: String): String {
        val itemMgr = server.collectionManager.getItemManager(server.collectionManager.fetch(calendar.uid))
        return String(itemMgr.fetch(itemUid).content, Charsets.UTF_8)
    }

    private data class Row(val id: Long, val syncId: String?, val title: String?, val dirty: Long)

    private fun batchOf(calendarUid: String) = Regex(Regex.escape("collection/$calendarUid/item/batch/"))

    private fun syncedEmptyCalendar(generation: String): Triple<Account, Collection, LocalCalendar> {
        val colMgr = server.collectionManager
        val remote = colMgr.create(Constants.ETEBASE_TYPE_CALENDAR, ItemMetadata().apply { name = "Personal" }, "")
        colMgr.upload(remote)
        val account = newAccount(generation)
        val settings = AccountSettings(context, account)
        HttpClient.Builder(context, settings).setForeground(false).build().use {
            CollectionListRefresh.run(context, account, settings, it.okHttpClient, forceRefresh = true, creationId = generation)
        }
        val cached = EtebaseLocalCache.getInstance(context, account.name).let { synchronized(it) { it.collectionGet(colMgr, remote.uid) } }
        LocalCalendar.create(account, checkNotNull(provider), cached)
        val local = checkNotNull(LocalCalendar.findByName(account, checkNotNull(provider), LocalCalendar.Factory, remote.uid))
        assertEquals("the first sync succeeds", SyncManager.ProviderOutcome.SUCCESS, sync(account, local))
        return Triple(account, remote, local)
    }

    private fun sync(account: Account, calendar: LocalCalendar): SyncManager.ProviderOutcome =
        CalendarSyncManager(context, account, AccountSettings(context, account), Bundle(), CalendarContract.AUTHORITY, SyncResult(),
            calendar, fake.baseUrl.toHttpUrl()).use { it.performSync() }

    /** A new event as a calendar app inserts it (not as the sync adapter), so it is dirty with no file name. */
    private fun insertAsCalendarApp(calendar: LocalCalendar, title: String): Long {
        val start = 1_900_000_000_000L
        val uri = checkNotNull(context.contentResolver.insert(Events.CONTENT_URI, ContentValues().apply {
            put(Events.CALENDAR_ID, calendar.id)
            put(Events.TITLE, title)
            put(Events.DTSTART, start)
            put(Events.DTEND, start + 3_600_000L)
            put(Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
        }))
        return ContentUris.parseId(uri)
    }

    private fun editAsCalendarApp(eventId: Long, title: String) = context.contentResolver.update(
        ContentUris.withAppendedId(Events.CONTENT_URI, eventId), ContentValues().apply { put(Events.TITLE, title) }, null, null)

    private fun localRows(calendar: LocalCalendar): List<Row> =
        checkNotNull(checkNotNull(provider).query(asSyncAdapter(Events.CONTENT_URI, calendar.account),
            arrayOf(Events._ID, Events._SYNC_ID, Events.TITLE, Events.DIRTY),
            "${Events.CALENDAR_ID}=? AND ${Events.DELETED}=0", arrayOf(calendar.id.toString()), null)).use {
            val rows = mutableListOf<Row>()
            while (it.moveToNext()) rows += Row(it.getLong(0), it.getString(1), it.getString(2), it.getLong(3))
            rows
        }

    private fun liveServerItems(calendar: Collection): List<String> {
        val itemMgr = server.collectionManager.getItemManager(server.collectionManager.fetch(calendar.uid))
        return fake.itemUids(calendar.uid).filter { !itemMgr.fetch(it).isDeleted }.sorted()
    }

    private fun serverEventUid(calendar: Collection, itemUid: String): String? {
        val itemMgr = server.collectionManager.getItemManager(server.collectionManager.fetch(calendar.uid))
        return String(itemMgr.fetch(itemUid).content, Charsets.UTF_8).lineSequence()
            .firstOrNull { it.startsWith("UID:") }?.removePrefix("UID:")?.trim()
    }

    private fun newAccount(generation: String): Account {
        val account = Account("lost-batch-${System.nanoTime()}@example.invalid", App.accountType)
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

    private fun asSyncAdapter(uri: Uri, account: Account): Uri = uri.buildUpon()
        .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
        .appendQueryParameter(Calendars.ACCOUNT_NAME, account.name)
        .appendQueryParameter(Calendars.ACCOUNT_TYPE, account.type)
        .build()

    companion object {
        private val username = "lost-batch-${System.nanoTime()}"

        /** One Etebase signup for the whole class; the session works against any stand-in server. */
        private val session: String by lazy {
            val fake = FakeEtebaseServer()
            val client = Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
            com.etebase.client.Account.signup(client, User(username, "lost-batch@example.invalid"), "stand-in-server-only").save(null)
        }
    }
}
