/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.cert4android

import android.util.Log
import java.util.logging.Level
import java.util.logging.Logger

object Constants {

    const val TAG = "cert4android"

    var log: Logger = Logger.getLogger(TAG)
    init {
        log.level = if (Log.isLoggable(TAG, Log.VERBOSE))
            Level.ALL
        else
            Level.INFO
    }

    const val NOTIFICATION_CERT_DECISION = 88809

}
