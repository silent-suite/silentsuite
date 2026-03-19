package at.bitfire.ical4android

import net.fortuna.ical4j.data.CalendarBuilder
import net.fortuna.ical4j.model.Component
import net.fortuna.ical4j.model.component.VEvent
import org.apache.commons.io.IOUtils
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
            assertEquals(valid, IOUtils.toString(result))
        }
        ICalPreprocessor.fixInvalidUtcOffset(StringReader(valid)).let { result ->
            assertEquals(valid, IOUtils.toString(result))
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