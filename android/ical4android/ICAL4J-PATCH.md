# ical4j 3.0.20 time-zone patch

ical4android uses ical4j 3.0.20 with three of its classes replaced. The build
(`build.gradle`, task `strippedIcal4j`) checks the SHA-256 of the upstream jar
from Maven Central and repackages it without these classes, so the originals
can't reach any classpath:

| Replaced class | Source here | Change |
|---|---|---|
| `net.fortuna.ical4j.model.TimeZone` | `src/main/java/net/fortuna/ical4j/model/TimeZone.java` | For a TZID that is exactly a tz database ID known to the platform, offsets come from the platform's `ZoneRules`. Marker field `SILENTSUITE_PATCH`. |
| `net.fortuna.ical4j.model.DateTime` | `src/main/java/net/fortuna/ical4j/model/DateTime.java` | A local DATE-TIME in such a zone becomes an instant through `java.time` (gaps move forward, overlaps take the earlier offset, as RFC 5545 asks). |
| `net.fortuna.ical4j.model.Iso8601` | `src/main/java/net/fortuna/ical4j/model/Iso8601.java` | Floating times are formatted with the default zone's offset at that instant. |

The files are the upstream 3.0.20 sources (BSD licence headers kept) with
the changes marked `SilentSuite patch`. `io.silentsuite.ical4j.SystemVTimeZones`
holds the shared code and generates the VTIMEZONEs that `Event` and `Task`
write for tz database IDs (`ICalendar.vTimeZoneFor`).

## Why

ical4j 3.0.20 bundles 2020b VTIMEZONEs and derives a single raw offset per
zone from them (and from the default zone, for floating times). Both break
when a zone changes its standard offset. British Columbia moved to permanent
UTC-07 on 1 November 2026 (IANA 2026b):

- with the bundled data, events after that date were off by an hour;
- with current data but upstream arithmetic, every winter before it would be;
- on a device whose own zone changed, the parser's floating round trip moved
  every value in such a period before its TZID was even applied.

No ical4j release ships 2026 data (3.2.19 has 2024a, 4.4.0 has 2025a). With the
patch, ical4j uses the same rules Android uses to display events and expand
recurrences, and Android updates them with its tz data. Network time-zone
updates stay disabled (`ical4j.properties`).

Custom and Windows-style TZIDs keep their own VTIMEZONE definitions. A tz
database ID wins over an embedded VTIMEZONE, as in other clients (the web app,
Thunderbird, Google Calendar).

## Tests

- `src/test/java/io/silentsuite/ical4j`: JVM tests, run with
  `./gradlew ical4android:testDebugUnitTest --tests 'io.silentsuite.ical4j.*'`.
  They need a JDK with IANA 2026b or later and fail otherwise.
- `src/androidTest/java/at/bitfire/ical4android/SystemTimeZoneRuntimeTest.kt`:
  the same conversions on Android's classes and through CalendarProvider.

## Updating ical4j

Moving to another ical4j version means re-checking whether these changes are
still needed, then re-applying them to that version's sources and updating
the version and SHA-256 in `build.gradle`.
