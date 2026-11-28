package io.silentsuite.sync.ui

import io.silentsuite.sync.ui.importlocal.DeviceImport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Once calendar, contacts or tasks access was denied with "Don't ask again", Android answers every request at once
 * with a denial. The permissions screen then offers SilentSuite's app settings, the only place left to grant it.
 */
class PermissionsSettingsRouteTest {
    private fun source(path: String) = File("src/main/$path").readText().replace("\r\n", "\n")

    @Test fun `a denial Android will not ask again is told apart from one it will`() {
        val requested = listOf("android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR")
        assertEquals(DeviceImport.PermissionOutcome.DENIED_PERMANENTLY,
            DeviceImport.permissionOutcome(requested, granted = { false }, canAskAgain = { false }))
        assertEquals(DeviceImport.PermissionOutcome.DENIED,
            DeviceImport.permissionOutcome(requested, granted = { false }, canAskAgain = { true }))
        // A request the system cancelled returns no permissions and changes nothing.
        assertEquals(DeviceImport.PermissionOutcome.GRANTED,
            DeviceImport.permissionOutcome(emptyList(), granted = { false }, canAskAgain = { false }))
    }

    @Test fun `the settings route goes once the permanently denied permissions are granted, even if others are missing`() {
        val calendar = setOf("android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR")
        val contacts = listOf("android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS")
        val granted = mutableSetOf<String>()
        val permanentlyDenied = mutableSetOf<String>()

        // Calendar is denied with "don't ask again"; contacts was never requested.
        assertEquals(DeviceImport.PermissionOutcome.DENIED_PERMANENTLY,
            DeviceImport.permissionOutcome(calendar.toList(), granted = granted::contains, canAskAgain = { false }))
        permanentlyDenied += calendar.filterNot(granted::contains)
        assertTrue(DeviceImport.settingsStillNeeded(permanentlyDenied, granted::contains))

        // Only one of the pair granted in Settings: the route is still needed.
        granted += "android.permission.READ_CALENDAR"
        assertTrue(DeviceImport.settingsStillNeeded(permanentlyDenied, granted::contains))

        // Calendar granted in Settings, contacts still missing but requestable: the route goes.
        granted += calendar
        assertFalse(contacts.all(granted::contains))
        assertFalse(DeviceImport.settingsStillNeeded(permanentlyDenied, granted::contains))
        assertFalse(DeviceImport.settingsStillNeeded(emptySet(), granted::contains))
    }

    @Test fun `the screen offers app settings after a permanent denial and keeps the offer across recreation`() {
        val activity = source("java/io/silentsuite/sync/ui/PermissionsActivity.kt")
        val layout = source("res/layout/activity_permissions.xml")

        val result = activity.substringAfter("override fun onRequestPermissionsResult(").substringBefore("\n    }\n")
        assertTrue(result.contains("DeviceImport.permissionOutcome("))
        assertTrue(result.contains("ActivityCompat.shouldShowRequestPermissionRationale(this, it)"))
        assertTrue(result.contains("DeviceImport.PermissionOutcome.DENIED_PERMANENTLY"))
        assertTrue(result.indexOf("settingsNeeded += permissions.filterNot(::isGranted)") < result.indexOf("refresh()"))

        val refresh = activity.substringAfter("protected fun refresh() {").substringBefore("\n    }\n")
        assertTrue(refresh.contains("R.id.permissions_settings"))
        assertTrue(refresh.contains("DeviceImport.settingsStillNeeded(settingsNeeded, ::isGranted) && requirements.isNotEmpty()"))

        assertTrue(activity.contains("outState.putStringArrayList(STATE_SETTINGS_NEEDED, ArrayList(settingsNeeded))"))
        assertTrue(activity.contains("savedInstanceState?.getStringArrayList(STATE_SETTINGS_NEEDED)?.let(settingsNeeded::addAll)"))

        val open = activity.substringAfter("fun openAppSettings(v: View) {").substringBefore("\n    }\n")
        assertTrue(open.contains("Settings.ACTION_APPLICATION_DETAILS_SETTINGS"))
        assertTrue(open.contains("Uri.parse(\"package:\$packageName\")"))

        val section = layout.substringAfter("android:id=\"@+id/permissions_settings\"")
        assertTrue(layout.contains("android:id=\"@+id/permissions_settings\""))
        assertTrue(section.substringBefore("</LinearLayout>").contains("android:visibility=\"gone\""))
        assertTrue(section.contains("@string/import_device_permission_settings"))
        assertTrue(section.contains("android:onClick=\"openAppSettings\""))
        assertTrue(section.contains("@string/import_device_permission_open_settings"))
        assertFalse("no second copy of the same words", source("res/values/strings.xml")
            .contains("name=\"permissions_open_settings\""))
    }
}
