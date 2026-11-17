/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widget.month

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
}
