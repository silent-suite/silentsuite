package io.silentsuite.sync.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** One spelling of Wi-Fi and SilentSuite, sentence-case buttons, and no "0 min. ago" on the dashboard. */
class CopyConsistencyContractTest {
    private val strings = File("src/main/res/values/strings.xml").readText()
    private val about = File("src/main/java/io/silentsuite/sync/ui/AboutActivity.kt").readText()
    private val account = File("src/main/java/io/silentsuite/sync/ui/AccountActivity.kt").readText()
    private val styleFiles = listOf("values/styles.xml", "values-night/styles.xml").map { File("src/main/res/$it").readText() }
    private val themeFiles = listOf("values/themes.xml", "values-night/themes.xml").map { File("src/main/res/$it").readText() }

    @Test
    fun userCopySpellsWiFiAndSilentSuiteOneWay() {
        assertFalse(strings.contains("WiFi"))
        assertTrue(strings.contains("<string name=\"settings_sync_wifi_only\">Sync over Wi-Fi only</string>"))
        assertFalse(about.contains("\"Silent Suite\""))
    }

    @Test
    fun buttonsAreNotForcedToAllCaps() {
        for (styles in styleFiles) assertFalse(styles.contains("<item name=\"android:textAllCaps\">true</item>"))
        for (themes in themeFiles) {
            assertTrue(themes.contains("<item name=\"textAppearanceButton\">@style/TextAppearance.AppTheme.Button</item>"))
        }
    }

    @Test
    fun dashboardSaysJustNowUnderAMinute() {
        assertTrue(strings.contains("<string name=\"dashboard_time_just_now\">just now</string>"))
        val relativeTime = account.substringAfter("private fun relativeTime(").substringBefore("\n    }\n")
        // Only 0 up to a minute ago; a future time falls back to Android's text.
        assertTrue(relativeTime.contains("if (now - timestamp in 0 until DateUtils.MINUTE_IN_MILLIS) return getString(R.string.dashboard_time_just_now)"))
        assertTrue(relativeTime.contains("return DateUtils.getRelativeTimeSpanString(timestamp, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE)"))
    }
}
