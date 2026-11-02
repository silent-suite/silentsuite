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
import io.silentsuite.sync.syncadapter.CollectionListRefresh
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.utils.AndroidCompat
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The Birthdays maintenance hook of the real parent contacts sync must write nothing once the
 * account generation it runs for is gone: here the account is removed and a same-name account with
 * a new generation is added while the reconciler's last read before its write is held.
 *
 * The fixture is the parent hook's own (`BirthdayContactSyncRuntimeTest`, whose method is the
 * positive control: with no replacement the generated leftover is tombstoned with the calendar root
 * as its dependency). The platform's SyncManager runs this app's `AddressBooksSyncAdapterService`
 * for a registered main account with a real saved Etebase session, against the in-process
 * [FakeEtebaseServer]. With zero address books the reconciler's listing of the active calendar's
 * items is its last request before it writes; nothing else lists that calendar's items, as the
 * calendar adapter is unsyncable and the collection refresh lists collections only.
 *
 * The replacement is genuine: the original row's removal is confirmed and read back as absent, and
 * the replacement is created with its generation in the `addAccountExplicitly` bundle and then read
 * from a freshly listed row. The platform's own cancellation of the removed account's sync is not
 * mocked; the hold swallows the interrupt it delivers while the read is parked, as a network stack
 * that consumed it would, so the generation is what this test isolates.
 *
 * The end of the original run is witnessed by its own CONTACTS attempt, read through the original
 * generation's status identity: only the exact attempt that run began can close it, and the parent
 * closes it after the hook has returned (`attachContactsChildren` with zero children).
 */
