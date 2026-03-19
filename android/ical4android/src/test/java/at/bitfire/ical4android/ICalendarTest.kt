/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android

import net.fortuna.ical4j.data.CalendarBuilder
import net.fortuna.ical4j.model.Component
import net.fortuna.ical4j.model.Date
import net.fortuna.ical4j.model.DateTime
import net.fortuna.ical4j.model.component.VAlarm
import net.fortuna.ical4j.model.component.VTimeZone
import net.fortuna.ical4j.model.parameter.Related
import net.fortuna.ical4j.model.property.DtEnd
import net.fortuna.ical4j.model.property.DtStart
import net.fortuna.ical4j.model.property.Due
import net.fortuna.ical4j.util.TimeZones
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Duration
import java.time.Period

class ICalendarTest {

	// UTC timezone
	val tzUTC = DateUtils.ical4jTimeZone(TimeZones.UTC_ID)!!.vTimeZone

	// Austria (Europa/Vienna) uses DST regularly
	val vtzVienna = readTimeZone("Vienna.ics")

	// Pakistan (Asia/Karachi) used DST only in 2002, 2008 and 2009; no known future occurrences
	val vtzKarachi = readTimeZone("Karachi.ics")

	// Somalia (Africa/Mogadishu) has never used DST
	val vtzMogadishu = readTimeZone("Mogadishu.ics")

	// current time stamp
	val currentTime = java.util.Date().time


	private fun readTimeZone(fileName: String): VTimeZone {
		javaClass.classLoader!!.getResourceAsStream("tz/$fileName").use { tzStream ->
			val cal = CalendarBuilder().build(tzStream)
			val vTimeZone = cal.getComponent(Component.VTIMEZONE) as VTimeZone
			return vTimeZone
		}
	}


	@Test
	fun testMinifyVTimezone_UTC() {
		// Keep the only observance for UTC.
		// DATE-TIME values in UTC are usually noted with ...Z and don't have a VTIMEZONE,
		// but it is allowed to write them as TZID=Etc/UTC.
		assertEquals(1, tzUTC.observances.size)
		ICalendar.minifyVTimeZone(tzUTC, Date("20200612")).let { minified ->
			assertEquals(1, minified.observances.size)
		}
	}

	@Test
	fun testMinifyVTimezone_removeObsoleteDstObservances() {
		// Remove obsolete observances when DST is used.
		assertEquals(6, vtzVienna.observances.size)
		// By default, the earliest observance is in 1893. We can drop that for events in 2020.
		assertEquals(DateTime("18930401T000000"), vtzVienna.observances.sortedBy { it.startDate.date }.first().startDate.date)
		ICalendar.minifyVTimeZone(vtzVienna, Date("20200101")).let { minified ->
			assertEquals(2, minified.observances.size)
			// now earliest observance for DAYLIGHT/STANDARD is 1981/1996
			assertEquals(DateTime("19810329T020000"), minified.observances[0].startDate.date)
			assertEquals(DateTime("19961027T030000"), minified.observances[1].startDate.date)
		}

	}

	@Test
	fun testMinifyVTimezone_removeObsoleteObservances() {
		// Remove obsolete observances when DST is not used. Mogadishu had several time zone changes,
		// but now there is a simple offest without DST.
		assertEquals(4, vtzMogadishu.observances.size)
		ICalendar.minifyVTimeZone(vtzMogadishu, Date("19611001")).let { minified ->
			assertEquals(1, minified.observances.size)
		}
	}

	@Test
	fun testMinifyVTimezone_keepFutureObservances() {
		// Keep future observances.
		ICalendar.minifyVTimeZone(vtzVienna, Date("19751001")).let { minified ->
			assertEquals(4, minified.observances.size)
			assertEquals(DateTime("19160430T230000"), minified.observances[2].startDate.date)
			assertEquals(DateTime("19161001T010000"), minified.observances[3].startDate.date)
		}
		ICalendar.minifyVTimeZone(vtzKarachi, Date("19611001")).let { minified ->
			assertEquals(4, minified.observances.size)
		}
		ICalendar.minifyVTimeZone(vtzKarachi, Date("19751001")).let { minified ->
			assertEquals(3, minified.observances.size)
		}
		ICalendar.minifyVTimeZone(vtzMogadishu, Date("19311001")).let { minified ->
			assertEquals(3, minified.observances.size)
		}
	}

