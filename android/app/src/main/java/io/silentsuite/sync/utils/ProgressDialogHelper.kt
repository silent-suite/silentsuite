package io.silentsuite.sync.utils

import android.app.Dialog
import android.content.Context
import android.view.LayoutInflater
import android.widget.ProgressBar
import android.widget.TextView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.R

object ProgressDialogHelper {

    fun createIndeterminate(
        context: Context,
        titleRes: Int,
        message: String,
        cancelable: Boolean = false
    ): Dialog {
        val view = LayoutInflater.from(context).inflate(R.layout.dialog_progress, null)
        view.findViewById<ProgressBar>(R.id.progress_bar).isIndeterminate = true
        view.findViewById<TextView>(R.id.progress_message).text = message
        return MaterialAlertDialogBuilder(context)
            .setTitle(titleRes)
            .setView(view)
            .setCancelable(cancelable)
            .create()
    }

    fun createHorizontal(
        context: Context,
        titleRes: Int,
        message: String,
        iconRes: Int? = null,
        cancelable: Boolean = false
    ): Dialog {
        val view = LayoutInflater.from(context).inflate(R.layout.dialog_progress, null)
        val progressBar = view.findViewById<ProgressBar>(R.id.progress_bar)
        progressBar.isIndeterminate = false
        view.findViewById<TextView>(R.id.progress_message).text = message
        val builder = MaterialAlertDialogBuilder(context)
            .setTitle(titleRes)
            .setView(view)
            .setCancelable(cancelable)
        if (iconRes != null) {
            builder.setIcon(iconRes)
        }
        return builder.create()
    }

    fun getProgressBar(dialog: Dialog): ProgressBar =
        dialog.findViewById(R.id.progress_bar)!!

    fun setMessage(dialog: Dialog, message: String) {
        dialog.findViewById<TextView>(R.id.progress_message)?.text = message
    }
}
