package io.silentsuite.sync.syncadapter

import android.app.Activity
import android.app.PendingIntent
import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteException
import android.net.Uri
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import at.bitfire.ical4android.CalendarStorageException
import at.bitfire.vcard4android.ContactsStorageException
import com.etebase.client.exceptions.*
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.ui.AppSettingsActivity
import io.silentsuite.sync.ui.DebugInfoActivity
import io.silentsuite.sync.ui.WebViewActivity
import io.silentsuite.sync.utils.NotificationUtils
import io.silentsuite.sync.ui.settings.SettingsCategory
import java.util.logging.Level

class SyncNotification(internal val context: Context, internal val notificationTag: String, internal val notificationId: Int) {

    internal val notificationManager: NotificationManagerCompat
    lateinit var detailsIntent: Intent
        internal set
    internal var messageInt: Int = 0
    internal var messageString: String? = null

    private var throwable: Throwable? = null

    init {
        this.notificationManager = NotificationManagerCompat.from(context)
    }

    fun setThrowable(e: Throwable) {
        throwable = e
        if (e is UnauthorizedException) {
            Logger.log.log(Level.SEVERE, "Not authorized anymore", e)
            messageInt = R.string.sync_error_unauthorized
        } else if (e is TemporaryServerErrorException) {
            Logger.log.log(Level.SEVERE, "Service unavailable")
            messageInt = R.string.sync_error_unavailable
        } else if (e is PermissionDeniedException) {
            Logger.log.log(Level.SEVERE, "Permission denied", e)
            messageString = context.getString(R.string.sync_error_permission_denied, e.localizedMessage)
        } else if (e is ServerErrorException || e is HttpException) {
            Logger.log.log(Level.SEVERE, "HTTP Exception during sync", e)
            messageInt = R.string.sync_error_http_dav
        } else if (e is CalendarStorageException || e is ContactsStorageException || e is SQLiteException) {
            Logger.log.log(Level.SEVERE, "Couldn't access local storage", e)
            messageInt = R.string.sync_error_local_storage
        } else {
            Logger.log.log(Level.SEVERE, "Unknown sync error", e)
            messageInt = R.string.sync_error
        }

        detailsIntent = Intent(context, NotificationHandlerActivity::class.java)
        detailsIntent.putExtra(DebugInfoActivity.KEY_THROWABLE, e)
        detailsIntent.data = Uri.parse("uri://" + javaClass.name + "/" + notificationTag)
    }

    /** Captures the generation when the notification is created, not when an old one is tapped. */
    fun setAccount(account: Account) {
        detailsIntent.putExtra(Constants.KEY_ACCOUNT, account)
        detailsIntent.putExtra(
            AppSettingsActivity.EXTRA_CREATION_ID,
            AccountManager.get(context).getUserData(account, AccountSettings.KEY_CREATION_ID)
        )
    }

    fun notify(title: String, state: String) {
        val message = messageString ?: context.getString(messageInt, state)
        notify(title, message, null, detailsIntent)
    }

    @JvmOverloads
    fun notify(title: String, content: String, bigText: String?, intent: Intent, _icon: Int = -1) {
        var icon = _icon
        val category: String;
        val channel: String;
        if (throwable == null) {
            category = NotificationCompat.CATEGORY_STATUS
            channel = NotificationUtils.CHANNEL_SYNC_STATUS
        } else {
            category = NotificationCompat.CATEGORY_ERROR
            channel = NotificationUtils.CHANNEL_SYNC_ERRORS
        }
        val builder = NotificationUtils.newBuilder(context, channel)
        if (icon == -1) {
            //Check if error was configured
            if (throwable == null) {
                icon = R.drawable.ic_sync_dark
            } else {
                icon = R.drawable.ic_error_light
            }
        }

        builder .setContentTitle(title)
                .setContentText(content)
                .setAutoCancel(true)
                .setCategory(category)
                .setSmallIcon(icon)
                .setContentIntent(PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))

        if (bigText != null)
            builder.setStyle(NotificationCompat.BigTextStyle()
                    .bigText(bigText))

        NotificationUtils.notify(context, notificationManager, notificationTag, notificationId, builder.build())
    }


    fun cancel() {
        notificationManager.cancel(notificationTag, notificationId)
    }

    class NotificationHandlerActivity : Activity() {

        public override fun onCreate(savedBundle: Bundle?) {
            super.onCreate(savedBundle)
            val extras = intent.extras ?: run {
                finish()
                return
            }
            val e = extras.get(DebugInfoActivity.KEY_THROWABLE) as? Exception ?: run {
                finish()
                return
            }

            val detailsIntent: Intent
            if (e is UnauthorizedException || e is PermissionDeniedException) {
                detailsIntent = settingsIntent(this, extras)
            } else if (e is AccountSettings.AccountMigrationException) {
                WebViewActivity.openUrl(this, Constants.faqUri.buildUpon().encodedFragment("account-migration-error").build())
                return
            } else {
                detailsIntent = DebugInfoActivity.newIntent(this, this::class.toString())
            }
            if (detailsIntent.component?.className != AppSettingsActivity::class.java.name)
                detailsIntent.putExtras(extras)
            startActivity(detailsIntent)
        }

        public override fun onStop() {
            super.onStop()
            finish()
        }
    }

    companion object {
        internal fun settingsIntent(context: Context, extras: Bundle): Intent =
            AppSettingsActivity.newIntent(
                context,
                extras.getParcelable<Account>(Constants.KEY_ACCOUNT),
                extras.getString(AppSettingsActivity.EXTRA_CREATION_ID),
                SettingsCategory.SYNC
            )
    }
}
