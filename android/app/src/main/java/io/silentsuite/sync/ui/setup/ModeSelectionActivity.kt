package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.RadioButton
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.etebase.NewAccountWizardActivity

/**
 * Mode selector screen presented after account creation.
 *
 * Bridge Mode (default): Syncs to phone's calendar/contacts/tasks apps via sync adapter.
 * Walled Garden: Data stays in Etebase cache only, accessible via web app.
 *
 * The choice is persisted to SharedPreferences and read by the sync adapter
 * to decide whether to register content providers.
 */
class ModeSelectionActivity : BaseActivity() {

    companion object {
        private const val EXTRA_ACCOUNT = "account"
        const val PREF_NAME = "app_mode"
        const val KEY_MODE = "sync_mode"
        const val MODE_BRIDGE = "bridge"
        const val MODE_WALLED = "walled"

        fun newIntent(context: Context, account: Account): Intent {
            val intent = Intent(context, ModeSelectionActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            return intent
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.mode_selector_fragment)

        val account = intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)!!

        val bridgeRadio = findViewById<RadioButton>(R.id.mode_bridge_radio)
        val walledRadio = findViewById<RadioButton>(R.id.mode_walled_radio)

        // Card click toggles radio
        findViewById<android.view.View>(R.id.mode_bridge_card).setOnClickListener {
            bridgeRadio.isChecked = true
            walledRadio.isChecked = false
        }
        findViewById<android.view.View>(R.id.mode_walled_card).setOnClickListener {
            walledRadio.isChecked = true
            bridgeRadio.isChecked = false
        }

        // Radio mutual exclusion
        bridgeRadio.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) walledRadio.isChecked = false
        }
        walledRadio.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) bridgeRadio.isChecked = false
        }

        findViewById<android.view.View>(R.id.mode_continue).setOnClickListener {
            val mode = if (bridgeRadio.isChecked) MODE_BRIDGE else MODE_WALLED
            getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_MODE, mode)
                .apply()

            // Proceed to collection wizard (which creates default collections + starts sync)
            startActivity(NewAccountWizardActivity.newIntent(this, account))
            finish()
        }
    }
}
