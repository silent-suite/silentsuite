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
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.Buffer
import org.apache.commons.collections4.SetUtils
import java.io.FileNotFoundException
import java.io.IOException
import java.io.StringReader
import java.net.InetAddress
import java.net.Proxy
import java.net.UnknownHostException
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
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

        // A held edit keeps its dirty flag but is not uploaded until its labels have a safe basis.
        if (heldIds.isNotEmpty())
            localDirty = localDirty.filterNot { it is LocalContact && it.id?.let { id -> id in heldIds } == true }
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
        val removed = localAddressBook().removeEmptyCategoryGroups()
        if (removed > 0)
            Logger.log.info("Removed $removed unused label group(s)")
    }

    /**
     * Raw IDs of dirty, server-backed contacts whose labels have no safe basis yet. They are not uploaded
     * this run, which lists the address book from the start to obtain one.
     */
    private val heldIds = HashSet<Long>()

    /**
     * Before any upload, restores the label memberships of rows not (or not completely) projected, from the
     * cached server item of exactly the revision the row records, parsed without downloading anything.
     * Rows never confirmed by the server and rows whose cached item is deleted are left as they are; dirty rows
     * without a matching cached item are held, clean ones wait for the server to deliver them again.
     */
    private fun reconcileCategoryProjection() {
        heldIds.clear()
        listedUnusableIds.clear()
        if (cachedCollection.col.accessLevel == CollectionAccessLevel.ReadOnly)
            return
        val addressBook = localAddressBook()

        class Candidate(val id: Long, val fileName: String?, val eTag: String?, val dirty: Boolean, val released: Boolean)
        val candidates = ArrayList<Candidate>()
        // Unknown is not none: without this list, rows needing recovery could be uploaded unprojected.
        val cursor = addressBook.provider!!.query(addressBook.syncAdapterURI(ContactsContract.RawContacts.CONTENT_URI),
                arrayOf(ContactsContract.RawContacts._ID, at.bitfire.vcard4android.AndroidContact.COLUMN_FILENAME,
                        at.bitfire.vcard4android.AndroidContact.COLUMN_ETAG, ContactsContract.RawContacts.DIRTY,
                        LocalContact.COLUMN_CATEGORIES),
                "${ContactsContract.RawContacts.DELETED}=0 AND " +
                        "(${LocalContact.COLUMN_CATEGORIES} IS NULL OR ${LocalContact.COLUMN_CATEGORIES}=?)",
                arrayOf(LocalContact.CATEGORIES_RELEASED), null)
                ?: throw ContactsStorageException("Couldn't read contacts awaiting label projection")
        cursor.use {
            while (it.moveToNext())
                candidates += Candidate(it.getLong(0), it.getString(1), it.getString(2),
                        !it.isNull(3) && it.getInt(3) != 0, it.getString(4) == LocalContact.CATEGORIES_RELEASED)
        }

        var recovered = 0
        var waiting = 0
        for (candidate in candidates) {
            val fileName = candidate.fileName
            // Never confirmed by the server: its own memberships are what its upload certifies.
            if (candidate.eTag == null || fileName == null)
                continue
            val cached = synchronized(etebaseLocalCache) {
                etebaseLocalCache.itemGet(itemMgr, cachedCollection.col.uid, fileName)
            }
            // Deleted on the server: there are no server labels to protect.
            if (cached != null && cached.item.isDeleted)
                continue
            val basis = cached?.takeIf { it.item.etag == candidate.eTag }
                    ?.let { Contact.fromReader(StringReader(it.content), null).firstOrNull() }
            if (basis != null && !basis.group) {
                addressBook.findContactByID(candidate.id).replaceCategoryProjection(basis.categories)
                recovered++
            } else if (candidate.dirty && !candidate.released)
                heldIds += candidate.id
            else
                waiting++
        }
        if (recovered > 0 || heldIds.isNotEmpty() || waiting > 0)
            Logger.log.info("Label projection: $recovered recovered from the cache, ${heldIds.size} held, $waiting awaiting delivery")
    }

    /**
     * After a completed listing, a held edit whose live item never arrived is released to the ordinary upload
     * path. Without an exactly current destination the edits stay held and the run fails rather than succeeds.
     */
    private fun releaseHeldRows() {
        if (heldIds.isEmpty())
            return
        // Only a destination this run actually captured, and that is still exactly current, authorizes a release;
        // the inherited fallback for an uncaptured destination is not that proof.
        val captured = destination
        if (captured == null || !destinationStillCurrent(captured))
            throw ContactsStorageException("${heldIds.size} contact edit(s) held for label recovery")
        // A row whose live item was listed is not absent, even if that item could not supply its labels.
        val absent = heldIds - listedUnusableIds
        val addressBook = localAddressBook()
        val values = ContentValues(1)
        values.put(LocalContact.COLUMN_CATEGORIES, LocalContact.CATEGORIES_RELEASED)
        for (id in absent)
            addressBook.provider!!.update(
                    addressBook.syncAdapterURI(ContentUris.withAppendedId(ContactsContract.RawContacts.CONTENT_URI, id)),
                    values, "${LocalContact.COLUMN_CATEGORIES} IS NULL", null)
        if (absent.isNotEmpty())
            Logger.log.info("Released ${absent.size} held contact edit(s) that a complete listing did not return")
        val unresolved = heldIds.size - absent.size
        heldIds.clear()
        if (unresolved > 0)
            throw ContactsStorageException("$unresolved held contact edit(s) whose listed item could not supply labels")
    }

    /** Held rows whose live item this run's listing returned without a usable individual-contact basis. */
    private val listedUnusableIds = HashSet<Long>()

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
        reconcileCategoryProjection()
        val exact = destination ?: return true
        if (heldIds.isNotEmpty()) {
            Logger.log.info("Listing this address book from the start for ${heldIds.size} contact edit(s) held for label recovery")
            return true
        }
        if (stored != null && stored.contentEquals(marker(exact)))
            return false
        Logger.log.info("Listing this address book from the start, as it isn't marked complete")
        return true
    }

    @Throws(ContactsStorageException::class)
    override fun onReplayCompleted() {
        releaseHeldRows()
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

        // A held edit takes the listed item's labels as its basis; the rules below then keep the edit itself.
        if (local is LocalContact && !item.isDeleted && local.id?.let { it in heldIds } == true) {
            val listed = Contact.fromReader(StringReader(String(item.content)), null).firstOrNull()
            if (listed != null && !listed.group) {
                local.replaceCategoryProjection(listed.categories)
                heldIds -= local.id!!
                listedUnusableIds -= local.id!!
            } else
                // Observed live but unusable (a group vCard, or no contact parsed): never released as absent.
                listedUnusableIds += local.id!!
        }

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

            // The URL comes from the contact, so it is never logged.
            if (httpUrl == null) {
                Logger.log.warning("Invalid external resource URL")
                return null
            }

            // Non-interactive: an unknown certificate fails at once rather than holding the sync for
            // a user decision the call deadline cannot interrupt. No network logging: in debug
            // builds it would buffer the whole body before the size check.
            return HttpClient.Builder(context, interactiveCertificates = false, networkLogging = false)
                    .setForeground(false).build().use { client ->
                fetchBounded(client.okHttpClient, httpUrl)
            }
        }

        companion object {
            /** Largest external resource (contact photo) accepted; bigger bodies are dropped unread. */
            const val MAX_RESOURCE_BYTES: Long = 5L * 1024 * 1024

            /** Deadline for the whole fetch, including any host check, connecting and reading the body. */
            const val CALL_TIMEOUT_SECONDS: Long = 30

            private const val READ_CHUNK_BYTES: Long = 8 * 1024

            /**
             * Fetches [url] with [client] and returns the body only for a 2xx response no larger than
             * [maxBytes], fetched (host check included) within [callTimeoutMillis]. Anything else yields null.
             *
             * Unless [publicAddressesOnly] is false (tests against a local server only), the host must
             * be public: see [PublicAddressDns]. Redirects are not followed, so no other host is reached.
             */
            @VisibleForTesting
            internal fun fetchBounded(
                    client: OkHttpClient,
                    url: HttpUrl,
                    maxBytes: Long = MAX_RESOURCE_BYTES,
                    callTimeoutMillis: Long = TimeUnit.SECONDS.toMillis(CALL_TIMEOUT_SECONDS),
                    publicAddressesOnly: Boolean = true
            ): ByteArray? {
                val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(callTimeoutMillis)
                // A literal address is checked here too, because through a proxy no lookup happens.
                if (publicAddressesOnly && isLocalLiteral(url.host)) {
                    Logger.log.warning("External resource host is a local address, ignoring")
                    return null
                }
                // Through a proxy, OkHttp looks up only the proxy's name and the proxy resolves this
                // host itself. Best effort: resolve it here first and refuse it unless every address
                // is public. The proxy can still resolve it differently (split DNS, rebinding).
                if (publicAddressesOnly && goesThroughProxy(client, url) &&
                        !resolvesToPublicOnly(client.dns, url.host, callTimeoutMillis)) {
                    Logger.log.warning("External resource host is local or could not be resolved in time, ignoring")
                    return null
                }
                // The call gets only what is left of the budget.
                val remainingMillis = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
                if (remainingMillis <= 0) {
                    Logger.log.warning("External resource fetch ran out of time, ignoring")
                    return null
                }
                val boundedClient = client.newBuilder()
                        .callTimeout(remainingMillis, TimeUnit.MILLISECONDS)
                        .followRedirects(false)
                        .followSslRedirects(false)
                        .apply { if (publicAddressesOnly) dns(PublicAddressDns(url.host, client.dns)) }
                        .build()
                try {
                    boundedClient.newCall(Request.Builder()
                            .get()
                            .url(url)
                            .build()).execute().use { response ->
                        if (!response.isSuccessful) {
                            Logger.log.warning("External resource request failed with HTTP ${response.code}")
                            return null
                        }
                        val body = response.body ?: return null
                        if (body.contentLength() > maxBytes) {
                            Logger.log.warning("External resource is too large (declared ${body.contentLength()} bytes), ignoring")
                            return null
                        }
                        val source = body.source()
                        val buffer = Buffer()
                        while (buffer.size <= maxBytes) {
                            if (source.read(buffer, READ_CHUNK_BYTES) == -1L)
                                return buffer.readByteArray()
                        }
                        Logger.log.warning("External resource is larger than $maxBytes bytes, ignoring")
                        return null
                    }
                } catch (e: IOException) {
                    Logger.log.log(Level.SEVERE, "Couldn't download external resource", e)
                }
                return null
            }

            /**
             * True when [host] resolves through [dns], within [timeoutMillis], to public addresses
             * only. A lookup that is still running then is left to finish on its own thread.
             */
            private fun resolvesToPublicOnly(dns: Dns, host: String, timeoutMillis: Long): Boolean {
                val lookup = FutureTask(Callable { PublicAddressDns(host, dns).lookup(host) })
                Thread(lookup, "external-resource-lookup").apply { isDaemon = true }.start()
                return try {
                    lookup.get(timeoutMillis, TimeUnit.MILLISECONDS)
                    true
                } catch (e: TimeoutException) {
                    lookup.cancel(true)
                    false
                } catch (e: ExecutionException) {   // not public, or not resolvable
                    false
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    false
                }
            }

            /** True unless [client] connects to [url] directly. */
            private fun goesThroughProxy(client: OkHttpClient, url: HttpUrl): Boolean {
                val proxies = client.proxy?.let { listOf(it) }
                        ?: try { client.proxySelector.select(url.toUri()) } catch (e: Exception) { null }
                        ?: return true
                return proxies.any { it.type() != Proxy.Type.DIRECT }
            }

            private val IPV4_LITERAL = Regex("""\d{1,3}(\.\d{1,3}){3}""")

            /**
             * True when [host] is a literal IP address (as [HttpUrl] gives it) that is not public.
             * Parsed without a lookup; other forms are left to [PublicAddressDns].
             */
            internal fun isLocalLiteral(host: String): Boolean {
                val address = when {
                    host.contains(':') ->   // HttpUrl only accepts valid IPv6 literals
                        try { InetAddress.getByName(host) } catch (e: UnknownHostException) { return true }
                    IPV4_LITERAL.matches(host) -> {
                        val parts = host.split('.').map { it.toInt() }
                        if (parts.any { it > 255 })
                            return false
                        InetAddress.getByAddress(ByteArray(4) { parts[it].toByte() })
                    }
                    else -> return false
                }
                return !PublicAddressDns.isPublic(address)
            }
        }
    }

}
