/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.vcard4android

import android.accounts.Account
import android.content.ContentProviderClient
import android.content.ContentValues
import android.database.DatabaseUtils
import android.net.Uri
import android.provider.ContactsContract
import android.provider.ContactsContract.Groups
import android.provider.ContactsContract.RawContacts
import java.io.FileNotFoundException
import java.util.*

open class AndroidAddressBook<T1: AndroidContact, T2: AndroidGroup>(
        var account: Account,
        val provider: ContentProviderClient?,
        protected val contactFactory: AndroidContactFactory<T1>,
        protected val groupFactory: AndroidGroupFactory<T2>
) {

    open var readOnly: Boolean = false

    var settings: ContentValues
        /**
         * Retrieves [ContactsContract.Settings] for the current address book.
         * @throws FileNotFoundException if the settings row couldn't be fetched.
         * @throws android.os.RemoteException on content provider errors
         */
        get() {
            provider!!.query(syncAdapterURI(ContactsContract.Settings.CONTENT_URI), null, null, null, null)?.use { cursor ->
                if (cursor.moveToNext()) {
                    val values = ContentValues(cursor.columnCount)
                    DatabaseUtils.cursorRowToContentValues(cursor, values)
                    return values
                }
            }
            throw FileNotFoundException()
        }

        /**
         * Updates [ContactsContract.Settings] by inserting the given values into
         * the current address book.
         * @param values settings to be updated
         * @throws android.os.RemoteException on content provider errors
         */
        set(values) {
            values.put(ContactsContract.Settings.ACCOUNT_NAME, account.name)
            values.put(ContactsContract.Settings.ACCOUNT_TYPE, account.type)
            provider!!.insert(syncAdapterURI(ContactsContract.Settings.CONTENT_URI), values)
        }

    var syncState: ByteArray?
        get() = ContactsContract.SyncState.get(provider, account)
        set(data) = ContactsContract.SyncState.set(provider, account, data)


    fun queryContacts(where: String?, whereArgs: Array<String>?, sortOrder: String? = null): List<T1> {
        val contacts = LinkedList<T1>()
        provider!!.query(rawContactsSyncUri(),
                null, where, whereArgs, sortOrder)?.use { cursor ->
            while (cursor.moveToNext()) {
                val values = ContentValues(cursor.columnCount)
                DatabaseUtils.cursorRowToContentValues(cursor, values)
                contacts += contactFactory.fromProvider(this, values)
            }
        }
        return contacts
    }

    fun queryGroups(where: String?, whereArgs: Array<String>?, sortOrder: String? = null): List<T2> {
        val groups = LinkedList<T2>()
        provider!!.query(groupsSyncUri(),
                arrayOf(Groups._ID, AndroidGroup.COLUMN_FILENAME, AndroidGroup.COLUMN_ETAG),
                where, whereArgs, sortOrder)?.use { cursor ->
            while (cursor.moveToNext()) {
                val values = ContentValues(cursor.columnCount)
                DatabaseUtils.cursorRowToContentValues(cursor, values)
                groups += groupFactory.fromProvider(this, values)
            }
        }
        return groups
    }

    fun findContactByID(id: Long) =
            queryContacts("${RawContacts._ID}=?", arrayOf(id.toString())).firstOrNull()
                    ?: throw FileNotFoundException()

    fun findContactByUID(uid: String) =
            queryContacts("${AndroidContact.COLUMN_UID}=?", arrayOf(uid)).firstOrNull()


    // helpers

    fun syncAdapterURI(uri: Uri) = uri.buildUpon()
            .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(RawContacts.ACCOUNT_NAME, account.name)
            .appendQueryParameter(RawContacts.ACCOUNT_TYPE, account.type)
            .build()!!

    fun rawContactsSyncUri() = syncAdapterURI(RawContacts.CONTENT_URI)
    fun groupsSyncUri() = syncAdapterURI(Groups.CONTENT_URI)

}
