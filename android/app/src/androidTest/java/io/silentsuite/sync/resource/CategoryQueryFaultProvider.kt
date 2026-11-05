package io.silentsuite.sync.resource

import android.content.ContentProvider
import android.content.ContentProviderClient
import android.content.ContentProviderOperation
import android.content.ContentProviderResult
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.GroupMembership
import androidx.test.rule.provider.ProviderTestRule
import java.util.concurrent.atomic.AtomicInteger

/**
 * #934 test-only transport: a ContentProvider that forwards every call to the real Contacts provider client,
 * except that a single armed [Fault] answers its matching queries with a null cursor (and counts them).
 *
 * A client of it is obtained only through the public API of the already declared androidx.test ProviderTestRule
 * (Builder(Class, authority).build(), then getResolver().acquireContentProviderClient(authority)); this file
 * names no android.test.mock class. No manifest component, no production hook, no Contacts database model.
 * One session at a time; [Session.close] disarms, releases both clients and shuts the provider down.
 */
class CategoryQueryFaultProvider : ContentProvider() {

    /** A query answered with a null cursor instead of being forwarded; [hits] witnesses that it was reached. */
    class Fault(val name: String, val matches: (uri: Uri, selection: String?, args: List<String>) -> Boolean) {
        val hits = AtomicInteger()
    }

    class Session internal constructor(
        val client: ContentProviderClient,
        private val real: ContentProviderClient,
        private val provider: CategoryQueryFaultProvider,
    ) : AutoCloseable {
        /** Queries forwarded to the real provider while this session was open. */
        val forwardedQueries: Int get() = forwarded.get()

        fun arm(f: Fault) {
            fault = f
        }

        fun disarm() {
            fault = null
        }

        override fun close() {
            val errors = ArrayList<Throwable>()
            fault = null
            runCatching { client.close() }.onFailure { errors += it }
            runCatching { provider.shutdown() }.onFailure { errors += it }
            runCatching { real.close() }.onFailure { errors += it }
            delegate = null
            instance = null
            if (errors.isNotEmpty())
                throw IllegalStateException("FIXTURE #934: fault session cleanup failed: ${errors.map { it.message }}").apply {
                    errors.forEach { addSuppressed(it) }
                }
        }
    }

    companion object {
        @Volatile private var delegate: ContentProviderClient? = null
        @Volatile private var fault: Fault? = null
        @Volatile private var instance: CategoryQueryFaultProvider? = null
        private val forwarded = AtomicInteger()

        /** LocalAddressBook.categoryGroups(): this account's label groups. */
        fun categoryGroupClassification() = Fault("category-group classification") { uri, selection, args ->
            uri.pathSegments.firstOrNull() == "groups" && LocalAddressBook.CATEGORY_GROUP_MARKER in args &&
                selection?.contains("${LocalAddressBook.CATEGORY_GROUP_COLUMN}=?") == true
        }

        /** LocalAddressBook.removeEmptyCategoryGroups(): which label groups still have members. */
        fun usedMembershipEnumeration() = Fault("used-membership enumeration") { uri, selection, args ->
            uri.pathSegments.firstOrNull() == "data" && args == listOf(GroupMembership.CONTENT_ITEM_TYPE) &&
                selection?.contains("${GroupMembership.GROUP_ROW_ID} IN (") == true
        }

        /** ContactsSyncManager.reconcileCategoryProjection(): rows whose labels are not certified. */
        fun unprojectedCandidateScan() = Fault("unprojected-candidate scan") { uri, _, args ->
            uri.pathSegments.firstOrNull() == "raw_contacts" && LocalContact.CATEGORIES_RELEASED in args
        }

        /** Opens a forwarding client of the real Contacts provider; nothing is faulted until [Session.arm]. */
        fun open(context: Context): Session {
            check(delegate == null && instance == null) { "FIXTURE #934: a fault session is already open" }
            val real = context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY)
                ?: throw IllegalStateException("FIXTURE #934: contacts provider unavailable")
            delegate = real
            forwarded.set(0)
            fault = null
            try {
                @Suppress("DEPRECATION")
                val rule = ProviderTestRule.Builder(CategoryQueryFaultProvider::class.java, ContactsContract.AUTHORITY).build()
                val provider = instance ?: throw IllegalStateException("the rule created no provider instance")
                val client = rule.resolver.acquireContentProviderClient(ContactsContract.AUTHORITY)
                    ?: throw IllegalStateException("the rule's resolver returned no client")
                return Session(client, real, provider)
            } catch (t: Throwable) {
                delegate = null
                instance = null
                runCatching { real.close() }.onFailure { t.addSuppressed(it) }
                throw IllegalStateException("FIXTURE #934: the public ProviderTestRule transport is unavailable: " +
                    "${t.javaClass.name}: ${t.message}", t)
            }
        }
    }

    private val real: ContentProviderClient
        get() = delegate ?: throw IllegalStateException("FIXTURE #934: fault provider used without an open session")

    override fun onCreate(): Boolean {
        instance = this
        return true
    }

    override fun query(uri: Uri, projection: Array<String>?, queryArgs: Bundle?, cancellationSignal: CancellationSignal?): Cursor? {
        val armed = fault
        if (armed != null && armed.matches(uri, queryArgs?.getString(ContentResolver.QUERY_ARG_SQL_SELECTION),
                queryArgs?.getStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS)?.toList() ?: emptyList())) {
            armed.hits.incrementAndGet()
            return null
        }
        forwarded.incrementAndGet()
        return real.query(uri, projection, queryArgs, cancellationSignal)
    }

    override fun query(uri: Uri, projection: Array<String>?, selection: String?, selectionArgs: Array<String>?, sortOrder: String?): Cursor? =
        query(uri, projection, sqlQueryArgs(selection, selectionArgs, sortOrder), null)

    /** The legacy query arguments as public QUERY_ARG_SQL_* extras; null when there are none. */
    private fun sqlQueryArgs(selection: String?, selectionArgs: Array<String>?, sortOrder: String?): Bundle? {
        if (selection == null && selectionArgs == null && sortOrder == null)
            return null
        return Bundle().apply {
            if (selection != null) putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
            if (selectionArgs != null) putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, selectionArgs)
            if (sortOrder != null) putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, sortOrder)
        }
    }

    override fun getType(uri: Uri): String? = real.getType(uri)

    override fun insert(uri: Uri, values: ContentValues?): Uri? = real.insert(uri, values)

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?): Int =
        real.update(uri, values, selection, selectionArgs)

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int =
        real.delete(uri, selection, selectionArgs)

    override fun bulkInsert(uri: Uri, values: Array<ContentValues>): Int = real.bulkInsert(uri, values)

    override fun applyBatch(operations: ArrayList<ContentProviderOperation>): Array<ContentProviderResult> =
        real.applyBatch(operations)

    override fun applyBatch(authority: String, operations: ArrayList<ContentProviderOperation>): Array<ContentProviderResult> =
        real.applyBatch(authority, operations)

    override fun openAssetFile(uri: Uri, mode: String): AssetFileDescriptor? = real.openAssetFile(uri, mode)

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? = real.call(method, arg, extras)
}
