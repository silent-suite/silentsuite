package io.silentsuite.sync.ui

import android.os.Build
import android.os.Bundle
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.silentsuite.sync.R

open class BaseActivity : AppCompatActivity() {
    private var statusBarScrim: View? = null
    private var navigationBarScrim: View? = null
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
        val systemBarColor = ContextCompat.getColor(this, R.color.semantic_system_bar)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
        }

        if (Build.VERSION.SDK_INT >= 35) {
            window.statusBarColor = android.graphics.Color.TRANSPARENT
            window.navigationBarColor = android.graphics.Color.TRANSPARENT
            window.setStatusBarContrastEnforced(false)
            window.setNavigationBarContrastEnforced(false)
            installSystemBarScrims(systemBarColor)
        } else {
            window.statusBarColor = systemBarColor
            window.navigationBarColor = systemBarColor
        }
        // Navy system bars require light clock/battery/connectivity icons. Explicitly
        // clear light-system-bar flags so Android 15+ edge-to-edge
        // defaults or theme inheritance cannot leave dark icons on a dark bar.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            window.clearLightStatusBar()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            window.clearLightNavigationBar()
        }
    }

    private fun installSystemBarScrims(color: Int) {
        val overlay = window.decorView as ViewGroup
        fun scrim(existing: View?, tag: String): View = existing ?: View(this).also {
            it.tag = tag
            it.isClickable = false
            it.isFocusable = false
            it.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            it.setBackgroundColor(color)
            overlay.addView(it, FrameLayout.LayoutParams(0, 0))
        }
        statusBarScrim = scrim(statusBarScrim, STATUS_BAR_SCRIM_TAG)
        navigationBarScrim = scrim(navigationBarScrim, NAVIGATION_BAR_SCRIM_TAG)
        ViewCompat.setOnApplyWindowInsetsListener(overlay) { _, insets ->
            val status = insets.getInsets(WindowInsetsCompat.Type.statusBars())
            val navigation = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            statusBarScrim!!.layoutParams = scrimLayoutParams(status, statusBar = true)
            navigationBarScrim!!.layoutParams = scrimLayoutParams(navigation, statusBar = false)
            insets
        }
        ViewCompat.requestApplyInsets(overlay)
    }

    private fun scrimLayoutParams(insets: Insets, statusBar: Boolean): FrameLayout.LayoutParams {
        val edge = if (statusBar) {
            when {
                insets.top > 0 -> android.view.Gravity.TOP
                insets.left > 0 -> android.view.Gravity.LEFT
                insets.right > 0 -> android.view.Gravity.RIGHT
                insets.bottom > 0 -> android.view.Gravity.BOTTOM
                else -> android.view.Gravity.NO_GRAVITY
            }
        } else {
            when {
                insets.bottom > 0 -> android.view.Gravity.BOTTOM
                insets.left > 0 -> android.view.Gravity.LEFT
                insets.right > 0 -> android.view.Gravity.RIGHT
                insets.top > 0 -> android.view.Gravity.TOP
                else -> android.view.Gravity.NO_GRAVITY
            }
        }
        return when (edge) {
            android.view.Gravity.TOP -> FrameLayout.LayoutParams(-1, insets.top, edge)
            android.view.Gravity.BOTTOM -> FrameLayout.LayoutParams(-1, insets.bottom, edge)
            android.view.Gravity.LEFT -> FrameLayout.LayoutParams(insets.left, -1, edge)
            android.view.Gravity.RIGHT -> FrameLayout.LayoutParams(insets.right, -1, edge)
            else -> FrameLayout.LayoutParams(0, 0, edge)
        }
    }

    private fun Window.clearLightStatusBar() {
        decorView.systemUiVisibility = decorView.systemUiVisibility and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
    }

    private fun Window.clearLightNavigationBar() {
        decorView.systemUiVisibility = decorView.systemUiVisibility and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
    }

    companion object {
        const val STATUS_BAR_SCRIM_TAG = "color-parity-status-bar-scrim"
        const val NAVIGATION_BAR_SCRIM_TAG = "color-parity-navigation-bar-scrim"
    }
}
