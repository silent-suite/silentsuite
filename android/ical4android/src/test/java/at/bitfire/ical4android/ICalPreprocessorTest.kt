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
            "TRIGGER;X-NOTE=\"a:b\";RELATED=START:-P1W2DT15H" to "TRIGGER;X-NOTE=\"a:b\";RELATED=START:-P9DT15H",
            "DURATION:P1W1DT12H" to "DURATION:P8DT12H",
            // upper case, so that whole days stay a Period in ical4j
            "trigger:-p1w2dt15h" to "trigger:-P9DT15H",
            "DURATION:p1w2d" to "DURATION:P9D",
            // valid or other values stay as they are
            "TRIGGER:-P2W" to "TRIGGER:-P2W",
            "TRIGGER:-P5D" to "TRIGGER:-P5D",
            "TRIGGER:-PT15H" to "TRIGGER:-PT15H",
            "TRIGGER;VALUE=DATE-TIME:20261210T090000Z" to "TRIGGER;VALUE=DATE-TIME:20261210T090000Z",
            "DESCRIPTION:TRIGGER:-P1W2DT15H" to "DESCRIPTION:TRIGGER:-P1W2DT15H",
            "DESCRIPTION:demo\u2028TRIGGER:-P1W2DT15H" to "DESCRIPTION:demo\u2028TRIGGER:-P1W2DT15H",
            "TRIGGER:-P99999999999999999999W1D" to "TRIGGER:-P99999999999999999999W1D"
        )
        for ((original, fixed) in cases)
            for (eol in listOf("\r\n", "\n")) {
                val ics = "BEGIN:VALARM${eol}ACTION:DISPLAY$eol$original${eol}END:VALARM$eol"
                assertEquals(ics.replace(original, fixed), ICalPreprocessor.fixWeekDurations(StringReader(ics)).readText())
            }

        // folded lines are unfolded (as ical4j does anyway) and then fixed
        assertEquals(
            "BEGIN:VALARM\r\nDESCRIPTION:long text\r\nTRIGGER:-P9DT15H\r\nEND:VALARM\r\n",
            ICalPreprocessor.fixWeekDurations(StringReader(
                "BEGIN:VALARM\r\nDESCRIPTION:long\r\n  text\r\nTRIGGER:-P1W\r\n 2D\r\n\tT15H\r\nEND:VALARM\r\n"
            )).readText()
        )
        // without anything to fix, the folding is kept
        val folded = "BEGIN:VALARM\r\nDESCRIPTION:long\r\n  text\r\nTRIGGER:-P2W\r\nEND:VALARM\r\n"
        assertEquals(folded, ICalPreprocessor.fixWeekDurations(StringReader(folded)).readText())
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