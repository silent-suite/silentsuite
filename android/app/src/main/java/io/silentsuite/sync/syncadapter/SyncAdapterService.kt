/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.accounts.AccountManager
import android.app.PendingIntent
import android.app.Service
import android.content.*
import android.database.sqlite.SQLiteException
import android.net.ConnectivityManager
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.IBinder
import androidx.core.app.NotificationCompat
import at.bitfire.ical4android.CalendarStorageException
import at.bitfire.vcard4android.ContactsStorageException
import com.etebase.client.FetchOptions
import com.etebase.client.exceptions.ConnectionException
import com.etebase.client.exceptions.TemporaryServerErrorException
import com.etebase.client.exceptions.UnauthorizedException
import io.silentsuite.sync.*
import io.silentsuite.sync.Constants.COLLECTION_TYPES
import io.silentsuite.sync.billing.BillingManager
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.ui.DebugInfoActivity
import io.silentsuite.sync.ui.PermissionsActivity
import io.silentsuite.sync.utils.NotificationUtils
import java.lang.Math.abs
import java.util.*
import java.util.logging.Level

internal data class SyncCompletionSnapshot(
    val auth: Long,
    val io: Long,
    val parse: Long,
    val conflict: Long,
    val databaseError: Boolean,
    val fullSyncRequested: Boolean,
)

internal enum class CompletedOutcome { AUTHENTICATION_FAILURE, NETWORK_FAILURE, STORAGE_FAILURE, PROVIDER_FAILURE, SUCCESS, CANCELLED }

internal fun classifyCompletedOutcome(before: SyncCompletionSnapshot, after: SyncCompletionSnapshot, forceFailure: Boolean) = when {
    after.auth > before.auth -> CompletedOutcome.AUTHENTICATION_FAILURE
    after.io > before.io -> CompletedOutcome.NETWORK_FAILURE
    after.databaseError && !before.databaseError -> CompletedOutcome.STORAGE_FAILURE
    after.parse > before.parse || after.conflict > before.conflict || forceFailure -> CompletedOutcome.PROVIDER_FAILURE
    after.fullSyncRequested -> CompletedOutcome.CANCELLED
    else -> CompletedOutcome.SUCCESS
}

abstract class SyncAdapterService : Service() {

    protected abstract fun syncAdapter(): AbstractThreadedSyncAdapter

    override fun onBind(intent: Intent): IBinder? {
        return syncAdapter().syncAdapterBinder
    }

    abstract class SyncAdapter(context: Context) : AbstractThreadedSyncAdapter(context, false) {
        private val syncErrorTitle: Int = R.string.sync_error_generic
        protected enum class Completion { SUCCESS, FAILURE, SKIPPED, DISPATCHED }

        protected open val outcomeService: SyncStatusStore.Service? = null

        protected abstract fun onPerformSyncDo(account: Account, extras: Bundle, authority: String, provider: ContentProviderClient, syncResult: SyncResult): Completion

