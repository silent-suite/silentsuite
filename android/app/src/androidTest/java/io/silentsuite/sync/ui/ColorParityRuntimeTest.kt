package io.silentsuite.sync.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatDelegate
import androidx.appcompat.graphics.drawable.DrawerArrowDrawable
import androidx.appcompat.widget.Toolbar
import androidx.core.graphics.Insets
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.viewpager.widget.ViewPager
import io.silentsuite.sync.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs

@RunWith(AndroidJUnit4::class)
class ColorParityRuntimeTest {
    private fun setNightModeOnMainThread(mode: Int) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync { AppCompatDelegate.setDefaultNightMode(mode) }
        instrumentation.waitForIdleSync()
    }

    private fun waitForAbout(scenario: ActivityScenario<AboutActivity>) {
        repeat(40) {
            var ready = false
            scenario.onActivity { activity ->
                val pager = activity.findViewById<ViewPager>(R.id.viewpager)
                ready = pager.isAttachedToWindow && pager.isShown && (pager.adapter?.count ?: 0) > 0
            }
            if (ready) return
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            SystemClock.sleep(50)
        }
        throw AssertionError("AboutActivity viewpager was not attached, shown, and populated")
    }

    private fun <T> about(block: (ActivityScenario<AboutActivity>) -> T): T {
        return ActivityScenario.launch(AboutActivity::class.java).use { scenario ->
            waitForAbout(scenario)
            block(scenario)
        }
    }

    private fun assertRoles(activity: AboutActivity, expected: Array<Pair<Int, String>>) {
        expected.forEach { (resource, color) ->
            assertEquals(color, Color.parseColor(color), ContextCompat.getColor(activity, resource))
        }
        assertNotNull(activity.findViewById<ViewPager>(R.id.viewpager).adapter)
    }

    private val dayRoles = arrayOf(
        R.color.semantic_background to "#FCFDFF",
        R.color.semantic_surface to "#F3F5F9",
        R.color.semantic_on_surface to "#111B27",
        R.color.semantic_on_surface_variant to "#475569",
        R.color.semantic_outline to "#C8D2DE",
        R.color.semantic_surface_variant to "#E7EBF0",
        R.color.semantic_outline_variant to "#DCE3EB",
        R.color.semantic_primary to "#10B981",
        R.color.semantic_secondary_action to "#059669",
        R.color.semantic_action_text to "#047857",
        R.color.semantic_on_primary to "#0A1018",
        R.color.semantic_primary_container to "#D1FAE5",
        R.color.semantic_on_primary_container to "#064E3B",
        R.color.semantic_on_secondary to "#FFFFFF",
        R.color.semantic_secondary_container to "#D1FAE5",
        R.color.semantic_on_secondary_container to "#064E3B",
        R.color.semantic_success to "#047857",
        R.color.semantic_on_success to "#FFFFFF",
        R.color.semantic_warning to "#B45309",
        R.color.semantic_on_warning to "#FFFFFF",
        R.color.semantic_error to "#B91C1C",
        R.color.semantic_on_error to "#FFFFFF",
        R.color.semantic_error_container to "#FEE2E2",
        R.color.semantic_on_error_container to "#7F1D1D",
        R.color.semantic_focus to "#047857",
        R.color.semantic_selected_container to "#1F10B981",
        R.color.semantic_disabled_content to "#A3A7AD",
        R.color.semantic_disabled_container to "#E0E2E5",
        R.color.semantic_inverse_surface to "#1B2838",
        R.color.semantic_inverse_on_surface to "#FFFFFF",
        R.color.semantic_inverse_primary to "#34D399",
        R.color.semantic_system_bar to "#0A1018",
        R.color.semantic_on_system_bar to "#FFFFFF",
    )

    private val nightRoles = arrayOf(
        R.color.semantic_background to "#0A1018",
        R.color.semantic_surface to "#111B27",
        R.color.semantic_on_surface to "#D9DFE8",
        R.color.semantic_on_surface_variant to "#A3B3C9",
        R.color.semantic_outline to "#253549",
        R.color.semantic_surface_variant to "#1B2838",
        R.color.semantic_outline_variant to "#35465A",
        R.color.semantic_primary to "#34D399",
        R.color.semantic_secondary_action to "#10B981",
        R.color.semantic_action_text to "#34D399",
        R.color.semantic_on_primary to "#0A1018",
        R.color.semantic_primary_container to "#064E3B",
        R.color.semantic_on_primary_container to "#D1FAE5",
        R.color.semantic_on_secondary to "#0A1018",
        R.color.semantic_secondary_container to "#064E3B",
        R.color.semantic_on_secondary_container to "#D1FAE5",
        R.color.semantic_success to "#34D399",
        R.color.semantic_on_success to "#0A1018",
        R.color.semantic_warning to "#FBBF24",
        R.color.semantic_on_warning to "#0A1018",
        R.color.semantic_error to "#FCA5A5",
        R.color.semantic_on_error to "#0A1018",
        R.color.semantic_error_container to "#7F1D1D",
        R.color.semantic_on_error_container to "#FEE2E2",
        R.color.semantic_focus to "#10B981",
        R.color.semantic_selected_container to "#2934D399",
        R.color.semantic_disabled_content to "#595F67",
        R.color.semantic_disabled_container to "#232931",
        R.color.semantic_inverse_surface to "#D9DFE8",
        R.color.semantic_inverse_on_surface to "#111B27",
        R.color.semantic_inverse_primary to "#059669",
        R.color.semantic_system_bar to "#0A1018",
        R.color.semantic_on_system_bar to "#FFFFFF",
    )

    @Test fun dayNightRolesRecreateDeterministically() {
        val prior = AppCompatDelegate.getDefaultNightMode()
        try {
            setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_NO)
            about { scenario ->
                scenario.onActivity { assertRoles(it, dayRoles) }
                scenario.onActivity { assertDashboardToolbar(it, "dashboard toolbar (day)") }
                setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_YES)
                scenario.recreate()
                waitForAbout(scenario)
                scenario.onActivity { assertRoles(it, nightRoles) }
                scenario.onActivity { assertDashboardToolbar(it, "dashboard toolbar (night)") }
                setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_NO)
                scenario.recreate()
                waitForAbout(scenario)
                scenario.onActivity { assertRoles(it, dayRoles) }
            }
            // The real legacy Settings window action bar, through day -> night -> day recreation.
            val settingsIntent = AppSettingsActivity.newIntent(InstrumentationRegistry.getInstrumentation().targetContext)
            ActivityScenario.launch<AppSettingsActivity>(settingsIntent).use { scenario ->
                waitForSettingsBar(scenario)
                scenario.onActivity { assertSettingsBar(it, "settings action bar (day)") }
                setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_YES)
                scenario.recreate()
                waitForSettingsBar(scenario)
                scenario.onActivity { assertSettingsBar(it, "settings action bar (night)") }
                setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_NO)
                scenario.recreate()
                waitForSettingsBar(scenario)
                scenario.onActivity { assertSettingsBar(it, "settings action bar (day, recreated)") }
            }
        } finally {
            setNightModeOnMainThread(prior)
        }
    }

    private fun waitForSettingsBar(scenario: ActivityScenario<AppSettingsActivity>) {
        repeat(40) {
            var ready = false
            scenario.onActivity { activity ->
                val bar = activity.findViewById<View>(androidx.appcompat.R.id.action_bar_container)
                ready = bar != null && bar.isAttachedToWindow && bar.isShown && bar.width > 0 && bar.height > 0 &&
                    activity.supportFragmentManager.findFragmentById(android.R.id.content) != null
            }
            if (ready) return
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            SystemClock.sleep(50)
        }
        throw AssertionError("AppSettingsActivity window action bar was not attached, shown, and laid out")
    }

    private fun assertSettingsBar(activity: AppSettingsActivity, label: String) {
        val toolbar = activity.findViewById<Toolbar>(androidx.appcompat.R.id.action_bar)
        val titleText = toolbar.title?.toString()
        assertTrue("$label title is set", !titleText.isNullOrEmpty())
        val title = (0 until toolbar.childCount).map { toolbar.getChildAt(it) }
            .filterIsInstance<TextView>()
            .single { it.text?.toString() == titleText }
        assertEquals("$label title colour", ContextCompat.getColor(activity, R.color.semantic_on_system_bar), title.currentTextColor)
        assertNavyBarWithWhiteForeground(label, activity.findViewById(androidx.appcompat.R.id.action_bar_container))
    }

    /**
     * AccountActivity needs a signed-in account, so this inflates its real layout in an activity
     * with the same AppTheme.Material3.NoActionBar theme and mirrors its wiring: the drawer toggle
     * sets a DrawerArrowDrawable built from the toolbar context, and the support action bar inflates
     * the options menu with that same themed context. It is not a launched dashboard.
     */
    private fun assertDashboardToolbar(activity: AboutActivity, label: String) {
        val root = activity.layoutInflater.inflate(R.layout.activity_account, null, false)
        val toolbar = root.findViewById<Toolbar>(R.id.toolbar)
        toolbar.title = activity.getString(R.string.app_name)
        toolbar.navigationIcon = DrawerArrowDrawable(toolbar.context)
        toolbar.inflateMenu(R.menu.activity_account)
        assertNotNull("$label overflow icon", toolbar.overflowIcon)
        val width = activity.window.decorView.width
        val height = toolbar.layoutParams.height
        assertTrue("$label has a laid-out size", width > 0 && height > 0)
        toolbar.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
        )
        toolbar.layout(0, 0, width, height)
        assertNavyBarWithWhiteForeground(label, toolbar)
    }

    /**
     * Renders the bar and requires a navy background with every pixel on the navy-to-white blend
     * line, so the title, navigation, action and overflow glyphs are all white (or their
     * antialiased edges) and nothing else is painted on the bar.
     */
    private fun assertNavyBarWithWhiteForeground(label: String, bar: View) {
        val navy = ContextCompat.getColor(bar.context, R.color.semantic_system_bar)
        val white = ContextCompat.getColor(bar.context, R.color.semantic_on_system_bar)
        assertEquals(Color.parseColor("#0A1018"), navy)
        assertEquals(Color.parseColor("#FFFFFF"), white)
        val bitmap = Bitmap.createBitmap(bar.width, bar.height, Bitmap.Config.ARGB_8888)
        bar.draw(Canvas(bitmap))
        assertEquals("$label background", navy, bitmap.getPixel(bitmap.width - 1, 0))
        val span = intArrayOf(
            Color.red(white) - Color.red(navy), Color.green(white) - Color.green(navy), Color.blue(white) - Color.blue(navy),
        )
        val spanSquared = span.sumOf { it * it }.toDouble()
        val stray = mutableListOf<String>()
        var foreground = 0
        for (y in 0 until bitmap.height) {
            for (x in 0 until bitmap.width) {
                val pixel = bitmap.getPixel(x, y)
                val delta = intArrayOf(
                    Color.red(pixel) - Color.red(navy), Color.green(pixel) - Color.green(navy), Color.blue(pixel) - Color.blue(navy),
                )
                val coverage = (0..2).sumOf { delta[it] * span[it] } / spanSquared
                val residual = (0..2).maxOf { abs(delta[it] - coverage * span[it]) }
                if (Color.alpha(pixel) != 255 || residual > 8.0) stray += "($x,$y)=#%08X".format(pixel)
                if (coverage > 0.9) foreground++
            }
        }
        assertTrue("$label has non navy/white pixels ${stray.take(5)} of ${stray.size}", stray.isEmpty())
        assertTrue("$label draws no white foreground", foreground > 0)
    }

    private fun View.bounds() = Rect(left, top, right, bottom)

    private fun View.paddingBounds() = Rect(paddingLeft, paddingTop, paddingRight, paddingBottom)

    private fun assertContentInsets(activity: AboutActivity) {
        val decor = activity.window.decorView
        val content = activity.findViewById<android.view.ViewGroup>(android.R.id.content)
        val rootInsets = ViewCompat.getRootWindowInsets(decor)
        assertNotNull(rootInsets)
        val safeDrawing = rootInsets!!.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        assertEquals(
            Rect(safeDrawing.left, safeDrawing.top, safeDrawing.right, safeDrawing.bottom),
            content.paddingBounds(),
        )
        assertTrue("Content must retain its inflated child", content.childCount > 0)
        // The match_parent root must end exactly at the navigation-bar edge: a second
        // bottom inset claimed by a descendant would lift it further.
        val child = content.getChildAt(0)
        val decorLocation = IntArray(2)
        val childLocation = IntArray(2)
        decor.getLocationOnScreen(decorLocation)
        child.getLocationOnScreen(childLocation)
        assertEquals(
            "Content root bottom must sit on the safe-drawing edge",
            decor.height - safeDrawing.bottom,
            childLocation[1] - decorLocation[1] + child.height,
        )
    }

    private fun expectedScrimBounds(decor: View, insets: Insets, gravity: Int): Rect =
        when (gravity) {
            Gravity.TOP -> Rect(0, 0, decor.width, insets.top)
            Gravity.BOTTOM -> Rect(0, decor.height - insets.bottom, decor.width, decor.height)
            Gravity.LEFT -> Rect(0, 0, insets.left, decor.height)
            Gravity.RIGHT -> Rect(decor.width - insets.right, 0, decor.width, decor.height)
            else -> Rect()
        }

    private fun assertScrimSet(activity: AboutActivity, prefix: String, insets: Insets) {
        val decor = activity.window.decorView
        val expectedColor = ContextCompat.getColor(activity, R.color.semantic_system_bar)
        for ((gravity, suffix) in BaseActivity.SCRIM_EDGES) {
            val tag = "$prefix-$suffix"
            val scrim = decor.findViewWithTag<View>(tag)
            assertNotNull(tag, scrim)
            assertEquals(tag, expectedScrimBounds(decor, insets, gravity), scrim!!.bounds())
            assertEquals(tag, expectedColor, (scrim.background as ColorDrawable).color)
            assertEquals(tag, 1, countTagged(decor, tag))
        }
    }

    private fun assertScrimBounds(activity: AboutActivity) {
        val decor = activity.window.decorView
        val insets = ViewCompat.getRootWindowInsets(decor)
        assertNotNull(insets)
        val status = insets!!.getInsets(WindowInsetsCompat.Type.statusBars())
        val navigation = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
        assertScrimSet(activity, BaseActivity.STATUS_BAR_SCRIM_TAG, status)
        assertScrimSet(activity, BaseActivity.NAVIGATION_BAR_SCRIM_TAG, navigation)
    }

    @Test fun systemBarProtectionMatchesApiAndInsets() {
        about { scenario ->
            scenario.onActivity { activity ->
                if (Build.VERSION.SDK_INT >= 35) {
                    assertEquals(Color.TRANSPARENT, activity.window.statusBarColor)
                    assertEquals(Color.TRANSPARENT, activity.window.navigationBarColor)
                    assertFalse(activity.window.isStatusBarContrastEnforced)
                    assertFalse(activity.window.isNavigationBarContrastEnforced)
                    assertScrimBounds(activity)
                    assertContentInsets(activity)
                } else {
                    val expected = ContextCompat.getColor(activity, R.color.semantic_system_bar)
                    assertEquals(expected, activity.window.statusBarColor)
                    assertEquals(expected, activity.window.navigationBarColor)
                    assertContentInsets(activity)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    assertEquals(0, activity.window.decorView.systemUiVisibility and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    assertEquals(0, activity.window.decorView.systemUiVisibility and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR)
                }
            }
        }
    }

    @Test fun repeatedInsetDispatchIsIdempotentAndDoesNotMoveContent() {
        about { scenario ->
            var before: Rect? = null
            var paddingBefore: Rect? = null
            scenario.onActivity { activity ->
                before = activity.findViewById<View>(android.R.id.content).bounds()
                paddingBefore = activity.findViewById<View>(android.R.id.content).paddingBounds()
                ViewCompat.requestApplyInsets(activity.window.decorView)
            }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            scenario.recreate()
            waitForAbout(scenario)
            scenario.onActivity { activity ->
                assertEquals(before, activity.findViewById<View>(android.R.id.content).bounds())
                assertEquals(paddingBefore, activity.findViewById<View>(android.R.id.content).paddingBounds())
                if (Build.VERSION.SDK_INT >= 35) {
                    val decor = activity.window.decorView
                    assertScrimBounds(activity)
                    assertContentInsets(activity)
                    assertEquals(8, BaseActivity.SCRIM_EDGES.sumOf { (_, suffix) ->
                        countTagged(decor, "${BaseActivity.STATUS_BAR_SCRIM_TAG}-$suffix") +
                            countTagged(decor, "${BaseActivity.NAVIGATION_BAR_SCRIM_TAG}-$suffix")
                    })
                }
            }
        }
    }

    private fun countTagged(view: View, tag: String): Int {
        var count = if (view.tag == tag) 1 else 0
        if (view is android.view.ViewGroup) {
            for (index in 0 until view.childCount) count += countTagged(view.getChildAt(index), tag)
        }
        return count
    }
}
