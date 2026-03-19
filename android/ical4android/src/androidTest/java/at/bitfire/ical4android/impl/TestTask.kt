/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android.impl

import android.content.ContentValues

import at.bitfire.ical4android.AndroidTask
import at.bitfire.ical4android.AndroidTaskFactory
import at.bitfire.ical4android.AndroidTaskList
import at.bitfire.ical4android.Task

class TestTask: AndroidTask {

    constructor(taskList: AndroidTaskList<AndroidTask>, values: ContentValues)
        : super(taskList, values)

    constructor(taskList: TestTaskList, task: Task)
        : super(taskList, task)

    object Factory: AndroidTaskFactory<TestTask> {
        override fun fromProvider(taskList: AndroidTaskList<AndroidTask>, values: ContentValues) =
                TestTask(taskList, values)
    }

}
