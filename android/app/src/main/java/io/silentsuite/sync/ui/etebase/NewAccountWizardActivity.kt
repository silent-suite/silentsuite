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
import com.google.android.material.dialog.MaterialAlertDialogBuilder
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
import io.silentsuite.sync.ui.setup.SetupSecretHolder
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class NewAccountWizardActivity : BaseActivity() {
    private lateinit var account: Account
    private val model: AccountViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val extras = requireNotNull(intent.extras) { "NewAccountWizardActivity requires intent extras" }
        account = requireNotNull(extras.getParcelable(EXTRA_ACCOUNT)) { "NewAccountWizardActivity requires EXTRA_ACCOUNT" }
        val etebaseSession = SetupSecretHolder.consumePendingSession(account.name)

        setContentView(R.layout.etebase_fragment_activity)
        setTitle(R.string.account_wizard_collections_title)

        // AccountSettings is the durable source after process death. The process-only session
        // is only an optional first-launch override while AccountManager user data settles.
        // initialize() is idempotent for a retained ViewModel, but starts a fresh ViewModel on
        // every new Activity instance.
        model.initialize(this, account, etebaseSession)

        if (savedInstanceState == null) {
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
            AccountActivity.newIntent(this, account)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        super.finish()
    }

    companion object {
        private val EXTRA_ACCOUNT = "account"

        fun newIntent(context: Context, account: Account): Intent {
            val intent = Intent(context, NewAccountWizardActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            return intent
        }
    }
}


fun reportErrorHelper(context: Context, e: Throwable) {
    MaterialAlertDialogBuilder(context)
            .setIcon(R.drawable.ic_info_dark)
            .setTitle(R.string.exception)
            .setMessage(e.localizedMessage)
            .setPositiveButton(android.R.string.yes) { _, _ -> }.show()
}

class WizardCheckFragment : Fragment() {
    private val model: AccountViewModel by activityViewModels()
    private val loadingModel: LoadingViewModel by viewModels()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.account_wizard_check, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        initUi(view)
        model.observe(viewLifecycleOwner) {
            checkAccountInit()
        }
    }

    private fun initUi(v: View) {
        val button = v.findViewById<Button>(R.id.button_retry)
        val progress = v.findViewById<ProgressBar>(R.id.loading)
        button.setOnClickListener {
            checkAccountInit()
        }
        loadingModel.observe(viewLifecycleOwner, {
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
        if (loadingModel.isLoading)
            return
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
    private var automaticCreationStarted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        automaticCreationStarted = savedInstanceState?.getBoolean(KEY_AUTOMATIC_CREATION_STARTED) ?: false
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.account_wizard_collections, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        initUi(view)
        // Auto-create once per restored wizard state. A recreated view still receives model
        // updates and working controls, but does not start a second collection creation job.
        model.observe(viewLifecycleOwner) {
            if (!automaticCreationStarted) {
                automaticCreationStarted = true
                createCollections()
            } else if (!loadingModel.isLoading) {
                loadingModel.setLoading(false)
            }
        }
    }

    private fun initUi(v: View) {
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
        loadingModel.observe(viewLifecycleOwner, {
            if (it) {
                progress.visibility = View.VISIBLE
                buttons.visibility = View.GONE
            } else {
                progress.visibility = View.GONE
                buttons.visibility = View.VISIBLE
            }
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(KEY_AUTOMATIC_CREATION_STARTED, automaticCreationStarted)
    }

    private fun createCollections() {
        val accountHolder = model.value ?: return
        if (loadingModel.isLoading)
            return
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
                Logger.log.severe("createCollections failed: ${e.javaClass.name}")
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
            Logger.log.severe(
                "etebaseLocalCache.collectionSet failed under app files dir: " +
                        e.javaClass.name
            )
            throw e
        }
    }

    companion object {
        private const val KEY_AUTOMATIC_CREATION_STARTED = "automaticCreationStarted"
    }
}
