/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widgets

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

class WidgetEventsTest {
    private val first = LocalDate.of(2026, 11, 17)
    private val utc = ZoneOffset.UTC
    private fun millis(value: String) = Instant.parse(value).toEpochMilli()
    private fun event(id: Long, start: String, end: String, allDay: Boolean = false) = WidgetEvent(
        id, millis(start), millis(end), allDay, "Event $id", 0xff047857.toInt(), "test-account")

    @Test fun `groups by date and keeps empty days for month consumers`() {
        val result = WidgetEvents.group(listOf(event(1, "2026-11-18T10:00:00Z", "2026-11-18T11:00:00Z")), first, 3, utc)
        assertEquals(listOf(first, first.plusDays(1), first.plusDays(2)), result.map { it.date })
        assertEquals(listOf(0, 1, 0), result.map { it.events.size })
    }

    @Test fun `all day events precede timed events and timed events sort by start`() {
        val late = event(3, "2026-11-17T15:00:00Z", "2026-11-17T16:00:00Z")
        val early = event(2, "2026-11-17T08:00:00Z", "2026-11-17T09:00:00Z")
        val allDay = event(1, "2026-11-17T00:00:00Z", "2026-11-18T00:00:00Z", true)
        assertEquals(listOf(1L, 2L, 3L), WidgetEvents.group(listOf(late, early, allDay), first, 1, utc).single().events.map { it.eventId })
    }

    @Test fun `timed multi day events appear each covered day but not their exclusive end date`() {
        val span = event(1, "2026-11-17T22:00:00Z", "2026-11-20T00:00:00Z")
        assertEquals(listOf(1, 1, 1, 0), WidgetEvents.group(listOf(span), first, 4, utc).map { it.events.size })
    }

