/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */
package at.bitfire.ical4android

import net.fortuna.ical4j.model.Date
import net.fortuna.ical4j.model.DateTime
import net.fortuna.ical4j.model.Parameter
import net.fortuna.ical4j.model.TimeZoneRegistryFactory
import net.fortuna.ical4j.model.component.VAlarm
import net.fortuna.ical4j.model.property.*
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.InputStreamReader
import java.nio.charset.Charset
import java.time.Duration

class EventTest {

    /* public interface tests */

    @Test
    fun testCalendarProperties() {
        javaClass.classLoader!!.getResourceAsStream("events/multiple.ics").use { stream ->
            val properties = mutableMapOf<String, String>()
            Event.eventsFromReader(InputStreamReader(stream, Charsets.UTF_8), properties)
            assertEquals(1, properties.size)
            assertEquals("Test-Kalender", properties[ICalendar.CALENDAR_NAME])
        }
    }

    @Test
    fun testCharsets() {
        var e = parseCalendar("latin1.ics", Charsets.ISO_8859_1)[0]
        assertEquals("äöüß", e.summary)

        e = parseCalendar("utf8.ics").first()
        assertEquals("© äö — üß", e.summary)
        assertEquals("中华人民共和国", e.location)
    }

    @Test
    fun testDstOnlyVtimezone() {
        // see https://github.com/ical4j/ical4j/issues/230
        val events = parseCalendar("dst-only-vtimezone.ics")
        assertEquals(1, events.size)
        val e = events.first()
        assertEquals("only-dst@example.com", e.uid)
        val dtStart = e.dtStart!!
        assertEquals("Europe/Berlin", dtStart.timeZone.id)
        assertEquals(1522738800000L, dtStart.date.time)
    }

    @Test
    fun testGenerateEtcUTC() {
        val tzUTC = DateUtils.ical4jTimeZone("Etc/UTC")

        val e = Event()
        e.uid = "etc-utc-test@example.com"
        e.dtStart = DtStart("20200926T080000", tzUTC)
        e.dtEnd = DtEnd("20200926T100000", tzUTC)
        e.alarms += VAlarm(Duration.ofMinutes(-30))
        e.attendees += Attendee("mailto:test@example.com")
        val baos = ByteArrayOutputStream()
        e.write(baos)
        val ical = baos.toString()

        assertTrue("BEGIN:VTIMEZONE.+BEGIN:STANDARD.+END:STANDARD.+END:VTIMEZONE".toRegex(RegexOption.DOT_MATCHES_ALL).containsMatchIn(ical))
    }

    @Test
    fun testGrouping() {
        val events = parseCalendar("multiple.ics")
        assertEquals(3, events.size)

        var e = findEvent(events, "multiple-0@ical4android.EventTest")
        assertEquals("Event 0", e.summary)
        assertEquals(0, e.exceptions.size)

        e = findEvent(events, "multiple-1@ical4android.EventTest")
        assertEquals("Event 1", e.summary)
        assertEquals(1, e.exceptions.size)
        assertEquals("Event 1 Exception", e.exceptions.first.summary)

        e = findEvent(events, "multiple-2@ical4android.EventTest")
        assertEquals("Event 2", e.summary)
        assertEquals(2, e.exceptions.size)
        assertTrue("Event 2 Updated Exception 1" == e.exceptions.first.summary || "Event 2 Updated Exception 1" == e.exceptions[1].summary)
        assertTrue("Event 2 Exception 2" == e.exceptions.first.summary || "Event 2 Exception 2" == e.exceptions[1].summary)
    }

