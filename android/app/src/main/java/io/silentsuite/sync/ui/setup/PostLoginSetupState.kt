package io.silentsuite.sync.ui.setup

/** Durable, non-secret setup state. Values are persisted verbatim in AccountManager. */
enum class PostLoginSetupState {
    CREATING, ACCOUNT_CREATED, COLLECTIONS, PERMISSIONS, INITIAL_SYNC, READY, COMPLETE,
    RECOVERY_REQUIRED;

    fun advance(): PostLoginSetupState = when (this) {
        CREATING -> ACCOUNT_CREATED
        ACCOUNT_CREATED -> COLLECTIONS
        COLLECTIONS -> PERMISSIONS
        PERMISSIONS -> INITIAL_SYNC
        INITIAL_SYNC -> READY
        READY, COMPLETE, RECOVERY_REQUIRED -> this
    }

    /** Completion is an explicit user acknowledgement, never an inferred sync result. */
    fun done(): PostLoginSetupState = if (this == READY) COMPLETE else this

    /** Inventory is complete before integration choices; sync is requested but never awaited. */
    fun afterCollections(): PostLoginSetupState = if (this == COLLECTIONS) PERMISSIONS else this

    fun continueWithCurrentIntegrations(): PostLoginSetupState =
        if (this == PERMISSIONS) INITIAL_SYNC else this

    fun afterInitialSyncRequested(): PostLoginSetupState =
        if (this == INITIAL_SYNC) READY else this

    val isComplete: Boolean get() = this == COMPLETE

    companion object {
        fun decode(value: String?, bootstrapped: Boolean): PostLoginSetupState? {
            if (value == null) return if (bootstrapped) RECOVERY_REQUIRED else null
            return values().firstOrNull { it.name == value } ?: RECOVERY_REQUIRED
        }
    }
}
