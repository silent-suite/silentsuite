/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android

import java.util.logging.Level
import java.util.logging.Logger

object Ical4Android {

    val log: Logger = Logger.getLogger("ical4android")

    const val ical4jVersion = BuildConfig.version_ical4j


    init {
        if (BuildConfig.DEBUG)
            log.level = Level.ALL
    }

    fun checkThreadContextClassLoader() {
        if (Thread.currentThread().contextClassLoader == null)
            throw IllegalStateException("Thread.currentThread().contextClassLoader must be set")
    }

}
