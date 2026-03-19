/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android

import android.content.ContentProviderClient
import android.content.ContentValues
import android.database.Cursor
import android.database.DatabaseUtils
import android.os.Build
import java.lang.reflect.Modifier
import java.util.*

object MiscUtils {

    /**
     * Generates useful toString info (fields and values) from [obj] by reflection.
     *
     * @param obj   object to inspect
     * @return      string containing properties and non-static declared fields
     */
    fun reflectionToString(obj: Any): String {
        val s = LinkedList<String>()
        var clazz: Class<in Any>? = obj.javaClass
        while (clazz != null) {
            for (prop in clazz.declaredFields.filterNot { Modifier.isStatic(it.modifiers) }) {
                prop.isAccessible = true
                s += "${prop.name}=" + prop.get(obj)?.toString()?.trim()
            }
            clazz = clazz.superclass
        }
        return "${obj.javaClass.simpleName}=[${s.joinToString(", ")}]"
    }

    /**
     * Removes empty [String] values from [values].
     *
     * @param values set of values to be modified
     * @return the modified object (which is the same object as passed in; for chaining)
     */
    fun removeEmptyStrings(values: ContentValues): ContentValues {
        val it = values.keySet().iterator()
        while (it.hasNext()) {
            val obj = values[it.next()]
            if (obj is String && obj.isEmpty())
                it.remove()
        }
        return values
    }


    object ContentProviderClientHelper {

        fun ContentProviderClient.closeCompat() {
            @Suppress("DEPRECATION")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N)
                close()
            else
                release()
        }

    }


    object CursorHelper {

        /**
         * Returns the entire contents of the current row as a [ContentValues] object.
         *
         * @param  removeEmptyRows  whether rows with empty values should be removed
         * @return entire contents of the current row
         */
        fun Cursor.toValues(removeEmptyRows: Boolean = false): ContentValues {
            val values = ContentValues(columnCount)
            DatabaseUtils.cursorRowToContentValues(this, values)

            if (removeEmptyRows)
                removeEmptyStrings(values)

            return values
        }

    }

}