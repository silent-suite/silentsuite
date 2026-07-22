package io.silentsuite.sync.ui.setup

/**
 * Deterministic ownership protocol for the Android-facing creator.  The platform adapter supplies
 * read-back operations; this pure coordinator quarantines only failures before the durable
 * ACCOUNT_CREATED boundary instead of retracting an already usable exact-owned row.
 */
class AccountCreationCoordinator(private val seams: Seams) {
    interface Seams {
        fun rowExists(): Boolean
        fun prepare(id: String): Boolean
        fun add(): Boolean
        fun writeAndReadBack(key: String, value: String?): Boolean
        fun activateAndReadBack(): Boolean
        fun phase(id: String, phase: AccountCreationRegistry.Phase): Boolean
        fun clear(id: String): Boolean
        /** Exact-owned pre-boundary repair: durable row and registry must both say recovery. */
        fun quarantine(id: String): Boolean = false
    }
    enum class Result { CREATED, ACCOUNT_CREATED_QUARANTINED, EXISTS_OR_BUSY, NOT_ADDED, QUARANTINED, QUARANTINE_FAILED }

    private fun quarantine(id: String): Result =
        if (seams.quarantine(id)) Result.QUARANTINED else Result.QUARANTINE_FAILED

    fun create(id: String, fields: List<Pair<String, String?>>): Result {
        if (seams.rowExists() || !seams.prepare(id)) return Result.EXISTS_OR_BUSY
        if (!seams.add()) {
            return if (seams.clear(id)) Result.NOT_ADDED else Result.QUARANTINED
        }
        if (!seams.writeAndReadBack("post_login_creation_id", id)) return quarantine(id)
        if (!seams.phase(id, AccountCreationRegistry.Phase.CREATING) ||
            !seams.writeAndReadBack("post_login_setup_state_v1", "CREATING")) return quarantine(id)
        if (fields.any { !seams.writeAndReadBack(it.first, it.second) } ||
            !seams.writeAndReadBack("post_login_setup_state_v1", "ACCOUNT_CREATED")) return quarantine(id)
        // Activation and registry cleanup are post-boundary repair work. Their failure must not
        // rewrite the exact durable ACCOUNT_CREATED row to recovery.
        if (!seams.activateAndReadBack() || !seams.clear(id)) return Result.ACCOUNT_CREATED_QUARANTINED
        return Result.CREATED
    }
}
