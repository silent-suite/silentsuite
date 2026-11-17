/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widget.month

import java.time.Clock
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.temporal.WeekFields
import java.util.Locale

/** Calendar arithmetic shared by the renderer and plain JVM tests. */
internal object MonthGrid {
    data class Day(val date: LocalDate, val inMonth: Boolean, val isToday: Boolean)
    data class EventRange(val beginMillis: Long, val endMillis: Long, val allDay: Boolean)

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

    /** End timestamps are exclusive, including midnight at the end of an all-day event. */
    fun markedDays(events: Iterable<EventRange>, first: LocalDate, last: LocalDate, zone: ZoneId): Set<LocalDate> {
        val marked = mutableSetOf<LocalDate>()
        for (event in events) {
            if (event.endMillis < event.beginMillis) continue
            // CalendarProvider stores all-day dates as UTC midnight, regardless of device zone.
            val eventZone = if (event.allDay) ZoneOffset.UTC else zone
            val start = Instant.ofEpochMilli(event.beginMillis).atZone(eventZone).toLocalDate()
            val inclusiveEnd = if (event.endMillis > event.beginMillis) event.endMillis - 1 else event.beginMillis
            val end = Instant.ofEpochMilli(inclusiveEnd).atZone(eventZone).toLocalDate()
            var date = maxOf(start, first)
            val until = minOf(end, last)
            while (!date.isAfter(until)) {
                marked += date
                date = date.plusDays(1)
            }
        }
        return marked
    }
}
