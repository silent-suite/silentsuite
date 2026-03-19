/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android

import android.accounts.Account
import android.content.ContentProviderClient
import android.content.ContentUris
import android.content.ContentValues
import android.net.Uri
import android.provider.CalendarContract.*
import at.bitfire.ical4android.MiscUtils.CursorHelper.toValues
import java.io.FileNotFoundException
import java.util.*
import java.util.logging.Level

/**
 * Represents a locally stored calendar, containing [AndroidEvent]s (whose data objects are [Event]s).
 * Communicates with the Android Contacts Provider which uses an SQLite
 * database to store the events.
 */
abstract class AndroidCalendar<out T: AndroidEvent>(
        val account: Account,
        val provider: ContentProviderClient,
        val eventFactory: AndroidEventFactory<T>,

        /** the calendar ID ([Calendars._ID]) **/
        val id: Long
) {

    companion object {

        /**
         * Recommended initial values when creating Android [Calendars].
         */
        val calendarBaseValues = ContentValues(3).apply {
            put(Calendars.ALLOWED_AVAILABILITY, "${Events.AVAILABILITY_BUSY},${Events.AVAILABILITY_FREE}")
            put(Calendars.ALLOWED_ATTENDEE_TYPES, "${Attendees.TYPE_NONE},${Attendees.TYPE_OPTIONAL},${Attendees.TYPE_REQUIRED},${Attendees.TYPE_RESOURCE}")
            put(Calendars.ALLOWED_REMINDERS, "${Reminders.METHOD_DEFAULT},${Reminders.METHOD_ALERT},${Reminders.METHOD_EMAIL}")
        }

        /**
         * Creates a local (Android calendar provider) calendar.
         *
         * @param account       account which the calendar should be assigned to
         * @param provider      client for Android calendar provider
         * @param info          initial calendar properties ([Calendars.CALENDAR_DISPLAY_NAME] etc.) – *may be modified by this method*
         *
         * @return              [Uri] of the created calendar
         *
         * @throws Exception    if the calendar couldn't be created
         */
        fun create(account: Account, provider: ContentProviderClient, info: ContentValues): Uri {
            info.put(Calendars.ACCOUNT_NAME, account.name)
            info.put(Calendars.ACCOUNT_TYPE, account.type)

            info.putAll(calendarBaseValues)

            Ical4Android.log.info("Creating local calendar: $info")
            return provider.insert(syncAdapterURI(Calendars.CONTENT_URI, account), info) ?:
                    throw Exception("Couldn't create calendar: provider returned null")
        }

        fun insertColors(provider: ContentProviderClient, account: Account) {
            provider.query(syncAdapterURI(Colors.CONTENT_URI, account), arrayOf(Colors.COLOR_KEY), null, null, null)?.use { cursor ->
                if (cursor.count == Css3Color.values().size)
                    // colors already inserted and up to date
                    return
            }

            Ical4Android.log.info("Inserting event colors for account $account")
            val values = ContentValues(5)
            values.put(Colors.ACCOUNT_NAME, account.name)
            values.put(Colors.ACCOUNT_TYPE, account.type)
            values.put(Colors.COLOR_TYPE, Colors.TYPE_EVENT)
            for (color in Css3Color.values()) {
                values.put(Colors.COLOR_KEY, color.name)
                values.put(Colors.COLOR, color.argb)
                try {
                    provider.insert(syncAdapterURI(Colors.CONTENT_URI, account), values)
                } catch(e: Exception) {
                    Ical4Android.log.log(Level.WARNING, "Couldn't insert event color: ${color.name}", e)
                }
            }
        }

        fun removeColors(provider: ContentProviderClient, account: Account) {
            Ical4Android.log.info("Removing event colors from account $account")

            // unassign colors from events
            // ANDROID BUG: affects events of all accounts, not just the selected one;
            // account_type and account_name can't be specified in selection, causes
            // SQLiteException: no such column: account_type (code 1): , while compiling: SELECT * FROM Events WHERE eventColor_index IS NOT NULL AND account_type=? AND account_name=?
            /* val values = ContentValues(1)
            values.putNull(Events.EVENT_COLOR_KEY)
            provider.update(syncAdapterURI(Events.CONTENT_URI, account), values,
                    "${Events.EVENT_COLOR_KEY} IS NOT NULL", null) */

            // remove color entries
            provider.delete(syncAdapterURI(Colors.CONTENT_URI, account), null, null)
        }

        fun<T: AndroidCalendar<AndroidEvent>> findByID(account: Account, provider: ContentProviderClient, factory: AndroidCalendarFactory<T>, id: Long): T {
            val iterCalendars = CalendarEntity.newEntityIterator(
                    provider.query(syncAdapterURI(ContentUris.withAppendedId(CalendarEntity.CONTENT_URI, id), account), null, null, null, null)
            )
            try {
                if (iterCalendars.hasNext()) {
                    val values = iterCalendars.next().entityValues
                    val calendar = factory.newInstance(account, provider, id)
                    calendar.populate(values)
                    return calendar
                }
            } finally {
                iterCalendars.close()
            }
            throw FileNotFoundException()
        }

        fun<T: AndroidCalendar<AndroidEvent>> find(account: Account, provider: ContentProviderClient, factory: AndroidCalendarFactory<T>, where: String?, whereArgs: Array<String>?): List<T> {
            val iterCalendars = CalendarEntity.newEntityIterator(
                    provider.query(syncAdapterURI(CalendarEntity.CONTENT_URI, account), null, where, whereArgs, null)
            )
            try {
                val calendars = LinkedList<T>()
                while (iterCalendars.hasNext()) {
                    val values = iterCalendars.next().entityValues
                    val calendar = factory.newInstance(account, provider, values.getAsLong(Calendars._ID))
                    calendar.populate(values)
                    calendars += calendar
                }
                return calendars
            } finally {
                iterCalendars.close()
            }
        }

        fun syncAdapterURI(uri: Uri, account: Account) = uri.buildUpon()
                .appendQueryParameter(Calendars.ACCOUNT_NAME, account.name)
                .appendQueryParameter(Calendars.ACCOUNT_TYPE, account.type)
                .appendQueryParameter(CALLER_IS_SYNCADAPTER, "true")
                .build()!!
    }

    var name: String? = null
    var displayName: String? = null
    var color: Int? = null
    var isSynced = true
    var isVisible = true

    var ownerAccount: String? = null


    protected open fun populate(info: ContentValues) {
        name = info.getAsString(Calendars.NAME)
        displayName = info.getAsString(Calendars.CALENDAR_DISPLAY_NAME)

        color = info.getAsInteger(Calendars.CALENDAR_COLOR)

        isSynced = info.getAsInteger(Calendars.SYNC_EVENTS) != 0
        isVisible = info.getAsInteger(Calendars.VISIBLE) != 0

        ownerAccount = info.getAsString(Calendars.OWNER_ACCOUNT)
    }


    fun update(info: ContentValues) = provider.update(calendarSyncURI(), info, null, null)

    fun delete() = provider.delete(calendarSyncURI(), null, null)


    /**
     * Queries events from this calendar. Adds a WHERE clause that restricts the
     * query to [Events.CALENDAR_ID] = [id].
     * @param _where selection
     * @param _whereArgs arguments for selection
     * @return events from this calendar which match the selection
     */
    fun queryEvents(_where: String? = null, _whereArgs: Array<String>? = null, sortOrder: String? = null): List<T> {
        val where = "(${_where ?: "1"}) AND " + Events.CALENDAR_ID + "=?"
        val whereArgs = (_whereArgs ?: arrayOf()) + id.toString()

        val events = LinkedList<T>()
        provider.query(eventsSyncURI(), null, where, whereArgs, sortOrder)?.use { cursor ->
            while (cursor.moveToNext())
                events += eventFactory.fromProvider(this, cursor.toValues())
        }
        return events
    }

    fun findById(id: Long) = queryEvents("${Events._ID}=?", arrayOf(id.toString())).firstOrNull()
            ?: throw FileNotFoundException()


    fun syncAdapterURI(uri: Uri) = uri.buildUpon()
            .appendQueryParameter(CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(Calendars.ACCOUNT_NAME, account.name)
            .appendQueryParameter(Calendars.ACCOUNT_TYPE, account.type)
            .build()!!

    fun calendarSyncURI() = syncAdapterURI(ContentUris.withAppendedId(Calendars.CONTENT_URI, id))
    fun eventsSyncURI() = syncAdapterURI(Events.CONTENT_URI)

    fun attendeesSyncUri() = syncAdapterURI(Attendees.CONTENT_URI)
    fun remindersSyncUri() = syncAdapterURI(Reminders.CONTENT_URI)

}
