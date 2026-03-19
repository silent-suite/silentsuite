/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android

import android.accounts.Account
import android.annotation.SuppressLint
import android.content.ContentProviderClient
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.content.pm.PackageInfoCompat
import at.bitfire.ical4android.MiscUtils.ContentProviderClientHelper.closeCompat
import org.dmfs.tasks.contract.TaskContract
import java.io.Closeable
import java.util.logging.Level


class TaskProvider private constructor(
        val name: ProviderName,
        val client: ContentProviderClient
): Closeable {

    enum class ProviderName(
            val authority: String,
            val packageName: String,
            val minVersionCode: Long,
            val minVersionName: String,
            private val readPermission: String,
            private val writePermission: String
    ) {
        OpenTasks("org.dmfs.tasks", "org.dmfs.tasks", 103, "1.1.8.2", PERMISSION_OPENTASKS_READ, PERMISSION_OPENTASKS_WRITE),
        TasksOrg("org.tasks.opentasks", "org.tasks", 100000, "10.0", PERMISSION_TASKS_ORG_READ, PERMISSION_TASKS_ORG_WRITE);

        companion object {
            fun fromAuthority(authority: String): ProviderName {
                for (provider in values())
                    if (provider.authority == authority)
                        return provider
                throw IllegalArgumentException("Unknown tasks authority $authority")
            }
        }

        val permissions: Array<String>
            get() = arrayOf(readPermission, writePermission)
    }

    companion object {

        val TASK_PROVIDERS = listOf(
                ProviderName.OpenTasks,
                ProviderName.TasksOrg
        )

        const val PERMISSION_OPENTASKS_READ = "org.dmfs.permission.READ_TASKS"
        const val PERMISSION_OPENTASKS_WRITE = "org.dmfs.permission.WRITE_TASKS"
        val PERMISSIONS_OPENTASKS = arrayOf(PERMISSION_OPENTASKS_READ, PERMISSION_OPENTASKS_WRITE)

        const val PERMISSION_TASKS_ORG_READ = "org.tasks.permission.READ_TASKS"
        const val PERMISSION_TASKS_ORG_WRITE = "org.tasks.permission.WRITE_TASKS"
        val PERMISSIONS_TASKS_ORG = arrayOf(PERMISSION_TASKS_ORG_READ, PERMISSION_TASKS_ORG_WRITE)

        /**
         * Acquires a content provider for a given task provider. The content provider will
         * be released when the TaskProvider is closed with [close].
         * @param context will be used to acquire the content provider client
         * @param name task provider to acquire content provider for; *null* to try all supported providers
         * @return content provider for the given task provider (may be *null*)
         * @throws [ProviderTooOldException] if the tasks provider is installed, but doesn't meet the minimum version requirement
         */
        @SuppressLint("Recycle")
        fun acquire(context: Context, name: ProviderName? = null): TaskProvider? {
            val providers =
                    name?.let { arrayOf(it) }       // provider name given? create array from it
                    ?: ProviderName.values()        // otherwise, try all providers
            for (provider in providers)
                try {
                    checkVersion(context, provider)

                    val client = context.contentResolver.acquireContentProviderClient(provider.authority)
                    if (client != null)
                        return TaskProvider(provider, client)
                } catch(e: SecurityException) {
                    Ical4Android.log.log(Level.WARNING, "Not allowed to access task provider", e)
                } catch(e: PackageManager.NameNotFoundException) {
                    Ical4Android.log.warning("Package ${provider.packageName} not installed")
                }
            return null
        }

        fun fromProviderClient(
                context: Context,
                provider: ProviderName,
                client: ContentProviderClient
        ): TaskProvider {
            checkVersion(context, provider)
            return TaskProvider(provider, client)
        }

        /**
         * Checks the version code of an installed tasks provider.
         * @throws PackageManager.NameNotFoundException if the tasks provider is not installed
         * @throws [ProviderTooOldException] if the tasks provider is installed, but doesn't meet the minimum version requirement
         * */
        private fun checkVersion(context: Context, name: ProviderName) {
            // check whether package is available with required minimum version
            val info = context.packageManager.getPackageInfo(name.packageName, 0)
            val installedVersionCode = PackageInfoCompat.getLongVersionCode(info)
            if (installedVersionCode < name.minVersionCode) {
                val exception = ProviderTooOldException(name, installedVersionCode, info.versionName ?: "unknown")
                Ical4Android.log.log(Level.WARNING, "Task provider too old", exception)
                throw exception
            }
        }

        fun syncAdapterUri(uri: Uri, account: Account) = uri.buildUpon()
                .appendQueryParameter(TaskContract.ACCOUNT_NAME, account.name)
                .appendQueryParameter(TaskContract.ACCOUNT_TYPE, account.type)
                .appendQueryParameter(TaskContract.CALLER_IS_SYNCADAPTER, "true")
                .build()!!

    }


    fun taskListsUri() = TaskContract.TaskLists.getContentUri(name.authority)!!
    fun syncStateUri() = TaskContract.SyncState.getContentUri(name.authority)!!

    fun tasksUri() = TaskContract.Tasks.getContentUri(name.authority)!!
    fun propertiesUri() = TaskContract.Properties.getContentUri(name.authority)!!
    fun alarmsUri() = TaskContract.Alarms.getContentUri(name.authority)!!
    fun categoriesUri() = TaskContract.Categories.getContentUri(name.authority)!!


    override fun close() {
        client.closeCompat()
    }


    class ProviderTooOldException(
            val provider: ProviderName,
            installedVersionCode: Long,
            val installedVersionName: String
    ): Exception("Package ${provider.packageName} has version $installedVersionName ($installedVersionCode), " +
            "required: ${provider.minVersionName} (${provider.minVersionCode})")

}
