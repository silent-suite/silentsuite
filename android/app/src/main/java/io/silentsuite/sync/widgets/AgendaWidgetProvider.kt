/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import io.silentsuite.sync.R

class AgendaWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        updateAll(context)
        WidgetRefresh.schedule(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        updateAll(context)
    }

    override fun onDisabled(context: Context) { WidgetRefresh.schedule(context) }

    companion object {
        const val DAYS = 7

        internal fun stateMessage(state: WidgetSettings.State): Int = when (state) {
            WidgetSettings.State.NO_ACCOUNT -> R.string.widget_no_account
            WidgetSettings.State.OFF -> R.string.widget_turned_off
            WidgetSettings.State.PERMISSION_REQUIRED -> R.string.widget_permission_required
            WidgetSettings.State.READY -> R.string.widget_empty
        }

        @Suppress("DEPRECATION") // RemoteViewsService supports the app's API 29 minimum.
        fun updateAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, AgendaWidgetProvider::class.java))
            if (ids.isEmpty()) return
            WidgetSettings.dataRevision.incrementAndGet()
            val state = WidgetSettings.access(context).state
            for (id in ids) {
                val views = RemoteViews(context.packageName, R.layout.widget_agenda)
                views.setOnClickPendingIntent(R.id.widget_header, action(context, id, WidgetActionActivity.TODAY))
                views.setOnClickPendingIntent(R.id.widget_add, action(context, id, WidgetActionActivity.ADD))
                views.setOnClickPendingIntent(R.id.widget_status, action(context, id, WidgetActionActivity.PERMISSION))
                val ready = state == WidgetSettings.State.READY
                views.setViewVisibility(R.id.widget_list, if (ready) View.VISIBLE else View.GONE)
                views.setViewVisibility(R.id.widget_status, if (ready) View.GONE else View.VISIBLE)
                views.setViewVisibility(R.id.widget_add, if (ready) View.VISIBLE else View.GONE)
                views.setTextViewText(R.id.widget_status, context.getString(stateMessage(state)))
                views.setRemoteAdapter(R.id.widget_list, Intent(context, AgendaWidgetService::class.java).apply {
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                    data = Uri.parse("silentsuite-widget://agenda/$id")
                })
                val template = Intent(context, WidgetActionActivity::class.java).apply {
                    action = WidgetActionActivity.EVENT
                    data = Uri.parse("silentsuite-widget://agenda/$id/event")
                }
                val mutable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                views.setPendingIntentTemplate(R.id.widget_list, PendingIntent.getActivity(context, id, template,
                    PendingIntent.FLAG_UPDATE_CURRENT or mutable))
                manager.updateAppWidget(id, views)
            }
            manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list)
        }

        private fun action(context: Context, id: Int, action: String): PendingIntent = PendingIntent.getActivity(
            context, id, Intent(context, WidgetActionActivity::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
