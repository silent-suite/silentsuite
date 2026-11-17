/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widgets

import android.accounts.AccountManager
import android.accounts.OnAccountsUpdateListener
import android.app.Activity
import android.app.Application
import android.app.AlarmManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.Bundle
import android.provider.CalendarContract
import io.silentsuite.sync.ui.PermissionsActivity
import java.time.LocalDate
import java.time.ZoneId

/** OS-owned content observation and a one-shot midnight alarm, with no resident service. */
object WidgetRefresh {
    private const val CONTENT_JOB = 0x535357
    private const val MIDNIGHT = "io.silentsuite.sync.widgets.MIDNIGHT"
    private var permissionReturn: Application.ActivityLifecycleCallbacks? = null
    private var accountListener: OnAccountsUpdateListener? = null
    private val main = Handler(Looper.getMainLooper())

    fun refresh(context: Context) {
        AgendaWidgetProvider.updateAll(context)
        // Other widget providers can refresh here when added to WidgetSettings.providers.
    }

    fun schedule(context: Context, replaceContentJob: Boolean = false) {
        val app = context.applicationContext
        val jobs = app.getSystemService(JobScheduler::class.java) ?: return
        val alarms = app.getSystemService(AlarmManager::class.java) ?: return
        val midnight = PendingIntent.getBroadcast(app, 0,
            Intent(app, WidgetRefreshReceiver::class.java).setAction(MIDNIGHT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        if (!WidgetSettings.hasPlacedWidgets(app) || !WidgetSettings.areWidgetsEnabled(app)) {
            jobs.cancel(CONTENT_JOB)
            alarms.cancel(midnight)
            permissionReturn?.let { (app as Application).unregisterActivityLifecycleCallbacks(it) }
            accountListener?.let { AccountManager.get(app).removeOnAccountsUpdatedListener(it) }
            permissionReturn = null
            accountListener = null
            return
        }
        // These listeners live only as long as this process; JobScheduler observes calendar changes
        // even after it is reclaimed. They also refresh immediately when returning from permissions.
        if (permissionReturn == null) {
            permissionReturn = object : Application.ActivityLifecycleCallbacks {
                override fun onActivityResumed(activity: Activity) {
                    if (activity is PermissionsActivity) main.post { refresh(app); schedule(app) }
                }
                override fun onActivityStopped(activity: Activity) {
                    if (activity is PermissionsActivity) main.post { refresh(app); schedule(app) }
                }
                override fun onActivityCreated(activity: Activity, savedState: Bundle?) = Unit
                override fun onActivityStarted(activity: Activity) = Unit
                override fun onActivityPaused(activity: Activity) = Unit
                override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
                override fun onActivityDestroyed(activity: Activity) = Unit
            }.also { (app as Application).registerActivityLifecycleCallbacks(it) }
        }
        if (accountListener == null) {
            accountListener = OnAccountsUpdateListener { main.post { refresh(app); schedule(app) } }
                .also { AccountManager.get(app).addOnAccountsUpdatedListener(it, main, false) }
        }
        if (WidgetSettings.access(app).state == WidgetSettings.State.READY) {
            if (replaceContentJob || jobs.getPendingJob(CONTENT_JOB) == null) {
                jobs.schedule(JobInfo.Builder(CONTENT_JOB, ComponentName(app, WidgetRefreshService::class.java))
                    .addTriggerContentUri(JobInfo.TriggerContentUri(CalendarContract.CONTENT_URI,
                        JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
                    .setTriggerContentUpdateDelay(1_000)
                    .setTriggerContentMaxDelay(5_000)
                    .build())
            }
        } else jobs.cancel(CONTENT_JOB)
        val zone = ZoneId.systemDefault()
        val nextMidnight = LocalDate.now(zone).plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        // No exact-alarm permission: Android may batch this while idle. Widget periodic updates
        // and time-change broadcasts provide recovery after reboot or a timezone change.
        alarms.setWindow(AlarmManager.RTC, nextMidnight, 10 * 60 * 1_000L, midnight)
    }
}

class WidgetRefreshReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == AccountManager.ACTION_ACCOUNT_REMOVED) {
            WidgetSettings.applyComponentState(context)
        } else {
            WidgetRefresh.refresh(context)
            WidgetRefresh.schedule(context)
        }
    }
}

class WidgetRefreshService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        WidgetRefresh.refresh(this)
        // Content-triggered jobs are one-shot. Re-arm before finishing to retain intervening changes.
        WidgetRefresh.schedule(this, replaceContentJob = true)
        return false
    }
    override fun onStopJob(params: JobParameters): Boolean = true
}
