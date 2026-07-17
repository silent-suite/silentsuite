/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.setup

/** Maps only durable row and generation evidence after an interrupted creation attempt. */
object DurableCreationAttemptPolicy {
    data class Evidence(
        val rowPresent: Boolean,
        val creationId: String?,
        val registryOwnsCreationId: Boolean,
        val state: PostLoginSetupState?
    )

    enum class Outcome { RetryCredentials, SettingsResolution, Recovery, Created, Completed }

    fun outcome(evidence: Evidence): Outcome = when {
        !evidence.rowPresent -> Outcome.RetryCredentials
        evidence.creationId == null || !evidence.registryOwnsCreationId -> Outcome.SettingsResolution
        evidence.state == PostLoginSetupState.CREATING || evidence.state == PostLoginSetupState.RECOVERY_REQUIRED -> Outcome.Recovery
        evidence.state in setOf(
            PostLoginSetupState.ACCOUNT_CREATED,
            PostLoginSetupState.COLLECTIONS,
            PostLoginSetupState.PERMISSIONS,
            PostLoginSetupState.INITIAL_SYNC,
            PostLoginSetupState.READY
        ) -> Outcome.Created
        evidence.state == PostLoginSetupState.COMPLETE -> Outcome.Completed
        else -> Outcome.SettingsResolution
    }
}
