package io.silentsuite.sync.ui.account

/**
 * Monotonic publication gate for replaceable asynchronous work.
 *
 * Cancellation is an optimization: callers must still pass every completion through this gate
 * because blocking IO may finish after cancellation and must never publish stale success or error.
 */
class LatestRequestWins<T> {
    private var latestRequest = 0L

    @Synchronized
    fun begin(): Long = ++latestRequest

    /** Invalidates every in-flight request without starting replacement work. */
    @Synchronized
    fun invalidate() {
        ++latestRequest
    }

    @Synchronized
    fun publishIfLatest(request: Long, value: T, publish: (T) -> Unit): Boolean {
        if (request != latestRequest) return false
        publish(value)
        return true
    }
}
