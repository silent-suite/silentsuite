/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widget.month

import android.Manifest
import android.accounts.AccountManager
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.os.CancellationSignal
import android.provider.CalendarContract
import io.silentsuite.sync.R
import java.time.LocalDate
import java.time.ZoneId

/** Local adapter until the agenda widget's shared reader is available. Never reads event text. */
internal object MonthEventReader {
    enum class State { READY, PERMISSION_REQUIRED, NO_CALENDAR, UNAVAILABLE }
    data class Result(val state: State, val markedDays: Set<LocalDate> = emptySet())

    fun read(context: Context, first: LocalDate, days: Int, zone: ZoneId = ZoneId.systemDefault(),
             cancellation: CancellationSignal? = null): Result {
        require(days in 1..62)
        val last = first.plusDays(days.toLong() - 1)
        if (context.checkSelfPermission(Manifest.permission.READ_CALENDAR) != PackageManager.PERMISSION_GRANTED)
            return Result(State.PERMISSION_REQUIRED)
        return try {
            val accountType = context.getString(R.string.account_type)
            val accounts = AccountManager.get(context).getAccountsByType(accountType)
            if (accounts.isEmpty()) return Result(State.NO_CALENDAR)
            val names = accounts.map { it.name }
            val selection = "${CalendarContract.Calendars.ACCOUNT_TYPE}=? AND " +
                "${CalendarContract.Calendars.VISIBLE}=1 AND " +
                "${CalendarContract.Calendars.ACCOUNT_NAME} IN (${names.joinToString(",") { "?" }})"
            val args = (listOf(accountType) + names).toTypedArray()
            // An empty Instances result cannot distinguish an empty month from no visible calendar.
            val hasCalendar = context.contentResolver.query(
                CalendarContract.Calendars.CONTENT_URI,
                arrayOf(CalendarContract.Calendars._ID), selection, args, null, cancellation
            )?.use { it.moveToFirst() } ?: return Result(State.UNAVAILABLE)
            if (!hasCalendar) return Result(State.NO_CALENDAR)

            // The extra day at each edge also includes all-day UTC dates in UTC-12..UTC+14.
            val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().apply {
                ContentUris.appendId(this, first.minusDays(1).atStartOfDay(zone).toInstant().toEpochMilli())
                ContentUris.appendId(this, last.plusDays(2).atStartOfDay(zone).toInstant().toEpochMilli())
            }.build()
            val marked = mutableSetOf<LocalDate>()
            context.contentResolver.query(uri, arrayOf(
                CalendarContract.Instances.BEGIN,
                CalendarContract.Instances.END,
                CalendarContract.Instances.ALL_DAY
            ), selection, args, null, cancellation)?.use { cursor ->
                while (cursor.moveToNext()) {
                    cancellation?.throwIfCanceled()
                    marked += MonthGrid.markedDays(listOf(MonthGrid.EventRange(
                        cursor.getLong(0), cursor.getLong(1), cursor.getInt(2) != 0
                    )), first, last, zone)
                }
            } ?: return Result(State.UNAVAILABLE)
            Result(State.READY, marked)
        } catch (_: SecurityException) {
            Result(State.PERMISSION_REQUIRED)
        } catch (_: RuntimeException) {
            // A failed provider read must clear old markers; do not log calendar or account data.
            Result(State.UNAVAILABLE)
        }
    }
}
