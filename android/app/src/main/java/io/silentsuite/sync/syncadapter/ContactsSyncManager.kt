/*
 * Copyright © 2013 – 2015 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.accounts.AccountManager
import android.content.*
import android.os.Bundle
import android.os.RemoteException
import android.provider.ContactsContract
import androidx.annotation.VisibleForTesting
import at.bitfire.ical4android.CalendarStorageException
import at.bitfire.vcard4android.BatchOperation
import at.bitfire.vcard4android.Contact
import at.bitfire.vcard4android.ContactsStorageException
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.Item
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.BuildConfig
import io.silentsuite.sync.Constants
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.resource.LocalAddress
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.resource.LocalContact
import io.silentsuite.sync.resource.LocalGroup
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import org.apache.commons.collections4.SetUtils
import java.io.FileNotFoundException
import java.io.IOException
import java.io.StringReader
import java.util.logging.Level

/**
 *
 * Synchronization manager for CardDAV collections; handles contacts and groups.
 */
class ContactsSyncManager
constructor(context: Context, account: Account, settings: AccountSettings, extras: Bundle, authority: String, private val provider: ContentProviderClient, result: SyncResult, localAddressBook: LocalAddressBook, private val remote: HttpUrl) : SyncManager<LocalAddress>(context, account, settings, extras, authority, result, localAddressBook.url, CollectionInfo.Type.ADDRESS_BOOK, localAddressBook.mainAccount.name) {
    private val resourceDownloader: ResourceDownloader

    protected override val syncErrorTitle: String
        get() = context.getString(R.string.sync_error_contacts, account.name)

    protected override val syncSuccessfullyTitle: String
        get() = context.getString(R.string.sync_successfully_contacts, account.name)

    init {
        localCollection = localAddressBook
        resourceDownloader = ResourceDownloader(context)
    }

    /**
     * The native address book and owner generation this run was admitted for, read once here and
     * never read again to adopt a later generation. Null when any part is missing or inconsistent:
     * such a destination is listed from the start and never marked complete.
     */
    private class Destination(
        val native: Account,
        val creationId: String,
        val ownerIdentity: String,
        val url: String,
        val main: Account,
        val mainCreationId: String,
    )

    private val destination: Destination? = captureDestination(context, localAddressBook)

    companion object {
        /** Marks a native address book that one complete listing has filled, for one exact destination. */
        private const val POPULATED_MARKER = "silentsuite.contacts.populated.v1"

        private fun captureDestination(context: Context, addressBook: LocalAddressBook): Destination? = runCatching {
            val manager = AccountManager.get(context)
            val native = addressBook.androidAccount
            val creationId = manager.getUserData(native, LocalAddressBook.USER_DATA_CREATION_ID)?.takeIf { it.isNotBlank() }
                ?: return null
            val ownerIdentity = manager.getUserData(native, LocalAddressBook.USER_DATA_MAIN_ACCOUNT_IDENTITY)?.takeIf { it.isNotBlank() }
                ?: return null
            val url = manager.getUserData(native, LocalAddressBook.USER_DATA_URL)?.takeIf { it.isNotBlank() } ?: return null
            val main = addressBook.mainAccountOrNull ?: return null
            val mainCreationId = manager.getUserData(main, AccountSettings.KEY_CREATION_ID)?.takeIf { it.isNotBlank() }
                ?: return null
            if (SyncStatusStore(context).identity(main).storageKey != ownerIdentity) return null
            Destination(native, creationId, ownerIdentity, url, main, mainCreationId)
        }.getOrNull()

        private fun marker(destination: Destination): ByteArray =
            listOf(POPULATED_MARKER, destination.creationId, destination.url, destination.ownerIdentity)
                .joinToString("\u0000").toByteArray(Charsets.UTF_8)

        /** Process-local fault for a native-store marker read (false) or write (true); never set in release. */
        @Volatile
        private var installedSyncStateFault: ((Boolean) -> Exception?)? = null

        /** Debug-only instrumentation seam; installing it in a release build fails. */
        @VisibleForTesting
        internal fun installSyncStateFaultForTest(fault: ((write: Boolean) -> Exception?)?) {
            check(BuildConfig.DEBUG) { "The sync-state fault hook is unavailable in release builds" }
            installedSyncStateFault = fault
        }

        /** The injected fault for a marker read or write, or null; always null in release builds. */
        internal fun syncStateFaultFor(write: Boolean): Exception? =
            if (BuildConfig.DEBUG) installedSyncStateFault?.invoke(write) else null
    }

    override fun notificationId(): Int {
        return Constants.NOTIFICATION_CONTACTS_SYNC
    }

    @Throws(ContactsStorageException::class, CalendarStorageException::class)
    override fun prepare(): Boolean {
        if (!super.prepare())
            return false
        localAddressBook()

        return true
    }

    @Throws(CalendarStorageException::class, ContactsStorageException::class, FileNotFoundException::class)
    override fun prepareLocal() {
        // A replay first finishes the server member lists an earlier run left pending against those same
        // lists, before this run's snapshot, upload or listing can replace them.
        if (keepsLocalEditsOfThisRun) {
            if (!exactDestinationCurrent()) {
                // It cannot do that for a generation it was not admitted for, so it stops here, before any
                // upload or listing, as a cancelled run; the pending lists stay for the next run.
                Logger.log.info("Stopping a replay whose address book generation changed before its pending memberships were merged")
                throw InterruptedException()
            }
            LocalGroup.applyPendingMemberships(localAddressBook(), keepLocalChanges = true)
        }
        super.prepareLocal()
    }

    @Throws(CalendarStorageException::class, ContactsStorageException::class)
    override fun prepareDirty() {
        super.prepareDirty()

        val addressBook = localAddressBook()

        /* groups as separate VCards: there are group contacts and individual contacts */

        // mark groups with changed members as dirty
        val batch = BatchOperation(addressBook.provider!!)
        for (contact in addressBook.findDirtyContacts()) {
            try {
                Logger.log.fine("Looking for changed group memberships of contact resource")
                val cachedGroups = contact.getCachedGroupMemberships()
                val currentGroups = contact.getGroupMemberships()
                for (groupID in SetUtils.disjunction(cachedGroups, currentGroups)) {
                    Logger.log.fine("Marking group as dirty: " + groupID!!)
                    batch.enqueue(BatchOperation.CpoBuilder.newUpdate(addressBook.syncAdapterURI(ContentUris.withAppendedId(ContactsContract.Groups.CONTENT_URI, groupID)))
                                    .withValue(ContactsContract.Groups.DIRTY, 1)
                    )
                }
            } catch (ignored: FileNotFoundException) {
            }

        }
        batch.commit()

        // A replay withholds groups the server may already know until their server members are merged,
        // so an incomplete local member list is never uploaded; groups without a filename upload as usual.
        // A filename, not an eTag, marks them: an upload whose dirty flag could not be cleared afterwards
        // leaves the filename without an eTag. A filename assigned before a failed upload only defers
        // that group's creation to the next ordinary run.
        if (keepsLocalEditsOfThisRun)
            localDirty = localDirty.filterNot { it is LocalGroup && it.fileName != null }
    }

    /**
     * On a read-only collection, a native/OEM Contacts app may still let the
     * user toggle the star. That local change must never be uploaded; instead
     * we reapply the authoritative cached remote vCard (already downloaded in
     * this sync) over the SilentSuite raw row so STARRED and every other field
     * are restored to the server's state before the dirty flag is cleared.
     */
    override fun restoreLocalFromRemote(local: LocalAddress): String? {
        if (local !is LocalContact)
            return null
        // The Etebase cache is keyed by the item/file UID, not the vCard UID.
        val itemUid = local.fileName
            ?: throw ContactsStorageException("Cannot restore read-only contact without cached item UID")

        val cached = synchronized(etebaseLocalCache) {
            etebaseLocalCache.itemGet(itemMgr, cachedCollection.col.uid, itemUid)
        }
        if (cached == null || cached.item.isDeleted)
            throw ContactsStorageException("Authoritative cached read-only contact is unavailable")

        val remote = Contact.fromReader(StringReader(cached.content), resourceDownloader)
        if (remote.isEmpty())
            throw ContactsStorageException("Authoritative cached read-only contact is invalid")

        Logger.log.info("Reapplying authoritative remote contact over a discarded read-only change")
        local.eTag = cached.item.etag
        local.update(remote[0])
        return cached.item.etag
    }

    @Throws(CalendarStorageException::class, ContactsStorageException::class)
    override fun postProcess() {
        super.postProcess()
        /* VCard4 group handling: there are group contacts and individual contacts */
        if (keepsLocalEditsOfThisRun) {
            if (!exactDestinationCurrent()) {
                // The pending lists stay for the next run; this run certifies nothing.
                Logger.log.info("Not merging memberships into an address book whose generation changed during this run")
                return
            }
            Logger.log.info("Merging memberships of downloaded contact groups with local changes")
            LocalGroup.applyPendingMemberships(localAddressBook(), keepLocalChanges = true)
        } else {
            Logger.log.info("Assigning memberships of downloaded contact groups")
            LocalGroup.applyPendingMemberships(localAddressBook())
        }
    }

    /**
     * A replay lists every entry, so a local change made while it runs would otherwise be written
     * over. On a writable address book such changes are kept for the next run's upload. A read-only
     * address book keeps the server's content, as an incremental run does.
     */
    private val keepsLocalEditsOfThisRun: Boolean
        get() = replaying && cachedCollection.col.accessLevel != CollectionAccessLevel.ReadOnly

    /**
     * False only when the native address book or owner generation this run captured has since been
     * replaced; a destination that could not be captured is never marked complete, but its memberships
     * are still applied as before.
     */
    private fun exactDestinationCurrent(): Boolean = destination?.let { destinationStillCurrent(it) } ?: true

    /**
     * On a writable replay, a server deletion of a row with a local change still to upload leaves the
     * row and the cached copy alone, so the next run uploads the local change (local wins).
     */
    override fun keepsLocalChange(item: Item): Boolean {
        if (!item.isDeleted || !keepsLocalEditsOfThisRun)
            return false
        val local = localCollection!!.findByFilename(item.uid) ?: return false
        return isDirty(local)
    }

    private fun isDirty(local: LocalAddress): Boolean {
        val addressBook = localAddressBook()
        val (uri, column) = when (local) {
            is LocalContact -> ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, local.id ?: return false) to
                ContactsContract.RawContacts.DIRTY
            is LocalGroup -> ContentUris.withAppendedId(ContactsContract.Groups.CONTENT_URI, local.id ?: return false) to
                ContactsContract.Groups.DIRTY
            else -> return false
        }
        return addressBook.provider!!.query(addressBook.syncAdapterURI(uri), arrayOf(column), null, null, null)?.use { cursor ->
            cursor.moveToNext() && cursor.getInt(0) != 0
        } ?: false
    }

    @Throws(ContactsStorageException::class)
    override fun replayFromStart(): Boolean {
        val stored = storageAccess("read") {
            syncStateFaultFor(false)?.let { throw it }
            localAddressBook().syncState
        }
        val exact = destination ?: return true
        if (stored != null && stored.contentEquals(marker(exact)))
            return false
        Logger.log.info("Listing this address book from the start, as it isn't marked complete")
        return true
    }

    @Throws(ContactsStorageException::class)
    override fun onReplayCompleted() {
        val exact = destination ?: return
        if (!destinationStillCurrent(exact)) {
            Logger.log.info("Not marking an address book whose generation changed during this run")
            return
        }
        val expected = marker(exact)
        storageAccess("write") {
            syncStateFaultFor(true)?.let { throw it }
            val addressBook = localAddressBook()
            addressBook.syncState = expected
            if (addressBook.syncState?.contentEquals(expected) != true)
                throw ContactsStorageException("The address book's sync state did not read back as written")
        }
    }

    /** Fresh reads: the same native row, owner and main account generation as when this run began. */
    private fun destinationStillCurrent(exact: Destination): Boolean = runCatching {
        val manager = AccountManager.get(context)
        manager.getAccountsByType(exact.native.type).any { it == exact.native } &&
            manager.getUserData(exact.native, LocalAddressBook.USER_DATA_CREATION_ID) == exact.creationId &&
            manager.getUserData(exact.native, LocalAddressBook.USER_DATA_MAIN_ACCOUNT_IDENTITY) == exact.ownerIdentity &&
            manager.getUserData(exact.native, LocalAddressBook.USER_DATA_URL) == exact.url &&
            manager.getAccountsByType(exact.main.type).any { it == exact.main } &&
            manager.getUserData(exact.main, AccountSettings.KEY_CREATION_ID) == exact.mainCreationId &&
            SyncStatusStore(context).identity(exact.main).storageKey == exact.ownerIdentity
    }.getOrDefault(false)

    /** Sync-state access as a Contacts storage failure, which the run reports as a database error. */
    private inline fun <R> storageAccess(what: String, access: () -> R): R = try {
        access()
    } catch (e: ContactsStorageException) {
        throw e
    } catch (e: RemoteException) {
        throw ContactsStorageException("Couldn't $what the address book's sync state", e)
    } catch (e: RuntimeException) {
        throw ContactsStorageException("Couldn't $what the address book's sync state", e)
    }


    // helpers

    private fun localAddressBook(): LocalAddressBook {
        return localCollection as LocalAddressBook
    }

    override fun processItem(item: Item) {
        val local = localCollection!!.findByFilename(item.uid)

        if (local != null && !item.isDeleted && keepsLocalEditsOfThisRun && isDirty(local)) {
            Logger.log.info("Keeping a local change made during this listing for the next upload")
            // A locally edited group still takes the server's member list as its merge baseline.
            if (local is LocalGroup)
                Contact.fromReader(StringReader(String(item.content)), resourceDownloader).firstOrNull()
                    ?.takeIf { it.group }
                    ?.let { local.stagePendingMembers(it) }
            return
        }

        if (!item.isDeleted) {
            val inputReader = StringReader(String(item.content))

            val contacts = Contact.fromReader(inputReader, resourceDownloader)
            if (contacts.size == 0) {
                Logger.log.warning("Received VCard without data, ignoring")
                return
            } else if (contacts.size > 1) {
                Logger.log.warning("Received multiple VCALs, using first one")
            }

            val contact = contacts[0]
            processContact(item, contact, local)
        } else {
            if (local != null) {
                Logger.log.info("Removing local record which has been deleted on the server")
                local.delete()
            } else {
                Logger.log.warning("Tried deleting a non-existent local contact resource")
            }
        }
    }

    private fun processContact(item: Item, newData: Contact, _local: LocalAddress?): LocalAddress {
        var local = _local
        val uuid = newData.uid
        // update local contact, if it exists
        if (local != null) {
            Logger.log.log(Level.INFO, "Updating local address book resource")

            if (local is LocalGroup && newData.group) {
                // update group
                val group: LocalGroup = local
                group.eTag = item.etag
                group.update(newData)
                syncResult.stats.numUpdates++

            } else if (local is LocalContact && !newData.group) {
                // update contact
                val contact: LocalContact = local
                contact.eTag = item.etag
                contact.update(newData)
                syncResult.stats.numUpdates++

            } else {
                // group has become an individual contact or vice versa
                try {
                    local.delete()
                    local = null
                } catch (e: CalendarStorageException) {
                    // CalendarStorageException is not used by LocalGroup and LocalContact
                }

            }
        }

        if (local == null) {
            if (newData.group) {
                Logger.log.log(Level.INFO, "Creating local group")
                val group = LocalGroup(localAddressBook(), newData, item.uid, item.etag)
                group.add()

                local = group
            } else {
                Logger.log.log(Level.INFO, "Creating local contact")
                val contact = LocalContact(localAddressBook(), newData, item.uid, item.etag)
                contact.add()

                local = contact
            }
            syncResult.stats.numInserts++
        }


        return local
    }

    // downloader helper class

    class ResourceDownloader(internal var context: Context) : Contact.Downloader {

        override fun download(url: String, accepts: String): ByteArray? {
            val httpUrl = url.toHttpUrlOrNull()

            if (httpUrl == null) {
                Logger.log.log(Level.SEVERE, "Invalid external resource URL", url)
                return null
            }

            val host = httpUrl.host
            if (host == null) {
                Logger.log.log(Level.SEVERE, "External resource URL doesn't specify a host name", url)
                return null
            }

            val resourceClient = HttpClient.Builder(context).setForeground(false).build().okHttpClient

            try {
                val response = resourceClient.newCall(Request.Builder()
                        .get()
                        .url(httpUrl)
                        .build()).execute()

                val body = response.body
                if (body != null) {
                    return body.bytes()
                }
            } catch (e: IOException) {
                Logger.log.log(Level.SEVERE, "Couldn't download external resource", e)
            }

            return null
        }
    }

}
