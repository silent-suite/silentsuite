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
import android.database.DatabaseUtils
import at.bitfire.ical4android.impl.TestTask
import at.bitfire.ical4android.impl.TestTaskList
import net.fortuna.ical4j.model.property.RelatedTo
import org.dmfs.tasks.contract.TaskContract
import org.dmfs.tasks.contract.TaskContract.Properties
import org.dmfs.tasks.contract.TaskContract.Property.Relation
import org.dmfs.tasks.contract.TaskContract.Tasks
import org.junit.Assert.*
import org.junit.Test

class AndroidTaskListTest(providerName: TaskProvider.ProviderName):
        AbstractTasksTest(providerName) {

    private val testAccount = Account("AndroidTaskListTest", TaskContract.LOCAL_ACCOUNT_TYPE)


    private fun createTaskList(): TestTaskList {
        val info = ContentValues()
        info.put(TaskContract.TaskLists.LIST_NAME, "Test Task List")
        info.put(TaskContract.TaskLists.LIST_COLOR, 0xffff0000)
        info.put(TaskContract.TaskLists.OWNER, "test@example.com")
        info.put(TaskContract.TaskLists.SYNC_ENABLED, 1)
        info.put(TaskContract.TaskLists.VISIBLE, 1)

        val uri = AndroidTaskList.create(testAccount, provider, info)
        assertNotNull(uri)

        return AndroidTaskList.findByID(testAccount, provider, TestTaskList.Factory, ContentUris.parseId(uri))
    }


    @Test
    fun testManageTaskLists() {
        val taskList = createTaskList()

        try {
            // sync URIs
            assertEquals("true", taskList.taskListSyncUri().getQueryParameter(TaskContract.CALLER_IS_SYNCADAPTER))
            assertEquals(testAccount.type, taskList.taskListSyncUri().getQueryParameter(TaskContract.ACCOUNT_TYPE))
            assertEquals(testAccount.name, taskList.taskListSyncUri().getQueryParameter(TaskContract.ACCOUNT_NAME))

            assertEquals("true", taskList.tasksSyncUri().getQueryParameter(TaskContract.CALLER_IS_SYNCADAPTER))
            assertEquals(testAccount.type, taskList.tasksSyncUri().getQueryParameter(TaskContract.ACCOUNT_TYPE))
            assertEquals(testAccount.name, taskList.tasksSyncUri().getQueryParameter(TaskContract.ACCOUNT_NAME))
        } finally {
            // delete task list
            assertEquals(1, taskList.delete())
        }
    }

    @Test
    fun testTouchRelations() {
        val taskList = createTaskList()
        try {
            val parent = Task()
            parent.uid = "parent"
            parent.summary = "Parent task"

            val child = Task()
            child.uid = "child"
            child.summary = "Child task"
            child.relatedTo.add(RelatedTo(parent.uid))

            // insert child before parent
            val childContentUri = TestTask(taskList, child).add()
            val childId = ContentUris.parseId(childContentUri)
            val parentContentUri = TestTask(taskList, parent).add()
            val parentId = ContentUris.parseId(parentContentUri)

            // OpenTasks should provide the correct relation…
            taskList.provider.client.query(taskList.tasksPropertiesSyncUri(), null,
                    "${Properties.TASK_ID}=?", arrayOf(childId.toString()),
                    null, null)!!.use { cursor ->
                assertEquals(1, cursor.count)
                cursor.moveToNext()

                val row = ContentValues()
                DatabaseUtils.cursorRowToContentValues(cursor, row)

                assertEquals(Relation.CONTENT_ITEM_TYPE, row.getAsString(Properties.MIMETYPE))
                assertEquals(parentId, row.getAsLong(Relation.RELATED_ID))
                assertEquals(parent.uid, row.getAsString(Relation.RELATED_UID))
                assertEquals(Relation.RELTYPE_PARENT, row.getAsInteger(Relation.RELATED_TYPE))
            }
            // … BUT the parent_id is not updated (https://github.com/dmfs/opentasks/issues/877)
            taskList.provider.client.query(childContentUri, arrayOf(Tasks.PARENT_ID),
                    null, null, null)!!.use { cursor ->
                assertTrue(cursor.moveToNext())
                assertTrue(cursor.isNull(0))
            }

            // touch the relations to update parent_id values
            taskList.touchRelations()

            // now parent_id should bet set
            taskList.provider.client.query(childContentUri, arrayOf(Tasks.PARENT_ID),
                    null, null, null)!!.use { cursor ->
                assertTrue(cursor.moveToNext())
                assertEquals(parentId, cursor.getLong(0))
            }
        } finally {
            taskList.delete()
        }
    }

}
