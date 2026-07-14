/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU General Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.cert4android

/**
 * Serializes the activity's certificate-display lifecycle.
 *
 * A parse result is useful only if it belongs to the request that is still current.  The
 * controller deliberately keeps the raw certificate together with its generation, so a
 * decision can only be made for exactly what was rendered.
 */
class TrustCertificateState {

    class ParseRequest internal constructor(
        internal val version: Long,
        internal val generation: String,
        internal val certificate: ByteArray
    )

    class Decision internal constructor(
        val generation: String,
        certificate: ByteArray
    ) {
        val certificate = certificate.clone()
    }

    data class Details(
        val issuedFor: String,
        val issuedBy: String,
        val validFrom: String,
        val validTo: String,
        val sha1: String,
        val sha256: String
    )

    data class Screen(
        val details: Details? = null,
        val ready: Boolean = false
    )

    private var version = 0L
    private var current: ParseRequest? = null
    private var rendered: Decision? = null

    @Synchronized
    fun begin(generation: String?, certificate: ByteArray?): ParseRequest? {
        version++
        rendered = null
        val request = if (generation != null && certificate != null)
            ParseRequest(version, generation, certificate.clone())
        else
            null
        current = request
        return request
    }

    /** Returns a ready screen only when this completion still belongs to the current request. */
    @Synchronized
    fun complete(request: ParseRequest, details: Details): Screen? {
        if (current?.version != request.version)
            return null
        rendered = Decision(request.generation, request.certificate)
        return Screen(details, ready = true)
    }

    /** The decision snapshot is absent while loading, invalid, or superseded. */
    @Synchronized
    fun decision(): Decision? = rendered?.let { Decision(it.generation, it.certificate) }
}
