package io.silentsuite.sync.birthdays

import io.silentsuite.sync.syncadapter.SyncStatusStore

/** Whether one Birthdays maintenance run may use the main account row it re-selected (plan amendment G2 §2.1). */
internal enum class BirthdayOwnership { PROCEED, NO_ACCOUNT, NO_GENERATION, NO_ADMISSION, STALE_RUN }

/**
 * Tests-first placeholder for the ownership decision (G2 §2.1, J1). Fail-closed: it never answers
 * [BirthdayOwnership.PROCEED] and decides nothing yet. It has no caller outside its JVM test.
 */
@Suppress("UNUSED_PARAMETER")
internal fun birthdayOwnership(
    rowPresent: Boolean,
    creationId: String?,
    admitted: SyncStatusStore.MainIdentity?,
    identityOf: (String) -> SyncStatusStore.MainIdentity,
): BirthdayOwnership = BirthdayOwnership.NO_ACCOUNT
