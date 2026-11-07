package at.bitfire.cert4android

import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.Process
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.lang.ref.Reference
import java.lang.ref.WeakReference
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import javax.net.ssl.HostnameVerifier

/**
 * ANDROIDX-U3: library lifecycle precondition only. This class is expected to pass.
 *
 * It runs the real [CustomCertManager] against the real [CustomCertService] in this library's
 * instrumentation target context. It establishes that each manager holds one service binding until
 * [CustomCertManager.close], and that the bindings stay held while derived hostname verifiers
 * are still reachable. It does not run the app's photo downloader or setup configuration finder,
 * and nothing here says anything about their behaviour.
 *
 * Binding counts come from two independent platform observers. Neither is derived from the number of
 * managers the test constructed:
 *  - O1: [ActivityManager.getRunningServices] `clientCount` for this package's own service record
 *    (still returned to the caller for its own services on API 26+).
 *  - O2: distinct `ConnectionRecord{<id>` identities in `dumpsys activity services <component>`.
 * An observer that cannot see the service, or output that lacks the dumpsys header, is a fixture
 * failure, not product evidence. Command failure is never read as zero connections.
 */
@RunWith(AndroidJUnit4::class)
class AndroidxU3BindingLifecycleTest {

    private companion object {
        const val MANAGERS = 5
        const val OBSERVE_TIMEOUT_MS = 10_000L
        const val POLL_MS = 100L
        const val SHELL_TIMEOUT_MS = 15_000L
        const val DUMPSYS_HEADER = "ACTIVITY MANAGER SERVICES"
        val CONNECTION_RECORD = Regex("ConnectionRecord\\{([0-9a-f]+) ")
    }

    private data class Observation(val clientCount: Int, val connectionRecords: Int)

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext
    private val component: ComponentName get() = ComponentName(context, CustomCertService::class.java)

    /** Healthy control: every closed manager returns both observers to the zero baseline. */
    @Test
    fun androidxU3_closedManagersReturnBindingsToBaseline() {
        requireOffMainThread()
        requireZeroBaseline()

        for (iteration in 1..MANAGERS) {
            // Closeable.use closes in finally, including when an assertion below fails.
            CustomCertManager(context, false, true).use { manager ->
                assertNotNull("iteration $iteration: manager was not connected to CustomCertService", manager.service)
                val bound = awaitObservation(1)
                assertEquals("iteration $iteration: O1 running-service clientCount while bound ($bound)", 1, bound.clientCount)
                assertEquals("iteration $iteration: O2 dumpsys ConnectionRecords while bound ($bound)", 1, bound.connectionRecords)
            }
            val released = awaitObservation(0)
            assertEquals("iteration $iteration: O1 running-service clientCount after close ($released)", 0, released.clientCount)
            assertEquals("iteration $iteration: O2 dumpsys ConnectionRecords after close ($released)", 0, released.connectionRecords)
        }
    }

    /**
     * Precondition: unclosed managers stay bound while their derived verifiers are reachable.
     *
     * [CustomCertManager.CustomHostnameVerifier] is an inner class, so each retained verifier strongly
     * retains its manager. The managers therefore stay reachable from this test for the whole method.
     * The GC requests do not show which root keeps a binding alive, and the test makes no claim
     * about survival once every client reference is gone. The weak references are only cleanup
     * handles. They resolve because the verifiers retain the managers, and an unresolved handle is
     * a fixture failure.
     */
    @Test
    fun androidxU3_unclosedManagersRetainOneBindingEachAcrossGc() {
        requireOffMainThread()
        requireZeroBaseline()

        val verifiers = ArrayList<HostnameVerifier>(MANAGERS)
        val cleanupHandles = ArrayList<WeakReference<CustomCertManager>>(MANAGERS)
        var unresolvedHandles = 0
        try {
            for (index in 1..MANAGERS) {
                val manager = CustomCertManager(context, false, true)
                // Registered for cleanup before any assertion can fail.
                cleanupHandles += WeakReference(manager)
                verifiers += manager.hostnameVerifier(null)
                assertNotNull("manager $index was not connected to CustomCertService", manager.service)
            }

            requestGc()

            val held = awaitObservation(MANAGERS)
            assertEquals("O1 running-service clientCount with verifiers retained ($held)", MANAGERS, held.clientCount)
            assertEquals("O2 dumpsys ConnectionRecords with verifiers retained ($held)", MANAGERS, held.connectionRecords)
        } finally {
            for (handle in cleanupHandles) {
                val manager = handle.get()
                if (manager == null) unresolvedHandles++ else manager.close()
            }
            // Keeps the verifiers (and through them the managers) reachable until every close() ran.
            Reference.reachabilityFence(verifiers)
        }

        assertEquals("cleanup handles that no longer resolved (fixture failure; manager could not be closed)", 0, unresolvedHandles)
        val released = awaitObservation(0)
        assertEquals("O1 running-service clientCount after closing all ($released)", 0, released.clientCount)
        assertEquals("O2 dumpsys ConnectionRecords after closing all ($released)", 0, released.connectionRecords)
    }

