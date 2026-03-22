/*
 * Copyright © 2013 – 2015 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.content.Context
import android.content.SyncResult
import android.os.Build
import android.os.Bundle
import at.bitfire.ical4android.CalendarStorageException
import at.bitfire.ical4android.Event
import at.bitfire.ical4android.InvalidCalendarException
import at.bitfire.vcard4android.ContactsStorageException
import com.etebase.client.Item
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.resource.LocalEvent
import io.silentsuite.sync.utils.EventEmailInvitation
import okhttp3.HttpUrl
import java.io.IOException
import java.io.StringReader

/**
 *
 * Synchronization manager for CalDAV collections; handles calendars.
 */
class CalendarSyncManager
constructor(context: Context, account: Account, settings: AccountSettings, extras: Bundle, authority: String, result: SyncResult, calendar: LocalCalendar, private val remote: HttpUrl) : SyncManager<LocalEvent>(context, account, settings, extras, authority, result, calendar.name!!, CollectionInfo.Type.CALENDAR, account.name) {

    override val syncErrorTitle: String
        get() = context.getString(R.string.sync_error_calendar, account.name)

    override val syncSuccessfullyTitle: String
        get() = context.getString(R.string.sync_successfully_calendar, localCalendar().displayName,
                account.name)

    init {
        localCollection = calendar
    }

    override fun notificationId(): Int {
        return Constants.NOTIFICATION_CALENDAR_SYNC
    }

    @Throws(ContactsStorageException::class, CalendarStorageException::class)
    override fun prepare(): Boolean {
        if (!super.prepare())
            return false

        return true
    }

    @Throws(CalendarStorageException::class, ContactsStorageException::class)
    override fun prepareDirty() {
        super.prepareDirty()

        localCalendar().processDirtyExceptions()
    }


    // helpers

    private fun localCalendar(): LocalCalendar {
        return localCollection as LocalCalendar
    }

    override fun processItem(item: Item) {
        val local = localCollection!!.findByFilename(item.uid)

        if (!item.isDeleted) {
            val inputReader = StringReader(String(item.content))

            val events = Event.eventsFromReader(inputReader)
            if (events.size == 0) {
                Logger.log.warning("Received VCard without data, ignoring")
                return
            } else if (events.size > 1) {
                Logger.log.warning("Received multiple VCALs, using first one")
            }

            val event = events[0]
            processEvent(item, event, local)
        } else {
            if (local != null) {
                Logger.log.info("Removing local record #" + local.id + " which has been deleted on the server")
                local.delete()
            } else {
                Logger.log.warning("Tried deleting a non-existent record: " + item.uid)
            }
        }
    }

    @Throws(CalendarStorageException::class, ContactsStorageException::class, IOException::class)
    override fun prepareLocal() {
        super.prepareLocal()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            createInviteAttendeesNotification()
        }
    }

    @Throws(CalendarStorageException::class, ContactsStorageException::class, IOException::class)
    private fun createInviteAttendeesNotification() {
        for (local in localDirty) {
            val event = local.event

            if (event?.attendees?.isEmpty()!! || !event.organizer?.value?.replace("mailto:", "").equals(account.name)) {
                return
            }
            createInviteAttendeesNotification(event, local.content)
        }
    }

    private fun createInviteAttendeesNotification(event: Event, icsContent: String) {
        val intent = EventEmailInvitation(context, account).createIntent(event, icsContent)
        if (intent != null) {
            val notificationHelper = SyncNotification(context, icsContent, event.hashCode())
            notificationHelper.notify(
                    context.getString(
                            R.string.sync_calendar_attendees_notification_title, event.summary),
                    context.getString(R.string.sync_calendar_attendees_notification_content), null,
                    intent,
                    R.drawable.ic_email_black)
        }
    }

    private fun processEvent(item: Item, newData: Event, _localEvent: LocalEvent?): LocalEvent {
        var localEvent = _localEvent
        // delete local event, if it exists
        if (localEvent != null) {
            Logger.log.info("Updating " + newData.uid + " in local calendar")
            localEvent.eTag = item.etag
            localEvent.update(newData)
            syncResult.stats.numUpdates++
        } else {
            Logger.log.info("Adding " + newData.uid + " to local calendar")
            localEvent = LocalEvent(localCalendar(), newData, item.uid, item.etag)
            localEvent.add()
            syncResult.stats.numInserts++
        }

        return localEvent
    }
}
