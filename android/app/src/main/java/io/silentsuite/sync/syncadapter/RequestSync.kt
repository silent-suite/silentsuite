package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.content.ContentResolver
import android.content.Context
import android.os.Bundle
import android.provider.CalendarContract
import io.silentsuite.sync.App
import io.silentsuite.sync.utils.TaskProviderHandling


const val EXTRA_FORCE_COLLECTION_REFRESH = "io.silentsuite.sync.FORCE_COLLECTION_REFRESH"

fun requestSync(context: Context, account: Account?, forceCollectionRefresh: Boolean = false) {
    val authorities = arrayOf(
            App.addressBooksAuthority,
            CalendarContract.AUTHORITY,
            TaskProviderHandling.getWantedTaskSyncProvider(context)?.authority
    )

    for (authority in authorities.filterNotNull()) {
        val extras = Bundle()
        extras.putBoolean(ContentResolver.SYNC_EXTRAS_MANUAL, true)        // manual sync
        extras.putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)     // run immediately (don't queue)
        if (forceCollectionRefresh) {
            extras.putBoolean(EXTRA_FORCE_COLLECTION_REFRESH, true)
        }
        ContentResolver.requestSync(account, authority, extras)
    }
}