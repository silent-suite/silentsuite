/*
 * Copyright © 2013 – 2015 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */
package io.silentsuite.sync.ui.setup

import android.content.Context
import com.etebase.client.Account
import com.etebase.client.Client
import io.silentsuite.sync.Constants
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.log.Logger
import java.io.Serializable
import java.net.URI

class BaseConfigurationFinder(protected val context: Context, protected val credentials: LoginCredentials) {
    protected var httpClient: okhttp3.OkHttpClient

    init {
        httpClient = HttpClient.Builder(context).build().okHttpClient
    }

    fun findInitialConfiguration(): Configuration {
        var exception: Throwable? = null

        val uri = credentials.uri ?: URI(Constants.etebaseServiceUrl)

        var etebaseSession: String? = null
        try {
            val client = Client.create(httpClient, uri.toString())
            val etebase = Account.login(client, credentials.userName, credentials.password)
            etebaseSession = etebase.save(null)
        } catch (e: java.lang.Exception) {
            Logger.log.warning(e.localizedMessage)
            exception = e
        }

        return Configuration(
                uri,
                credentials.userName,
                etebaseSession,
                exception
        )
    }

    // data classes

    class Configuration
    // We have to use URI here because HttpUrl is not serializable!

    (val url: URI?, val userName: String, val etebaseSession: String?, var error: Throwable?) : Serializable {
        var rawPassword: String? = null
        var password: String? = null

        val isFailed: Boolean
            get() = this.error != null

        override fun toString(): String {
            return "BaseConfigurationFinder.Configuration(url=" + this.url + ", userName=" + this.userName + ", error=" + this.error + ", failed=" + this.isFailed + ")"
        }
    }

}
