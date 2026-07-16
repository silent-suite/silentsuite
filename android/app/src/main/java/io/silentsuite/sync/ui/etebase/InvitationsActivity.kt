package io.silentsuite.sync.ui.etebase

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.viewModels
import androidx.fragment.app.commit
import io.silentsuite.sync.R
import io.silentsuite.sync.App
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.setup.ExactAccountRouting

class InvitationsActivity : BaseActivity() {
    private lateinit var account: Account
    private val model: AccountViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val requestedAccount = intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)
        val creationId = intent.getStringExtra(EXTRA_CREATION_ID)
        account = ExactAccountRouting.validate(requestedAccount, creationId, App.accountType,
            AccountManager.get(this)) ?: run {
            finish()
            return
        }

        setContentView(R.layout.etebase_fragment_activity)

        if (savedInstanceState == null) {
            model.loadAccount(this, account)
            title = getString(R.string.invitations_title)
            supportFragmentManager.commit {
                replace(R.id.fragment_container, InvitationsListFragment())
            }
        }

        supportActionBar?.setDisplayHomeAsUpEnabled(true)
    }

    companion object {
        private val EXTRA_ACCOUNT = "account"
        private const val EXTRA_CREATION_ID = "account_creation_id"

        fun newIntent(context: Context, account: Account, creationId: String): Intent {
            require(creationId.isNotBlank()) { "Creation ID must be nonblank" }
            val intent = Intent(context, InvitationsActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            intent.putExtra(EXTRA_CREATION_ID, creationId)
            return intent
        }
    }
}
