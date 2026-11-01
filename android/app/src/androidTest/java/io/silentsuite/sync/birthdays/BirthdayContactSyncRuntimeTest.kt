package io.silentsuite.sync.birthdays

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.os.Bundle
import android.os.SystemClock
import android.provider.CalendarContract
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
import io.silentsuite.sync.utils.AndroidCompat
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The Birthdays maintenance hook in the real parent contacts sync (plan2 §3 trigger (a), kept by
 * plan3): after a successful address-book refresh and `updateLocalAddressBooks`, even with zero
 * child address books, so that removing the last address book removes its birthdays.
 *
 * The parent sync runs for real: the platform's SyncManager runs this app's
 * `AddressBooksSyncAdapterService` for a registered main account, on a manual request for
 * [App.addressBooksAuthority], against the in-process [FakeEtebaseServer] (the app's
 * [HttpClient.testInterceptor]). The account has a real saved Etebase session. The server side is
 * seeded through the pinned SDK and read back through it. Every other adapter of the account is
 * unsyncable and master sync is off, so only this one sync runs.
 *
 * In the current code, a parent sync that finds no address books ends with the CONTACTS terminal
 * "setup required" (`SyncStatusStore.attachContactsChildKeys`, empty child set). That terminal is
 * recorded only after the collection refresh and `updateLocalAddressBooks` finished without an
 * error, so it is this test's witness that the parent sync itself completed.
 */
@RunWith(AndroidJUnit4::class)
class BirthdayContactSyncRuntimeTest {
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

