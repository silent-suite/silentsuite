/*
 * Copyright © SilentSuite contributors.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.webapp

import java.net.URI
import java.util.Locale

/**
 * Decides what the bundled web view may load and where it may navigate.
 *
 * The bundled pages are answered under [appOrigin] and never fetched from the
 * network, so a file the bundle lacks is "not found" even though a real site
 * exists at that address. Everything else is refused unless it is a request
 * (not a page) to one of [connectOrigins].
 */
internal class WebAppRequestPolicy(
    private val appOrigin: Origin,
    private val connectOrigins: Set<Origin>,
    private val bundledPaths: Set<String>,
) {
    data class Origin(val scheme: String, val host: String, val port: Int) {
        companion object {
            /** The origin of an absolute http(s) URL without user info, or null. */
            fun of(url: String): Origin? {
                val uri = try { URI(url) } catch (_: Exception) { return null }
                val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
                val defaultPort = when (scheme) { "https" -> 443; "http" -> 80; else -> return null }
                if (uri.rawUserInfo != null) return null
                val host = uri.host?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() } ?: return null
                return Origin(scheme, host, if (uri.port == -1) defaultPort else uri.port)
            }
        }
    }

    sealed interface Request {
        /** Answer with the bundled file for [path]. */
        data class Bundled(val path: String) : Request
        /** The address is ours but the bundle has no such file. */
        object NotFound : Request
        /** The address is ours but only GET and HEAD can be answered from files. */
        object MethodNotAllowed : Request
        /** Let the web view fetch it. */
        object Network : Request
        object Blocked : Request
    }

    enum class Navigation { IN_APP, EXTERNAL_BROWSER, BLOCKED }

    fun request(url: String, method: String, isMainFrame: Boolean): Request {
        // data: URLs carry their own bytes; the page policy limits where they may be used.
        if (!isMainFrame && url.startsWith("data:", ignoreCase = true)) return Request.Network
        val origin = Origin.of(url) ?: return Request.Blocked
        if (origin == appOrigin) {
            if (!method.equals("GET", ignoreCase = true) && !method.equals("HEAD", ignoreCase = true)) return Request.MethodNotAllowed
            val path = try { URI(url).path } catch (_: Exception) { null }
            return if (path != null && path in bundledPaths) Request.Bundled(path) else Request.NotFound
        }
        if (!isMainFrame && origin in connectOrigins) return Request.Network
        return Request.Blocked
    }

    fun navigation(url: String, hasGesture: Boolean, isRedirect: Boolean): Navigation {
        val origin = Origin.of(url) ?: return Navigation.BLOCKED
        if (origin == appOrigin) return Navigation.IN_APP
        // A link the person tapped opens in their browser; nothing else leaves the bundle.
        return if (origin.scheme == "https" && hasGesture && !isRedirect) Navigation.EXTERNAL_BROWSER else Navigation.BLOCKED
    }
}
