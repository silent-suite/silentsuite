/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.content.Intent
import android.os.Bundle

/**
 * Legacy AccountSettingsActivity — now redirects to the consolidated AppSettingsActivity.
 * Kept for backward compatibility with notification intents and manifest declarations.
 */
class AccountSettingsActivity : BaseActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Redirect to the consolidated App Settings screen
        startActivity(Intent(this, AppSettingsActivity::class.java))
        finish()
    }
}