        override fun onPerformSync(account: Account, extras: Bundle, authority: String, provider: ContentProviderClient, syncResult: SyncResult) {
            Logger.log.log(Level.INFO, "$authority sync has been initiated.", extras.keySet().toTypedArray())
            // Capture once before sync work. The error-notification route must not inspect a
            // potentially replaced same-name AccountManager row after an asynchronous failure.
            val accountCreationId = AccountManager.get(context).getUserData(account, AccountSettings.KEY_CREATION_ID)
                ?.takeIf { it.isNotBlank() }
            val notificationManager = SyncNotification(
                context, "refresh-collections", Constants.NOTIFICATION_REFRESH_COLLECTIONS,
                account, accountCreationId
            )

            // required for dav4android (ServiceLoader)
            Thread.currentThread().contextClassLoader = context.classLoader

            notificationManager.cancel()

            // Check subscription status before allowing sync.
            // Blocks sync when subscription is cancelled/expired (read-only mode).
            // Allows sync when billing API is unreachable (optimistic for dev/self-hosted).
            if (!BillingManager.getInstance().isSyncAllowed(context, account)) {
                Logger.log.info("Sync skipped: subscription inactive")
                return
            }

            val before = snapshot(syncResult)
            try {
                val completion = onPerformSyncDo(account, extras, authority, provider, syncResult)
                when (completion) {
                    Completion.SUCCESS -> recordCompletedOutcome(account, extras, before, syncResult)
                    Completion.FAILURE -> recordCompletedOutcome(account, extras, before, syncResult, forceFailure = true)
                    Completion.SKIPPED, Completion.DISPATCHED -> Unit
                }
            } catch (e: SecurityException) {
                // Shouldn't be needed - not sure why it doesn't fail
                onSecurityException(account, extras, authority, syncResult)
                persistStatus(syncResult) { recordFailure(account, extras, SyncStatusStore.FailureCategory.PERMISSION) }
            } catch (e: TemporaryServerErrorException) {
                syncResult.stats.numIoExceptions++
                syncResult.delayUntil = Constants.DEFAULT_RETRY_DELAY
                persistStatus(syncResult) { recordFailure(account, extras, SyncStatusStore.FailureCategory.NETWORK) }
            } catch (e: ConnectionException) {
                syncResult.stats.numIoExceptions++
                syncResult.delayUntil = Constants.DEFAULT_RETRY_DELAY
                persistStatus(syncResult) { recordFailure(account, extras, SyncStatusStore.FailureCategory.NETWORK) }
            } catch (e: Exception) {
                if (e is ContactsStorageException || e is CalendarStorageException || e is SQLiteException) {
                    Logger.log.log(Level.SEVERE, "Couldn't prepare local journals", e)
                    syncResult.databaseError = true
                }

                val syncPhase = R.string.sync_phase_journals
                val title = context.getString(syncErrorTitle, account.name)

                notificationManager.setThrowable(e)

                val detailsIntent = notificationManager.detailsIntent
                detailsIntent.putExtra(Constants.KEY_ACCOUNT, account)
                if (e !is UnauthorizedException) {
                    detailsIntent.putExtra(DebugInfoActivity.KEY_AUTHORITY, authority)
                    detailsIntent.putExtra(DebugInfoActivity.KEY_PHASE, syncPhase)
                }

                notificationManager.notify(title, context.getString(syncPhase))
                persistStatus(syncResult) { recordFailure(account, extras, failureCategory(e)) }
            } catch (e: OutOfMemoryError) {
                val syncPhase = R.string.sync_phase_journals
                val title = context.getString(syncErrorTitle, account.name)
                notificationManager.setThrowable(e)
                val detailsIntent = notificationManager.detailsIntent
                detailsIntent.putExtra(Constants.KEY_ACCOUNT, account)
                notificationManager.notify(title, context.getString(syncPhase))
                persistStatus(syncResult) { recordFailure(account, extras, SyncStatusStore.FailureCategory.UNKNOWN) }
            }
        }

        protected open fun recordSuccess(account: Account, extras: Bundle): Boolean =
            outcomeService?.let { SyncStatusStore(context).recordSuccess(account, it) } ?: true

        protected open fun recordFailure(account: Account, extras: Bundle, category: SyncStatusStore.FailureCategory): Boolean =
            outcomeService?.let { SyncStatusStore(context).recordFailure(account, it, category) } ?: true

        private fun recordCompletedOutcome(account: Account, extras: Bundle, before: SyncCompletionSnapshot, result: SyncResult, forceFailure: Boolean = false) {
            val after = snapshot(result)
            val write = when (classifyCompletedOutcome(before, after, forceFailure)) {
                CompletedOutcome.AUTHENTICATION_FAILURE -> { { recordFailure(account, extras, SyncStatusStore.FailureCategory.AUTHENTICATION) } }
                CompletedOutcome.NETWORK_FAILURE -> { { recordFailure(account, extras, SyncStatusStore.FailureCategory.NETWORK) } }
                CompletedOutcome.STORAGE_FAILURE -> { { recordFailure(account, extras, SyncStatusStore.FailureCategory.STORAGE) } }
                CompletedOutcome.PROVIDER_FAILURE -> { { recordFailure(account, extras, SyncStatusStore.FailureCategory.PROVIDER) } }
                CompletedOutcome.SUCCESS -> { { recordSuccess(account, extras) } }
                CompletedOutcome.CANCELLED -> null
            }
            if (write != null) persistStatus(result, write)
        }

        private fun persistStatus(result: SyncResult, write: () -> Boolean) {
            if (!write()) {
                result.stats.numIoExceptions++
                result.delayUntil = maxOf(result.delayUntil, Constants.DEFAULT_RETRY_DELAY)
            }
        }

        private fun failureCategory(error: Exception) = when (error) {
            is UnauthorizedException -> SyncStatusStore.FailureCategory.AUTHENTICATION
            is ContactsStorageException, is CalendarStorageException, is SQLiteException -> SyncStatusStore.FailureCategory.STORAGE
            else -> SyncStatusStore.FailureCategory.UNKNOWN
        }

