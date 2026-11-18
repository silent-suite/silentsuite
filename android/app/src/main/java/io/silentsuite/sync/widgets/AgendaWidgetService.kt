/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widgets

import android.content.Context
import android.content.Intent
import android.os.Binder
import android.text.format.DateFormat
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import io.silentsuite.sync.R
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date

class AgendaWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = AgendaFactory(applicationContext)
}

private class AgendaFactory(private val context: Context) : RemoteViewsService.RemoteViewsFactory {
    private sealed class Row {
        data class Day(val date: LocalDate) : Row()
        data class Event(val date: LocalDate, val event: WidgetEvent) : Row()
        data class Message(val text: Int) : Row()
    }
    private data class Snapshot(val rows: List<Row>, val zone: ZoneId, val revision: Long)
    @Volatile private var snapshot = Snapshot(emptyList(), ZoneId.systemDefault(), -1)

    override fun onCreate() = Unit
    override fun onDestroy() { snapshot = snapshot.copy(rows = emptyList()) }

    override fun onDataSetChanged() {
        val zone = ZoneId.systemDefault()
        val today = LocalDate.now(zone)
        val revision = WidgetSettings.dataRevision.get()
        val identity = Binder.clearCallingIdentity()
        val result = try {
            WidgetEventReader.read(context, today, AgendaWidgetProvider.DAYS, zone)
        } finally {
            Binder.restoreCallingIdentity(identity)
        }
        val agendaDays = WidgetEvents.agendaDays(result.days, today)
        val rows = when {
            result.state != WidgetSettings.State.READY -> listOf(Row.Message(AgendaWidgetProvider.stateMessage(result.state)))
            result.failed -> listOf(Row.Message(R.string.widget_read_failed))
            agendaDays.isEmpty() -> listOf(Row.Message(R.string.widget_empty))
            else -> agendaDays.flatMap { day ->
                listOf(Row.Day(day.date)) + if (day.events.isEmpty())
                    listOf(Row.Message(R.string.widget_no_events_today))
                else day.events.map { Row.Event(day.date, it) }
            }
        }
        snapshot = Snapshot(rows, zone, revision)
    }

    override fun getCount(): Int = snapshot.rows.size
    override fun getViewTypeCount(): Int = 3
    override fun getItemId(position: Int): Long = position.toLong()
    override fun hasStableIds(): Boolean = false
    override fun getLoadingView(): RemoteViews = message(R.string.widget_loading)

    override fun getViewAt(position: Int): RemoteViews {
        val current = snapshot
        // Reader checks consent before/after the query; a subsequent widget refresh invalidates
        // this snapshot, so queued rows cannot newly reveal an account that was just turned off.
        if (current.revision != WidgetSettings.dataRevision.get()) return message(R.string.widget_loading)
        val zone = current.zone
        return when (val row = current.rows.getOrNull(position)) {
            is Row.Day -> RemoteViews(context.packageName, R.layout.widget_agenda_day).apply {
                val locale = context.resources.configuration.locales[0]
                val pattern = DateFormat.getBestDateTimePattern(locale, "EEE MMM d")
                val date = row.date.format(DateTimeFormatter.ofPattern(pattern, locale))
                setTextViewText(R.id.widget_day, if (row.date == LocalDate.now(zone))
                    context.getString(R.string.widget_today_header, date) else date)
            }
            is Row.Event -> {
                val event = row.event
                val title = event.title.takeIf { it.isNotBlank() } ?: context.getString(R.string.widget_untitled)
                val time = if (event.allDay) context.getString(R.string.widget_all_day) else {
                    val range = WidgetEvents.timedRange(event, row.date, zone)
                    val format = DateFormat.getTimeFormat(context)
                    val endLabel = if (Instant.ofEpochMilli(range.last).atZone(zone).toLocalDate() > row.date)
                        context.getString(R.string.widget_midnight) else format.format(Date(range.last))
                    val startLabel = format.format(Date(range.first))
                    if (range.first == range.last) startLabel
                    else context.getString(R.string.widget_time_range, startLabel, endLabel)
                }
                RemoteViews(context.packageName, R.layout.widget_agenda_event).apply {
                    setTextViewText(R.id.widget_event_title, title)
                    setTextViewText(R.id.widget_event_time, time)
                    setInt(R.id.widget_event_color, "setBackgroundColor", event.calendarColor or (0xff shl 24))
                    setContentDescription(R.id.widget_event_row, context.getString(R.string.widget_event_description, title, time))
                    setOnClickFillInIntent(R.id.widget_event_row, Intent().apply {
                        putExtra(WidgetActionActivity.EVENT_ID, event.eventId)
                        putExtra(WidgetActionActivity.BEGIN, event.begin)
                        putExtra(WidgetActionActivity.END, event.end)
                    })
                }
            }
            is Row.Message -> message(row.text)
            null -> message(R.string.widget_loading)
        }
    }

    private fun message(text: Int): RemoteViews = RemoteViews(context.packageName, R.layout.widget_agenda_message).apply {
        setTextViewText(R.id.widget_message, context.getString(text))
    }
}
