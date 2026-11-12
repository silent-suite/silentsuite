package io.silentsuite.sync.ui.report

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Posts one report to the report endpoint. A plain OkHttp client with the system trust store: not the account
 * HttpClient, whose user-added certificates belong to the user's own server. No redirects and no
 * connection retry, so one Send is at most one request.
 */
class ProblemReportTransport(
    private val endpoint: HttpUrl = ProblemReport.ENDPOINT.toHttpUrl(),
    private val client: OkHttpClient = newClient(),
) {
    /** True only for a 201; any other status (503 included), timeout or I/O error is unconfirmed. */
    fun post(body: ByteArray): Boolean {
        val request = Request.Builder()
            .url(endpoint)
            .post(OneShotBody(body))
            .build()
        return client.newCall(request).execute().use { it.code == 201 }
    }

    /**
     * retryOnConnectionFailure(false) does not cover OkHttp's follow-ups: a 503 with "Retry-After: 0"
     * (and a 421 on a coalesced connection) would be re-sent. A one-shot body makes OkHttp return
     * that response instead, so one Send stays one POST.
     */
    private class OneShotBody(private val bytes: ByteArray) : RequestBody() {
        override fun contentType(): MediaType = JSON
        override fun contentLength(): Long = bytes.size.toLong()
        override fun writeTo(sink: BufferedSink) {
            sink.write(bytes)
        }
        override fun isOneShot(): Boolean = true
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        const val DEFAULT_TIMEOUT_MILLIS = 20_000L

        fun newClient(callTimeoutMillis: Long = DEFAULT_TIMEOUT_MILLIS): OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .connectTimeout(callTimeoutMillis, TimeUnit.MILLISECONDS)
            .writeTimeout(callTimeoutMillis, TimeUnit.MILLISECONDS)
            .readTimeout(callTimeoutMillis, TimeUnit.MILLISECONDS)
            .callTimeout(callTimeoutMillis, TimeUnit.MILLISECONDS)
            .build()
    }
}

/**
 * One report, sent at most once. There is no automatic retry: after a timeout the server may already
 * have emailed the report, so a failure ends in [State.UNCONFIRMED] and only Email or Copy remain.
 */
class ProblemReportFlow(private val transport: (ByteArray) -> Boolean) {
    enum class State { EDITING, SENDING, SENT, UNCONFIRMED }

    private val claimed = AtomicBoolean(false)

    @Volatile
    var state: State = State.EDITING
        private set

    /** Claims the single send. False when a send was already started, whatever its outcome. */
    fun claim(): Boolean = claimed.compareAndSet(false, true).also { if (it) state = State.SENDING }

    /** Performs the claimed send; blocking, so call it off the main thread. */
    fun deliver(body: String): State {
        check(state == State.SENDING) { "deliver() requires a successful claim()" }
        val sent = try {
            transport(body.toByteArray(Charsets.UTF_8))
        } catch (_: Exception) {
            false
        }
        state = if (sent) State.SENT else State.UNCONFIRMED
        return state
    }

    fun send(body: String): State = if (claim()) deliver(body) else state
}
