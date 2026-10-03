package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.fragment.app.commit
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.NotesSyncPolicy
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.setup.ExactAccountRouting

/**
 * Read-only Notes screen (experimental): notebook list, note list, note viewer. The route is
 * exact-account bound like every other account surface, and it only exists while the account
 * has Notes enabled. Opening it triggers a Notes sync; the content itself is read from the cache.
 */
class NotesActivity : BaseActivity() {
    private var exactAccount: Account? = null
    private var exactCreationId: String? = null

    internal val account: Account?
        get() = exactAccount
    internal val creationId: String?
        get() = exactCreationId

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val manager = AccountManager.get(this)
        val explicit = intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)
        val expectedCreationId = intent.getStringExtra(EXTRA_CREATION_ID)?.takeIf { it.isNotBlank() }
        val resolved = ExactAccountRouting.validate(explicit, expectedCreationId, App.accountType, manager)
        if (resolved == null || expectedCreationId == null || !AccountSettings.notesEnabled(manager, resolved)) {
            finish()
            return
        }
        exactAccount = resolved
        exactCreationId = expectedCreationId

        setContentView(R.layout.etebase_fragment_activity)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        title = getString(R.string.notes_title)
        if (savedInstanceState == null) {
            supportFragmentManager.commit {
                replace(R.id.fragment_container, NotebookListFragment.newInstance(resolved, expectedCreationId))
            }
            // Opening the screen is one of the Notes sync triggers; rotation is not. It is not a
            // user sync gesture, so it honors the account's Wi-Fi-only restriction.
            NotesSyncCoordinator.request(applicationContext, resolved, expectedCreationId, NotesSyncPolicy.Trigger.SCREEN_OPEN)
        }
    }

    override fun onResume() {
        super.onResume()
        if (!exactAccountStillCurrent()) finish()
    }

    /** True while the exact generation is present and Notes is still enabled for it. */
    internal fun exactAccountStillCurrent(): Boolean {
        val account = exactAccount ?: return false
        val creationId = exactCreationId ?: return false
        val manager = AccountManager.get(this)
        return ExactAccountRouting.validate(account, creationId, App.accountType, manager) != null &&
            AccountSettings.notesEnabled(manager, account)
    }

    internal fun identity(): ExactAccountIdentity? {
        val account = exactAccount ?: return null
        val creationId = exactCreationId ?: return null
        return ExactAccountIdentity(account.type, account.name, creationId)
    }

    override fun onSupportNavigateUp(): Boolean {
        if (!supportFragmentManager.popBackStackImmediate()) finish()
        return true
    }

    companion object {
        internal const val EXTRA_ACCOUNT = "account"
        internal const val EXTRA_CREATION_ID = "creationId"

        fun newIntent(context: Context, account: Account, creationId: String): Intent {
            require(creationId.isNotBlank()) { "Creation ID must be nonblank" }
            return Intent(context, NotesActivity::class.java)
                .putExtra(EXTRA_ACCOUNT, account)
                .putExtra(EXTRA_CREATION_ID, creationId)
        }
    }
}
