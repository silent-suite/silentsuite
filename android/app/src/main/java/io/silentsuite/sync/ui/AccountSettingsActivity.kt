/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.os.Bundle

/**
 * Legacy AccountSettingsActivity — now redirects to the consolidated AppSettingsActivity.
 * Kept for backward compatibility with notification intents and manifest declarations.
 */
class AccountSettingsActivity : BaseActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A notification route may be stale or malformed. Fail closed rather than letting the
        // AppSettings intent factory throw, and never recover a generation from the current row.
        val account = intent.getParcelableExtra<android.accounts.Account>(AppSettingsActivity.EXTRA_ACCOUNT)
        val creationId = intent.getStringExtra(AppSettingsActivity.EXTRA_CREATION_ID)?.takeIf { it.isNotBlank() }
        if (account == null || creationId == null) {
            finish()
            return
        }
        startActivity(AppSettingsActivity.newIntent(this, account, creationId))
        finish()
    }
}
