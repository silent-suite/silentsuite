/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.cert4android

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.Looper
import java.io.Closeable
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.logging.Level
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSession
import javax.net.ssl.X509TrustManager

/**
 * TrustManager to handle custom certificates. Communicates with
 * [CustomCertService] to fetch information about custom certificate
 * trustworthiness. The IPC with a service is required when multiple processes,
 * each of them with an own [CustomCertManager], want to access a synchronized central
 * certificate trust store + UI (for accepting certificates etc.).
 *
 * @param context used to bind to [CustomCertService]
 * @param interactive true: users will be notified in case of unknown certificates;
 *                    false: unknown certificates will be rejected (only uses custom certificate key store)
 * @param trustSystemCerts whether system certificates will be trusted
 * @param appInForeground  Whether to launch [TrustCertificateActivity] directly. The notification will always be shown.
 *
 * @constructor Creates a new instance, using a certain [CustomCertService] messenger (for testing).
 * Must not be run from the main thread because this constructor may request binding to [CustomCertService].
 * The actual binding code is called by the looper in the main thread, so waiting for the
 * service would block forever.
 *
 * @throws IllegalStateException if run from main thread
 */
class CustomCertManager @JvmOverloads constructor(
        val context: Context,
        val interactive: Boolean = true,
        trustSystemCerts: Boolean = true,

        @Volatile
        var appInForeground: Boolean = false
): X509TrustManager, Closeable {

    companion object {

        /** how long to wait for a decision from [CustomCertService] before giving up temporarily */
        var SERVICE_TIMEOUT: Long = 3*60*1000

        fun resetCertificates(context: Context): Boolean {
            val intent = Intent(context, CustomCertService::class.java)
            intent.action = CustomCertService.CMD_RESET_CERTIFICATES
            return context.startService(intent) != null
        }

    }

    var service: ICustomCertService? = null
    private var serviceConn: ServiceConnection? = null
    private var serviceLock = Object()

    /** system-default trust store */
    private val systemTrustManager: X509TrustManager? =
            if (trustSystemCerts) CertUtils.getTrustManager(null) else null


    init {
        val newServiceConn = object: ServiceConnection {
            override fun onServiceConnected(className: ComponentName, binder: IBinder) {
                Constants.log.fine("Connected to service")
                synchronized(serviceLock) {
                    this@CustomCertManager.service = ICustomCertService.Stub.asInterface(binder)
                    serviceLock.notify()
                }
            }

            override fun onServiceDisconnected(className: ComponentName) {
                synchronized(serviceLock) {
                    this@CustomCertManager.service = null
                }
            }
        }

        check(Looper.myLooper() != Looper.getMainLooper()) {
            // service is actually created after bindService() by code running in looper, so this would block
            "must not be run on main thread"
        }

        Constants.log.fine("Binding to service")
        if (context.bindService(Intent(context, CustomCertService::class.java), newServiceConn, Context.BIND_AUTO_CREATE)) {
            serviceConn = newServiceConn

            Constants.log.fine("Waiting for service to be bound")
            synchronized(serviceLock) {
                while (service == null)
                    try {
                        serviceLock.wait()
                    } catch(e: InterruptedException) {
                    }
            }
        } else
            Constants.log.severe("Couldn't bind CustomCertService to context")
    }

    override fun close() {
        serviceConn?.let {
            try {
                context.unbindService(it)
                serviceConn = null
            } catch (e: Exception) {
                Constants.log.log(Level.WARNING, "Couldn't unbind CustomCertService", e)
            }
        }
    }


    @Throws(CertificateException::class)
    override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {
        throw CertificateException("cert4android doesn't validate client certificates")
    }

    /**
     * Checks whether a certificate is trusted. If {@link #systemTrustManager} is null (because
     * system certificates are not being trusted or available), the first certificate in the chain
     * (which is the lowest one, i.e. the actual server certificate) is passed to
     * {@link CustomCertService} for further decision.
     * @param chain        certificate chain to check
     * @param authType     authentication type (ignored)
     * @throws CertificateException in case of an untrusted or questionable certificate
     */
    @Throws(CertificateException::class)
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        var trusted = false

        systemTrustManager?.let {
            try {
                it.checkServerTrusted(chain, authType)
                trusted = true
            } catch(ignored: CertificateException) {
                Constants.log.fine("Certificate not trusted by system")
            }
        }

        if (!trusted)
            // not trusted by system, let's check ourselves
            checkCustomTrusted(chain[0])
    }

    internal fun checkCustomTrusted(cert: X509Certificate) {
        val svc = service ?: throw CertificateException("Not bound to CustomCertService")

        val lock = Object()
        var valid: Boolean? = null

        val callback = object: IOnCertificateDecision.Stub() {
            override fun accept() {
                synchronized(lock) {
                    valid = true
                    lock.notify()
                }
            }
            override fun reject() {
                synchronized(lock) {
                    valid = false
                    lock.notify()
                }
            }
        }

        try {
            svc.checkTrusted(cert.encoded, interactive, appInForeground, callback)
            synchronized(lock) {
                if (valid == null) {
                    Constants.log.fine("Waiting for reply from service")
                    try {
                        lock.wait(SERVICE_TIMEOUT)
                    } catch(e: InterruptedException) {
                    }
                }
            }
        } catch(e: Exception) {
            throw CertificateException("Couldn't check certificate", e)
        }

        when (valid) {
            null -> {
                svc.abortCheck(callback)
                throw CertificateException("Timeout when waiting for certificate trustworthiness decision")
            }

            true -> { /* OK */ }
            false -> throw CertificateException("Certificate not accepted by CustomCertService")
        }
    }

    override fun getAcceptedIssuers() = arrayOf<X509Certificate>()


    // custom methods

    fun hostnameVerifier(defaultVerifier: HostnameVerifier?) = CustomHostnameVerifier(defaultVerifier)


    // hostname verifier

    inner class CustomHostnameVerifier(
            private val defaultVerifier: HostnameVerifier?
    ): HostnameVerifier {

        override fun verify(host: String, sslSession: SSLSession): Boolean {
            Constants.log.fine("Verifying certificate for $host")

            if (defaultVerifier?.verify(host, sslSession) == true)
                return true

            // default hostname verifier couldn't verify the hostname →
            // accept the hostname as verified only if the certificate has been accepted be the user

            try {
                val cert = sslSession.peerCertificates
                if (cert.isNotEmpty() && cert[0] is X509Certificate) {
                    checkCustomTrusted(cert[0] as X509Certificate)
                    Constants.log.fine("Certificate is in custom trust store, accepting")
                    return true
                }
            } catch(e: SSLPeerUnverifiedException) {
                Constants.log.log(Level.WARNING, "Couldn't get certificate for host name verification", e)
            } catch (ignored: CertificateException) {
            }

            return false
        }

    }

}
