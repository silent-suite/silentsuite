package at.bitfire.cert4android

import android.app.Instrumentation
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.ServiceTestRule
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.matcher.ViewMatchers.isEnabled
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.lifecycle.ViewModelProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.FileInputStream
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * End-to-end coverage of the public AIDL contract.  The certificate is a checked-in, local test
 * fixture: these tests do not contact davdroid.com (or any other network endpoint).
 */
@RunWith(AndroidJUnit4::class)
class CustomCertManagerTest {
    @JvmField @Rule val services = ServiceTestRule()

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private lateinit var service: ICustomCertService
    private lateinit var certificate: X509Certificate
    private lateinit var secondCertificate: X509Certificate

    @Before fun setUp() {
        val binder: IBinder = services.bindService(Intent(instrumentation.targetContext, CustomCertService::class.java))
        service = ICustomCertService.Stub.asInterface(binder)
        certificate = CertificateFactory.getInstance("X.509").generateCertificate(
            requireNotNull(javaClass.classLoader?.getResourceAsStream("sample.crt"))
        ) as X509Certificate
        secondCertificate = CertificateFactory.getInstance("X.509").generateCertificate(
            requireNotNull(javaClass.classLoader?.getResourceAsStream("second.crt"))
        ) as X509Certificate
        service.resetCertificates()
    }

    @After fun tearDown() {
        service.resetCertificates()
    }

    @Test fun acceptThenTrustedCheckUsesTheRealServiceBinder() {
        val pending = beginForegroundDecision()
        sendDecision(pending.generation, true)
        pending.callback.assertAccepted()
        // The manager is the public TrustManager consumer and binds to the same real service.
        val manager = CustomCertManager(instrumentation.targetContext, interactive = false, trustSystemCerts = false)
        try {
            manager.checkServerTrusted(arrayOf(certificate), "RSA")
        } finally {
            manager.close()
        }
    }

    @Test fun rejectAndDuplicateOrStaleGenerationsAreIgnored() {
        val first = beginForegroundDecision()
        sendDecision(first.generation, false)
        first.callback.assertRejected()

        val second = beginForegroundDecision()
        sendDecision(first.generation, true) // stale generation must not consume the new callback
        assertFalse(second.callback.await(250))
        sendDecision(second.generation, false)
        second.callback.assertRejected()
        sendDecision(second.generation, true) // duplicate delivery is a no-op
        assertEquals(0, second.callback.accepts)
        assertEquals(1, second.callback.rejects)
    }

    @Test fun multipleCallbacksResolveExactlyOnceAndAbortDetachesOnlyItsCallback() {
        val first = beginForegroundDecision()
        val joined = Callback()
        service.checkTrusted(certificate.encoded, true, true, joined)
        service.abortCheck(first.callback)
        sendDecision(first.generation, true)
        assertFalse(first.callback.await(250))
        joined.assertAccepted()
        assertEquals(1, joined.accepts)
        assertEquals(0, joined.rejects)
    }

    @Test fun unavailableNotificationFailsClosedForBackgroundRequests() {
        // API 33 is the only platform where an app-level notification permission can be made
        // unavailable deterministically without changing production code. API 14–32 has no such
        // permission and is covered by the normal notification path above.
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        val packageName = instrumentation.targetContext.packageName
        val originalMode = Regex("POST_NOTIFICATION:\\s+(\\w+)")
            .find(shell("appops get $packageName POST_NOTIFICATION"))?.groupValues?.get(1)
        shell("appops set $packageName POST_NOTIFICATION deny")
        instrumentation.waitForIdleSync()
        try {
            val callback = Callback()
            service.checkTrusted(certificate.encoded, true, false, callback)
            callback.assertRejected()
        } finally {
            if (originalMode == null)
                shell("appops reset $packageName POST_NOTIFICATION")
            else
                shell("appops set $packageName POST_NOTIFICATION $originalMode")
            instrumentation.waitForIdleSync()
        }
    }

