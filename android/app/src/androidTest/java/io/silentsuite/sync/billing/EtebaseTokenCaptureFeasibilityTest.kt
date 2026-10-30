/*
 * Copyright 2026 Silent Suite
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

package io.silentsuite.sync.billing

import androidx.test.ext.junit.runners.AndroidJUnit4
import io.silentsuite.sync.notes.FakeEtebaseServer
import io.silentsuite.sync.notes.TestMsgPack
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Native token-capture check (plan A1), bound to the production [AccountNoticeClient]: the real
 * etebase-java `fetchDashboardUrl()` request passes the production [AccountNoticeClient.OriginGuard]
 * and [AccountNoticeClient.TokenCapture], the production preflight and strict parser are exercised, and
 * [AccountNoticeClient.requestNotice] runs its real restore → dashboard → status proof → summary
 * sequence. Test wrappers only observe (attempted hosts, request counts) and delegate to the
 * production interceptors.
 *
 * Everything is answered in-process by [FakeEtebaseServer] and stand-ins, so no socket is opened and no
 * host is resolved. The token is the stand-in's synthetic one. This does not prove the hosted server's
 * dashboard callback safe; that is gate G-CB, checked separately.
 *
 * The native tests run unconditionally on every focused runtime lane: the repacked Etebase AAR keeps
 * upstream's x86 and armeabi-v7a libraries and replaces only the 64-bit ones
 * (android/scripts/build-etebase-client-16kb.sh), so API 29 x86 and API 35/36 x86_64 all load it.
 *
 * Failure messages start with HARNESS (the fixture, guard or preflight did not behave as written; says
 * nothing about JNI), JNI_PATH (the native request reached the stand-in but the header was not
 * observable as expected) or CLIENT (the production sequence or parser misbehaved). Messages never
 * contain header values.
 */
@RunWith(AndroidJUnit4::class)
class EtebaseTokenCaptureFeasibilityTest {

    /** Records each attempted host, then lets the production guard decide. */
    private class ObservedGuard(private val guard: Interceptor) : Interceptor {
        val attemptedHosts: MutableList<String> = CopyOnWriteArrayList()
        val refused: MutableList<String> = CopyOnWriteArrayList()

        override fun intercept(chain: Interceptor.Chain): Response {
            val url = chain.request().url
            attemptedHosts += url.host
            return try {
                guard.intercept(chain)
            } catch (e: IOException) {
                if (e.message == "blocked") refused += url.host
                throw e
            }
        }
    }

    /** Counts dashboard requests, then lets the production capture act. */
    private class CountingCapture(val capture: AccountNoticeClient.TokenCapture) : Interceptor {
        @Volatile var dashboardRequests = 0

