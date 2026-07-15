package io.silentsuite.sync.ui.setup

/**
 * Pure retry coordinator.  Remote inventory is authoritative; local-cache success is never used
 * as proof that an upload succeeded.  An upload exception is uncertain, so it always re-inventories
 * before another create attempt.
 */
object CollectionReconciliation {
    sealed class Result { object Ready : Result(); object Limited : Result(); object Recovery : Result() }

    fun reconcile(
        required: List<String>,
        refresh: () -> List<CollectionEligibility.Collection>,
        createAndCache: (String) -> Unit,
        maxUncertainAttempts: Int = required.size + 1
    ): Result {
        var uncertainAttempts = 0
        val limit = maxUncertainAttempts.coerceAtLeast(1)
        while (true) {
            val inventory = refresh()
            val missing = CollectionEligibility.missingTypes(inventory, required)
            if (missing.isEmpty()) return Result.Ready
            try {
                createAndCache(missing.first())
                // Success is also uncertain until the next remote inventory says so.
                uncertainAttempts++
            } catch (cancelled: java.util.concurrent.CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                uncertainAttempts++
            }
            // The next loop always refreshes. A server-side success after a timeout or a
            // cache failure is therefore deduped. Permanent invisibility is bounded too.
            if (uncertainAttempts >= limit) {
                // Never classify against the inventory from before the last upload attempt.
                val finalInventory = refresh()
                if (CollectionEligibility.missingTypes(finalInventory, required).isEmpty()) return Result.Ready
                return if (finalInventory.any { !it.removed }) Result.Limited else Result.Recovery
            }
        }
    }
}