    private fun requireOffMainThread() =
        assertTrue("CustomCertManager must not be constructed on the main thread",
            Looper.getMainLooper().thread !== Thread.currentThread())

    private fun requireZeroBaseline() {
        val baseline = awaitObservation(0)
        assertEquals("O1 baseline clientCount before any manager ($baseline); nonzero is a fixture failure", 0, baseline.clientCount)
        assertEquals("O2 baseline ConnectionRecords before any manager ($baseline); nonzero is a fixture failure", 0, baseline.connectionRecords)
    }

    private fun requestGc() {
        repeat(3) {
            Runtime.getRuntime().gc()
            System.runFinalization()
            SystemClock.sleep(POLL_MS)
        }
        instrumentation.waitForIdleSync()
    }

    /** Polls both observers on the monotonic clock until both match [expected] or the bound expires. */
    private fun awaitObservation(expected: Int): Observation {
        val deadline = SystemClock.elapsedRealtime() + OBSERVE_TIMEOUT_MS
        while (true) {
            val observed = Observation(runningServiceClientCount(), dumpsysConnectionRecords())
            if (observed.clientCount == expected && observed.connectionRecords == expected)
                return observed
            if (SystemClock.elapsedRealtime() >= deadline)
                return observed
            SystemClock.sleep(POLL_MS)
        }
    }

    /** O1. An absent record (service not running) is the platform's own zero, not a command failure. */
    @Suppress("DEPRECATION")
    private fun runningServiceClientCount(): Int {
        val activityManager = requireNotNull(context.getSystemService(ActivityManager::class.java)) {
            "ActivityManager unavailable (fixture failure)"
        }
        val records = activityManager.getRunningServices(Int.MAX_VALUE)
            .filter { it.service == component && it.uid == Process.myUid() }
        check(records.size <= 1) { "more than one running-service record for $component (fixture failure): $records" }
        return records.singleOrNull()?.clientCount ?: 0
    }

    /** O2. Rejects output without the dumpsys services header instead of treating it as zero. */
    private fun dumpsysConnectionRecords(): Int {
        val output = shell("dumpsys activity services ${component.flattenToString()}")
        check(output.contains(DUMPSYS_HEADER)) {
            "unsupported dumpsys output (fixture failure, not product evidence): ${output.take(500)}"
        }
        return CONNECTION_RECORD.findAll(output).map { it.groupValues[1] }.toSet().size
    }

    private fun shell(command: String): String {
        val descriptor = instrumentation.uiAutomation.executeShellCommand(command)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val read = executor.submit<String> {
                ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() }
            }
            return try {
                read.get(SHELL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            } catch (e: TimeoutException) {
                read.cancel(true)
                throw AssertionError("'$command' exceeded ${SHELL_TIMEOUT_MS} ms (fixture failure)", e)
            }
        } finally {
            runCatching { descriptor.close() }
            executor.shutdownNow()
        }
    }
}
