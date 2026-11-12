package io.silentsuite.ical4j;

import net.fortuna.ical4j.model.DateTime;
import net.fortuna.ical4j.model.Recur;
import net.fortuna.ical4j.model.component.Daylight;
import net.fortuna.ical4j.model.component.Observance;
import net.fortuna.ical4j.model.component.Standard;
import net.fortuna.ical4j.model.component.VTimeZone;
import net.fortuna.ical4j.model.property.DtStart;
import net.fortuna.ical4j.model.property.RRule;
import net.fortuna.ical4j.model.property.TzId;
import net.fortuna.ical4j.model.property.TzOffsetFrom;
import net.fortuna.ical4j.model.property.TzOffsetTo;

import java.text.ParseException;
import java.time.DateTimeException;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.Month;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.time.temporal.TemporalAdjusters;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import java.time.zone.ZoneOffsetTransition;
import java.time.zone.ZoneOffsetTransitionRule;
import java.time.zone.ZoneRules;

/**
 * Time zones that are known to the platform's tz database.
 *
 * ical4j 3.0.20 bundles 2020b VTIMEZONE files and computes offsets from them with a single raw
 * offset per zone. Both are wrong for zones whose rules changed (America/Vancouver moved to
 * permanent -07 on 2026-11-01). For an exact tz database ID, the patched ical4j classes and this
 * class use the platform rules instead: on Android that is the device's tz data, which Android
 * also uses to display events and expand recurrences.
 */
public final class SystemVTimeZones {

    private SystemVTimeZones() {
    }

    private static final Set<String> SYSTEM_IDS =
            Collections.unmodifiableSet(new HashSet<>(ZoneId.getAvailableZoneIds()));

    private static final Pattern WALL_PATTERN = Pattern.compile("\\d{8}T\\d{6}");

    private static final DateTimeFormatter WALL_FORMAT =
            DateTimeFormatter.ofPattern("uuuuMMdd'T'HHmmss", Locale.ROOT)
                    .withResolverStyle(ResolverStyle.STRICT);

    /** Years of explicit onsets written when a yearly rule can't be expressed as an RRULE. */
    static final int RDATE_FALLBACK_YEARS = 50;

    /** Years checked when deciding whether a yearly rule can be expressed as an RRULE. */
    private static final int RRULE_CHECK_YEARS = 60;

    /**
     * @param id a TZID value
     * @return the platform zone when {@code id} is exactly a tz database ID known to the
     * platform, otherwise null (custom and Windows-style IDs keep their VTIMEZONE definitions)
     */
    public static ZoneId systemZone(final String id) {
        if (id == null || !SYSTEM_IDS.contains(id)) {
            return null;
        }
        try {
            return ZoneId.of(id);
        } catch (DateTimeException e) {
            return null;
        }
    }

    /**
     * Converts an iCalendar local DATE-TIME value ({@code yyyyMMdd'T'HHmmss}) in a platform zone to
     * epoch milliseconds. A wall time in a gap moves forward by the gap's length and an ambiguous
     * wall time takes the earlier offset (RFC 5545 3.3.5).
     *
     * @return the instant, or null if {@code value} is not such a value (the caller then falls back
     * to ical4j's own parsing)
     */
    public static Long wallToEpochMilli(final String value, final ZoneId zone) {
        if (value == null || !WALL_PATTERN.matcher(value).matches()) {
            return null;
        }
        try {
            return LocalDateTime.parse(value, WALL_FORMAT).atZone(zone).toInstant().toEpochMilli();
        } catch (DateTimeException e) {
            return null;
        }
    }

    /**
     * Generates a VTIMEZONE for a TZID from the platform rules, or null if the TZID isn't a
     * platform zone.
     *
     * @param id            TZID
     * @param earliestMillis the earliest instant the definition has to cover (for instance the
     *                       earliest DTSTART of an event), or null for now
     */
    public static VTimeZone forId(final String id, final Long earliestMillis) {
        final ZoneId zone = systemZone(id);
        if (zone == null) {
            return null;
        }
        final Instant earliest = earliestMillis != null ? Instant.ofEpochMilli(earliestMillis) : Instant.now();
        return generate(zone, earliest);
    }

