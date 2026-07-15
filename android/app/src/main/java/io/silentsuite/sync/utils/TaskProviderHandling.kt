package io.silentsuite.sync.utils

import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.provider.CalendarContract
import at.bitfire.ical4android.TaskProvider
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.resource.LocalTaskList
import io.silentsuite.sync.ui.setup.PostLoginSetupState
import io.silentsuite.sync.utils.defaultSharedPreferences

class TaskProviderHandling {
    companion object {
        /** Same-module instrumentation override; null preserves package/provider discovery. */
        @JvmField internal var wantedProviderResolver: ((Context) -> TaskProvider.ProviderName?)? = null
        @JvmField internal var providerAuthorityResolver: ((TaskProvider.ProviderName) -> String)? = null
        @JvmField internal var calendarIntervalResolver: ((AccountSettings) -> Long?)? = null
        internal fun eligibleAccounts(accounts: Iterable<android.accounts.Account>, explicitCreatingTarget: android.accounts.Account? = null, load: (android.accounts.Account) -> PostLoginSetupState?): List<android.accounts.Account> =
            accounts.filter { account ->
                val state = runCatching { load(account) }.getOrNull()
                state in setOf(
                    PostLoginSetupState.ACCOUNT_CREATED, PostLoginSetupState.COLLECTIONS,
                    PostLoginSetupState.PERMISSIONS, PostLoginSetupState.INITIAL_SYNC,
                    PostLoginSetupState.READY, PostLoginSetupState.COMPLETE
                ) || (account == explicitCreatingTarget && state == PostLoginSetupState.CREATING)
            }
        fun getWantedTaskSyncProvider(context: Context): TaskProvider.ProviderName? {
            val openTasksAvailable = LocalTaskList.tasksProviderAvailable(context, TaskProvider.ProviderName.OpenTasks)
            val tasksOrgAvailable = LocalTaskList.tasksProviderAvailable(context, TaskProvider.ProviderName.TasksOrg)

            if (openTasksAvailable && tasksOrgAvailable) {
                if (context.defaultSharedPreferences.getBoolean(App.PREFER_TASKSORG, false))
                    return TaskProvider.ProviderName.TasksOrg
                else
                    return TaskProvider.ProviderName.OpenTasks
            } else {
                if (openTasksAvailable)
                    return TaskProvider.ProviderName.OpenTasks
                else if (tasksOrgAvailable)
                    return TaskProvider.ProviderName.TasksOrg
                else
                    return null
            }
        }

        fun updateTaskSync(context: Context, provider: TaskProvider.ProviderName, explicitCreatingTarget: android.accounts.Account? = null) {
            val providerAuthority = providerAuthorityResolver?.invoke(provider) ?: provider.authority
            for (account in eligibleAccounts(AccountManager.get(context).getAccountsByType(App.accountType).asIterable(), explicitCreatingTarget) { account ->
                try { AccountSettings(context, account); AccountSettings.setupState(AccountManager.get(context), account, true) } catch (_: Exception) { PostLoginSetupState.RECOVERY_REQUIRED }
            }) {
                val settings = try { AccountSettings(context, account) } catch (_: Exception) { continue }
                if (AccountSettings.setupState(AccountManager.get(context), account, true) == PostLoginSetupState.RECOVERY_REQUIRED)
                    continue
                val calendarSyncInterval = calendarIntervalResolver?.invoke(settings)
                    ?: settings.getSyncInterval(CalendarContract.AUTHORITY)
                val wantedProvider = wantedProviderResolver?.invoke(context) ?: getWantedTaskSyncProvider(context)
                val shouldSync = wantedProvider == provider

                Logger.log.info("Package (un)installed; Syncing (${shouldSync}) for ${provider.name}")
                if (shouldSync) {
                    if (calendarSyncInterval == null) {
                        // do nothing atm
                    } else if (ContentResolver.getIsSyncable(account, providerAuthority) <= 0) {
                        ContentResolver.setIsSyncable(account, providerAuthority, 1)
                        settings.setSyncInterval(providerAuthority, calendarSyncInterval)
                    }
                } else {
                    ContentResolver.setIsSyncable(account, providerAuthority, 0)
                }
            }
        }
    }
}
