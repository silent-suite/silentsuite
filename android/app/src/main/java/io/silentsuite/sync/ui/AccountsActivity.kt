/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.content.ContentResolver
import android.content.ContentResolver.SYNC_OBSERVER_TYPE_SETTINGS
import android.content.Intent
import android.content.SyncStatusObserver
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.view.MenuItem
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.ActionBarDrawerToggle
import androidx.appcompat.widget.Toolbar
import androidx.core.view.GravityCompat
import androidx.drawerlayout.widget.DrawerLayout
import io.silentsuite.sync.BuildConfig.DEBUG
import io.silentsuite.sync.Constants
import io.silentsuite.sync.Constants.serviceUrl
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.setup.LoginActivity
import io.silentsuite.sync.utils.HintManager
import io.silentsuite.sync.utils.ShowcaseBuilder
import com.google.android.material.floatingactionbutton.FloatingActionButton
import com.google.android.material.navigation.NavigationView
import com.google.android.material.snackbar.Snackbar
import tourguide.tourguide.ToolTip

class AccountsActivity : BaseActivity(), NavigationView.OnNavigationItemSelectedListener, SyncStatusObserver {

    private var syncStatusSnackbar: Snackbar? = null
    private var syncStatusObserver: Any? = null


    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_accounts)

        val toolbar = findViewById<View>(R.id.toolbar) as Toolbar
        setSupportActionBar(toolbar)

        val fab = findViewById<View>(R.id.fab) as FloatingActionButton
        fab.setOnClickListener { startActivity(Intent(this@AccountsActivity, LoginActivity::class.java)) }

        val drawer = findViewById<View>(R.id.drawer_layout) as DrawerLayout
        val toggle = ActionBarDrawerToggle(
                this, drawer, toolbar, R.string.navigation_drawer_open, R.string.navigation_drawer_close)
        drawer.setDrawerListener(toggle)
        toggle.syncState()

        val navigationView = findViewById<View>(R.id.nav_view) as NavigationView
        navigationView.setNavigationItemSelectedListener(this)
        navigationView.itemIconTintList = null

        if (savedInstanceState == null && packageName != callingPackage) {
            val ft = supportFragmentManager.beginTransaction()
            for (fragment in StartupDialogFragment.getStartupDialogs(this))
                ft.add(fragment, null)
            ft.commit()

            if (DEBUG) {
                Toast.makeText(this, "Server: " + serviceUrl.toString(), Toast.LENGTH_SHORT).show()
            }
        }

        PermissionsActivity.requestAllPermissions(this)

        if (!HintManager.getHintSeen(this, HINT_ACCOUNT_ADD)) {
            ShowcaseBuilder.getBuilder(this)
                    .setToolTip(ToolTip().setTitle(getString(R.string.tourguide_title)).setDescription(getString(R.string.accounts_showcase_add)).setGravity(Gravity.TOP or Gravity.LEFT))
                    .playOn(fab)
            HintManager.setHintSeen(this, HINT_ACCOUNT_ADD, true)
        }
    }

    override fun onResume() {
        super.onResume()
        onStatusChanged(SYNC_OBSERVER_TYPE_SETTINGS)
        syncStatusObserver = ContentResolver.addStatusChangeListener(SYNC_OBSERVER_TYPE_SETTINGS, this)
    }

    override fun onPause() {
        super.onPause()
        if (syncStatusObserver != null) {
            ContentResolver.removeStatusChangeListener(syncStatusObserver)
            syncStatusObserver = null
        }
    }

    override fun onStatusChanged(which: Int) {
        runOnUiThread {
            if (syncStatusSnackbar != null) {
                syncStatusSnackbar!!.dismiss()
                syncStatusSnackbar = null
            }

            if (!ContentResolver.getMasterSyncAutomatically()) {
                syncStatusSnackbar = Snackbar.make(findViewById(R.id.coordinator), R.string.accounts_global_sync_disabled, Snackbar.LENGTH_INDEFINITE)
                        .setAction(R.string.accounts_global_sync_enable) { ContentResolver.setMasterSyncAutomatically(true) }
                syncStatusSnackbar!!.show()
            }
        }
    }


    override fun onBackPressed() {
        val drawer = findViewById<View>(R.id.drawer_layout) as DrawerLayout
        if (drawer.isDrawerOpen(GravityCompat.START))
            drawer.closeDrawer(GravityCompat.START)
        else
            super.onBackPressed()
    }

    override fun onNavigationItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.nav_about -> startActivity(Intent(this, AboutActivity::class.java))
            R.id.nav_app_settings -> startActivity(Intent(this, AppSettingsActivity::class.java))
            R.id.nav_website -> startActivity(Intent(Intent.ACTION_VIEW, Constants.webUri))
            R.id.nav_webapp -> startActivity(Intent(Intent.ACTION_VIEW, Constants.webAppUri))
            R.id.nav_guide -> startActivity(Intent(Intent.ACTION_VIEW, Constants.docsUri))
        }

        val drawer = findViewById<View>(R.id.drawer_layout) as DrawerLayout
        drawer.closeDrawer(GravityCompat.START)
        return true
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val denied = HashMap<String, Boolean>()
        for (permission in permissions.withIndex()) {
            val status = grantResults[permission.index]
            if (status != PackageManager.PERMISSION_GRANTED) {
                val key = permission.value.substringAfterLast('_')
                if (key != "TASKS") {
                    // We don't want to show it for tasks
                    denied[key] = true
                }
            }
        }

        if (denied.size > 0) {
            val deniedString = denied.keys.joinToString(", ")
            Snackbar.make(findViewById(R.id.coordinator), getString(R.string.accounts_missing_permissions, deniedString), Snackbar.LENGTH_INDEFINITE).show()
        }
    }

    companion object {
        val HINT_ACCOUNT_ADD = "AddAccount"
    }
}
