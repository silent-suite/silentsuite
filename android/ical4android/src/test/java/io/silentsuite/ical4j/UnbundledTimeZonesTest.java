package io.silentsuite.ical4j;

import net.fortuna.ical4j.data.CalendarBuilder;
import net.fortuna.ical4j.model.Calendar;
import net.fortuna.ical4j.model.Component;
import net.fortuna.ical4j.model.TimeZone;
import net.fortuna.ical4j.model.TimeZoneRegistry;
import net.fortuna.ical4j.model.TimeZoneRegistryFactory;
import net.fortuna.ical4j.model.component.VEvent;
import net.fortuna.ical4j.util.ResourceLoader;
import org.junit.Test;

import java.io.StringReader;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.TreeSet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Zones that ical4j 3.0.20 doesn't bundle (Europe/Kyiv, America/Ciudad_Juarez, ...) get a
 * VTIMEZONE generated from the platform rules. Upstream's generator threw a DateTimeException for
 * zones with a "last weekday of the month" rule, which stopped calendar sync at such an event.
 */
public class UnbundledTimeZonesTest {

    /** As stored by the web app's .ics import, which drops the VTIMEZONE. */
    static final String KYIV_EVENT = String.join("\r\n",
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//SilentSuite//EN",
            "BEGIN:VEVENT",
            "UID:qa-tmp-sync-20261116-y001",
            "DTSTART;TZID=Europe/Kyiv:20210601T100000",
            "DTEND;TZID=Europe/Kyiv:20210601T110000",
            "SUMMARY:kyiv",
            "CREATED:20261116T113306Z",
            "LAST-MODIFIED:20261116T113306Z",
            "END:VEVENT",
            "END:VCALENDAR", "");

    @Test
    public void kyivEventWithoutVTimeZoneParses() throws Exception {
        final Calendar calendar = new CalendarBuilder().build(new StringReader(KYIV_EVENT));
        final VEvent event = (VEvent) calendar.getComponent(Component.VEVENT);
        assertEquals("Europe/Kyiv", event.getStartDate().getTimeZone().getID());
        assertEquals(Instant.parse("2021-06-01T07:00:00Z").toEpochMilli(), event.getStartDate().getDate().getTime());
        assertEquals(Instant.parse("2021-06-01T08:00:00Z").toEpochMilli(), event.getEndDate().getDate().getTime());
    }

    /**
     * Every zone ID ical4j doesn't bundle loads without throwing; platform zones among them are
     * generated and follow the platform rules.
     */
    @Test
    public void everyUnbundledZoneLoads() {
        final TimeZoneRegistry registry = TimeZoneRegistryFactory.getInstance().createRegistry();
        final TreeSet<String> ids = new TreeSet<>(Arrays.asList(java.util.TimeZone.getAvailableIDs()));
        ids.addAll(ZoneId.getAvailableZoneIds());

        final List<String> failures = new ArrayList<>();
        final List<String> unbundled = new ArrayList<>();
        for (String id : ids) {
            if (ResourceLoader.getResource("zoneinfo/" + id + ".ics") != null)
                continue;
            unbundled.add(id);
            try {
                final TimeZone tz = registry.getTimeZone(id);
                final ZoneId zone = SystemVTimeZones.systemZone(id);
                if (zone != null) {
                    if (tz == null) {
                        failures.add(id + ": not loaded");
                        continue;
                    }
                    if (!id.equals(tz.getID()))
                        continue;   // mapped to another zone by tz.alias
                    for (String at : new String[]{"1995-01-15T12:00:00Z", "2021-06-01T07:00:00Z", "2035-10-28T12:00:00Z"}) {
                        final Instant instant = Instant.parse(at);
                        final int expected = zone.getRules().getOffset(instant).getTotalSeconds() * 1000;
                        if (tz.getOffset(instant.toEpochMilli()) != expected)
                            failures.add(id + " at " + at + ": " + tz.getOffset(instant.toEpochMilli()) + " (want " + expected + ")");
                    }
                }
            } catch (RuntimeException e) {
                failures.add(id + ": " + e);
            }
        }
        assertTrue(unbundled.toString(), unbundled.contains("Europe/Kyiv"));
        assertEquals(String.join("\n", failures), 0, failures.size());
        assertNotNull(registry.getTimeZone("Europe/Kyiv"));
    }
}
