package io.silentsuite.sync.ui.etebase

import android.accounts.Account
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ProgressBar
import androidx.activity.viewModels
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.fragment.app.commit
import androidx.fragment.app.viewModels
import com.etebase.client.Collection
import com.etebase.client.FetchOptions
import com.etebase.client.ItemMetadata
import com.etebase.client.exceptions.EtebaseException
import io.silentsuite.sync.Constants.COLLECTION_TYPES
import io.silentsuite.sync.Constants.ETEBASE_TYPE_ADDRESS_BOOK
import io.silentsuite.sync.Constants.ETEBASE_TYPE_CALENDAR
import io.silentsuite.sync.Constants.ETEBASE_TYPE_TASKS
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.ui.AccountActivity
import io.silentsuite.sync.ui.BaseActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class NewAccountWizardActivity : BaseActivity() {
    private lateinit var account: Account
    private val model: AccountViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val extras = requireNotNull(intent.extras) { "NewAccountWizardActivity requires intent extras" }
        account = requireNotNull(extras.getParcelable(EXTRA_ACCOUNT)) { "NewAccountWizardActivity requires EXTRA_ACCOUNT" }
        val etebaseSession = extras.getString(EXTRA_ETEBASE_SESSION)

        setContentView(R.layout.etebase_fragment_activity)

        if (savedInstanceState == null) {
            setTitle(R.string.account_wizard_collections_title)
            model.loadAccount(this, account, etebaseSession)
            supportFragmentManager.commit {
                replace(R.id.fragment_container, WizardCheckFragment())
            }
        }
    }

    // Issue #119: by the time this wizard finishes, LoginActivity, CreateAccountFragment,
    // and ModeSelectionActivity have all already finish()ed up the back stack. Without an
    // explicit relaunch, the task is left empty and the user is dropped to the home screen
    // — indistinguishable from a crash. Re-launching AccountActivity (the LAUNCHER) keeps
    // the user inside the app on the just-created account.
    override fun finish() {
        startActivity(
            Intent(this, AccountActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        super.finish()
    }

    companion object {
        private val EXTRA_ACCOUNT = "account"
        private val EXTRA_ETEBASE_SESSION = "etebaseSession"

        fun newIntent(context: Context, account: Account, etebaseSession: String? = null): Intent {
            val intent = Intent(context, NewAccountWizardActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            if (etebaseSession != null) intent.putExtra(EXTRA_ETEBASE_SESSION, etebaseSession)
            return intent
        }
    }
}


fun reportErrorHelper(context: Context, e: Throwable) {
    AlertDialog.Builder(context)
            .setIcon(R.drawable.ic_info_dark)
            .setTitle(R.string.exception)
            .setMessage(e.localizedMessage)
            .setPositiveButton(android.R.string.yes) { _, _ -> }.show()
}

class WizardCheckFragment : Fragment() {
    private val model: AccountViewModel by activityViewModels()
    private val loadingModel: LoadingViewModel by viewModels()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val ret = inflater.inflate(R.layout.account_wizard_check, container, false)

        if (savedInstanceState == null) {
            if (container != null) {
                initUi(inflater, ret)
                model.observe(this, {
                    checkAccountInit()
                })
            }
        }

        return ret
    }

    private fun initUi(inflater: LayoutInflater, v: View) {
        val button = v.findViewById<Button>(R.id.button_retry)
        val progress = v.findViewById<ProgressBar>(R.id.loading)
        button.setOnClickListener {
            checkAccountInit()
        }
        loadingModel.observe(this, {
            if (it) {
                progress.visibility = View.VISIBLE
                button.visibility = View.GONE
            } else {
                progress.visibility = View.GONE
                button.visibility = View.VISIBLE
            }
        })
    }

    private fun checkAccountInit() {
        val colMgr = model.value?.colMgr ?: return
        loadingModel.setLoading(true)
        lifecycleScope.launch {
            try {
                val collections = withContext(Dispatchers.IO) {
                    colMgr.list(COLLECTION_TYPES, FetchOptions().limit(1))
                }
                if (collections.data.size > 0) {
                    activity?.finish()
                } else {
                    parentFragmentManager.commit {
                        replace(R.id.fragment_container, WizardFragment())
                    }
                }
            } catch (e: Exception) {
                reportErrorHelper(requireContext(), e)
                loadingModel.setLoading(false)
            }
        }
    }
}

class WizardFragment : Fragment() {
    private val model: AccountViewModel by activityViewModels()
    private val loadingModel: LoadingViewModel by viewModels()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val ret = inflater.inflate(R.layout.account_wizard_collections, container, false)

        if (savedInstanceState == null) {
            if (container != null) {
                initUi(inflater, ret)
                // Auto-create default collections immediately — no need to ask the user
                model.observe(this, {
                    if (it != null) {
                        createCollections()
                    }
                })
            }
        }

        return ret
    }

    private fun initUi(inflater: LayoutInflater, v: View) {
        v.findViewById<Button>(R.id.button_create).setOnClickListener {
            createCollections()
        }

        v.findViewById<Button>(R.id.button_skip).setOnClickListener {
            activity?.finish()
        }

        val buttons = v.findViewById<View>(R.id.buttons_holder)
        val progress = v.findViewById<ProgressBar>(R.id.loading)
        // Hide buttons — auto-creation in progress
        buttons.visibility = View.GONE
        progress.visibility = View.VISIBLE
        loadingModel.observe(this, {
            if (it) {
                progress.visibility = View.VISIBLE
                buttons.visibility = View.GONE
            } else {
                progress.visibility = View.GONE
                buttons.visibility = View.VISIBLE
            }
        })
    }

    private fun createCollections() {
        val accountHolder = model.value ?: return
        val colMgr = accountHolder.colMgr
        loadingModel.setLoading(true)

        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val baseMeta = listOf(
                        Pair(ETEBASE_TYPE_ADDRESS_BOOK, "My Contacts"),
                        Pair(ETEBASE_TYPE_CALENDAR, "My Calendar"),
                        Pair(ETEBASE_TYPE_TASKS, "My Tasks"),
                    )

                    baseMeta.forEach {
                        val meta = ItemMetadata()
                        meta.name = it.second
                        meta.mtime = System.currentTimeMillis()

                        val col = colMgr.create(it.first, meta, "")
                        uploadCollection(accountHolder, col)
                    }
                    requestSync(requireContext(), accountHolder.account)
                }
                activity?.finish()
            } catch (e: Exception) {
                // Cooperate with structured concurrency — never swallow cancellation.
                if (e is CancellationException) throw e
                // Issue #119: previously only EtebaseException was caught, so JNI/IO/IllegalState
                // failures from the very first FS-cache write escaped the coroutine and crashed
                // the app via the default uncaught-exception handler. Log first so the next
                // logcat capture pinpoints the failure class even if the dialog is dismissed.
                Logger.log.severe("createCollections failed: ${e.javaClass.name}: ${e.message}")
                reportErrorHelper(requireContext(), e)
            } finally {
                loadingModel.setLoading(false)
            }
        }
    }

    private fun uploadCollection(accountHolder: AccountHolder, col: Collection) {
        val etebaseLocalCache = accountHolder.etebaseLocalCache
        val colMgr = accountHolder.colMgr
        colMgr.upload(col)
        try {
            synchronized(etebaseLocalCache) {
                etebaseLocalCache.collectionSet(colMgr, col)
            }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            // Issue #119: this is the very first on-disk Etebase write per username. If the
            // per-username cols/<colUid>/items directory creation fails, surface enough detail
            // to disambiguate the cause before the exception propagates up to createCollections.
            val colsPath = File(File(requireContext().filesDir, accountHolder.account.name), "cols").absolutePath
            Logger.log.severe(
                "etebaseLocalCache.collectionSet failed for colUid=${col.uid} path=$colsPath: " +
                        "${e.javaClass.name}: ${e.message}"
            )
            throw e
        }
    }
}