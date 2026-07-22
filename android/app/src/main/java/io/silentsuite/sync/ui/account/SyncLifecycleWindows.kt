package io.silentsuite.sync.ui.account

/** Product-owned status expiry policy, independent of Android adapter retry behavior. */
data class SyncLifecycleWindows(
    val interruptionAfterMillis: Long = DEFAULT_INTERRUPTION_AFTER_MILLIS,
) {
    init {
        require(interruptionAfterMillis >= 0)
    }

    fun age(now: Long, timestamp: Long): Long = if (now <= timestamp) 0 else now - timestamp
    fun isExpired(timestamp: Long, now: Long) = age(now, timestamp) >= interruptionAfterMillis

    companion object {
        /** Dashboard product policy; intentionally independent of adapter retry configuration. */
        const val DEFAULT_INTERRUPTION_AFTER_MILLIS = 30L * 60L * 1000L
    }
}
