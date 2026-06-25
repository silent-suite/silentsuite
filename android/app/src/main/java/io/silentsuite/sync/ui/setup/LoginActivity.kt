/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.setup

import android.content.Intent
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem

import io.silentsuite.sync.BuildConfig
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.WebViewActivity

/**
 * Activity to initially connect to a server and create an account.
 * Fields for server/user data can be pre-filled with extras in the Intent.
 */
class LoginActivity : BaseActivity() {

    companion object {
        const val EXTRA_INITIAL_USERNAME = "io.silentsuite.sync.extra.INITIAL_USERNAME"
        const val EXTRA_INITIAL_PASSWORD = "io.silentsuite.sync.extra.INITIAL_PASSWORD"
    }

    public override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (savedInstanceState == null) {
            showLoginFragment(intent)
        }

    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        showLoginFragment(intent)
    }

    private fun showLoginFragment(intent: Intent) {
        // Optional extras are only for debug screenshot instrumentation.
        // Do not accept plaintext credential prefill extras in release builds.
        val initialUsername = if (BuildConfig.DEBUG) intent.getStringExtra(EXTRA_INITIAL_USERNAME) else null
        val initialPassword = if (BuildConfig.DEBUG) intent.getStringExtra(EXTRA_INITIAL_PASSWORD) else null
        supportFragmentManager.beginTransaction()
                .replace(android.R.id.content, LoginCredentialsFragment.newInstance(initialUsername, initialPassword))
                .commit()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.activity_login, menu)
        return true
    }

    fun showHelp(item: MenuItem) {
        WebViewActivity.openUrl(this, Constants.helpUri)
    }
}
