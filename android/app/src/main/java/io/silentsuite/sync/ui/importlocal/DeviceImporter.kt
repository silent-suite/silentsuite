package io.silentsuite.sync.ui.importlocal

import android.accounts.Account
import android.content.ContentProviderClient
import android.content.ContentResolver
import android.content.Context
import android.provider.CalendarContract.Calendars
import android.provider.ContactsContract.Groups
import android.provider.ContactsContract.RawContacts
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.resource.LocalContact
import io.silentsuite.sync.resource.LocalEvent

/**
 * Copies another account's events or contacts into a SilentSuite collection on this phone. The copies
 * are written as dirty rows, so the next sync encrypts and uploads them like any local change.
 */
internal object DeviceImporter {
    /** The account or collection route changed during the copy; nothing more is written. */
    class StaleRoute : Exception()

    sealed class Destination<out T> {
        /** The collection has no local copy yet (not synced to this phone). */
        object Missing : Destination<Nothing>()
        /** The collection is read-only for this account (shared read-only, or the active Birthdays calendar). */
        object ReadOnly : Destination<Nothing>()
        class Ready<T>(val collection: T) : Destination<T>()
    }

    fun destinationCalendar(account: Account, provider: ContentProviderClient, collectionUid: String): Destination<LocalCalendar> {
        val calendar = LocalCalendar.findByName(account, provider, LocalCalendar.Factory, collectionUid)
            ?: return Destination.Missing
        val accessLevel = provider.query(calendar.calendarSyncURI(), arrayOf(Calendars.CALENDAR_ACCESS_LEVEL), null, null, null)
            ?.use { if (it.moveToFirst() && !it.isNull(0)) it.getInt(0) else null }
        return if (DeviceImport.calendarWritable(accessLevel)) Destination.Ready(calendar) else Destination.ReadOnly
    }

    fun destinationAddressBook(context: Context, account: Account, provider: ContentProviderClient, collectionUid: String): Destination<LocalAddressBook> {
        val addressBook = LocalAddressBook.findByUid(context, provider, account, collectionUid)
            ?: return Destination.Missing
        return if (addressBook.readOnly) Destination.ReadOnly else Destination.Ready(addressBook)
    }

    /**
     * Copies every event series of [source] into [destination]. A series already copied earlier (same
     * import UID) is replaced as a whole, so a repeated or interrupted import never duplicates and never
     * keeps half a series. A [SecurityException] (permission removed) or [StaleRoute] stops the copy;
     * the series written before stay complete.
     */
    fun copyCalendar(
        source: LocalCalendar,
        destination: LocalCalendar,
        stillCurrent: () -> Boolean,
        progress: (done: Int, total: Int) -> Unit = { _, _ -> },
    ): ResultFragment.ImportResult {
        val result = ResultFragment.ImportResult()
        val series = source.queryEvents(DeviceImport.SOURCE_EVENT_SELECTION, null)
        result.total = series.size.toLong()
        val container = source.name ?: "calendar:${source.id}"
        series.forEachIndexed { index, sourceRow ->
            if (!stillCurrent()) throw StaleRoute()
            try {
                val event = requireNotNull(sourceRow.event)
                val uid = DeviceImport.importUid(event.uid, "event", source.account.type, source.account.name,
                    container, sourceRow.fileName, sourceRow.id)
                event.uid = uid
                val existing = destination.queryEvents(DeviceImport.DESTINATION_SERIES_SELECTION, arrayOf(uid)).firstOrNull()
                if (existing != null) {
                    existing.updateAsDirty(event)
                    result.updated++
                } else {
                    LocalEvent(destination, event, uid, null).addAsDirty()
                    result.added++
                }
            } catch (e: SecurityException) {
                throw e
            } catch (e: Exception) {
                Logger.log.warning("Couldn't copy an event from another account: ${e.javaClass.name}")
                result.failed++
            }
            progress(index + 1, series.size)
        }
        return result
    }

    /**
     * Copies every contact of [source] into [destination]. The source account's own groups become
     * labels (vCard CATEGORIES) on each contact. A contact copied earlier is replaced, not duplicated.
     */
    fun copyContacts(
        source: LocalAddressBook,
        destination: LocalAddressBook,
        stillCurrent: () -> Boolean,
        progress: (done: Int, total: Int) -> Unit = { _, _ -> },
    ): ResultFragment.ImportResult {
        val result = ResultFragment.ImportResult()
        val groupTitles = importableGroupTitles(source)
        val contacts = source.findAllContacts()
        result.total = contacts.size.toLong()
        contacts.forEachIndexed { index, sourceRow ->
            if (!stillCurrent()) throw StaleRoute()
            try {
                val contact = requireNotNull(sourceRow.contact)
                // Never the other app's RawContacts.SYNC1: it is that sync adapter's private column.
                val uid = DeviceImport.importUid(null, "contact", source.account.type, source.account.name,
                    "", sourceRow.fileName, sourceRow.id)
                contact.uid = uid
                val labels = DeviceImport.labels(contact.categories, sourceRow.getGroupMemberships(), groupTitles)
                contact.categories.clear()
                contact.categories.addAll(labels)
                val existing = destination.findContactByUID(uid)
                if (existing != null) {
                    existing.updateAsDirty(contact)
                    result.updated++
                } else {
                    LocalContact(destination, contact, uid, null).createAsDirty()
                    result.added++
                }
            } catch (e: SecurityException) {
                throw e
            } catch (e: Exception) {
                Logger.log.warning("Couldn't copy a contact from another account: ${e.javaClass.name}")
                result.failed++
            }
            progress(index + 1, contacts.size)
        }
        return result
    }

    private fun importableGroupTitles(source: LocalAddressBook): Map<Long, String> {
        val titles = HashMap<Long, String>()
        source.requireProvider().query(source.groupsSyncUri(), arrayOf(Groups._ID, Groups.TITLE, Groups.SYSTEM_ID),
            "${Groups.ACCOUNT_NAME}=? AND ${Groups.ACCOUNT_TYPE}=? AND ${Groups.DELETED}=0",
            arrayOf(source.account.name, source.account.type), null)?.use { cursor ->
            while (cursor.moveToNext()) {
                val title = cursor.getString(1)
                if (title != null && DeviceImport.isImportableGroup(title, cursor.getString(2)))
                    titles[cursor.getLong(0)] = title.trim()
            }
        }
        return titles
    }

    /**
     * Contacts saved only on the phone, in no account. They are not imported by this route (they have
     * no account to read them through); the picker lists their number and points to file import.
     */
    fun phoneOnlyContactCount(resolver: ContentResolver): Int =
        resolver.query(RawContacts.CONTENT_URI, arrayOf(RawContacts._ID),
            "${RawContacts.ACCOUNT_NAME} IS NULL AND ${RawContacts.DELETED}=0", null, null)?.use { it.count } ?: 0
}
