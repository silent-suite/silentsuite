package io.silentsuite.sync.ui.importlocal

import android.app.Dialog
import android.content.DialogInterface
import android.os.Bundle
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.fragment.app.DialogFragment
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import java.io.Serializable

/**
 * Created by tal on 30/03/17.
 */

class ResultFragment : DialogFragment() {
    private var result: ImportResult? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        result = requireArguments().getSerializable(KEY_RESULT) as ImportResult
    }

    override fun onDismiss(dialog: DialogInterface) {
        super.onDismiss(dialog)
        val activity = activity
        if (activity is DialogInterface) {
            (activity as DialogInterface).dismiss()
        }
    }

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        if (result!!.isFailed) {
            val failureMessage = result!!.failureMessage ?: getString(R.string.import_dialog_failed_generic)
            return MaterialAlertDialogBuilder(requireActivity())
                    .setTitle(R.string.import_dialog_failed_title)
                    .setIcon(R.drawable.ic_error_dark)
                    .setMessage(getString(R.string.import_dialog_failed_body, failureMessage))
                    .setNegativeButton(android.R.string.no) { dialog, which ->
                        // dismiss
                    }
                    .setPositiveButton(android.R.string.yes) { dialog, which ->
                        // TODO(Phase2): Report to Sentry once integrated
                        Logger.log.severe("Import failed: ${result!!.e!!.javaClass.name}")
                    }
                    .create()
        } else {
            val message = if (result!!.failed > 0) {
                getString(R.string.import_dialog_partial_success, result!!.total, result!!.added, result!!.updated, result!!.skipped, result!!.failed)
            } else {
                getString(R.string.import_dialog_success, result!!.total, result!!.added, result!!.updated, result!!.skipped)
            }
            return MaterialAlertDialogBuilder(requireActivity())
                    .setTitle(R.string.import_dialog_title)
                    .setIcon(R.drawable.ic_import_export_black)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { dialog, which ->
                        // dismiss
                    }
                    .create()
        }
    }

    class ImportResult : Serializable {
        var total: Long = 0
        var added: Long = 0
        var updated: Long = 0
        var failed: Long = 0
        var e: Exception? = null
        var failureMessage: String? = null

        val isFailed: Boolean
            get() = e != null

        val skipped: Long
            get() = total - (added + updated + failed)

        override fun toString(): String {
            return "ResultFragment.ImportResult(total=" + this.total + ", added=" + this.added + ", updated=" + this.updated + ", failed=" + this.failed + ", e=" + this.e?.javaClass?.name + ")"
        }
    }

    companion object {
        private val KEY_RESULT = "result"

        fun newInstance(result: ImportResult): ResultFragment {
            val args = Bundle()
            args.putSerializable(KEY_RESULT, result)
            val fragment = ResultFragment()
            fragment.arguments = args
            return fragment
        }
    }
}
