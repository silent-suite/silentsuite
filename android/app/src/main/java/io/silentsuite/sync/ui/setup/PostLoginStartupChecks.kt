package io.silentsuite.sync.ui.setup

import android.content.Context
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import io.silentsuite.sync.App

/**
 * Process-scoped owner of startup bootstrap runs and their typed outcomes.
 *
 * At most one retry runs per process: a request while another is in flight is rejected, not
 * queued. A run publishes its result before returning, so a cancelled caller cannot discard it.
 * Outcomes stay in memory only; bootstrap re-runs on every process start.
 */
object PostLoginStartupChecks {
    data class Snapshot(
        val outcome: PostLoginStartupOutcome?,
        val source: PostLoginStartupOutcome.Source?,
        val retryAttempts: Int,
        val retryInFlight: Boolean,
    )

    sealed class RetryResult {
        data class Completed(val outcome: PostLoginStartupOutcome) : RetryResult()
        object AccountChanged : RetryResult()
        object AlreadyRunning : RetryResult()
    }

    private const val MAX_COUNTED_RETRIES = 99
    private val lock = Any()
    private val stateLock = Any()
    private var latest: PostLoginStartupOutcome? = null
    private var latestSource: PostLoginStartupOutcome.Source? = null
    private var retryAttempts = 0
    private var retryInFlight = false
    private var retryVersion = 0
    private val retryChanges = MutableLiveData<Int>()

    /**
     * Emits a new version when any retry starts or settles, so a screen that did not start the
     * run still observes it. Unset until the first retry, so plain launches get no dispatch.
     */
    val retryStateChanges: LiveData<Int> get() = retryChanges

    fun retryStateVersion(): Int = synchronized(stateLock) { retryVersion }

    /** androidTest-only: runs on the retry worker after the run is admitted, before bootstrap. */
    @JvmField @Volatile internal var beforeRetryBootstrapForTest: (() -> Unit)? = null

    /** Application.onCreate entry point; never throws for bootstrap failures. */
    fun runAtLaunch(context: Context): Boolean = synchronized(lock) {
        publish(PostLoginSetupMigration.bootstrapOutcome(context), PostLoginStartupOutcome.Source.LAUNCH)
    }

    /** Worker-thread only. [stillExact] is checked after admission; a rejected account runs nothing. */
    fun retry(context: Context, stillExact: () -> Boolean): RetryResult {
        val admitted = synchronized(stateLock) {
            if (retryInFlight) {
                false
            } else {
                retryInFlight = true
                true
            }
        }
        if (!admitted) return RetryResult.AlreadyRunning
        signalRetryChange()
        try {
            beforeRetryBootstrapForTest?.invoke()
            synchronized(lock) {
                if (!stillExact()) return RetryResult.AccountChanged
                synchronized(stateLock) {
                    if (retryAttempts < MAX_COUNTED_RETRIES) retryAttempts++
                }
                val outcome = PostLoginSetupMigration.bootstrapOutcome(context)
                publish(outcome, PostLoginStartupOutcome.Source.RETRY)
                return RetryResult.Completed(outcome)
            }
        } finally {
            synchronized(stateLock) { retryInFlight = false }
            signalRetryChange()
        }
    }

    fun snapshot(): Snapshot = synchronized(stateLock) {
        Snapshot(latest, latestSource, retryAttempts, retryInFlight)
    }

    /** androidTest-only: forget recorded outcomes between fixtures. */
    internal fun resetForTest() {
        synchronized(stateLock) {
            latest = null
            latestSource = null
            retryAttempts = 0
        }
    }

    private fun publish(outcome: PostLoginStartupOutcome, source: PostLoginStartupOutcome.Source): Boolean {
        synchronized(stateLock) {
            latest = outcome
            latestSource = source
        }
        App.postLoginBootstrapSucceeded = outcome.succeeded
        return outcome.succeeded
    }

    private fun signalRetryChange() {
        val version = synchronized(stateLock) { ++retryVersion }
        retryChanges.postValue(version)
    }
}
