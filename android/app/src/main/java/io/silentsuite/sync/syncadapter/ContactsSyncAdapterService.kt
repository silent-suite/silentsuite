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

internal data class ContactsChildTarget(
    val mainIdentity: SyncStatusStore.MainIdentity,
    val attemptId: String,
    val childIdentity: SyncStatusStore.ChildIdentity,
)

internal fun contactsChildTarget(mainIdentity: SyncStatusStore.MainIdentity?, attemptId: String?,
    childIdentity: SyncStatusStore.ChildIdentity?): ContactsChildTarget? =
    if (mainIdentity == null || attemptId.isNullOrBlank() || childIdentity == null) null
    else ContactsChildTarget(mainIdentity, attemptId, childIdentity)

internal fun contactsChildTarget(extras: Bundle): ContactsChildTarget? = contactsChildTarget(
    SyncStatusStore.identityFromStorageKey(extras.getString(SyncStatusStore.EXTRA_CONTACTS_MAIN_IDENTITY)),
    contactsAttempt(extras),
    SyncStatusStore.childIdentityFromStorageKey(extras.getString(SyncStatusStore.EXTRA_CONTACTS_CHILD_IDENTITY)),
)

internal fun contactsChildGenerationMatches(store: SyncStatusStore, child: Account, target: ContactsChildTarget): Boolean =
    runCatching { store.childIdentity(child) == target.childIdentity }.getOrDefault(false)

internal fun contactsLifecycleTargetMatches(
    store: SyncStatusStore,
    child: Account,
    target: ContactsChildTarget,
    storedMainIdentity: SyncStatusStore.MainIdentity?,
    currentMainAccount: Account?,
): Boolean = contactsChildGenerationMatches(store, child, target) &&
    contactsParentGenerationMatches(store, target, storedMainIdentity, currentMainAccount)

internal fun contactsParentGenerationMatches(
    store: SyncStatusStore,
    target: ContactsChildTarget,
    storedMainIdentity: SyncStatusStore.MainIdentity?,
    currentMainAccount: Account?,
): Boolean = storedMainIdentity == target.mainIdentity &&
    currentMainAccount != null && store.identity(currentMainAccount) == target.mainIdentity

internal fun contactsLifecycleTargetMatchesCurrent(
    context: Context,
    store: SyncStatusStore,
    child: Account,
    target: ContactsChildTarget,
): Boolean = runCatching {
    val accountManager = android.accounts.AccountManager.get(context)
    contactsLifecycleTargetMatches(
        store,
        child,
        target,
        SyncStatusStore.identityFromStorageKey(
            accountManager.getUserData(child, LocalAddressBook.USER_DATA_MAIN_ACCOUNT_IDENTITY)),
        LocalAddressBook(context, child, null).mainAccount,
    )
}.getOrDefault(false)

internal fun contactsParentGenerationMatchesCurrent(
    context: Context,
    store: SyncStatusStore,
    child: Account,
    target: ContactsChildTarget,
): Boolean = runCatching {
    val accountManager = android.accounts.AccountManager.get(context)
    contactsParentGenerationMatches(
        store,
        target,
        SyncStatusStore.identityFromStorageKey(
            accountManager.getUserData(child, LocalAddressBook.USER_DATA_MAIN_ACCOUNT_IDENTITY)),
        LocalAddressBook(context, child, null).mainAccount,
    )
}.getOrDefault(false)

internal fun hasContactsLifecycleTarget(extras: Bundle): Boolean =
    extras.containsKey(SyncStatusStore.EXTRA_CONTACTS_ATTEMPT) ||
        extras.containsKey(SyncStatusStore.EXTRA_CONTACTS_MAIN_IDENTITY) ||
        extras.containsKey(SyncStatusStore.EXTRA_CONTACTS_CHILD_IDENTITY)

/** The parent and child adapters share this correlation-only lifecycle boundary. */
internal fun attachContactsChildrenAtAdapterBoundary(
    store: SyncStatusStore,
    parent: SyncStatusStore.MainIdentity,
    attemptId: String,
    children: Set<SyncStatusStore.ChildIdentity>,
    startedAt: Long,
    requestId: String? = null,
): SyncStatusStore.ContactsStart = store.attachContactsChildren(parent, attemptId, children, startedAt, requestId)

