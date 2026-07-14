/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.cert4android

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.databinding.DataBindingUtil
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import at.bitfire.cert4android.databinding.ActivityTrustCertificateBinding
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.CertificateParsingException
import java.security.cert.X509Certificate
import java.security.spec.MGF1ParameterSpec.SHA1
import java.security.spec.MGF1ParameterSpec.SHA256
import java.text.DateFormat
import java.util.*
import java.util.logging.Level
import kotlin.concurrent.thread

class TrustCertificateActivity: AppCompatActivity() {

    companion object {
        const val EXTRA_CERTIFICATE = "certificate"
    }

    private lateinit var model: Model

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        model = ViewModelProvider(this).get(Model::class.java)
        model.processIntent(intent)

        val binding = DataBindingUtil.setContentView<ActivityTrustCertificateBinding>(this, R.layout.activity_trust_certificate)
        binding.lifecycleOwner = this
        binding.model = model
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // singleInstance activities receive a new intent; decisions must use its generation.
        setIntent(intent)
        model.processIntent(intent)
    }

    fun acceptCertificate(view: View) {
        sendDecision(true)
        finish()
    }

    fun rejectCertificate(view: View) {
        sendDecision(false)
        finish()
    }

    private fun sendDecision(trusted: Boolean) {
        val decision = model.decision() ?: return
        val intent = Intent(this, CustomCertService::class.java)
        with(intent) {
            action = CustomCertService.CMD_CERTIFICATION_DECISION
            putExtra(CustomCertService.EXTRA_CERTIFICATE, decision.certificate)
            putExtra(CustomCertService.EXTRA_TRUSTED, trusted)
            putExtra(CustomCertService.EXTRA_DECISION_GENERATION, decision.generation)
        }
        startService(intent)
    }


    class Model: ViewModel() {

        companion object {
            val certFactory = CertificateFactory.getInstance("X.509")!!
        }

        private val certificateState = TrustCertificateState()
        private val mainHandler = Handler(Looper.getMainLooper())
        val screen = MutableLiveData(TrustCertificateState.Screen())
        val verifiedByUser = MutableLiveData<Boolean>()

        fun processIntent(intent: Intent?) {
            // Clear the previous screen synchronously: neither button may decide while the
            // current intent is loading or malformed.
            verifiedByUser.value = false
            screen.value = TrustCertificateState.Screen()
            val request = certificateState.begin(
                intent?.getStringExtra(CustomCertService.EXTRA_DECISION_GENERATION),
                intent?.getByteArrayExtra(EXTRA_CERTIFICATE)
            ) ?: return
            thread {
                val details = parse(request.certificate) ?: return@thread
                mainHandler.post {
                    // This guard runs on the UI thread, after any onNewIntent processing.
                    certificateState.complete(request, details)?.let { screen.value = it }
                }
            }
        }

        fun decision() = certificateState.decision()

        private fun parse(raw: ByteArray): TrustCertificateState.Details? = try {
            val cert = synchronized(certFactory) {
                certFactory.generateCertificate(ByteArrayInputStream(raw)) as? X509Certificate
            } ?: return null
            val subject = cert.subjectAlternativeNames?.let { altNames ->
                buildString {
                    for (altName in altNames) {
                        val name = altName[1]
                        if (name is String)
                            append("[").append(altName[0]).append("]").append(name).append(" ")
                    }
                }
            } ?: cert.subjectDN.name
            val formatter = DateFormat.getDateInstance(DateFormat.LONG)
            TrustCertificateState.Details(subject, cert.issuerDN.toString(),
                formatter.format(cert.notBefore), formatter.format(cert.notAfter),
                fingerprint(cert, SHA1.digestAlgorithm), fingerprint(cert, SHA256.digestAlgorithm))
        } catch(e: CertificateParsingException) {
            Constants.log.log(Level.WARNING, "Couldn't parse certificate", e)
            null
        } catch(e: Exception) {
            Constants.log.log(Level.WARNING, "Couldn't parse certificate", e)
            null
        }

        private fun fingerprint(cert: X509Certificate, algorithm: String) =
                try {
                    val md = MessageDigest.getInstance(algorithm)
                    "$algorithm: ${hexString(md.digest(cert.encoded))}"
                } catch(e: Exception) {
                    e.message ?: "Couldn't create message digest"
                }

        private fun hexString(data: ByteArray): String {
            val str = data.mapTo(LinkedList()) { String.format("%02x", it) }
            return str.joinToString(":")
        }

    }

}
