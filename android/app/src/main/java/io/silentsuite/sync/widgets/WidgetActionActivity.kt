/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widgets

import android.content.ActivityNotFoundException
import android.content.ContentUris
import android.content.Intent
import android.os.Bundle
import android.provider.CalendarContract
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.PermissionsActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.ZoneId

/** A direct widget activity PendingIntent, so launching a calendar is a user action on modern Android. */
class WidgetActionActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WidgetRefresh.schedule(this)
        lifecycleScope.launch {
            try {
                val access = WidgetSettings.access(this@WidgetActionActivity)
                if (access.state == WidgetSettings.State.PERMISSION_REQUIRED) {
                    startActivity(Intent(this@WidgetActionActivity, PermissionsActivity::class.java))
                    return@launch
                }
                if (access.state != WidgetSettings.State.READY) {
                    Toast.makeText(this@WidgetActionActivity, AgendaWidgetProvider.stateMessage(access.state), Toast.LENGTH_SHORT).show()
                    return@launch
                }
                val target = when (intent.action) {
                    TODAY -> Intent(Intent.ACTION_VIEW, CalendarContract.CONTENT_URI.buildUpon()
                        .appendPath("time").appendPath(System.currentTimeMillis().toString()).build())
                    ADD -> Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)
                    EVENT -> {
                        val id = intent.getLongExtra(EVENT_ID, -1)
                        val begin = intent.getLongExtra(BEGIN, Long.MIN_VALUE)
                        val end = intent.getLongExtra(END, Long.MIN_VALUE)
                        // Old launcher rows must not open an event after its account opted out or calendar was hidden.
                        val allowed = withContext(Dispatchers.IO) {
                            val zone = ZoneId.systemDefault()
                            WidgetEventReader.read(this@WidgetActionActivity, LocalDate.now(zone), AgendaWidgetProvider.DAYS, zone)
                                .days.any { day -> day.events.any { it.eventId == id && it.begin == begin && it.end == end } }
                        }
                        if (!allowed) {
                            Toast.makeText(this@WidgetActionActivity, R.string.widget_event_unavailable, Toast.LENGTH_SHORT).show()
                            return@launch
                        }
                        Intent(Intent.ACTION_VIEW, ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id))
                            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin)
                            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
                    }
                    else -> return@launch
                }
                startActivity(target)
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(this@WidgetActionActivity, R.string.widget_no_calendar_app, Toast.LENGTH_LONG).show()
            } catch (_: SecurityException) {
                Toast.makeText(this@WidgetActionActivity, R.string.widget_calendar_unavailable, Toast.LENGTH_LONG).show()
            } finally {
                WidgetRefresh.refresh(this@WidgetActionActivity)
                finish()
            }
        }
    }

    companion object {
        const val TODAY = "io.silentsuite.sync.widgets.TODAY"
        const val ADD = "io.silentsuite.sync.widgets.ADD"
        const val EVENT = "io.silentsuite.sync.widgets.EVENT"
        const val PERMISSION = "io.silentsuite.sync.widgets.PERMISSION"
        const val EVENT_ID = "event_id"
        const val BEGIN = "begin"
        const val END = "end"
    }
}