        val captured: String? get() = capture.captured

        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            if (request.method == "POST" && request.url.encodedPath == DASHBOARD_PATH) dashboardRequests++
            return capture.intercept(chain)
        }
    }

    /** Answers the dashboard request the way the project's server can (`authentication.py` dashboard_url). */
    private class DashboardStandIn(private val answer: Answer) : Interceptor {
        enum class Answer { NOT_SUPPORTED, URL, REDIRECT }

        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            if (request.url.encodedPath != DASHBOARD_PATH) return chain.proceed(request)
            val builder = Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
            return when (answer) {
                Answer.NOT_SUPPORTED -> builder.code(400).message("Error").body(msgpack(linkedMapOf(
                    "code" to "not_supported", "detail" to "This server doesn't have a user dashboard."))).build()
                Answer.URL -> builder.code(200).message("OK").body(msgpack(linkedMapOf("url" to SYNTHETIC_DASHBOARD_URL))).build()
                Answer.REDIRECT -> builder.code(302).message("Found").header("Location", REDIRECT_TARGET)
                    .body(ByteArray(0).toResponseBody(null)).build()
            }
        }

        private fun msgpack(value: Map<String, Any?>) =
            TestMsgPack.encode(value).toResponseBody("application/msgpack".toMediaType())
    }

    /** The server's status-proof route, as the new server answers it; absent on an old server. */
    private class StatusProofStandIn : Interceptor {
        val authorizations: MutableList<String?> = CopyOnWriteArrayList()

        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            if (request.method != "POST" || request.url.encodedPath != AccountNoticeClient.STATUS_PROOF_PATH) return chain.proceed(request)
            authorizations += request.header("Authorization")
            return Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(JSONObject().put("statusProof", SYNTHETIC_PROOF).toString().toResponseBody("application/json".toMediaType()))
                .build()
        }
    }

    /** Billing's summary route; records exactly what reached it. */
    private class BillingStandIn(private val body: String) : Interceptor {
        class Seen(val url: String, val method: String, val authorization: String?, val cookie: String?, val body: String)
        val requests: MutableList<Seen> = CopyOnWriteArrayList()

        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            val sent = request.body?.let { Buffer().also(it::writeTo).readUtf8() } ?: ""
            requests += Seen(request.url.toString(), request.method, request.header("Authorization"), request.header("Cookie"), sent)
            return Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }
    }

    private class Recorder : Interceptor {
        val requests: MutableList<HttpUrl> = CopyOnWriteArrayList()
        override fun intercept(chain: Interceptor.Chain): Response {
            requests += chain.request().url
            return Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(ByteArray(0).toResponseBody(null)).build()
        }
    }

    private class Fixture(answer: DashboardStandIn.Answer, statusRoute: Boolean = false, summary: String = TRIAL_SUMMARY) {
        val guard = ObservedGuard(AccountNoticeClient.OriginGuard(AccountNoticeClient.ETEBASE_HOST))
        val capture = CountingCapture(AccountNoticeClient.TokenCapture())
        val server = FakeEtebaseServer(APPROVED_ROOT)
        val statusProofs = StatusProofStandIn()
        val client: OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .addInterceptor(guard)
            .addInterceptor(capture)
            .addInterceptor(DashboardStandIn(answer))
            .apply { if (statusRoute) addInterceptor(statusProofs) }
            .addInterceptor(server)
            .build()
        val billingGuard = ObservedGuard(AccountNoticeClient.OriginGuard(
            AccountNoticeClient.BILLING_HOST, setOf(AccountNoticeClient.SUMMARY_PATH), forbidAuthorization = true))
        val billing = BillingStandIn(summary)
        val billingClient: OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .addInterceptor(billingGuard)
            .addInterceptor(billing)
            .build()

        fun requestNotice(session: String) =
            AccountNoticeClient.requestNotice(session, client, capture.capture, billingClient)
    }

    /** Signs a synthetic user up with the real native client, saves the session, and restores it over [fixture]. */
    private fun restoredAccount(fixture: Fixture): Pair<String, com.etebase.client.Account> {
        val session = try {
            val client = com.etebase.client.Client.create(fixture.client, APPROVED_ROOT)
            com.etebase.client.Account.signup(client,
                com.etebase.client.User("a1-feasibility-${System.nanoTime()}", "a1-feasibility@example.invalid"),
                "stand-in-server-only").save(null)
        } catch (e: Exception) {
            fail("HARNESS: synthetic signup against the stand-in failed (${e.javaClass.simpleName})")
            throw AssertionError()
        }
        assertTrue("HARNESS: signup did not go through the stand-in",
            fixture.server.requests.any { it.startsWith("POST authentication/signup/") })
        assertEquals("HARNESS: signup already sent a dashboard request", 0, fixture.capture.dashboardRequests)
        return session to com.etebase.client.Account.restore(com.etebase.client.Client.create(fixture.client, APPROVED_ROOT), session, null)
    }

    private fun assertCapturedSyntheticToken(fixture: Fixture) {
        assertEquals("HARNESS: the native dashboard request did not reach the stand-in exactly once", 1, fixture.capture.dashboardRequests)
        val captured = fixture.capture.captured
        assertNotNull("JNI_PATH: the dashboard request carried no Authorization header visible to the application interceptor", captured)
        assertTrue("JNI_PATH: the captured Authorization value is not the stand-in's synthetic token", captured == EXPECTED_HEADER)
        assertTrue("HARNESS: a request left the approved origin", fixture.guard.refused.isEmpty())
        assertTrue("HARNESS: a request was attempted outside the approved origin", fixture.guard.attemptedHosts.all { it == APPROVED_HOST })
    }

    @Test
    fun nativeDashboardRequestExposesTheTokenWhenTheServerHasNoDashboard() {
        val fixture = Fixture(DashboardStandIn.Answer.NOT_SUPPORTED)
        val (session, account) = restoredAccount(fixture)
        val outcome = runCatching { account.fetchDashboardUrl() }
        assertTrue("HARNESS: a not_supported answer was not reported as a failure", outcome.isFailure)
        assertCapturedSyntheticToken(fixture)

        // The production sequence against a server without the status-proof route (the fake answers
        // 404): it stops there, never reaches Billing and never falls back to a login proof.
        val (result, status) = fixture.requestNotice(session)
        assertEquals("CLIENT: an old server was not reported as unsupported", AccountNoticeClient.Outcome.UNSUPPORTED, result)
        assertNull("CLIENT: an old server produced a notice", status)
        assertTrue("CLIENT: Billing was called without a status proof", fixture.billing.requests.isEmpty())
        assertTrue("CLIENT: a login proof was requested",
            fixture.server.requests.none { it.startsWith("POST billing/link-proof/") })
        assertNull("CLIENT: the captured header outlived the call", fixture.capture.captured)
    }

    @Test
    fun nativeDashboardRequestExposesTheTokenWhenTheServerReturnsAUrl() {
        val fixture = Fixture(DashboardStandIn.Answer.URL, statusRoute = true)
        val (session, account) = restoredAccount(fixture)
        val url = try {
            account.fetchDashboardUrl()
        } catch (e: Exception) {
            fail("JNI_PATH: fetchDashboardUrl failed on a well-formed answer (${e.javaClass.simpleName})")
            throw AssertionError()
        }
        assertEquals("HARNESS: the stand-in's dashboard URL did not come back", SYNTHETIC_DASHBOARD_URL, url)
        assertCapturedSyntheticToken(fixture)

        // The full production sequence: native dashboard request, captured header sent only to the
        // same origin's status-proof route, and Billing receiving the proof alone.
        val (result, status) = fixture.requestNotice(session)
        assertEquals("CLIENT: the full sequence did not succeed", AccountNoticeClient.Outcome.OK, result)
        assertNotNull("CLIENT: no notice was mapped", status)
        assertEquals("trialing", status!!.status)
        assertEquals("trial", status.plan)
        assertEquals(SYNTHETIC_TRIAL_END, status.renewalDate)
        assertEquals(3, status.trialDaysRemaining)
        assertEquals("CLIENT: the status-proof request did not carry exactly the captured header once",
            1, fixture.statusProofs.authorizations.size)
        assertTrue("CLIENT: the status-proof request carried another header", fixture.statusProofs.authorizations.single() == EXPECTED_HEADER)
        val sent = fixture.billing.requests.single()
        assertEquals(AccountNoticeClient.SUMMARY_URL, sent.url)
        assertEquals("POST", sent.method)
        assertNull("CLIENT: Billing received an Authorization header", sent.authorization)
        assertNull("CLIENT: Billing received a cookie", sent.cookie)
        val body = JSONObject(sent.body)
        assertEquals("CLIENT: Billing received more than the proof", setOf("contractVersion", "statusProof"), body.keys().asSequence().toSet())
        assertEquals(1, body.get("contractVersion"))
        assertEquals(SYNTHETIC_PROOF, body.get("statusProof"))
        assertTrue("CLIENT: the Billing guard refused the summary request", fixture.billingGuard.refused.isEmpty())
        assertTrue("CLIENT: a request left the approved origin", fixture.guard.refused.isEmpty())
        assertNull("CLIENT: the captured header outlived the call", fixture.capture.captured)

        // The production strict parser.
        assertEquals("unknown", AccountNoticeClient.parseSummary("""{"contractVersion":1,"notice":null}""")!!.status)
        val ended = AccountNoticeClient.parseSummary("""{"contractVersion":1,"notice":{"kind":"trial_ended","endedAt":"2026-10-29T10:00:00.000Z"}}""")!!
        assertEquals(listOf("expired", "trial", "2026-10-29T10:00:00.000Z"), listOf(ended.status, ended.plan, ended.renewalDate))
        val paid = AccountNoticeClient.parseSummary("""{"contractVersion":1,"notice":{"kind":"access_ended","endedAt":null}}""")!!
        assertEquals(listOf("expired", null, null), listOf(paid.status, paid.plan, paid.renewalDate))
        listOf(
            """{"contractVersion":2,"notice":null}""",
            """{"contractVersion":1}""",
            """{"contractVersion":1,"notice":null,"extra":1}""",
            """{"contractVersion":1,"notice":{"kind":"trial_days_left","trialEndsAt":"2026-11-05T10:00:00.000Z","daysRemaining":0}}""",
            """{"contractVersion":1,"notice":{"kind":"trial_days_left","trialEndsAt":"not a date","daysRemaining":3}}""",
            """{"contractVersion":1,"notice":{"kind":"trial_days_left","trialEndsAt":"2026-11-05T10:00:00.000Z","daysRemaining":3,"x":1}}""",
            """{"contractVersion":1,"notice":{"kind":"trial_ended","endedAt":null}}""",
            """{"contractVersion":1,"notice":{"kind":"renews","at":"2026-11-05T10:00:00.000Z"}}""",
            "not json",
        ).forEachIndexed { index, malformed ->
            assertNull("CLIENT: the parser accepted malformed case $index", AccountNoticeClient.parseSummary(malformed))
        }
    }

    /**
     * The stand-in answers above OkHttp's follow-up layer, so this checks that the native client
     * itself issues no request to the redirect target; OkHttp's own following is off by configuration,
     * which is asserted on the production transports. The initial request is allowed and counted.
     */
    @Test
    fun nativeDashboardRedirectIsNotFollowedAnywhere() {
        val production = AccountNoticeClient.etebaseTransport(io.silentsuite.sync.HttpClient.sharedClient, AccountNoticeClient.TokenCapture())
        val productionBilling = AccountNoticeClient.billingTransport(io.silentsuite.sync.HttpClient.sharedClient)
        assertEquals("CLIENT: the Etebase transport is not exactly guard then capture",
            listOf(AccountNoticeClient.OriginGuard::class.java, AccountNoticeClient.TokenCapture::class.java),
            production.interceptors.map { it.javaClass })
        assertEquals("CLIENT: the Billing transport is not exactly its guard",
            listOf(AccountNoticeClient.OriginGuard::class.java), productionBilling.interceptors.map { it.javaClass })
        for (transport in listOf(production, productionBilling)) {
            assertTrue("CLIENT: a production transport keeps network interceptors", transport.networkInterceptors.isEmpty())
            assertFalse("CLIENT: a production transport follows redirects", transport.followRedirects)
            assertFalse("CLIENT: a production transport follows TLS redirects", transport.followSslRedirects)
            assertFalse("CLIENT: a production transport retries", transport.retryOnConnectionFailure)
            assertTrue("CLIENT: a production transport keeps cookies", transport.cookieJar === CookieJar.NO_COOKIES)
            assertNull("CLIENT: a production transport caches", transport.cache)
        }

        val fixture = Fixture(DashboardStandIn.Answer.REDIRECT)
        assertFalse("HARNESS: redirects are enabled", fixture.client.followRedirects)
        assertFalse("HARNESS: TLS redirects are enabled", fixture.client.followSslRedirects)
        val (_, account) = restoredAccount(fixture)
        val outcome = runCatching { account.fetchDashboardUrl() }
        assertTrue("HARNESS: a redirect was reported as a dashboard URL", outcome.isFailure)
        assertEquals("HARNESS: the initial dashboard request was not made exactly once", 1, fixture.capture.dashboardRequests)
        assertEquals("HARNESS: a request reached the redirect target", 0, fixture.guard.attemptedHosts.count { it == REDIRECT_HOST })
        assertTrue("HARNESS: a request was refused, so something tried to leave the origin", fixture.guard.refused.isEmpty())
    }

    /** The production guards alone, without JNI: every refused request is stopped before the next interceptor sees it. */
    @Test
    fun originGuardRefusesEveryOtherDestinationBeforeItProceeds() {
        val guard = AccountNoticeClient.OriginGuard(AccountNoticeClient.ETEBASE_HOST)
        val recorder = Recorder()
        val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .addInterceptor(guard).addInterceptor(recorder).build()
        val refused = listOf(
            "http://server.silentsuite.io/api/v1/authentication/dashboard_url/",
            "https://server.silentsuite.io:8443/api/v1/authentication/dashboard_url/",
            "https://server.silentsuite.io.evil.invalid/api/v1/authentication/dashboard_url/",
            "https://user@server.silentsuite.io/api/v1/authentication/dashboard_url/",
            "https://user:secret@server.silentsuite.io/api/v1/authentication/dashboard_url/",
            "https://api.silentsuite.io/api/v1/authentication/dashboard_url/",
            REDIRECT_TARGET,
        )
        for (url in refused) {
            val result = runCatching { client.newCall(Request.Builder().url(url).build()).execute().close() }
            assertTrue("HARNESS: the guard let a disallowed destination through (case ${refused.indexOf(url)})", result.isFailure)
        }
        assertTrue("HARNESS: a disallowed request reached the next interceptor", recorder.requests.isEmpty())
        for (url in listOf("https://server.silentsuite.io/api/v1/authentication/dashboard_url/", "https://server.silentsuite.io:443/")) {
            client.newCall(Request.Builder().url(url).build()).execute().use {
                assertEquals("HARNESS: the guard refused the approved origin", 200, it.code)
            }
        }
        assertEquals("HARNESS: approved requests were not all forwarded", 2, recorder.requests.size)
        val cookie = runCatching {
            client.newCall(Request.Builder().url(APPROVED_ROOT).header("Cookie", "a=b").build()).execute().close()
        }
        assertTrue("CLIENT: the Etebase guard forwarded a cookie", cookie.isFailure)

        // Billing's guard: the summary path only, never with Authorization or a cookie.
        val billingRecorder = Recorder()
        val billing = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .addInterceptor(AccountNoticeClient.OriginGuard(AccountNoticeClient.BILLING_HOST,
                setOf(AccountNoticeClient.SUMMARY_PATH), forbidAuthorization = true))
            .addInterceptor(billingRecorder).build()
        val summaryBody = "{}".toRequestBody("application/json".toMediaType())
        val refusedBilling = listOf(
            Request.Builder().url(AccountNoticeClient.SUMMARY_URL).header("Authorization", "Token synthetic").post(summaryBody).build(),
            Request.Builder().url(AccountNoticeClient.SUMMARY_URL).header("Cookie", "a=b").post(summaryBody).build(),
            Request.Builder().url("https://api.silentsuite.io/subscription").post(summaryBody).build(),
            Request.Builder().url("https://server.silentsuite.io/subscription/summary").post(summaryBody).build(),
            Request.Builder().url("http://api.silentsuite.io/subscription/summary").post(summaryBody).build(),
        )
        refusedBilling.forEachIndexed { index, request ->
            assertTrue("CLIENT: the Billing guard let case $index through",
                runCatching { billing.newCall(request).execute().close() }.isFailure)
        }
        assertTrue("CLIENT: a refused Billing request reached the next interceptor", billingRecorder.requests.isEmpty())
        billing.newCall(Request.Builder().url(AccountNoticeClient.SUMMARY_URL).post(summaryBody).build()).execute().use {
            assertEquals("CLIENT: the Billing guard refused the summary request", 200, it.code)
        }
    }

    /** The production account-URI preflight alone: only the approved root origin passes, and debug remotes never do. */
    @Test
    fun accountUriPreflightAcceptsOnlyTheApprovedRootOrigin() {
        val accepted = listOf("https://server.silentsuite.io/", "https://server.silentsuite.io:443/", "https://server.silentsuite.io")
        for (uri in accepted) {
            assertNotNull("HARNESS: preflight refused an approved account URI (case ${accepted.indexOf(uri)})", preflight(uri, debugRemote = null))
        }
        val refused = listOf(
            "http://server.silentsuite.io/",
            "https://server.silentsuite.io:8443/",
            "https://server.silentsuite.io.evil.invalid/",
            "https://server.silentsuite.io./",
            "https://user@server.silentsuite.io/",
            "https://user:secret@server.silentsuite.io/",
            "https://server.silentsuite.io/sub/",
            "https://server.silentsuite.io/?q=1",
            "https://server.silentsuite.io/#f",
            "https://SERVER.silentsuite.io/",
            "not a uri",
        )
        for (uri in refused) {
            assertNull("HARNESS: preflight accepted a disallowed account URI (case ${refused.indexOf(uri)})", preflight(uri, debugRemote = null))
        }
        assertNull("HARNESS: preflight accepted the approved URI on a debug-remote build",
            preflight("https://server.silentsuite.io/", debugRemote = "https://server.silentsuite.io/"))
        assertNull("CLIENT: preflight accepted a missing account URI", preflight(null, debugRemote = null))
    }

    private companion object {
        const val APPROVED_HOST = "server.silentsuite.io"
        const val APPROVED_ROOT = "https://server.silentsuite.io/"
        const val DASHBOARD_PATH = "/api/v1/authentication/dashboard_url/"
        /** [FakeEtebaseServer] answers every signup with this synthetic token. */
        const val EXPECTED_HEADER = "Token fake-token"
        const val SYNTHETIC_DASHBOARD_URL = "https://dashboard.example.invalid/synthetic"
        const val REDIRECT_HOST = "other.example.invalid"
        const val REDIRECT_TARGET = "https://other.example.invalid/next"
        val SYNTHETIC_PROOF = "s".repeat(43)
        const val SYNTHETIC_TRIAL_END = "2026-11-05T10:00:00.000Z"
        const val TRIAL_SUMMARY =
            """{"contractVersion":1,"notice":{"kind":"trial_days_left","trialEndsAt":"$SYNTHETIC_TRIAL_END","daysRemaining":3}}"""

        /** The production preflight under test. */
        fun preflight(uri: String?, debugRemote: String?): HttpUrl? = AccountNoticeClient.preflight(uri, debugRemote)
    }
}
