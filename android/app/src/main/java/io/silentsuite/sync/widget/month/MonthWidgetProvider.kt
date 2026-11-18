/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widget.month

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.format.DateFormat
import android.view.View
import android.widget.RemoteViews
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.AccountActivity
import io.silentsuite.sync.widgets.WidgetActionActivity
import io.silentsuite.sync.widgets.WidgetEventReader
import io.silentsuite.sync.widgets.WidgetRefresh
import io.silentsuite.sync.widgets.WidgetSettings
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
                // Updating options delivers onAppWidgetOptionsChanged, which refreshes once.
            }
            ACTION_REFRESH, Intent.ACTION_LOCALE_CHANGED -> refreshAsync(context)
            else -> super.onReceive(context, intent)
        }
    }

    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) = refreshAsync(context)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) =
        refreshAsync(context)

    override fun onDisabled(context: Context) = WidgetRefresh.schedule(context)

    private fun refreshAsync(context: Context) {
        WidgetRefresh.schedule(context)
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
        private val executor = Executors.newSingleThreadExecutor()

        /** Refresh entry point for the shared permission/settings flow after access changes. */
        @JvmStatic
        fun requestUpdate(context: Context) {
            context.sendBroadcast(Intent(context, MonthWidgetProvider::class.java).setAction(ACTION_REFRESH))
        }

        internal fun ids(context: Context): IntArray = AppWidgetManager.getInstance(context)
            .getAppWidgetIds(ComponentName(context, MonthWidgetProvider::class.java))

        private fun parseMonth(value: String): YearMonth? = try {
            YearMonth.parse(value).takeIf { it.year in 1..9999 }
        } catch (_: java.time.DateTimeException) { null }

        // Cache only dates for this render; event titles and instances stay in the shared reader.
        private data class Snapshot(
            val state: WidgetSettings.State,
            val failed: Boolean,
            val markedDays: Set<LocalDate>
        )

        private fun updateAll(context: Context) {
            val widgetIds = ids(context)
            if (widgetIds.isEmpty()) return
            val manager = AppWidgetManager.getInstance(context)
            val clock = Clock.systemDefaultZone()
            val todayMonth = YearMonth.now(clock)
            val locale = context.resources.configuration.locales[0]
            val results = mutableMapOf<YearMonth, Snapshot>()
            for (id in widgetIds) {
                val options = manager.getAppWidgetOptions(id)
                val month = parseMonth(options.getString(OPTION_MONTH).orEmpty()) ?: todayMonth
                val days = MonthGrid.days(month, MonthGrid.firstDay(locale), clock)
                val result = results.getOrPut(month) {
                    val read = WidgetEventReader.read(context, days.first().date, days.size, clock.zone)
                    Snapshot(read.state, read.failed,
                        read.days.filter { it.events.isNotEmpty() }.mapTo(mutableSetOf()) { it.date })
                }
                val views = RemoteViews(context.packageName, R.layout.widget_month)
                val fullTitle = month.format(DateTimeFormatter.ofPattern(
                    DateFormat.getBestDateTimePattern(locale, "LLLLyyyy"), locale))
                val titleSkeleton = if (month == todayMonth) "LLLLyyyy" else "LLLyyyy"
                views.setTextViewText(R.id.widget_month_title,
                    month.format(DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, titleSkeleton), locale)))
                views.setContentDescription(R.id.widget_month_title, fullTitle)
                views.setOnClickPendingIntent(R.id.widget_month_previous,
                    monthIntent(context, id, month.minusMonths(1).toString(), todayMonth))
                views.setOnClickPendingIntent(R.id.widget_month_next,
                    monthIntent(context, id, month.plusMonths(1).toString(), todayMonth))
                views.setViewVisibility(R.id.widget_month_today, if (month == todayMonth) View.GONE else View.VISIBLE)
                views.setOnClickPendingIntent(R.id.widget_month_today, monthIntent(context, id, "", todayMonth))
                views.setOnClickPendingIntent(R.id.widget_month_add, calendarIntent(context, null))
                if (result.state != WidgetSettings.State.READY || result.failed) {
                    views.setViewVisibility(R.id.widget_month_content, View.GONE)
                    views.setTextViewText(R.id.widget_month_title, context.getString(R.string.widget_month_name))
                    views.setContentDescription(R.id.widget_month_title, context.getString(R.string.widget_month_name))
                    views.setViewVisibility(R.id.widget_month_today, View.GONE)
                    views.setViewVisibility(R.id.widget_month_previous, View.GONE)
                    views.setViewVisibility(R.id.widget_month_next, View.GONE)
                    views.setViewVisibility(R.id.widget_month_add, View.GONE)
                    views.setViewVisibility(R.id.widget_month_message, View.VISIBLE)
                    val message = when (result.state) {
                        WidgetSettings.State.PERMISSION_REQUIRED -> R.string.widget_month_permission
                        WidgetSettings.State.NO_ACCOUNT -> R.string.widget_no_account
                        WidgetSettings.State.OFF -> R.string.widget_turned_off
                        else -> R.string.widget_month_unavailable
                    }
                    views.setTextViewText(R.id.widget_month_message, context.getString(message))
                    views.setOnClickPendingIntent(R.id.widget_month_root,
                        if (result.state == WidgetSettings.State.PERMISSION_REQUIRED)
                            actionIntent(context, WidgetActionActivity.PERMISSION) else appIntent(context))
                } else {
                    // Hosts may reapply a full RemoteViews update onto the old layout.
                    views.setViewVisibility(R.id.widget_month_content, View.VISIBLE)
                    views.setViewVisibility(R.id.widget_month_previous, View.VISIBLE)
                    views.setViewVisibility(R.id.widget_month_next, View.VISIBLE)
                    views.setViewVisibility(R.id.widget_month_add, View.VISIBLE)
                    views.setViewVisibility(R.id.widget_month_message, View.GONE)
                    views.setOnClickPendingIntent(R.id.widget_month_root, null)
                    // Use the smaller host bounds so the box fits in either orientation.
                    // The 88dp budget is 16dp outer padding + 48dp header + 24dp weekdays;
                    // each day reserves another 6dp for the marker and its gap.
                    val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 280)
                    val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 300)
                    val numberWidth = minOf(32, (width - 16) / 7).coerceAtLeast(1)
                    val numberHeight = minOf(32, (height - 88) / (days.size / 7) - 6).coerceAtLeast(1)
                    val density = context.resources.displayMetrics.density
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
                            cell.setInt(R.id.widget_month_number, "setWidth", (numberWidth * density).toInt())
                            cell.setInt(R.id.widget_month_number, "setHeight", (numberHeight * density).toInt())
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

        private fun calendarIntent(context: Context, day: LocalDate?): PendingIntent =
            actionIntent(context, if (day == null) WidgetActionActivity.ADD else WidgetActionActivity.DAY, day)

        private fun actionIntent(context: Context, action: String, day: LocalDate? = null): PendingIntent {
            val intent = Intent(context, WidgetActionActivity::class.java).setAction(action).apply {
                if (day != null) {
                    // Extras do not identify a PendingIntent: give each date its own identity.
                    data = Uri.parse("silentsuite-month://day/$day")
                    putExtra(WidgetActionActivity.DATE, day.toString())
                }
            }
            return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        private fun appIntent(context: Context): PendingIntent = PendingIntent.getActivity(context, 0,
            Intent(context, AccountActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
