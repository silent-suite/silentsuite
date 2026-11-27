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
    fun testFixWeekDurations() {
        val cases = mapOf(
            "TRIGGER:-P1W2DT15H" to "TRIGGER:-P9DT15H",     // Proton Calendar, all-day event reminder
            "TRIGGER:-P1WT2H" to "TRIGGER:-P7DT2H",
            "TRIGGER:P1W2D" to "TRIGGER:P9D",
            "TRIGGER;RELATED=END:+P2W1DT1H30M" to "TRIGGER;RELATED=END:+P15DT1H30M",
            "DURATION:P1W1DT12H" to "DURATION:P8DT12H",
            "trigger:-p1w2dt15h" to "trigger:-p9Dt15h",
            // valid or other values stay as they are
            "TRIGGER:-P2W" to "TRIGGER:-P2W",
            "TRIGGER:-P5D" to "TRIGGER:-P5D",
            "TRIGGER:-PT15H" to "TRIGGER:-PT15H",
            "TRIGGER;VALUE=DATE-TIME:20261210T090000Z" to "TRIGGER;VALUE=DATE-TIME:20261210T090000Z",
            "DESCRIPTION:TRIGGER:-P1W2DT15H" to "DESCRIPTION:TRIGGER:-P1W2DT15H",
            "TRIGGER:-P99999999999999999999W1D" to "TRIGGER:-P99999999999999999999W1D"
        )
        for ((original, fixed) in cases) {
            val ics = "BEGIN:VALARM\r\nACTION:DISPLAY\r\n$original\r\nEND:VALARM\r\n"
            assertEquals(ics.replace(original, fixed), ICalPreprocessor.fixWeekDurations(StringReader(ics)).readText())
        }
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