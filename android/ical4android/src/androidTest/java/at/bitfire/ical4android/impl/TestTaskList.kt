/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android.impl

import android.accounts.Account
import android.content.ContentUris
import android.content.ContentValues
import at.bitfire.ical4android.AndroidTaskList
import at.bitfire.ical4android.AndroidTaskListFactory
import at.bitfire.ical4android.TaskProvider
import org.dmfs.tasks.contract.TaskContract

class TestTaskList(
        account: Account,
        provider: TaskProvider,
        id: Long
): AndroidTaskList<TestTask>(account, provider, TestTask.Factory, id) {

    companion object {

        fun create(account: Account, provider: TaskProvider): TestTaskList {
            val values = ContentValues(4)
            values.put(TaskContract.TaskListColumns.LIST_NAME, "Test Task List")
            values.put(TaskContract.TaskListColumns.LIST_COLOR, 0xffff0000)
            values.put(TaskContract.TaskListColumns.SYNC_ENABLED, 1)
            values.put(TaskContract.TaskListColumns.VISIBLE, 1)
            val uri = AndroidTaskList.create(account, provider, values)

            return TestTaskList(account, provider, ContentUris.parseId(uri))
        }

    }


    object Factory: AndroidTaskListFactory<TestTaskList> {
        override fun newInstance(account: Account, provider: TaskProvider, id: Long) =
                TestTaskList(account, provider, id)
    }

}
