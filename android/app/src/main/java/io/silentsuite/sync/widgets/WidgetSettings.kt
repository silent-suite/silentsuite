/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widgets

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.R
import io.silentsuite.sync.widget.month.MonthWidgetProvider
import java.util.concurrent.atomic.AtomicLong

/** Shared opt-in and component gate. Add future widget providers to [providers]. */
object WidgetSettings {
    // A refresh invalidates factory snapshots immediately, without AccountManager IPC per row.
    internal val dataRevision = AtomicLong()

    enum class State { READY, NO_ACCOUNT, OFF, PERMISSION_REQUIRED }
    data class Access(val state: State, val accounts: List<Account>)

    fun access(context: Context): Access {
        val manager = AccountManager.get(context)
        val accounts = try {
            manager.getAccountsByType(context.getString(R.string.account_type)).toList()
        } catch (_: Exception) {
            return Access(State.OFF, emptyList())
        }
        if (accounts.isEmpty()) return Access(State.NO_ACCOUNT, emptyList())
        val enabled = accounts.filter { AccountSettings.widgetsEnabled(manager, it) }
        if (enabled.isEmpty()) return Access(State.OFF, emptyList())
        val state = if (context.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED)
            State.READY else State.PERMISSION_REQUIRED
        return Access(state, enabled)
    }

    fun areWidgetsEnabled(context: Context): Boolean = access(context).accounts.isNotEmpty()

    internal fun providers(context: Context): List<ComponentName> =
        listOf(ComponentName(context, AgendaWidgetProvider::class.java),
            ComponentName(context, MonthWidgetProvider::class.java))

    /** Called after a verified switch write, never from application startup or account migration. */
    fun applyComponentState(context: Context) {
        // Clear previously delivered event views before PackageManager removes a disabled provider.
        AgendaWidgetProvider.updateAll(context)
        val state = if (areWidgetsEnabled(context)) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        for (provider in providers(context)) {
            if (context.packageManager.getComponentEnabledSetting(provider) != state)
                context.packageManager.setComponentEnabledSetting(provider, state, PackageManager.DONT_KILL_APP)
        }
        // Switching one account off need not emit a CalendarProvider change for the remaining widgets.
        MonthWidgetProvider.requestUpdate(context)
        WidgetRefresh.schedule(context)
    }

    internal fun hasPlacedWidgets(context: Context): Boolean {
        val manager = AppWidgetManager.getInstance(context)
        return providers(context).any { manager.getAppWidgetIds(it).isNotEmpty() }
    }
}