/** Preserve stale-vs-storage semantics through the real child-adapter completion boundary. */
internal fun recordContactsChildAtAdapterBoundary(
    store: SyncStatusStore,
    target: ContactsChildTarget,
    result: SyncStatusStore.ChildResult,
    category: SyncStatusStore.FailureCategory = SyncStatusStore.FailureCategory.PROVIDER,
    timestamp: Long = System.currentTimeMillis(),
): SyncStatusStore.MutationResult = when (
    store.recordContactsChild(target.mainIdentity, target.attemptId, target.childIdentity, result, category, timestamp)
) {
    SyncStatusStore.ChildWrite.RECORDED -> SyncStatusStore.MutationResult.RECORDED
    SyncStatusStore.ChildWrite.REJECTED -> SyncStatusStore.MutationResult.REJECTED
    SyncStatusStore.ChildWrite.STORAGE_FAILURE -> SyncStatusStore.MutationResult.STORAGE_FAILURE
}

internal fun closeReplacedContactsChildAtAdapterBoundary(
    store: SyncStatusStore,
    target: ContactsChildTarget,
    parentGenerationCurrent: Boolean,
): SyncStatusStore.MutationResult = if (!parentGenerationCurrent) SyncStatusStore.MutationResult.REJECTED else
    recordContactsChildAtAdapterBoundary(store, target, SyncStatusStore.ChildResult.REMOVED,
        SyncStatusStore.FailureCategory.CHILD_REMOVED)

internal fun putContactsAttempt(extras: Bundle, attemptId: String) {
    extras.putString(SyncStatusStore.EXTRA_CONTACTS_ATTEMPT, attemptId)
}

internal fun contactsAttempt(extras: Bundle): String? = extras.getString(SyncStatusStore.EXTRA_CONTACTS_ATTEMPT)
internal fun contactsMainIdentity(extras: Bundle): SyncStatusStore.MainIdentity? =
    SyncStatusStore.identityFromStorageKey(extras.getString(SyncStatusStore.EXTRA_CONTACTS_MAIN_IDENTITY))

internal fun putContactsParent(extras: Bundle, mainIdentity: SyncStatusStore.MainIdentity, attemptId: String) {
    putContactsAttempt(extras, attemptId)
    extras.putString(SyncStatusStore.EXTRA_CONTACTS_MAIN_IDENTITY, mainIdentity.storageKey)
}

internal fun putContactsTarget(extras: Bundle, mainIdentity: SyncStatusStore.MainIdentity, attemptId: String,
    childIdentity: SyncStatusStore.ChildIdentity) {
    putContactsParent(extras, mainIdentity, attemptId)
    extras.putString(SyncStatusStore.EXTRA_CONTACTS_CHILD_IDENTITY, childIdentity.storageKey)
}

class ContactsSyncAdapterService : SyncAdapterService() {

    override fun syncAdapter(): AbstractThreadedSyncAdapter {
        return ContactsSyncAdapter(this)
    }


    private class ContactsSyncAdapter(context: Context) : SyncAdapterService.SyncAdapter(context) {
        override fun onPerformSyncDo(account: Account, extras: Bundle, authority: String, provider: ContentProviderClient, syncResult: SyncResult): Completion {
            val lifecycleTarget = contactsChildTarget(extras)
            if (hasContactsLifecycleTarget(extras) &&
                (lifecycleTarget == null ||
                    !contactsLifecycleTargetMatchesCurrent(context, SyncStatusStore(context), account, lifecycleTarget))) {
                if (lifecycleTarget != null) {
                    val store = SyncStatusStore(context)
                    val closed = closeReplacedContactsChildAtAdapterBoundary(store, lifecycleTarget,
                        contactsParentGenerationMatchesCurrent(context, store, account, lifecycleTarget))
                    if (closed == SyncStatusStore.MutationResult.STORAGE_FAILURE) signalPersistenceRetry(syncResult)
                }
                Logger.log.info("Skipping sync for a replaced address-book generation")
                return Completion.SKIPPED
            }
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
            val target = contactsChildTarget(extras) ?: return SyncStatusStore.MutationResult.REJECTED
            val store = SyncStatusStore(context)
            if (!contactsLifecycleTargetMatchesCurrent(context, store, child, target))
                return closeReplacedContactsChildAtAdapterBoundary(store, target,
                    contactsParentGenerationMatchesCurrent(context, store, child, target))
            return recordContactsChildAtAdapterBoundary(store, target, result, category)
        }
    }

}
