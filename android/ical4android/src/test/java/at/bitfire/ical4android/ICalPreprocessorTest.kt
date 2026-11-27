package at.bitfire.ical4android

import net.fortuna.ical4j.data.CalendarBuilder
import net.fortuna.ical4j.model.Component
import net.fortuna.ical4j.model.component.VEvent
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.InputStreamReader
import java.io.StringReader

class ICalPreprocessorTest {

    @Test
    fun testFixInvalidUtcOffset() {
        val invalid = "BEGIN:VEVENT" +
                "SUMMARY:Test" +
                "DTSTART;TZID=Test:19970714T133000" +
                "END:VEVENT" +
                "BEGIN:VTIMEZONE\n" +
                "TZID:Test\n" +
                "BEGIN:DAYLIGHT\n" +
                "DTSTART:19670430T020000\n" +
                "TZOFFSETFROM:-5730\n" +
                "TZOFFSETTO:+1920\n" +
                "TZNAME:EDT\n" +
                "END:DAYLIGHT\n" +
                "BEGIN:STANDARD\n" +
                "DTSTART:19671029T020000\n" +
                "TZOFFSETFROM:-0400\n" +
                "TZOFFSETTO:-0500\n" +
                "TZNAME:EST" +
                "END:STANDARD\n" +
                "END:VTIMEZONE"
        val valid = "BEGIN:VEVENT" +
                "SUMMARY:Test" +
                "DTSTART;TZID=Test:19970714T133000" +
                "END:VEVENT" +
                "BEGIN:VTIMEZONE\n" +
                "TZID:Test\n" +
                "BEGIN:DAYLIGHT\n" +
                "DTSTART:19670430T020000\n" +
                "TZOFFSETFROM:-005730\n" +
                "TZOFFSETTO:+001920\n" +
                "TZNAME:EDT\n" +
                "END:DAYLIGHT\n" +
                "BEGIN:STANDARD\n" +
                "DTSTART:19671029T020000\n" +
                "TZOFFSETFROM:-0400\n" +
                "TZOFFSETTO:-0500\n" +
                "TZNAME:EST" +
                "END:STANDARD\n" +
                "END:VTIMEZONE"
        ICalPreprocessor.fixInvalidUtcOffset(StringReader(invalid)).let { result ->
            assertEquals(valid, result.readText())
        }
        ICalPreprocessor.fixInvalidUtcOffset(StringReader(valid)).let { result ->
            assertEquals(valid, result.readText())
        }
    }

    @Test
    fun testFixInvalidRecurrenceRules() {
        fun fix(ics: String) = ICalPreprocessor.fixInvalidRecurrenceRules(StringReader(ics)).readText()

        // lower-case names and values
        assertEquals("BEGIN:VEVENT\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\n",
                fix("BEGIN:VEVENT\r\nRRULE:freq=weekly;count=3\r\nEND:VEVENT\r\n"))
        // empty rule part
        assertEquals("BEGIN:VEVENT\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\n",
                fix("BEGIN:VEVENT\r\nRRULE:FREQ=WEEKLY;BYDAY=\r\nEND:VEVENT\r\n"))
        // EXRULE, folded line
        assertEquals("BEGIN:VEVENT\r\nEXRULE:FREQ=DAILY;INTERVAL=2\r\nEND:VEVENT\r\n",
                fix("BEGIN:VEVENT\r\nEXRULE:freq=daily;\r\n interval=2;;\r\nEND:VEVENT\r\n"))
        // valid rule and other properties stay unchanged
        val valid = "BEGIN:VEVENT\r\nSUMMARY:freq=weekly;BYDAY=\r\nRRULE:FREQ=MONTHLY;BYDAY=-1SU;UNTIL=20261231T000000Z\r\nEND:VEVENT\r\n"
        assertEquals(valid, fix(valid))
    }

    @Test
    fun testParseInvalidRecurrenceRules() {
        fun rRule(rule: String) = Event.eventsFromReader(StringReader(
                listOf("BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:test", "BEGIN:VEVENT", "UID:recur",
                        "DTSTART:20261201T100000Z", rule, "END:VEVENT", "END:VCALENDAR", "").joinToString("\r\n")
        )).single().rRules.single()

        assertEquals("FREQ=WEEKLY;COUNT=3", rRule("RRULE:freq=weekly;count=3").value)
        assertEquals("FREQ=WEEKLY", rRule("RRULE:FREQ=WEEKLY;BYDAY=").value)
    }

    @Test
    fun testMsTimeZones() {
        javaClass.classLoader!!.getResourceAsStream("events/outlook1.ics").use { stream ->
            val reader = InputStreamReader(stream, Charsets.UTF_8)
            val calendar = CalendarBuilder().build(reader)
            val vEvent = calendar.getComponent(Component.VEVENT) as VEvent

            assertEquals("W. Europe Standard Time", vEvent.startDate.timeZone.id)
            ICalPreprocessor.preProcess(calendar)
            assertEquals("Europe/Vienna", vEvent.startDate.timeZone.id)
        }
    }

}