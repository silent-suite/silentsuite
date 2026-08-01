package io.silentsuite.sync.ui.setup

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.annotation.VisibleForTesting
import io.silentsuite.sync.BuildConfig

import java.lang.ref.WeakReference
import java.util.UUID

/** Narrow browser callback boundary; token possession alone never implies account creation. */
class SignupReturnActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val instanceNonce = UUID.randomUUID().toString()
    private var retryDeadline = Long.MIN_VALUE
    private lateinit var retry: RetryRunnable

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        retryDeadline = savedInstanceState?.getLong(KEY_RETRY_DEADLINE, Long.MIN_VALUE)
            ?.takeIf { it > 0 }
            ?: checkedDeadline(SetupElapsedClock.now(), 2_000L)
        retry = RetryRunnable(WeakReference(this), instanceNonce)
        if (!route()) handler.post(retry)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putLong(KEY_RETRY_DEADLINE, retryDeadline)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        if (::retry.isInitialized) handler.removeCallbacks(retry)
        super.onDestroy()
    }

    private fun retryOnce(nonce: String, runnable: RetryRunnable) {
        if (nonce != instanceNonce || isFinishing || isDestroyed) return
        val routed = route()
        if (!routed && SetupElapsedClock.now() < retryDeadline) handler.postDelayed(runnable, 50L)
        else if (!routed) openCleanLogin()
    }

    private fun route(): Boolean {
        val token = intent.data?.getQueryParameter("continuation")
        when (val result: SignupRouteResult = LoginFlowOwnerRegistry.routeSignupToken(token)) {
                is SignupRouteResult.Foreground -> {
                    val testExecutor = foregroundExecutorForTest
                    val executed = if (testExecutor != null) {
                        check(BuildConfig.DEBUG)
                        testExecutor(result.command)
                    } else {
                        result.command.execute()
                    }
                    if (executed) {
                        finish()
                        return true
                    }
                    return false
                }
                is SignupRouteResult.QUEUED_REBIND -> {
                    retryDeadline = minOf(retryDeadline, result.deadline)
                    return false
                }
                SignupRouteResult.UNRELATED_LIVE_OWNER -> {
                    finish()
                    return true
                }
                SignupRouteResult.NO_LIVE_OWNER -> Unit
        }
        openCleanLogin()
        return true
    }

    private fun openCleanLogin() {
        startActivity(Intent(this, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }

    private fun checkedDeadline(now: Long, duration: Long): Long =
        if (now > Long.MAX_VALUE - duration) Long.MAX_VALUE else now + duration

    companion object {
        private const val KEY_RETRY_DEADLINE = "signup_return_retry_deadline"
        @VisibleForTesting
        internal var foregroundExecutorForTest: ((ForegroundCommand) -> Boolean)? = null
            set(value) {
                check(value == null || BuildConfig.DEBUG)
                field = value
            }
    }

    private class RetryRunnable(
        private val owner: WeakReference<SignupReturnActivity>,
        private val instanceNonce: String,
    ) : Runnable {
        override fun run() {
            val activity = owner.get() ?: return
            activity.retryOnce(instanceNonce, this)
        }
    }
}
