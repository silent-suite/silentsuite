/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.setup

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.annotation.VisibleForTesting
import io.silentsuite.sync.BuildConfig

import java.lang.ref.WeakReference
import java.util.UUID

sealed class SignupRouteResult {
    data class Foreground(val command: ForegroundCommand) : SignupRouteResult()
    data class QUEUED_REBIND(val deadline: Long) : SignupRouteResult()
    object UNRELATED_LIVE_OWNER : SignupRouteResult()
    object NO_LIVE_OWNER : SignupRouteResult()
}

data class ForegroundCommand internal constructor(
    private val owner: WeakReference<LoginActivity>,
    private val flowId: String,
    private val generation: Long,
    private val instanceNonce: String,
) {
    fun execute(): Boolean {
        val activity = owner.get() ?: return false
        if (!LoginFlowOwnerRegistry.isCurrent(activity, flowId, generation, instanceNonce)) return false
        return try {
            activity.startActivity(
                Intent(activity, LoginActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    .putExtra(LoginActivity.EXTRA_OWNER_MARKER_FLOW, flowId)
                    .putExtra(LoginActivity.EXTRA_OWNER_MARKER_GENERATION, generation)
                    .putExtra(LoginActivity.EXTRA_OWNER_MARKER_NONCE, instanceNonce),
            )
            true
        } catch (_: RuntimeException) {
            // The token was installed in the exact owner intent before foregrounding. A later
            // resume can therefore finish the pending handoff without accepting another owner.
            false
        }
    }
}

/** One process-wide weak LoginActivity owner with exact, bounded recreation authority. */
object LoginFlowOwnerRegistry {
    private enum class State { ACTIVE, REBINDING }
    enum class BrowserState { IDLE, LAUNCHING, AWAY_IN_BROWSER, CALLBACK_PENDING }

    private data class Owner(
        val flowId: String,
        val generation: Long,
        val lease: SetupSecretHolder.OwnerLease,
        val instanceNonce: String,
        val activity: WeakReference<LoginActivity>,
        val state: State,
        val rebindDeadline: Long,
        val browserState: BrowserState,
    )

    data class ReleaseToken internal constructor(
        val flowId: String,
        val generation: Long,
        val lease: SetupSecretHolder.OwnerLease,
        val instanceNonce: String,
    )

    data class Admission(
        val flowId: String,
        val generation: Long,
        val lease: SetupSecretHolder.OwnerLease,
        val instanceNonce: String,
        val rebound: Boolean,
        val releaseToken: ReleaseToken,
    )

    private val lock = Any()
    private val handler = Handler(Looper.getMainLooper())
    private var owner: Owner? = null
    private var nextGeneration = 1L
    internal const val REBIND_MILLIS = 2_000L

    fun admit(activity: LoginActivity, restoredFlowId: String?, restoredGeneration: Long?): Admission =
        synchronized(lock) {
            val now = SetupElapsedClock.now()
            retireExpiredRebind(now)
            retireWeakOwner()
            val current = owner
            if (current != null && current.state == State.REBINDING &&
                current.flowId == restoredFlowId && current.generation == restoredGeneration &&
                SetupSecretHolder.compareCurrent(current.lease)) {
                val rebound = current.copy(
                    instanceNonce = UUID.randomUUID().toString(),
                    activity = WeakReference(activity),
                    state = State.ACTIVE,
                    rebindDeadline = Long.MAX_VALUE,
                )
                owner = rebound
                return@synchronized admission(rebound, rebound = true)
            }

            if (current != null) {
                // Close every old authority while routing is blocked by owner=null. The exact old
                // authenticator is canceled before the replacement record can route callbacks.
                owner = null
                revokeOwnerState(current)
                current.activity.get()?.cancelAndFinishSupersededOwner(
                    current.flowId,
                    current.generation,
                    current.instanceNonce,
                )
            }

            val generation = allocateGeneration()
            val flowId = restoredFlowId?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
            val lease = SetupSecretHolder.issue(SetupSecretHolder.LeaseKind.LOGIN)
            val fresh = Owner(
                flowId,
                generation,
                lease,
                UUID.randomUUID().toString(),
                WeakReference(activity),
                State.ACTIVE,
                Long.MAX_VALUE,
                BrowserState.IDLE,
            )
            owner = fresh
            admission(fresh, rebound = false)
        }

    fun routeSignupToken(token: String?): SignupRouteResult = synchronized(lock) {
        val now = SetupElapsedClock.now()
        retireExpiredRebind(now)
        retireWeakOwner()
        val route = SignupContinuationRegistry.route(token)
        val current = owner
        val flowId = (route as? SignupContinuationRegistry.Route.ROUTABLE)?.flowId
            ?: return@synchronized when {
                current?.state == State.REBINDING -> SignupRouteResult.QUEUED_REBIND(current.rebindDeadline)
                current?.activity?.get() != null -> SignupRouteResult.UNRELATED_LIVE_OWNER
                else -> SignupRouteResult.NO_LIVE_OWNER
            }
        val exactToken = token ?: return@synchronized SignupRouteResult.NO_LIVE_OWNER
        if (current == null) return@synchronized SignupRouteResult.NO_LIVE_OWNER
        if (current.flowId != flowId) return@synchronized SignupRouteResult.UNRELATED_LIVE_OWNER
        if (current.state == State.REBINDING)
            return@synchronized SignupRouteResult.QUEUED_REBIND(current.rebindDeadline)
        val activity = current.activity.get() ?: run {
            retireWeakOwner()
            return@synchronized SignupRouteResult.NO_LIVE_OWNER
        }
        activity.intent.putExtra(LoginActivity.EXTRA_SIGNUP_CONTINUATION_TOKEN, exactToken)
        owner = current.copy(browserState = BrowserState.CALLBACK_PENDING)
        SignupRouteResult.Foreground(
            ForegroundCommand(current.activity, current.flowId, current.generation, current.instanceNonce),
        )
    }

    /** Replace malformed restored navigation authority with a secret-empty login lease. */
    fun resetToCleanChoice(activity: LoginActivity, admission: Admission): Admission? = synchronized(lock) {
        val current = exactOwner(activity, admission) ?: return@synchronized null
        owner = null
        activity.intent.removeExtra(LoginActivity.EXTRA_SIGNUP_CONTINUATION_TOKEN)
        SignupContinuationRegistry.remove(current.flowId)
        SetupSecretHolder.revoke(current.lease)
        val clean = current.copy(
            lease = SetupSecretHolder.issue(SetupSecretHolder.LeaseKind.LOGIN),
            browserState = BrowserState.IDLE,
        )
        owner = clean
        admission(clean, rebound = false)
    }

    fun beginHostedSignup(activity: LoginActivity, admission: Admission): String? = synchronized(lock) {
        val current = exactOwner(activity, admission) ?: return@synchronized null
        if (current.state != State.ACTIVE || current.browserState != BrowserState.IDLE) return@synchronized null
        val token = SignupContinuationRegistry.issue(current.flowId)
        owner = current.copy(browserState = BrowserState.LAUNCHING)
        token
    }

    fun browserLaunchFailed(activity: LoginActivity, admission: Admission, token: String): Boolean = synchronized(lock) {
        val current = exactOwner(activity, admission) ?: return@synchronized false
        if (current.browserState != BrowserState.LAUNCHING) return@synchronized false
        SignupContinuationRegistry.revoke(token, current.flowId)
        owner = current.copy(browserState = BrowserState.IDLE)
        true
    }

    fun browserPaused(activity: LoginActivity, admission: Admission) = synchronized(lock) {
        val current = exactOwner(activity, admission) ?: return@synchronized
        if (current.browserState == BrowserState.LAUNCHING)
            owner = current.copy(browserState = BrowserState.AWAY_IN_BROWSER)
    }

    fun browserResumed(activity: LoginActivity, admission: Admission, callbackPending: Boolean) = synchronized(lock) {
        val current = exactOwner(activity, admission) ?: return@synchronized
        owner = when {
            callbackPending -> current.copy(browserState = BrowserState.CALLBACK_PENDING)
            current.browserState == BrowserState.LAUNCHING || current.browserState == BrowserState.AWAY_IN_BROWSER ->
                current.copy(browserState = BrowserState.IDLE)
            else -> current
        }
    }

    fun signupHandled(activity: LoginActivity, admission: Admission) = synchronized(lock) {
        val current = exactOwner(activity, admission) ?: return@synchronized
        owner = current.copy(browserState = BrowserState.IDLE)
    }

    fun schedulePendingClaimExpiry(
        activity: LoginActivity,
        admission: Admission,
        token: String,
        claim: SignupContinuationRegistry.ClaimRef,
    ) = synchronized(lock) {
        val current = exactOwner(activity, admission) ?: return@synchronized
        val weakActivity = current.activity
        val delay = (claim.deadline - SetupElapsedClock.now()).coerceAtLeast(0L)
        handler.postDelayed({
            val target = synchronized(lock) prompt@{
                retireExpiredRebind(SetupElapsedClock.now())
                retireWeakOwner()
                val exact = owner ?: return@prompt null
                if (exact.flowId != admission.flowId || exact.generation != admission.generation ||
                    exact.instanceNonce != admission.instanceNonce || exact.lease != admission.lease ||
                    exact.activity !== weakActivity || SetupElapsedClock.now() < claim.deadline ||
                    !SignupContinuationRegistry.rollbackExpired(token, admission.flowId, claim))
                    return@prompt null
                owner = exact.copy(browserState = BrowserState.IDLE)
                weakActivity.get()
            }
            target?.onSignupClaimExpired(admission, token, claim)
        }, delay)
    }

    fun isSignupAdmissionAvailable(activity: LoginActivity, admission: Admission): Boolean = synchronized(lock) {
        exactOwner(activity, admission)?.let {
            it.state == State.ACTIVE && it.browserState == BrowserState.IDLE
        } == true
    }

    fun isExactMarker(flowId: String?, generation: Long?, nonce: String?): Boolean = synchronized(lock) {
        retireExpiredRebind(SetupElapsedClock.now())
        retireWeakOwner()
        val current = owner ?: return@synchronized false
        flowId != null && generation != null && nonce != null && current.flowId == flowId &&
            current.generation == generation && current.instanceNonce == nonce &&
            current.state == State.ACTIVE && current.activity.get() != null
    }

    fun isCurrent(activity: LoginActivity, flowId: String, generation: Long, nonce: String): Boolean =
        synchronized(lock) {
            retireExpiredRebind(SetupElapsedClock.now())
            retireWeakOwner()
            owner?.let {
                it.flowId == flowId && it.generation == generation && it.instanceNonce == nonce &&
                    it.activity.get() === activity
            } == true
        }

    fun release(activity: LoginActivity, token: ReleaseToken, changingConfigurations: Boolean) {
        val retired = synchronized(lock) {
            val current = owner
            if (current == null || current.flowId != token.flowId || current.generation != token.generation ||
                current.lease != token.lease || current.instanceNonce != token.instanceNonce ||
                current.activity.get() !== activity) return
            if (changingConfigurations) {
                val deadline = checkedDeadline(SetupElapsedClock.now(), REBIND_MILLIS)
                owner = current.copy(
                    activity = WeakReference(null),
                    state = State.REBINDING,
                    rebindDeadline = deadline,
                )
                scheduleRebindRetirement(current, deadline)
                null
            } else {
                owner = null
                current
            }
        }
        retired?.let(::revokeOwnerState)
    }

    private fun exactOwner(activity: LoginActivity, admission: Admission): Owner? {
        retireExpiredRebind(SetupElapsedClock.now())
        retireWeakOwner()
        val current = owner ?: return null
        return current.takeIf {
            it.flowId == admission.flowId && it.generation == admission.generation &&
                it.lease == admission.lease && it.instanceNonce == admission.instanceNonce &&
                it.activity.get() === activity
        }
    }

    private fun admission(owner: Owner, rebound: Boolean): Admission {
        val token = ReleaseToken(owner.flowId, owner.generation, owner.lease, owner.instanceNonce)
        return Admission(owner.flowId, owner.generation, owner.lease, owner.instanceNonce, rebound, token)
    }

    private fun scheduleRebindRetirement(owner: Owner, deadline: Long) {
        val flowId = owner.flowId
        val generation = owner.generation
        val lease = owner.lease
        val nonce = owner.instanceNonce
        val delay = (deadline - SetupElapsedClock.now()).coerceAtLeast(0L)
        handler.postDelayed({ retireExpiredRebind(flowId, generation, nonce, lease, deadline) }, delay)
    }

    private fun retireExpiredRebind(now: Long) {
        val current = owner ?: return
        if (current.state == State.REBINDING && now >= current.rebindDeadline) {
            owner = null
            revokeOwnerState(current)
        }
    }

    private fun retireExpiredRebind(
        flowId: String,
        generation: Long,
        nonce: String,
        lease: SetupSecretHolder.OwnerLease,
        deadline: Long,
    ) = synchronized(lock) {
        val current = owner ?: return@synchronized
        if (current.flowId != flowId || current.generation != generation || current.instanceNonce != nonce ||
            current.lease != lease || current.state != State.REBINDING || current.rebindDeadline != deadline ||
            SetupElapsedClock.now() < deadline) return@synchronized
        owner = null
        revokeOwnerState(current)
    }

    private fun retireWeakOwner() {
        val current = owner ?: return
        if (current.activity.get() == null && current.state == State.ACTIVE) {
            owner = null
            revokeOwnerState(current)
        }
    }

    private fun revokeOwnerState(owner: Owner) {
        owner.activity.get()?.intent?.removeExtra(LoginActivity.EXTRA_SIGNUP_CONTINUATION_TOKEN)
        SignupContinuationRegistry.remove(owner.flowId)
        SetupSecretHolder.revoke(owner.lease)
    }

    private fun allocateGeneration(): Long {
        if (nextGeneration <= 0) error("Login owner generation invalid")
        if (nextGeneration == Long.MAX_VALUE) error("Login owner generation exhausted")
        val generation = nextGeneration
        nextGeneration += 1
        return generation
    }

    @VisibleForTesting
    internal fun resetForTests() {
        check(BuildConfig.DEBUG)
        val retired = synchronized(lock) {
            val current = owner
            owner = null
            nextGeneration = 1L
            current
        }
        retired?.let(::revokeOwnerState)
    }

    @VisibleForTesting
    internal fun isEmptyForTests(): Boolean {
        check(BuildConfig.DEBUG)
        return synchronized(lock) {
            retireExpiredRebind(SetupElapsedClock.now())
            retireWeakOwner()
            owner == null
        }
    }

    private fun checkedDeadline(now: Long, duration: Long): Long =
        if (now > Long.MAX_VALUE - duration) Long.MAX_VALUE else now + duration
}
