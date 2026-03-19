/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android

import android.Manifest
import android.accounts.Account
import android.content.ContentProviderClient
import android.content.ContentUris
import android.content.ContentValues
import android.provider.CalendarContract
import androidx.test.filters.MediumTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import at.bitfire.ical4android.MiscUtils.ContentProviderClientHelper.closeCompat
import at.bitfire.ical4android.impl.TestCalendar
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class AndroidCalendarTest {

    @JvmField
    @Rule
    val permissionRule = GrantPermissionRule.grant(
            Manifest.permission.READ_CALENDAR,
            Manifest.permission.WRITE_CALENDAR
    )!!

    private val testAccount = Account("ical4android.AndroidCalendarTest", CalendarContract.ACCOUNT_TYPE_LOCAL)

    private lateinit var provider: ContentProviderClient

    @Before
    fun prepare() {
        provider = InstrumentationRegistry.getInstrumentation().targetContext.contentResolver.acquireContentProviderClient(CalendarContract.AUTHORITY)!!
    }

    @After
    fun shutdown() {
        provider.closeCompat()
    }


    @MediumTest
    @Test
    fun testManageCalendars() {
        // create calendar
        val info = ContentValues()
        info.put(CalendarContract.Calendars.NAME, "TestCalendar")
        info.put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, "ical4android Test Calendar")
        info.put(CalendarContract.Calendars.VISIBLE, 0)
        info.put(CalendarContract.Calendars.SYNC_EVENTS, 0)
        val uri = AndroidCalendar.create(testAccount, provider, info)
        assertNotNull(uri)

        // query task list
        val calendar = AndroidCalendar.findByID(testAccount, provider, TestCalendar.Factory, ContentUris.parseId(uri))
        assertNotNull(calendar)

        // delete task list
        assertEquals(1, calendar.delete())
    }

}
