/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.cert4android

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast
import androidx.core.app.NotificationCompat
import org.conscrypt.Conscrypt
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.KeyStore
import java.security.KeyStoreException
import java.security.Security
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.*
import java.util.logging.Level
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * The service which manages the certificates. Communications with
 * the [CustomCertManager]s over IPC. Initializes Conscrypt when class is loaded.
 *
 * This services is both a started and a bound service.
 */
class CustomCertService: Service() {

    companion object {
        /**
         * Command when used as started service to accept/reject an open certificate decision.
         * Usually sent by a notification action or [TrustCertificateActivity].
         */
        const val CMD_CERTIFICATION_DECISION = "certificateDecision"
        /**
         * Command when used as a started service to remove all known certificates.
         * Resets the state of all previously accepted and rejected certificates.
         */
        const val CMD_RESET_CERTIFICATES = "resetCertificates"

        const val EXTRA_CERTIFICATE = "certificate"
        const val EXTRA_TRUSTED = "trusted"

        const val KEYSTORE_DIR = "KeyStore"
        const val KEYSTORE_NAME = "KeyStore.bks"

        init {
            // initialize Conscrypt
            Security.insertProviderAt(Conscrypt.newProvider(), 1)

            val version = Conscrypt.version()
            Log.i(Constants.TAG, "Using Conscrypt/${version.major()}.${version.minor()}.${version.patch()} for TLS")
            val engine = SSLContext.getDefault().createSSLEngine()
            Log.i(Constants.TAG, "Enabled protocols: ${engine.enabledProtocols.joinToString(", ")}")
            Log.i(Constants.TAG, "Enabled ciphers: ${engine.enabledCipherSuites.joinToString(", ")}")
        }

    }

    private lateinit var keyStoreFile: File

    private val certFactory = CertificateFactory.getInstance("X.509")
    private val trustedKeyStore = KeyStore.getInstance(KeyStore.getDefaultType())!!
    private var customTrustManager: X509TrustManager? = null

    private var untrustedCerts = HashSet<X509Certificate>()

    private val pendingDecisions = mutableMapOf<X509Certificate, MutableList<IOnCertificateDecision>>()


    override fun onCreate() {
        Constants.log.info("CustomCertService created")

        // initialize trustedKeyStore
        keyStoreFile = File(getDir(KEYSTORE_DIR, Context.MODE_PRIVATE), KEYSTORE_NAME)
        try {
            FileInputStream(keyStoreFile).use {
                trustedKeyStore.load(it, null)
                Constants.log.fine("Loaded ${trustedKeyStore.size()} trusted certificate(s)")
            }
        } catch(e: Exception) {
            Constants.log.log(Level.INFO, "No key store for trusted certifcates (yet); creating in-memory key store.")
            try {
                trustedKeyStore.load(null, null)
            } catch(e: Exception) {
                Constants.log.log(Level.SEVERE, "Couldn't initialize in-memory key store", e)
            }
        }

        // create custom TrustManager based on trustedKeyStore
        customTrustManager = CertUtils.getTrustManager(trustedKeyStore)
    }

    override fun onDestroy() {
        Constants.log.info("CustomCertService destroyed")
    }

    private fun inTrustStore(cert: X509Certificate) =
        try {
            trustedKeyStore.getCertificateAlias(cert) != null
        } catch(e: KeyStoreException) {
            Constants.log.log(Level.WARNING, "Couldn't query custom key store", e)
            false
        }


    // started service

    override fun onStartCommand(intent: Intent?, flags: Int, id: Int): Int {
        Constants.log.fine("Received command: $intent")

        when (intent?.action) {
            CMD_CERTIFICATION_DECISION -> {
                val raw = intent.getByteArrayExtra(EXTRA_CERTIFICATE)
                try {
                    val cert = certFactory.generateCertificate(ByteArrayInputStream(raw)) as X509Certificate
                    onReceiveDecision(cert, intent.getBooleanExtra(EXTRA_TRUSTED, false))
                } catch (e: Exception) {
                    Constants.log.log(Level.SEVERE, "Couldn't process certificate", e)
                }
            }
            CMD_RESET_CERTIFICATES -> {
                untrustedCerts.clear()
                try {
                    for (alias in trustedKeyStore.aliases())
                        trustedKeyStore.deleteEntry(alias)
                    saveKeyStore()
                } catch(e: KeyStoreException) {
                    Constants.log.log(Level.SEVERE, "Couldn't reset custom certificates", e)
                }
            }
        }
        stopSelf()
        return START_NOT_STICKY
    }

