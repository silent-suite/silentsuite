/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.app.PendingIntent
import android.app.Service
import android.content.*
import android.database.sqlite.SQLiteException
import android.net.ConnectivityManager
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
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

abstract class SyncAdapterService : Service() {

    protected abstract fun syncAdapter(): AbstractThreadedSyncAdapter

    override fun onBind(intent: Intent): IBinder? {
        return syncAdapter().syncAdapterBinder
    }

    abstract class SyncAdapter(context: Context) : AbstractThreadedSyncAdapter(context, false) {
        private val syncErrorTitle: Int = R.string.sync_error_generic
        private val notificationManager = SyncNotification(context, "refresh-collections", Constants.NOTIFICATION_REFRESH_COLLECTIONS)

        abstract fun onPerformSyncDo(account: Account, extras: Bundle, authority: String, provider: ContentProviderClient, syncResult: SyncResult)

        override fun onPerformSync(account: Account, extras: Bundle, authority: String, provider: ContentProviderClient, syncResult: SyncResult) {
            Logger.log.log(Level.INFO, "$authority sync of $account has been initiated.", extras.keySet().toTypedArray())

            // required for dav4android (ServiceLoader)
            Thread.currentThread().contextClassLoader = context.classLoader

            notificationManager.cancel()

            // Check subscription status before allowing sync.
            // Check if walled garden mode is active — skip sync adapter in that mode
            val modePrefs = context.getSharedPreferences("app_mode", android.content.Context.MODE_PRIVATE)
            if (modePrefs.getString("sync_mode", "bridge") == "walled") {
                Logger.log.info("Sync skipped for $account: walled garden mode active")
                return
            }

            // Blocks sync when subscription is cancelled/expired (read-only mode).
            // Allows sync when billing API is unreachable (optimistic for dev/self-hosted).
            if (!BillingManager.getInstance().isSyncAllowed(context, account)) {
                Logger.log.info("Sync skipped for $account: subscription inactive")
                return
            }

            try {
                onPerformSyncDo(account, extras, authority, provider, syncResult)
            } catch (e: SecurityException) {
                // Shouldn't be needed - not sure why it doesn't fail
                onSecurityException(account, extras, authority, syncResult)
            } catch (e: TemporaryServerErrorException) {
                syncResult.stats.numIoExceptions++
                syncResult.delayUntil = Constants.DEFAULT_RETRY_DELAY
            } catch (e: ConnectionException) {
                syncResult.stats.numIoExceptions++
                syncResult.delayUntil = Constants.DEFAULT_RETRY_DELAY
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
            } catch (e: OutOfMemoryError) {
                val syncPhase = R.string.sync_phase_journals
                val title = context.getString(syncErrorTitle, account.name)
                notificationManager.setThrowable(e)
                val detailsIntent = notificationManager.detailsIntent
                detailsIntent.putExtra(Constants.KEY_ACCOUNT, account)
                notificationManager.notify(title, context.getString(syncPhase))
            }
        }

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
            val nm = NotificationManagerCompat.from(context)
            nm.notify(Constants.NOTIFICATION_PERMISSIONS, notify)
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

        inner class RefreshCollections internal constructor(private val account: Account, private val serviceType: CollectionInfo.Type) {
            private val context: Context

            init {
                context = getContext()
            }

            @Throws(InvalidAccountException::class)
            internal fun run() {
                Logger.log.info("Refreshing " + serviceType + " collections of service #" + serviceType.toString())

                val settings = AccountSettings(context, account)
                HttpClient.Builder(context, settings).setForeground(false).build().use { httpClient ->
                    val etebaseLocalCache = EtebaseLocalCache.getInstance(context, account.name)
                    synchronized(etebaseLocalCache) {
                        val cacheAge = 5 * 1000 // 5 seconds - it's just a hack for burst fetching
                        val now = System.currentTimeMillis()
                        val lastCollectionsFetch = collectionLastFetchMap[account.name] ?: 0

                        if (abs(now - lastCollectionsFetch) <= cacheAge) {
                            return@synchronized
                        }

                        val etebase = EtebaseLocalCache.getEtebase(context, httpClient.okHttpClient, settings)
                        val colMgr = etebase.collectionManager
                        var stoken = etebaseLocalCache.loadStoken()
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