	@Test
	fun testMinifyVTimezone_keepDstWhenStartInDst() {
		// Keep DST when there are no obsolete observances, but start time is in DST.
		ICalendar.minifyVTimeZone(vtzKarachi, Date("20091031")).let { minified ->
			assertEquals(2, minified.observances.size)
		}
	}

	@Test
	fun testMinifyVTimezone_removeDstWhenNotUsedAnymore() {
		// Remove obsolete observances (including DST) when DST is not used anymore.
		ICalendar.minifyVTimeZone(vtzKarachi, Date("201001001")).let { minified ->
			assertEquals(1, minified.observances.size)
		}
	}


    @Test
    fun testTimezoneDefToTzId_Valid() {
		assertEquals("US-Eastern", ICalendar.timezoneDefToTzId("BEGIN:VCALENDAR\n" +
				"PRODID:-//Example Corp.//CalDAV Client//EN\n" +
				"VERSION:2.0\n" +
				"BEGIN:VTIMEZONE\n" +
				"TZID:US-Eastern\n" +
				"LAST-MODIFIED:19870101T000000Z\n" +
				"BEGIN:STANDARD\n" +
				"DTSTART:19671029T020000\n" +
				"RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10\n" +
				"TZOFFSETFROM:-0400\n" +
				"TZOFFSETTO:-0500\n" +
				"TZNAME:Eastern Standard Time (US &amp; Canada)\n" +
				"END:STANDARD\n" +
				"BEGIN:DAYLIGHT\n" +
				"DTSTART:19870405T020000\n" +
				"RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4\n" +
				"TZOFFSETFROM:-0500\n" +
				"TZOFFSETTO:-0400\n" +
				"TZNAME:Eastern Daylight Time (US &amp; Canada)\n" +
				"END:DAYLIGHT\n" +
				"END:VTIMEZONE\n" +
				"END:VCALENDAR"))
	}

	@Test
	fun testTimezoneDefToTzId_Invalid() {
		// invalid time zone
		assertNull(ICalendar.timezoneDefToTzId("/* invalid content */"))

        // time zone without TZID
		assertNull(ICalendar.timezoneDefToTzId("BEGIN:VCALENDAR\n" +
				"PRODID:-//Inverse inc./SOGo 2.2.10//EN\n" +
				"VERSION:2.0\n" +
				"END:VCALENDAR"))
    }


	@Test
	fun testVAlarmToMin_TriggerDuration_Negative() {
		// TRIGGER;REL=START:-P1DT1H1M29S
		val (ref, min) = ICalendar.vAlarmToMin(
				VAlarm(Duration.parse("-P1DT1H1M29S")),
				Event(), false)!!
		assertEquals(Related.START, ref)
		assertEquals(60*24 + 60 + 1, min)
	}

	@Test
	fun testVAlarmToMin_TriggerDuration_OnlySeconds() {
		// TRIGGER;REL=START:-PT3600S
		val (ref, min) = ICalendar.vAlarmToMin(
				VAlarm(Duration.parse("-PT3600S")),
				Event(), false)!!
		assertEquals(Related.START, ref)
		assertEquals(60, min)
	}

	@Test
	fun testVAlarmToMin_TriggerDuration_Positive() {
		// TRIGGER;REL=START:P1DT1H1M30S (alarm *after* start)
		val (ref, min) = ICalendar.vAlarmToMin(
				VAlarm(Duration.parse("P1DT1H1M30S")),
				Event(), false)!!
		assertEquals(Related.START, ref)
		assertEquals(-(60*24 + 60 + 1), min)
	}

	@Test
	fun testVAlarmToMin_TriggerDuration_RelEndAllowed() {
		// TRIGGER;REL=END:-P1DT1H1M30S (caller accepts Related.END)
		val alarm = VAlarm(Duration.parse("-P1DT1H1M30S"))
		alarm.trigger.parameters.add(Related.END)
		val (ref, min) = ICalendar.vAlarmToMin(alarm, Event(), true)!!
		assertEquals(Related.END, ref)
		assertEquals(60*24 + 60 + 1, min)
	}

