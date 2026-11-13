package io.silentsuite.sync.ui.report

import android.os.SystemClock
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.RadioButton
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.R
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.SocketTimeoutException
import java.util.concurrent.CopyOnWriteArrayList

/** The real screen and builder; only the final POST goes to a recording seam. */
@RunWith(AndroidJUnit4::class)
class ReportProblemRuntimeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val sent = CopyOnWriteArrayList<ByteArray>()

    @After
    fun resetSeam() {
        ReportProblemViewModel.transportForTest = null
    }

    private fun launch() = ActivityScenario.launch<ReportProblemActivity>(
        ReportProblemActivity.newIntent(ApplicationProvider.getApplicationContext()))

    private fun fill(activity: ReportProblemActivity) {
        activity.findViewById<EditText>(R.id.report_summary).setText("Sync stops")
        activity.findViewById<EditText>(R.id.report_description).setText("It stopped after the update.\nTwice.")
    }

    private fun status(activity: ReportProblemActivity) =
        activity.findViewById<TextView>(R.id.report_status).text.toString()

    private fun waitFor(scenario: ActivityScenario<ReportProblemActivity>, what: String,
                        condition: (ReportProblemActivity) -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (true) {
            instrumentation.waitForIdleSync()
            var met = false
            scenario.onActivity { met = condition(it) }
            if (met) return
            check(SystemClock.uptimeMillis() < deadline) { "timed out waiting for $what" }
            SystemClock.sleep(50)
        }
    }

    @Test
    fun openingEditingTogglingBackgroundingAndCancellingSendNothing() {
        ReportProblemViewModel.transportForTest = { sent += it; true }
        val scenario = launch()
        scenario.onActivity { activity ->
            fill(activity)
            val box = activity.findViewById<CheckBox>(R.id.report_include_diagnostics)
            val preview = activity.findViewById<View>(R.id.report_preview_group)
            assertTrue(box.isChecked)
            assertEquals(View.VISIBLE, preview.visibility)
            activity.findViewById<RadioButton>(R.id.report_kind_feature).performClick()
            assertFalse("feature requests default to no diagnostics", box.isChecked)
            assertEquals(View.GONE, preview.visibility)
            box.performClick()
            assertEquals(View.VISIBLE, preview.visibility)
            activity.findViewById<RadioButton>(R.id.report_kind_problem).performClick()
            assertTrue(box.isChecked)
            assertEquals("", status(activity))
        }
        scenario.recreate()
        scenario.moveToState(Lifecycle.State.CREATED)
        scenario.moveToState(Lifecycle.State.RESUMED)
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        instrumentation.waitForIdleSync()
        scenario.close()
        SystemClock.sleep(300)
        assertTrue("nothing may be sent before Send", sent.isEmpty())
    }

    @Test
    fun theSentDiagnosticsAreThePreviewTextAndOnePressSendsOnce() {
        ReportProblemViewModel.transportForTest = { sent += it; true }
        launch().use { scenario ->
            var preview = ""
            scenario.onActivity { activity ->
                fill(activity)
                preview = activity.findViewById<TextView>(R.id.report_preview).text.toString()
                val send = activity.findViewById<Button>(R.id.report_send)
                send.performClick()
                // A second press while sending reaches the listener but never a second request.
                send.performClick()
            }
            waitFor(scenario, "thanks") { status(it) == it.getString(R.string.report_problem_sent) }
            scenario.recreate()
            waitFor(scenario, "thanks after recreation") { status(it) == it.getString(R.string.report_problem_sent) }
            SystemClock.sleep(300)
            assertEquals(1, sent.size)
            val body = String(sent.single(), Charsets.UTF_8)
            assertTrue(preview, preview.startsWith("{\n  \"app_version\": "))
            assertTrue(body, body.endsWith(",\"diagnostics\":$preview}"))
            assertTrue(body, body.contains("\"description\":\"It stopped after the update.\\nTwice.\""))
        }
    }

    @Test
    fun aTimeoutShowsTheUnconfirmedMessageAndNothingResends() {
        ReportProblemViewModel.transportForTest = { sent += it; throw SocketTimeoutException("timeout") }
        launch().use { scenario ->
            scenario.onActivity { activity ->
                fill(activity)
                activity.findViewById<Button>(R.id.report_send).performClick()
            }
            val unconfirmed = { activity: ReportProblemActivity ->
                status(activity) == activity.getString(R.string.report_problem_unconfirmed)
            }
            waitFor(scenario, "unconfirmed", unconfirmed)
            scenario.onActivity { activity ->
                val send = activity.findViewById<Button>(R.id.report_send)
                assertEquals(View.GONE, send.visibility)
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.report_email_instead).visibility)
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.report_copy).visibility)
                send.performClick()
            }
            scenario.recreate()
            waitFor(scenario, "unconfirmed after recreation", unconfirmed)
            SystemClock.sleep(300)
            assertEquals(1, sent.size)
        }
    }
}
