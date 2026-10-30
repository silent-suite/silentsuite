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
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Synthetic feasibility check (plan A1): can an application interceptor on the OkHttp client the app
 * hands to etebase-java see the `Authorization: Token …` header of the real native
 * `fetchDashboardUrl()` request, while a guard keeps every request on one approved HTTPS origin?
 *
 * Everything is answered in-process by [FakeEtebaseServer] and a dashboard stand-in, so no socket is
 * opened and no host is resolved. The token is the stand-in's synthetic one. Nothing here ships: the
 * guard, capture and preflight below are test-local copies of the planned design, and this test does
 * not prove the hosted server's dashboard callback safe (gate G-CB stays open).
 *
 * The native tests run unconditionally on every focused runtime lane: the repacked Etebase AAR keeps
 * upstream's x86 and armeabi-v7a libraries and replaces only the 64-bit ones
 * (android/scripts/build-etebase-client-16kb.sh), so API 29 x86 and API 35/36 x86_64 all load it.
 *
 * Failure messages start with HARNESS (the fixture, guard or preflight did not behave as written; says
 * nothing about JNI) or JNI_PATH (the native request reached the stand-in but the header was not
 * observable as expected). Messages never contain header values.
 */
@RunWith(AndroidJUnit4::class)
class EtebaseTokenCaptureFeasibilityTest {

    /** Refuses, before `proceed`, any request outside the approved origin, and records each attempt's host. */
    private class OriginGuard : Interceptor {
        val attemptedHosts: MutableList<String> = CopyOnWriteArrayList()
        val refused: MutableList<String> = CopyOnWriteArrayList()

        override fun intercept(chain: Interceptor.Chain): Response {
            val url = chain.request().url
            attemptedHosts += url.host
            if (!approvedOrigin(url)) {
                refused += url.host
                throw IOException("blocked")
            }
            return chain.proceed(chain.request())
        }
    }

    /** Copies the Authorization value of the dashboard request only; never logs it. */
    private class TokenCapture : Interceptor {
        @Volatile var captured: String? = null
        @Volatile var dashboardRequests = 0

        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            if (request.method == "POST" && request.url.encodedPath == DASHBOARD_PATH) {
                dashboardRequests++
                captured = request.header("Authorization")
            }
            return chain.proceed(request)
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

    private class Recorder : Interceptor {
        val requests: MutableList<HttpUrl> = CopyOnWriteArrayList()
        override fun intercept(chain: Interceptor.Chain): Response {
            requests += chain.request().url
            return Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(ByteArray(0).toResponseBody(null)).build()
        }
    }

    private class Fixture(answer: DashboardStandIn.Answer) {
        val guard = OriginGuard()
        val capture = TokenCapture()
        val server = FakeEtebaseServer(APPROVED_ROOT)
        val client: OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .addInterceptor(guard)
            .addInterceptor(capture)
            .addInterceptor(DashboardStandIn(answer))
            .addInterceptor(server)
            .build()
    }

    /** Signs a synthetic user up with the real native client, saves the session, and restores it over [fixture]. */
    private fun restoredAccount(fixture: Fixture): com.etebase.client.Account {
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
        return com.etebase.client.Account.restore(com.etebase.client.Client.create(fixture.client, APPROVED_ROOT), session, null)
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
        val account = restoredAccount(fixture)
        val outcome = runCatching { account.fetchDashboardUrl() }
        assertTrue("HARNESS: a not_supported answer was not reported as a failure", outcome.isFailure)
        assertCapturedSyntheticToken(fixture)
    }

    @Test
    fun nativeDashboardRequestExposesTheTokenWhenTheServerReturnsAUrl() {
        val fixture = Fixture(DashboardStandIn.Answer.URL)
        val account = restoredAccount(fixture)
        val url = try {
            account.fetchDashboardUrl()
        } catch (e: Exception) {
            fail("JNI_PATH: fetchDashboardUrl failed on a well-formed answer (${e.javaClass.simpleName})")
            throw AssertionError()
        }
        assertEquals("HARNESS: the stand-in's dashboard URL did not come back", SYNTHETIC_DASHBOARD_URL, url)
        assertCapturedSyntheticToken(fixture)
    }

    /**
     * The stand-in answers above OkHttp's follow-up layer, so this checks that the native client
     * itself issues no request to the redirect target; OkHttp's own following is off by configuration.
     * The initial request is allowed and counted.
     */
    @Test
    fun nativeDashboardRedirectIsNotFollowedAnywhere() {
        val fixture = Fixture(DashboardStandIn.Answer.REDIRECT)
        assertFalse("HARNESS: redirects are enabled", fixture.client.followRedirects)
        assertFalse("HARNESS: TLS redirects are enabled", fixture.client.followSslRedirects)
        val account = restoredAccount(fixture)
        val outcome = runCatching { account.fetchDashboardUrl() }
        assertTrue("HARNESS: a redirect was reported as a dashboard URL", outcome.isFailure)
        assertEquals("HARNESS: the initial dashboard request was not made exactly once", 1, fixture.capture.dashboardRequests)
        assertEquals("HARNESS: a request reached the redirect target", 0, fixture.guard.attemptedHosts.count { it == REDIRECT_HOST })
        assertTrue("HARNESS: a request was refused, so something tried to leave the origin", fixture.guard.refused.isEmpty())
    }

    /** The guard alone, without JNI: every refused request is stopped before the next interceptor sees it. */
    @Test
    fun originGuardRefusesEveryOtherDestinationBeforeItProceeds() {
        val guard = OriginGuard()
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
    }

    /** The account-URI preflight alone: only the approved root origin passes, and debug remotes never do. */
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

        /** Scheme, exact host, effective port 443 and no user info: the planned transport guard. */
        fun approvedOrigin(url: HttpUrl): Boolean =
            url.scheme == "https" && url.host == APPROVED_HOST && url.port == 443 &&
                url.username.isEmpty() && url.password.isEmpty()

        /** The planned account-URI preflight: the guard's checks plus a root path, no query or fragment, no debug remote. */
        fun preflight(uri: String, debugRemote: String?): HttpUrl? {
            if (debugRemote != null) return null
            val raw = runCatching { URI(uri) }.getOrNull() ?: return null
            if (raw.rawAuthority != APPROVED_HOST && raw.rawAuthority != "$APPROVED_HOST:443") return null
            if (raw.rawQuery != null || raw.rawFragment != null) return null
            if (!raw.rawPath.isNullOrEmpty() && raw.rawPath != "/") return null
            val url = uri.toHttpUrlOrNull() ?: return null
            return url.takeIf { approvedOrigin(it) }
        }
    }
}
