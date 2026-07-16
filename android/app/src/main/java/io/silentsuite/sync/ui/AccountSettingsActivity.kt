/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.os.Bundle
import android.accounts.Account

/**
 * Legacy AccountSettingsActivity — now redirects to the consolidated AppSettingsActivity.
 * Kept for backward compatibility with notification intents and manifest declarations.
 */
class AccountSettingsActivity : BaseActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // An explicit legacy account route must retain its already-captured generation. Never
        // re-resolve a mutable same-name row while forwarding notification settings.
        val account = intent.getParcelableExtra<Account>(AppSettingsActivity.EXTRA_ACCOUNT)
        val creationId = intent.getStringExtra(AppSettingsActivity.EXTRA_CREATION_ID)
        val settingsIntent = when {
            account == null -> AppSettingsActivity.newIntent(this)
            !creationId.isNullOrBlank() -> AppSettingsActivity.newIntent(this, account, creationId)
            else -> null
        }
        settingsIntent?.let(::startActivity)
        finish()
    }
}