    @Test
    fun testParse() {
        val event = parseCalendar("utf8.ics").first()
        assertEquals("utf8@ical4android.EventTest", event.uid)
        assertEquals("© äö — üß", event.summary)
        assertEquals("Test Description", event.description)
        assertEquals("中华人民共和国", event.location)
        assertEquals(Css3Color.aliceblue, event.color)

        // TODO: use attendee.getParameter<Email>(Parameter.EMAIL) when
        // https://github.com/ical4j/ical4j/pull/413 and
        // https://github.com/ical4j/ical4j/pull/414 are merged
        assertEquals("cyrus@example.com", event.attendees.first.parameters.getParameter<Parameter>("EMAIL").value)

        val unknown = event.unknownProperties.first
        assertEquals("X-UNKNOWN-PROP", unknown.name)
        assertEquals("xxx", unknown.getParameter<Parameter>("param1").value)
        assertEquals("Unknown Value", unknown.value)
    }

    @Test
    fun testRecurringWriteFullDayException() {
        val event = Event().apply {
            uid = "test1"
            dtStart = DtStart("20190117T083000", DateUtils.ical4jTimeZone("Europe/Berlin"))
            summary = "Main event"
            rRules += RRule("FREQ=DAILY;COUNT=5")
            exceptions += arrayOf(
                    Event().apply {
                        uid = "test2"
                        recurrenceId = RecurrenceId(DateTime("20190118T073000", DateUtils.ical4jTimeZone("Europe/London")))
                        summary = "Normal exception"
                    },
                    Event().apply {
                        uid = "test3"
                        recurrenceId = RecurrenceId(Date("20190223"))
                        summary = "Full-day exception"
                    }
            )
        }
        val baos = ByteArrayOutputStream()
        event.write(baos)
        val iCal = baos.toString()
        assertTrue(iCal.contains("UID:test1\r\n"))
        assertTrue(iCal.contains("DTSTART;TZID=Europe/Berlin:20190117T083000\r\n"))

        // first RECURRENCE-ID has been rewritten
        // - to main event's UID
        // - to time zone Europe/Berlin (with one hour time difference)
        assertTrue(iCal.contains("UID:test1\r\n" +
                "RECURRENCE-ID;TZID=Europe/Berlin:20190118T083000\r\n" +
                "SUMMARY:Normal exception\r\n" +
                "END:VEVENT"))

        // no RECURRENCE-ID;VALUE=DATE:20190223
        assertFalse(iCal.contains(":20190223"))
    }

    @Test
    fun testRecurringWithException() {
        val event = parseCalendar("recurring-with-exception1.ics").first()
        assertTrue(DateUtils.isDate(event.dtStart))

        assertEquals(1, event.exceptions.size)
        val exception = event.exceptions.first
        assertEquals("20150503", exception.recurrenceId!!.value)
        assertEquals("Another summary for the third day", exception.summary)
    }

    @Test
    fun testStartEndTimes() {
        // event with start+end date-time
        val eViennaEvolution = parseCalendar("vienna-evolution.ics").first()
        assertEquals(1381330800000L, eViennaEvolution.dtStart!!.date.time)
        assertEquals("Europe/Vienna", eViennaEvolution.dtStart!!.timeZone.id)
        assertEquals(1381334400000L, eViennaEvolution.dtEnd!!.date.time)
        assertEquals("Europe/Vienna", eViennaEvolution.dtEnd!!.timeZone.id)
    }

    @Test
    fun testStartEndTimesAllDay() {
        // event with start date only
        val eOnThatDay = parseCalendar("event-on-that-day.ics").first()
        assertEquals(868838400000L, eOnThatDay.dtStart!!.date.time)
        assertNull(eOnThatDay.dtStart!!.timeZone)

        // event with start+end date for all-day event (one day)
        val eAllDay1Day = parseCalendar("all-day-1day.ics").first()
        assertEquals(868838400000L, eAllDay1Day.dtStart!!.date.time)
        assertNull(eAllDay1Day.dtStart!!.timeZone)
        assertEquals(868838400000L + 86400000, eAllDay1Day.dtEnd!!.date.time)
        assertNull(eAllDay1Day.dtEnd!!.timeZone)

        // event with start+end date for all-day event (ten days)
        val eAllDay10Days = parseCalendar("all-day-10days.ics").first()
        assertEquals(868838400000L, eAllDay10Days.dtStart!!.date.time)
        assertNull(eAllDay10Days.dtStart!!.timeZone)
        assertEquals(868838400000L + 10 * 86400000, eAllDay10Days.dtEnd!!.date.time)
        assertNull(eAllDay10Days.dtEnd!!.timeZone)

        // event with start+end date on some day (0 sec-event)
        val eAllDay0Sec = parseCalendar("all-day-0sec.ics").first()
        assertEquals(868838400000L, eAllDay0Sec.dtStart!!.date.time)
        assertNull(eAllDay0Sec.dtStart!!.timeZone)
        // DTEND is same as DTSTART which is not valid for Android – but this will be handled by AndroidEvent, not Event
        assertEquals(868838400000L, eAllDay0Sec.dtEnd!!.date.time)
        assertNull(eAllDay0Sec.dtEnd!!.timeZone)
    }

