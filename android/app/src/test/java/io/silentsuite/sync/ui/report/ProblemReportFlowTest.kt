package io.silentsuite.sync.ui.report

import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.report.ProblemReportFlow.State
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/** The real builder, serializer and OkHttp transport against a local server; no Android framework. */
class ProblemReportFlowTest {
    private lateinit var server: MockWebServer
    private val preview = ProblemReport.diagnosticsJson(ProblemReport.DiagnosticsInput(
        "0.5.18-beta", 5018, 34,
        listOf(ProblemReport.AccountState(false, listOf(SyncStatusStore.Status(lastSuccessAt = 1L)))),
        ProblemReport.StartupOutcome.SUCCEEDED, 2L,
    ))

    @Before
    fun start() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun flow(timeoutMillis: Long = 2_000) = ProblemReportFlow(
        ProblemReportTransport(server.url("/v1/reports"), ProblemReportTransport.newClient(timeoutMillis))::post,
    )

    private fun body(diagnostics: String? = preview) =
        ProblemReport.build(ProblemReport.Kind.PROBLEM, "Sync stops", "It stopped after the update.", "", diagnostics)

    @Test
    fun nothingIsRequestedBeforeSend() {
        val flow = flow()
        // Opening the screen, building the preview, toggling diagnostics and editing build text only.
        body(preview)
        body(null)
        ProblemReport.emailBody("text", preview)
        assertEquals(State.EDITING, flow.state)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun sentBodyIsExactlyTheBuiltBodyWithTheFrozenPreview() {
        server.enqueue(MockResponse().setResponseCode(201).setBody("{\"ok\":true}"))
        val body = body()
        assertEquals(State.SENT, flow().send(body))
        val request = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("POST", request.method)
        assertEquals("/v1/reports", request.path)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
        assertNull(request.getHeader("Origin"))
        val sent = request.body.readByteArray()
        assertTrue(sent.contentEquals(body.toByteArray(Charsets.UTF_8)))
        assertTrue(String(sent, Charsets.UTF_8).contains(preview))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun timeoutIsUnconfirmedAndNeverResent() {
        // The relay reads the request but answers only after the client has given up.
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val flow = flow(timeoutMillis = 500)
        assertEquals(State.UNCONFIRMED, flow.send(body()))
        // A second press, or a recreated screen reusing the flow, sends nothing more.
        assertFalse(flow.claim())
        assertEquals(State.UNCONFIRMED, flow.send(body()))
        Thread.sleep(300)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun redirectsAreNotFollowed() {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", server.url("/elsewhere").toString()))
        server.enqueue(MockResponse().setResponseCode(201))
        assertEquals(State.UNCONFIRMED, flow().send(body()))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun serverErrorsAndRefusedConnectionsAreUnconfirmedAfterOneAttempt() {
        server.enqueue(MockResponse().setResponseCode(502))
        assertEquals(State.UNCONFIRMED, flow().send(body()))
        assertEquals(1, server.requestCount)
        server.enqueue(MockResponse().setResponseCode(200))
        assertEquals("only 201 confirms a report", State.UNCONFIRMED, flow().send(body()))

        val closed = MockWebServer().apply { start() }
        val url = closed.url("/v1/reports")
        closed.shutdown()
        val refused = ProblemReportFlow(ProblemReportTransport(url)::post)
        assertEquals(State.UNCONFIRMED, refused.send(body()))
    }

    @Test
    fun productionClientUsesTheFixedEndpointNoRedirectsNoRetryAndShortTimeouts() {
        assertEquals("https://report.silentsuite.io/v1/reports", ProblemReport.ENDPOINT)
        val client = ProblemReportTransport.newClient()
        assertFalse(client.followRedirects)
        assertFalse(client.followSslRedirects)
        assertFalse(client.retryOnConnectionFailure)
        listOf(client.callTimeoutMillis, client.connectTimeoutMillis, client.readTimeoutMillis, client.writeTimeoutMillis)
            .forEach { assertTrue(it in 1..20_000) }
    }
}
