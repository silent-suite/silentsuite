package io.silentsuite.sync.ui.importlocal

import io.silentsuite.sync.Constants
import io.silentsuite.sync.ui.setup.ContextualPermissionPlan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class DeviceImportTest {
    private val calendar = ContextualPermissionPlan.CALENDAR
    private val contacts = ContextualPermissionPlan.CONTACTS

    @Test fun `calendars and contacts ask for their READ and WRITE pair and tasks ask for nothing`() {
        assertEquals(listOf("android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"),
            DeviceImport.permissionsFor(Constants.ETEBASE_TYPE_CALENDAR))
        assertEquals(listOf("android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"),
            DeviceImport.permissionsFor(Constants.ETEBASE_TYPE_ADDRESS_BOOK))
        assertEquals(emptyList<String>(), DeviceImport.permissionsFor(Constants.ETEBASE_TYPE_TASKS))
    }

    @Test fun `both permissions granted opens the picker`() {
        assertEquals(DeviceImport.PermissionOutcome.GRANTED,
            DeviceImport.permissionOutcome(calendar, granted = { true }, canAskAgain = { false }))
    }

    @Test fun `a denied permission that Android may ask again for is a plain denial`() {
        assertEquals(DeviceImport.PermissionOutcome.DENIED,
            DeviceImport.permissionOutcome(contacts, granted = { false }, canAskAgain = { true }))
    }

    @Test fun `read granted but write denied is still a denial`() {
        assertEquals(DeviceImport.PermissionOutcome.DENIED,
            DeviceImport.permissionOutcome(calendar,
                granted = { it == "android.permission.READ_CALENDAR" },
                canAskAgain = { it == "android.permission.WRITE_CALENDAR" }))
    }

    @Test fun `denied with don't ask again needs the app settings`() {
        assertEquals(DeviceImport.PermissionOutcome.DENIED_PERMANENTLY,
            DeviceImport.permissionOutcome(contacts, granted = { false }, canAskAgain = { false }))
        // The rationale flag of an already granted permission does not count.
        assertEquals(DeviceImport.PermissionOutcome.DENIED_PERMANENTLY,
            DeviceImport.permissionOutcome(calendar,
                granted = { it == "android.permission.READ_CALENDAR" },
                canAskAgain = { it == "android.permission.READ_CALENDAR" }))
    }

    @Test fun `own account types and accounts without a type are not import sources`() {
        val own = setOf("io.silentsuite.sync", "io.silentsuite.sync.address_book")
        assertTrue(DeviceImport.isImportSource("com.google", own))
        assertFalse(DeviceImport.isImportSource("io.silentsuite.sync", own))
        assertFalse(DeviceImport.isImportSource("io.silentsuite.sync.address_book", own))
        assertFalse(DeviceImport.isImportSource(null, own))
        assertFalse(DeviceImport.isImportSource("", own))
    }

    @Test fun `only a calendar this account may add events to is writable`() {
        // CalendarContract.Calendars: READ 200, CONTRIBUTOR 500, EDITOR 600, OWNER 700.
        assertFalse(DeviceImport.calendarWritable(null))
        assertFalse(DeviceImport.calendarWritable(200))
        assertTrue(DeviceImport.calendarWritable(500))
        assertTrue(DeviceImport.calendarWritable(700))
    }

    @Test fun `an event keeps its own iCalendar UID`() {
        assertEquals("series@example.com",
            DeviceImport.importUid("series@example.com", "event", "com.google", "me@example.com", "cal", "sync-1", 7))
    }

    @Test fun `a row without its own UID gets the same derived UID on every import`() {
        val first = DeviceImport.importUid(null, "contact", "com.google", "me@example.com", "", "source-1", 7)
        val again = DeviceImport.importUid(null, "contact", "com.google", "me@example.com", "", "source-1", 7)
        val blankOwn = DeviceImport.importUid(" ", "contact", "com.google", "me@example.com", "", "source-1", 7)
        assertEquals(first, again)
        assertEquals(first, blankOwn)
        // The source ID identifies the row; its row ID only stands in when there is none.
        assertEquals(first, DeviceImport.importUid(null, "contact", "com.google", "me@example.com", "", "source-1", 99))
    }

    @Test fun `derived UIDs differ by account, container, kind and row`() {
        val base = DeviceImport.importUid(null, "event", "com.google", "me@example.com", "cal-a", null, 7)
        listOf(
            DeviceImport.importUid(null, "event", "com.google", "me@example.com", "cal-a", null, 8),
            DeviceImport.importUid(null, "event", "com.google", "me@example.com", "cal-b", null, 7),
            DeviceImport.importUid(null, "event", "com.google", "other@example.com", "cal-a", null, 7),
            DeviceImport.importUid(null, "event", "com.example.other", "me@example.com", "cal-a", null, 7),
            DeviceImport.importUid(null, "contact", "com.google", "me@example.com", "cal-a", null, 7),
            DeviceImport.importUid(null, "event", "com.google", "me@example.com", "cal-a", "sync-7", 7),
        ).forEach { assertNotEquals(base, it) }
    }

    @Test fun `source groups become labels next to the contact's own categories`() {
        val titles = mapOf(1L to "Family", 2L to "Work ", 3L to "Climbing")
        assertEquals(listOf("Friends", "Family", "Work"),
            DeviceImport.labels(listOf("Friends", "Family"), listOf(1L, 2L, 42L), titles))
        assertEquals(emptyList<String>(), DeviceImport.labels(emptyList(), listOf(42L), titles))
    }

    @Test fun `system groups are not imported as labels`() {
        assertTrue(DeviceImport.isImportableGroup("Family", null))
        assertFalse(DeviceImport.isImportableGroup("My Contacts", "Contacts"))
        assertFalse(DeviceImport.isImportableGroup("Starred in Android", "Starred"))
        assertFalse(DeviceImport.isImportableGroup(" ", null))
        assertFalse(DeviceImport.isImportableGroup(null, null))
    }

    @Test fun `a series is copied through its master and replaced by its master`() {
        assertEquals("original_id IS NULL AND deleted=0", DeviceImport.SOURCE_EVENT_SELECTION)
        assertEquals("uid2445=? AND original_id IS NULL", DeviceImport.DESTINATION_SERIES_SELECTION)
    }

    @Test fun `calendars and address books offer the choice and tasks keep direct file import`() {
        val view = File("src/main/java/io/silentsuite/sync/ui/etebase/ViewCollectionFragment.kt").readText()
        val startImport = view.substringAfter("private fun startImport").substringBefore("private fun createExportDocument")
        assertTrue(startImport.contains("Constants.ETEBASE_TYPE_CALENDAR -> CollectionInfo.Type.CALENDAR"))
        assertTrue(startImport.contains("Constants.ETEBASE_TYPE_ADDRESS_BOOK -> CollectionInfo.Type.ADDRESS_BOOK"))
        assertTrue(startImport.contains("ImportActivity.newIntent("))
        assertTrue(startImport.contains("add(ImportFragment.newInstance(identity), null)"))
        // The read-only refusal still comes first.
        assertTrue(startImport.indexOf("CollectionAccessLevel.ReadOnly") < startImport.indexOf("ImportActivity.newIntent("))
    }

    @Test fun `pickers open only after access and refuse without it or without a writable destination`() {
        val dir = File("src/main/java/io/silentsuite/sync/ui/importlocal")
        val activity = File(dir, "ImportActivity.kt").readText()
        assertTrue(activity.substringAfter("override fun importAccount()").substringBefore("override fun onResume")
            .contains("deviceAccess.start()"))
        listOf("LocalCalendarImportFragment.kt", "LocalContactImportFragment.kt").forEach { name ->
            val source = File(dir, name).readText()
            val created = source.substringAfter("override fun onViewCreated").substringBefore("private fun showSourcesIfDestinationWritable")
            assertTrue(name, created.contains("DeviceImportAccess.granted("))
            assertTrue(name, created.indexOf("DeviceImportAccess.refuse(") < created.indexOf("showSourcesIfDestinationWritable()"))
            assertTrue(name, source.contains("DeviceImportAccess.destinationProblem(destination)"))
            assertTrue(name, source.contains("catch (e: SecurityException)"))
        }
    }
}
