package io.silentsuite.sync.ui

import android.os.Build
import android.os.Bundle
import android.view.Gravity
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
    private var statusBarScrims: Map<Int, View> = emptyMap()
    private var navigationBarScrims: Map<Int, View> = emptyMap()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyReadableSystemBars()
    }

    override fun onContentChanged() {
        super.onContentChanged()
        applyContentInsets()
    }

    override fun onPostCreate(savedInstanceState: Bundle?) {
        super.onPostCreate(savedInstanceState)
        // Fragment-only activities may never call setContentView(), so onContentChanged()
        // is not guaranteed to run after AppCompat installs android.R.id.content.
        applyContentInsets()
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
        fun scrims(existing: Map<Int, View>, tagPrefix: String): Map<Int, View> =
            SCRIM_EDGES.associate { (gravity, suffix) ->
                gravity to (existing[gravity] ?: View(this).also {
                    it.tag = "$tagPrefix-$suffix"
                    it.isClickable = false
                    it.isFocusable = false
                    it.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                    it.setBackgroundColor(color)
                    overlay.addView(it, FrameLayout.LayoutParams(0, 0))
                })
            }
        statusBarScrims = scrims(statusBarScrims, STATUS_BAR_SCRIM_TAG)
        navigationBarScrims = scrims(navigationBarScrims, NAVIGATION_BAR_SCRIM_TAG)
        ViewCompat.setOnApplyWindowInsetsListener(overlay) { view, insets ->
            val status = insets.getInsets(WindowInsetsCompat.Type.statusBars())
            val navigation = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            statusBarScrims.forEach { (gravity, scrim) ->
                scrim.layoutParams = scrimLayoutParams(status, gravity)
            }
            navigationBarScrims.forEach { (gravity, scrim) ->
                scrim.layoutParams = scrimLayoutParams(navigation, gravity)
            }
            // A listener replaces DecorView's normal onApplyWindowInsets call. Invoke it so
            // decor bookkeeping still runs and the resulting insets reach the content tree.
            ViewCompat.onApplyWindowInsets(view, insets)
        }
        ViewCompat.requestApplyInsets(overlay)
    }

    /**
     * API 35+ enforces edge-to-edge for this target SDK. Keep every [BaseActivity] content tree
     * outside the system bars, then dispatch only the unclaimed inset space to descendants.
     * Descendants can therefore add IME padding without double-claiming the navigation bar.
     */
    private fun applyContentInsets() {
        if (Build.VERSION.SDK_INT < 35) return
        val content = window.decorView.findViewById<ViewGroup>(android.R.id.content) ?: return
        content.clipToPadding = false
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val safeDrawing = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(safeDrawing.left, safeDrawing.top, safeDrawing.right, safeDrawing.bottom)
            ViewCompat.onApplyWindowInsets(view, insets.inset(safeDrawing))
        }
        ViewCompat.requestApplyInsets(content)
    }

    private fun scrimLayoutParams(insets: Insets, gravity: Int): FrameLayout.LayoutParams =
        when (gravity) {
            Gravity.TOP -> FrameLayout.LayoutParams(-1, insets.top, gravity)
            Gravity.BOTTOM -> FrameLayout.LayoutParams(-1, insets.bottom, gravity)
            Gravity.LEFT -> FrameLayout.LayoutParams(insets.left, -1, gravity)
            Gravity.RIGHT -> FrameLayout.LayoutParams(insets.right, -1, gravity)
            else -> FrameLayout.LayoutParams(0, 0, Gravity.NO_GRAVITY)
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
        internal val SCRIM_EDGES = listOf(
            Gravity.TOP to "top",
            Gravity.BOTTOM to "bottom",
            Gravity.LEFT to "left",
            Gravity.RIGHT to "right",
        )
    }
}
