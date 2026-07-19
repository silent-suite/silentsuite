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
import at.bitfire.vcard4android.ContactsStorageException
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.Constants
import io.silentsuite.sync.InvalidAccountException
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.resource.LocalAddressBook
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal data class ContactsChildTarget(val mainAccount: Account, val attemptId: String)

internal fun contactsChildTarget(mainAccount: Account?, attemptId: String?): ContactsChildTarget? =
    if (mainAccount == null || attemptId.isNullOrBlank()) null else ContactsChildTarget(mainAccount, attemptId)

/** The parent and child adapters share this correlation-only lifecycle boundary. */
internal fun attachContactsChildrenAtAdapterBoundary(
    store: SyncStatusStore,
    parent: Account,
    attemptId: String,
    children: Set<Account>,
    startedAt: Long,
    requestId: String? = null,
): SyncStatusStore.ContactsStart = store.attachContactsChildren(parent, attemptId, children, startedAt, requestId)

/** Preserve stale-vs-storage semantics through the real child-adapter completion boundary. */
internal fun recordContactsChildAtAdapterBoundary(
    store: SyncStatusStore,
    target: ContactsChildTarget,
    child: Account,
    result: SyncStatusStore.ChildResult,
    category: SyncStatusStore.FailureCategory = SyncStatusStore.FailureCategory.PROVIDER,
    timestamp: Long = System.currentTimeMillis(),
): SyncStatusStore.MutationResult = when (
    store.recordContactsChild(target.mainAccount, target.attemptId, child, result, category, timestamp)
) {
    SyncStatusStore.ChildWrite.RECORDED -> SyncStatusStore.MutationResult.RECORDED
    SyncStatusStore.ChildWrite.REJECTED -> SyncStatusStore.MutationResult.REJECTED
    SyncStatusStore.ChildWrite.STORAGE_FAILURE -> SyncStatusStore.MutationResult.STORAGE_FAILURE
}

internal fun putContactsAttempt(extras: Bundle, attemptId: String) {
    extras.putString(SyncStatusStore.EXTRA_CONTACTS_ATTEMPT, attemptId)
}

internal fun contactsAttempt(extras: Bundle): String? = extras.getString(SyncStatusStore.EXTRA_CONTACTS_ATTEMPT)

class ContactsSyncAdapterService : SyncAdapterService() {

    override fun syncAdapter(): AbstractThreadedSyncAdapter {
        return ContactsSyncAdapter(this)
    }


    private class ContactsSyncAdapter(context: Context) : SyncAdapterService.SyncAdapter(context) {
        override fun onPerformSyncDo(account: Account, extras: Bundle, authority: String, provider: ContentProviderClient, syncResult: SyncResult): Completion {
            val addressBook = LocalAddressBook(context, account, provider)

            val settings: AccountSettings
            try {
                settings = AccountSettings(context, addressBook.mainAccount)
            } catch (e: InvalidAccountException) {
                Logger.log.info("Skipping sync due to invalid account.")
                Logger.log.info("Invalid account: ${e.javaClass.name}")
                return Completion.SKIPPED
            } catch (e: ContactsStorageException) {
                Logger.log.info("Skipping sync due to invalid account.")
                Logger.log.info("Invalid account: ${e.javaClass.name}")
                return Completion.SKIPPED
            }

            if (!extras.containsKey(ContentResolver.SYNC_EXTRAS_MANUAL) && !checkSyncConditions(settings))
                return Completion.SKIPPED

            Logger.log.info("Synchronizing address book")
            Logger.log.info("Taking settings from main account")

            val principal = settings.uri?.toHttpUrlOrNull() ?: run {
                Logger.log.warning("Contacts sync skipped: no valid URI")
                return Completion.SKIPPED
            }
            val providerOutcome = ContactsSyncManager(context, account, settings, extras, authority, provider, syncResult, addressBook, principal).use { it.performSync() }

            Logger.log.info("Contacts sync complete")
            return when (providerOutcome) {
                SyncManager.ProviderOutcome.FAILURE -> Completion.FAILURE
                SyncManager.ProviderOutcome.CANCELLED -> Completion.SKIPPED
                SyncManager.ProviderOutcome.SUCCESS -> Completion.SUCCESS
                SyncManager.ProviderOutcome.SKIPPED -> Completion.SKIPPED
            }
        }

        override fun recordSuccess(account: Account, extras: Bundle): SyncStatusStore.MutationResult =
            recordChild(account, extras, SyncStatusStore.ChildResult.SUCCESS)

        override fun recordFailure(account: Account, extras: Bundle, category: SyncStatusStore.FailureCategory): SyncStatusStore.MutationResult =
            recordChild(account, extras, SyncStatusStore.ChildResult.FAILURE, category)

        // A skipped child has no terminal outcome. Recording the generation-local skip lets the
        // final child close the parent lifecycle without inventing a success or failure.
        override fun finishWithoutOutcome(account: Account, extras: Bundle): SyncStatusStore.MutationResult =
            recordChild(account, extras, SyncStatusStore.ChildResult.SKIPPED)

        private fun recordChild(
            child: Account,
            extras: Bundle,
            result: SyncStatusStore.ChildResult,
            category: SyncStatusStore.FailureCategory = SyncStatusStore.FailureCategory.PROVIDER,
        ): SyncStatusStore.MutationResult {
            val main = runCatching { LocalAddressBook(context, child, null).mainAccount }.getOrNull()
            val target = contactsChildTarget(main, contactsAttempt(extras)) ?: return SyncStatusStore.MutationResult.REJECTED
            return recordContactsChildAtAdapterBoundary(SyncStatusStore(context), target, child, result, category)
        }
    }

}