    @Test fun aCompletedParentAddressBookRefreshWithNoChildrenCleansOnlyGeneratedBirthdays() {
        val generation = "birthday-parent-sync-${System.nanoTime()}"
        val account = Account("birthday-parent-sync-${System.nanoTime()}@example.invalid", App.accountType)
        val previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        val previousInterceptor = HttpClient.testInterceptor
        var primary: Throwable? = null
        try {
            // Server side, through the pinned SDK: one private active Birthdays calendar holding a
            // generated leftover and an ordinary event, and no address book at all.
            val colMgr = server.collectionManager
            val calendar = colMgr.create(Constants.ETEBASE_TYPE_CALENDAR, ItemMetadata().apply { name = "Birthdays" }, MARKER_ACTIVE)
            colMgr.upload(calendar)
            fake.setMembers(calendar.uid, listOf(username to ADMIN))
            val generated = uploadItem(calendar, GENERATED_UID, GENERATED_ICS)
            val ordinary = uploadItem(calendar, "ordinary-dentist", ORDINARY_ICS)
            val rootBefore = colMgr.fetch(calendar.uid).etag
            val collections = fake.collectionUids()
            assertEquals("no address book on the server", listOf(calendar.uid), collections.toList())

            ContentResolver.setMasterSyncAutomatically(false)
            HttpClient.testInterceptor = fake
            check(manager.addAccountExplicitly(account, null, null))
            for (authority in TaskProvider.TASK_PROVIDERS.map { it.authority } + CalendarContract.AUTHORITY) {
                ContentResolver.setIsSyncable(account, authority, 0)
            }
            ContentResolver.setIsSyncable(account, App.addressBooksAuthority, 1)
            AccountSettings.setUserData(manager, account, URI(fake.baseUrl), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
            AccountSettings(context, account).etebaseSession = session
            val requestsBefore = fake.requests.size
            val since = fake.uploadDeps.size
            val startedAt = System.currentTimeMillis()

            // The real parent contacts sync, as a manual request runs it.
            ContentResolver.requestSync(account, App.addressBooksAuthority, Bundle().apply {
                putBoolean(ContentResolver.SYNC_EXTRAS_MANUAL, true)
                putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)
            })
            waitUntil("the parent contacts sync to record its terminal") {
                val status = SyncStatusStore(context).status(account, SyncStatusStore.Service.CONTACTS)
                (status.lastTerminalAt ?: 0L) >= startedAt && status.activeAttemptId == null
            }
            waitUntil("the parent contacts sync to stop running") { syncStopped(account) }

            // Controls: the parent sync itself completed, with zero address books, for this account generation.
            val status = SyncStatusStore(context).status(account, SyncStatusStore.Service.CONTACTS)
            assertEquals("the parent sync reached its zero-address-book completion", SyncStatusStore.FailureCategory.SETUP_REQUIRED,
                status.lastFailureCategory)
            assertFalse("no attempt is left open", status.activeAttemptId != null)
            assertTrue("the collection refresh listed the inventory",
                fake.requests.drop(requestsBefore).any { it.startsWith("POST collection/list_multi/") })
            assertEquals("no local address book", 0, LocalAddressBook.find(context, null, account).size)
            assertTrue("the refresh cached the calendar for this account",
                EtebaseLocalCache.getInstance(context, account.name).let { cache ->
                    synchronized(cache) { cache.collectionList(colMgr, type = Constants.ETEBASE_TYPE_CALENDAR) }
                }.any { it.col.uid == calendar.uid })
            assertEquals("the account generation is unchanged", generation, manager.getUserData(account, AccountSettings.KEY_CREATION_ID))

            val itemMgr = colMgr.getItemManager(colMgr.fetch(calendar.uid))
            assertTrue("FEATURE_PARENT_CONTACT_SYNC: the generated birthday of a contact that no longer exists is tombstoned",
                itemMgr.fetch(generated.uid).isDeleted)
            assertFalse("the ordinary event is not deleted", itemMgr.fetch(ordinary.uid).isDeleted)
            assertEquals("the ordinary event is unchanged", ORDINARY_ICS, String(itemMgr.fetch(ordinary.uid).content, Charsets.UTF_8))
            val after = colMgr.fetch(calendar.uid)
            assertEquals("the calendar root did not move", rootBefore, after.etag)
            assertEquals("the active marker is kept", MARKER_ACTIVE, String(after.content, Charsets.UTF_8))
            assertEquals("no collection is created or removed", collections, fake.collectionUids())
            val uploads = fake.requests.drop(requestsBefore).map { it.substringBefore('?') }
                .filter { it.startsWith("POST collection/") && it.contains("/item/") }
            assertEquals("FEATURE_PARENT_CONTACT_SYNC: one cleanup transaction into the calendar",
                listOf("POST collection/${calendar.uid}/item/transaction/"), uploads)
            assertEquals("FEATURE_PARENT_CONTACT_SYNC: fenced on the calendar root", listOf(listOf(calendar.uid)), fake.uploadDeps.drop(since))
            assertEquals("the account generation is still unchanged", generation, manager.getUserData(account, AccountSettings.KEY_CREATION_ID))
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
        attempt { ContentResolver.cancelSync(account, App.addressBooksAuthority) }
        attempt { waitUntil("this account's parent contacts sync to be neither running nor pending after cancellation") { syncStopped(account) } }
        attempt { removeAccount(account) }
        attempt {
            EtebaseLocalCache.clearUserCache(context, account.name)
            CollectionListRefresh.collectionLastFetchMap.keys.filter { it.startsWith("${account.name}\u0000") }
                .forEach { CollectionListRefresh.collectionLastFetchMap.remove(it) }
        }
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

    /** No sync of this account is running, and none is pending for the address-books authority. */
    private fun syncStopped(account: Account) =
        ContentResolver.getCurrentSyncs().none { it.account == account } &&
            !ContentResolver.isSyncPending(account, App.addressBooksAuthority)

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

        /** Events vector 1's canonical text: a generated event whose contact no longer exists. */
        private const val GENERATED_UID = "ss-bday1-c8970a5b3457981540f4ee428f84a1f4"
        private const val GENERATED_ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SilentSuite//Birthdays v1//EN\r\n" +
            "BEGIN:VEVENT\r\nUID:ss-bday1-c8970a5b3457981540f4ee428f84a1f4\r\nDTSTAMP:19720101T000000Z\r\n" +
            "DTSTART;VALUE=DATE:19720315\r\nDTEND;VALUE=DATE:19720316\r\nRRULE:FREQ=YEARLY\r\n" +
            "SUMMARY:🎂 Alex Example\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

        private const val ORDINARY_ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other client//EN\r\n" +
            "BEGIN:VEVENT\r\nUID:ordinary-dentist\r\nDTSTAMP:20261031T120000Z\r\n" +
            "DTSTART:20261105T090000Z\r\nDTEND:20261105T100000Z\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

        private val username = "birthday-parent-sync-${System.nanoTime()}"

        /** One Etebase signup for the whole class; the session works against any stand-in server. */
        private val session: String by lazy {
            val fake = FakeEtebaseServer()
            val client = Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
            com.etebase.client.Account.signup(client, User(username, "birthday-parent-sync@example.invalid"), "stand-in-server-only").save(null)
        }
    }
}
