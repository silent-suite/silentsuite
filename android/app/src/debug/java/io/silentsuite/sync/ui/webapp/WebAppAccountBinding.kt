/*
 * Copyright © SilentSuite contributors.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.webapp

import java.net.URI
import java.security.MessageDigest

/**
 * Ties the web view's stored data to one Android account row.
 *
 * Each account gets its own web storage profile, named after the account's
 * type, name and creation ID. A removed account, another account, or a new
 * account with an old name therefore never sees an earlier profile, and
 * profiles that belong to no registered account are deleted.
 */
internal object WebAppAccountBinding {
    const val PROFILE_PREFIX = "webapp-"

    /** The profile name for an account row, or null when the row cannot be bound. */
    fun profileName(accountType: String, accountName: String, creationId: String?): String? {
        if (accountType.isBlank() || accountName.isBlank() || creationId.isNullOrBlank()) return null
        val digest = MessageDigest.getInstance("SHA-256")
        for (part in listOf(accountType, accountName, creationId)) {
            val bytes = part.toByteArray(Charsets.UTF_8)
            // Length-prefixed, so no two different rows share one input.
            digest.update(bytes.size.toString().toByteArray(Charsets.US_ASCII))
            digest.update(0)
            digest.update(bytes)
        }
        return PROFILE_PREFIX + digest.digest().take(16).joinToString("") { "%02x".format(it) }
    }

    /**
     * Profiles of this feature that belong to none of the registered accounts
     * ([live]) and must be deleted. Another account's profile is never stale:
     * it may hold edits that have not been synced yet.
     */
    fun staleProfiles(allProfiles: Collection<String>, live: Set<String>): List<String> =
        allProfiles.filter { it.startsWith(PROFILE_PREFIX) && it !in live }

    /**
     * Whether the account syncs with the hosted service the bundle talks to.
     * An account without a stored server uses the app's built-in one.
     */
    fun isHostedAccount(accountServerUri: String?, builtInServerUri: String, hostedSyncOrigin: WebAppRequestPolicy.Origin): Boolean {
        val server = accountServerUri ?: builtInServerUri
        if (WebAppRequestPolicy.Origin.of(server) != hostedSyncOrigin) return false
        // The hosted service lives at the root of its address; another path is another server.
        val uri = try { URI(server) } catch (_: Exception) { return false }
        return uri.rawPath.isNullOrEmpty() || uri.rawPath == "/"
    }
}
