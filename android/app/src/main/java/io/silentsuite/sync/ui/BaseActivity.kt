package io.silentsuite.sync.ui

import android.os.Build
import android.os.Bundle
import android.view.MenuItem
import android.view.View
import android.view.Window
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import io.silentsuite.sync.R

open class BaseActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyReadableSystemBars()
    }

    override fun onResume() {
        super.onResume()
        applyReadableSystemBars()
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == android.R.id.home) {
            if (!supportFragmentManager.popBackStackImmediate()) {
                finish()
            }
            return true
        }
        return false
    }

    private fun applyReadableSystemBars() {
        val systemBarColor = ContextCompat.getColor(this, R.color.navy700)

        window.statusBarColor = systemBarColor
        window.navigationBarColor = systemBarColor

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
        }

        // Navy system bars require light clock/battery/connectivity icons. Explicitly
        // clear light-system-bar flags so Android 15 / targetSdk 35 edge-to-edge
        // defaults or theme inheritance cannot leave dark icons on a dark bar.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            window.clearLightStatusBar()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            window.clearLightNavigationBar()
        }
    }

    private fun Window.clearLightStatusBar() {
        decorView.systemUiVisibility = decorView.systemUiVisibility and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
    }

    private fun Window.clearLightNavigationBar() {
        decorView.systemUiVisibility = decorView.systemUiVisibility and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
    }
}
