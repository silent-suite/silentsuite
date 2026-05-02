package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.content.Context
import android.content.Intent
import android.os.Bundle
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.etebase.NewAccountWizardActivity

/**
 * After account creation, sets bridge mode and proceeds to the collection wizard.
 * Walled garden mode has been removed.
 */
class ModeSelectionActivity : BaseActivity() {

    companion object {
        private const val EXTRA_ACCOUNT = "account"
        private const val EXTRA_ETEBASE_SESSION = "etebaseSession"
        const val PREF_NAME = "app_mode"
        const val KEY_MODE = "sync_mode"
        const val MODE_BRIDGE = "bridge"

        fun newIntent(context: Context, account: Account, etebaseSession: String? = null): Intent {
            val intent = Intent(context, ModeSelectionActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            if (etebaseSession != null) intent.putExtra(EXTRA_ETEBASE_SESSION, etebaseSession)
            return intent
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val account = requireNotNull(intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)) { "ModeSelectionActivity requires EXTRA_ACCOUNT" }
        val etebaseSession = intent.getStringExtra(EXTRA_ETEBASE_SESSION)

        // Always use bridge mode (walled garden removed)
        getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_MODE, MODE_BRIDGE)
            .apply()

        startActivity(NewAccountWizardActivity.newIntent(this, account, etebaseSession))
        finish()
    }
}
