package io.silentsuite.sync.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle

/**
 * Legacy stub — was used only by EteSync v1 journal item viewing.
 * Scheduled for removal in story A1.2.
 */
class JournalItemActivity : BaseActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Legacy activity — finish immediately
        finish()
    }

    companion object {
        val KEY_SYNC_ENTRY = "syncEntry"

        fun newIntent(context: Context): Intent {
            return Intent(context, JournalItemActivity::class.java)
        }
    }
}