    @Test fun activityRecreationAndNewIntentDeliverTheRenderedGenerationDecision() {
        val old = beginForegroundDecision()
        val current = beginForegroundDecision(secondCertificate)
        ActivityScenario.launch<TrustCertificateActivity>(activityIntent(old.generation)).use { scenario ->
            // singleInstance delivery must supersede the old parse/render snapshot.
            scenario.onActivity {
                it.startActivity(activityIntent(current.generation, secondCertificate))
            }
            instrumentation.waitForIdleSync()
            scenario.recreate()
            awaitRenderedCertificate(scenario)
            // This is the actual bound layout click, not a direct service command: it proves the
            // recreated activity retained the current rendered certificate+generation for IPC.
            onView(withId(R.id.reject_certificate)).check(matches(isEnabled())).perform(click())
        }
        current.callback.assertRejected()
        assertFalse(old.callback.await(250))
        sendDecision(old.generation, false)
        old.callback.assertRejected()
    }

    @Test fun activityAcceptDeliversThroughTheStartedService() {
        val pending = beginForegroundDecision()
        ActivityScenario.launch<TrustCertificateActivity>(activityIntent(pending.generation)).use { scenario ->
            scenario.recreate()
            awaitRenderedCertificate(scenario)
            onView(withId(R.id.certificate_verified)).perform(click())
            onView(withId(R.id.accept_certificate)).check(matches(isEnabled())).perform(click())
        }
        pending.callback.assertAccepted()
    }

    private fun beginForegroundDecision(cert: X509Certificate = certificate): Pending {
        val monitor = instrumentation.addMonitor(TrustCertificateActivity::class.java.name, null, false)
        val callback = Callback()
        service.checkTrusted(cert.encoded, true, true, callback)
        val activity = instrumentation.waitForMonitorWithTimeout(monitor, 3_000)
        instrumentation.removeMonitor(monitor)
        requireNotNull(activity) { "Foreground certificate decision did not launch TrustCertificateActivity" }
        val generation = activity.intent.getStringExtra(CustomCertService.EXTRA_DECISION_GENERATION)
        activity.finish()
        instrumentation.waitForIdleSync()
        return Pending(requireNotNull(generation), callback)
    }

    private fun sendDecision(generation: String, trusted: Boolean) {
        instrumentation.targetContext.startService(Intent(instrumentation.targetContext, CustomCertService::class.java).apply {
            action = CustomCertService.CMD_CERTIFICATION_DECISION
            putExtra(CustomCertService.EXTRA_CERTIFICATE, certificate.encoded)
            putExtra(CustomCertService.EXTRA_DECISION_GENERATION, generation)
            putExtra(CustomCertService.EXTRA_TRUSTED, trusted)
        })
    }

    private fun activityIntent(generation: String, cert: X509Certificate = certificate) = Intent(instrumentation.targetContext, TrustCertificateActivity::class.java).apply {
        putExtra(TrustCertificateActivity.EXTRA_CERTIFICATE, cert.encoded)
        putExtra(CustomCertService.EXTRA_DECISION_GENERATION, generation)
    }

    private fun shell(command: String): String =
        instrumentation.uiAutomation.executeShellCommand(command).use { descriptor ->
            FileInputStream(descriptor.fileDescriptor).bufferedReader().readText()
        }

    private fun awaitRenderedCertificate(scenario: ActivityScenario<TrustCertificateActivity>) {
        val rendered = CountDownLatch(1)
        scenario.onActivity { activity ->
            ViewModelProvider(activity).get(TrustCertificateActivity.Model::class.java)
                .screen.observe(activity) { if (it.ready) rendered.countDown() }
        }
        assertTrue("certificate screen did not become ready", rendered.await(3_000, TimeUnit.MILLISECONDS))
    }

    private data class Pending(val generation: String, val callback: Callback)

    private class Callback : IOnCertificateDecision.Stub() {
        private val result = CountDownLatch(1)
        @Volatile var accepts = 0
        @Volatile var rejects = 0
        override fun accept() { accepts++; result.countDown() }
        override fun reject() { rejects++; result.countDown() }
        fun await(timeoutMillis: Long) = result.await(timeoutMillis, TimeUnit.MILLISECONDS)
        fun assertAccepted() { assertTrue("accept callback timed out", await(3_000)); assertEquals(1, accepts); assertEquals(0, rejects) }
        fun assertRejected() { assertTrue("reject callback timed out", await(3_000)); assertEquals(0, accepts); assertEquals(1, rejects) }
    }
}
