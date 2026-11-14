/*
 * Copyright © 2013 – 2015 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.resource

import android.accounts.Account
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.RemoteException
import at.bitfire.ical4android.AndroidTaskList
import at.bitfire.ical4android.AndroidTaskListFactory
import at.bitfire.ical4android.CalendarStorageException
import at.bitfire.ical4android.TaskProvider
import at.bitfire.ical4android.TaskProvider.ProviderName
import io.silentsuite.sync.CachedCollection
import org.dmfs.tasks.contract.TaskContract.TaskLists
import org.dmfs.tasks.contract.TaskContract.Tasks

class LocalTaskList private constructor(
        account: Account,
        provider: TaskProvider,
        id: Long
): AndroidTaskList<LocalTask>(account, provider, LocalTask.Factory, id), LocalCollection<LocalTask> {
    companion object {
        val defaultColor = -0x743cb6     // light green 500

        /** Holds [POPULATED] once one complete listing has filled this task list row. */
        private const val COLUMN_POPULATED = TaskLists.SYNC1

        /**
         * A task list row created later (the tasks app was reinstalled or switched, or its data was
         * cleared) lacks this, so it is listed from the start even though the collection's sync
         * token survived in the app's own cache.
         */
        internal const val POPULATED = "silentsuite.tasks.populated.v1"

        fun tasksProviderAvailable(context: Context, provider: ProviderName): Boolean =
                context.packageManager.resolveContentProvider(provider.authority, 0) != null

        fun create(account: Account, provider: TaskProvider, cachedCollection: CachedCollection): Uri {
            val values = valuesFromCachedCollection(cachedCollection, true)
            values.put(TaskLists.OWNER, account.name)
            values.put(TaskLists.SYNC_ENABLED, 1)
            values.put(TaskLists.VISIBLE, 1)
            return create(account, provider, values)
        }

        fun findByName(account: Account, provider: TaskProvider, factory: Factory, name: String): LocalTaskList?
                = AndroidTaskList.find(account, provider, factory, TaskLists._SYNC_ID + "==?", arrayOf(name)).firstOrNull()


        private fun valuesFromCachedCollection(cachedCollection: CachedCollection, withColor: Boolean): ContentValues {
            val col = cachedCollection.col
            val meta = cachedCollection.meta
            val values = ContentValues(3)
            values.put(TaskLists._SYNC_ID, col.uid)
            values.put(TaskLists.LIST_NAME, meta.name)

            if (withColor)
                values.put(TaskLists.LIST_COLOR, LocalCalendar.parseColor(meta.color))

            return values
        }
    }

    override val url: String?
        get() = syncId

    fun update(cachedCollection: CachedCollection, updateColor: Boolean) =
            update(valuesFromCachedCollection(cachedCollection, updateColor))

    /** Whether one complete listing has filled this task list row. */
    fun populated(): Boolean =
        provider.client.query(taskListSyncUri(), arrayOf(COLUMN_POPULATED), null, null, null)?.use { cursor ->
            cursor.moveToNext() && cursor.getString(0) == POPULATED
        } ?: false

    fun markPopulated() {
        update(ContentValues(1).apply { put(COLUMN_POPULATED, POPULATED) })
    }

    /** Whether the task [id] has a local change or deletion that isn't uploaded yet. */
    fun hasPendingChange(id: Long): Boolean =
        provider.client.query(tasksSyncUri(), arrayOf(Tasks._ID),
                "${Tasks._ID}=? AND (${Tasks._DIRTY}!=0 OR ${Tasks._DELETED}!=0)", arrayOf(id.toString()), null)?.use { cursor ->
            cursor.count > 0
        } ?: false

    override fun findDeleted() = queryTasks("${Tasks._DELETED}!=0", null)

    override fun findDirty(limit: Int?): List<LocalTask> {
        val sortOrder = if (limit != null) "${Tasks._ID} ASC LIMIT $limit" else null
        val tasks = queryTasks("${Tasks._DIRTY}!=0 AND ${Tasks._DELETED}==0", null, sortOrder)
        for (localTask in tasks) {
            val task = requireNotNull(localTask.task)
            val sequence = task.sequence
            if (sequence == null)    // sequence has not been assigned yet (i.e. this task was just locally created)
                task.sequence = 0
            else
                task.sequence = sequence + 1
        }
        return tasks
    }

    override fun findAll(): List<LocalTask>
            = queryTasks(null, null)

    override fun findWithoutFileName(): List<LocalTask>
        = queryTasks(Tasks._SYNC_ID + " IS NULL", null)

    override fun findByUid(uid: String): LocalTask?
        = queryTasks(LocalTask.COLUMN_UID + " =? ", arrayOf(uid)).firstOrNull()

    override fun findByFilename(filename: String): LocalTask?
            = queryTasks(Tasks._SYNC_ID + " =? ", arrayOf(filename)).firstOrNull()

    override fun count(): Long {
        try {
            val cursor = provider.client.query(
                    TaskProvider.syncAdapterUri(provider.tasksUri(), account), null,
                    Tasks.LIST_ID + "=?", arrayOf(id.toString()), null)
            try {
                return cursor?.count?.toLong()!!
            } finally {
                cursor?.close()
            }
        } catch (e: RemoteException) {
            throw CalendarStorageException("Couldn't query calendar events", e)
        }

    }

    object Factory: AndroidTaskListFactory<LocalTaskList> {

        override fun newInstance(account: Account, provider: TaskProvider, id: Long) =
                LocalTaskList(account, provider, id)

    }
}
