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

    /**
     * A task list row that no complete listing has filled yet is listed from the start, as the
     * collection's saved sync token may already be past entries this row never received.
     */
    override fun replayFromStart(): Boolean {
        if (localTaskList().populated())
            return false
        Logger.log.info("Listing this task list from the start, as it isn't marked complete")
        return true
    }

    override fun onReplayCompleted() {
        localTaskList().markPopulated()
    }

    /** What this run does with [item] given a local change of it that isn't uploaded yet. */
    private fun replayLocalChange(item: Item, local: LocalTask?): ReplayLocalChange {
        val pending = replaying && local?.id?.let { localTaskList().hasPendingChange(it) } == true
        return replayLocalChange(replaying, item.isDeleted, pending)
    }

    override fun keepsLocalChange(item: Item): Boolean {
        if (!replaying || !item.isDeleted)
            return false
        val keep = replayLocalChange(item, localCollection!!.findByFilename(item.uid)) == ReplayLocalChange.SKIP_APPLY_AND_CACHE
        if (keep)
            Logger.log.info("Keeping a local change over a server deletion during this listing")
        return keep
    }

    override fun processItem(item: Item) {
        val local = localCollection!!.findByFilename(item.uid)

        if (replayLocalChange(item, local) == ReplayLocalChange.SKIP_APPLY) {
            Logger.log.info("Keeping a local change made during this listing for the next upload")
            return
        }
        if (replayKeepsStoredRevision(replaying, item.isDeleted, local?.eTag, item.etag)) {
            // A listing from the start fills in missing tasks; it doesn't rewrite ones already current.
            return
        }

        if (!item.isDeleted) {
            val inputReader = StringReader(String(item.content))

            val tasks = Task.tasksFromReader(inputReader)
            if (tasks.size == 0) {
                Logger.log.warning("Received VTODO without data, ignoring")
                return
            } else if (tasks.size > 1) {
                Logger.log.warning("Received multiple VCALs, using first one")
            }

            val task = tasks[0]
            processTask(item, task, local)
        } else {
            if (local != null) {
                Logger.log.info("Removing local task resource which has been deleted on the server")
                local.delete()
            } else {
                Logger.log.warning("Tried deleting a non-existent local task resource")
            }
        }
    }

    private fun processTask(item: Item, newData: Task, _localTask: LocalTask?): LocalTask {
        var localTask = _localTask
        // delete local Task, if it exists
        if (localTask != null) {
            Logger.log.info("Updating local task resource")
            localTask.eTag = item.etag
            localTask.update(newData)
            syncResult.stats.numUpdates++
        } else {
            Logger.log.info("Adding local task resource")
            localTask = LocalTask(localTaskList(), newData, item.uid, item.etag)
            localTask.add()
            syncResult.stats.numInserts++
        }

        return localTask
    }
}

/**
 * Whether a listing from the start leaves a local task alone because it already holds the listed
 * revision. Outside such a listing every item is applied as before.
 */
internal fun replayKeepsStoredRevision(replaying: Boolean, remoteDeleted: Boolean, localETag: String?, remoteETag: String?): Boolean =
    replaying && !remoteDeleted && localETag != null && localETag == remoteETag
