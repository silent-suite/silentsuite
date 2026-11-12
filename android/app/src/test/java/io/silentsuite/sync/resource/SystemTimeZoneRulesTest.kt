package io.silentsuite.sync.resource

import at.bitfire.ical4android.DateUtils
import at.bitfire.ical4android.Event
import at.bitfire.ical4android.SystemTimeZoneRegistryFactory
import at.bitfire.ical4android.util.ZoneRulesVTimeZone
import net.fortuna.ical4j.model.DateTime
import net.fortuna.ical4j.model.TimeZoneRegistryFactory
import net.fortuna.ical4j.model.component.Observance
import net.fortuna.ical4j.model.property.DtStart
import net.fortuna.ical4j.model.property.TzOffsetTo
import net.fortuna.ical4j.util.TimeZones
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.StringReader
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * Events are converted between provider instants and iCalendar wall-clock times with the platform's
 * time zone rules, not with the Olson 2020b snapshot bundled in ical4j 3.0.20 (internal #887:
 * British Columbia stopped changing clocks in 2026; Mexico abolished DST in 2022).
 */
class SystemTimeZoneRulesTest {

    private val registry = TimeZoneRegistryFactory.getInstance().createRegistry()

    @Test
    fun registryFactoryIsTheSystemOne() {
        assertTrue(TimeZoneRegistryFactory.getInstance() is SystemTimeZoneRegistryFactory)
    }

