/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.ContentResolver.SYNC_OBSERVER_TYPE_SETTINGS
import android.content.Intent
import android.content.SyncStatusObserver
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.MenuItem
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.ActionBarDrawerToggle
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatDelegate
import androidx.appcompat.widget.Toolbar
import androidx.core.view.GravityCompat
import androidx.drawerlayout.widget.DrawerLayout
import io.silentsuite.sync.App
import io.silentsuite.sync.BuildConfig.DEBUG
import io.silentsuite.sync.Constants
import io.silentsuite.sync.Constants.serviceUrl
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.setup.LoginActivity
import com.google.android.material.floatingactionbutton.FloatingActionButton
import com.google.android.material.navigation.NavigationView
import com.google.android.material.snackbar.Snackbar

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
        drawer.addDrawerListener(toggle)
        toggle.syncState()

        val navigationView = findViewById<View>(R.id.nav_view) as NavigationView
        navigationView.setNavigationItemSelectedListener(this)
        navigationView.itemIconTintList = null

        // Display the logged-in user's email in the nav header
        updateNavHeader(navigationView)

        if (savedInstanceState == null && packageName != callingPackage) {
            // Startup info dialogs removed — users go straight to the main screen
            if (DEBUG) {
                Toast.makeText(this, "Server: " + serviceUrl.toString(), Toast.LENGTH_SHORT).show()
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val drawerLayout = findViewById<View>(R.id.drawer_layout) as DrawerLayout
                if (drawerLayout.isDrawerOpen(GravityCompat.START))
                    drawerLayout.closeDrawer(GravityCompat.START)
                else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        PermissionsActivity.requestAllPermissions(this)

    }

    override fun onResume() {
        super.onResume()
        onStatusChanged(SYNC_OBSERVER_TYPE_SETTINGS)
        syncStatusObserver = ContentResolver.addStatusChangeListener(SYNC_OBSERVER_TYPE_SETTINGS, this)

        // Refresh the nav header in case account changed
        val navigationView = findViewById<View>(R.id.nav_view) as NavigationView
        updateNavHeader(navigationView)
    }

    override fun onPause() {
        super.onPause()
        if (syncStatusObserver != null) {
            ContentResolver.removeStatusChangeListener(syncStatusObserver)
            syncStatusObserver = null
        }
    }

    private fun updateNavHeader(navigationView: NavigationView) {
        val headerView = navigationView.getHeaderView(0)
        val userEmailView = headerView?.findViewById<TextView>(R.id.nav_user_email)
        val accountManager = AccountManager.get(this)
        val accounts = accountManager.getAccountsByType(App.accountType)
        if (accounts.isNotEmpty()) {
            userEmailView?.text = accounts[0].name
        } else {
            userEmailView?.text = getString(R.string.app_name)
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

    override fun onNavigationItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.nav_about -> startActivity(Intent(this, AboutActivity::class.java))
            R.id.nav_app_settings -> startActivity(Intent(this, AppSettingsActivity::class.java))
            R.id.nav_website -> startActivity(Intent(Intent.ACTION_VIEW, Constants.webUri))
            R.id.nav_webapp -> startActivity(Intent(Intent.ACTION_VIEW, Constants.webAppUri))
            R.id.nav_guide -> startActivity(Intent(Intent.ACTION_VIEW, Constants.docsUri))
            R.id.nav_add_account -> startActivity(Intent(this, LoginActivity::class.java))
            R.id.nav_logout -> confirmLogout()
            R.id.nav_theme -> showThemeDialog()
        }

        val drawer = findViewById<View>(R.id.drawer_layout) as DrawerLayout
        drawer.closeDrawer(GravityCompat.START)
        return true
    }

    private fun confirmLogout() {
        val accountManager = AccountManager.get(this)
        val accounts = accountManager.getAccountsByType(App.accountType)
        if (accounts.isEmpty()) {
            Toast.makeText(this, "No account to log out", Toast.LENGTH_SHORT).show()
            return
        }

        AlertDialog.Builder(this)
            .setTitle(R.string.account_delete_confirmation_title)
            .setMessage(R.string.account_delete_confirmation_text)
            .setPositiveButton(R.string.navigation_drawer_logout) { _, _ ->
                for (account in accounts) {
                    accountManager.removeAccountExplicitly(account)
                }
                // Return to login
                val intent = Intent(this, LoginActivity::class.java)
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                finish()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun showThemeDialog() {
        val themes = arrayOf("Light", "Dark", "System default")
        val prefs = getSharedPreferences("app_settings", MODE_PRIVATE)
        val currentMode = prefs.getInt("theme_mode", AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)
        val checkedItem = when (currentMode) {
            AppCompatDelegate.MODE_NIGHT_NO -> 0
            AppCompatDelegate.MODE_NIGHT_YES -> 1
            else -> 2
        }

        AlertDialog.Builder(this)
            .setTitle(R.string.navigation_drawer_theme)
            .setSingleChoiceItems(themes, checkedItem) { dialog, which ->
                val mode = when (which) {
                    0 -> AppCompatDelegate.MODE_NIGHT_NO
                    1 -> AppCompatDelegate.MODE_NIGHT_YES
                    else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
                }
                prefs.edit().putInt("theme_mode", mode).apply()
                AppCompatDelegate.setDefaultNightMode(mode)
                dialog.dismiss()
            }
            .show()
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
}
