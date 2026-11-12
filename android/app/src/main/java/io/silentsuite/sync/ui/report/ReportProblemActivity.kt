package io.silentsuite.sync.ui.report

import android.accounts.AccountManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import androidx.activity.viewModels
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.BuildConfig
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.report.ProblemReportFlow.State
import io.silentsuite.sync.ui.setup.PostLoginStartupChecks
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Settings → Help → Report a problem. Nothing leaves the device until the user presses Send (one
 * request to the report endpoint, never retried) or picks an email app. The diagnostics shown in the preview
 * are captured once when the screen opens and sent byte for byte.
 */
class ReportProblemActivity : BaseActivity() {
    private val model: ReportProblemViewModel by viewModels()

    private lateinit var kindGroup: RadioGroup
    private lateinit var summary: TextInputEditText
    private lateinit var description: TextInputEditText
    private lateinit var email: TextInputEditText
    private lateinit var includeDiagnostics: CheckBox
    private lateinit var previewGroup: View
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var send: Button
    private lateinit var emailInstead: Button
    private lateinit var copy: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_report_problem)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        model.prepare(savedInstanceState) { collectDiagnostics(applicationContext) }

        kindGroup = findViewById(R.id.report_kind)
        summary = findViewById(R.id.report_summary)
        description = findViewById(R.id.report_description)
        email = findViewById(R.id.report_email)
        includeDiagnostics = findViewById(R.id.report_include_diagnostics)
        previewGroup = findViewById(R.id.report_preview_group)
        status = findViewById(R.id.report_status)
        progress = findViewById(R.id.report_progress)
        send = findViewById(R.id.report_send)
        emailInstead = findViewById(R.id.report_email_instead)
        copy = findViewById(R.id.report_copy)

        findViewById<TextView>(R.id.report_preview).text = model.diagnostics
        findViewById<TextView>(R.id.report_disclosure).text =
            getString(R.string.report_problem_disclosure, getString(R.string.report_problem_retention))
        findViewById<View>(R.id.report_privacy_link).setOnClickListener { openPrivacyPolicy() }

        // Diagnostics default on for a problem and off for a feature request. Restored widget state
        // is applied after onCreate, and the checkbox follows the radio group, so it keeps its own value.
        kindGroup.setOnCheckedChangeListener { _, checkedId ->
            includeDiagnostics.isChecked = checkedId == R.id.report_kind_problem
        }
        includeDiagnostics.setOnCheckedChangeListener { _, checked ->
            previewGroup.visibility = if (checked) View.VISIBLE else View.GONE
        }
        previewGroup.visibility = if (includeDiagnostics.isChecked) View.VISIBLE else View.GONE

        send.setOnClickListener { onSend() }
        emailInstead.setOnClickListener { onEmailInstead() }
        copy.setOnClickListener { onCopy() }
        model.state.observe(this, ::render)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        model.save(outState)
    }

    private fun kind() =
        if (kindGroup.checkedRadioButtonId == R.id.report_kind_feature) ProblemReport.Kind.FEATURE
        else ProblemReport.Kind.PROBLEM

    private fun diagnosticsToSend(): String? = if (includeDiagnostics.isChecked) model.diagnostics else null

    private fun onSend() {
        listOf(R.id.report_summary_layout, R.id.report_description_layout, R.id.report_email_layout)
            .forEach { findViewById<TextInputLayout>(it).error = null }
        val body = try {
            ProblemReport.build(
                kind(),
                summary.text?.toString().orEmpty(),
                description.text?.toString().orEmpty(),
                email.text?.toString().orEmpty(),
                diagnosticsToSend(),
            )
        } catch (e: ProblemReport.InvalidReport) {
            showInputError(e)
            return
        }
        model.send(body)
    }

    private fun showInputError(error: ProblemReport.InvalidReport) {
        val layout = when (error.field) {
            ProblemReport.Field.SUMMARY -> R.id.report_summary_layout
            ProblemReport.Field.DESCRIPTION, ProblemReport.Field.BODY -> R.id.report_description_layout
            ProblemReport.Field.CONTACT_EMAIL -> R.id.report_email_layout
        }
        val message = when {
            error.field == ProblemReport.Field.CONTACT_EMAIL -> R.string.report_problem_error_email
            error.problem == ProblemReport.Problem.REQUIRED -> R.string.report_problem_error_required
            error.problem == ProblemReport.Problem.TOO_LONG -> R.string.report_problem_error_too_long
            else -> R.string.report_problem_error_characters
        }
        findViewById<TextInputLayout>(layout).error = getString(message)
    }

    private fun emailSubject() = ProblemReport.emailSubject(kind(), summary.text?.toString().orEmpty())
    private fun emailBody() = ProblemReport.emailBody(description.text?.toString().orEmpty(), diagnosticsToSend())

    private fun onEmailInstead() {
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:${ProblemReport.SUPPORT_EMAIL}"))
            .putExtra(Intent.EXTRA_SUBJECT, emailSubject())
            .putExtra(Intent.EXTRA_TEXT, emailBody())
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            showMessage(R.string.report_problem_email_unavailable)
        }
    }

    private fun onCopy() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val copied = try {
            clipboard?.setPrimaryClip(ClipData.newPlainText(
                getString(R.string.report_problem_clip_label), emailSubject() + "\n\n" + emailBody()))
            clipboard != null
        } catch (_: RuntimeException) {
            false
        }
        showMessage(if (copied) R.string.report_problem_copied else R.string.report_problem_copy_unavailable)
    }

    private fun openPrivacyPolicy() {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ProblemReport.PRIVACY_POLICY_URL)))
        } catch (_: ActivityNotFoundException) {
            showMessage(R.string.report_problem_link_unavailable)
        }
    }

    private fun showMessage(message: Int) {
        Snackbar.make(findViewById<View>(android.R.id.content), message, Snackbar.LENGTH_LONG).show()
    }

    private fun render(state: State) {
        val editing = state == State.EDITING
        listOf<View>(summary, description, email, includeDiagnostics,
            findViewById<RadioButton>(R.id.report_kind_problem), findViewById<RadioButton>(R.id.report_kind_feature))
            .forEach { it.isEnabled = editing }
        send.visibility = if (editing || state == State.SENDING) View.VISIBLE else View.GONE
        send.isEnabled = editing
        progress.visibility = if (state == State.SENDING) View.VISIBLE else View.GONE
        val fallbackVisible = if (state == State.SENT) View.GONE else View.VISIBLE
        emailInstead.visibility = fallbackVisible
        copy.visibility = fallbackVisible
        emailInstead.isEnabled = state != State.SENDING
        copy.isEnabled = state != State.SENDING
        val message = when (state) {
            State.EDITING -> null
            State.SENDING -> R.string.report_problem_sending
            State.SENT -> R.string.report_problem_sent
            State.UNCONFIRMED -> R.string.report_problem_unconfirmed
        }
        status.visibility = if (message == null) View.GONE else View.VISIBLE
        if (message != null) status.setText(message)
    }

    companion object {
        fun newIntent(context: Context) = Intent(context, ReportProblemActivity::class.java)

        /** Local reads only (accounts, sync evidence, in-memory startup snapshot); no network. */
        internal fun collectDiagnostics(context: Context): String {
            val manager = AccountManager.get(context)
            val store = SyncStatusStore(context)
            val hosted = Constants.serviceUrl.toString()
            val accounts = manager.getAccountsByType(App.accountType).map { account ->
                val statuses = SyncStatusStore.Service.values().mapNotNull { service ->
                    try {
                        store.status(account, service)
                    } catch (_: Exception) {
                        null
                    }
                }
                ProblemReport.AccountState(
                    customServer = ProblemReport.isCustomServer(manager.getUserData(account, AccountSettings.KEY_URI), hosted),
                    statuses = statuses,
                )
            }
            val outcome = PostLoginStartupChecks.snapshot().outcome
            return ProblemReport.diagnosticsJson(ProblemReport.DiagnosticsInput(
                versionName = BuildConfig.VERSION_NAME,
                versionCode = BuildConfig.VERSION_CODE,
                androidSdk = Build.VERSION.SDK_INT,
                accounts = accounts,
                startupOutcome = when {
                    outcome == null -> ProblemReport.StartupOutcome.NOT_RECORDED
                    outcome.succeeded -> ProblemReport.StartupOutcome.SUCCEEDED
                    else -> ProblemReport.StartupOutcome.FAILED
                },
                nowMillis = System.currentTimeMillis(),
            ))
        }
    }
}