    @Test fun `all day dates stay UTC dates east and west of UTC`() {
        val span = event(1, "2026-11-17T00:00:00Z", "2026-11-19T00:00:00Z", true)
        for (zone in listOf("America/Los_Angeles", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kolkata")) {
            val days = WidgetEvents.group(listOf(span), first.minusDays(1), 4, ZoneId.of(zone))
            assertEquals(zone, listOf(0, 1, 1, 0), days.map { it.events.size })
        }
    }

    @Test fun `timed events use local dates rather than UTC dates`() {
        val event = event(1, "2026-11-18T02:00:00Z", "2026-11-18T03:00:00Z")
        assertEquals(listOf(1, 0), WidgetEvents.group(listOf(event), first, 2, ZoneId.of("America/Los_Angeles")).map { it.events.size })
        assertEquals(listOf(0, 1), WidgetEvents.group(listOf(event), first, 2, ZoneId.of("Asia/Tokyo")).map { it.events.size })
    }

    @Test fun `window includes overlapping starts and excludes events at either outside edge`() {
        val before = event(1, "2026-11-16T22:00:00Z", "2026-11-17T00:00:00Z")
        val overlap = event(2, "2026-11-16T22:00:00Z", "2026-11-17T01:00:00Z")
        val after = event(3, "2026-11-24T00:00:00Z", "2026-11-24T01:00:00Z")
        val result = WidgetEvents.group(listOf(before, overlap, after), first, 7, utc)
        assertEquals(listOf(2L), result.flatMap { it.events }.map { it.eventId })
    }

    @Test fun `point events belong to exactly one day and malformed negative spans are ignored`() {
        val point = event(1, "2026-11-18T00:00:00Z", "2026-11-18T00:00:00Z")
        val invalid = event(2, "2026-11-18T02:00:00Z", "2026-11-17T22:00:00Z")
        assertEquals(listOf(0, 1), WidgetEvents.group(listOf(point, invalid), first, 2, utc).map { it.events.size })
    }

    @Test fun `spring DST day ends at the next local midnight not after 24 hours`() {
        val day = LocalDate.of(2026, 3, 8)
        val late = event(1, "2026-03-09T03:30:00Z", "2026-03-09T04:00:00Z")
        val next = event(2, "2026-03-09T04:00:00Z", "2026-03-09T04:30:00Z")
        val result = WidgetEvents.group(listOf(next, late), day, 2, ZoneId.of("America/New_York"))
        assertEquals(listOf(listOf(1L), listOf(2L)), result.map { it.events.map { event -> event.eventId } })
    }

    @Test fun `fall DST retains both occurrences of repeated local hour in instant order`() {
        val early = event(1, "2026-11-01T05:30:00Z", "2026-11-01T05:45:00Z")
        val late = event(2, "2026-11-01T06:30:00Z", "2026-11-01T06:45:00Z")
        val result = WidgetEvents.group(listOf(late, early), LocalDate.of(2026, 11, 1), 1, ZoneId.of("America/New_York"))
        assertEquals(listOf(1L, 2L), result.single().events.map { it.eventId })
    }

    @Test fun `query bounds include both UTC all day and local timed window`() {
        for (zoneName in listOf("Pacific/Kiritimati", "Pacific/Pago_Pago", "America/New_York", "UTC")) {
            val zone = ZoneId.of(zoneName)
            val bounds = WidgetEvents.queryBounds(first, 7, zone)
            assertTrue(first.atStartOfDay(zone).toInstant().toEpochMilli() in bounds)
            assertTrue(first.atStartOfDay(utc).toInstant().toEpochMilli() in bounds)
            assertTrue(first.plusDays(7).atStartOfDay(zone).toInstant().toEpochMilli() in bounds)
            assertTrue(first.plusDays(7).atStartOfDay(utc).toInstant().toEpochMilli() in bounds)
        }
    }

    @Test fun `duplicate instances collapse but recurrence occurrences remain distinct`() {
        val one = event(1, "2026-11-17T09:00:00Z", "2026-11-17T10:00:00Z")
        val two = event(1, "2026-11-18T09:00:00Z", "2026-11-18T10:00:00Z")
        assertEquals(listOf(1, 1), WidgetEvents.group(listOf(one, one, two), first, 2, utc).map { it.events.size })
    }

    @Test fun `all day window edges do not leak from the padded instance query`() {
        val before = event(1, "2026-11-16T00:00:00Z", "2026-11-17T00:00:00Z", true)
        val after = event(2, "2026-11-24T00:00:00Z", "2026-11-25T00:00:00Z", true)
        for (zone in listOf("Pacific/Kiritimati", "Pacific/Pago_Pago")) {
            assertTrue(WidgetEvents.group(listOf(before, after), first, 7, ZoneId.of(zone)).all { it.events.isEmpty() })
        }
    }

    @Test fun `display range preserves point events as one instant`() {
        val point = event(1, "2026-11-17T10:00:00Z", "2026-11-17T10:00:00Z")
        val range = WidgetEvents.timedRange(point, first, utc)
        assertEquals(point.begin, range.first)
        assertEquals(range.first, range.last)
    }

    @Test fun `display range clips a multi day event at each local midnight`() {
        val span = event(1, "2026-11-17T22:00:00Z", "2026-11-19T09:00:00Z")
        val start = WidgetEvents.timedRange(span, first, utc)
        val middle = WidgetEvents.timedRange(span, first.plusDays(1), utc)
        val end = WidgetEvents.timedRange(span, first.plusDays(2), utc)
        assertEquals(millis("2026-11-17T22:00:00Z")..millis("2026-11-18T00:00:00Z"), start)
        assertEquals(millis("2026-11-18T00:00:00Z")..millis("2026-11-19T00:00:00Z"), middle)
        assertEquals(millis("2026-11-19T00:00:00Z")..millis("2026-11-19T09:00:00Z"), end)
    }

    @Test fun `display range follows a 23 hour DST day instead of a fixed duration`() {
        val span = event(1, "2026-03-08T00:00:00Z", "2026-03-10T00:00:00Z")
        val range = WidgetEvents.timedRange(span, LocalDate.of(2026, 3, 8), ZoneId.of("America/New_York"))
        assertEquals(millis("2026-03-08T05:00:00Z")..millis("2026-03-09T04:00:00Z"), range)
    }


    @Test fun `agenda retains empty today but omits other empty days when future events exist`() {
        val future = event(1, "2026-11-19T10:00:00Z", "2026-11-19T11:00:00Z")
        val days = WidgetEvents.agendaDays(WidgetEvents.group(listOf(future), first, 7, utc), first)
        assertEquals(listOf(first, first.plusDays(2)), days.map { it.date })
        assertTrue(days.first().events.isEmpty())
        assertEquals(listOf(future), days.last().events)
    }

    @Test fun `agenda leaves a fully empty week to the existing window message`() {
        assertTrue(WidgetEvents.agendaDays(WidgetEvents.group(emptyList(), first, 7, utc), first).isEmpty())
    }

    @Test fun `agenda preserves every event today instead of replacing past events with an empty row`() {
        val morning = event(1, "2026-11-17T06:00:00Z", "2026-11-17T07:00:00Z")
        val evening = event(2, "2026-11-17T21:00:00Z", "2026-11-17T22:00:00Z")
        val days = WidgetEvents.agendaDays(WidgetEvents.group(listOf(evening, morning), first, 7, utc), first)
        assertEquals(listOf(first), days.map { it.date })
        assertEquals(listOf(morning, evening), days.single().events)
    }

}