@RunWith(AndroidJUnit4::class)
class BirthdayGenerationFenceRuntimeTest {
    @get:Rule
    val permissions: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS,
        Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR,
    )

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager = AccountManager.get(context)
    private val fake = FakeEtebaseServer()
    private val adapterAuthorities = TaskProvider.TASK_PROVIDERS.map { it.authority } + CalendarContract.AUTHORITY + App.addressBooksAuthority

    /** The SDK user's own session, talking to this test's stand-in. */
    private val server by lazy {
        com.etebase.client.Account.restore(Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl), session, null)
    }

    @Test fun aParentSyncWhoseAccountIsReplacedDuringItsLastReadWritesNothingAfterwards() {
        val name = "birthday-generation-${System.nanoTime()}@example.invalid"
        val type = App.accountType
        val oldGeneration = "birthday-generation-old-${System.nanoTime()}"
        val newGeneration = "birthday-generation-new-${System.nanoTime()}"
        val previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        val previousInterceptor = HttpClient.testInterceptor
        val store = SyncStatusStore(context)
        var oldIdentity: SyncStatusStore.MainIdentity? = null
        var requested = false
        var primary: Throwable? = null
        try {
            // Server side, through the pinned SDK: one private active Birthdays calendar holding a
            // generated leftover and an ordinary event, and no address book at all.
            val colMgr = server.collectionManager
            val calendar = colMgr.create(Constants.ETEBASE_TYPE_CALENDAR, ItemMetadata().apply { this.name = "Birthdays" }, MARKER_ACTIVE)
            colMgr.upload(calendar)
            fake.setMembers(calendar.uid, listOf(username to ADMIN))
            val generated = uploadItem(calendar, GENERATED_UID, GENERATED_ICS)
            val ordinary = uploadItem(calendar, "ordinary-dentist", ORDINARY_ICS)
            val rootBefore = colMgr.fetch(calendar.uid).etag
            val collections = fake.collectionUids()
            assertEquals("no address book on the server", listOf(calendar.uid), collections.toList())
            val transactionPath = "POST collection/${calendar.uid}/item/transaction/"

            // The original account, created with its generation and read back from a freshly listed row.
            ContentResolver.setMasterSyncAutomatically(false)
            HttpClient.testInterceptor = fake
            check(manager.addAccountExplicitly(Account(name, type), null, Bundle().apply {
                putString(AccountSettings.KEY_CREATION_ID, oldGeneration)
            }))
            val original = checkNotNull(currentRow(name, type)) { "the original row is listed" }
            assertEquals("the original row carries its generation from creation", oldGeneration,
                manager.getUserData(original, AccountSettings.KEY_CREATION_ID))
            for (authority in TaskProvider.TASK_PROVIDERS.map { it.authority } + CalendarContract.AUTHORITY) {
                ContentResolver.setIsSyncable(original, authority, 0)
            }
            ContentResolver.setIsSyncable(original, App.addressBooksAuthority, 1)
            AccountSettings.setUserData(manager, original, URI(fake.baseUrl), username)
            AccountSettings(context, original).etebaseSession = session
            assertEquals("the original's stored username is the SDK user", username, AccountSettings(context, original).username())
            assertEquals("the session setup kept the original generation", oldGeneration,
                manager.getUserData(original, AccountSettings.KEY_CREATION_ID))
            val old = store.identity(original, oldGeneration)
            assertEquals("the original's status identity is its generation's", old, store.identity(original))
            oldIdentity = old
            assertEquals("no contacts attempt yet for the original generation", SyncStatusStore.Status(),
                store.status(old, SyncStatusStore.Service.CONTACTS))

            // The real parent contacts sync, as a manual request runs it, held at its last read.
            val hold = fake.hold("GET", Regex(Regex.escape("collection/${calendar.uid}/item/")),
                swallowInterrupt = true, answerFirst = true)
            ContentResolver.requestSync(original, App.addressBooksAuthority, Bundle().apply {
                putBoolean(ContentResolver.SYNC_EXTRAS_MANUAL, true)
                putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)
            })
            requested = true
            hold.awaitArrival(60)

            // Controls: the parked read is the reconciler's, inside the original generation's open real attempt.
            assertTrue("the held request is the calendar's item listing",
                hold.request?.startsWith("GET collection/${calendar.uid}/item/") == true)
            val attemptId = store.status(old, SyncStatusStore.Service.CONTACTS).activeAttemptId
            assertTrue("the original generation's parent attempt is open", attemptId != null)
            assertTrue("the parent sync of the original row is running", ContentResolver.isSyncActive(original, App.addressBooksAuthority))
            assertTrue("nothing was written into the calendar before the replacement",
                fake.requests.none { it.substringBefore('?') == transactionPath })
            val depsAtRelease = fake.uploadDeps.size

            // The genuine replacement: confirmed removal and absence, then a same-name row created with
            // its new generation, read back from a freshly listed row and kept from syncing.
            assertTrue("the original generation's row was removed", removeExactGeneration(name, type, oldGeneration))
            check(manager.addAccountExplicitly(Account(name, type), null, Bundle().apply {
                putString(AccountSettings.KEY_CREATION_ID, newGeneration)
                putString(AccountSettings.KEY_SETTINGS_VERSION, AccountSettings.CURRENT_VERSION.toString())
            }))
            val replacement = checkNotNull(currentRow(name, type)) { "the replacement row is listed" }
            assertEquals("the replacement row carries its generation from creation", newGeneration,
                manager.getUserData(replacement, AccountSettings.KEY_CREATION_ID))
            for (authority in adapterAuthorities) ContentResolver.setIsSyncable(replacement, authority, 0)
            val new = store.identity(replacement, newGeneration)
            assertEquals("the replacement's status identity is its generation's", new, store.identity(replacement))
            assertNotEquals("the two generations have distinct status identities", old, new)
            assertEquals("the replacement has no contacts status", SyncStatusStore.Status(),
                store.status(new, SyncStatusStore.Service.CONTACTS))
            assertEquals("the original attempt is still open while its read is held", attemptId,
                store.status(old, SyncStatusStore.Service.CONTACTS).activeAttemptId)

            // The held read completes; the original run then ends by closing its own attempt. Nothing was
            // written up to here (the stand-in lets a parked request go by itself only after 60 s).
            val requestsAtRelease = fake.requests.size
            assertTrue("nothing was written into the calendar before the release",
                fake.requests.none { it.substringBefore('?') == transactionPath })
            assertEquals("no upload before the release", depsAtRelease, fake.uploadDeps.size)
            hold.release()
            waitUntil("the original generation's parent run to close its attempt", diagnostics = { statusDiagnostics(old) }) {
                store.status(old, SyncStatusStore.Service.CONTACTS).activeAttemptId == null
            }
            // What the run sent after the release, taken before this test's own reads below.
            val afterRelease = fake.requests.toList().drop(requestsAtRelease)
            val depsAfterRelease = fake.uploadDeps.toList().drop(depsAtRelease)

            // Controls: the replacement generation is untouched.
            val replacementNow = checkNotNull(currentRow(name, type)) { "the replacement row is still listed" }
            assertEquals("the replacement keeps its generation", newGeneration,
                manager.getUserData(replacementNow, AccountSettings.KEY_CREATION_ID))
            assertEquals("the replacement's contacts status is untouched", SyncStatusStore.Status(),
                store.status(new, SyncStatusStore.Service.CONTACTS))
            assertEquals("the replacement stays unsyncable for address books", 0,
                ContentResolver.getIsSyncable(replacementNow, App.addressBooksAuthority))

            val itemMgr = colMgr.getItemManager(colMgr.fetch(calendar.uid))
            assertFalse("GENERATION_FENCE: nothing is written after the generation was replaced",
                itemMgr.fetch(generated.uid).isDeleted)
            assertEquals("GENERATION_FENCE: no calendar transaction after the replacement (${afterRelease.size} requests)",
                emptyList<String>(), afterRelease.map { it.substringBefore('?') }.filter { it == transactionPath })
            assertEquals("GENERATION_FENCE: no root-fenced upload after the replacement", emptyList<List<String>>(), depsAfterRelease)
            assertEquals("no item is added to or removed from the calendar", setOf(generated.uid, ordinary.uid), fake.itemUids(calendar.uid))
            assertFalse("the ordinary event is not deleted", itemMgr.fetch(ordinary.uid).isDeleted)
            assertEquals("the ordinary event is unchanged", ORDINARY_ICS, String(itemMgr.fetch(ordinary.uid).content, Charsets.UTF_8))
            val after = colMgr.fetch(calendar.uid)
            assertEquals("the calendar root did not move", rootBefore, after.etag)
            assertEquals("the active marker is kept", MARKER_ACTIVE, String(after.content, Charsets.UTF_8))
            assertEquals("no collection is created or removed", collections, fake.collectionUids())
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
        // The original run must have ended before any row, the cache or the interceptor goes.
        oldIdentity?.takeIf { requested }?.let { old ->
            attempt {
                waitUntil("the original generation's parent run to close its attempt before cleanup", diagnostics = { statusDiagnostics(old) }) {
                    store.status(old, SyncStatusStore.Service.CONTACTS).activeAttemptId == null
                }
            }
        }
        attempt { currentRow(name, type)?.let { ContentResolver.cancelSync(it, App.addressBooksAuthority) } }
        attempt { removeExactGeneration(name, type, newGeneration) }
        attempt { removeExactGeneration(name, type, oldGeneration) }
        attempt {
            // The cache is keyed by the name: it is only cleared once no row of that name is left.
            check(currentRow(name, type) == null) { "a row with this test's name is still present; its cache is kept" }
            EtebaseLocalCache.clearUserCache(context, name)
            CollectionListRefresh.collectionLastFetchMap.keys.filter { it.startsWith("$name\u0000") }
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

    /** The row AccountManager lists now under exactly [name] and [type], or null. */
    private fun currentRow(name: String, type: String): Account? =
        manager.getAccountsByType(type).singleOrNull { it.name == name }

    /**
     * Removes the row now listed under [name] only if that fresh row carries [generation]: waits for
     * the confirmed callback and reads back that no row of the name is left. False, with nothing
     * removed, when no such row is listed or it belongs to another generation.
     */
    private fun removeExactGeneration(name: String, type: String, generation: String): Boolean {
        val row = currentRow(name, type) ?: return false
        if (manager.getUserData(row, AccountSettings.KEY_CREATION_ID) != generation) return false
        val removed = CountDownLatch(1)
        var confirmed = false
        AndroidCompat.removeAccount(manager, row) {
            confirmed = it
            removed.countDown()
        }
        assertTrue("account removal callback timed out", removed.await(10, TimeUnit.SECONDS))
        assertTrue("account removal was not confirmed", confirmed)
        assertTrue("the removed row is still listed", currentRow(name, type) == null)
        return true
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

    /** Content-free state of one generation's CONTACTS status, for a timeout message only. */
    private fun statusDiagnostics(identity: SyncStatusStore.MainIdentity): String = try {
        val status = SyncStatusStore(context).status(identity, SyncStatusStore.Service.CONTACTS)
        listOf(
            "attemptOpen=${status.activeAttemptId != null}",
            "terminalRecorded=${status.lastTerminalAt != null}",
            "terminalResult=${status.lastTerminalResult}",
            "failureCategory=${status.lastFailureCategory}",
            "storageFailure=${status.structuralStorageFailure}",
        ).joinToString(" ")
    } catch (t: Throwable) {
        "status unavailable (${t.javaClass.simpleName})"
    }

    private fun waitUntil(
        description: String,
        timeoutMillis: Long = 60_000,
        diagnostics: (() -> String)? = null,
        predicate: () -> Boolean,
    ) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < deadline) {
            if (predicate()) return
            SystemClock.sleep(50)
        }
        val done = predicate()
        if (!done && diagnostics != null) {
            // Computed once, at the deadline; a diagnostics failure never replaces the timeout itself.
            val detail = try {
                diagnostics()
            } catch (t: Throwable) {
                "diagnostics unavailable (${t.javaClass.simpleName})"
            }
            assertTrue("Timed out waiting for $description [$detail]", false)
        }
        assertTrue("Timed out waiting for $description", done)
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

        private val username = "birthday-generation-${System.nanoTime()}"

        /** One Etebase signup for the whole class; the session works against any stand-in server. */
        private val session: String by lazy {
            val fake = FakeEtebaseServer()
            val client = Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
            com.etebase.client.Account.signup(client, User(username, "birthday-generation@example.invalid"), "stand-in-server-only").save(null)
        }
    }
}