/** Survives rotation, so the frozen diagnostics and an in-flight send are kept and never repeated. */
class ReportProblemViewModel : ViewModel() {
    private val flow = ProblemReportFlow { body ->
        // The seam is honoured only in debug builds; release always posts to the real endpoint.
        val seam = if (BuildConfig.DEBUG) transportForTest else null
        seam?.invoke(body) ?: ProblemReportTransport().post(body)
    }
    private val mutableState = MutableLiveData(State.EDITING)
    val state: LiveData<State> = mutableState

    var diagnostics: String? = null
        private set

    fun prepare(saved: Bundle?, collect: () -> String) {
        if (diagnostics != null) return
        diagnostics = saved?.getString(KEY_DIAGNOSTICS) ?: collect()
        val previous = saved?.getString(KEY_STATE)?.let { name -> State.values().firstOrNull { it.name == name } }
        // After process death a started send is never repeated; one that was in flight is unconfirmed.
        if (previous != null && previous != State.EDITING && flow.claim())
            mutableState.value = if (previous == State.SENT) State.SENT else State.UNCONFIRMED
    }

    fun save(out: Bundle) {
        out.putString(KEY_DIAGNOSTICS, diagnostics)
        out.putString(KEY_STATE, mutableState.value?.name)
    }

    fun send(body: String) {
        if (!flow.claim()) return
        mutableState.value = State.SENDING
        viewModelScope.launch(Dispatchers.IO) { mutableState.postValue(flow.deliver(body)) }
    }

    companion object {
        private const val KEY_DIAGNOSTICS = "report_problem_diagnostics"
        private const val KEY_STATE = "report_problem_state"

        /** androidTest-only send seam (cleartext MockWebServer is refused on device); ignored unless BuildConfig.DEBUG. */
        @JvmField @Volatile internal var transportForTest: ((ByteArray) -> Boolean)? = null
    }
}
