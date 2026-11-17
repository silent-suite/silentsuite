/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widget.month

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.CalendarContract
import java.time.ZonedDateTime

internal object MonthWidgetRefresh {
    // Separate from the agenda job; only this widget owns this ID and alarm identity.
    private const val JOB_ID = 0x4d4f4e54

    fun schedule(context: Context, replaceContentJob: Boolean = false): Boolean {
        val scheduler = context.getSystemService(JobScheduler::class.java)
        val scheduled = if (replaceContentJob || scheduler.getPendingJob(JOB_ID) == null) {
            scheduler.schedule(JobInfo.Builder(JOB_ID, ComponentName(context, MonthWidgetRefreshJob::class.java))
                .addTriggerContentUri(JobInfo.TriggerContentUri(CalendarContract.CONTENT_URI,
                    JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
                .setTriggerContentUpdateDelay(1_000)
                .setTriggerContentMaxDelay(5_000)
                .build()) == JobScheduler.RESULT_SUCCESS
        } else true
        val midnight = ZonedDateTime.now().toLocalDate().plusDays(1)
            .atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()
        // Inexact: no exact-alarm permission. Android may defer this during idle/battery saving.
        context.getSystemService(AlarmManager::class.java).setAndAllowWhileIdle(
            AlarmManager.RTC, midnight, alarm(context))
        return scheduled
    }

    fun cancel(context: Context) {
        context.getSystemService(JobScheduler::class.java).cancel(JOB_ID)
        context.getSystemService(AlarmManager::class.java).cancel(alarm(context))
    }

    private fun alarm(context: Context): PendingIntent = PendingIntent.getBroadcast(context, 0,
        Intent(context, MonthWidgetProvider::class.java).setAction(MonthWidgetProvider.ACTION_REFRESH),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
}
