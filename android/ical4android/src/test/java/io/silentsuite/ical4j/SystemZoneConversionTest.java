package io.silentsuite.ical4j;

import net.fortuna.ical4j.data.CalendarBuilder;
import net.fortuna.ical4j.model.Calendar;
import net.fortuna.ical4j.model.DateTime;
import net.fortuna.ical4j.model.TimeZone;
import net.fortuna.ical4j.model.TimeZoneRegistry;
import net.fortuna.ical4j.model.TimeZoneRegistryFactory;
import net.fortuna.ical4j.model.component.VEvent;
import org.junit.Test;

import java.io.StringReader;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class SystemZoneConversionTest {

    private static final DateTimeFormatter WALL = DateTimeFormatter.ofPattern("uuuuMMdd'T'HHmmss");

    private final TimeZoneRegistry registry = TimeZoneRegistryFactory.getInstance().createRegistry();

    /** The bundled 2020b Vancouver rule, which still falls back to -08 every November. */
    private static final String STALE_VANCOUVER = String.join("\r\n",
            "BEGIN:VTIMEZONE", "TZID:America/Vancouver",
            "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0800", "TZOFFSETTO:-0700", "TZNAME:PDT",
            "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
            "BEGIN:STANDARD", "TZOFFSETFROM:-0700", "TZOFFSETTO:-0800", "TZNAME:PST",
            "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
            "END:VTIMEZONE");

    private static void requireCurrentVancouverRules() {
        // Fails instead of skipping: this lane must prove the 2026 change itself.
        if (!ZoneOffset.ofHours(-7).equals(ZoneId.of("America/Vancouver").getRules().getOffset(Instant.parse("2026-11-05T17:00:00Z"))))
            fail("This JDK's tz data predates IANA 2026b (British Columbia permanent UTC-07); run the tests on a current JDK");
    }

    private static Instant parseStart(String vtimezone, String tzid, String wall) throws Exception {
        final String ics = String.join("\r\n", "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:test",
                vtimezone,
                "BEGIN:VEVENT", "UID:1", "DTSTAMP:20260101T000000Z", "DTSTART;TZID=" + tzid + ":" + wall,
                "END:VEVENT", "END:VCALENDAR", "").replace("\r\n\r\n", "\r\n");
        final Calendar calendar = new CalendarBuilder().build(new StringReader(ics));
        final VEvent event = (VEvent) calendar.getComponent(VEvent.VEVENT);
        return Instant.ofEpochMilli(event.getStartDate().getDate().getTime());
    }

    @Test
    public void patchedClassesAreLoaded() throws Exception {
        assertEquals("system-zone-rules-1", TimeZone.class.getField("SILENTSUITE_PATCH").get(null));
    }

    @Test
    public void vancouverBeforeAndAfterThe2026Change() throws Exception {
        requireCurrentVancouverRules();
        final String[][] cases = {
                {"20250115T100000", "2025-01-15T18:00:00Z"},
                {"20260115T100000", "2026-01-15T18:00:00Z"},
                {"20260715T100000", "2026-07-15T17:00:00Z"},
                {"20261105T100000", "2026-11-05T17:00:00Z"},
                {"20270115T100000", "2027-01-15T17:00:00Z"},
                {"20270715T100000", "2027-07-15T17:00:00Z"},
        };
        final TimeZone tz = registry.getTimeZone("America/Vancouver");
        for (String[] c : cases) {
            assertEquals(c[0], Instant.parse(c[1]), parseStart("", "America/Vancouver", c[0]));
            final DateTime back = new DateTime(Instant.parse(c[1]).toEpochMilli());
            back.setTimeZone(tz);
            assertEquals(c[1], c[0], back.toString());
        }
    }

    @Test
    public void systemRulesWinOverAnEmbeddedStaleDefinition() throws Exception {
        requireCurrentVancouverRules();
        assertEquals(Instant.parse("2026-11-05T17:00:00Z"), parseStart(STALE_VANCOUVER, "America/Vancouver", "20261105T100000"));
        assertEquals(Instant.parse("2026-01-15T18:00:00Z"), parseStart(STALE_VANCOUVER, "America/Vancouver", "20260115T100000"));
    }

    @Test
    public void customTzidKeepsItsDefinition() throws Exception {
        final String custom = STALE_VANCOUVER.replace("TZID:America/Vancouver", "TZID:Pacific Time (Custom)");
        assertNull(SystemVTimeZones.systemZone("Pacific Time (Custom)"));
        // the custom definition's November fallback still applies
        assertEquals(Instant.parse("2026-11-05T18:00:00Z"), parseStart(custom, "Pacific Time (Custom)", "20261105T100000"));
        assertEquals(Instant.parse("2026-07-15T17:00:00Z"), parseStart(custom, "Pacific Time (Custom)", "20260715T100000"));
    }

    @Test
    public void gapsMoveForwardAndOverlapsTakeTheEarlierOffset() throws Exception {
        final TimeZone tz = registry.getTimeZone("America/Los_Angeles");
        // 2025-03-09 02:30 doesn't exist: it's read with the offset before the gap (-08), i.e. 03:30 -07
        assertEquals(Instant.parse("2025-03-09T10:30:00Z"), Instant.ofEpochMilli(new DateTime("20250309T023000", tz).getTime()));
        // 2025-11-02 01:30 happens twice: the first one (-07) is used
        assertEquals(Instant.parse("2025-11-02T08:30:00Z"), Instant.ofEpochMilli(new DateTime("20251102T013000", tz).getTime()));
    }

    @Test
    public void utcAndFloatingValuesAreUnchanged() throws Exception {
        assertEquals(Instant.parse("2026-11-05T10:00:00Z"), Instant.ofEpochMilli(new DateTime("20261105T100000Z").getTime()));
        final java.util.TimeZone saved = java.util.TimeZone.getDefault();
        try {
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"));
            assertEquals(Instant.parse("2026-11-05T10:00:00Z"), Instant.ofEpochMilli(new DateTime("20261105T100000", (TimeZone) null).getTime()));
        } finally {
            java.util.TimeZone.setDefault(saved);
        }
    }

    /**
     * The parser first reads every DATE-TIME as floating time in the device's zone and formats it
     * back before applying its TZID. That round trip has to be exact whatever the device's zone,
     * including Vancouver itself, whose standard offset changed.
     */
    @Test
    public void parsingDoesNotDependOnTheDefaultZone() throws Exception {
        requireCurrentVancouverRules();
        final java.util.TimeZone saved = java.util.TimeZone.getDefault();
        try {
            for (String deviceZone : new String[]{"America/Vancouver", "Europe/Berlin", "Asia/Kolkata", "UTC"}) {
                java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone(deviceZone));
                assertEquals(deviceZone, Instant.parse("2025-01-15T18:00:00Z"), parseStart("", "America/Vancouver", "20250115T100000"));
                assertEquals(deviceZone, Instant.parse("2026-11-05T17:00:00Z"), parseStart("", "America/Vancouver", "20261105T100000"));
                assertEquals(deviceZone, Instant.parse("2025-01-15T09:00:00Z"), parseStart("", "Europe/Berlin", "20250115T100000"));

                final ZoneId zone = ZoneId.of(deviceZone);
                for (LocalDateTime wall = LocalDateTime.of(2000, 1, 3, 10, 0); wall.getYear() < 2036; wall = wall.plusHours(241)) {
                    if (zone.getRules().getValidOffsets(wall).size() != 1)
                        continue;   // gaps and overlaps keep ical4j's lenient floating behaviour
                    final DateTime floating = new DateTime(WALL.format(wall));
                    assertEquals(deviceZone + " " + wall, wall.atZone(zone).toInstant(), Instant.ofEpochMilli(floating.getTime()));
                    assertEquals(deviceZone + " " + wall, WALL.format(wall), floating.toString());
                }
            }
        } finally {
            java.util.TimeZone.setDefault(saved);
        }
    }

    /**
     * Every platform zone: parsing and formatting agree with java.time at sampled wall times and
     * instants. The stock classes get past offsets wrong in every zone whose standard offset
     * changed (and Vancouver's every past winter once the platform has 2026 rules).
     */
    @Test
    public void everySystemZoneMatchesThePlatformRules() throws Exception {
        final List<String> failures = new ArrayList<>();
        int checked = 0;
        for (String id : new TreeSet<>(ZoneId.getAvailableZoneIds())) {
            final TimeZone tz = registry.getTimeZone(id);
            if (tz == null)
                continue;
            // tz.alias may map an ID to another zone; the registry returns that zone
            assertNotNull(id, SystemVTimeZones.systemZone(tz.getID()));
            final ZoneId zone = ZoneId.of(tz.getID());
            for (LocalDateTime wall = LocalDateTime.of(2000, 1, 3, 10, 0); wall.getYear() < 2036; wall = wall.plusHours(241)) {
                final Instant expected = wall.atZone(zone).toInstant();
                final Instant parsed = Instant.ofEpochMilli(new DateTime(WALL.format(wall), tz).getTime());
                final DateTime formatted = new DateTime(expected.toEpochMilli());
                formatted.setTimeZone(tz);
                final String expectedWall = WALL.format(LocalDateTime.ofInstant(expected, zone));
                if (!expected.equals(parsed) || !expectedWall.equals(formatted.toString())) {
                    if (failures.size() < 20)
                        failures.add(id + " " + wall + ": parsed " + parsed + " (want " + expected + "), formatted " + formatted + " (want " + expectedWall + ")");
                    else
                        break;
                }
                checked++;
            }
        }
        assertTrue("checked " + checked, checked > 100_000);
        assertEquals(String.join("\n", failures), 0, failures.size());
    }
}
