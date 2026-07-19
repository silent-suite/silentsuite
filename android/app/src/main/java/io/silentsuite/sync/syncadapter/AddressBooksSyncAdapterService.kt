/*
 * Copyright © 2013 – 2015 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */
package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.content.*
import android.os.Bundle
import android.provider.ContactsContract
import io.silentsuite.sync.*
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.resource.LocalAddressBook
import java.util.*
import java.util.logging.Level

class AddressBooksSyncAdapterService : SyncAdapterService() {

    override fun syncAdapter(): AbstractThreadedSyncAdapter {
        return AddressBooksSyncAdapter(this)
    }


    private class AddressBooksSyncAdapter(context: Context) : SyncAdapterService.SyncAdapter(context) {
        override val outcomeService = SyncStatusStore.Service.CONTACTS

        override fun onPerformSyncDo(account: Account, extras: Bundle, authority: String, provider: ContentProviderClient, syncResult: SyncResult): Completion {
            val contactsProvider = context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY)
            if (contactsProvider == null) {
                Logger.log.severe("Couldn't access contacts provider")
                syncResult.databaseError = true
                return Completion.FAILURE
            }

            val settings = AccountSettings(context, account)
            if (!extras.containsKey(ContentResolver.SYNC_EXTRAS_MANUAL) && !checkSyncConditions(settings))
                return Completion.SKIPPED

            RefreshCollections(
                account,
                CollectionInfo.Type.ADDRESS_BOOK,
                extras.getBoolean(EXTRA_FORCE_COLLECTION_REFRESH, false),
            ).run()

            updateLocalAddressBooks(contactsProvider, account, settings)

            contactsProvider.release()

            val childAccounts = LocalAddressBook.find(context, null, account).map { it.androidAccount }.toSet()
            val attemptId = contactsAttempt(extras)
            if (attemptId == null) {
                syncResult.stats.numIoExceptions++
                syncResult.delayUntil = maxOf(syncResult.delayUntil, Constants.DEFAULT_RETRY_DELAY)
            } else {
                when (attachContactsChildrenAtAdapterBoundary(SyncStatusStore(context),
                    account, attemptId, childAccounts, System.currentTimeMillis(), syncRequestId(extras))) {
                    is SyncStatusStore.ContactsStart.Started,
                    SyncStatusStore.ContactsStart.SetupRequired -> Unit
                    SyncStatusStore.ContactsStart.StorageFailure -> signalPersistenceRetry(syncResult)
                }
            }
            for (addressBookAccount in childAccounts) {
                Logger.log.log(Level.INFO, "Running sync for address book", addressBookAccount)
                val syncExtras = Bundle(extras)
                syncExtras.putBoolean(ContentResolver.SYNC_EXTRAS_IGNORE_SETTINGS, true)
                syncExtras.putBoolean(ContentResolver.SYNC_EXTRAS_IGNORE_BACKOFF, true)
                syncExtras.putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)     // run immediately (don't queue)
                attemptId?.let { putContactsAttempt(syncExtras, it) }
                ContentResolver.requestSync(addressBookAccount, ContactsContract.AUTHORITY, syncExtras)
            }

            Logger.log.info("Address book sync complete")
            return Completion.DISPATCHED
        }

        override fun recordFailure(account: Account, extras: Bundle, category: SyncStatusStore.FailureCategory): SyncStatusStore.MutationResult {
            val safeCategory = if (category == SyncStatusStore.FailureCategory.PERMISSION) category else SyncStatusStore.FailureCategory.PARENT_REFRESH
            val attemptId = syncAttempt(extras) ?: return SyncStatusStore.MutationResult.REJECTED
            return SyncStatusStore(context).failContactsParentResult(account, attemptId, syncRequestId(extras), safeCategory)
        }

        private fun updateLocalAddressBooks(provider: ContentProviderClient, account: Account, settings: AccountSettings) {
            val remote = HashMap<String, CachedCollection>()
            val etebaseLocalCache = EtebaseLocalCache.getInstance(context, account.name)
            val collections: List<CachedCollection>
            synchronized(etebaseLocalCache) {
                HttpClient.Builder(context, settings).setForeground(false).build().use { httpClient ->
                    val etebase = EtebaseLocalCache.getEtebase(context, httpClient.okHttpClient, settings)
                    val colMgr = etebase.collectionManager

                    collections = etebaseLocalCache.collectionList(colMgr).filter { it.collectionType == Constants.ETEBASE_TYPE_ADDRESS_BOOK }
                }
            }

            for (collection in collections) {
                remote[collection.col.uid] = collection
            }

            val local = LocalAddressBook.find(context, provider, account)

            // delete obsolete local calendar
            for (addressBook in local) {
                val url = addressBook.url
                val collection = remote[url]
                if (collection == null) {
                    Logger.log.fine("Deleting obsolete local address book")
                    addressBook.delete()
                } else {
                    // remote CollectionInfo found for this local collection, update data
                    Logger.log.fine("Updating local address book")
                    addressBook.update(collection)
                    // we already have a local addressBook for this remote collection, don't take into consideration anymore
                    remote.remove(url)
                }
            }

            // create new local calendars
            for (url in remote.keys) {
                val cachedCollection = remote[url]!!
                Logger.log.info("Adding local address book")
                LocalAddressBook.create(context, provider, account, cachedCollection)
            }
        }
    }

}