    @Test
    fun testUnfolding() {
        val e = parseCalendar("two-line-description-without-crlf.ics").first()
        assertEquals("http://www.tgbornheim.de/index.php?sessionid=&page=&id=&sportcentergroup=&day=6", e.description)
    }

    @Test
    fun testToString() {
        val e = Event()
        e.uid = "SAMPLEUID"
        val s = e.toString()
        assertTrue(s.contains(Event::class.java.simpleName))
        assertTrue(s.contains("uid=SAMPLEUID"))
    }


    /* generating */

    @Test
    fun testWrite() {
        val e = Event()
        e.uid = "SAMPLEUID"
        e.dtStart = DtStart("20190101T100000", TimeZoneRegistryFactory.getInstance().createRegistry().getTimeZone("Europe/Berlin"))
        e.alarms += VAlarm(Duration.ofHours(-1))

        val os = ByteArrayOutputStream()
        e.write(os)
        val raw = os.toString(Charsets.UTF_8.name())

        assertTrue(raw.contains("PRODID:${ICalendar.prodId.value}"))
        assertTrue(raw.contains("UID:SAMPLEUID"))
        assertTrue(raw.contains("DTSTART;TZID=Europe/Berlin:20190101T100000"))
        assertTrue(raw.contains("DTSTAMP:"))
        assertTrue(raw.contains("BEGIN:VALARM\r\n" +
                "TRIGGER:-PT1H\r\n" +
                "END:VALARM\r\n"))
        assertTrue(raw.contains("BEGIN:VTIMEZONE"))
    }


    /* internal tests */

    @Test
    fun testFindMasterEventsAndExceptions() {
        // two single events
        var events = parseCalendar("two-events-without-exceptions.ics")
        assertEquals(2, events.size)
        for (event in events)
            assertTrue(event.exceptions.isEmpty())

        // one event with exception, another single event
        events = parseCalendar("one-event-with-exception-one-without.ics")
        assertEquals(2, events.size)
        for (event in events) {
            val uid = event.uid
            if ("event1" == uid)
                assertEquals(1, event.exceptions.size)
            else
                assertTrue(event.exceptions.isEmpty())
        }

        // one event two exceptions (thereof one updated two times) and updated exception, another single event
        events = parseCalendar("one-event-with-multiple-exceptions-one-without.ics")
        assertEquals(2, events.size)
        for (event in events) {
            val uid = event.uid
            if ("event1" == uid) {
                assertEquals(2, event.exceptions.size)
                for (exception in event.exceptions)
                    if ("20150503" == exception.recurrenceId!!.value) {
                        assertEquals(2, exception.sequence)
                        assertEquals("Final summary", exception.summary)
                    }
            } else
                assertTrue(event.exceptions.isEmpty())
        }
    }


    // helpers

    private fun findEvent(events: Iterable<Event>, uid: String): Event {
        for (event in events)
            if (uid == event.uid)
                return event
        throw FileNotFoundException()
    }

    private fun parseCalendar(fname: String, charset: Charset = Charsets.UTF_8): List<Event> =
            javaClass.classLoader!!.getResourceAsStream("events/$fname").use { stream ->
                return Event.eventsFromReader(InputStreamReader(stream, charset))
            }

}