    private fun onReceiveDecision(cert: X509Certificate, trusted: Boolean) {
        // remove notification
        val nm = NotificationUtils.createChannels(this)
        nm.cancel(CertUtils.getTag(cert), Constants.NOTIFICATION_CERT_DECISION)

        // put into trust store, if trusted
        if (trusted) {
            untrustedCerts.remove(cert)

            try {
                trustedKeyStore.setCertificateEntry(cert.subjectDN.name, cert)
                saveKeyStore()
            } catch(e: KeyStoreException) {
                Constants.log.log(Level.SEVERE, "Couldn't add certificate into key store", e)
            }
        } else {
            untrustedCerts.add(cert)
            Toast.makeText(this, R.string.service_rejected_temporarily, Toast.LENGTH_LONG).show()
        }

        // notify receivers which are waiting for a decision
        pendingDecisions[cert]?.let { callbacks ->
            Constants.log.fine("Notifying ${callbacks.size} certificate decision listener(s)")
            callbacks.forEach {
                if (trusted)
                    it.accept()
                else
                    it.reject()
            }
            pendingDecisions -= cert
        }
    }

    private fun saveKeyStore() {
        Constants.log.fine("Saving custom certificate key store to $keyStoreFile")
        try {
            FileOutputStream(keyStoreFile).use { trustedKeyStore.store(it, null) }
        } catch(e: Exception) {
            Constants.log.log(Level.SEVERE, "Couldn't save custom certificate key store", e)
        }
    }


    // bound service

    private val binder = object: ICustomCertService.Stub() {

        override fun checkTrusted(raw: ByteArray, interactive: Boolean, foreground: Boolean, callback: IOnCertificateDecision) {
            val cert: X509Certificate? = try {
                certFactory.generateCertificate(ByteArrayInputStream(raw)) as? X509Certificate
            } catch(e: Exception) {
                Constants.log.log(Level.SEVERE, "Couldn't handle certificate", e)
                null
            }
            if (cert == null) {
                callback.reject()
                return
            }

            // if there's already a pending decision for this certificate, just add this callback
            pendingDecisions[cert]?.let { callbacks ->
                callbacks += callback
                return
            }

            when {
                untrustedCerts.contains(cert) -> {
                    Constants.log.fine("Certificate is cached as untrusted, rejecting")
                    callback.reject()
                }
                inTrustStore(cert) -> {
                    Constants.log.fine("Certificate is cached as trusted, accepting")
                    callback.accept()
                }
                else -> {
                    if (interactive) {
                        Constants.log.fine("Certificate not known and running in interactive mode, asking user")

                        // remember pending decision
                        pendingDecisions[cert] = mutableListOf(callback)

                        val decisionIntent = Intent(this@CustomCertService, TrustCertificateActivity::class.java)
                        decisionIntent.putExtra(TrustCertificateActivity.EXTRA_CERTIFICATE, raw)

                        val rejectIntent = Intent(this@CustomCertService, CustomCertService::class.java)
                        with(rejectIntent) {
                            action = CMD_CERTIFICATION_DECISION
                            putExtra(EXTRA_CERTIFICATE, raw)
                            putExtra(EXTRA_TRUSTED, false)
                        }

                        val id = raw.contentHashCode()
                        val notify = NotificationCompat.Builder(this@CustomCertService, NotificationUtils.CHANNEL_CERTIFICATES)
                                .setSmallIcon(R.drawable.ic_lock_open_white)
                                .setContentTitle(this@CustomCertService.getString(R.string.certificate_notification_connection_security))
                                .setContentText(this@CustomCertService.getString(R.string.certificate_notification_user_interaction))
                                .setSubText(cert.subjectDN.name)
                                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                                .setContentIntent(PendingIntent.getActivity(this@CustomCertService, id, decisionIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                                .setDeleteIntent(PendingIntent.getService(this@CustomCertService, id, rejectIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                                .build()
                        val nm = NotificationUtils.createChannels(this@CustomCertService)
                        nm.notify(CertUtils.getTag(cert), Constants.NOTIFICATION_CERT_DECISION, notify)

                        if (foreground) {
                            decisionIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            startActivity(decisionIntent)
                        }

                    } else {
                        Constants.log.fine("Certificate not known and running in non-interactive mode, rejecting")
                        callback.reject()
                    }
                }
            }
        }

        override fun abortCheck(callback: IOnCertificateDecision) {
            for ((cert, list) in pendingDecisions) {
                list.removeAll { it == callback }
                if (list.isEmpty())
                    pendingDecisions -= cert
            }
        }

    }

    override fun onBind(intent: Intent?) = binder

}
