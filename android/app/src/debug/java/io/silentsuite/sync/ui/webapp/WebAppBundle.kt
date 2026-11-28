/*
 * Copyright © SilentSuite contributors.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.webapp

import android.content.res.AssetManager
import org.json.JSONObject
import java.io.InputStream

/**
 * The static copy of the web app packaged into debug builds under
 * `assets/webapp/` by `apps/web/android-bundle/build.mjs`.
 */
internal class WebAppBundle private constructor(
    private val assets: AssetManager,
    val origin: WebAppRequestPolicy.Origin,
    val originUrl: String,
    val startPath: String,
    val notFoundPath: String,
    val syncServerOrigin: WebAppRequestPolicy.Origin,
    val connectOrigins: Set<WebAppRequestPolicy.Origin>,
    private val files: Map<String, File>,
) {
    class File(val asset: String, val contentType: String, val contentSecurityPolicy: String?)

    val paths: Set<String> get() = files.keys

    fun file(path: String): File? = files[path]

    fun open(file: File): InputStream = assets.open("$ROOT/${file.asset}")

    companion object {
        private const val ROOT = "webapp"
        private const val SCHEMA_VERSION = 1

        /** The packaged bundle, or null when this build carries none or it cannot be read. */
        fun load(assets: AssetManager): WebAppBundle? = try {
            val manifest = JSONObject(assets.open("$ROOT/manifest.json").use { it.readBytes().toString(Charsets.UTF_8) })
            require(manifest.getInt("schemaVersion") == SCHEMA_VERSION)
            val originUrl = manifest.getString("origin")
            val origins = manifest.getJSONArray("connectOrigins")
            val entries = manifest.getJSONObject("files")
            val files = HashMap<String, File>()
            for (path in entries.keys()) {
                val entry = entries.getJSONObject(path)
                val asset = entry.getString("asset")
                // Stored names are a hash and an extension; nothing else is opened.
                require(ASSET_NAME.matches(asset))
                files[path] = File(asset, entry.getString("contentType"), entry.optString("contentSecurityPolicy").ifEmpty { null })
            }
            val bundle = WebAppBundle(
                assets = assets,
                origin = requireNotNull(WebAppRequestPolicy.Origin.of(originUrl)),
                originUrl = originUrl,
                startPath = manifest.getString("startPath"),
                notFoundPath = manifest.getString("notFoundPath"),
                syncServerOrigin = requireNotNull(WebAppRequestPolicy.Origin.of(manifest.getString("syncServerOrigin"))),
                connectOrigins = (0 until origins.length()).map { requireNotNull(WebAppRequestPolicy.Origin.of(origins.getString(it))) }.toSet(),
                files = files,
            )
            // Every page must come with its policy, and the two fixed pages must exist.
            require(files.values.all { it.contentType != "text/html" || it.contentSecurityPolicy != null })
            require(bundle.file(bundle.startPath)?.contentType == "text/html")
            require(bundle.file(bundle.notFoundPath)?.contentType == "text/html")
            require(bundle.origin.scheme == "https" && bundle.connectOrigins.all { it.scheme == "https" })
            bundle
        } catch (_: Exception) {
            null
        }

        private val ASSET_NAME = Regex("files/[0-9a-f]{64}\\.[a-z0-9]{1,8}")
    }
}
