/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widget.month

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.CancellationSignal

/** The system watches CalendarProvider even when SilentSuite's process is not running. */
class MonthWidgetRefreshJob : JobService() {
    private var cancellation: CancellationSignal? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val signal = CancellationSignal()
        cancellation = signal
        MonthWidgetProvider.executor.execute {
            try {
                MonthWidgetProvider.updateAll(this, signal)
            } finally {
                if (!signal.isCanceled) {
                    if (MonthWidgetProvider.ids(this).isNotEmpty()) {
                        // Replacing a running content job ends it. Do this only AFTER reading;
                        // Android carries changes seen during this run over to its replacement.
                        if (!MonthWidgetRefresh.schedule(this, replaceContentJob = true))
                            jobFinished(params, true)
                    } else {
                        jobFinished(params, false)
                    }
                }
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        cancellation?.cancel()
        return true
    }
}
