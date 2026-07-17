package io.silentsuite.sync.ui.etebase

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.viewModels
import androidx.fragment.app.commit
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.setup.ExactAccountRouting

class InvitationsActivity : BaseActivity() {
    private lateinit var account: Account
    private val model: AccountViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val extras = intent.extras ?: run { finish(); return }
        val requestedAccount = extras.getParcelable<Account>(EXTRA_ACCOUNT)
        val creationId = extras.getString(EXTRA_CREATION_ID)?.takeIf { it.isNotBlank() }
        val exactAccount = if (requestedAccount != null && creationId != null) {
            ExactAccountRouting.validate(requestedAccount, creationId, App.accountType, AccountManager.get(this))
        } else null
        account = exactAccount ?: run { finish(); return }
        val identity = InvitationLifecycleIdentity(account, requireNotNull(creationId))

        setContentView(R.layout.etebase_fragment_activity)
        // Runtime invitation fixtures are deliberately process-only: do not create an
        // AccountViewModel/session (and consequently no Etebase/JNI objects) for them.
        if (invitationsOverride == null) {
            model.loadAccount(this, account, requireNotNull(creationId))
        }
        title = getString(R.string.invitations_title)
        if (supportFragmentManager.findFragmentById(R.id.fragment_container) == null) {
            supportFragmentManager.commit {
                replace(R.id.fragment_container, InvitationsListFragment.newInstance(identity))
            }
        }

        supportActionBar?.setDisplayHomeAsUpEnabled(true)
    }

    companion object {
        private const val EXTRA_ACCOUNT = "account"
        private const val EXTRA_CREATION_ID = "creationId"

        fun newIntent(context: Context, account: Account, creationId: String): Intent =
            Intent(context, InvitationsActivity::class.java).apply {
                require(creationId.isNotBlank()) { "Creation ID must be nonblank" }
                putExtra(EXTRA_ACCOUNT, account)
                putExtra(EXTRA_CREATION_ID, creationId)
            }
    }
}

/** Non-secret exact account generation carried by the restored Invitations fragment. */
data class InvitationLifecycleIdentity(val account: Account, val creationId: String) {
    init {
        require(account.type == App.accountType)
        require(account.name.isNotBlank())
        require(creationId.isNotBlank())
    }

    fun toBundle() = Bundle(2).apply {
        putParcelable(ARG_ACCOUNT, account)
        putString(ARG_CREATION_ID, creationId)
    }

    fun validate(context: Context): Boolean =
        ExactAccountRouting.validate(account, creationId, App.accountType, AccountManager.get(context)) == account

    companion object {
        private const val ARG_ACCOUNT = "invitation.identity.account"
        private const val ARG_CREATION_ID = "invitation.identity.creationId"

        fun from(bundle: Bundle?): InvitationLifecycleIdentity? {
            val account = bundle?.getParcelable<Account>(ARG_ACCOUNT) ?: return null
            val creationId = bundle.getString(ARG_CREATION_ID) ?: return null
            return runCatching { InvitationLifecycleIdentity(account, creationId) }.getOrNull()
        }
    }
}
