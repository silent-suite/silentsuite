package io.silentsuite.sync.ui.importlocal

import android.accounts.Account
import android.content.ContentResolver
import android.database.Cursor
import android.net.Uri
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import at.bitfire.ical4android.AndroidCalendar
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.resource.LocalCalendar
import java.util.*

/**
 * Created by tal on 27/03/17.
 */

class CalendarAccount protected constructor(val account: Account) {
    private val calendars = ArrayList<LocalCalendar>()

    val accountName: String
        get() = account.name

    val accountType: String
        get() = account.type

    fun getCalendars(): List<LocalCalendar> {
        return calendars
    }

    override fun toString(): String {
        return account.toString()
    }

    companion object {

        private val CAL_COLS = arrayOf(Calendars._ID, Calendars.ACCOUNT_NAME, Calendars.ACCOUNT_TYPE, Calendars.DELETED)

        // Load all available calendars of other accounts (not [ownAccountTypes]).
        // If an empty list is returned the caller probably needs to enable calendar
        // read permissions in App Ops/XPrivacy etc.
        fun loadAll(resolver: ContentResolver, ownAccountTypes: Set<String>): List<CalendarAccount> {

            if (missing(resolver, Calendars.CONTENT_URI) || missing(resolver, Events.CONTENT_URI))
                return ArrayList()

            val cur = resolver.query(Calendars.CONTENT_URI,
                    CAL_COLS, null, null,
                    Calendars.ACCOUNT_NAME + " ASC, " + Calendars.ACCOUNT_TYPE) ?: return ArrayList()

            val calendarAccounts = ArrayList<CalendarAccount>(cur.count)

            var calendarAccount: CalendarAccount? = null

            val contentProviderClient = resolver.acquireContentProviderClient(CalendarContract.CONTENT_URI)
            if (contentProviderClient == null) {
                cur.close()
                return calendarAccounts
            }
            try {
                while (cur.moveToNext()) {
                    if (getLong(cur, Calendars.DELETED) != 0L)
                        continue

                    val accountName = getString(cur, Calendars.ACCOUNT_NAME)
                    val accountType = getString(cur, Calendars.ACCOUNT_TYPE)
                    if (accountName.isNullOrBlank() || !DeviceImport.isImportSource(accountType, ownAccountTypes))
                        continue
                    if (calendarAccount == null ||
                            calendarAccount.accountName != accountName ||
                            calendarAccount.accountType != accountType) {
                        calendarAccount = CalendarAccount(Account(accountName, accountType!!))
                        calendarAccounts.add(calendarAccount)
                    }

                    try {
                        // By row ID: a calendar's NAME may be missing or shared by several calendars.
                        val localCalendar = AndroidCalendar.findByID(calendarAccount.account,
                                contentProviderClient,
                                LocalCalendar.Factory, getLong(cur, Calendars._ID))
                        calendarAccount.calendars.add(localCalendar)
                    } catch (ex: Exception) {
                        Logger.log.warning("Couldn't read a calendar of another account: ${ex.javaClass.name}")
                    }
                }
            } finally {
                contentProviderClient.release()
                cur.close()
            }
            return calendarAccounts.filter { it.calendars.isNotEmpty() }
        }

        private fun getColumnIndex(cur: Cursor?, dbName: String?): Int {
            return if (dbName == null) -1 else cur!!.getColumnIndex(dbName)
        }

        private fun getLong(cur: Cursor?, dbName: String): Long {
            val i = getColumnIndex(cur, dbName)
            return if (i == -1) -1 else cur!!.getLong(i)
        }

        private fun getString(cur: Cursor?, dbName: String): String? {
            val i = getColumnIndex(cur, dbName)
            return if (i == -1) null else cur!!.getString(i)
        }

        private fun missing(resolver: ContentResolver, uri: Uri): Boolean {
            // Determine if a provider is missing
            val provider = resolver.acquireContentProviderClient(uri)
            provider?.release()
            return provider == null
        }
    }
}
