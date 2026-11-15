package io.silentsuite.sync.ui.importlocal

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.R

/**
 * Runtime permissions for "Import from an account on this phone", owned by the import activity (the
 * pickers are retained fragments, which cannot hold an activity-result registration across rotation).
 * The pickers open only while their READ+WRITE pair is granted. Denied: explain and offer to ask again.
 * "Don't ask again": explain and link to the app's settings. Removed while the app was away: Android
 * restarts the process and the restored picker refuses to read ([refuse]) instead of crashing.
 *
 * Create it while the activity is created, and call [onCreate], [onResume] and [onSaveInstanceState].
 */
internal class DeviceImportAccess(
    private val activity: AppCompatActivity,
    private val permissions: () -> List<String>,
    private val explanation: () -> Int,
    private val onGranted: () -> Unit,
) {
    private var requestPending = false
    private var awaitingSettings = false

    private val launcher = activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        requestPending = false
        val outcome = DeviceImport.permissionOutcome(
            permissions(),
            granted = { granted(activity, it) },
            canAskAgain = { ActivityCompat.shouldShowRequestPermissionRationale(activity, it) },
        )
        when (outcome) {
            DeviceImport.PermissionOutcome.GRANTED -> onGranted()
            DeviceImport.PermissionOutcome.DENIED -> explain(permanently = false)
            DeviceImport.PermissionOutcome.DENIED_PERMANENTLY -> explain(permanently = true)
        }
    }

    fun onCreate(savedInstanceState: Bundle?) {
        savedInstanceState ?: return
        requestPending = savedInstanceState.getBoolean(STATE_REQUEST_PENDING, false)
        awaitingSettings = savedInstanceState.getBoolean(STATE_AWAITING_SETTINGS, false)
    }

    /** Opens the picker when access is granted, otherwise asks for it. */
    fun start() {
        when {
            granted(activity, permissions()) -> onGranted()
            // An open request (for example across rotation) answers through the launcher.
            requestPending -> Unit
            else -> request()
        }
    }

    /** Back from the app's settings: continue when access was granted there, explain again when not. */
    fun onResume() {
        if (!awaitingSettings) return
        awaitingSettings = false
        if (granted(activity, permissions())) onGranted() else explain(permanently = true)
    }

    fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(STATE_REQUEST_PENDING, requestPending)
        outState.putBoolean(STATE_AWAITING_SETTINGS, awaitingSettings)
    }

    private fun request() {
        requestPending = true
        launcher.launch(permissions().toTypedArray())
    }

    private fun explain(permanently: Boolean) {
        if (activity.isFinishing || activity.isDestroyed) return
        val message = if (permanently)
            activity.getString(explanation()) + "\n\n" + activity.getString(R.string.import_device_permission_settings)
        else
            activity.getString(explanation())
        val builder = MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.permissions_action_needed)
            .setMessage(message)
            .setNegativeButton(android.R.string.cancel, null)
        if (permanently)
            builder.setPositiveButton(R.string.import_device_permission_open_settings) { _, _ -> openSettings() }
        else
            builder.setPositiveButton(R.string.retry) { _, _ -> request() }
        builder.show()
    }

    private fun openSettings() {
        awaitingSettings = true
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}")))
    }

    companion object {
        private const val STATE_REQUEST_PENDING = "deviceImportPermissionRequestPending"
        private const val STATE_AWAITING_SETTINGS = "deviceImportAwaitingSettings"

        fun granted(context: Context, permissions: List<String>): Boolean = permissions.all { granted(context, it) }

        private fun granted(context: Context, permission: String) =
            ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

        /**
         * Shows why the picker can't continue in place of its instructions, with no sources listed; Back
         * returns to the import chooser. No dialog, so nothing outlives the picker.
         */
        fun refuse(fragment: Fragment, @StringRes message: Int) {
            fragment.view?.findViewById<TextView>(R.id.import_notice)?.setText(message)
        }

        /** Why nothing can be imported into this destination, or null when it is ready. */
        @StringRes
        fun destinationProblem(destination: DeviceImporter.Destination<*>): Int? = when (destination) {
            DeviceImporter.Destination.Missing -> R.string.import_device_destination_missing
            DeviceImporter.Destination.ReadOnly -> R.string.edit_owner_only_anon
            is DeviceImporter.Destination.Ready -> null
        }
    }
}
