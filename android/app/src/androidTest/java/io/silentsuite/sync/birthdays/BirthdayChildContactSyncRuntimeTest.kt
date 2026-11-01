package io.silentsuite.sync.birthdays

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderClient
import android.content.ContentResolver
import android.os.Bundle
import android.os.SystemClock
import android.provider.CalendarContract
import android.provider.ContactsContract
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import at.bitfire.ical4android.TaskProvider
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
import io.silentsuite.sync.notes.FakeEtebaseServer
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.syncadapter.CollectionListRefresh
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.syncadapter.putContactsTarget
import io.silentsuite.sync.utils.AndroidCompat
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The Birthdays maintenance hook after a successful CHILD contacts sync (plan2 §3 trigger (b)):
 * a contact downloaded by one address book's own sync must reach the generated birthday without a
 * parent address-book sync doing it instead.
 *
 * The child sync runs for real: the platform's SyncManager runs this app's
 * `ContactsSyncAdapterService` for a real child address-book account, created by
 * [LocalAddressBook.create] for a registered main account, on a manual request for
 * [ContactsContract.AUTHORITY], against the in-process [FakeEtebaseServer]. The main account has a
 * real saved Etebase session, authenticated as the exact SDK user.
 *
 * The child adapter only records its result for a contacts lifecycle target that its parent began
 * (`ContactsSyncAdapterService.recordChild`). The test therefore records, with the same store calls
 * the parent sync makes before it dispatches children (`beginAttemptResult`,
 * `attachContactsChildren`, `putContactsTarget`), an attempt that expects exactly this child. It
 * never records the outcome: the CONTACTS terminal SUCCESS can only come from the real child adapter,
 * and it is this test's witness that the child sync completed successfully.
 *
 * No parent sync runs: the main account's address-books authority, calendar and task authorities
 * are unsyncable, master sync is off, and the setup's collection listing is the plain
 * [CollectionListRefresh] that seeds the local cache, not the parent adapter.
 */
