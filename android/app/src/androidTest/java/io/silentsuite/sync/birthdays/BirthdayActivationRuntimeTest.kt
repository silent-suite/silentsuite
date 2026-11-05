package io.silentsuite.sync.birthdays

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.os.SystemClock
import android.provider.CalendarContract
import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import at.bitfire.ical4android.TaskProvider
import com.etebase.client.Client
import com.etebase.client.Collection
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.CollectionManager
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
import io.silentsuite.sync.ui.AccountActivity
import io.silentsuite.sync.utils.AndroidCompat
import androidx.appcompat.widget.Toolbar
import io.silentsuite.sync.R
import io.silentsuite.sync.billing.BillingManager
import io.silentsuite.sync.ui.setup.PostLoginSetupState
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The Android Birthdays switch (plan3 §3), end to end: the rendered Calendars menu of the real
 * dashboard, its real listener, the account's real stored session and the pinned SDK against the
 * in-process [FakeEtebaseServer]. Server state is seeded and read back through the SDK.
 */
@RunWith(AndroidJUnit4::class)
class BirthdayActivationRuntimeTest {
    @get:Rule
    val permissions: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS,
        Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR,
    )

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager = AccountManager.get(context)
    private val fake = FakeEtebaseServer()
    private val syncRequests = CopyOnWriteArrayList<Account>()
    private val invoked = AtomicBoolean(false)

    private val server by lazy {
        com.etebase.client.Account.restore(Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl), session, null)
    }

    @Test fun turningOnFromTheCalendarsMenuCreatesOnePrivateMarkedCalendarFilledFromContacts() {
        val colMgr = server.collectionManager
        val book = collection(colMgr, Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Contacts", "")
        val contact = uploadItem(book, "contact-alex", VCARD)
        val ordinary = collection(colMgr, Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", "")
        fake.setMembers(ordinary.uid, listOf(username to ADMIN))
        uploadItem(ordinary, "ordinary-dentist", ORDINARY_ICS)
        val shared = collection(colMgr, Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE)
        fake.setMembers(shared.uid, listOf(OTHER_MEMBER to ADMIN, username to READ_WRITE))
        uploadItem(shared, "shared-dentist", ORDINARY_ICS)
        uploadItem(shared, "shared-generated", GENERATED_ICS)
        // Received from its owner: this user may write but is not Admin, so C3 rejects it on access alone.
        fake.setAccessLevel(shared.uid, READ_WRITE)
        // Preconditions, read fresh through the SDK: the role the run will see (as BirthdayReconciliationRuntimeTest).
        val listedCalendars = colMgr.list(Constants.ETEBASE_TYPE_CALENDAR)
        assertTrue("PREREQUISITE: the calendar listing is complete", listedCalendars.isDone)
        assertEquals("PREREQUISITE: the received calendar is listed as ReadWrite for this user", CollectionAccessLevel.ReadWrite,
            listedCalendars.data.single { it.uid == shared.uid }.accessLevel)
        assertEquals("PREREQUISITE: the received calendar is fetched as ReadWrite for this user", CollectionAccessLevel.ReadWrite,
            colMgr.fetch(shared.uid).accessLevel)
        val seeded = fake.collectionUids()
        val held = mapOf("address book" to book.uid, "ordinary calendar named Birthdays" to ordinary.uid,
            "received read-write active calendar" to shared.uid).mapValues { (_, uid) -> uid to state(colMgr, uid) }
        val birthday = BirthdayCalendar.birthdayOf(VCARD)
        assertNotNull("PREREQUISITE: the fixture contact has a birthday", birthday)
        val expectedUid = BirthdayCalendar.eventUid(book.uid, contact.uid)
        val expectedIcs = BirthdayCalendar.eventIcs(BirthdayCalendar.BirthdayEvent(expectedUid, birthday!!.name, birthday.month, birthday.day))
        val known = seeded.joinToString("|") { Regex.escape(it) }
        val newCalendarMembers = fake.hold("GET", Regex("collection/(?!($known)/)[^/]+/member/"))

        withActivationDashboard(seeded) { scenario ->
            val since = fake.uploadDeps.size
            invokeCalendarsAction(scenario, TURN_ON)
            assertTrue("FEATURE_ACTIVATION: turning on verifies a new calendar's members before filling it",
                newCalendarMembers.arrivesWithin(60_000))
            val created = MEMBER_PATH.find(newCalendarMembers.request!!)!!.groupValues[1]
            assertTrue("FEATURE_ACTIVATION: the verified calendar is a newly created one", created !in seeded && created in fake.collectionUids())
            assertTrue("nothing is written into it before its members are verified", fake.itemUids(created).isEmpty())
            assertBusy(scenario)
            // The server lists a collection's creator as its only, Admin, member.
            fake.setMembers(created, listOf(username to ADMIN))
            newCalendarMembers.release()
            awaitIdle(scenario, "FEATURE_ACTIVATION: the turn-on to finish and its action to be available again")

            assertEquals("FEATURE_ACTIVATION: exactly one calendar is created", seeded + created, fake.collectionUids())
            val fresh = colMgr.fetch(created)
            assertFalse(fresh.isDeleted)
            assertEquals("it is a calendar", Constants.ETEBASE_TYPE_CALENDAR, fresh.collectionType)
            assertEquals("FEATURE_ACTIVATION: it carries the active marker", MARKER_ACTIVE, String(fresh.content, Charsets.UTF_8))
            val itemMgr = colMgr.getItemManager(fresh)
            val live = fake.itemUids(created).map { itemMgr.fetch(it) }.filter { !it.isDeleted }
            assertEquals("FEATURE_ACTIVATION: it holds exactly the contact's generated birthday", listOf(expectedIcs),
                live.map { String(it.content, Charsets.UTF_8) })
            assertTrue("FEATURE_ACTIVATION: written fenced on the new calendar's root", listOf(created) in fake.uploadDeps.drop(since))
            for ((label, entry) in held) assertEquals("the $label is unchanged", entry.second, state(colMgr, entry.first))
        }
    }

    @Test fun turningOffFromTheCalendarsMenuRetiresEveryQualifyingCalendarAndRemovesOnlyGeneratedEvents() {
        val colMgr = server.collectionManager
        val qualifying = (1..2).map { collection(colMgr, Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE) }
        val generated = HashMap<String, Item>()
        val ordinaryBefore = HashMap<String, Pair<String, ItemState>>()
        for (calendar in qualifying) {
            fake.setMembers(calendar.uid, listOf(username to ADMIN))
            generated[calendar.uid] = uploadItem(calendar, "generated", GENERATED_ICS)
            val ordinary = uploadItem(calendar, "ordinary-dentist", ORDINARY_ICS)
            ordinaryBefore[calendar.uid] = ordinary.uid to state(colMgr, calendar.uid).items.getValue(ordinary.uid)
        }
        val shared = collection(colMgr, Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE)
        fake.setMembers(shared.uid, listOf(username to ADMIN, OTHER_MEMBER to ADMIN))
        uploadItem(shared, "shared-dentist", ORDINARY_ICS)
        uploadItem(shared, "shared-generated", GENERATED_ICS)
        val sharedBefore = state(colMgr, shared.uid)
        val rootsBefore = qualifying.associate { it.uid to colMgr.fetch(it.uid).etag }
        val seeded = fake.collectionUids()
        val alternatives = qualifying.joinToString("|") { Regex.escape(it.uid) }
        val verify = fake.hold("GET", Regex("collection/($alternatives)/member/"))

        withActivationDashboard(seeded) { scenario ->
            val since = fake.uploadDeps.size
            invokeCalendarsAction(scenario, TURN_OFF)
            assertTrue("FEATURE_ACTIVATION: turning off verifies a qualifying calendar's members", verify.arrivesWithin(60_000))
            assertEquals("nothing is written before the members are verified", since, fake.uploadDeps.size)
            assertBusy(scenario)
            verify.release()
            awaitIdle(scenario, "FEATURE_ACTIVATION: the turn-off to finish and its action to be available again")

            for (calendar in qualifying) {
                val fresh = colMgr.fetch(calendar.uid)
                assertFalse("FEATURE_ACTIVATION: a turned-off calendar is kept", fresh.isDeleted)
                assertEquals("FEATURE_ACTIVATION: every qualifying calendar is retired", MARKER_RETIRED, String(fresh.content, Charsets.UTF_8))
                assertNotEquals("its root moved", rootsBefore.getValue(calendar.uid), fresh.etag)
                val itemMgr = colMgr.getItemManager(fresh)
                assertTrue("FEATURE_ACTIVATION: its generated event is removed", itemMgr.fetch(generated.getValue(calendar.uid).uid).isDeleted)
                val (ordinaryUid, before) = ordinaryBefore.getValue(calendar.uid)
                assertEquals("its ordinary event and metadata are unchanged", before, state(colMgr, calendar.uid).items.getValue(ordinaryUid))
                assertTrue("FEATURE_ACTIVATION: its cleanup is fenced on its root", listOf(calendar.uid) in fake.uploadDeps.drop(since))
            }
            assertEquals("the extra-member active calendar is untouched", sharedBefore, state(colMgr, shared.uid))
            assertEquals("no calendar is created or removed", seeded, fake.collectionUids())
        }
    }

    // ---- fixture ----

    private data class ItemState(val deleted: Boolean, val content: String, val name: String?, val mtime: Long?)
    private data class CollectionState(val root: String, val content: String, val name: String?, val items: Map<String, ItemState>)

    private fun state(colMgr: CollectionManager, uid: String): CollectionState {
        val collection = colMgr.fetch(uid)
        val itemMgr = colMgr.getItemManager(collection)
        return CollectionState(collection.etag, String(collection.content, Charsets.UTF_8), collection.meta.name,
            fake.itemUids(uid).associateWith { itemUid ->
                itemMgr.fetch(itemUid).let { ItemState(it.isDeleted, String(it.content, Charsets.UTF_8), it.meta.name, it.meta.mtime) }
            })
    }

    private fun collection(colMgr: CollectionManager, type: String, name: String, content: String): Collection =
        colMgr.create(type, ItemMetadata().apply { this.name = name }, content).also { colMgr.upload(it) }

    private fun uploadItem(collection: Collection, name: String, content: String): Item {
        val itemMgr = server.collectionManager.getItemManager(collection)
        val item = itemMgr.create(ItemMetadata().apply {
            this.name = name
            mtime = 1_000L
        }, content)
        itemMgr.batch(arrayOf(item))
        return item
    }

    /** The visible Birthdays actions of the Calendars menu, as (title, enabled). */
    private fun birthdayActions(scenario: ActivityScenario<AccountActivity>): List<Pair<String, Boolean>> {
        var actions = emptyList<Pair<String, Boolean>>()
        scenario.onActivity { activity ->
            val menu = activity.findViewById<Toolbar>(R.id.caldav_menu).menu
            actions = (0 until menu.size()).map { menu.getItem(it) }
                .filter { it.isVisible && it.title?.toString() in setOf(TURN_ON, TURN_OFF) }
                .map { it.title.toString() to it.isEnabled }
        }
        return actions
    }

    private fun invokeCalendarsAction(scenario: ActivityScenario<AccountActivity>, title: String) {
        scenario.onActivity { activity ->
            val menu = activity.findViewById<Toolbar>(R.id.caldav_menu).menu
            val item = (0 until menu.size()).map { menu.getItem(it) }.firstOrNull { it.title?.toString() == title }
            assertNotNull("FEATURE_ACTIVATION: the Calendars menu offers \"$title\"", item)
            assertTrue("FEATURE_ACTIVATION: \"$title\" is visible and enabled", item!!.isVisible && item.isEnabled)
            assertTrue("FEATURE_ACTIVATION: \"$title\" is its own menu action",
                item.itemId != View.NO_ID && item.itemId != R.id.create_calendar)
            invoked.set(true)
            menu.performIdentifierAction(item.itemId, 0)
        }
    }

    private fun assertBusy(scenario: ActivityScenario<AccountActivity>) =
        assertTrue("FEATURE_ACTIVATION: no Birthdays action can be started while a run is in progress",
            birthdayActions(scenario).none { it.second })

    private fun awaitIdle(scenario: ActivityScenario<AccountActivity>, description: String) =
        waitUntil(description) { birthdayActions(scenario).let { it.isNotEmpty() && it.all { action -> action.second } } }

    /** Runs [block] on the real dashboard of a fresh account whose cache holds the [published] collections. */
    private fun withActivationDashboard(published: Set<String>, block: (ActivityScenario<AccountActivity>) -> Unit) {
        val generation = "birthday-activation-${System.nanoTime()}"
        val account = Account("birthday-activation-${System.nanoTime()}@example.invalid", App.accountType)
        val other = Account("birthday-activation-other-${System.nanoTime()}@example.invalid", App.accountType)
        val otherGeneration = "birthday-activation-other-${System.nanoTime()}"
        // Everything this fixture changes is captured first and restored from these values, never to a default.
        val previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        val previousInterceptor = HttpClient.testInterceptor
        val previousBootstrap = App.postLoginBootstrapSucceeded
        // ActiveAccountManager's two preference keys exactly as found: absent, or their literal string. One getAll()
        // copy; a stored non-string fails here, before anything is changed, and is never normalized.
        val previousActive: Map<String, String?> = context.getSharedPreferences(ACTIVE_ACCOUNT_PREFS, Context.MODE_PRIVATE).all
            .let { all ->
                ACTIVE_ACCOUNT_KEYS.associateWith { key ->
                    all[key]?.let { value -> value as? String ?: error("PREREQUISITE: the active-account preference $key is not a string") }
                }
            }
        val previousLoader = AccountActivity.AccountInfoViewModel.accountLoaderOverride
        val previousSyncActive = AccountActivity.syncActiveOverride
        val previousSyncRequest = AccountActivity.syncRequestOverride
        val previousCollectionLauncher = AccountActivity.collectionIntentLauncherOverride
        val previousPermissionRequest = AccountActivity.permissionRequestOverride
        val previousBilling = AccountActivity.billingStatusOverride
        var scenario: ActivityScenario<AccountActivity>? = null
        var primary: Throwable? = null
        try {
            ContentResolver.setMasterSyncAutomatically(false)
            HttpClient.testInterceptor = fake
            for (row in listOf(account, other)) {
                check(manager.addAccountExplicitly(row, null, null))
                for (authority in TaskProvider.TASK_PROVIDERS.map { it.authority } + CalendarContract.AUTHORITY + App.addressBooksAuthority) {
                    ContentResolver.setIsSyncable(row, authority, 0)
                }
            }
            AccountSettings.setUserData(manager, account, URI(fake.baseUrl), username)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
            check(AccountSettings.writeSetupState(manager, account, PostLoginSetupState.COMPLETE))
            AccountSettings(context, account).etebaseSession = session
            check(AccountSettings.writeVerified(manager, other, AccountSettings.KEY_CREATION_ID, otherGeneration))
            // The dashboard lists collections from this account's cache only (EtebaseLocalCache.collections). Publish
            // the seeded server state there through the cache's own write path, as a collection refresh does.
            val colMgr = server.collectionManager
            val cache = EtebaseLocalCache.getInstance(context, account.name)
            val calendars = synchronized(cache) {
                published.sorted().map { colMgr.fetch(it) }.onEach { cache.collectionSet(colMgr, it) }
                    .count { it.collectionType == Constants.ETEBASE_TYPE_CALENDAR }
            }
            App.postLoginBootstrapSucceeded = true
            AccountActivity.AccountInfoViewModel.accountLoaderOverride = null
            AccountActivity.syncActiveOverride = { false }
            AccountActivity.syncRequestOverride = { _, exact -> syncRequests += exact }
            AccountActivity.collectionIntentLauncherOverride = { }
            AccountActivity.permissionRequestOverride = { }
            AccountActivity.billingStatusOverride = { _, _, _ -> BillingManager.SubscriptionStatus.unreachable() }
            val launched = ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(context, account))
            scenario = launched
            waitUntil("PREREQUISITE: the dashboard to load this account through its stored session") {
                var delivered = false
                launched.onActivity { delivered = it.hasDeliveredAccountInfo }
                delivered
            }
            assertEquals("PREREQUISITE: the account's stored username is the SDK user", username, AccountSettings(context, account).username())
            assertEquals("PREREQUISITE: the account holds the SDK user's session", session, AccountSettings(context, account).etebaseSession)
            assertTrue("PREREQUISITE: this exact account row is present", account in manager.getAccountsByType(account.type))
            assertEquals("PREREQUISITE: the row holds this generation", generation, manager.getUserData(account, AccountSettings.KEY_CREATION_ID))
            launched.onActivity { activity ->
                assertEquals("PREREQUISITE: the dashboard holds this generation", generation,
                    activity.intent.getStringExtra(AccountActivity.EXTRA_CREATION_ID))
                assertEquals("PREREQUISITE: the dashboard decoded every published calendar through the stored session",
                    calendars, activity.listCalDAV!!.adapter.count)
                assertNotNull("PREREQUISITE: the Calendars menu is rendered with Create calendar",
                    activity.findViewById<Toolbar>(R.id.caldav_menu).menu.findItem(R.id.create_calendar))
            }

            block(launched)

            assertEquals("the account generation is unchanged", generation, manager.getUserData(account, AccountSettings.KEY_CREATION_ID))
            assertTrue("the other account is still present", other in manager.getAccountsByType(other.type))
            assertEquals("the other account's generation is unchanged", otherGeneration,
                manager.getUserData(other, AccountSettings.KEY_CREATION_ID))
            assertFalse("no sync is requested for the other account", other in syncRequests)
        } catch (t: Throwable) {
            primary = t
        }

        // Every step is attempted. A started action must finish before its account, session and
        // transport go. A body failure stays the reported failure, with cleanup failures attached.
        val cleanup = ArrayList<Throwable>()
        fun attempt(step: () -> Unit) {
            try {
                step()
            } catch (t: Throwable) {
                cleanup += t
            }
        }
        attempt { fake.releaseAll() }
        if (invoked.get()) attempt { scenario?.let { awaitIdle(it, "the Birthdays action to finish before teardown") } }
        attempt { scenario?.close() }
        attempt {
            AccountActivity.AccountInfoViewModel.accountLoaderOverride = previousLoader
            AccountActivity.syncActiveOverride = previousSyncActive
            AccountActivity.syncRequestOverride = previousSyncRequest
            AccountActivity.collectionIntentLauncherOverride = previousCollectionLauncher
            AccountActivity.permissionRequestOverride = previousPermissionRequest
            AccountActivity.billingStatusOverride = previousBilling
        }
        attempt { removeAccount(account) }
        attempt { removeAccount(other) }
        attempt {
            EtebaseLocalCache.clearUserCache(context, account.name)
            CollectionListRefresh.collectionLastFetchMap.keys.filter { it.startsWith("${account.name}\u0000") }
                .forEach { CollectionListRefresh.collectionLastFetchMap.remove(it) }
        }
        attempt {
            // Exactly the captured keys: each removed or written back as found, committed, then read back.
            val prefs = context.getSharedPreferences(ACTIVE_ACCOUNT_PREFS, Context.MODE_PRIVATE)
            val editor = prefs.edit()
            for ((key, value) in previousActive) {
                if (value == null) editor.remove(key) else editor.putString(key, value)
            }
            check(editor.commit()) { "the active-account preference could not be committed back" }
            val restored = prefs.all
            check(ACTIVE_ACCOUNT_KEYS.all { key -> restored[key] == previousActive[key] }) {
                "the active-account preference was not restored exactly"
            }
        }
        attempt { HttpClient.testInterceptor = previousInterceptor }
        attempt { App.postLoginBootstrapSucceeded = previousBootstrap }
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
        private const val TURN_ON = "Turn on Birthdays calendar"
        private const val TURN_OFF = "Turn off Birthdays calendar"
        private const val ADMIN = 1L
        /** The server's access level for read-write (Etebase: read-only 0, admin 1, read-write 2). */
        private const val READ_WRITE = 2L
        /** ActiveAccountManager's preference file and its two keys (ActiveAccountManager.kt:11-13), for an exact restore. */
        private const val ACTIVE_ACCOUNT_PREFS = "active_account"
        private val ACTIVE_ACCOUNT_KEYS = listOf("account_name", "creation_id")
        private const val OTHER_MEMBER = "birthday-activation-sharer"
        private val MEMBER_PATH = Regex("collection/([^/]+)/member/")
        private const val MARKER_ACTIVE = "{\"type\":\"silentsuite.birthdays\",\"v\":1,\"state\":\"active\"}"
        private const val MARKER_RETIRED = "{\"type\":\"silentsuite.birthdays\",\"v\":1,\"state\":\"retired\"}"
        private const val VCARD = "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:contact-alex\r\nFN:Alex Example\r\nBDAY:19900315\r\nEND:VCARD\r\n"
        private const val GENERATED_ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SilentSuite//Birthdays v1//EN\r\n" +
            "BEGIN:VEVENT\r\nUID:ss-bday1-c8970a5b3457981540f4ee428f84a1f4\r\nDTSTAMP:19720101T000000Z\r\n" +
            "DTSTART;VALUE=DATE:19720315\r\nDTEND;VALUE=DATE:19720316\r\nRRULE:FREQ=YEARLY\r\n" +
            "SUMMARY:🎂 Alex Example\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        private const val ORDINARY_ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other client//EN\r\n" +
            "BEGIN:VEVENT\r\nUID:ordinary-dentist\r\nDTSTAMP:20261031T120000Z\r\n" +
            "DTSTART:20261105T090000Z\r\nDTEND:20261105T100000Z\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

        private val username = "birthday-activation-${System.nanoTime()}"

        /** One Etebase signup for the whole class; the session works against any stand-in server. */
        private val session: String by lazy {
            val fake = FakeEtebaseServer()
            val client = Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
            com.etebase.client.Account.signup(client, User(username, "birthday-activation@example.invalid"), "stand-in-server-only").save(null)
        }
    }
}
