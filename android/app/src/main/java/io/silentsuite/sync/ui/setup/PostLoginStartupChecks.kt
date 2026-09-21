package io.silentsuite.sync.ui.setup

import android.content.Context
import android.os.SystemClock
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
        /** Duration of the latest bootstrap run only; not total process startup. */
        val bootstrapElapsedBucket: BootstrapElapsedBucket = BootstrapElapsedBucket.NOT_RECORDED,
        val rowsClassified: Int = 0,
        val sessionParses: Int = 0,
        /** Outcome of the launch check in this process; a later Retry never replaces it. */
        val launchOutcome: PostLoginStartupOutcome? = null,
    )

    /** Coarse, capped duration of `bootstrapOutcome`; the report prints [reportValue] only. */
    enum class BootstrapElapsedBucket(val reportValue: String) {
        UNDER_1S("UNDER_1S"),
        FROM_1S_TO_5S("1S_TO_5S"),
        FROM_5S_TO_15S("5S_TO_15S"),
        FROM_15S_TO_30S("15S_TO_30S"),
        OVER_30S("OVER_30S"),
        NOT_RECORDED("NOT_RECORDED");

        companion object {
            fun of(elapsedMillis: Long): BootstrapElapsedBucket = when {
                elapsedMillis < 1_000L -> UNDER_1S
                elapsedMillis < 5_000L -> FROM_1S_TO_5S
                elapsedMillis < 15_000L -> FROM_5S_TO_15S
                elapsedMillis < 30_000L -> FROM_15S_TO_30S
                else -> OVER_30S
            }
        }
    }

    sealed class RetryResult {
        data class Completed(val outcome: PostLoginStartupOutcome) : RetryResult()
        object AccountChanged : RetryResult()
        object AlreadyRunning : RetryResult()
    }

    private class MeasuredRun(
        val outcome: PostLoginStartupOutcome,
        val elapsedBucket: BootstrapElapsedBucket,
        val rowsClassified: Int,
        val sessionParses: Int,
    )

    private const val MAX_COUNTED_RETRIES = 99
    private const val MAX_COUNTED_BOOTSTRAP_WORK = 99
    private val lock = Any()
    private val stateLock = Any()
    private var latest: PostLoginStartupOutcome? = null
    private var latestSource: PostLoginStartupOutcome.Source? = null
    private var launchOutcome: PostLoginStartupOutcome? = null
    private var latestElapsedBucket = BootstrapElapsedBucket.NOT_RECORDED
    private var latestRowsClassified = 0
    private var latestSessionParses = 0
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

    /**
     * Application.onCreate entry point; never throws for bootstrap failures. The Boolean only
     * says whether bootstrap succeeded; [snapshot] carries the typed outcome and measurements.
     */
    fun runAtLaunch(context: Context): Boolean = synchronized(lock) {
        publish(measuredBootstrap(context), PostLoginStartupOutcome.Source.LAUNCH)
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
                val run = measuredBootstrap(context)
                publish(run, PostLoginStartupOutcome.Source.RETRY)
                return RetryResult.Completed(run.outcome)
            }
        } finally {
            synchronized(stateLock) { retryInFlight = false }
            signalRetryChange()
        }
    }

    fun snapshot(): Snapshot = synchronized(stateLock) {
        Snapshot(latest, latestSource, retryAttempts, retryInFlight,
            latestElapsedBucket, latestRowsClassified, latestSessionParses, launchOutcome)
    }

    /** androidTest-only: forget recorded outcomes between fixtures. */
    internal fun resetForTest() {
        synchronized(stateLock) {
            latest = null
            latestSource = null
            launchOutcome = null
            latestElapsedBucket = BootstrapElapsedBucket.NOT_RECORDED
            latestRowsClassified = 0
            latestSessionParses = 0
            retryAttempts = 0
        }
    }

    /** Callers hold [lock]; only bucket names and capped counts leave this function. */
    private fun measuredBootstrap(context: Context): MeasuredRun {
        var rows = 0
        var parses = 0
        val startedAt = SystemClock.elapsedRealtime()
        val outcome = PostLoginSetupMigration.bootstrapOutcome(
            context,
            onRowClassified = { if (rows < MAX_COUNTED_BOOTSTRAP_WORK) rows++ },
            onSessionParse = { if (parses < MAX_COUNTED_BOOTSTRAP_WORK) parses++ },
        )
        val elapsed = SystemClock.elapsedRealtime() - startedAt
        return MeasuredRun(outcome, BootstrapElapsedBucket.of(elapsed), rows, parses)
    }

    private fun publish(run: MeasuredRun, source: PostLoginStartupOutcome.Source): Boolean {
        synchronized(stateLock) {
            latest = run.outcome
            latestSource = source
            if (source == PostLoginStartupOutcome.Source.LAUNCH) launchOutcome = run.outcome
            latestElapsedBucket = run.elapsedBucket
            latestRowsClassified = run.rowsClassified
            latestSessionParses = run.sessionParses
        }
        App.postLoginBootstrapSucceeded = run.outcome.succeeded
        return run.outcome.succeeded
    }

    private fun signalRetryChange() {
        val version = synchronized(stateLock) { ++retryVersion }
        retryChanges.postValue(version)
    }
}