        private fun snapshot(result: SyncResult) =
            SyncCompletionSnapshot(
                result.stats.numAuthExceptions,
                result.stats.numIoExceptions,
                result.stats.numParseExceptions,
                result.stats.numConflictDetectedExceptions,
                result.databaseError,
                result.fullSyncRequested,
            )

        override fun onSecurityException(account: Account, extras: Bundle, authority: String, syncResult: SyncResult) {
            Logger.log.log(Level.WARNING, "Security exception when opening content provider for $authority")
            syncResult.databaseError = true

            val intent = Intent(context, PermissionsActivity::class.java)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

            val notify = NotificationUtils.newBuilder(context, NotificationUtils.CHANNEL_SYNC_ERRORS)
                    .setSmallIcon(R.drawable.ic_error_light)
                    .setLargeIcon(App.getLauncherBitmap(context))
                    .setContentTitle(context.getString(R.string.sync_error_permissions))
                    .setContentText(context.getString(R.string.sync_error_permissions_text))
                    .setContentIntent(PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                    .setCategory(NotificationCompat.CATEGORY_ERROR)
                    .build()
            NotificationUtils.notify(context, Constants.NOTIFICATION_PERMISSIONS, notify)
        }

        protected fun checkSyncConditions(settings: AccountSettings): Boolean {
            if (settings.syncWifiOnly) {
                val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                val network = cm.activeNetworkInfo
                if (network == null) {
                    Logger.log.info("No network available, stopping")
                    return false
                }
                if (network.type != ConnectivityManager.TYPE_WIFI || !network.isConnected) {
                    Logger.log.info("Not on connected WiFi, stopping")
                    return false
                }

                var onlySSID = settings.syncWifiOnlySSID
                if (onlySSID != null) {
                    onlySSID = "\"" + onlySSID + "\""
                    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                    val info = wifi.connectionInfo
                    if (info == null || onlySSID != info.ssid) {
                        Logger.log.info("Connected to wrong WiFi network (" + info!!.ssid + ", required: " + onlySSID + "), ignoring")
                        return false
                    }
                }
            }
            return true
        }

        inner class RefreshCollections internal constructor(
            private val account: Account,
            private val serviceType: CollectionInfo.Type,
            private val forceRefresh: Boolean = false,
        ) {
            private val context: Context

            init {
                context = getContext()
            }

            @Throws(InvalidAccountException::class)
            internal fun run() {
                Logger.log.info("Refreshing " + serviceType + " collections of service #" + serviceType.toString() + if (forceRefresh) " (forced)" else "")

                val settings = AccountSettings(context, account)
                HttpClient.Builder(context, settings).setForeground(false).build().use { httpClient ->
                    val etebaseLocalCache = EtebaseLocalCache.getInstance(context, account.name)
                    synchronized(etebaseLocalCache) {
                        val cacheAge = 5 * 1000 // 5 seconds - it's just a hack for burst fetching
                        val now = System.currentTimeMillis()
                        val lastCollectionsFetch = collectionLastFetchMap[account.name] ?: 0

                        if (!forceRefresh && abs(now - lastCollectionsFetch) <= cacheAge) {
                            return@synchronized
                        }

                        val etebase = EtebaseLocalCache.getEtebase(context, httpClient.okHttpClient, settings)
                        val colMgr = etebase.collectionManager
                        // Post-invite acceptance must not depend on the previous collection-list
                        // cursor: a full list refresh makes newly accepted shared collections
                        // visible even when an old stoken would otherwise hide the membership change.
                        var stoken = if (forceRefresh) null else etebaseLocalCache.loadStoken()
                        var done = false
                        while (!done) {
                            val colList = colMgr.list(COLLECTION_TYPES, FetchOptions().stoken(stoken))
                            for (col in colList.data) {
                                etebaseLocalCache.collectionSet(colMgr, col)
                            }

                            for (col in colList.removedMemberships) {
                                etebaseLocalCache.collectionUnset(colMgr, col.uid())
                            }

                            stoken = colList.stoken
                            done = colList.isDone
                            if (stoken != null) {
                                etebaseLocalCache.saveStoken(stoken)
                            }
                        }
                        collectionLastFetchMap[account.name] = now
                    }
                }
            }
        }
    }

    companion object {
        var collectionLastFetchMap = java.util.concurrent.ConcurrentHashMap<String, Long>()
    }
}
