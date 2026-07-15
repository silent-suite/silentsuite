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
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.WebViewActivity
import java.util.UUID

/**
 * Activity to initially connect to a server and create an account.
 * Login credentials are entered only in the UI and remain process-only.
 */
open class LoginActivity : BaseActivity() {

    companion object {
        const val EXTRA_SIGNUP_CONTINUATION_TOKEN = "io.silentsuite.sync.extra.SIGNUP_CONTINUATION_TOKEN"
        private const val KEY_FLOW_ID = "signup_flow_id"
        private const val KEY_PROCESS_EPOCH = "authenticator_process_epoch"
        internal const val KEY_WAS_AUTHENTICATOR = "authenticator_was_authenticator"
        @JvmField internal var obsoleteSeamsFactory: ((LoginActivity, Intent, Bundle?) -> ObsoleteAuthenticatorCoordinator.Seams)? = null
        @JvmField internal var controllerFactory: ((Intent, Bundle?) -> AuthenticatorResponseController)? = null
    }

    private lateinit var authenticatorResponse: AuthenticatorResponseController
    private lateinit var flowId: String

    public override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        flowId = savedInstanceState?.getString(KEY_FLOW_ID) ?: UUID.randomUUID().toString()
        val restoredAuthenticator = savedInstanceState?.getBoolean(KEY_WAS_AUTHENTICATOR, false) == true ||
            (savedInstanceState != null && intent.hasExtra(android.accounts.AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE))
        if (AuthenticatorRestorePolicy.mustRestartNormally(restoredAuthenticator,
                savedInstanceState?.getString(KEY_PROCESS_EPOCH), App.processEpoch)) {
            // Saved framework binders have no delivery acknowledgement after process death.
            // Terminate that obsolete Settings request and restart as ordinary, non-auth login.
            ObsoleteAuthenticatorCoordinator(obsoleteSeamsFactory?.invoke(this, intent, savedInstanceState) ?: object : ObsoleteAuthenticatorCoordinator.Seams {
                override fun cancel() = AuthenticatorResponseController.cancelObsolete(intent, savedInstanceState)
                override fun clearSecrets() = SetupSecretHolder.clearProcessOnlySecrets()
                override fun launchNormalOnce() = startActivity(Intent(this@LoginActivity, LoginActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            }).handle()
            super.finish()
            return
        }
        authenticatorResponse = controllerFactory?.invoke(intent, savedInstanceState) ?: AuthenticatorResponseController(intent, savedInstanceState)

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
        outState.putString(KEY_PROCESS_EPOCH, App.processEpoch)
        outState.putBoolean(KEY_WAS_AUTHENTICATOR, true)
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

    fun onAccountCreated(account: android.accounts.Account, creationId: String): Boolean {
        // This is live-process only; a killed authenticator flow is cancelled rather than
        // replaying an obsolete AccountAuthenticatorResponse binder.
        authenticatorResponse.complete(account)
        return true
    }

    /** Every failure before the verified account-created boundary is one framework cancellation. */
    fun cancelBeforeAccountCreated() {
        finish()
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
