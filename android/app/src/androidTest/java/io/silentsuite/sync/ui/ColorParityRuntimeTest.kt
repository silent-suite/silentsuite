package io.silentsuite.sync.ui

import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.SystemClock
import android.view.View
import androidx.appcompat.app.AppCompatDelegate
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
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

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

    private fun assertRole(activity: AboutActivity, color: Int, expected: String) {
        assertEquals(Color.parseColor(expected), color)
        assertNotNull(activity.findViewById<ViewPager>(R.id.viewpager).adapter)
    }

    @Test fun dayNightRolesRecreateDeterministically() {
        val prior = AppCompatDelegate.getDefaultNightMode()
        try {
            setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_NO)
            about { scenario ->
                scenario.onActivity { assertRole(it, ContextCompat.getColor(it, R.color.semantic_background), "#FCFDFF") }
                setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_YES)
                scenario.recreate()
                waitForAbout(scenario)
                scenario.onActivity { assertRole(it, ContextCompat.getColor(it, R.color.semantic_background), "#0A1018") }
                setNightModeOnMainThread(AppCompatDelegate.MODE_NIGHT_NO)
                scenario.recreate()
                waitForAbout(scenario)
                scenario.onActivity { assertRole(it, ContextCompat.getColor(it, R.color.semantic_background), "#FCFDFF") }
            }
        } finally {
            setNightModeOnMainThread(prior)
        }
    }

    private fun View.bounds() = Rect(left, top, right, bottom)

    private fun expectedScrimBounds(decor: View, insets: Insets, statusBar: Boolean): Rect =
        if (statusBar) {
            when {
                insets.top > 0 -> Rect(0, 0, decor.width, insets.top)
                insets.left > 0 -> Rect(0, 0, insets.left, decor.height)
                insets.right > 0 -> Rect(decor.width - insets.right, 0, decor.width, decor.height)
                insets.bottom > 0 -> Rect(0, decor.height - insets.bottom, decor.width, decor.height)
                else -> Rect()
            }
        } else {
            when {
                insets.bottom > 0 -> Rect(0, decor.height - insets.bottom, decor.width, decor.height)
                insets.left > 0 -> Rect(0, 0, insets.left, decor.height)
                insets.right > 0 -> Rect(decor.width - insets.right, 0, decor.width, decor.height)
                insets.top > 0 -> Rect(0, 0, decor.width, insets.top)
                else -> Rect()
            }
        }

    private fun assertScrimBounds(activity: AboutActivity) {
        val decor = activity.window.decorView
        val insets = ViewCompat.getRootWindowInsets(decor)
        assertNotNull(insets)
        val status = insets!!.getInsets(WindowInsetsCompat.Type.statusBars())
        val navigation = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
        val statusScrim = decor.findViewWithTag<View>(BaseActivity.STATUS_BAR_SCRIM_TAG)
        val navigationScrim = decor.findViewWithTag<View>(BaseActivity.NAVIGATION_BAR_SCRIM_TAG)
        assertNotNull(statusScrim)
        assertNotNull(navigationScrim)
        assertEquals(expectedScrimBounds(decor, status, statusBar = true), statusScrim!!.bounds())
        assertEquals(expectedScrimBounds(decor, navigation, statusBar = false), navigationScrim!!.bounds())
        assertEquals(ContextCompat.getColor(activity, R.color.semantic_system_bar), (statusScrim.background as ColorDrawable).color)
        assertEquals(ContextCompat.getColor(activity, R.color.semantic_system_bar), (navigationScrim.background as ColorDrawable).color)
    }

    @Test fun systemBarProtectionMatchesApiAndInsets() {
        about { scenario ->
            scenario.onActivity { activity ->
                if (Build.VERSION.SDK_INT >= 35) {
                    assertEquals(Color.TRANSPARENT, activity.window.statusBarColor)
                    assertEquals(Color.TRANSPARENT, activity.window.navigationBarColor)
                    assertScrimBounds(activity)
                } else {
                    val expected = ContextCompat.getColor(activity, R.color.semantic_system_bar)
                    assertEquals(expected, activity.window.statusBarColor)
                    assertEquals(expected, activity.window.navigationBarColor)
                }
            }
        }
    }

    @Test fun repeatedInsetDispatchIsIdempotentAndDoesNotMoveContent() {
        about { scenario ->
            var before: Rect? = null
            scenario.onActivity { activity ->
                before = activity.findViewById<View>(android.R.id.content).bounds()
                ViewCompat.requestApplyInsets(activity.window.decorView)
            }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            scenario.recreate()
            waitForAbout(scenario)
            scenario.onActivity { activity ->
                assertEquals(before, activity.findViewById<View>(android.R.id.content).bounds())
                if (Build.VERSION.SDK_INT >= 35) {
                    val decor = activity.window.decorView
                    assertScrimBounds(activity)
                    assertEquals(1, countTagged(decor, BaseActivity.STATUS_BAR_SCRIM_TAG))
                    assertEquals(1, countTagged(decor, BaseActivity.NAVIGATION_BAR_SCRIM_TAG))
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
