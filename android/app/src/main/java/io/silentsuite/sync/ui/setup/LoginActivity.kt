/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.setup

import android.accounts.AccountManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import androidx.activity.OnBackPressedCallback
import androidx.annotation.MainThread
import androidx.annotation.VisibleForTesting
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentManager
import androidx.lifecycle.Lifecycle
import com.google.android.material.snackbar.Snackbar
import io.silentsuite.sync.App
import io.silentsuite.sync.BuildConfig
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.WebViewActivity

/** Sole owner of account-entry navigation, secrets, authenticator delivery and hosted signup. */
open class LoginActivity : BaseActivity() {
    companion object {
        const val EXTRA_SIGNUP_CONTINUATION_TOKEN = "io.silentsuite.sync.extra.SIGNUP_CONTINUATION_TOKEN"
        internal const val EXTRA_OWNER_MARKER_FLOW = "io.silentsuite.sync.extra.OWNER_MARKER_FLOW"
        internal const val EXTRA_OWNER_MARKER_GENERATION = "io.silentsuite.sync.extra.OWNER_MARKER_GENERATION"
        internal const val EXTRA_OWNER_MARKER_NONCE = "io.silentsuite.sync.extra.OWNER_MARKER_NONCE"
        internal const val ACCOUNT_CHOICE_TAG = "account-choice"
        internal const val CREDENTIALS_TAG = "credentials"
        internal const val CREATE_ACCOUNT_TAG = "create-account"
        internal const val CHOICE_TO_CREDENTIALS_BACK_STACK = "choice-to-credentials"
        internal const val CREDENTIALS_TO_CREATOR_BACK_STACK = "credentials-to-creator"
        internal const val DETECT_CONFIGURATION_TAG = "detect_configuration"
        internal const val CREATE_RETRY_ERROR_TAG = "account_creation_retry_error"
        private const val KEY_FLOW_ID = "signup_flow_id"
        private const val KEY_PROCESS_EPOCH = "authenticator_process_epoch"
        internal const val KEY_WAS_AUTHENTICATOR = "authenticator_was_authenticator"
        private const val KEY_OWNER_GENERATION = "login_owner_generation"
        private const val KEY_NAV_SCHEMA = "login_navigation_schema"
        private const val KEY_NAV_DESTINATION = "login_navigation_destination"
        private const val KEY_PENDING_CREATION_FAILURE = "pending_creation_failure_message"
        private const val NAV_SCHEMA_VERSION = 2
        internal var obsoleteSeamsFactory: ((LoginActivity, Intent, Bundle?) -> ObsoleteAuthenticatorCoordinator.Seams)? = null
            set(value) {
                check(value == null || BuildConfig.DEBUG)
                field = value
            }
        internal var controllerFactory: ((Intent, Bundle?) -> AuthenticatorResponseController)? = null
            set(value) {
                check(value == null || BuildConfig.DEBUG)
                field = value
            }
        internal var browserLauncherForTest: ((LoginActivity, Intent) -> Unit)? = null
            set(value) {
                check(value == null || BuildConfig.DEBUG)
                field = value
            }
    }

    private enum class Destination { CHOICE, CREDENTIALS, CREATOR, INVALID }
    private data class PendingSignupAcknowledgement(
        val token: String,
        val navigationGeneration: Long,
        val claim: SignupContinuationRegistry.ClaimRef,
    )

    private lateinit var authenticatorResponse: AuthenticatorResponseController
    private lateinit var admission: LoginFlowOwnerRegistry.Admission
    private var authenticatorMode = false
    private var supersededTerminal = false
    private var nextNavigationGeneration = 1L
    private var callbackNavigationGeneration = 0L
    private var pendingSignupAcknowledgement: PendingSignupAcknowledgement? = null
    private var credentialsTransactionPending = false
    private var ordinaryCredentialFocusPending = false
    private var pendingCreationFailureMessage: Int? = null
    private var accountEntryAdmissionPublished = false

