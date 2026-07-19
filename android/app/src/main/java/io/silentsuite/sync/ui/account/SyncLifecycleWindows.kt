package io.silentsuite.sync.ui.account

import io.silentsuite.sync.Constants
import java.util.concurrent.TimeUnit

/** Product-owned status expiry policy, independent of Android adapter retry behavior. */
data class SyncLifecycleWindows(
    val interruptionAfterMillis: Long = TimeUnit.SECONDS.toMillis(Constants.DEFAULT_RETRY_DELAY),
) {
    init {
        require(interruptionAfterMillis >= 0)
    }

    fun age(now: Long, timestamp: Long): Long = if (now <= timestamp) 0 else now - timestamp
    fun isExpired(timestamp: Long, now: Long) = age(now, timestamp) >= interruptionAfterMillis
}
