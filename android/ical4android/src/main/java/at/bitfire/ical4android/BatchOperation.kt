/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android

import android.content.*
import android.net.Uri
import android.os.RemoteException
import android.os.TransactionTooLargeException
import java.util.*
import java.util.logging.Level

class BatchOperation(
        private val providerClient: ContentProviderClient
) {

    private val queue = LinkedList<CpoBuilder>()
    private var results = arrayOfNulls<ContentProviderResult?>(0)


    fun nextBackrefIdx() = queue.size

    fun enqueue(operation: CpoBuilder): BatchOperation {
        queue.add(operation)
        return this
    }

    fun commit(): Int {
        var affected = 0
        if (!queue.isEmpty())
            try {
                if (Ical4Android.log.isLoggable(Level.FINE)) {
                    Ical4Android.log.log(Level.FINE, "Committing ${queue.size} operations:")
                    for ((idx, op) in queue.withIndex())
                        Ical4Android.log.log(Level.FINE, "#$idx: ${op.build()}")
                }

                results = arrayOfNulls(queue.size)
                runBatch(0, queue.size)

                for (result in results.filterNotNull())
                    when {
                        result.count != null -> affected += result.count ?: 0
                        result.uri != null   -> affected += 1
                    }
                Ical4Android.log.fine("… $affected record(s) affected")

            } catch(e: Exception) {
                throw CalendarStorageException("Couldn't apply batch operation", e)
            }

        queue.clear()
        return affected
    }

    fun getResult(idx: Int) = results[idx]


    /**
     * Runs a subset of the operations in [queue] using [providerClient] in a transaction.
     * Catches [TransactionTooLargeException] and splits the operations accordingly.
     * @param start index of first operation which will be run (inclusive)
     * @param end   index of last operation which will be run (exclusive!)
     * @throws RemoteException on calendar provider errors
     * @throws OperationApplicationException when the batch can't be processed
     * @throws CalendarStorageException if the transaction is too large
     */
    private fun runBatch(start: Int, end: Int) {
        if (end == start)
            return     // nothing to do

        try {
            val ops = toCPO(start, end)
            Ical4Android.log.fine("Running ${ops.size} operations ($start .. ${end-1})")
            val partResults = providerClient.applyBatch(ops)

            val n = end - start
            if (partResults.size != n)
                Ical4Android.log.warning("Batch operation returned only ${partResults.size} instead of $n results")

            System.arraycopy(partResults, 0, results, start, partResults.size)
        } catch(e: TransactionTooLargeException) {
            if (end <= start + 1)
                // only one operation, can't be split
                throw CalendarStorageException("Can't transfer data to content provider (data row too large)")

            Ical4Android.log.warning("Transaction too large, splitting (losing atomicity)")
            val mid = start + (end - start)/2
            runBatch(start, mid)
            runBatch(mid, end)
        }
    }

    private fun toCPO(start: Int, end: Int): ArrayList<ContentProviderOperation> {
        val cpo = ArrayList<ContentProviderOperation>(end - start)

        for (cpoBuilder in queue.subList(start, end)) {
            for ((backrefKey, backrefIdx) in cpoBuilder.valueBackrefs) {
                if (backrefIdx < start) {
                    // back reference is outside of the current batch, get result from previous execution ...
                    val resultUri = results[backrefIdx]?.uri ?: throw CalendarStorageException("Referenced operation didn't produce a valid result")
                    val resultId = ContentUris.parseId(resultUri)
                    // ... and use result directly instead of using a back reference
                    cpoBuilder  .removeValueBackReference(backrefKey)
                                .withValue(backrefKey, resultId)
                } else
                    // back reference is in current batch, shift index
                    cpoBuilder.withValueBackReference(backrefKey, backrefIdx - start)
            }

            cpo += cpoBuilder.build()
        }
        return cpo
    }


    /**
     * Wrapper for [ContentProviderOperation.Builder] that allows to reset previously-set
     * value back references.
     */
    class CpoBuilder private constructor(
            val uri: Uri,
            val type: Type
    ) {

        enum class Type { INSERT, UPDATE, DELETE }

        companion object {

            fun newInsert(uri: Uri) = CpoBuilder(uri, Type.INSERT)
            fun newUpdate(uri: Uri) = CpoBuilder(uri, Type.UPDATE)
            fun newDelete(uri: Uri) = CpoBuilder(uri, Type.DELETE)

        }


        var selection: String? = null
        var selectionArguments: Array<String>? = null

        val values = mutableMapOf<String, Any?>()
        val valueBackrefs = mutableMapOf<String, Int>()


        fun withSelection(select: String, args: Array<String>): CpoBuilder {
            selection = select
            selectionArguments = args
            return this
        }

        fun withValueBackReference(key: String, index: Int): CpoBuilder {
            valueBackrefs[key] = index
            return this
        }

        fun removeValueBackReference(key: String): CpoBuilder {
            if (valueBackrefs.remove(key) == null)
                throw IllegalArgumentException("$key was not set as value back reference")
            return this
        }

        fun withValue(key: String, value: Any?): CpoBuilder {
            values[key] = value
            return this
        }


        fun build(): ContentProviderOperation {
            val builder = when (type) {
                Type.INSERT -> ContentProviderOperation.newInsert(uri)
                Type.UPDATE -> ContentProviderOperation.newUpdate(uri)
                Type.DELETE -> ContentProviderOperation.newDelete(uri)
            }

            if (selection != null)
                builder.withSelection(selection, selectionArguments)

            for ((key, value) in values)
                builder.withValue(key, value)
            for ((key, index) in valueBackrefs)
                builder.withValueBackReference(key, index)

            return builder.build()
        }

    }

}