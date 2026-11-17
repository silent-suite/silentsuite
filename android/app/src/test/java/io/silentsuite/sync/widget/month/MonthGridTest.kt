/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widget.month

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Clock
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale

class MonthGridTest {
    private val clock = Clock.fixed(Instant.parse("2026-11-17T12:00:00Z"), ZoneOffset.UTC)
    private fun date(value: String) = LocalDate.parse(value)
    private fun millis(value: String) = Instant.parse(value).toEpochMilli()
    private fun event(begin: String, end: String, allDay: Boolean = false) =
        MonthGrid.EventRange(millis(begin), millis(end), allDay)

    @Test fun `locale controls the first weekday including Saturday`() {
        assertEquals(DayOfWeek.MONDAY, MonthGrid.firstDay(Locale.UK))
        assertEquals(DayOfWeek.SUNDAY, MonthGrid.firstDay(Locale.US))
        assertEquals(DayOfWeek.SATURDAY, MonthGrid.firstDay(Locale.forLanguageTag("ar-EG")))
        for ((locale, start) in listOf(Locale.UK to "2026-10-26", Locale.US to "2026-11-01",
            Locale.forLanguageTag("ar-EG") to "2026-10-31")) {
            val days = MonthGrid.days(YearMonth.of(2026, 11), MonthGrid.firstDay(locale), clock)
            assertEquals(date(start), days.first().date)
            assertEquals(MonthGrid.firstDay(locale), days.first().date.dayOfWeek)
        }
    }

    @Test fun `four five and six week grids have no missing or repeated dates`() {
        for ((month, weeks) in listOf("2021-02" to 4, "2026-04" to 5, "2026-03" to 6)) {
            val ym = YearMonth.parse(month)
            val days = MonthGrid.days(ym, DayOfWeek.MONDAY, clock)
            assertEquals(weeks * 7, days.size)
            assertEquals((1..ym.lengthOfMonth()).map { ym.atDay(it) }, days.filter { it.inMonth }.map { it.date })
            days.zipWithNext().forEach { (a, b) -> assertEquals(a.date.plusDays(1), b.date) }
        }
    }

    @Test fun `leading trailing leap and year boundary days are classified`() {
        val leap = MonthGrid.days(YearMonth.of(2024, 2), DayOfWeek.MONDAY, clock)
        assertEquals(date("2024-01-29"), leap.first().date)
        assertEquals(date("2024-03-03"), leap.last().date)
        assertEquals(29, leap.count { it.inMonth })
        assertFalse(leap.first().inMonth)
        assertFalse(leap.last().inMonth)
        val january = MonthGrid.days(YearMonth.of(2027, 1), DayOfWeek.SUNDAY, clock)
        assertEquals(date("2026-12-27"), january.first().date)
        assertEquals(date("2027-02-06"), january.last().date)
    }

    @Test fun `today uses the device timezone including adjacent month cells`() {
        val instant = Instant.parse("2026-11-01T00:30:00Z")
        for ((zone, expected) in listOf("America/Los_Angeles" to "2026-10-31", "Pacific/Kiritimati" to "2026-11-01")) {
            val days = MonthGrid.days(YearMonth.of(2026, 11), DayOfWeek.MONDAY,
                Clock.fixed(instant, ZoneId.of(zone)))
            assertEquals(listOf(date(expected)), days.filter { it.isToday }.map { it.date })
        }
    }

    @Test fun `timed events mark every local day but not an exclusive midnight end`() {
        val events = listOf(event("2026-11-17T22:00:00Z", "2026-11-20T00:00:00Z"))
        assertEquals(setOf(date("2026-11-17"), date("2026-11-18"), date("2026-11-19")),
            MonthGrid.markedDays(events, date("2026-11-01"), date("2026-11-30"), ZoneOffset.UTC))
        assertEquals(setOf(date("2026-11-18"), date("2026-11-19"), date("2026-11-20")),
            MonthGrid.markedDays(events, date("2026-11-01"), date("2026-11-30"), ZoneId.of("Asia/Tokyo")))
    }

    @Test fun `all day and multiday dates stay on UTC calendar dates in both timezone directions`() {
        val events = listOf(event("2026-11-17T00:00:00Z", "2026-11-18T00:00:00Z", true),
            event("2026-11-19T00:00:00Z", "2026-11-21T00:00:00Z", true))
        for (zone in listOf("America/Los_Angeles", "Pacific/Kiritimati")) {
            assertEquals(setOf(date("2026-11-17"), date("2026-11-19"), date("2026-11-20")),
                MonthGrid.markedDays(events, date("2026-11-01"), date("2026-11-30"), ZoneId.of(zone)))
        }
    }

    @Test fun `day mapping clips long events deduplicates and handles zero duration`() {
        val events = listOf(event("2026-01-01T12:00:00Z", "2027-01-01T12:00:00Z"),
            event("2026-11-17T12:00:00Z", "2026-11-17T12:00:00Z"))
        val first = date("2026-11-16")
        val last = date("2026-11-18")
        assertEquals(setOf(first, date("2026-11-17"), last), MonthGrid.markedDays(events, first, last, ZoneOffset.UTC))
        assertEquals(setOf(date("2026-11-17")), MonthGrid.markedDays(events.takeLast(1), first, last, ZoneOffset.UTC))
        assertTrue(MonthGrid.markedDays(emptyList(), first, last, ZoneOffset.UTC).isEmpty())
        assertTrue(MonthGrid.markedDays(listOf(event("2026-11-18T12:00:00Z", "2026-11-17T12:00:00Z")),
            first, last, ZoneOffset.UTC).isEmpty())
    }

    @Test fun `timed days follow daylight saving transitions`() {
        val events = listOf(event("2026-03-08T07:30:00Z", "2026-03-09T04:00:00Z"))
        assertEquals(setOf(date("2026-03-07"), date("2026-03-08")), MonthGrid.markedDays(
            events, date("2026-03-01"), date("2026-03-31"), ZoneId.of("America/Los_Angeles")))
    }
}