    private val destinationCallbacks = object : FragmentManager.FragmentLifecycleCallbacks() {
        override fun onFragmentResumed(fm: FragmentManager, f: Fragment) {
            if (f is LoginCredentialsFragment) {
                credentialsTransactionPending = false
                pendingCreationFailureMessage?.let { messageRes ->
                    if (fm.findFragmentById(android.R.id.content) === f &&
                        fm.findFragmentByTag(CREATE_RETRY_ERROR_TAG) == null) {
                        pendingCreationFailureMessage = null
                        f.onSubmissionFailed()
                        DetectConfigurationFragment.NothingDetectedFragment.newInstance(messageRes)
                            .show(fm, CREATE_RETRY_ERROR_TAG)
                    }
                }
                if (ordinaryCredentialFocusPending && pendingSignupAcknowledgement == null &&
                    fm.findFragmentById(android.R.id.content) === f) {
                    ordinaryCredentialFocusPending = false
                    f.view?.findViewById<android.view.View>(R.id.login_existing_account_heading)?.let { heading ->
                        heading.requestFocus()
                        heading.announceForAccessibility(getString(R.string.login_existing_account_heading))
                    }
                }
                acknowledgeSignupDestinationIfReady(f)
            }
            updateDestinationTitle()
        }
    }

    public override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (hasOwnerMarker(intent) && savedInstanceState == null) {
            LoginFlowOwnerRegistry.isExactMarker(
                intent.getStringExtra(EXTRA_OWNER_MARKER_FLOW),
                intent.extras?.get(EXTRA_OWNER_MARKER_GENERATION) as? Long,
                intent.getStringExtra(EXTRA_OWNER_MARKER_NONCE),
            )
            // A marker is only for an already admitted instance. A framework-created marker
            // Activity, exact or stale, must finish only itself and never admit or supersede.
            intent.removeExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN)
            super.finish()
            return
        }

        if (savedInstanceState == null && intent.hasExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN))
            intent.removeExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN)

        supportFragmentManager.registerFragmentLifecycleCallbacks(destinationCallbacks, true)
        authenticatorMode = savedInstanceState?.getBoolean(KEY_WAS_AUTHENTICATOR, false) == true ||
            intent.hasExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE)
        if (AuthenticatorRestorePolicy.mustRestartNormally(
                authenticatorMode,
                savedInstanceState?.getString(KEY_PROCESS_EPOCH),
                App.processEpoch,
            )) {
            ObsoleteAuthenticatorCoordinator(
                obsoleteSeamsFactory?.also { check(BuildConfig.DEBUG) }
                    ?.invoke(this, intent, savedInstanceState)
                    ?: object : ObsoleteAuthenticatorCoordinator.Seams {
                        override fun cancel() = AuthenticatorResponseController.cancelObsolete(intent, savedInstanceState)
                        override fun clearSecrets() = Unit
                        override fun launchNormalOnce() = startActivity(
                            Intent(this@LoginActivity, LoginActivity::class.java)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
                        )
                    },
            ).handle()
            super.finish()
            return
        }

        admission = LoginFlowOwnerRegistry.admit(
            this,
            savedInstanceState?.getString(KEY_FLOW_ID),
            savedInstanceState?.takeIf { it.containsKey(KEY_OWNER_GENERATION) }?.getLong(KEY_OWNER_GENERATION),
        )
        authenticatorResponse = controllerFactory?.also { check(BuildConfig.DEBUG) }
            ?.invoke(intent, savedInstanceState)
            ?: AuthenticatorResponseController(intent, savedInstanceState)
        pendingCreationFailureMessage = savedInstanceState
            ?.takeIf { it.containsKey(KEY_PENDING_CREATION_FAILURE) }
            ?.getInt(KEY_PENDING_CREATION_FAILURE)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = routeBackOrUp()
        })

        val navigationIsValid = savedInstanceState != null && admission.rebound &&
            hasValidNavigation(savedInstanceState)
        if (!navigationIsValid) {
            admission = LoginFlowOwnerRegistry.resetToCleanChoice(this, admission) ?: run {
                super.finish()
                return
            }
            showChoiceRoot()
        } else {
            updateDestinationTitle()
        }
        accountEntryAdmissionPublished = true
    }

    override fun onPause() {
        if (::admission.isInitialized) LoginFlowOwnerRegistry.browserPaused(this, admission)
        super.onPause()
    }

    override fun onPostResume() {
        super.onPostResume()
        recoverStalledRestoredCreator()
        processSignupContinuation()
        pendingCreationFailureMessage?.let {
            if (currentDestination() == Destination.CREATOR) recoverFromAccountCreationFailure(it)
        }
        if (::admission.isInitialized) {
            LoginFlowOwnerRegistry.browserResumed(
                this,
                admission,
                intent.hasExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN),
            )
            (supportFragmentManager.findFragmentById(android.R.id.content) as? AccountChoiceFragment)
                ?.refreshHostedSignupAdmission()
        }
        (supportFragmentManager.findFragmentById(android.R.id.content) as? LoginCredentialsFragment)
            ?.let(::acknowledgeSignupDestinationIfReady)
    }

    internal fun recoverStalledRestoredCreator(): Boolean {
        val restoredCreator = supportFragmentManager.findFragmentById(android.R.id.content)
            as? CreateAccountFragment
        if (!::admission.isInitialized || currentDestination() != Destination.CREATOR ||
            restoredCreator == null ||
            restoredCreator.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return false
        admission = LoginFlowOwnerRegistry.resetToCleanChoice(this, admission) ?: run {
            super.finish()
            return true
        }
        showChoiceRoot()
        return true
    }

    override fun onNewIntent(newIntent: Intent) {
        super.onNewIntent(newIntent)
        if (hasOwnerMarker(newIntent)) {
            val markerGeneration = newIntent.extras?.get(EXTRA_OWNER_MARKER_GENERATION) as? Long
            if (!::admission.isInitialized ||
                !LoginFlowOwnerRegistry.isExactMarker(
                    newIntent.getStringExtra(EXTRA_OWNER_MARKER_FLOW),
                    markerGeneration,
                    newIntent.getStringExtra(EXTRA_OWNER_MARKER_NONCE),
                ) ||
                newIntent.getStringExtra(EXTRA_OWNER_MARKER_FLOW) != admission.flowId ||
                markerGeneration != admission.generation ||
                newIntent.getStringExtra(EXTRA_OWNER_MARKER_NONCE) != admission.instanceNonce
            ) return
        }
        newIntent.getStringExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN)?.let {
            intent.putExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN, it)
        }
        processSignupContinuation()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        if (::authenticatorResponse.isInitialized) authenticatorResponse.onSaveInstanceState(outState)
        if (::admission.isInitialized) {
            outState.putString(KEY_FLOW_ID, admission.flowId)
            outState.putLong(KEY_OWNER_GENERATION, admission.generation)
        }
        outState.putInt(KEY_NAV_SCHEMA, NAV_SCHEMA_VERSION)
        outState.putString(KEY_NAV_DESTINATION, currentDestination().name)
        pendingCreationFailureMessage?.let { outState.putInt(KEY_PENDING_CREATION_FAILURE, it) }
        outState.putString(KEY_PROCESS_EPOCH, App.processEpoch)
        outState.putBoolean(KEY_WAS_AUTHENTICATOR, authenticatorMode)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        supportFragmentManager.unregisterFragmentLifecycleCallbacks(destinationCallbacks)
        if (::admission.isInitialized)
            LoginFlowOwnerRegistry.release(this, admission.releaseToken, isChangingConfigurations)
        super.onDestroy()
    }

    override fun finish() {
        if (::admission.isInitialized && LoginFlowOwnerRegistry.isCurrent(
                this,
                admission.flowId,
                admission.generation,
                admission.instanceNonce,
            )) {
            if (::authenticatorResponse.isInitialized) authenticatorResponse.finish()
            LoginFlowOwnerRegistry.release(this, admission.releaseToken, changingConfigurations = false)
        }
        super.finish()
    }

    internal fun cancelAndFinishSupersededOwner(flowId: String, generation: Long, nonce: String) {
        if (!supersededTerminal && ::admission.isInitialized && admission.flowId == flowId &&
            admission.generation == generation && admission.instanceNonce == nonce) {
            supersededTerminal = true
            if (::authenticatorResponse.isInitialized) authenticatorResponse.finish()
            super.finish()
        }
    }

    internal fun setupLease(): SetupSecretHolder.OwnerLease? {
        if (!::admission.isInitialized) return null
        return admission.lease.takeIf {
            LoginFlowOwnerRegistry.isCurrent(this, admission.flowId, admission.generation, admission.instanceNonce)
        }
    }

    internal fun isAccountEntryAdmissionPublished(): Boolean =
        accountEntryAdmissionPublished && setupLease() != null

    @MainThread
    internal fun beginSetupOperation(expectedLease: SetupSecretHolder.OwnerLease): SetupSecretHolder.OperationToken? {
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) || setupLease() != expectedLease) return null
        return SetupSecretHolder.beginOperation(expectedLease)
    }

    @MainThread
    internal fun isSetupOperationCurrent(token: SetupSecretHolder.OperationToken): Boolean =
        lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) && setupLease() == token.lease &&
            SetupSecretHolder.compareOperation(token)

    @MainThread
    internal fun commitSetupOperation(
        token: SetupSecretHolder.OperationToken,
        vararg kinds: SetupSecretHolder.CommitKind,
    ): Boolean {
        if (!isSetupOperationCurrent(token)) return false
        return kinds.all { SetupSecretHolder.commitIfCurrent(token, it) }
    }

    internal fun recoverFromAccountCreationFailure(messageRes: Int) {
        if (!::admission.isInitialized || supportFragmentManager.isStateSaved ||
            !LoginFlowOwnerRegistry.isCurrent(
                this,
                admission.flowId,
                admission.generation,
                admission.instanceNonce,
            ) || currentDestination() != Destination.CREATOR ||
            supportFragmentManager.backStackEntryCount != 2 ||
            supportFragmentManager.getBackStackEntryAt(1).name != CREDENTIALS_TO_CREATOR_BACK_STACK) return
        pendingCreationFailureMessage = messageRes
        supportFragmentManager.popBackStack()
    }

    internal fun rejectMalformedCreator(fragment: CreateAccountFragment) {
        if (!::admission.isInitialized || supportFragmentManager.isStateSaved ||
            supportFragmentManager.findFragmentById(android.R.id.content) !== fragment ||
            currentDestination() != Destination.CREATOR ||
            supportFragmentManager.backStackEntryCount != 2 ||
            supportFragmentManager.getBackStackEntryAt(1).name != CREDENTIALS_TO_CREATOR_BACK_STACK ||
            !fragment.ownsActivePresentation(this, admission.lease) ||
            !LoginFlowOwnerRegistry.isCurrent(
                this,
                admission.flowId,
                admission.generation,
                admission.instanceNonce,
            )) return
        if (!SetupSecretHolder.clearCredentialsAndConfiguration(admission.lease)) return
        pendingCreationFailureMessage = R.string.setup_state_expired
        supportFragmentManager.popBackStack()
    }


    internal fun hasPendingAccountCreationFailure(): Boolean = pendingCreationFailureMessage != null

    fun requestSignIn() = navigateToCredentials(fromCallback = false)

    private fun navigateToCredentials(fromCallback: Boolean) {
        if (!::admission.isInitialized || supportFragmentManager.isStateSaved ||
            credentialsTransactionPending || currentDestination() != Destination.CHOICE ||
            supportFragmentManager.backStackEntryCount != 0) return
        credentialsTransactionPending = true
        try {
            supportFragmentManager.beginTransaction()
                .replace(android.R.id.content, LoginCredentialsFragment(), CREDENTIALS_TAG)
                .addToBackStack(CHOICE_TO_CREDENTIALS_BACK_STACK)
                .commit()
        } catch (e: RuntimeException) {
            credentialsTransactionPending = false
            throw e
        }
        title = getString(R.string.account_choice_sign_in)
        if (!fromCallback) {
            pendingSignupAcknowledgement = null
            ordinaryCredentialFocusPending = true
        }
    }

    fun requestHostedSignup(): Boolean {
        if (!::admission.isInitialized) return false
        val token = LoginFlowOwnerRegistry.beginHostedSignup(this, admission) ?: return false
        val callback = Constants.signupCompleteReturnUri.buildUpon()
            .appendQueryParameter("continuation", token)
            .build()
        val signup = Constants.webAppUri.buildUpon()
            .appendEncodedPath("signup")
            .appendQueryParameter("return_to", callback.toString())
            .build()
        try {
            val launchIntent = Intent(Intent.ACTION_VIEW, signup)
            val testLauncher = browserLauncherForTest
            if (testLauncher != null) {
                check(BuildConfig.DEBUG)
                testLauncher(this, launchIntent)
            } else {
                startActivity(launchIntent)
            }
            return true
        } catch (_: ActivityNotFoundException) {
            recoverBrowserLaunch(token)
        } catch (_: SecurityException) {
            recoverBrowserLaunch(token)
        }
        return false
    }

    internal fun isHostedSignupAdmissionAvailable(): Boolean =
        ::admission.isInitialized && LoginFlowOwnerRegistry.isSignupAdmissionAvailable(this, admission)

    private fun recoverBrowserLaunch(token: String) {
        if (LoginFlowOwnerRegistry.browserLaunchFailed(this, admission, token))
            Snackbar.make(
                findViewById(android.R.id.content),
                R.string.signup_open_failed,
                Snackbar.LENGTH_LONG,
            ).show()
    }

    @VisibleForTesting
    internal fun issueSignupCallbackUri(): android.net.Uri {
        check(io.silentsuite.sync.BuildConfig.DEBUG)
        val token = SignupContinuationRegistry.issue(admission.flowId)
        return Constants.signupCompleteReturnUri.buildUpon()
            .appendQueryParameter("continuation", token)
            .build()
    }

    private fun processSignupContinuation() {
        if (!::admission.isInitialized || supportFragmentManager.isStateSaved ||
            lifecycle.currentState != Lifecycle.State.RESUMED) return
        val token = intent.getStringExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN) ?: return
        when (SignupContinuationRegistry.claim(token, admission.flowId)) {
            SignupContinuationRegistry.ClaimResult.NEW_PENDING,
            SignupContinuationRegistry.ClaimResult.SAME_FLOW_PENDING -> {
                val destination = currentDestination()
                val detector = supportFragmentManager.findFragmentByTag(DETECT_CONFIGURATION_TAG)
                    as? DetectConfigurationFragment
                val creator = supportFragmentManager.findFragmentById(android.R.id.content)
                    as? CreateAccountFragment
                val operationOwnsPresentation =
                    detector?.ownsActivePresentation(this, admission.lease) == true ||
                        (destination == Destination.CREATOR &&
                            creator?.ownsActivePresentation(this, admission.lease) == true)
                if (operationOwnsPresentation) {
                    if (SignupContinuationRegistry.markHandled(token, admission.flowId))
                        completeSignupTransportWithoutGuidance()
                    return
                }
                if (!ensurePendingAcknowledgement(token)) return
                when (destination) {
                    Destination.CHOICE -> navigateToCredentials(fromCallback = true)
                    Destination.CREDENTIALS ->
                        (supportFragmentManager.findFragmentById(android.R.id.content) as? LoginCredentialsFragment)
                            ?.let(::acknowledgeSignupDestinationIfReady)
                    Destination.CREATOR, Destination.INVALID -> Unit
                }
            }
            SignupContinuationRegistry.ClaimResult.SAME_FLOW_HANDLED -> {
                completeSignupTransportWithoutGuidance()
            }
            SignupContinuationRegistry.ClaimResult.EXPIRED_SAME_FLOW -> {
                SignupContinuationRegistry.pendingClaimRef(token, admission.flowId)?.let { claim ->
                    SignupContinuationRegistry.rollbackExpired(token, admission.flowId, claim)
                }
                intent.removeExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN)
                pendingSignupAcknowledgement = null
                LoginFlowOwnerRegistry.signupHandled(this, admission)
            }
            SignupContinuationRegistry.ClaimResult.OTHER_FLOW,
            SignupContinuationRegistry.ClaimResult.UNKNOWN -> Unit
        }
    }

    private fun completeSignupTransportWithoutGuidance() {
        intent.removeExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN)
        pendingSignupAcknowledgement = null
        LoginFlowOwnerRegistry.signupHandled(this, admission)
    }

    private fun acknowledgeSignupDestinationIfReady(credentials: LoginCredentialsFragment) {
        val pending = pendingSignupAcknowledgement ?: return
        if (!::admission.isInitialized || supportFragmentManager.isStateSaved ||
            credentials.lifecycle.currentState != Lifecycle.State.RESUMED ||
            supportFragmentManager.findFragmentById(android.R.id.content) !== credentials ||
            supportFragmentManager.findFragmentByTag(CREDENTIALS_TAG) !== credentials ||
            supportFragmentManager.backStackEntryCount != 1 ||
            supportFragmentManager.getBackStackEntryAt(0).name != CHOICE_TO_CREDENTIALS_BACK_STACK ||
            pending.navigationGeneration != callbackNavigationGeneration ||
            SignupContinuationRegistry.pendingClaimRef(pending.token, admission.flowId) != pending.claim ||
            intent.getStringExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN) != pending.token ||
            !LoginFlowOwnerRegistry.isCurrent(
                this,
                admission.flowId,
                admission.generation,
                admission.instanceNonce,
            )
        ) return
        if (!SignupContinuationRegistry.markHandled(pending.token, admission.flowId)) return
        intent.removeExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN)
        pendingSignupAcknowledgement = null
        LoginFlowOwnerRegistry.signupHandled(this, admission)
        credentials.view?.findViewById<android.view.View>(R.id.login_existing_account_heading)?.requestFocus()
        Snackbar.make(
            findViewById(android.R.id.content),
            R.string.signup_returned_from_web,
            Snackbar.LENGTH_LONG,
        ).show()
    }

    private fun ensurePendingAcknowledgement(token: String): Boolean {
        if (pendingSignupAcknowledgement?.token == token) return true
        val claim = SignupContinuationRegistry.pendingClaimRef(token, admission.flowId) ?: return false
        if (nextNavigationGeneration == Long.MAX_VALUE) error("Login navigation generation exhausted")
        val generation = nextNavigationGeneration
        nextNavigationGeneration += 1
        callbackNavigationGeneration = generation
        pendingSignupAcknowledgement = PendingSignupAcknowledgement(token, generation, claim)
        LoginFlowOwnerRegistry.schedulePendingClaimExpiry(this, admission, token, claim)
        return true
    }

    internal fun onSignupClaimExpired(
        expectedAdmission: LoginFlowOwnerRegistry.Admission,
        token: String,
        claim: SignupContinuationRegistry.ClaimRef,
    ) {
        val pending = pendingSignupAcknowledgement ?: return
        if (!::admission.isInitialized || admission != expectedAdmission || pending.token != token ||
            pending.claim != claim || intent.getStringExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN) != token ||
            !LoginFlowOwnerRegistry.isCurrent(
                this,
                admission.flowId,
                admission.generation,
                admission.instanceNonce,
            )) return
        intent.removeExtra(EXTRA_SIGNUP_CONTINUATION_TOKEN)
        pendingSignupAcknowledgement = null
    }

    private fun showChoiceRoot() {
        if (supportFragmentManager.isStateSaved) return
        supportFragmentManager.popBackStackImmediate(null, FragmentManager.POP_BACK_STACK_INCLUSIVE)
        supportFragmentManager.beginTransaction()
            .replace(android.R.id.content, AccountChoiceFragment(), ACCOUNT_CHOICE_TAG)
            .commitNow()
        title = getString(R.string.login_title)
    }

    private fun hasValidNavigation(saved: Bundle): Boolean {
        if (saved.getInt(KEY_NAV_SCHEMA, -1) != NAV_SCHEMA_VERSION) return false
        val savedDestination = runCatching {
            Destination.valueOf(saved.getString(KEY_NAV_DESTINATION).orEmpty())
        }.getOrNull() ?: return false
        if (savedDestination == Destination.INVALID || savedDestination != currentDestination()) return false
        return when (savedDestination) {
            Destination.CHOICE -> supportFragmentManager.backStackEntryCount == 0
            Destination.CREDENTIALS -> supportFragmentManager.backStackEntryCount == 1 &&
                supportFragmentManager.getBackStackEntryAt(0).name == CHOICE_TO_CREDENTIALS_BACK_STACK &&
                supportFragmentManager.findFragmentByTag(DETECT_CONFIGURATION_TAG).let { detector ->
                    detector == null ||
                        (detector is DetectConfigurationFragment &&
                            detector.hasValidRestoredAuthority(admission.lease))
                }
            Destination.CREATOR -> supportFragmentManager.backStackEntryCount == 2 &&
                supportFragmentManager.getBackStackEntryAt(0).name == CHOICE_TO_CREDENTIALS_BACK_STACK &&
                supportFragmentManager.getBackStackEntryAt(1).name == CREDENTIALS_TO_CREATOR_BACK_STACK &&
                (supportFragmentManager.findFragmentById(android.R.id.content) as? CreateAccountFragment)
                    ?.hasValidRestoredAuthority(admission.lease) == true
            Destination.INVALID -> false
        }
    }

    private fun currentDestination(): Destination {
        val current = supportFragmentManager.findFragmentById(android.R.id.content)
        return when {
            current is AccountChoiceFragment &&
                supportFragmentManager.findFragmentByTag(ACCOUNT_CHOICE_TAG) === current -> Destination.CHOICE
            current is LoginCredentialsFragment &&
                supportFragmentManager.findFragmentByTag(CREDENTIALS_TAG) === current -> Destination.CREDENTIALS
            current is CreateAccountFragment &&
                supportFragmentManager.findFragmentByTag(CREATE_ACCOUNT_TAG) === current -> Destination.CREATOR
            else -> Destination.INVALID
        }
    }

    private fun updateDestinationTitle() {
        title = getString(
            if (currentDestination() == Destination.CHOICE) R.string.login_title
            else R.string.account_choice_sign_in,
        )
    }

    private fun routeBackOrUp() {
        if (supportFragmentManager.fragments.any {
                it is androidx.fragment.app.DialogFragment && it.dialog?.isShowing == true
            }) return
        if (currentDestination() == Destination.CREDENTIALS &&
            supportFragmentManager.backStackEntryCount == 1 &&
            supportFragmentManager.getBackStackEntryAt(0).name == CHOICE_TO_CREDENTIALS_BACK_STACK) {
            val cleared = setupLease()?.let { lease ->
                beginSetupOperation(lease)?.let { token ->
                    commitSetupOperation(token, SetupSecretHolder.CommitKind.HOLDER_MUTATION) &&
                        SetupSecretHolder.clearCredentialsAndConfiguration(lease)
                }
            } == true
            if (!cleared) return
            supportFragmentManager.popBackStackImmediate()
            title = getString(R.string.login_title)
        } else if (!supportFragmentManager.popBackStackImmediate()) {
            finish()
        }
    }

    private fun hasOwnerMarker(candidate: Intent): Boolean =
        candidate.hasExtra(EXTRA_OWNER_MARKER_FLOW) ||
            candidate.hasExtra(EXTRA_OWNER_MARKER_GENERATION) ||
            candidate.hasExtra(EXTRA_OWNER_MARKER_NONCE)

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == android.R.id.home) {
            routeBackOrUp()
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    fun onAccountCreated(account: android.accounts.Account, creationId: String): Boolean {
        if (!::admission.isInitialized || !LoginFlowOwnerRegistry.isCurrent(
                this,
                admission.flowId,
                admission.generation,
                admission.instanceNonce,
            )) return false
        authenticatorResponse.complete(account)
        return true
    }

    fun cancelBeforeAccountCreated() = finish()

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.activity_login, menu)
        return true
    }

    fun showHelp(item: MenuItem) = WebViewActivity.openUrl(this, Constants.helpUri)
}
