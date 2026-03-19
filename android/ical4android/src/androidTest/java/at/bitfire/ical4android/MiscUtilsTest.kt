/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android

import android.content.ContentValues
import android.database.MatrixCursor
import androidx.test.filters.SmallTest
import at.bitfire.ical4android.MiscUtils.CursorHelper.toValues
import org.junit.Assert.*
import org.junit.Test

class MiscUtilsTest {

    private val tzVienna = DateUtils.ical4jTimeZone("Europe/Vienna")


    @Test
    @SmallTest
    fun testReflectionToString() {
        val s = MiscUtils.reflectionToString(TestClass())
        assertTrue(s.startsWith("TestClass=["))
        assertTrue(s.contains("s=test"))
        assertTrue(s.contains("i=2"))
    }

    @Test
    @SmallTest
    fun testRemoveEmptyStrings() {
        val values = ContentValues(2)
        values.put("key1", "value")
        values.put("key2", 1L)
        values.put("key3", "")
        MiscUtils.removeEmptyStrings(values)
        assertEquals("value", values.getAsString("key1"))
        assertEquals(1L, values.getAsLong("key2").toLong())
        assertNull(values.get("key3"))
    }


    @Test
    @SmallTest
    fun testCursorToValues() {
        val columns = arrayOf("col1", "col2")
        val c = MatrixCursor(columns)
        c.addRow(arrayOf("row1_val1", "row1_val2"))
        c.moveToFirst()
        val values = c.toValues()
        assertEquals("row1_val1", values.getAsString("col1"))
        assertEquals("row1_val2", values.getAsString("col2"))
    }


    @Suppress("unused")
    private class TestClass {
        private val s = "test"
        val i = 2
    }

}