	@Test
	fun testVAlarmToMin_TriggerDuration_RelEndNotAllowed() {
		// event with TRIGGER;REL=END:-PT30S (caller doesn't accept Related.END)
		val alarm = VAlarm(Duration.parse("-PT65S"))
		alarm.trigger.parameters.add(Related.END)
		val event = Event()
		event.dtStart = DtStart(DateTime(currentTime))
		event.dtEnd = DtEnd(DateTime(currentTime + 180*1000))    // 180 sec later
		val (ref, min) = ICalendar.vAlarmToMin(alarm, event, false)!!
		assertEquals(Related.START, ref)
		// duration of event: 180 s (3 min), 65 s before that -> alarm 1:55 min before start
		assertEquals(-1, min)
	}

	@Test
	fun testVAlarmToMin_TriggerDuration_RelEndNotAllowed_NoDtStart() {
		// event with TRIGGER;REL=END:-PT30S (caller doesn't accept Related.END)
		val alarm = VAlarm(Duration.parse("-PT65S"))
		alarm.trigger.parameters.add(Related.END)
		val event = Event()
		event.dtEnd = DtEnd(DateTime(currentTime))
		assertNull(ICalendar.vAlarmToMin(alarm, event, false))
	}

	@Test
	fun testVAlarmToMin_TriggerDuration_RelEndNotAllowed_NoDuration() {
		// event with TRIGGER;REL=END:-PT30S (caller doesn't accept Related.END)
		val alarm = VAlarm(Duration.parse("-PT65S"))
		alarm.trigger.parameters.add(Related.END)
		val event = Event()
		event.dtStart = DtStart(DateTime(currentTime))
		assertNull(ICalendar.vAlarmToMin(alarm, event, false))
	}

	@Test
	fun testVAlarmToMin_TriggerDuration_RelEndNotAllowed_AfterEnd() {
		// task with TRIGGER;REL=END:-P1DT1H1M30S (caller doesn't accept Related.END; alarm *after* end)
		val alarm = VAlarm(Duration.parse("P1DT1H1M30S"))
		alarm.trigger.parameters.add(Related.END)
		val task = Task()
		task.dtStart = DtStart(DateTime(currentTime))
		task.due = Due(DateTime(currentTime + 90*1000))	// 90 sec (should be rounded down to 1 min) later
		val (ref, min) = ICalendar.vAlarmToMin(alarm, task, false)!!
		assertEquals(Related.START, ref)
		assertEquals(-(60*24 + 60 + 1 + 1) /* duration of event: */ - 1, min)
	}

	@Test
	fun testVAlarm_TriggerPeriod() {
		val event = Event()
		event.dtStart = DtStart(Date(currentTime))
		val (ref, min) = ICalendar.vAlarmToMin(
				VAlarm(Period.parse("-P1W1D")),
				event, false
		)!!
		assertEquals(Related.START, ref)
		assertEquals(8*24*60, min)
	}

	@Test
	fun testVAlarm_TriggerAbsoluteValue() {
		// TRIGGER;VALUE=DATE-TIME:<xxxx>
		val event = Event()
		event.dtStart = DtStart(DateTime(currentTime))
		val alarm = VAlarm(DateTime(currentTime - 89*1000))	// 89 sec (should be cut off to 1 min) before event
		alarm.trigger.parameters.add(Related.END)	// not useful for DATE-TIME values, should be ignored
		val (ref, min) = ICalendar.vAlarmToMin(alarm, event, false)!!
		assertEquals(Related.START, ref)
		assertEquals(1, min)
	}

	/*
	DOES NOT WORK YET! Will work as soon as Java 8 API is consequently used in ical4j and ical4android.

	@Test
	fun testVAlarm_TriggerPeriod_CrossingDST() {
		// Event start: 2020/04/01 01:00 Vienna, alarm: one day before start of the event
		// DST changes on 2020/03/29 02:00 -> 03:00, so there is one hour less!
		// The alarm has to be set 23 hours before the event so that it is set one day earlier.
		val event = Event()
		event.dtStart = DtStart("20200401T010000", tzVienna)
		val (ref, min) = ICalendar.vAlarmToMin(
				VAlarm(Period.parse("-P1W1D")),
				event, false
		)!!
		assertEquals(Related.START, ref)
		assertEquals(8*24*60, min)
	}*/

}