    @Test
    fun everyPlatformZoneMatchesPlatformRules() {
        val from = Instant.parse("1950-01-01T00:00:00Z")
        val until = Instant.parse("2045-01-01T00:00:00Z")
        val failures = mutableListOf<String>()
        for (id in ZoneId.getAvailableZoneIds().sorted()) {
            val rules = ZoneId.of(id).rules
            val vTimeZone = ZoneRulesVTimeZone.build(id)
            val instants = sortedSetOf<Instant>()
            var t = from
            while (t < until) {
                instants += t
                t = t.plusSeconds(29L * 86400 + 7 * 3600)
            }
            for (transition in rules.transitions)
                if (transition.instant > from)
                    instants += listOf(transition.instant.minusSeconds(1), transition.instant, transition.instant.plusSeconds(1))
            for (rule in rules.transitionRules)
                for (year in 2020..2044) {
                    val instant = rule.createTransition(year).instant
                    instants += listOf(instant.minusSeconds(1), instant, instant.plusSeconds(1))
                }
            for (instant in instants) {
                val observance: Observance = vTimeZone.getApplicableObservance(DateTime(instant.toEpochMilli()))
                val offset = observance.getProperty<TzOffsetTo>("TZOFFSETTO").offset.totalSeconds
                val expected = rules.getOffset(instant).totalSeconds
                if (offset != expected) {
                    failures += "$id at $instant: $offset instead of $expected"
                    break
                }
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun mexicoCity_noDstSince2022() {
        // Mexico City has kept -06:00 all year since tzdata 2022f; ical4j's 2020b data still has summer time.
        val instant = Instant.parse("2026-07-15T16:00:00Z")
        assumeTrue(ZoneId.of("America/Mexico_City").rules.getOffset(instant) == ZoneOffset.ofHours(-6))

        assertEquals("DTSTART;TZID=America/Mexico_City:20260715T100000", upload(instant, "America/Mexico_City"))
        assertEquals(instant, download("America/Mexico_City", "20260715T100000"))
    }

    @Test
    fun vancouver_permanentMinus7From2026() {
        // tzdata 2026b: British Columbia doesn't fall back on 2026-11-01.
        val instant = Instant.parse("2026-11-20T17:00:00Z")
        val platformOffset = ZoneId.of("America/Vancouver").rules.getOffset(instant)
        println("Platform offset for America/Vancouver at $instant: $platformOffset")
        assumeTrue(platformOffset == ZoneOffset.ofHours(-7))

        assertEquals("DTSTART;TZID=America/Vancouver:20261120T100000", upload(instant, "America/Vancouver"))
        assertEquals(instant, download("America/Vancouver", "20261120T100000"))
    }

    @Test
    fun uploadedVTimeZoneCarriesPlatformRules() {
        val instant = Instant.parse("2026-07-15T16:00:00Z")
        assumeTrue(ZoneId.of("America/Mexico_City").rules.getOffset(instant) == ZoneOffset.ofHours(-6))

        val event = Event()
        event.uid = "tz-upload"
        event.dtStart = DtStart(DateTime(instant.toEpochMilli()).apply {
            timeZone = DateUtils.ical4jTimeZone("America/Mexico_City")
        })
        val raw = ByteArrayOutputStream().also { event.write(it) }.toString(Charsets.UTF_8.name())

        assertTrue(raw, raw.contains("DTSTART;TZID=America/Mexico_City:20260715T100000"))
        // Minified to the observances that apply from DTSTART on: no summer time any more.
        val vTimeZone = raw.substringAfter("BEGIN:VTIMEZONE").substringBefore("END:VTIMEZONE")
        assertTrue(vTimeZone, vTimeZone.contains("TZOFFSETTO:-0600"))
        assertTrue(vTimeZone, !vTimeZone.contains("TZOFFSETTO:-0500"))

        // Another client reading it back gets the same instant.
        val parsed = Event.eventsFromReader(StringReader(raw)).single()
        assertEquals(instant.toEpochMilli(), parsed.dtStart!!.date.time)
    }

    @Test
    fun knownTzidUsesPlatformRulesOverEmbeddedVTimeZone() {
        // ICalPreprocessor (ical4j's DatePropertyRule/TzHelper) re-resolves every known TZID through the
        // registry and so ignores the item's own VTIMEZONE. That was already the case with ical4j's data;
        // the registry now answers with the platform rules.
        val instant = Instant.parse("2026-07-15T16:00:00Z")
        assumeTrue(ZoneId.of("America/Mexico_City").rules.getOffset(instant) == ZoneOffset.ofHours(-6))
        val ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\n" +
                "BEGIN:VTIMEZONE\r\nTZID:America/Mexico_City\r\n" +
                "BEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\n" +
                "END:VTIMEZONE\r\n" +
                "BEGIN:VEVENT\r\nUID:embedded\r\nDTSTAMP:20261101T000000Z\r\n" +
                "DTSTART;TZID=America/Mexico_City:20260715T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        val event = Event.eventsFromReader(StringReader(ics)).single()
        assertEquals(instant.toEpochMilli(), event.dtStart!!.date.time)
    }

    @Test
    fun idsThePlatformDoesNotKnowStillResolve() {
        // Bundled ical4j data and its aliases remain the fallback.
        assertNotNull(registry.getTimeZone("EST"))
        assertNotNull(registry.getTimeZone("AET"))
    }

    @Test
    fun utcAndFixedOffsets() {
        // Same IDs as ical4j's own data, so UTC is still recognized as UTC.
        assertEquals("Etc/UTC", registry.getTimeZone("UTC").id)
        assertTrue(TimeZones.isUtc(registry.getTimeZone("UTC")))
        assertTrue(TimeZones.isUtc(registry.getTimeZone("Etc/UTC")))
        assertEquals("Etc/GMT", registry.getTimeZone("GMT").id)

        val gmtPlus7 = ZoneRulesVTimeZone.build("Etc/GMT+7")
        assertEquals(1, gmtPlus7.observances.size)
        assertEquals("-0700", gmtPlus7.observances[0].getProperty<TzOffsetTo>("TZOFFSETTO").value)
    }


    /** Same conversion as [at.bitfire.ical4android.AndroidEvent] uses for a provider row. */
    private fun upload(instant: Instant, tzId: String): String =
        DtStart(DateTime(instant.toEpochMilli()).apply {
            timeZone = DateUtils.ical4jTimeZone(tzId)
        }).toString().trim()

    /** Parses an item without VTIMEZONE (what the web app writes). */
    private fun download(tzId: String, local: String): Instant {
        val ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\n" +
                "BEGIN:VEVENT\r\nUID:download\r\nDTSTAMP:20261101T000000Z\r\n" +
                "DTSTART;TZID=$tzId:$local\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        return Instant.ofEpochMilli(Event.eventsFromReader(StringReader(ics)).single().dtStart!!.date.time)
    }

}
