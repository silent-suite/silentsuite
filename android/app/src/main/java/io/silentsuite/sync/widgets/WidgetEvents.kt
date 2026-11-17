/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widgets

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

/** An expanded CalendarContract instance. All-day begin/end are UTC dates, end exclusive. */
data class WidgetEvent(
    val eventId: Long,
    val begin: Long,
    val end: Long,
    val allDay: Boolean,
    val title: String,
    val calendarColor: Int,
    val accountName: String,
)

data class WidgetDay(val date: LocalDate, val events: List<WidgetEvent>)

/** Pure date logic shared by calendar widgets. Empty days are retained for month consumers. */
object WidgetEvents {
    fun group(events: List<WidgetEvent>, firstDay: LocalDate, days: Int, zone: ZoneId): List<WidgetDay> {
        require(days in 1..62)
        val order = compareBy<WidgetEvent> { !it.allDay }
            .thenBy { it.begin }.thenBy { it.end }.thenBy { it.title }.thenBy { it.eventId }
        return (0 until days).map { offset ->
            val day = firstDay.plusDays(offset.toLong())
            val dayStart = day.atStartOfDay(zone).toInstant().toEpochMilli()
            val dayEnd = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
            WidgetDay(day, events.filter { event ->
                if (event.end < event.begin) false
                else if (event.allDay) {
                    val start = Instant.ofEpochMilli(event.begin).atZone(ZoneOffset.UTC).toLocalDate()
                    val end = Instant.ofEpochMilli(event.end).atZone(ZoneOffset.UTC).toLocalDate()
                    !day.isBefore(start) && day.isBefore(end)
                } else if (event.begin == event.end) {
                    event.begin >= dayStart && event.begin < dayEnd
                } else event.begin < dayEnd && event.end > dayStart
            }.distinctBy { Triple(it.eventId, it.begin, it.end) }.sortedWith(order))
        }
    }

    /** Keep today as an empty section when later events exist; an empty window has no sections. */
    fun agendaDays(days: List<WidgetDay>, today: LocalDate): List<WidgetDay> =
        if (days.all { it.events.isEmpty() }) emptyList()
        else days.filter { it.date == today || it.events.isNotEmpty() }

    /** Clip a timed instance to one displayed day; equal endpoints represent a point event. */
    fun timedRange(event: WidgetEvent, day: LocalDate, zone: ZoneId): LongRange =
        maxOf(event.begin, day.atStartOfDay(zone).toInstant().toEpochMilli())..
            minOf(event.end, day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli())

    /** Query both local timed boundaries and UTC all-day boundaries; grouping clips the excess. */
    fun queryBounds(firstDay: LocalDate, days: Int, zone: ZoneId): LongRange {
        require(days in 1..62)
        val end = firstDay.plusDays(days.toLong())
        val startMillis = minOf(firstDay.atStartOfDay(zone).toInstant().toEpochMilli(),
            firstDay.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        val endMillis = maxOf(end.atStartOfDay(zone).toInstant().toEpochMilli(),
            end.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        return startMillis..endMillis
    }
}
