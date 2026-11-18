/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widgets

import android.content.ContentUris
import android.content.Context
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Instances
import io.silentsuite.sync.R
import java.time.LocalDate
import java.time.ZoneId

/** Reads only expanded instances from visible, opted-in SilentSuite calendars. No content is logged. */
object WidgetEventReader {
    data class Result(val state: WidgetSettings.State, val days: List<WidgetDay>, val failed: Boolean = false)

    fun read(context: Context, firstDay: LocalDate, days: Int, zone: ZoneId = ZoneId.systemDefault()): Result {
        val access = WidgetSettings.access(context)
        if (access.state != WidgetSettings.State.READY) return Result(access.state, emptyList())
        val bounds = WidgetEvents.queryBounds(firstDay, days, zone)
        val uri = Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, bounds.first)
            ContentUris.appendId(it, bounds.last)
        }.build()
        val names = access.accounts.map { it.name }
        val selection = "${Calendars.ACCOUNT_TYPE} = ? AND ${Instances.VISIBLE} = 1 AND " +
            "${Calendars.ACCOUNT_NAME} IN (${names.joinToString(",") { "?" }})"
        val args = (listOf(context.getString(R.string.account_type)) + names).toTypedArray()
        val events = mutableListOf<WidgetEvent>()
        try {
            val cursor = context.contentResolver.query(uri, arrayOf(Instances.EVENT_ID, Instances.BEGIN,
                Instances.END, Instances.ALL_DAY, Instances.TITLE, Instances.CALENDAR_COLOR, Calendars.ACCOUNT_NAME),
                selection, args, null) ?: return Result(access.state, emptyList(), failed = true)
            cursor.use {
                while (it.moveToNext()) events += WidgetEvent(it.getLong(0), it.getLong(1), it.getLong(2),
                    it.getInt(3) != 0, it.getString(4).orEmpty(), it.getInt(5), it.getString(6))
            }
        } catch (_: SecurityException) {
            return Result(WidgetSettings.access(context).state, emptyList(), failed = true)
        } catch (_: RuntimeException) {
            return Result(access.state, emptyList(), failed = true)
        }
        // Consent or permission may have changed while the provider was answering the query.
        val current = WidgetSettings.access(context)
        if (current.state != WidgetSettings.State.READY) return Result(current.state, emptyList())
        val allowed = current.accounts.map { it.name }.toSet()
        return Result(current.state, WidgetEvents.group(events.filter { it.accountName in allowed }, firstDay, days, zone))
    }
}