@RunWith(AndroidJUnit4::class)
class BirthdayChildContactSyncRuntimeTest {
    @get:Rule
    val permissions: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS,
        Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR,
    )

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager = AccountManager.get(context)
    private val fake = FakeEtebaseServer()

    /** The SDK user's own session, talking to this test's stand-in. */
    private val server by lazy {
        com.etebase.client.Account.restore(Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl), session, null)
    }

    @Test fun aSuccessfulChildContactSyncUpdatesTheGeneratedBirthdayWithoutAParentSync() {
        val generation = "birthday-child-sync-${System.nanoTime()}"
        val main = Account("birthday-child-sync-${System.nanoTime()}@example.invalid", App.accountType)
        var child: Account? = null
        var contactsProvider: ContentProviderClient? = null
        val previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        val previousInterceptor = HttpClient.testInterceptor
        var primary: Throwable? = null
        try {
            // Server side, through the pinned SDK: a private active Birthdays calendar holding the old
            // generated birthday of a contact and an ordinary event, and the contact, now renamed with a
            // changed birthday, in a readable address book.
            val colMgr = server.collectionManager
            val calendar = colMgr.create(Constants.ETEBASE_TYPE_CALENDAR, ItemMetadata().apply { name = "Birthdays" }, MARKER_ACTIVE)
            colMgr.upload(calendar)
            fake.setMembers(calendar.uid, listOf(username to ADMIN))
            val book = colMgr.create(Constants.ETEBASE_TYPE_ADDRESS_BOOK, ItemMetadata().apply { name = "Contacts" }, "")
            colMgr.upload(book)
            fake.setMembers(book.uid, listOf(username to ADMIN))
            val contact = uploadItem(book, "contact-ada", ADA_RENAMED_VCARD)
            val uid = BirthdayCalendar.eventUid(book.uid, contact.uid)
            val oldFields = BirthdayCalendar.fieldsOf(BirthdayCalendar.BirthdayEvent(uid, "Ada Lovelace", 12, 10))
            val newFields = BirthdayCalendar.fieldsOf(BirthdayCalendar.BirthdayEvent(uid, "Ada King", 12, 11))
            val generated = uploadItem(calendar, uid, BirthdayCalendar.eventIcs(BirthdayCalendar.BirthdayEvent(uid, "Ada Lovelace", 12, 10)))
            val ordinary = uploadItem(calendar, "ordinary-dentist", ORDINARY_ICS)
            val rootBefore = colMgr.fetch(calendar.uid).etag
            val collections = fake.collectionUids()
            assertEquals("the seeded event has the old fields", oldFields,
                BirthdayCalendar.eventFields(String(colMgr.getItemManager(colMgr.fetch(calendar.uid)).fetch(generated.uid).content, Charsets.UTF_8)))
            assertEquals("the contact on the server is the renamed one", ADA_RENAMED_VCARD,
                String(colMgr.getItemManager(colMgr.fetch(book.uid)).fetch(contact.uid).content, Charsets.UTF_8))

            // The main account, authenticated as the exact SDK user, with no parent sync able to run.
            ContentResolver.setMasterSyncAutomatically(false)
            HttpClient.testInterceptor = fake
            check(manager.addAccountExplicitly(main, null, null))
            for (authority in TaskProvider.TASK_PROVIDERS.map { it.authority } + CalendarContract.AUTHORITY + App.addressBooksAuthority) {
                ContentResolver.setIsSyncable(main, authority, 0)
            }
            AccountSettings.setUserData(manager, main, URI(fake.baseUrl), username)
            check(AccountSettings.writeVerified(manager, main, AccountSettings.KEY_CREATION_ID, generation))
            AccountSettings(context, main).etebaseSession = session
            assertEquals("the main account's stored username is the SDK user", username, AccountSettings(context, main).username())

            // The local cache, as a collection listing fills it, and the real child address book.
            val settings = AccountSettings(context, main)
            HttpClient.Builder(context, settings).setForeground(false).build().use {
                CollectionListRefresh.run(context, main, settings, it.okHttpClient, forceRefresh = true, creationId = generation)
            }
            val cached = EtebaseLocalCache.getInstance(context, main.name).let { cache ->
                synchronized(cache) { cache.collectionGet(colMgr, book.uid) }
            }
            contactsProvider = checkNotNull(context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY))
            val addressBook = LocalAddressBook.create(context, contactsProvider, main, cached)
            child = addressBook.androidAccount
            val childAccount = addressBook.androidAccount
            assertEquals("the child belongs to this main account", main, addressBook.mainAccount)
            val childCreationId = manager.getUserData(childAccount, LocalAddressBook.USER_DATA_CREATION_ID)
            assertTrue("the child has its own creation id", !childCreationId.isNullOrBlank())
            assertEquals("no contact in the child yet", 0, childContactNames(childAccount).size)

            // The contacts attempt the parent would have begun for exactly this child, and its target.
            val store = SyncStatusStore(context)
            val mainIdentity = store.identity(main)
            val childIdentity = checkNotNull(store.childIdentity(childAccount)) { "the child has a status identity" }
            val attemptId = UUID.randomUUID().toString()
            val startedAt = System.currentTimeMillis()
            assertEquals("the parent attempt is recorded", SyncStatusStore.MutationResult.RECORDED,
                store.beginAttemptResult(mainIdentity, SyncStatusStore.Service.CONTACTS, attemptId, startedAt, null))
            assertTrue("the attempt expects exactly this child",
                store.attachContactsChildren(mainIdentity, attemptId, setOf(childIdentity), startedAt) is SyncStatusStore.ContactsStart.Started)
            val requestsBefore = fake.requests.size
            val since = fake.uploadDeps.size

            // The real child contacts sync, as a manual request with its parent's target runs it.
            ContentResolver.requestSync(childAccount, ContactsContract.AUTHORITY, Bundle().apply {
                putBoolean(ContentResolver.SYNC_EXTRAS_MANUAL, true)
                putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)
                putContactsTarget(this, mainIdentity, attemptId, childIdentity)
            })
            waitUntil("the child contacts sync to record its result") {
                val status = SyncStatusStore(context).status(main, SyncStatusStore.Service.CONTACTS)
                (status.lastTerminalAt ?: 0L) >= startedAt && status.activeAttemptId == null
            }
            waitUntil("the child contacts sync to stop running") { !ContentResolver.isSyncActive(childAccount, ContactsContract.AUTHORITY) }

            // Controls: the child sync itself succeeded and downloaded the contact; no parent sync ran.
            val status = SyncStatusStore(context).status(main, SyncStatusStore.Service.CONTACTS)
            assertEquals("the child sync succeeded for the attempt that expected it", SyncStatusStore.TerminalResult.SUCCESS,
                status.lastTerminalResult)
            assertEquals("the child downloaded the renamed contact", listOf("Ada King"), childContactNames(childAccount))
            assertTrue("the child listed its address book's items",
                fake.requests.drop(requestsBefore).any { it.startsWith("GET collection/${book.uid}/item/") })
            assertEquals("the main account's address books stay unsyncable: no parent sync", 0,
                ContentResolver.getIsSyncable(main, App.addressBooksAuthority))
            assertFalse("no parent sync is running", ContentResolver.isSyncActive(main, App.addressBooksAuthority))
            assertEquals("the main generation is unchanged", generation, manager.getUserData(main, AccountSettings.KEY_CREATION_ID))
            assertEquals("the child generation is unchanged", childCreationId, manager.getUserData(childAccount, LocalAddressBook.USER_DATA_CREATION_ID))
            assertEquals("the child still belongs to this main account", main, LocalAddressBook(context, childAccount, null).mainAccount)

            val itemMgr = colMgr.getItemManager(colMgr.fetch(calendar.uid))
            assertEquals("FEATURE_CHILD_CONTACT_SYNC: the generated birthday follows the contact the child sync downloaded",
                newFields, BirthdayCalendar.eventFields(String(itemMgr.fetch(generated.uid).content, Charsets.UTF_8)))
            assertFalse("the generated birthday is the same storage item, not deleted", itemMgr.fetch(generated.uid).isDeleted)
            assertEquals("no item is added to or removed from the calendar", setOf(generated.uid, ordinary.uid), fake.itemUids(calendar.uid))
            assertFalse("the ordinary event is not deleted", itemMgr.fetch(ordinary.uid).isDeleted)
            assertEquals("the ordinary event is unchanged", ORDINARY_ICS, String(itemMgr.fetch(ordinary.uid).content, Charsets.UTF_8))
            val after = colMgr.fetch(calendar.uid)
            assertEquals("the calendar root did not move", rootBefore, after.etag)
            assertEquals("the active marker is kept", MARKER_ACTIVE, String(after.content, Charsets.UTF_8))
            assertEquals("no collection is created or removed", collections, fake.collectionUids())
            val calendarUploads = fake.requests.drop(requestsBefore).map { it.substringBefore('?') }
                .filter { it == "POST collection/${calendar.uid}/item/transaction/" }
            assertEquals("FEATURE_CHILD_CONTACT_SYNC: one update transaction into the calendar", 1, calendarUploads.size)
            assertTrue("FEATURE_CHILD_CONTACT_SYNC: fenced on the calendar root",
                listOf(calendar.uid) in fake.uploadDeps.drop(since))
            assertEquals("the contact on the server is untouched", ADA_RENAMED_VCARD,
                String(colMgr.getItemManager(colMgr.fetch(book.uid)).fetch(contact.uid).content, Charsets.UTF_8))
        } catch (t: Throwable) {
            primary = t
        }

        // Every cleanup step is attempted even if an earlier one fails. A failure in the test body stays
        // the reported failure, with cleanup failures attached; otherwise a cleanup failure fails the test.
        val cleanup = ArrayList<Throwable>()
        fun attempt(step: () -> Unit) {
            try {
                step()
            } catch (t: Throwable) {
                cleanup += t
            }
        }
        attempt { fake.releaseAll() }
        child?.let { childAccount ->
            attempt { ContentResolver.cancelSync(childAccount, ContactsContract.AUTHORITY) }
            attempt {
                waitUntil("the child contacts sync to stop running after cancellation") {
                    !ContentResolver.isSyncActive(childAccount, ContactsContract.AUTHORITY)
                }
            }
        }
        attempt { ContentResolver.cancelSync(main, App.addressBooksAuthority) }
        attempt {
            waitUntil("no parent contacts sync to be running after cancellation") {
                !ContentResolver.isSyncActive(main, App.addressBooksAuthority)
            }
        }
        child?.let { childAccount ->
            attempt { removeAccount(childAccount) }
            attempt {
                waitUntil("the child's contacts to be removed with its account") { childContactNames(childAccount).isEmpty() }
            }
        }
        attempt { removeAccount(main) }
        attempt {
            EtebaseLocalCache.clearUserCache(context, main.name)
            CollectionListRefresh.collectionLastFetchMap.keys.filter { it.startsWith("${main.name}\u0000") }
                .forEach { CollectionListRefresh.collectionLastFetchMap.remove(it) }
        }
        attempt { contactsProvider?.close() }
        attempt { HttpClient.testInterceptor = previousInterceptor }
        attempt { ContentResolver.setMasterSyncAutomatically(previousMasterSync) }
        primary?.let { failure ->
            cleanup.forEach(failure::addSuppressed)
            throw failure
        }
        cleanup.firstOrNull()?.let { failure ->
            cleanup.drop(1).forEach(failure::addSuppressed)
            throw failure
        }
    }

    // ---- fixture ----

    /**
     * Display names of the child account's live raw contacts, read from the Contacts provider: first
     * the live (not deleted) raw contact ids of exactly this account from [ContactsContract.RawContacts],
     * where `deleted` is a column, then each one's StructuredName rows from [ContactsContract.Data] by
     * its `raw_contact_id` and mimetype. The Data view has no `deleted` column to filter on.
     */
    private fun childContactNames(child: Account): List<String> {
        val liveRawIds = checkNotNull(context.contentResolver.query(ContactsContract.RawContacts.CONTENT_URI,
            arrayOf(ContactsContract.RawContacts._ID),
            "${ContactsContract.RawContacts.ACCOUNT_NAME}=? AND ${ContactsContract.RawContacts.ACCOUNT_TYPE}=? AND " +
                "${ContactsContract.RawContacts.DELETED}=0",
            arrayOf(child.name, child.type), null)).use { cursor ->
            val ids = ArrayList<Long>()
            while (cursor.moveToNext()) ids += cursor.getLong(0)
            ids
        }.sorted()
        val names = ArrayList<String>()
        for (rawId in liveRawIds) {
            checkNotNull(context.contentResolver.query(ContactsContract.Data.CONTENT_URI,
                arrayOf(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME),
                "${ContactsContract.Data.RAW_CONTACT_ID}=? AND ${ContactsContract.Data.MIMETYPE}=?",
                arrayOf(rawId.toString(), ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE), null)).use { cursor ->
                while (cursor.moveToNext()) names += cursor.getString(0) ?: ""
            }
        }
        return names
    }

    private fun uploadItem(collection: Collection, name: String, content: String): Item {
        val itemMgr = server.collectionManager.getItemManager(collection)
        val item = itemMgr.create(ItemMetadata().apply {
            this.name = name
            mtime = 1_000L
        }, content)
        itemMgr.batch(arrayOf(item))
        return item
    }

    /** Removes exactly [account], waits for the confirmed callback, and reads back that it is gone. */
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
        assertFalse("the account is still present after its confirmed removal", account in manager.getAccountsByType(account.type))
    }

    private fun waitUntil(description: String, timeoutMillis: Long = 60_000, predicate: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < deadline) {
            if (predicate()) return
            SystemClock.sleep(50)
        }
        assertTrue("Timed out waiting for $description", predicate())
    }

    companion object {
        /** The server's access level for an admin, as the fake stores it. */
        private const val ADMIN = 1L

        /** The shared-v1 marker bytes (`contracts/birthday-calendar/v1-vectors.json`, marker vector 1). */
        private const val MARKER_ACTIVE = "{\"type\":\"silentsuite.birthdays\",\"v\":1,\"state\":\"active\"}"

        private const val ADA_RENAMED_VCARD = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c-ada\r\nFN:Ada King\r\nN:King;Ada;;;\r\nBDAY:1815-12-11\r\nEND:VCARD\r\n"

        private const val ORDINARY_ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other client//EN\r\n" +
            "BEGIN:VEVENT\r\nUID:ordinary-dentist\r\nDTSTAMP:20261031T120000Z\r\n" +
            "DTSTART:20261105T090000Z\r\nDTEND:20261105T100000Z\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

        private val username = "birthday-child-sync-${System.nanoTime()}"

        /** One Etebase signup for the whole class; the session works against any stand-in server. */
        private val session: String by lazy {
            val fake = FakeEtebaseServer()
            val client = Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
            com.etebase.client.Account.signup(client, User(username, "birthday-child-sync@example.invalid"), "stand-in-server-only").save(null)
        }
    }
}
