/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widget.month

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.provider.CalendarContract
import android.view.View
import android.widget.RemoteViews
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.AccountActivity
import java.text.NumberFormat
import java.time.Clock
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.concurrent.Executors

class MonthWidgetProvider : AppWidgetProvider() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_MONTH -> {
                val manager = AppWidgetManager.getInstance(context)
                val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
                if (id !in ids(context)) return
                val target = intent.getStringExtra(EXTRA_MONTH).orEmpty()
                if (target.isNotEmpty() && parseMonth(target) == null) return
                // Empty means follow today across future month boundaries; other months stay pinned.
                manager.updateAppWidgetOptions(id, Bundle().apply { putString(OPTION_MONTH, target) })
                refreshAsync(context)
            }
            ACTION_REFRESH, Intent.ACTION_DATE_CHANGED, Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_LOCALE_CHANGED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> refreshAsync(context)
            else -> super.onReceive(context, intent)
        }
    }

    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) = refreshAsync(context)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) =
        refreshAsync(context)

    override fun onDisabled(context: Context) = MonthWidgetRefresh.cancel(context)

    private fun refreshAsync(context: Context) {
        val pending = goAsync()
        val app = context.applicationContext
        executor.execute {
            try {
                updateAll(app)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        internal const val ACTION_REFRESH = "io.silentsuite.sync.widget.month.REFRESH"
        private const val ACTION_MONTH = "io.silentsuite.sync.widget.month.MONTH"
        private const val EXTRA_MONTH = "month"
        private const val OPTION_MONTH = "io.silentsuite.sync.widget.month.displayed"
        internal val executor = Executors.newSingleThreadExecutor()

        internal fun ids(context: Context): IntArray = AppWidgetManager.getInstance(context)
            .getAppWidgetIds(ComponentName(context, MonthWidgetProvider::class.java))

        private fun parseMonth(value: String): YearMonth? = try {
            YearMonth.parse(value).takeIf { it.year in 1..9999 }
        } catch (_: java.time.DateTimeException) { null }

        internal fun updateAll(context: Context, cancellation: CancellationSignal? = null) {
            val widgetIds = ids(context)
            if (widgetIds.isEmpty()) {
                MonthWidgetRefresh.cancel(context)
                return
            }
            // Arm before reading so a provider change during the read causes a subsequent update.
            MonthWidgetRefresh.schedule(context)
            val manager = AppWidgetManager.getInstance(context)
            val clock = Clock.systemDefaultZone()
            val todayMonth = YearMonth.now(clock)
            val locale = context.resources.configuration.locales[0]
            val results = mutableMapOf<YearMonth, MonthEventReader.Result>()
            for (id in widgetIds) {
                if (cancellation?.isCanceled == true) return
                val options = manager.getAppWidgetOptions(id)
                val month = parseMonth(options.getString(OPTION_MONTH).orEmpty()) ?: todayMonth
                val days = MonthGrid.days(month, MonthGrid.firstDay(locale), clock)
                val result = if (MonthWidgetGate.areWidgetsEnabled(context)) {
                    results.getOrPut(month) {
                        MonthEventReader.read(context, days.first().date, days.size, clock.zone, cancellation)
                    }
                } else MonthEventReader.Result(MonthEventReader.State.UNAVAILABLE)
                val views = RemoteViews(context.packageName, R.layout.widget_month)
                views.setTextViewText(R.id.widget_month_title,
                    month.format(DateTimeFormatter.ofPattern("LLLL yyyy", locale)))
                views.setOnClickPendingIntent(R.id.widget_month_previous,
                    monthIntent(context, id, month.minusMonths(1).toString(), todayMonth))
                views.setOnClickPendingIntent(R.id.widget_month_next,
                    monthIntent(context, id, month.plusMonths(1).toString(), todayMonth))
                views.setViewVisibility(R.id.widget_month_today, if (month == todayMonth) View.INVISIBLE else View.VISIBLE)
                views.setOnClickPendingIntent(R.id.widget_month_today, monthIntent(context, id, "", todayMonth))
                views.setOnClickPendingIntent(R.id.widget_month_add, calendarIntent(context, null))
                if (result.state != MonthEventReader.State.READY) {
                    views.setViewVisibility(R.id.widget_month_content, View.GONE)
                    views.setViewVisibility(R.id.widget_month_navigation, View.GONE)
                    views.setViewVisibility(R.id.widget_month_add, View.GONE)
                    views.setViewVisibility(R.id.widget_month_message, View.VISIBLE)
                    val message = when (result.state) {
                        MonthEventReader.State.PERMISSION_REQUIRED -> R.string.widget_month_permission
                        MonthEventReader.State.NO_CALENDAR -> R.string.widget_month_no_calendar
                        else -> R.string.widget_month_unavailable
                    }
                    views.setTextViewText(R.id.widget_month_message, context.getString(message))
                    views.setOnClickPendingIntent(R.id.widget_month_root, appIntent(context))
                } else {
                    // Hosts may reapply a full RemoteViews update onto the old layout.
                    views.setViewVisibility(R.id.widget_month_content, View.VISIBLE)
                    views.setViewVisibility(R.id.widget_month_navigation, View.VISIBLE)
                    views.setViewVisibility(R.id.widget_month_add, View.VISIBLE)
                    views.setViewVisibility(R.id.widget_month_message, View.GONE)
                    views.setOnClickPendingIntent(R.id.widget_month_root, null)
                    val numbers = NumberFormat.getIntegerInstance(locale)
                    val dateFormat = DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).withLocale(locale)
                    views.removeAllViews(R.id.widget_month_weekdays)
                    repeat(7) { offset ->
                        val weekday = days[offset].date.dayOfWeek
                        val label = RemoteViews(context.packageName, R.layout.widget_month_weekday)
                        label.setTextViewText(R.id.widget_month_weekday, weekday.getDisplayName(TextStyle.NARROW_STANDALONE, locale))
                        label.setContentDescription(R.id.widget_month_weekday, weekday.getDisplayName(TextStyle.FULL_STANDALONE, locale))
                        views.addView(R.id.widget_month_weekdays, label)
                    }
                    views.removeAllViews(R.id.widget_month_weeks)
                    for (week in days.chunked(7)) {
                        val row = RemoteViews(context.packageName, R.layout.widget_month_week)
                        for (day in week) {
                            val layout = when {
                                day.isToday -> R.layout.widget_month_day_today
                                !day.inMonth -> R.layout.widget_month_day_outside
                                else -> R.layout.widget_month_day
                            }
                            val cell = RemoteViews(context.packageName, layout)
                            cell.setTextViewText(R.id.widget_month_number, numbers.format(day.date.dayOfMonth))
                            val marked = day.date in result.markedDays
                            cell.setViewVisibility(R.id.widget_month_marker, if (marked) View.VISIBLE else View.INVISIBLE)
                            val description = buildList {
                                add(day.date.format(dateFormat))
                                if (day.isToday) add(context.getString(R.string.widget_month_today))
                                if (marked) add(context.getString(R.string.widget_month_has_events))
                            }.joinToString(", ")
                            cell.setContentDescription(R.id.widget_month_day, description)
                            cell.setOnClickPendingIntent(R.id.widget_month_day, calendarIntent(context, day.date))
                            row.addView(R.id.widget_month_week, cell)
                        }
                        views.addView(R.id.widget_month_weeks, row)
                    }
                }
                if (cancellation?.isCanceled == true) return
                manager.updateAppWidget(id, views)
            }
        }

        private fun monthIntent(context: Context, id: Int, target: String, today: YearMonth): PendingIntent {
            val intent = Intent(context, MonthWidgetProvider::class.java).apply {
                action = ACTION_MONTH
                data = Uri.parse("silentsuite-month://month/$id/$target")
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                putExtra(EXTRA_MONTH, if (target == today.toString()) "" else target)
            }
            return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        /** Kept here for the later swap to the shared calendar-routing Activity. */
        private fun calendarIntent(context: Context, day: LocalDate?): PendingIntent {
            val intent = if (day == null) {
                Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)
            } else {
                val millis = day.atStartOfDay(Clock.systemDefaultZone().zone).toInstant().toEpochMilli()
                Intent(Intent.ACTION_VIEW, ContentUris.withAppendedId(
                    CalendarContract.CONTENT_URI.buildUpon().appendPath("time").build(), millis))
            }
            return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        private fun appIntent(context: Context): PendingIntent = PendingIntent.getActivity(context, 0,
            Intent(context, AccountActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
