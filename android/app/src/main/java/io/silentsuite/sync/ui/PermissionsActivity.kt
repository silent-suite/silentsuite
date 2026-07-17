/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import androidx.annotation.IdRes
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import at.bitfire.ical4android.TaskProvider.Companion.TASK_PROVIDERS
import at.bitfire.ical4android.TaskProvider.ProviderName
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.resource.LocalTaskList

class PermissionsActivity : BaseActivity() {

    private var lastAnnouncedRequirements: Set<Int>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_permissions)
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    protected fun refresh() {
        val requirements = linkedSetOf<Int>()
        val noCalendarPermissions = ActivityCompat.checkSelfPermission(this, Manifest.permission.READ_CALENDAR) != PackageManager.PERMISSION_GRANTED || ActivityCompat.checkSelfPermission(this, Manifest.permission.WRITE_CALENDAR) != PackageManager.PERMISSION_GRANTED
        findViewById<View>(R.id.calendar_permissions).visibility = if (noCalendarPermissions) View.VISIBLE else View.GONE
        if (noCalendarPermissions) requirements += R.string.permissions_calendar

        val noContactsPermissions = ActivityCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED || ActivityCompat.checkSelfPermission(this, Manifest.permission.WRITE_CONTACTS) != PackageManager.PERMISSION_GRANTED
        findViewById<View>(R.id.contacts_permissions).visibility = if (noContactsPermissions) View.VISIBLE else View.GONE
        if (noContactsPermissions) requirements += R.string.permissions_contacts

        setupPermissions(ProviderName.OpenTasks, R.id.opentasks_permissions, R.string.permissions_opentasks)?.let(requirements::add)
        setupPermissions(ProviderName.TasksOrg, R.id.tasksorg_permissions, R.string.permissions_tasks_org)?.let(requirements::add)

        val previous = lastAnnouncedRequirements
        if (previous != null && requirements != lastAnnouncedRequirements && requirements.isNotEmpty()) {
            val names = requirements.joinToString(getString(R.string.list_separator)) { getString(it) }
            findViewById<View>(R.id.permissions_scroll).announceForAccessibility(
                getString(R.string.permissions_requirements_changed, names)
            )
        }
        lastAnnouncedRequirements = requirements

        if (requirements.isEmpty()) {
            NotificationManagerCompat.from(this).cancel(Constants.NOTIFICATION_PERMISSIONS)
            finish()
        }
    }

    private fun setupPermissions(provider: ProviderName, @IdRes id: Int, titleRes: Int): Int? {
        val providerAvailable = LocalTaskList.tasksProviderAvailable(this, provider)
        val hasPermissions = providerAvailable && provider.permissions.all {
            ActivityCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
        val needsPermission = providerAvailable && !hasPermissions
        findViewById<View>(id).visibility = if (needsPermission) View.VISIBLE else View.GONE
        return titleRes.takeIf { needsPermission }
    }

    fun requestCalendarPermissions(v: View) {
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR), 0)
    }

    fun requestContactsPermissions(v: View) {
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS), 0)
    }

    fun requestOpenTasksPermissions(v: View) {
        ActivityCompat.requestPermissions(this, ProviderName.OpenTasks.permissions, 0)
    }

    fun requestTasksOrgPermissions(v: View) {
        ActivityCompat.requestPermissions(this, ProviderName.TasksOrg.permissions, 0)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh()
    }

    companion object {
        private val REQUEST_CODE_ASK_MULTIPLE_PERMISSIONS = 124

        fun requestAllPermissions(activity: Activity) {
            val taskPermissions = TASK_PROVIDERS
                .filter { LocalTaskList.tasksProviderAvailable(activity, it) }
                .flatMap { it.permissions.toList() }
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(
                    Manifest.permission.READ_CALENDAR,
                    Manifest.permission.WRITE_CALENDAR,
                    Manifest.permission.READ_CONTACTS,
                    Manifest.permission.WRITE_CONTACTS
                ) + taskPermissions,
                REQUEST_CODE_ASK_MULTIPLE_PERMISSIONS
            )
        }
    }
}