    /**
     * Generates a VTIMEZONE from the platform rules of {@code zone} that is correct from
     * {@code earliest} on: the observance in effect then, every later historic transition, and
     * the zone's ongoing yearly rules (as RRULEs, or as explicit onsets for rules RRULE can't
     * express).
     *
     * Observances are typed by the rules' own daylight-saving flag. A zone that moved to
     * permanent daylight-style time (Vancouver) therefore ends on a DAYLIGHT observance, which
     * older ical4j versions also evaluate correctly.
     */
    public static VTimeZone generate(final ZoneId zone, final Instant earliest) {
        final ZoneRules rules = zone.getRules();
        final List<Observance> observances = new ArrayList<>();

        // the observance in effect at `earliest`
        final ZoneOffsetTransition previous = rules.previousTransition(earliest.plusSeconds(1));
        if (previous != null) {
            observances.add(observance(rules, previous));
        } else {
            final ZoneOffset offset = rules.getOffset(earliest);
            LocalDateTime start = LocalDateTime.of(1970, 1, 1, 0, 0);
            final LocalDateTime local = LocalDateTime.ofInstant(earliest, offset).toLocalDate().atStartOfDay().minusDays(1);
            if (local.isBefore(start)) {
                start = local;
            }
            observances.add(observance(rules.isDaylightSavings(earliest), offset, offset, start, null));
        }

        // later historic transitions
        Instant lastHistoric = null;
        for (ZoneOffsetTransition transition : rules.getTransitions()) {
            lastHistoric = transition.getInstant();
            if (transition.getInstant().isAfter(earliest)) {
                observances.add(observance(rules, transition));
            }
        }

        // ongoing yearly rules
        final Instant rulesFrom = lastHistoric != null && lastHistoric.isAfter(earliest) ? lastHistoric : earliest;
        for (ZoneOffsetTransitionRule rule : rules.getTransitionRules()) {
            int year = LocalDateTime.ofInstant(rulesFrom, ZoneOffset.UTC).getYear() - 1;
            while (!rule.createTransition(year).getInstant().isAfter(rulesFrom)) {
                year++;
            }
            final boolean daylight = !rule.getOffsetAfter().equals(rule.getStandardOffset());
            final String recur = recurFor(rule, year);
            if (recur != null) {
                observances.add(observance(daylight, rule.getOffsetBefore(), rule.getOffsetAfter(),
                        rule.createTransition(year).getDateTimeBefore(), recur));
            } else {
                for (int y = year; y < year + RDATE_FALLBACK_YEARS; y++) {
                    observances.add(observance(daylight, rule.getOffsetBefore(), rule.getOffsetAfter(),
                            rule.createTransition(y).getDateTimeBefore(), null));
                }
            }
        }

        final VTimeZone vTimeZone = new VTimeZone();
        vTimeZone.getProperties().add(new TzId(zone.getId()));
        for (Observance observance : observances) {
            vTimeZone.getObservances().add(observance);
        }
        return vTimeZone;
    }

    private static Observance observance(final ZoneRules rules, final ZoneOffsetTransition transition) {
        return observance(rules.isDaylightSavings(transition.getInstant()), transition.getOffsetBefore(),
                transition.getOffsetAfter(), transition.getDateTimeBefore(), null);
    }

    /**
     * One observance with its onset as DTSTART and an optional RRULE.
     *
     * The DTSTART value is written as fixed text. ical4j would otherwise format this floating
     * local time through the device's default zone, and a transition's local onset often lies in
     * a gap of that very zone (02:00 on the spring-forward day), which the lenient default format
     * moves by an hour. (RDATE can't be written this way, so explicit onsets get an observance each.)
     */
    private static Observance observance(final boolean daylight, final ZoneOffset from, final ZoneOffset to,
                                         final LocalDateTime start, final String rrule) {
        final Observance observance = daylight ? new Daylight() : new Standard();
        final String startText = WALL_FORMAT.format(start);
        observance.getProperties().add(new DtStart(new DateTime(start.toInstant(ZoneOffset.UTC).toEpochMilli())) {
            @Override
            public String getValue() {
                return startText;
            }
        });
        observance.getProperties().add(new TzOffsetFrom(from));
        observance.getProperties().add(new TzOffsetTo(to));
        if (rrule != null) {
            try {
                observance.getProperties().add(new RRule(new Recur(rrule)));
            } catch (ParseException e) {
                throw new IllegalStateException("Generated RRULE is invalid: " + rrule, e);
            }
        }
        return observance;
    }

