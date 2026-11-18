/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widget.month

import java.time.Clock
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.YearMonth
import java.time.temporal.WeekFields
import java.util.Locale

/** Calendar arithmetic shared by the renderer and plain JVM tests. */
internal object MonthGrid {
    data class Day(val date: LocalDate, val inMonth: Boolean, val isToday: Boolean)

    fun firstDay(locale: Locale): DayOfWeek = WeekFields.of(locale).firstDayOfWeek

    fun days(month: YearMonth, firstDay: DayOfWeek, clock: Clock): List<Day> {
        val first = month.atDay(1)
        val leading = Math.floorMod(first.dayOfWeek.value - firstDay.value, 7)
        val start = first.minusDays(leading.toLong())
        val count = ((leading + month.lengthOfMonth() + 6) / 7) * 7
        val today = LocalDate.now(clock)
        return List(count) { offset ->
            val date = start.plusDays(offset.toLong())
            Day(date, YearMonth.from(date) == month, date == today)
        }
    }
}
