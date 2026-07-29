package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.content.ContentResolver
import android.content.Context
import android.os.Bundle
import android.provider.CalendarContract
import io.silentsuite.sync.App
import io.silentsuite.sync.utils.TaskProviderHandling
import java.util.UUID
import androidx.annotation.VisibleForTesting


const val EXTRA_FORCE_COLLECTION_REFRESH = "io.silentsuite.sync.FORCE_COLLECTION_REFRESH"
const val EXTRA_SYNC_REQUEST_ID = "io.silentsuite.sync.SYNC_REQUEST_ID"

/** Test-only dispatch hold; production always delegates to ContentResolver. */
@VisibleForTesting
internal var requestSyncDispatchOverride: ((Account?, String, Bundle) -> Unit)? = null

fun putSyncRequestId(extras: Bundle, requestId: String) = extras.putString(EXTRA_SYNC_REQUEST_ID, requestId)
fun syncRequestId(extras: Bundle): String? = extras.getString(EXTRA_SYNC_REQUEST_ID)?.takeIf { it.isNotBlank() }

fun requestSync(
    context: Context,
    account: Account?,
    forceCollectionRefresh: Boolean = false,
    explicitRequestId: String? = null,
) {
    val authorities = linkedMapOf(
        App.addressBooksAuthority to SyncStatusStore.Service.CONTACTS,
        CalendarContract.AUTHORITY to SyncStatusStore.Service.CALENDAR,
    ).apply {
        TaskProviderHandling.getWantedTaskSyncProvider(context)?.authority?.let {
            put(it, SyncStatusStore.Service.TASKS)
        }
    }
    val requestId = explicitRequestId ?: UUID.randomUUID().toString()
    val statusStore = account?.let { SyncStatusStore(context) }
    val requestedIdentity = account?.let { statusStore?.identity(it) }

    // Durable UI evidence must lead scheduling, but a storage failure never blocks real sync.
    requestedIdentity?.let {
        statusStore?.recordRequested(it, authorities.values.toSet(), requestId, System.currentTimeMillis())
    }

    for ((authority, _) in authorities) {
        val extras = Bundle()
        extras.putBoolean(ContentResolver.SYNC_EXTRAS_MANUAL, true)        // manual sync
        extras.putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)     // run immediately (don't queue)
        if (forceCollectionRefresh) {
            extras.putBoolean(EXTRA_FORCE_COLLECTION_REFRESH, true)
        }
        requestedIdentity?.let {
            putSyncRequestId(extras, requestId)
            putSyncMainIdentity(extras, it)
        }
        requestSyncDispatchOverride?.invoke(account, authority, extras)
            ?: ContentResolver.requestSync(account, authority, extras)
    }
}
