/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.content.Context
import android.content.SyncResult
import android.os.Bundle
import at.bitfire.ical4android.Task
import com.etebase.client.Item
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.resource.LocalTask
import io.silentsuite.sync.resource.LocalTaskList
import okhttp3.HttpUrl
import java.io.StringReader

/**
 * Synchronization manager for CalDAV collections; handles tasks (VTODO)
 */
class TasksSyncManager(
        context: Context,
        account: Account,
        accountSettings: AccountSettings,
        extras: Bundle,
        authority: String,
        syncResult: SyncResult,
        taskList: LocalTaskList,
        private val remote: HttpUrl
): SyncManager<LocalTask>(context, account, accountSettings, extras, authority, syncResult, taskList.url!!, CollectionInfo.Type.TASKS, account.name) {

    override val syncErrorTitle: String
        get() = context.getString(R.string.sync_error_tasks, account.name)

    override val syncSuccessfullyTitle: String
        get() = context.getString(R.string.sync_successfully_tasks, localTaskList().name!!,
                account.name)

    init {
        localCollection = taskList
    }

    override fun notificationId(): Int {
        return Constants.NOTIFICATION_TASK_SYNC
    }

    override fun prepare(): Boolean {
        if (!super.prepare())
            return false

        return true
    }

    // helpers

    private fun localTaskList(): LocalTaskList {
        return localCollection as LocalTaskList
    }

    override fun processItem(item: Item) {
        val local = localCollection!!.findByFilename(item.uid)

        if (!item.isDeleted) {
            val inputReader = StringReader(String(item.content))

            val tasks = Task.tasksFromReader(inputReader)
            if (tasks.size == 0) {
                Logger.log.warning("Received VCard without data, ignoring")
                return
            } else if (tasks.size > 1) {
                Logger.log.warning("Received multiple VCALs, using first one")
            }

            val task = tasks[0]
            processTask(item, task, local)
        } else {
            if (local != null) {
                Logger.log.info("Removing local record #" + local.id + " which has been deleted on the server")
                local.delete()
            } else {
                Logger.log.warning("Tried deleting a non-existent record: " + item.uid)
            }
        }
    }

    private fun processTask(item: Item, newData: Task, _localTask: LocalTask?): LocalTask {
        var localTask = _localTask
        // delete local Task, if it exists
        if (localTask != null) {
            Logger.log.info("Updating " + item.uid + " in local calendar")
            localTask.eTag = item.etag
            localTask.update(newData)
            syncResult.stats.numUpdates++
        } else {
            Logger.log.info("Adding " + item.uid + " to local calendar")
            localTask = LocalTask(localTaskList(), newData, item.uid, item.etag)
            localTask.add()
            syncResult.stats.numInserts++
        }

        return localTask
    }
}
