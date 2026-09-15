package io.silentsuite.sync.ui.setup

/**
 * Allowlisted, content-free startup bootstrap outcome. Every field is an enum: account names,
 * creation IDs, server URIs, registry contents and raw exception messages are never carried.
 */
data class PostLoginStartupOutcome(
    val phase: Phase,
    val reason: Reason,
    val exceptionCategory: ExceptionCategory = ExceptionCategory.NONE,
) {
    enum class Phase { REGISTRY_READ, CLASSIFY_ROWS, RECONCILE_PENDING, MARKER_COMMIT, DONE }

    /** One value per production fail-closed boundary; ownership safety is unchanged by reporting. */
    enum class Reason {
        NONE,
        REGISTRY_UNREADABLE,
        CLASSIFY_PENDING_ROW_RECOVERY_FAILED,
        CLASSIFY_CREATION_ID_WRITE_FAILED,
        CLASSIFY_STATE_RECOVERY_FAILED,
        RECONCILE_REGISTRY_UNREADABLE,
        RECONCILE_CLEAR_MISSING_ROW_FAILED,
        RECONCILE_QUARANTINE_MISMATCH_FAILED,
        RECONCILE_ACTIVATE_FAILED,
        RECONCILE_CLEAR_OWNED_FAILED,
        RECONCILE_RECOVERY_RECORD_FAILED,
        MARKER_COMMIT_FAILED,
        MARKER_READBACK_FAILED,
        EXCEPTION,
    }

    /** Coarse type only; the exception message and stack are deliberately discarded. */
    enum class ExceptionCategory { NONE, SECURITY, ILLEGAL_STATE, ILLEGAL_ARGUMENT, OTHER }

    /** Which startup check produced the latest outcome in this process. */
    enum class Source { LAUNCH, RETRY }

    val succeeded: Boolean get() = reason == Reason.NONE

    companion object {
        val SUCCEEDED = PostLoginStartupOutcome(Phase.DONE, Reason.NONE)

        fun failed(phase: Phase, reason: Reason) = PostLoginStartupOutcome(phase, reason)

        fun exception(phase: Phase, error: Exception) =
            PostLoginStartupOutcome(phase, Reason.EXCEPTION, categorize(error))

        internal fun categorize(error: Exception): ExceptionCategory = when (error) {
            is SecurityException -> ExceptionCategory.SECURITY
            is IllegalStateException -> ExceptionCategory.ILLEGAL_STATE
            is IllegalArgumentException -> ExceptionCategory.ILLEGAL_ARGUMENT
            else -> ExceptionCategory.OTHER
        }
    }
}
