/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.ui.settings.SettingsCategory

/**
 * Legacy AccountSettingsActivity — now redirects to the consolidated AppSettingsActivity.
 * Kept for backward compatibility with notification intents and manifest declarations.
 */
class AccountSettingsActivity : BaseActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Redirect while preserving the generation that the legacy intent captured.
        startActivity(redirectIntent(this, intent))
        finish()
    }

    companion object {
        fun newIntent(
            context: Context,
            account: Account,
            category: SettingsCategory = SettingsCategory.SYNC
        ): Intent = Intent(context, AccountSettingsActivity::class.java)
            .putExtra(AppSettingsActivity.EXTRA_ACCOUNT, account)
            .putExtra(
                AppSettingsActivity.EXTRA_CREATION_ID,
                AccountManager.get(context).getUserData(account, AccountSettings.KEY_CREATION_ID)
            )
            .putExtra(AppSettingsActivity.EXTRA_CATEGORY, category.route)

        internal fun redirectIntent(context: Context, source: Intent): Intent {
            val category = SettingsCategory.fromRoute(
                source.getStringExtra(AppSettingsActivity.EXTRA_CATEGORY)
            ).takeUnless { it == SettingsCategory.HOME } ?: SettingsCategory.SYNC
            return if (source.hasExtra(AppSettingsActivity.EXTRA_ACCOUNT) ||
                source.hasExtra(AppSettingsActivity.EXTRA_CREATION_ID)) {
                val account = source.getParcelableExtra<Account>(AppSettingsActivity.EXTRA_ACCOUNT)
                val creationId = source.getStringExtra(AppSettingsActivity.EXTRA_CREATION_ID)
                if (account != null && !creationId.isNullOrBlank())
                    AppSettingsActivity.newIntent(context, account, creationId, category)
                else Intent(context, AppSettingsActivity::class.java).apply {
                    // Preserve malformed explicitness so AppSettings fails closed instead of
                    // redirecting to a mutable active account.
                    account?.let { putExtra(AppSettingsActivity.EXTRA_ACCOUNT, it) }
                    putExtra(AppSettingsActivity.EXTRA_CREATION_ID, creationId)
                    putExtra(AppSettingsActivity.EXTRA_CATEGORY, category.route)
                }
            }
            else AppSettingsActivity.newIntent(context, category)
        }
    }
}