    /**
     * Expresses a yearly transition rule as an RRULE, or returns null when the rule's local onset
     * doesn't follow a pattern RRULE can express (for instance when the time definition moves the
     * local onset across midnight).
     */
    static String recurFor(final ZoneOffsetTransitionRule rule, final int firstYear) {
        final int month = rule.getMonth().getValue();
        final int dom = rule.getDayOfMonthIndicator();
        final DayOfWeek dow = rule.getDayOfWeek();
        final String byDay;
        if (dow == null) {
            byDay = "BYMONTHDAY=" + dom;
        } else if (dom > 0 && dom <= 22 && (dom - 1) % 7 == 0) {
            byDay = "BYDAY=" + ((dom - 1) / 7 + 1) + abbreviation(dow);
        } else if (dom == -1) {
            byDay = "BYDAY=-1" + abbreviation(dow);
        } else if (dom > 0 && dom + 6 <= 28) {
            byDay = "BYDAY=" + abbreviation(dow) + ";BYMONTHDAY=" + range(dom, dom + 6);
        } else if (dom > 0 && month != 2 && dom + 6 <= Month.of(month).length(false)) {
            // the week ending on day `dom + 6`, counted from the month's end ("Sun>=25" in March is the last Sunday)
            final int fromEnd = dom - Month.of(month).length(false) - 1;
            byDay = fromEnd + 6 == -1 ? "BYDAY=-1" + abbreviation(dow)
                    : "BYDAY=" + abbreviation(dow) + ";BYMONTHDAY=" + range(fromEnd, fromEnd + 6);
        } else if (dom < 0 && dom - 6 >= -28) {
            byDay = "BYDAY=" + abbreviation(dow) + ";BYMONTHDAY=" + range(dom - 6, dom);
        } else {
            return null;
        }

        // the pattern above must give the actual local onset in every year
        final LocalTime time = rule.createTransition(firstYear).getDateTimeBefore().toLocalTime();
        for (int year = firstYear; year < firstYear + RRULE_CHECK_YEARS; year++) {
            final LocalDateTime onset = rule.createTransition(year).getDateTimeBefore();
            if (!onset.toLocalTime().equals(time) || !onset.toLocalDate().equals(patternDate(year, month, dom, dow))) {
                return null;
            }
        }
        return "FREQ=YEARLY;BYMONTH=" + month + ";" + byDay;
    }

    private static LocalDate patternDate(final int year, final int month, final int dom, final DayOfWeek dow) {
        final LocalDate monthStart = LocalDate.of(year, month, 1);
        if (dow == null) {
            return dom > 0 ? monthStart.withDayOfMonth(dom)
                    : monthStart.with(TemporalAdjusters.lastDayOfMonth()).plusDays(dom + 1);
        }
        if (dom > 0) {
            return monthStart.withDayOfMonth(dom).with(TemporalAdjusters.nextOrSame(dow));
        }
        return monthStart.with(TemporalAdjusters.lastDayOfMonth()).plusDays(dom + 1)
                .with(TemporalAdjusters.previousOrSame(dow));
    }

    private static String range(final int from, final int to) {
        final StringBuilder b = new StringBuilder();
        for (int day = from; day <= to; day++) {
            if (b.length() > 0) {
                b.append(',');
            }
            b.append(day);
        }
        return b.toString();
    }

    private static String abbreviation(final DayOfWeek dow) {
        return dow.name().substring(0, 2);
    }

}
