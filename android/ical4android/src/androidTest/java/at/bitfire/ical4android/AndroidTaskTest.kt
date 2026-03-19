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
import android.net.Uri
import androidx.test.filters.MediumTest
import at.bitfire.ical4android.impl.TestTask
import at.bitfire.ical4android.impl.TestTaskList
import net.fortuna.ical4j.model.Date
import net.fortuna.ical4j.model.DateList
import net.fortuna.ical4j.model.DateTime
import net.fortuna.ical4j.model.parameter.*
import net.fortuna.ical4j.model.parameter.TzId
import net.fortuna.ical4j.model.property.*
import org.dmfs.tasks.contract.TaskContract
import org.dmfs.tasks.contract.TaskContract.*
import org.dmfs.tasks.contract.TaskContract.Property.Category
import org.dmfs.tasks.contract.TaskContract.Property.Relation
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.time.ZoneId

class AndroidTaskTest(
        providerName: TaskProvider.ProviderName
): AbstractTasksTest(providerName) {

    private val tzVienna = DateUtils.ical4jTimeZone("Europe/Vienna")!!
    private val tzChicago = DateUtils.ical4jTimeZone("America/Chicago")!!
    private val tzDefault = DateUtils.ical4jTimeZone(ZoneId.systemDefault().id)!!

    private val testAccount = Account("AndroidTaskTest", TaskContract.LOCAL_ACCOUNT_TYPE)

    private lateinit var taskListUri: Uri
    private var taskList: TestTaskList? = null

    @Before
    override fun prepare() {
        super.prepare()

        taskList = TestTaskList.create(testAccount, provider)
        assertNotNull("Couldn't find/create test task list", taskList)

        taskListUri = ContentUris.withAppendedId(provider.taskListsUri(), taskList!!.id)
    }

    @After
    override fun shutdown() {
        taskList?.delete()
        super.shutdown()
    }


    // tests

    private fun buildTask(taskBuilder: Task.() -> Unit): ContentValues {
        val task = Task().apply {
            taskBuilder()
        }
        val uri = TestTask(taskList!!, task).add()
        provider.client.query(uri, null, null, null, null)!!.use {
            it.moveToNext()
            val values = ContentValues()
            DatabaseUtils.cursorRowToContentValues(it, values)
            return values
        }
    }

    @Test
    fun testBuildTask_Sequence() {
        buildTask() {
            sequence = 12345
        }.let { result ->
            assertEquals(12345, result.getAsInteger(Tasks.SYNC_VERSION))
        }
    }

    @Test
    fun testBuildTask_CreatedAt() {
        buildTask() {
            createdAt = 1593771404  // Fri Jul 03 10:16:44 2020 UTC
        }.let { result ->
            assertEquals(1593771404, result.getAsLong(Tasks.CREATED))
        }
    }

    @Test
    fun testBuildTask_LastModified() {
        buildTask() {
            lastModified = 1593771404
        }.let { result ->
            assertEquals(1593771404, result.getAsLong(Tasks.LAST_MODIFIED))
        }
    }

    @Test
    fun testBuildTask_Summary() {
        buildTask() {
            summary = "Sample Summary"
        }.let { result ->
            assertEquals("Sample Summary", result.get(Tasks.TITLE))
        }
    }

    @Test
    fun testBuildTask_Location() {
        buildTask() {
            location = "Sample Location"
        }.let { result ->
            assertEquals("Sample Location", result.get(Tasks.LOCATION))
        }
    }

    @Test
    fun testBuildTask_Geo() {
        buildTask() {
            geoPosition = Geo(47.913563.toBigDecimal(), 16.159601.toBigDecimal())
        }.let { result ->
            assertEquals("16.159601,47.913563", result.get(Tasks.GEO))
        }
    }

    @Test
    fun testBuildTask_Description() {
        buildTask() {
            description = "Sample Description"
        }.let { result ->
            assertEquals("Sample Description", result.get(Tasks.DESCRIPTION))
        }
    }

    @Test
    fun testBuildTask_Color() {
        buildTask() {
            color = 0x11223344
        }.let { result ->
            assertEquals(0x11223344, result.getAsInteger(Tasks.TASK_COLOR))
        }
    }

    @Test
    fun testBuildTask_Url() {
        buildTask() {
            url = "https://www.example.com"
        }.let { result ->
            assertEquals("https://www.example.com", result.getAsString(Tasks.URL))
        }
    }

    @Test
    fun testBuildTask_Organizer_MailTo() {
        buildTask() {
            organizer = Organizer("mailto:organizer@example.com")
        }.let { result ->
            assertEquals("organizer@example.com", result.getAsString(Tasks.ORGANIZER))
        }
    }

    @Test
    fun testBuildTask_Organizer_EmailParameter() {
        buildTask() {
            organizer = Organizer("uri:unknown").apply {
                parameters.add(Email("organizer@example.com"))
            }
        }.let { result ->
            assertEquals("organizer@example.com", result.getAsString(Tasks.ORGANIZER))
        }
    }

    @Test
    fun testBuildTask_Organizer_NotEmail() {
        buildTask() {
            organizer = Organizer("uri:unknown")
        }.let { result ->
            assertNull(result.get(Tasks.ORGANIZER))
        }
    }

    @Test
    fun testBuildTask_Priority() {
        buildTask() {
            priority = 2
        }.let { result ->
            assertEquals(2, result.getAsInteger(Tasks.PRIORITY))
        }
    }

    @Test
    fun testBuildTask_Classification_Public() {
        buildTask() {
            classification = Clazz.PUBLIC
        }.let { result ->
            assertEquals(Tasks.CLASSIFICATION_PUBLIC, result.getAsInteger(Tasks.CLASSIFICATION))
        }
    }

    @Test
    fun testBuildTask_Classification_Private() {
        buildTask() {
            classification = Clazz.PRIVATE
        }.let { result ->
            assertEquals(Tasks.CLASSIFICATION_PRIVATE, result.getAsInteger(Tasks.CLASSIFICATION))
        }
    }

    @Test
    fun testBuildTask_Classification_Confidential() {
        buildTask() {
            classification = Clazz.CONFIDENTIAL
        }.let { result ->
            assertEquals(Tasks.CLASSIFICATION_CONFIDENTIAL, result.getAsInteger(Tasks.CLASSIFICATION))
        }
    }

    @Test
    fun testBuildTask_Classification_Custom() {
        buildTask() {
            classification = Clazz("x-custom")
        }.let { result ->
            assertEquals(Tasks.CLASSIFICATION_PRIVATE, result.getAsInteger(Tasks.CLASSIFICATION))
        }
    }

    @Test
    fun testBuildTask_Classification_None() {
        buildTask() {
        }.let { result ->
            assertEquals(Tasks.CLASSIFICATION_DEFAULT /* null */, result.getAsInteger(Tasks.CLASSIFICATION))
        }
    }

    @Test
    fun testBuildTask_Status_NeedsAction() {
        buildTask() {
            status = Status.VTODO_NEEDS_ACTION
        }.let { result ->
            assertEquals(Tasks.STATUS_NEEDS_ACTION, result.getAsInteger(Tasks.STATUS))
        }
    }

    @Test
    fun testBuildTask_Status_Completed() {
        buildTask() {
            status = Status.VTODO_COMPLETED
        }.let { result ->
            assertEquals(Tasks.STATUS_COMPLETED, result.getAsInteger(Tasks.STATUS))
        }
    }

    @Test
    fun testBuildTask_Status_InProcess() {
        buildTask() {
            status = Status.VTODO_IN_PROCESS
        }.let { result ->
            assertEquals(Tasks.STATUS_IN_PROCESS, result.getAsInteger(Tasks.STATUS))
        }
    }

    @Test
    fun testBuildTask_Status_Cancelled() {
        buildTask() {
            status = Status.VTODO_CANCELLED
        }.let { result ->
            assertEquals(Tasks.STATUS_CANCELLED, result.getAsInteger(Tasks.STATUS))
        }
    }

    @Test
    fun testBuildTask_DtStart() {
        buildTask() {
            dtStart = DtStart("20200703T155722", tzVienna)
        }.let { result ->
            assertEquals(1593784642000L, result.getAsLong(Tasks.DTSTART))
            assertEquals(tzVienna.id, result.getAsString(Tasks.TZ))
            assertEquals(0, result.getAsInteger(Tasks.IS_ALLDAY))
        }
    }

    @Test
    fun testBuildTask_DtStart_AllDay() {
        buildTask() {
            dtStart = DtStart(Date("20200703"))
        }.let { result ->
            assertEquals(1593734400000L, result.getAsLong(Tasks.DTSTART))
            assertNull(result.get(Tasks.TZ))
            assertEquals(1, result.getAsInteger(Tasks.IS_ALLDAY))
        }
    }

    @Test
    fun testBuildTask_Due() {
        buildTask() {
            due = Due(DateTime("20200703T155722", tzVienna))
        }.let { result ->
            assertEquals(1593784642000L, result.getAsLong(Tasks.DUE))
            assertEquals(tzVienna.id, result.getAsString(Tasks.TZ))
            assertEquals(0, result.getAsInteger(Tasks.IS_ALLDAY))
        }
    }

    @Test
    fun testBuildTask_Due_AllDay() {
        buildTask() {
            due = Due(Date("20200703"))
        }.let { result ->
            assertEquals(1593734400000L, result.getAsLong(Tasks.DUE))
            assertNull(result.getAsString(Tasks.TZ))
            assertEquals(1, result.getAsInteger(Tasks.IS_ALLDAY))
        }
    }

    @Test
    fun testBuildTask_DtStart_NonAllDay_Due_AllDay() {
        buildTask() {
            dtStart = DtStart(DateTime("20200101T010203"))
            due = Due(Date("20200201"))
        }.let { result ->
            assertEquals(ZoneId.systemDefault().id, result.getAsString(Tasks.TZ))
            assertEquals(0, result.getAsInteger(Tasks.IS_ALLDAY))
        }
    }

    @Test
    fun testBuildTask_DtStart_AllDay_Due_NonAllDay() {
        buildTask() {
            dtStart = DtStart(Date("20200101"))
            due = Due(DateTime("20200201T010203"))
        }.let { result ->
            assertNull(result.getAsString(Tasks.TZ))
            assertEquals(1, result.getAsInteger(Tasks.IS_ALLDAY))
        }
    }

    @Test
    fun testBuildTask_DtStart_AllDay_Due_AllDay() {
        buildTask() {
            dtStart = DtStart(Date("20200101"))
            due = Due(Date("20200201"))
        }.let { result ->
            assertEquals(1, result.getAsInteger(Tasks.IS_ALLDAY))
        }
    }

    @Test
    fun testBuildTask_DtStart_FloatingTime() {
        buildTask() {
            dtStart = DtStart("20200703T010203")
        }.let { result ->
            assertEquals(DateTime("20200703T010203").time, result.getAsLong(Tasks.DTSTART))
            assertEquals(ZoneId.systemDefault().id, result.getAsString(Tasks.TZ))
            assertEquals(0, result.getAsInteger(Tasks.IS_ALLDAY))
        }
    }

    @Test
    fun testBuildTask_DtStart_Utc() {
        buildTask() {
            dtStart = DtStart(DateTime(1593730923000), true)
        }.let { result ->
            assertEquals(1593730923000L, result.getAsLong(Tasks.DTSTART))
            assertEquals("Etc/UTC", result.getAsString(Tasks.TZ))
            assertEquals(0, result.getAsInteger(Tasks.IS_ALLDAY))
        }
    }

    @Test
    fun testBuildTask_Due_FloatingTime() {
        buildTask() {
            due = Due("20200703T010203")
        }.let { result ->
            assertEquals(DateTime("20200703T010203").time, result.getAsLong(Tasks.DUE))
            assertEquals(ZoneId.systemDefault().id, result.getAsString(Tasks.TZ))
            assertEquals(0, result.getAsInteger(Tasks.IS_ALLDAY))
        }
    }

    @Test
    fun testBuildTask_Due_Utc() {
        buildTask() {
            due = Due(DateTime(1593730923000).apply { isUtc = true })
        }.let { result ->
            assertEquals(1593730923000L, result.getAsLong(Tasks.DUE))
            assertEquals("Etc/UTC", result.getAsString(Tasks.TZ))
            assertEquals(0, result.getAsInteger(Tasks.IS_ALLDAY))
        }
    }

    @Test
    fun testBuildTask_Duration() {
        buildTask() {
            dtStart = DtStart(DateTime())
            duration = Duration(null, "P1D")
        }.let { result ->
            assertEquals("P1D", result.get(Tasks.DURATION))
        }
    }

    @Test
    fun testBuildTask_CompletedAt() {
        val now = DateTime()
        buildTask() {
            completedAt = Completed(now)
        }.let { result ->
            // Note: iCalendar does not allow COMPLETED to be all-day [RFC 5545 3.8.2.1]
            assertEquals(0, result.getAsInteger(Tasks.COMPLETED_IS_ALLDAY))
            assertEquals(now.time, result.getAsLong(Tasks.COMPLETED))
        }
    }

    @Test
    fun testBuildTask_PercentComplete() {
        buildTask() {
            percentComplete = 50
        }.let { result ->
            assertEquals(50, result.getAsInteger(Tasks.PERCENT_COMPLETE))
        }
    }

    @Test
    fun testBuildTask_RRule() {
        // Note: OpenTasks only supports one RRULE per VTODO (iCalendar: multiple RRULEs are allowed, but SHOULD not be used)
        buildTask() {
            rRule = RRule("FREQ=DAILY;COUNT=10")
        }.let { result ->
            assertEquals("FREQ=DAILY;COUNT=10", result.getAsString(Tasks.RRULE))
        }
    }

    @Test
    fun testBuildTask_RDate() {
        buildTask() {
            dtStart = DtStart(DateTime("20200101T010203", tzVienna))
            rDates += RDate(DateList("20200102T020304", Value.DATE_TIME, tzVienna))
            rDates += RDate(DateList("20200102T020304", Value.DATE_TIME, tzChicago))
            rDates += RDate(DateList("20200103T020304Z", Value.DATE_TIME))
            rDates += RDate(DateList("20200103", Value.DATE))
        }.let { result ->
            assertEquals(tzVienna.id, result.getAsString(Tasks.TZ))
            assertEquals("20200102T020304,20200102T090304,20200103T020304Z,20200103T000000", result.getAsString(Tasks.RDATE))
        }
    }

    @Test
    fun testBuildTask_ExDate() {
        buildTask() {
            dtStart = DtStart(DateTime("20200101T010203", tzVienna))
            rRule = RRule("FREQ=DAILY;COUNT=10")
            exDates += ExDate(DateList("20200102T020304", Value.DATE_TIME, tzVienna))
            exDates += ExDate(DateList("20200102T020304", Value.DATE_TIME, tzChicago))
            exDates += ExDate(DateList("20200103T020304Z", Value.DATE_TIME))
            exDates += ExDate(DateList("20200103", Value.DATE))
        }.let { result ->
            assertEquals(tzVienna.id, result.getAsString(Tasks.TZ))
            assertEquals("20200102T020304,20200102T090304,20200103T020304Z,20200103T000000", result.getAsString(Tasks.EXDATE))
        }
    }

    @Test
    fun testBuildTask_Categories() {
        var hasCat1 = false
        var hasCat2 = false
        buildTask() {
            categories.addAll(arrayOf("Cat_1", "Cat 2"))
        }.let { result ->
            val id = result.getAsLong(Tasks._ID)
            val uri = taskList!!.tasksPropertiesSyncUri()
            provider.client.query(uri, arrayOf(Category.CATEGORY_NAME), "${Properties.MIMETYPE}=? AND ${PropertyColumns.TASK_ID}=?",
                    arrayOf(Category.CONTENT_ITEM_TYPE, id.toString()), null)!!.use { cursor ->
                while (cursor.moveToNext())
                    when (cursor.getString(0)) {
                        "Cat_1" -> hasCat1 = true
                        "Cat 2" -> hasCat2 = true
                    }
            }
        }
        assertTrue(hasCat1)
        assertTrue(hasCat2)
    }

    private fun firstProperty(taskId: Long, mimeType: String): ContentValues? {
        val uri = taskList!!.tasksPropertiesSyncUri()
        provider.client.query(uri, null, "${Properties.MIMETYPE}=? AND ${PropertyColumns.TASK_ID}=?",
                arrayOf(mimeType, taskId.toString()), null)!!.use { cursor ->
            if (cursor.moveToNext()) {
                val result = ContentValues(cursor.count)
                DatabaseUtils.cursorRowToContentValues(cursor, result)
                return result
            }
        }
        return null
    }

    @Test
    fun testBuildTask_RelatedTo_Parent() {
        buildTask() {
            relatedTo.add(RelatedTo("Parent-Task").apply {
                parameters.add(RelType.PARENT)
            })
        }.let { result ->
            val taskId = result.getAsLong(Tasks._ID)
            val relation = firstProperty(taskId, Relation.CONTENT_ITEM_TYPE)!!
            assertEquals("Parent-Task", relation.getAsString(Relation.RELATED_UID))
            assertNull(relation.get(Relation.RELATED_ID))   // other task not in DB (yet)
            assertEquals(Relation.RELTYPE_PARENT, relation.getAsInteger(Relation.RELATED_TYPE))
        }
    }

    @Test
    fun testBuildTask_RelatedTo_Child() {
        buildTask() {
            relatedTo.add(RelatedTo("Child-Task").apply {
                parameters.add(RelType.CHILD)
            })
        }.let { result ->
            val taskId = result.getAsLong(Tasks._ID)
            val relation = firstProperty(taskId, Relation.CONTENT_ITEM_TYPE)!!
            assertEquals("Child-Task", relation.getAsString(Relation.RELATED_UID))
            assertNull(relation.get(Relation.RELATED_ID))   // other task not in DB (yet)
            assertEquals(Relation.RELTYPE_CHILD, relation.getAsInteger(Relation.RELATED_TYPE))
        }
    }

    @Test
    fun testBuildTask_RelatedTo_Sibling() {
        buildTask() {
            relatedTo.add(RelatedTo("Sibling-Task").apply {
                parameters.add(RelType.SIBLING)
            })
        }.let { result ->
            val taskId = result.getAsLong(Tasks._ID)
            val relation = firstProperty(taskId, Relation.CONTENT_ITEM_TYPE)!!
            assertEquals("Sibling-Task", relation.getAsString(Relation.RELATED_UID))
            assertNull(relation.get(Relation.RELATED_ID))   // other task not in DB (yet)
            assertEquals(Relation.RELTYPE_SIBLING, relation.getAsInteger(Relation.RELATED_TYPE))
        }
    }

    @Test
    fun testBuildTask_RelatedTo_Custom() {
        buildTask() {
            relatedTo.add(RelatedTo("Sibling-Task").apply {
                parameters.add(RelType("custom-relationship"))
            })
        }.let { result ->
            val taskId = result.getAsLong(Tasks._ID)
            val relation = firstProperty(taskId, Relation.CONTENT_ITEM_TYPE)!!
            assertEquals("Sibling-Task", relation.getAsString(Relation.RELATED_UID))
            assertNull(relation.get(Relation.RELATED_ID))   // other task not in DB (yet)
            assertEquals(Relation.RELTYPE_PARENT, relation.getAsInteger(Relation.RELATED_TYPE))
        }
    }

    @Test
    fun testBuildTask_RelatedTo_Default() {
        buildTask() {
            relatedTo.add(RelatedTo("Parent-Task"))
        }.let { result ->
            val taskId = result.getAsLong(Tasks._ID)
            val relation = firstProperty(taskId, Relation.CONTENT_ITEM_TYPE)!!
            assertEquals("Parent-Task", relation.getAsString(Relation.RELATED_UID))
            assertNull(relation.get(Relation.RELATED_ID))   // other task not in DB (yet)
            assertEquals(Relation.RELTYPE_PARENT, relation.getAsInteger(Relation.RELATED_TYPE))
        }
    }


    @Test
    fun testBuildTask_UnknownProperty() {
        val xProperty = XProperty("X-TEST-PROPERTY", "test-value").apply {
            parameters.add(TzId(tzVienna.id))
            parameters.add(XParameter("X-TEST-PARAMETER", "12345"))
        }
        buildTask() {
            unknownProperties.add(xProperty)
        }.let { result ->
            val taskId = result.getAsLong(Tasks._ID)
            val unknownProperty = firstProperty(taskId, UnknownProperty.CONTENT_ITEM_TYPE)!!
            assertEquals(xProperty, UnknownProperty.fromJsonString(unknownProperty.getAsString(AndroidTask.UNKNOWN_PROPERTY_DATA)))
        }
    }


    @MediumTest
    @Test
    fun testAddTask() {
        // build and write event to calendar provider
        val task = Task()
        task.uid = "sample1@testAddEvent"
        task.summary = "Sample event"
        task.description = "Sample event with date/time"
        task.location = "Sample location"
        task.dtStart = DtStart("20150501T120000", tzVienna)
        task.due = Due("20150501T140000", tzVienna)
        task.organizer = Organizer("mailto:organizer@example.com")
        assertFalse(task.isAllDay())

        // extended properties
        task.categories.addAll(arrayOf("Cat1", "Cat2"))

        val sibling = RelatedTo("most-fields2@example.com")
        sibling.parameters.add(RelType.SIBLING)
        task.relatedTo.add(sibling)

        task.unknownProperties += XProperty("X-UNKNOWN-PROP", "Unknown Value")

        // add to task list
        val uri = TestTask(taskList!!, task).add()
        assertNotNull("Couldn't add task", uri)

        // read and parse event from calendar provider
        val testTask = taskList!!.findById(ContentUris.parseId(uri))
        try {
            assertNotNull("Inserted task is not here", testTask)
            val task2 = testTask.task
            assertNotNull("Inserted task is empty", task2)

            // compare with original event
            assertEquals(task.summary, task2!!.summary)
            assertEquals(task.description, task2.description)
            assertEquals(task.location, task2.location)
            assertEquals(task.dtStart, task2.dtStart)

            assertEquals(task.categories, task2.categories)
            assertEquals(task.relatedTo, task2.relatedTo)
            assertEquals(task.unknownProperties, task2.unknownProperties)
        } finally {
            testTask.delete()
        }
    }

    @MediumTest
    @Test(expected = CalendarStorageException::class)
    fun testAddTaskWithInvalidDue() {
        val task = Task()
        task.uid = "invalidDUE@ical4android.tests"
        task.summary = "Task with invalid DUE"
        task.dtStart = DtStart(Date("20150102"))

        task.due = Due(Date("20150101"))
        TestTask(taskList!!, task).add()
    }

    @MediumTest
    @Test
    fun testUpdateTask() {
        // add test event without reminder
        val task = Task()
        task.uid = "sample1@testAddEvent"
        task.summary = "Sample event"
        task.description = "Sample event with date/time"
        task.location = "Sample location"
        task.dtStart = DtStart("20150501T120000", tzVienna)
        assertFalse(task.isAllDay())
        val uri = TestTask(taskList!!, task).add()
        assertNotNull(uri)

        val testTask = taskList!!.findById(ContentUris.parseId(uri))
        try {
            // update test event in calendar
            val task2 = testTask.task!!
            task2.summary = "Updated event"                     // change value
            task.location = null                                // remove value
            task2.duration = Duration(java.time.Duration.ofMinutes(10))     // add value
            testTask.update(task2)

            // read again and verify result
            val updatedTask = taskList!!.findById(ContentUris.parseId(uri)).task!!
            assertEquals(task2.summary, updatedTask.summary)
            assertEquals(task2.location, updatedTask.location)
            assertEquals(task2.dtStart, updatedTask.dtStart)
            assertEquals(task2.duration!!.value, updatedTask.duration!!.value)
        } finally {
            testTask.delete()
        }
    }

    @MediumTest
    @Test
    fun testBuildAllDayTask() {
        // add all-day event to calendar provider
        val task = Task()
        task.summary = "All-day task"
        task.description = "All-day task for testing"
        task.location = "Sample location testBuildAllDayTask"
        task.dtStart = DtStart(Date("20150501"))
        task.due = Due(Date("20150502"))
        assertTrue(task.isAllDay())
        val uri = TestTask(taskList!!, task).add()
        assertNotNull(uri)

        val testTask = taskList!!.findById(ContentUris.parseId(uri))
        try {
            // read again and verify result
            val task2 = testTask.task!!
            assertEquals(task.summary, task2.summary)
            assertEquals(task.description, task2.description)
            assertEquals(task.location, task2.location)
            assertEquals(task.dtStart!!.date, task2.dtStart!!.date)
            assertEquals(task.due!!.date, task2.due!!.date)
            assertTrue(task2.isAllDay())
        } finally {
            testTask.delete()
        }
    }

    @Test
    fun testGetTimeZone() {
        // no date/time
        var t = TestTask(taskList!!, Task())
        assertEquals(tzDefault, t.getTimeZone())

        // dtstart with date (no time)
        t = TestTask(taskList!!, Task())
        t.task!!.dtStart = DtStart("20150101")
        assertEquals(tzDefault, t.getTimeZone())

        // dtstart with time
        t = TestTask(taskList!!, Task())
        t.task!!.dtStart = (DtStart("20150101", tzVienna))
        assertEquals(tzVienna, t.getTimeZone())
    }

}