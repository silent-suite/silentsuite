/*
 * Copyright © 2013 – 2015 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.resource

import android.content.ContentProviderClient
import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.ContentValues
import android.net.Uri
import android.os.Parcel
import android.os.RemoteException
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.GroupMembership
import android.provider.ContactsContract.Groups
import android.provider.ContactsContract.RawContacts.Data
import android.text.TextUtils
import at.bitfire.vcard4android.*
import at.bitfire.vcard4android.GroupMethod.GROUP_VCARDS
import io.silentsuite.sync.log.Logger
import ezvcard.VCardVersion
import java.io.ByteArrayOutputStream
import java.util.*

class LocalGroup : AndroidGroup, LocalAddress {
    companion object {
        /** marshalled list of member UIDs, as sent by server  */
        val COLUMN_PENDING_MEMBERS = Groups.SYNC3

        /**
         * Processes all groups with non-null {@link #COLUMN_PENDING_MEMBERS}: the pending memberships
         * are (if possible) applied, keeping cached memberships in sync.
         * @param addressBook    address book to take groups from
         * @param keepLocalChanges  merge the server's members with local membership changes still to
         *                          upload instead of applying the server's list as it is (writable replay only)
         */
        fun applyPendingMemberships(addressBook: LocalAddressBook, keepLocalChanges: Boolean = false) {
            addressBook.provider!!.query(
                    addressBook.groupsSyncUri(),
                    arrayOf(Groups._ID, COLUMN_PENDING_MEMBERS),
                    "$COLUMN_PENDING_MEMBERS IS NOT NULL", null,
                    null
            )?.use { cursor ->
                val batch = BatchOperation(addressBook.provider as ContentProviderClient)
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(0)

                    // extract list of member UIDs
                    val members = LinkedList<String>()
                    val raw = cursor.getBlob(1)
                    val parcel = Parcel.obtain()
                    try {
                        parcel.unmarshall(raw, 0, raw.size)
                        parcel.setDataPosition(0)
                        parcel.readStringList(members)
                    } finally {
                        parcel.recycle()
                    }

                    val group = addressBook.findGroupById(id)
                    if (keepLocalChanges)
                        group.reconcileMembers(batch, members)
                    else {
                        // insert memberships
                        val membersIds = members.map {uid ->
                            Constants.log.fine("Assigning group member")
                            val contact = addressBook.findByUid(uid) as LocalContact?
                            if (contact != null) contact.id else null
                        }.filterNotNull()

                        group.setMembers(batch, membersIds)
                    }

                    batch.commit()
                }
            }
        }
    }

    private var saveAsDirty = false // When true, the resource will be saved as dirty

    override val uuid: String?
        get() = fileName

    override val content: String
        get() {
            val contact: Contact
            contact = this.contact!!

            Logger.log.fine("Preparing upload of group VCard resource")

            val os = ByteArrayOutputStream()
            contact.write(VCardVersion.V4_0, GROUP_VCARDS, os)

            return os.toString()
        }

    override val isLocalOnly: Boolean
        get() = TextUtils.isEmpty(eTag)

    constructor(addressBook: AndroidAddressBook<out AndroidContact, LocalGroup>, values: ContentValues)
            : super(addressBook, values) {}

    constructor(addressBook: AndroidAddressBook<out AndroidContact, LocalGroup>, contact: Contact, fileName: String?, eTag: String?)
            : super(addressBook, contact, fileName, eTag) {}

    override fun contentValues(): ContentValues  {
        val values = super.contentValues()

        val members = Parcel.obtain()
        try {
            members.writeStringList(contact?.members)
            values.put(COLUMN_PENDING_MEMBERS, members.marshall())
        } finally {
            members.recycle()
        }

        if (saveAsDirty) {
            values.put(Groups.DIRTY, true)
        }
        return values
    }

    override fun clearDirty(eTag: String?) {
        val id = requireNotNull(id)

        val values = ContentValues(2)
        values.put(Groups.DIRTY, 0)
        this.eTag = eTag
        if (eTag != null) {
            values.put(AndroidGroup.COLUMN_ETAG, eTag)
        }
        update(values)

        // update cached group memberships
        val batch = BatchOperation(addressBook.provider!!)

        // delete cached group memberships
        batch.enqueue(BatchOperation.CpoBuilder.newDelete(addressBook.syncAdapterURI(ContactsContract.Data.CONTENT_URI))
                        .withSelection(
                                CachedGroupMembership.MIMETYPE + "=? AND " + CachedGroupMembership.GROUP_ID + "=?",
                                arrayOf(CachedGroupMembership.CONTENT_ITEM_TYPE, id.toString())
                        )
        )

        // insert updated cached group memberships
        for (member in getMembers())
            batch.enqueue(BatchOperation.CpoBuilder.newInsert(addressBook.syncAdapterURI(ContactsContract.Data.CONTENT_URI))
                            .withValue(CachedGroupMembership.MIMETYPE, CachedGroupMembership.CONTENT_ITEM_TYPE)
                            .withValue(CachedGroupMembership.RAW_CONTACT_ID, member)
                            .withValue(CachedGroupMembership.GROUP_ID, id)
            )

        batch.commit()
    }

    override fun prepareForUpload(fileName: String, uid: String) {
        val values = ContentValues(2)
        values.put(AndroidGroup.COLUMN_FILENAME, fileName)
        values.put(AndroidGroup.COLUMN_UID, uid)
        addressBook.provider?.update(groupSyncUri(), values, null, null)

        contact?.uid = uid
        this.fileName = fileName
    }

    override fun resetDeleted() {
        val values = ContentValues(1)
        values.put(Groups.DELETED, 0)
        addressBook.provider!!.update(groupSyncUri(), values, null, null)
    }

    private fun setMembers(batch: BatchOperation, members: List<Long>) {
        val id = id!!
        val addressBook = this.addressBook as LocalAddressBook
        Constants.log.fine("Assigning members to group $id")

        // delete all memberships and cached memberships for this group; a member's rows for other groups stay
        batch.enqueue(BatchOperation.CpoBuilder.newDelete(addressBook.syncAdapterURI(ContactsContract.Data.CONTENT_URI))
                        .withSelection(
                                "(${GroupMembership.MIMETYPE}=? AND ${GroupMembership.GROUP_ROW_ID}=?) OR " +
                                        "(${CachedGroupMembership.MIMETYPE}=? AND ${CachedGroupMembership.GROUP_ID}=?)",
                                arrayOf(GroupMembership.CONTENT_ITEM_TYPE, id.toString(), CachedGroupMembership.CONTENT_ITEM_TYPE, id.toString())
                        )
        )

        // insert memberships
        for (memberId in members) {
            Constants.log.fine("Assigning member: $memberId")
            addressBook.findContactByID(memberId).let { member ->
                member.addToGroup(batch, id)
            } ?: Constants.log.warning("Group member not found: $memberId")
        }


        // remove pending memberships
        batch.enqueue(BatchOperation.CpoBuilder.newUpdate(addressBook.syncAdapterURI(ContentUris.withAppendedId(Groups.CONTENT_URI, id)))
                        .withValue(COLUMN_PENDING_MEMBERS, null)
        )
    }


    fun updateAsDirty(group: Contact, members: List<Long>): Uri {
        saveAsDirty = true

        val ret = this.update(group)

        val batch = BatchOperation(addressBook.provider!!)
        setMembers(batch, members)
        batch.commit()

        return ret
    }

    fun createAsDirty(members: List<Long>): Uri {
        saveAsDirty = true

        val ret = this.add()

        val batch = BatchOperation(addressBook.provider!!)
        setMembers(batch, members)
        batch.commit()

        return ret
    }

    /**
     * Stores the server's member list of [server] as pending, without touching this group's title,
     * content or dirty flag, so a local edit of the group is kept while the server's members are merged.
     */
    fun stagePendingMembers(server: Contact) {
        val values = ContentValues(1)
        val members = Parcel.obtain()
        try {
            members.writeStringList(server.members)
            values.put(COLUMN_PENDING_MEMBERS, members.marshall())
        } finally {
            members.recycle()
        }
        addressBook.provider!!.update(groupSyncUri(), values, null, null)
    }

    /**
     * Merges the server's members ([serverUids]) with this group's membership changes still to upload.
     * Current rows hold the local state and cached rows the state last agreed with the server, so a
     * local addition is current without cached and a local removal cached without current. The target
     * is (server ∪ local additions) − local removals; contacts deleted locally gain no membership and
     * keep their rows until their deletion is uploaded.
     *
     * The operations are queued so any committed prefix is safe if [BatchOperation] yields or splits:
     * first current rows only, then cached rows only and only toward the server's list (a cached row of
     * a server member is never deleted, so local-removal evidence survives), and last the pending list
     * is cleared and the group marked dirty when the target differs from the server. Until that last
     * step commits the pending list remains, and recomputing from the rows gives the same target.
     */
    private fun reconcileMembers(batch: BatchOperation, serverUids: List<String>) {
        val id = requireNotNull(id)
        val addressBook = this.addressBook as LocalAddressBook
        val pendingDeletion = addressBook.findDeletedContacts().mapNotNull { it.id }.toSet()
        val server = serverUids.mapNotNull { uid -> (addressBook.findByUid(uid) as? LocalContact)?.id }
                .filterNot { it in pendingDeletion }.toSet()
        val current = memberRawIds(GroupMembership.CONTENT_ITEM_TYPE, GroupMembership.GROUP_ROW_ID)
        val cached = memberRawIds(CachedGroupMembership.CONTENT_ITEM_TYPE, CachedGroupMembership.GROUP_ID)
        val target = (server + (current - cached)) - (cached - current) - pendingDeletion
        val dataUri = addressBook.syncAdapterURI(ContactsContract.Data.CONTENT_URI)

        // A: current rows only
        for (rawId in target - current)
            batch.enqueue(BatchOperation.CpoBuilder.newInsert(dataUri)
                    .withValue(GroupMembership.MIMETYPE, GroupMembership.CONTENT_ITEM_TYPE)
                    .withValue(GroupMembership.RAW_CONTACT_ID, rawId)
                    .withValue(GroupMembership.GROUP_ROW_ID, id))
        for (rawId in current - target - pendingDeletion)
            batch.enqueue(BatchOperation.CpoBuilder.newDelete(dataUri)
                    .withSelection("${GroupMembership.RAW_CONTACT_ID}=? AND ${GroupMembership.MIMETYPE}=? AND ${GroupMembership.GROUP_ROW_ID}=?",
                            arrayOf(rawId.toString(), GroupMembership.CONTENT_ITEM_TYPE, id.toString())))

        // B: cached rows only, toward the server's list
        for (rawId in server - cached)
            batch.enqueue(BatchOperation.CpoBuilder.newInsert(dataUri)
                    .withValue(CachedGroupMembership.MIMETYPE, CachedGroupMembership.CONTENT_ITEM_TYPE)
                    .withValue(CachedGroupMembership.RAW_CONTACT_ID, rawId)
                    .withValue(CachedGroupMembership.GROUP_ID, id))
        for (rawId in cached - server)
            batch.enqueue(BatchOperation.CpoBuilder.newDelete(dataUri)
                    .withSelection("${CachedGroupMembership.RAW_CONTACT_ID}=? AND ${CachedGroupMembership.MIMETYPE}=? AND ${CachedGroupMembership.GROUP_ID}=?",
                            arrayOf(rawId.toString(), CachedGroupMembership.CONTENT_ITEM_TYPE, id.toString())))

        // C: last; a group is never marked clean here
        val done = BatchOperation.CpoBuilder.newUpdate(addressBook.syncAdapterURI(ContentUris.withAppendedId(Groups.CONTENT_URI, id)))
                .withValue(COLUMN_PENDING_MEMBERS, null)
        if (target != server)
            done.withValue(Groups.DIRTY, 1)
        batch.enqueue(done)
    }

    /** Raw contact IDs with a membership row of [mimeType] for this group. */
    private fun memberRawIds(mimeType: String, groupColumn: String): Set<Long> {
        val id = requireNotNull(id)
        val members = HashSet<Long>()
        addressBook.provider!!.query(
                addressBook.syncAdapterURI(ContactsContract.Data.CONTENT_URI),
                arrayOf(ContactsContract.Data.RAW_CONTACT_ID),
                "${ContactsContract.Data.MIMETYPE}=? AND $groupColumn=?",
                arrayOf(mimeType, id.toString()),
                null
        )?.use { cursor ->
            while (cursor.moveToNext())
                members += cursor.getLong(0)
        }
        return members
    }

    // helpers

    private fun groupSyncUri(): Uri {
        val id = requireNotNull(id)
        return ContentUris.withAppendedId(addressBook.groupsSyncUri(), id)
    }

    /**
     * Lists all members of this group.
     * @return list of all members' raw contact IDs
     * @throws RemoteException on contact provider errors
     */
    internal fun getMembers(): List<Long> {
        val id = requireNotNull(id)
        val members = LinkedList<Long>()
        addressBook.provider!!.query(
                addressBook.syncAdapterURI(ContactsContract.Data.CONTENT_URI),
                arrayOf(Data.RAW_CONTACT_ID),
                "${GroupMembership.MIMETYPE}=? AND ${GroupMembership.GROUP_ROW_ID}=?",
                arrayOf(GroupMembership.CONTENT_ITEM_TYPE, id.toString()),
                null
        )?.use { cursor ->
            while (cursor.moveToNext())
                members += cursor.getLong(0)
        }
        return members
    }


    // factory

    object Factory: AndroidGroupFactory<LocalGroup> {
        override fun fromProvider(addressBook: AndroidAddressBook<out AndroidContact, LocalGroup>, values: ContentValues) =
                LocalGroup(addressBook, values)
    }
}
