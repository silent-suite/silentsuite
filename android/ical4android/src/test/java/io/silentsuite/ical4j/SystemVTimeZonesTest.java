package io.silentsuite.ical4j;

import net.fortuna.ical4j.data.CalendarBuilder;
import net.fortuna.ical4j.model.Calendar;
import net.fortuna.ical4j.model.DateTime;
import net.fortuna.ical4j.model.Property;
import net.fortuna.ical4j.model.component.Observance;
import net.fortuna.ical4j.model.component.VTimeZone;
import net.fortuna.ical4j.model.property.TzOffsetTo;
import org.junit.Test;

import java.io.StringReader;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class SystemVTimeZonesTest {

    /** Parses generated text again, as another client would, under a custom TZID so that ical4j evaluates the observances themselves. */
    private static VTimeZone reparse(VTimeZone generated) throws Exception {
        final String text = generated.toString().replaceFirst("TZID:[^\r\n]*", "TZID:Generated");
        final Calendar calendar = new CalendarBuilder().build(new StringReader(String.join("\r\n",
                "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:test") + "\r\n" + text + "END:VCALENDAR\r\n"));
        return (VTimeZone) calendar.getComponent(VTimeZone.VTIMEZONE);
    }

    private static int offsetSeconds(VTimeZone vTimeZone, Instant instant) {
        final Observance observance = vTimeZone.getApplicableObservance(new DateTime(instant.toEpochMilli()));
        return ((TzOffsetTo) observance.getProperty(Property.TZOFFSETTO)).getOffset().getTotalSeconds();
    }

    @Test
    public void nonSystemIdsAreNotGenerated() {
        assertNull(SystemVTimeZones.forId("Pacific Time (Custom)", 0L));
        assertNull(SystemVTimeZones.forId("america/vancouver", 0L));
    }

    @Test
    public void vancouverEndsOnPermanentMinusSeven() throws Exception {
        final ZoneId vancouver = ZoneId.of("America/Vancouver");
        if (!vancouver.getRules().getTransitionRules().isEmpty())
            throw new AssertionError("This JDK's tz data predates IANA 2026b; run the tests on a current JDK");
        final String text = SystemVTimeZones.generate(vancouver, Instant.parse("2026-01-15T18:00:00Z")).toString();
        assertTrue(text, text.contains("DTSTART:20251102T020000"));   // in effect on 15 January: -0700 -> -0800
        assertTrue(text, text.contains("DTSTART:20260308T020000"));   // last change: -0800 -> -0700
        assertFalse(text, text.contains("RRULE"));
        final VTimeZone parsed = reparse(SystemVTimeZones.generate(vancouver, Instant.parse("2026-01-15T18:00:00Z")));
        assertEquals(-8 * 3600, offsetSeconds(parsed, Instant.parse("2026-01-15T18:00:00Z")));
        assertEquals(-7 * 3600, offsetSeconds(parsed, Instant.parse("2026-11-05T17:00:00Z")));
        assertEquals(-7 * 3600, offsetSeconds(parsed, Instant.parse("2030-01-15T17:00:00Z")));
    }

    @Test
    public void ongoingRulesBecomeRrules() {
        final String text = SystemVTimeZones.generate(ZoneId.of("Europe/Berlin"), Instant.parse("2026-11-12T12:00:00Z")).toString();
        assertTrue(text, text.contains("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU"));
        assertTrue(text, text.contains("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU"));
    }

    @Test
    public void onsetsInAGapOfTheDefaultZoneAreWrittenUnchanged() {
        final java.util.TimeZone saved = java.util.TimeZone.getDefault();
        try {
            // 02:00 on 8 March 2026 doesn't exist in Los Angeles; a lenient format would write 03:00
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("America/Los_Angeles"));
            final String text = SystemVTimeZones.generate(ZoneId.of("America/Los_Angeles"), Instant.parse("2026-01-15T18:00:00Z")).toString();
            assertTrue(text, text.contains("DTSTART:20260308T020000"));
        } finally {
            java.util.TimeZone.setDefault(saved);
        }
    }

    /**
     * For every platform zone and several starting points, a client that evaluates the generated
     * definition itself gets the platform offset at every sampled instant up to 40 years later.
     */
    @Test
    public void generatedDefinitionsMatchThePlatformRules() throws Exception {
        // Evaluated in UTC: stock ical4j reads an observance's DTSTART as floating time in the
        // default zone, so an onset in a gap of that zone would shift by an hour (not our output).
        final java.util.TimeZone saved = java.util.TimeZone.getDefault();
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"));
        try {
            checkAllZones();
        } finally {
            java.util.TimeZone.setDefault(saved);
        }
    }

    private void checkAllZones() throws Exception {
        final Instant[] starts = {Instant.parse("1995-06-15T12:00:00Z"), Instant.parse("2020-01-10T12:00:00Z"), Instant.parse("2026-11-12T12:00:00Z")};
        final List<String> failures = new ArrayList<>();
        int checked = 0;
        for (String id : new TreeSet<>(ZoneId.getAvailableZoneIds())) {
            final ZoneId zone = ZoneId.of(id);
            for (Instant start : starts) {
                final VTimeZone parsed = reparse(SystemVTimeZones.generate(zone, start));
                for (Instant at = start; at.isBefore(start.plus(Duration.ofDays(365 * 40))); at = at.plus(Duration.ofHours(24 * 9 + 7))) {
                    final int expected = zone.getRules().getOffset(at).getTotalSeconds();
                    final int actual = offsetSeconds(parsed, at);
                    if (expected != actual && failures.size() < 20)
                        failures.add(id + " from " + start + " at " + at + ": " + actual + " (want " + expected + ")");
                    checked++;
                }
            }
        }
        assertTrue("checked " + checked, checked > 500_000);
        assertEquals(String.join("\n", failures), 0, failures.size());
    }
}
