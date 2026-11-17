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
import java.time.format.FormatStyle
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
    @Volatile private var rows: List<Row> = emptyList()
    private var zone: ZoneId = ZoneId.systemDefault()

    override fun onCreate() = Unit
    override fun onDestroy() { rows = emptyList() }

    override fun onDataSetChanged() {
        zone = ZoneId.systemDefault()
        val identity = Binder.clearCallingIdentity()
        val result = try {
            WidgetEventReader.read(context, LocalDate.now(zone), AgendaWidgetProvider.DAYS, zone)
        } finally {
            Binder.restoreCallingIdentity(identity)
        }
        rows = when {
            result.state != WidgetSettings.State.READY -> listOf(Row.Message(AgendaWidgetProvider.stateMessage(result.state)))
            result.failed -> listOf(Row.Message(R.string.widget_read_failed))
            result.days.all { it.events.isEmpty() } -> listOf(Row.Message(R.string.widget_empty))
            else -> result.days.filter { it.events.isNotEmpty() }.flatMap { day ->
                listOf(Row.Day(day.date)) + day.events.map { Row.Event(day.date, it) }
            }
        }
    }

    override fun getCount(): Int = rows.size
    override fun getViewTypeCount(): Int = 3
    override fun getItemId(position: Int): Long = position.toLong()
    override fun hasStableIds(): Boolean = false
    override fun getLoadingView(): RemoteViews = message(R.string.widget_loading)

    override fun getViewAt(position: Int): RemoteViews {
        val identity = Binder.clearCallingIdentity()
        val access = try { WidgetSettings.access(context) } finally { Binder.restoreCallingIdentity(identity) }
        if (access.state != WidgetSettings.State.READY) return message(AgendaWidgetProvider.stateMessage(access.state))
        return when (val row = rows.getOrNull(position)) {
            is Row.Day -> RemoteViews(context.packageName, R.layout.widget_agenda_day).apply {
                val date = row.date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL))
                setTextViewText(R.id.widget_day, if (row.date == LocalDate.now(zone))
                    context.getString(R.string.widget_today_header, date) else date)
            }
            is Row.Event -> {
                if (access.accounts.none { it.name == row.event.accountName }) return message(R.string.widget_turned_off)
                val event = row.event
                val title = event.title.takeIf { it.isNotBlank() } ?: context.getString(R.string.widget_untitled)
                val time = if (event.allDay) context.getString(R.string.widget_all_day) else {
                    val start = maxOf(event.begin, row.date.atStartOfDay(zone).toInstant().toEpochMilli())
                    val end = minOf(event.end, row.date.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli())
                    val format = DateFormat.getTimeFormat(context)
                    val endLabel = if (Instant.ofEpochMilli(end).atZone(zone).toLocalDate() > row.date)
                        context.getString(R.string.widget_midnight) else format.format(Date(end))
                    context.getString(R.string.widget_time_range, format.format(Date(start)), endLabel)
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
