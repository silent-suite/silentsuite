/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.cert4android

import android.app.Service
import android.content.Intent
import android.os.IBinder
import androidx.test.platform.app.InstrumentationRegistry.getInstrumentation
import androidx.test.rule.ServiceTestRule
import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Assume.assumeNotNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.io.IOException
import java.net.URL
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection

class CustomCertManagerTest {

    companion object {
        private fun getSiteCertificates(url: URL): List<X509Certificate> {
            val conn = url.openConnection() as HttpsURLConnection
            try {
                conn.inputStream.read()
                val certs = mutableListOf<X509Certificate>()
                conn.serverCertificates.forEach { certs += it as X509Certificate }
                return certs
            } finally {
                conn.disconnect()
            }
        }
    }

    lateinit var certManager: CustomCertManager
    lateinit var paranoidCertManager: CustomCertManager

    init {
        CustomCertManager.SERVICE_TIMEOUT = 1000
    }

    @JvmField
    @Rule
    val serviceTestRule = ServiceTestRule()

    var siteCerts: List<X509Certificate>? = null
    init {
        try {
            siteCerts = getSiteCertificates(URL("https://www.davdroid.com"))
        } catch(e: IOException) {
        }
        assumeNotNull(siteCerts)
    }


    @Before
    fun initCertManager() {
        // prepare a bound and ready service for testing
        // loop required because of https://code.google.com/p/android/issues/detail?id=180396
        val binder = bindService(CustomCertService::class.java)
        assertNotNull(binder)

        val context = getInstrumentation().context
        CustomCertManager.resetCertificates(context)

        certManager = CustomCertManager(context, false)
        assertNotNull(certManager)

        paranoidCertManager = CustomCertManager(context, false, false)
        assertNotNull(paranoidCertManager)
    }

    @After
    fun closeCertManager() {
        paranoidCertManager.close()
        certManager.close()
    }


    @Test(expected = CertificateException::class)
    fun testCheckClientCertificate() {
        certManager.checkClientTrusted(null, null)
    }

    @Test
    fun testTrustedCertificate() {
        certManager.checkServerTrusted(siteCerts!!.toTypedArray(), "RSA")
    }

    @Test(expected = CertificateException::class)
    fun testParanoidCertificate() {
        paranoidCertManager.checkServerTrusted(siteCerts!!.toTypedArray(), "RSA")
    }

    @Test
    fun testAddCustomCertificate() {
        addCustomCertificate()
        paranoidCertManager.checkServerTrusted(siteCerts!!.toTypedArray(), "RSA")
    }

    // fails randomly for unknown reason:
    @Test(expected = CertificateException::class)
    fun testRemoveCustomCertificate() {
        addCustomCertificate()

        // remove certificate and check again
        // should now be rejected for the whole session, i.e. no timeout anymore
        val intent = Intent(getInstrumentation().context, CustomCertService::class.java)
        intent.action = CustomCertService.CMD_CERTIFICATION_DECISION
        intent.putExtra(CustomCertService.EXTRA_CERTIFICATE, siteCerts!!.first().encoded)
        intent.putExtra(CustomCertService.EXTRA_TRUSTED, false)
        startService(intent, CustomCertService::class.java)
        paranoidCertManager.checkServerTrusted(siteCerts!!.toTypedArray(), "RSA")
    }

    private fun addCustomCertificate() {
        // add certificate and check again
        val intent = Intent(getInstrumentation().context, CustomCertService::class.java)
        intent.action = CustomCertService.CMD_CERTIFICATION_DECISION
        intent.putExtra(CustomCertService.EXTRA_CERTIFICATE, siteCerts!!.first().encoded)
        intent.putExtra(CustomCertService.EXTRA_TRUSTED, true)
        startService(intent, CustomCertService::class.java)
    }


    private fun bindService(clazz: Class<out Service>): IBinder {
        var binder = serviceTestRule.bindService(Intent(getInstrumentation().targetContext, clazz))
        var it = 0
        while (binder == null && it++ <100) {
            binder = serviceTestRule.bindService(Intent(getInstrumentation().targetContext, clazz))
            System.err.println("Waiting for ServiceTestRule.bindService")
            Thread.sleep(50)
        }
        if (binder == null)
            throw IllegalStateException("Couldn't bind to service")
        return binder
    }

    private fun startService(intent: Intent, clazz: Class<out Service>) {
        serviceTestRule.startService(intent)
        bindService(clazz)
    }

}
