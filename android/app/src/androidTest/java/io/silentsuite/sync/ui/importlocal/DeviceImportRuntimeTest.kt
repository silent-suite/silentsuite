package io.silentsuite.sync.ui.importlocal

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderClient
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.GroupMembership
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.provider.ContactsContract.Data
import android.provider.ContactsContract.Groups
import android.provider.ContactsContract.RawContacts
import android.view.View
import android.widget.ExpandableListView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import at.bitfire.ical4android.AndroidCalendar
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.resource.LocalCalendar
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * "Import from an account on this phone" (#48) against the real calendar and contacts providers.
 * Source data is written the way another app's sync adapter writes it: calendars of a LOCAL calendar
 * account and contacts of a separate registered account, through sync-adapter URIs. Every fixture row
 * and account is removed again afterwards. Permission denial and revocation can't be driven here
 * (revoking a runtime permission kills the instrumentation process); those paths are checked by hand.
 */
@RunWith(AndroidJUnit4::class)
class DeviceImportRuntimeTest {
    @get:Rule
    val permissionRule: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.READ_CALENDAR,
        Manifest.permission.WRITE_CALENDAR,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.WRITE_CONTACTS,
    )

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager = AccountManager.get(context)
    private val registeredAccounts = mutableListOf<Account>()
    private val localCalendarAccounts = mutableListOf<Account>()
    private val phoneOnlyRawContacts = mutableListOf<Long>()
    private lateinit var calendarProvider: ContentProviderClient
    private lateinit var contactsProvider: ContentProviderClient

    private val berlin = "Europe/Berlin"
    private val start = 1_900_000_800_000L
    private val hour = 3_600_000L
    private val week = 7 * 24 * hour
    private val allDayStart = 86_400_000L * 21_991
    private val seriesUid = "series@device-import.invalid"

    @Before fun setUp() {
        calendarProvider = checkNotNull(context.contentResolver.acquireContentProviderClient(CalendarContract.AUTHORITY))
        contactsProvider = checkNotNull(context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY))
    }

    @After fun tearDown() {
        val problems = mutableListOf<Throwable>()
        for (account in localCalendarAccounts + registeredAccounts) runCatching {
            calendarProvider.delete(calendarSyncUri(Calendars.CONTENT_URI, account),
                "${Calendars.ACCOUNT_NAME}=? AND ${Calendars.ACCOUNT_TYPE}=?", arrayOf(account.name, account.type))
        }.exceptionOrNull()?.let(problems::add)
        for (account in registeredAccounts) runCatching {
            contactsProvider.delete(contactsSyncUri(RawContacts.CONTENT_URI),
                "${RawContacts.ACCOUNT_NAME}=? AND ${RawContacts.ACCOUNT_TYPE}=?", arrayOf(account.name, account.type))
            contactsProvider.delete(contactsSyncUri(Groups.CONTENT_URI),
                "${Groups.ACCOUNT_NAME}=? AND ${Groups.ACCOUNT_TYPE}=?", arrayOf(account.name, account.type))
        }.exceptionOrNull()?.let(problems::add)
        for (id in phoneOnlyRawContacts) runCatching {
            contactsProvider.delete(contactsSyncUri(ContentUris.withAppendedId(RawContacts.CONTENT_URI, id)), null, null)
        }.exceptionOrNull()?.let(problems::add)
        for (account in registeredAccounts.reversed()) runCatching { manager.removeAccountExplicitly(account) }
            .exceptionOrNull()?.let(problems::add)
        @Suppress("DEPRECATION") calendarProvider.release()
        @Suppress("DEPRECATION") contactsProvider.release()
        problems.firstOrNull()?.let { throw it }
    }

    @Test
    fun aRecurringSeriesWithExceptionsAllDayAndTimeZonesIsCopiedAsDirtyRowsAndAReimportReplacesIt() {
        val source = sourceCalendar("Personal")
        seedSeries(source, seriesUid, "series-sync")
        val allDayRow = insertEvent(source, ContentValues().apply {
            put(Events.TITLE, "All day")
            put(Events.ALL_DAY, 1)
            put(Events.DTSTART, allDayStart)
            put(Events.DTEND, allDayStart + 24 * hour)
            put(Events.EVENT_TIMEZONE, "UTC")
        })
        insertEvent(source, ContentValues().apply {
            put(Events.TITLE, "New York")
            put(Events.DTSTART, start + 3 * hour)
            put(Events.DTEND, start + 4 * hour)
            put(Events.EVENT_TIMEZONE, "America/New_York")
            put(Events._SYNC_ID, "ny-sync")
        })
        val destination = destinationCalendar()

        val first = DeviceImporter.copyCalendar(source, destination, stillCurrent = { true })
        assertEquals(3L, first.total)
        assertEquals(3L, first.added)
        assertEquals(0L, first.failed)
        assertCompleteCopy(destination)
        val copied = rows(destination)
        val allDay = copied.single { it.title == "All day" }
        assertEquals(1, allDay.allDay)
        assertEquals(allDayStart, allDay.dtStart)
        assertEquals("an event without its own UID gets the derived UID",
            DeviceImport.eventImportUid(null, source.account.type, source.account.name, source.id, null, allDayRow), allDay.uid)
        val newYork = copied.single { it.title == "New York" }
        assertEquals("America/New_York", newYork.timeZone)
        assertEquals(start + 3 * hour, newYork.dtStart)
        assertTrue("every copied row is dirty: $copied", copied.all { it.dirty == 1 })
        assertEquals("the calendar sync uploads all three copies", 3, destination.findDirty(null).size)

        val again = DeviceImporter.copyCalendar(source, destination, stillCurrent = { true })
        assertEquals(0L, again.added)
        assertEquals(3L, again.updated)
        assertCompleteCopy(destination)
    }

    @Test
    fun anInterruptedImportIsCompletedByTheRetryWithoutDuplicatesOrALostException() {
        val source = sourceCalendar("Personal")
        seedSeries(source, seriesUid, "series-sync")
        insertEvent(source, ContentValues().apply {
            put(Events.TITLE, "New York")
            put(Events.DTSTART, start + 3 * hour)
            put(Events.DTEND, start + 4 * hour)
            put(Events.EVENT_TIMEZONE, "America/New_York")
        })
        val destination = destinationCalendar()

        var checks = 0
        try {
            DeviceImporter.copyCalendar(source, destination, stillCurrent = { checks++ == 0 })
            fail("the copy continued after its route became stale")
        } catch (expected: DeviceImporter.StaleRoute) {
        }
        assertEquals("one unit was written before the stop", 1, rows(destination).count { it.originalId == null })
        // As if an earlier run had left the series without its exception: the retry must restore it.
        calendarProvider.delete(calendarSyncUri(Events.CONTENT_URI, destination.account),
            "${Events.CALENDAR_ID}=? AND ${Events.ORIGINAL_ID} IS NOT NULL", arrayOf(destination.id.toString()))

        val retry = DeviceImporter.copyCalendar(source, destination, stillCurrent = { true })
        assertEquals(2L, retry.total)
        assertEquals(1L, retry.added)
        assertEquals(1L, retry.updated)
        val copied = rows(destination)
        assertEquals(2, copied.count { it.originalId == null })
        val series = copied.single { it.uid == seriesUid }
        assertNotNull(series.exDate)
        assertEquals("Moved", copied.single { it.originalId == series.id }.title)
    }

    @Test
    fun calendarsSharingANameStaySeparateAndARenamedCalendarIsStillRecognised() {
        val sourceAccount = localCalendarAccount()
        val first = calendar(sourceAccount, "work")
        val second = calendar(sourceAccount, "work")
        for ((calendar, title) in listOf(first to "From the first", second to "From the second"))
            insertEvent(calendar, ContentValues().apply {
                put(Events.TITLE, title)
                put(Events.DTSTART, start)
                put(Events.DTEND, start + hour)
                put(Events.EVENT_TIMEZONE, berlin)
                put(Events._SYNC_ID, "event-1")
            })
        val destination = destinationCalendar()

        DeviceImporter.copyCalendar(first, destination, stillCurrent = { true })
        DeviceImporter.copyCalendar(second, destination, stillCurrent = { true })
        assertEquals(setOf("From the first", "From the second"), rows(destination).map { it.title }.toSet())

        calendarProvider.update(calendarSyncUri(ContentUris.withAppendedId(Calendars.CONTENT_URI, first.id), sourceAccount),
            ContentValues().apply { put(Calendars.NAME, "renamed") }, null, null)
        val renamed = AndroidCalendar.findByID(sourceAccount, calendarProvider, LocalCalendar.Factory, first.id)
        assertEquals("renamed", renamed.name)
        val again = DeviceImporter.copyCalendar(renamed, destination, stillCurrent = { true })
        assertEquals(0L, again.added)
        assertEquals(1L, again.updated)
        assertEquals(2, rows(destination).size)
    }

    @Test
    fun contactsCopyUserGroupsAsLabelsLeavePhoneOnlyContactsOutAndAReimportReplaces() {
        val sourceAccount = contactsAccount("device-import-contacts-source")
        val family = insertGroup(sourceAccount, "Family", null)
        val myContacts = insertGroup(sourceAccount, "My Contacts", "Contacts")
        val ada = insertRawContact(sourceAccount, "Ada", "Lovelace", "ada-source")
        addMembership(ada, family)
        addMembership(ada, myContacts)
        insertRawContact(sourceAccount, "Bob", "Builder", null)
        insertPhoneOnlyContact("Phone", "Only")
        assertTrue(DeviceImporter.phoneOnlyContactCount(context.contentResolver) >= 1)

        val destinationAccount = contactsAccount("device-import-contacts-destination")
        val destination = LocalAddressBook(context, destinationAccount, contactsProvider)
        val source = LocalAddressBook(context, sourceAccount, contactsProvider)

        val first = DeviceImporter.copyContacts(source, destination, stillCurrent = { true })
        assertEquals("only the source account's two contacts", 2L, first.total)
        assertEquals(2L, first.added)
        assertEquals(0L, first.failed)
        assertContactCopy(destination, sourceAccount, ada)

        val again = DeviceImporter.copyContacts(source, destination, stillCurrent = { true })
        assertEquals(0L, again.added)
        assertEquals(2L, again.updated)
        assertContactCopy(destination, sourceAccount, ada)
    }

    @Test
    fun missingAndReadOnlyDestinationsAreRefusedBeforeAnythingIsCopied() {
        val creationId = "device-import-${System.nanoTime()}"
        val main = mainAccount(creationId)
        assertSame(DeviceImporter.Destination.Missing,
            DeviceImporter.destinationCalendar(main, calendarProvider, "no-such-calendar"))
        calendar(main, "read-only-calendar", Calendars.CAL_ACCESS_READ)
        assertSame(DeviceImporter.Destination.ReadOnly,
            DeviceImporter.destinationCalendar(main, calendarProvider, "read-only-calendar"))
        calendar(main, "own-calendar")
        assertTrue(DeviceImporter.destinationCalendar(main, calendarProvider, "own-calendar") is DeviceImporter.Destination.Ready)

        assertSame(DeviceImporter.Destination.Missing,
            DeviceImporter.destinationAddressBook(context, main, contactsProvider, "no-such-book"))
        val bookAccount = Account("device-import-book-${System.nanoTime()}", App.addressBookAccountType)
        check(manager.addAccountExplicitly(bookAccount, null, Bundle().apply {
            putString(LocalAddressBook.USER_DATA_MAIN_ACCOUNT_NAME, main.name)
            putString(LocalAddressBook.USER_DATA_MAIN_ACCOUNT_TYPE, main.type)
            putString(LocalAddressBook.USER_DATA_URL, "book-uid")
        }))
        registeredAccounts += bookAccount
        disableSync(bookAccount)
        assertTrue(DeviceImporter.destinationAddressBook(context, main, contactsProvider, "book-uid") is DeviceImporter.Destination.Ready)
        LocalAddressBook(context, bookAccount, contactsProvider).readOnly = true
        assertSame(DeviceImporter.Destination.ReadOnly,
            DeviceImporter.destinationAddressBook(context, main, contactsProvider, "book-uid"))

        // The picker says why and lists no source to copy from.
        assertPickerRefuses(main, creationId, "no-such-calendar", R.string.import_device_destination_missing)
        assertPickerRefuses(main, creationId, "read-only-calendar", R.string.edit_owner_only_anon)
    }

    // fixtures

    private fun assertCompleteCopy(destination: LocalCalendar) {
        val copied = rows(destination)
        assertEquals("three units, no duplicates: $copied", 3, copied.count { it.originalId == null })
        val series = copied.single { it.uid == seriesUid }
        assertTrue(series.rrule.orEmpty().contains("FREQ=WEEKLY"))
        assertTrue(series.rrule.orEmpty().contains("COUNT=5"))
        assertEquals(berlin, series.timeZone)
        assertEquals(start, series.dtStart)
        assertNotNull("the cancelled occurrence is excluded", series.exDate)
        val exceptions = copied.filter { it.originalId != null }
        assertEquals("only the modified occurrence is an exception row: $copied", 1, exceptions.size)
        val moved = exceptions.single()
        assertEquals(series.id, moved.originalId)
        assertEquals("Moved", moved.title)
        assertEquals(start + week, moved.originalInstanceTime)
        assertEquals(start + week + 2 * hour, moved.dtStart)
    }

    private fun assertContactCopy(destination: LocalAddressBook, sourceAccount: Account, adaRow: Long) {
        val copies = destination.findAllContacts()
        assertEquals(2, copies.size)
        val names = copies.map { requireNotNull(it.contact).displayName }.toSet()
        assertEquals(setOf("Ada Lovelace", "Bob Builder"), names)
        val adaUid = DeviceImport.contactImportUid(sourceAccount.type, sourceAccount.name, "ada-source", adaRow)
        val ada = requireNotNull(destination.findContactByUID(adaUid)) { "Ada's copy has the derived UID" }
        assertEquals("a user group becomes a label, a system group does not",
            listOf("Family"), requireNotNull(ada.contact).categories.toList())
        val bob = copies.single { requireNotNull(it.contact).displayName == "Bob Builder" }
        assertTrue(requireNotNull(bob.contact).categories.isEmpty())
        val dirty = contactsProvider.query(destination.syncAdapterURI(RawContacts.CONTENT_URI), arrayOf(RawContacts.DIRTY),
            "${RawContacts.ACCOUNT_NAME}=? AND ${RawContacts.ACCOUNT_TYPE}=? AND ${RawContacts.DELETED}=0",
            arrayOf(destination.account.name, destination.account.type), null)!!.use { cursor ->
            val flags = mutableListOf<Int>()
            while (cursor.moveToNext()) flags += cursor.getInt(0)
            flags
        }
        assertEquals("both copies are dirty for the contacts sync", listOf(1, 1), dirty)
    }

    private fun assertPickerRefuses(main: Account, creationId: String, collectionUid: String, message: Int) {
        val info = CollectionInfo().apply {
            uid = collectionUid
            enumType = CollectionInfo.Type.CALENDAR
        }
        ActivityScenario.launch<ImportActivity>(ImportActivity.newIntent(context, main, creationId, info)).use { scenario ->
            waitUntil("import chooser") {
                var shown = false
                scenario.onActivity { shown = it.findViewById<View>(R.id.import_account)?.isShown == true }
                shown
            }
            scenario.onActivity { it.findViewById<View>(R.id.import_account).performClick() }
            val expected = context.getString(message)
            waitUntil("refusal for $collectionUid") {
                var refused = false
                scenario.onActivity { activity ->
                    refused = activity.supportFragmentManager.fragments.any { it is LocalCalendarImportFragment } &&
                        activity.findViewById<TextView>(R.id.import_notice)?.text?.toString() == expected
                }
                refused
            }
            scenario.onActivity { activity ->
                assertNull("no source is listed", activity.findViewById<ExpandableListView>(android.R.id.list).expandableListAdapter)
            }
        }
    }

    private data class Row(
        val id: Long, val title: String?, val uid: String?, val originalId: Long?, val dirty: Int, val allDay: Int,
        val timeZone: String?, val dtStart: Long, val rrule: String?, val exDate: String?, val originalInstanceTime: Long?,
    )

    private fun rows(calendar: LocalCalendar): List<Row> =
        checkNotNull(calendarProvider.query(calendarSyncUri(Events.CONTENT_URI, calendar.account),
            arrayOf(Events._ID, Events.TITLE, Events.UID_2445, Events.ORIGINAL_ID, Events.DIRTY, Events.ALL_DAY,
                Events.EVENT_TIMEZONE, Events.DTSTART, Events.RRULE, Events.EXDATE, Events.ORIGINAL_INSTANCE_TIME),
            "${Events.CALENDAR_ID}=? AND ${Events.DELETED}=0", arrayOf(calendar.id.toString()), null)).use { c ->
            val rows = mutableListOf<Row>()
            while (c.moveToNext()) rows += Row(
                c.getLong(0), c.getString(1), c.getString(2), if (c.isNull(3)) null else c.getLong(3), c.getInt(4),
                c.getInt(5), c.getString(6), c.getLong(7), c.getString(8), c.getString(9), if (c.isNull(10)) null else c.getLong(10),
            )
            rows
        }

    private fun seedSeries(calendar: LocalCalendar, uid: String?, syncId: String?) {
        val master = insertEvent(calendar, ContentValues().apply {
            put(Events.TITLE, "Weekly")
            put(Events.DTSTART, start)
            put(Events.DURATION, "PT1H")
            put(Events.EVENT_TIMEZONE, berlin)
            put(Events.RRULE, "FREQ=WEEKLY;COUNT=5")
            uid?.let { put(Events.UID_2445, it) }
            syncId?.let { put(Events._SYNC_ID, it) }
        })
        // A modified occurrence (one week in, two hours later) and a cancelled one (two weeks in).
        insertEvent(calendar, exception(master, syncId, start + week, "Moved", start + week + 2 * hour, cancelled = false))
        insertEvent(calendar, exception(master, syncId, start + 2 * week, "Weekly", start + 2 * week, cancelled = true))
    }

    private fun exception(master: Long, syncId: String?, instance: Long, title: String, dtStart: Long, cancelled: Boolean) =
        ContentValues().apply {
            put(Events.ORIGINAL_ID, master)
            syncId?.let { put(Events.ORIGINAL_SYNC_ID, it) }
            put(Events.ORIGINAL_INSTANCE_TIME, instance)
            put(Events.ORIGINAL_ALL_DAY, 0)
            put(Events.TITLE, title)
            put(Events.DTSTART, dtStart)
            put(Events.DTEND, dtStart + hour)
            put(Events.EVENT_TIMEZONE, berlin)
            if (cancelled) put(Events.STATUS, Events.STATUS_CANCELED)
        }

    private fun insertEvent(calendar: LocalCalendar, values: ContentValues): Long {
        values.put(Events.CALENDAR_ID, calendar.id)
        return ContentUris.parseId(checkNotNull(calendarProvider.insert(calendarSyncUri(Events.CONTENT_URI, calendar.account), values)))
    }

    private fun localCalendarAccount() =
        Account("device-import-source-${System.nanoTime()}", CalendarContract.ACCOUNT_TYPE_LOCAL).also { localCalendarAccounts += it }

    private fun sourceCalendar(name: String) = calendar(localCalendarAccount(), name)

    private fun destinationCalendar(): LocalCalendar = calendar(mainAccount("device-import-${System.nanoTime()}"), "destination-uid")

    private fun calendar(account: Account, name: String, accessLevel: Int = Calendars.CAL_ACCESS_OWNER): LocalCalendar {
        val uri = AndroidCalendar.create(account, calendarProvider, ContentValues().apply {
            put(Calendars.NAME, name)
            put(Calendars.CALENDAR_DISPLAY_NAME, name)
            put(Calendars.CALENDAR_COLOR, 0xff336699.toInt())
            put(Calendars.CALENDAR_ACCESS_LEVEL, accessLevel)
            put(Calendars.OWNER_ACCOUNT, account.name)
            put(Calendars.VISIBLE, 1)
            put(Calendars.SYNC_EVENTS, 1)
        })
        return AndroidCalendar.findByID(account, calendarProvider, LocalCalendar.Factory, ContentUris.parseId(uri))
    }

    private fun mainAccount(creationId: String): Account {
        val account = Account("device-import-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(account, null, Bundle().apply {
            putString(AccountSettings.KEY_CREATION_ID, creationId)
            putString(AccountSettings.KEY_SETTINGS_VERSION, AccountSettings.CURRENT_VERSION.toString())
        }))
        registeredAccounts += account
        disableSync(account)
        return account
    }

    /** ContactsProvider purges rows of accounts AccountManager does not know, so the source is registered too. */
    private fun contactsAccount(prefix: String): Account {
        val account = Account("$prefix-${System.nanoTime()}", App.addressBookAccountType)
        check(manager.addAccountExplicitly(account, null, null))
        registeredAccounts += account
        disableSync(account)
        return account
    }

    private fun disableSync(account: Account) {
        ContentResolver.getSyncAdapterTypes().filter { it.accountType == account.type }.forEach { adapter ->
            ContentResolver.setSyncAutomatically(account, adapter.authority, false)
            ContentResolver.setIsSyncable(account, adapter.authority, 0)
            ContentResolver.removePeriodicSync(account, adapter.authority, Bundle())
        }
    }

    private fun insertGroup(account: Account, title: String, systemId: String?): Long =
        ContentUris.parseId(checkNotNull(contactsProvider.insert(contactsSyncUri(Groups.CONTENT_URI), ContentValues().apply {
            put(Groups.ACCOUNT_NAME, account.name)
            put(Groups.ACCOUNT_TYPE, account.type)
            put(Groups.TITLE, title)
            systemId?.let { put(Groups.SYSTEM_ID, it) }
        })))

    private fun insertRawContact(account: Account, given: String, family: String, sourceId: String?): Long {
        val id = ContentUris.parseId(checkNotNull(contactsProvider.insert(contactsSyncUri(RawContacts.CONTENT_URI), ContentValues().apply {
            put(RawContacts.ACCOUNT_NAME, account.name)
            put(RawContacts.ACCOUNT_TYPE, account.type)
            sourceId?.let { put(RawContacts.SOURCE_ID, it) }
        })))
        insertName(id, given, family, contactsSyncUri(Data.CONTENT_URI))
        return id
    }

    private fun insertPhoneOnlyContact(given: String, family: String) {
        val id = ContentUris.parseId(checkNotNull(context.contentResolver.insert(RawContacts.CONTENT_URI, ContentValues().apply {
            putNull(RawContacts.ACCOUNT_NAME)
            putNull(RawContacts.ACCOUNT_TYPE)
        })))
        phoneOnlyRawContacts += id
        insertName(id, given, family, Data.CONTENT_URI)
    }

    private fun insertName(rawContact: Long, given: String, family: String, uri: Uri) {
        checkNotNull(contactsProvider.insert(uri, ContentValues().apply {
            put(Data.RAW_CONTACT_ID, rawContact)
            put(Data.MIMETYPE, StructuredName.CONTENT_ITEM_TYPE)
            put(StructuredName.GIVEN_NAME, given)
            put(StructuredName.FAMILY_NAME, family)
            put(StructuredName.DISPLAY_NAME, "$given $family")
        }))
    }

    private fun addMembership(rawContact: Long, group: Long) {
        checkNotNull(contactsProvider.insert(contactsSyncUri(Data.CONTENT_URI), ContentValues().apply {
            put(Data.RAW_CONTACT_ID, rawContact)
            put(Data.MIMETYPE, GroupMembership.CONTENT_ITEM_TYPE)
            put(GroupMembership.GROUP_ROW_ID, group)
        }))
    }

    private fun calendarSyncUri(uri: Uri, account: Account): Uri = uri.buildUpon()
        .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
        .appendQueryParameter(Calendars.ACCOUNT_NAME, account.name)
        .appendQueryParameter(Calendars.ACCOUNT_TYPE, account.type)
        .build()

    private fun contactsSyncUri(uri: Uri): Uri = uri.buildUpon()
        .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
        .build()

    private fun waitUntil(description: String, timeoutMillis: Long = 10_000, predicate: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < deadline) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            if (predicate()) return
            SystemClock.sleep(25)
        }
        assertTrue("Timed out waiting for $description", predicate())
    }
}
