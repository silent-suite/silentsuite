/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.content.ContentResolver
import android.content.Context
import android.os.Bundle
import android.provider.CalendarContract
import at.bitfire.ical4android.TaskProvider
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.utils.TaskProviderHandling

/** Resumable platform sync scheduling for an already durable account-created row. */
object PostLoginSyncConfigurator {
    /** Same-module instrumentation override; reset it in a finally block. */
    @JvmField internal var configureOverride: ((Context, Account) -> Boolean)? = null

    fun configure(context: Context, account: Account): Boolean =
        configureOverride?.invoke(context, account) ?: runCatching {
            val interval = Constants.DEFAULT_SYNC_INTERVAL.toLong()
            val wanted = TaskProviderHandling.getWantedTaskSyncProvider(context)
            configureEnabled(account, App.addressBooksAuthority, interval)
            configureEnabled(account, CalendarContract.AUTHORITY, interval)
            TaskProvider.TASK_PROVIDERS.forEach { provider ->
                if (provider == wanted) configureEnabled(account, provider.authority, interval)
                else ContentResolver.setIsSyncable(account, provider.authority, 0)
            }
            verifyEnabled(account, App.addressBooksAuthority) &&
                verifyEnabled(account, CalendarContract.AUTHORITY) &&
                TaskProvider.TASK_PROVIDERS.all { provider ->
                    if (provider == wanted) verifyEnabled(account, provider.authority)
                    else ContentResolver.getIsSyncable(account, provider.authority) <= 0
                }
        }.getOrDefault(false)

    private fun configureEnabled(account: Account, authority: String, interval: Long) {
        ContentResolver.setIsSyncable(account, authority, 1)
        ContentResolver.setSyncAutomatically(account, authority, true)
        ContentResolver.addPeriodicSync(account, authority, Bundle(), interval)
    }

    private fun verifyEnabled(account: Account, authority: String): Boolean =
        ContentResolver.getIsSyncable(account, authority) > 0 &&
            ContentResolver.getSyncAutomatically(account, authority)
}
