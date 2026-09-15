package io.silentsuite.sync.ui.setup

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.DialogInterface
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.TextView
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.FragmentActivity
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.R

/**
 * Previews the exact startup report snapshot. Copy and Share act on that same string; nothing is
 * uploaded or sent unless the user picks a share target.
 */
class StartupDiagnosticReportDialog : DialogFragment() {
    // An AlertDialog content view has no parent at inflation time.
    @SuppressLint("InflateParams")
    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val report = requireArguments().getString(ARG_REPORT).orEmpty()
        // getLayoutInflater() would re-enter onCreateDialog for a DialogFragment.
        val content = LayoutInflater.from(requireContext())
            .inflate(R.layout.dialog_startup_diagnostic_report, null)
        content.findViewById<TextView>(R.id.startup_report_text).text = report
        val dialog = MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.startup_report_title)
            .setView(content)
            .setPositiveButton(R.string.startup_report_share, null)
            .setNeutralButton(R.string.startup_report_copy, null)
            .setNegativeButton(R.string.startup_report_close, null)
            .create()
        dialog.setOnShowListener {
            // Replacing the listeners keeps the preview open after Copy or Share.
            dialog.getButton(DialogInterface.BUTTON_POSITIVE).setOnClickListener { share(content, report) }
            dialog.getButton(DialogInterface.BUTTON_NEUTRAL).setOnClickListener { copy(content, report) }
        }
        return dialog
    }

    private fun share(content: View, report: String) {
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, report)
        val chooser = Intent.createChooser(send, getString(R.string.startup_report_share))
        val started = try {
            val starter = shareStarterForTest
            if (starter != null) starter(chooser) else startActivity(chooser)
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
        showFeedback(content, if (started) null else R.string.startup_report_share_unavailable)
    }

    private fun copy(content: View, report: String) {
        val clipboard = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val copied = try {
            if (clipboard == null) {
                false
            } else {
                clipboard.setPrimaryClip(ClipData.newPlainText(getString(R.string.startup_report_clip_label), report))
                true
            }
        } catch (_: RuntimeException) {
            false
        }
        showFeedback(
            content,
            if (copied) R.string.startup_report_copied else R.string.startup_report_copy_unavailable,
        )
    }

    private fun showFeedback(content: View, message: Int?) {
        content.findViewById<TextView>(R.id.startup_report_feedback).apply {
            if (message == null) {
                text = ""
                visibility = View.GONE
            } else {
                setText(message)
                visibility = View.VISIBLE
            }
        }
    }

    companion object {
        const val TAG = "startup_diagnostic_report"
        private const val ARG_REPORT = "startup_diagnostic_report_text"

        /** androidTest-only share seam; production always starts the platform chooser. */
        @JvmField @Volatile internal var shareStarterForTest: ((Intent) -> Unit)? = null

        /** Freezes [report] into fragment arguments so recreation previews and shares the same text. */
        fun show(activity: FragmentActivity, report: String) {
            val manager = activity.supportFragmentManager
            if (manager.isStateSaved || manager.findFragmentByTag(TAG) != null) return
            StartupDiagnosticReportDialog()
                .apply { arguments = Bundle().apply { putString(ARG_REPORT, report) } }
                .show(manager, TAG)
        }
    }
}
