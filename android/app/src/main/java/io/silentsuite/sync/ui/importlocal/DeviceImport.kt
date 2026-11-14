package io.silentsuite.sync.ui.importlocal

import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import io.silentsuite.sync.Constants
import io.silentsuite.sync.ui.setup.ContextualPermissionPlan
import java.util.UUID

/**
 * Pure rules for "Import from an account on this phone": copying the events or contacts that another
 * account exposes to Android into a SilentSuite collection, which then uploads them encrypted.
 */
object DeviceImport {
    enum class PermissionOutcome { GRANTED, DENIED, DENIED_PERMANENTLY }

    /**
     * READ and WRITE as one pair, like [ContextualPermissionPlan]: the import reads the other account
     * and writes the SilentSuite copy. Tasks have no device import.
     */
    fun permissionsFor(collectionType: String): List<String> = when (collectionType) {
        Constants.ETEBASE_TYPE_CALENDAR -> ContextualPermissionPlan.CALENDAR
        Constants.ETEBASE_TYPE_ADDRESS_BOOK -> ContextualPermissionPlan.CONTACTS
        else -> emptyList()
    }

    /**
     * The state after a permission request returned. [canAskAgain] is Android's rationale flag, which is
     * false once the person chose "don't ask again" (or denied twice): then only app settings can grant it.
     */
    fun permissionOutcome(
        permissions: List<String>,
        granted: (String) -> Boolean,
        canAskAgain: (String) -> Boolean,
    ): PermissionOutcome {
        val missing = permissions.filterNot(granted)
        return when {
            missing.isEmpty() -> PermissionOutcome.GRANTED
            missing.any(canAskAgain) -> PermissionOutcome.DENIED
            else -> PermissionOutcome.DENIED_PERMANENTLY
        }
    }

    /** Other apps' accounts only: SilentSuite's own collections are not a source for each other. */
    fun isImportSource(accountType: String?, ownAccountTypes: Set<String>): Boolean =
        !accountType.isNullOrBlank() && accountType !in ownAccountTypes

    /** A destination calendar takes the copy only when the provider lets this account add events to it. */
    fun calendarWritable(accessLevel: Int?): Boolean =
        accessLevel != null && accessLevel >= Calendars.CAL_ACCESS_CONTRIBUTOR

    /**
     * Source rows to copy: series masters and single events, never the exception rows. Reading a master
     * also reads its exceptions (modified occurrences as exceptions, cancelled ones as EXDATE), so a
     * series is written and replaced as one unit.
     */
    val SOURCE_EVENT_SELECTION = "${Events.ORIGINAL_ID} IS NULL AND ${Events.DELETED}=0"

    /** The copy of a series in the destination: its master row, found by the import UID. */
    val DESTINATION_SERIES_SELECTION = "${Events.UID_2445}=? AND ${Events.ORIGINAL_ID} IS NULL"

    /**
     * The UID of the copy. A calendar event keeps its own iCalendar UID (CalendarContract's UID_2445).
     * Otherwise the UID is derived from where the row comes from (account, container and the row's
     * source ID, or its row ID when the other app has not set one), so importing the same source again
     * finds and replaces the earlier copy instead of adding a second one.
     */
    fun importUid(
        ownUid: String?,
        kind: String,
        accountType: String,
        accountName: String,
        container: String,
        sourceId: String?,
        rowId: Long?,
    ): String {
        ownUid?.takeIf { it.isNotBlank() }?.let { return it }
        val itemKey = sourceId?.takeIf { it.isNotBlank() } ?: "row:$rowId"
        val key = listOf("silentsuite-device-import", kind, accountType, accountName, container, itemKey)
            .joinToString("\u0000")
        return UUID.nameUUIDFromBytes(key.toByteArray(Charsets.UTF_8)).toString()
    }

    /**
     * A contact's labels (vCard CATEGORIES, what SilentSuite shows as contact groups): its own
     * categories plus the titles of the source account's groups it belongs to. [groupTitles] holds
     * only importable groups (see [isImportableGroup]).
     */
    fun labels(existing: Collection<String>, memberGroupIds: Collection<Long>, groupTitles: Map<Long, String>): List<String> =
        (existing + memberGroupIds.mapNotNull { groupTitles[it] })
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .distinct()

    /**
     * User groups become labels. System groups (such as Google's "My Contacts" or "Starred in Android")
     * are account plumbing; as labels they would tag every contact.
     */
    fun isImportableGroup(title: String?, systemId: String?): Boolean =
        !title.isNullOrBlank() && systemId.isNullOrBlank()
}
