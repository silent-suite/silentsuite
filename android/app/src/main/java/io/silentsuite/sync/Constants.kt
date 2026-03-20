/*
 * Copyright © 2013 – 2015 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 *
 * Modified by Silent Suite
 */
package io.silentsuite.sync

import android.net.Uri

object Constants {
    // notification IDs
    const val NOTIFICATION_ACCOUNT_SETTINGS_UPDATED = 0
    const val NOTIFICATION_EXTERNAL_FILE_LOGGING = 1
    const val NOTIFICATION_REFRESH_COLLECTIONS = 2
    const val NOTIFICATION_CONTACTS_SYNC = 10
    const val NOTIFICATION_CALENDAR_SYNC = 11
    const val NOTIFICATION_TASK_SYNC = 12
    const val NOTIFICATION_ACCOUNT_UPDATE = 13
    const val NOTIFICATION_PERMISSIONS = 20

    val webUri: Uri = Uri.parse("https://silentsuite.io/")
    val webAppUri: Uri = Uri.parse("https://app.silentsuite.io/")
    val docsUri: Uri = Uri.parse("https://docs.silentsuite.io/")
    val etebaseDashboardPrefix: Uri = Uri.parse("https://dashboard.silentsuite.io/user/partner/")
    val contactUri: Uri = webUri.buildUpon().appendEncodedPath("about/#contact").build()
    val registrationUrl: Uri = webUri.buildUpon().appendEncodedPath("accounts/signup/").build()
    val reportIssueUri: Uri = Uri.parse("https://github.com/silent-suite/silentsuite/issues")
    val feedbackUri: Uri = reportIssueUri
    val pricing: Uri = webUri.buildUpon().appendEncodedPath("pricing/").build()
    val dashboard: Uri = webUri.buildUpon().appendEncodedPath("dashboard/").build()
    val faqUri: Uri = docsUri.buildUpon().appendEncodedPath("faq/").build()
    val helpUri: Uri = docsUri
    val forgotPassword: Uri = webAppUri.buildUpon().appendEncodedPath("forgot-password").build()

    // TODO(Phase2): Add Sentry crash reporting URL
    const val crashReportingUrl = ""

    val serviceUrl: Uri = Uri.parse(if (BuildConfig.DEBUG_REMOTE_URL == null) "https://server.silentsuite.io/" else BuildConfig.DEBUG_REMOTE_URL)
    val etebaseServiceUrl: String = if (BuildConfig.DEBUG_REMOTE_URL == null) "https://server.silentsuite.io/" else BuildConfig.DEBUG_REMOTE_URL

    val PRODID_BASE = "-//SilentSuite//${BuildConfig.APPLICATION_ID}/${BuildConfig.VERSION_NAME}"

    val DEFAULT_SYNC_INTERVAL = 4 * 3600  // 4 hours
    val DEFAULT_RETRY_DELAY = 30L * 60  // 30 minutes

    const val KEY_ACCOUNT = "account"
    const val KEY_COLLECTION_INFO = "collectionInfo"

    const val ETEBASE_TYPE_ADDRESS_BOOK = "etebase.vcard"
    const val ETEBASE_TYPE_CALENDAR = "etebase.vevent"
    const val ETEBASE_TYPE_TASKS = "etebase.vtodo"
    val COLLECTION_TYPES = arrayOf(
        ETEBASE_TYPE_ADDRESS_BOOK,
        ETEBASE_TYPE_CALENDAR,
        ETEBASE_TYPE_TASKS
    )
}
