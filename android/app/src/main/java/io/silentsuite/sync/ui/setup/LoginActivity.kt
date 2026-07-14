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

import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.WebViewActivity
import java.util.UUID

/**
 * Activity to initially connect to a server and create an account.
 * Login credentials are entered only in the UI and remain process-only.
 */
class LoginActivity : BaseActivity() {

    companion object {
        const val EXTRA_SIGNUP_CONTINUATION_TOKEN = "io.silentsuite.sync.extra.SIGNUP_CONTINUATION_TOKEN"
        private const val KEY_FLOW_ID = "signup_flow_id"
    }

    private lateinit var authenticatorResponse: AuthenticatorResponseController
    private lateinit var flowId: String

    public override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        flowId = savedInstanceState?.getString(KEY_FLOW_ID) ?: UUID.randomUUID().toString()
        authenticatorResponse = AuthenticatorResponseController(intent, savedInstanceState)

        if (savedInstanceState == null) {
            showLoginFragment()
        }

    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val continuationToken = intent.getStringExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN)
        if (SignupContinuationRegistry.consume(continuationToken, flowId)) {
            showLoginFragment()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        authenticatorResponse.onSaveInstanceState(outState)
        outState.putString(KEY_FLOW_ID, flowId)
        super.onSaveInstanceState(outState)
    }

    override fun finish() {
        val wasCompleted = authenticatorResponse.isCompleted
        SignupContinuationRegistry.remove(flowId)
        authenticatorResponse.finish()
        if (!wasCompleted)
            SetupSecretHolder.clearProcessOnlySecrets()
        super.finish()
    }

    fun onAccountCreated(account: android.accounts.Account) {
        authenticatorResponse.complete(account)
    }

    fun issueSignupCallbackUri(): android.net.Uri {
        val token = SignupContinuationRegistry.issue(flowId)
        return Constants.signupCompleteReturnUri.buildUpon()
            .appendQueryParameter("continuation", token)
            .build()
    }

    private fun showLoginFragment() {
        supportFragmentManager.beginTransaction()
                .replace(android.R.id.content, LoginCredentialsFragment())
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
