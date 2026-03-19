/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android

import android.accounts.Account
import android.content.ContentUris
import android.content.ContentValues
import android.net.Uri
import at.bitfire.ical4android.MiscUtils.CursorHelper.toValues
import org.dmfs.tasks.contract.TaskContract
import org.dmfs.tasks.contract.TaskContract.Property.Relation
import org.dmfs.tasks.contract.TaskContract.TaskLists
import org.dmfs.tasks.contract.TaskContract.Tasks
import java.io.FileNotFoundException
import java.util.*


/**
 * Represents a locally stored task list, containing AndroidTasks (whose data objects are Tasks).
 * Communicates with third-party content providers to store the tasks.
 * Currently, only the OpenTasks tasks provider (org.dmfs.provider.tasks) is supported.
 */
abstract class AndroidTaskList<out T: AndroidTask>(
        val account: Account,
        val provider: TaskProvider,
        val taskFactory: AndroidTaskFactory<T>,
        val id: Long
) {

	companion object {

        fun create(account: Account, provider: TaskProvider, info: ContentValues): Uri {
            info.put(TaskContract.ACCOUNT_NAME, account.name)
            info.put(TaskContract.ACCOUNT_TYPE, account.type)
            info.put(TaskLists.ACCESS_LEVEL, 0)

            Ical4Android.log.info("Creating local task list: $info")
            return provider.client.insert(TaskProvider.syncAdapterUri(provider.taskListsUri(), account), info) ?:
                    throw CalendarStorageException("Couldn't create task list (empty result from provider)")
        }

        fun<T: AndroidTaskList<AndroidTask>> findByID(account: Account, provider: TaskProvider, factory: AndroidTaskListFactory<T>, id: Long): T {
            provider.client.query(TaskProvider.syncAdapterUri(ContentUris.withAppendedId(provider.taskListsUri(), id), account), null, null, null, null)?.use { cursor ->
                if (cursor.moveToNext()) {
                    val taskList = factory.newInstance(account, provider, id)
                    taskList.populate(cursor.toValues())
                    return taskList
                }
            }
            throw FileNotFoundException()
        }

        fun<T: AndroidTaskList<AndroidTask>> find(account: Account, provider: TaskProvider, factory: AndroidTaskListFactory<T>, where: String?, whereArgs: Array<String>?): List<T> {
            val taskLists = LinkedList<T>()
            provider.client.query(TaskProvider.syncAdapterUri(provider.taskListsUri(), account), null, where, whereArgs, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val values = cursor.toValues()
                    val taskList = factory.newInstance(account, provider, values.getAsLong(TaskLists._ID))
                    taskList.populate(values)
                    taskLists += taskList
                }
            }
            return taskLists
        }

    }

    var syncId: String? = null
    var name: String? = null
    var color: Int? = null
    var isSynced = false
    var isVisible = false


    protected fun populate(values: ContentValues) {
        syncId = values.getAsString(TaskLists._SYNC_ID)
        name = values.getAsString(TaskLists.LIST_NAME)
        color = values.getAsInteger(TaskLists.LIST_COLOR)
        values.getAsInteger(TaskLists.SYNC_ENABLED)?.let { isSynced = it != 0 }
        values.getAsInteger(TaskLists.VISIBLE)?.let { isVisible = it != 0 }
    }

    fun update(info: ContentValues) = provider.client.update(taskListSyncUri(), info, null, null)
    fun delete() = provider.client.delete(taskListSyncUri(), null, null)

    /**
     * When tasks are added or updated, they may refer to related tasks by UID ([Relation.RELATED_UID]).
     * However, those related tasks may not be available (for instance, because they have not been
     * synchronized yet), so that the tasks provider can't establish the actual relation (= set
     * [Relation.TASK_ID]) in the database.
     *
     * As soon as such a related task is added, OpenTasks updates the [Relation.RELATED_ID],
     * but it does *not* update [Tasks.PARENT_ID] of the parent task:
     * https://github.com/dmfs/opentasks/issues/877
     *
     * This method shall be called after all tasks have been synchronized. It touches
     *
     *   - all [Relation] rows
     *   - with [Relation.RELATED_ID] (→ related task is already synchronized)
     *   - of tasks without [Tasks.PARENT_ID] (→ only touch relevant rows)
     *
     * so that missing [Tasks.PARENT_ID] fields are updated.
     *
     * @return number of touched [Relation] rows
    */
    fun touchRelations(): Int {
        Ical4Android.log.fine("Touching relations to set parent_id")
        val batchOperation = BatchOperation(provider.client)
        provider.client.query(tasksSyncUri(true), null,
                "${Tasks.LIST_ID}=? AND ${Tasks.PARENT_ID} IS NULL AND ${Relation.MIMETYPE}=? AND ${Relation.RELATED_ID} IS NOT NULL",
                arrayOf(id.toString(), Relation.CONTENT_ITEM_TYPE),
                null, null)?.use { cursor ->
            while (cursor.moveToNext()) {
                val values = cursor.toValues()
                val id = values.getAsLong(Relation.PROPERTY_ID)
                val propertyContentUri = ContentUris.withAppendedId(tasksPropertiesSyncUri(), id)
                batchOperation.enqueue(BatchOperation.CpoBuilder
                        .newUpdate(propertyContentUri)
                        .withValue(Relation.RELATED_ID, values.getAsLong(Relation.RELATED_ID))
                )
            }
        }
        return batchOperation.commit()
    }


    /**
     * Queries tasks from this task list. Adds a WHERE clause that restricts the
     * query to [Tasks.LIST_ID] = [id].
     *
     * @param _where selection
     * @param _whereArgs arguments for selection
     *
     * @return events from this task list which match the selection
     */
    fun queryTasks(_where: String? = null, _whereArgs: Array<String>? = null, sortOrder: String? = null): List<T> {
        val where = "(${_where ?: "1"}) AND ${Tasks.LIST_ID}=?"
        val whereArgs = (_whereArgs ?: arrayOf()) + id.toString()

        val tasks = LinkedList<T>()
        provider.client.query(
                tasksSyncUri(),
                null,
                where, whereArgs, sortOrder)?.use { cursor ->
            while (cursor.moveToNext())
                tasks += taskFactory.fromProvider(this, cursor.toValues())
        }
        return tasks
    }

    fun findById(id: Long) = queryTasks("${Tasks._ID}=?", arrayOf(id.toString())).firstOrNull()
            ?: throw FileNotFoundException()


    fun taskListSyncUri() = TaskProvider.syncAdapterUri(ContentUris.withAppendedId(provider.taskListsUri(), id), account)
    fun tasksSyncUri(loadProperties: Boolean = false): Uri {
        val uri = TaskProvider.syncAdapterUri(provider.tasksUri(), account)
        return if (loadProperties)
            uri     .buildUpon()
                    .appendQueryParameter(TaskContract.LOAD_PROPERTIES, "1")
                    .build()
        else
            uri
    }
    fun tasksPropertiesSyncUri() = TaskProvider.syncAdapterUri(provider.propertiesUri(), account)

}
