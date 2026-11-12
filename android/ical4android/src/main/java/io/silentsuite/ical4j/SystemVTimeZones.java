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
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.time.zone.ZoneOffsetTransition;
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

    /** Years of explicit onsets written when a zone's transitions don't follow yearly RRULEs. */
    static final int EXPLICIT_YEARS = 50;

    /** Years of transitions an RRULE has to reproduce before it's used. */
    static final int RRULE_CHECK_YEARS = 60;

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
     * {@code earliest} on: the observance in effect then, every later transition up to two years
     * from now, and after that the zone's yearly transitions as RRULEs (or, when they don't repeat
     * yearly, explicit onsets for {@value #EXPLICIT_YEARS} more years).
     *
     * Only {@link ZoneRules#nextTransition} and {@link ZoneRules#previousTransition} are used: on
     * Android, {@code getTransitions()} and {@code getTransitionRules()} don't always list
     * transitions those methods (and the offsets) do follow.
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

        // later transitions until the start of the year after next
        final Instant now = Instant.now();
        final int patternYear = year(earliest.isAfter(now) ? earliest : now) + 2;
        final Instant patternStart = startOfYear(patternYear);
        ZoneOffsetTransition transition = rules.nextTransition(earliest);
        while (transition != null && transition.getInstant().isBefore(patternStart)) {
            observances.add(observance(rules, transition));
            transition = rules.nextTransition(transition.getInstant());
        }

        // transitions from then on, as yearly RRULEs if they follow one
        if (transition != null) {
            final Instant checkEnd = startOfYear(patternYear + RRULE_CHECK_YEARS);
            final List<ZoneOffsetTransition> future = new ArrayList<>();
            while (transition != null && transition.getInstant().isBefore(checkEnd)) {
                future.add(transition);
                transition = rules.nextTransition(transition.getInstant());
            }
            final List<Observance> yearly = yearlyObservances(rules, future, patternYear);
            if (yearly != null) {
                observances.addAll(yearly);
            } else {
                final Instant explicitEnd = startOfYear(patternYear + EXPLICIT_YEARS);
                for (ZoneOffsetTransition f : future) {
                    if (f.getInstant().isBefore(explicitEnd)) {
                        observances.add(observance(rules, f));
                    }
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

    private static int year(final Instant instant) {
        return LocalDateTime.ofInstant(instant, ZoneOffset.UTC).getYear();
    }

    private static Instant startOfYear(final int year) {
        return LocalDateTime.of(year, 1, 1, 0, 0).toInstant(ZoneOffset.UTC);
    }

    /**
     * One observance with an RRULE per kind of transition (daylight flag and offsets), if every
     * kind occurs exactly once a year from {@code firstYear} on, at the same local time, and on
     * dates an RRULE can express; otherwise null.
     */
    static List<Observance> yearlyObservances(final ZoneRules rules, final List<ZoneOffsetTransition> transitions,
                                              final int firstYear) {
        final Map<String, List<ZoneOffsetTransition>> kinds = new LinkedHashMap<>();
        for (ZoneOffsetTransition transition : transitions) {
            final String kind = rules.isDaylightSavings(transition.getInstant()) + " " +
                    transition.getOffsetBefore() + " " + transition.getOffsetAfter();
            List<ZoneOffsetTransition> list = kinds.get(kind);
            if (list == null) {
                list = new ArrayList<>();
                kinds.put(kind, list);
            }
            list.add(transition);
        }

        final List<Observance> observances = new ArrayList<>();
        for (List<ZoneOffsetTransition> kind : kinds.values()) {
            if (kind.size() != RRULE_CHECK_YEARS) {
                return null;
            }
            final ZoneOffsetTransition first = kind.get(0);
            final List<LocalDate> dates = new ArrayList<>();
            for (int i = 0; i < kind.size(); i++) {
                final LocalDateTime onset = kind.get(i).getDateTimeBefore();
                if (onset.getYear() != firstYear + i || onset.getMonth() != first.getDateTimeBefore().getMonth() ||
                        !onset.toLocalTime().equals(first.getDateTimeBefore().toLocalTime())) {
                    return null;
                }
                dates.add(onset.toLocalDate());
            }
            final String byDay = byDayFor(dates);
            if (byDay == null) {
                return null;
            }
            observances.add(observance(rules.isDaylightSavings(first.getInstant()), first.getOffsetBefore(),
                    first.getOffsetAfter(), first.getDateTimeBefore(),
                    "FREQ=YEARLY;BYMONTH=" + first.getDateTimeBefore().getMonthValue() + ";" + byDay));
        }
        return observances;
    }

    /**
     * The BYDAY/BYMONTHDAY part of a yearly RRULE that yields exactly {@code dates} (one per year,
     * all in the same month), or null if there's none.
     */
    static String byDayFor(final List<LocalDate> dates) {
        boolean sameDay = true;
        boolean sameWeekday = true;
        int minDay = Integer.MAX_VALUE, maxDay = Integer.MIN_VALUE;
        int minFromEnd = Integer.MAX_VALUE, maxFromEnd = Integer.MIN_VALUE;
        final LocalDate first = dates.get(0);
        for (LocalDate date : dates) {
            sameDay &= date.getDayOfMonth() == first.getDayOfMonth();
            sameWeekday &= date.getDayOfWeek() == first.getDayOfWeek();
            minDay = Math.min(minDay, date.getDayOfMonth());
            maxDay = Math.max(maxDay, date.getDayOfMonth());
            final int fromEnd = date.getDayOfMonth() - date.lengthOfMonth() - 1;   // -1 is the last day
            minFromEnd = Math.min(minFromEnd, fromEnd);
            maxFromEnd = Math.max(maxFromEnd, fromEnd);
        }
        if (sameDay) {
            return "BYMONTHDAY=" + first.getDayOfMonth();
        }
        if (!sameWeekday) {
            return null;
        }
        // every date lies in one window of seven days, so it is that window's only such weekday
        final String weekday = abbreviation(first.getDayOfWeek());
        if (maxDay - minDay <= 6) {
            final int from = maxDay - 6;
            if (from >= 1 && (from - 1) % 7 == 0 && from <= 22) {
                return "BYDAY=" + ((from - 1) / 7 + 1) + weekday;
            }
            if (from >= 1 && from + 6 <= 28) {
                return "BYDAY=" + weekday + ";BYMONTHDAY=" + range(from, from + 6);
            }
        }
        if (maxFromEnd - minFromEnd <= 6) {
            final int from = maxFromEnd - 6;
            if (from == -7) {
                return "BYDAY=-1" + weekday;
            }
            if (from >= -28) {
                return "BYDAY=" + weekday + ";BYMONTHDAY=" + range(from, from + 6);
            }
        }
        return null;
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
