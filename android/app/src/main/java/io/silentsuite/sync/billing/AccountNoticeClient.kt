/*
 * Copyright 2026 Silent Suite
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

package io.silentsuite.sync.billing

import android.accounts.Account
import android.content.Context
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.BuildConfig
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.log.Logger
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.time.Instant

/**
 * Reads the informational subscription notice of a hosted account (plan v2 §4.3, v3 A3).
 *
 * Only an account on exactly https://server.silentsuite.io/ is read; every other account is
 * answered locally with "no notice" before any session restore or network use. The Etebase token is
 * read in memory, from the native client's own dashboard request, by a guarded transport that only
 * reaches that origin; it is sent back only to that origin to issue a one-time status proof. Billing
 * receives that proof alone: no Etebase token, cookie or sync data.
 *
 * The result is informational. It never reaches [BillingManager]'s cache, preferences or sync
 * eligibility. Outcomes are logged as fixed codes only.
 */
object AccountNoticeClient {
    internal const val ETEBASE_HOST = "server.silentsuite.io"
    internal const val ETEBASE_ROOT = "https://server.silentsuite.io/"
    internal const val BILLING_HOST = "api.silentsuite.io"
    internal const val DASHBOARD_PATH = "/api/v1/authentication/dashboard_url/"
    internal const val STATUS_PROOF_PATH = "/api/v1/billing/status-proof/"
    internal const val SUMMARY_PATH = "/subscription/summary"
    internal const val SUMMARY_URL = "https://api.silentsuite.io/subscription/summary"

    private val TOKEN_HEADER = Regex("^Token [A-Za-z0-9_-]{1,512}$")
    private val JSON = "application/json".toMediaType()

    /** Fixed, content-free outcome codes; the only thing ever logged. */
    enum class Outcome { OK, NOT_HOSTED, NO_SESSION, NO_TOKEN, UNSUPPORTED, UNAVAILABLE, PARSE }

    /** Scheme, exact host, effective port 443 and no user info. */
    internal fun approvedOrigin(url: HttpUrl, host: String): Boolean =
        url.scheme == "https" && url.host == host && url.port == 443 &&
            url.username.isEmpty() && url.password.isEmpty()

    /** The account-URI preflight: the approved root origin only, never on a debug-remote build. */
    internal fun preflight(uri: String?, debugRemote: String?): HttpUrl? {
        if (debugRemote != null || uri == null) return null
        val raw = try {
            URI(uri)
        } catch (e: Exception) {
            return null
        }
        if (raw.rawAuthority != ETEBASE_HOST && raw.rawAuthority != "$ETEBASE_HOST:443") return null
        if (raw.rawQuery != null || raw.rawFragment != null) return null
        if (!raw.rawPath.isNullOrEmpty() && raw.rawPath != "/") return null
        val url = uri.toHttpUrlOrNull() ?: return null
        return url.takeIf { approvedOrigin(it, ETEBASE_HOST) }
    }

    /**
     * Refuses, before `proceed`, any request outside [host] or carrying a cookie; with [paths], any
     * other path; with [forbidAuthorization], any Authorization header.
     */
    internal class OriginGuard(
        private val host: String,
        private val paths: Set<String>? = null,
        private val forbidAuthorization: Boolean = false,
    ) : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            if (!approvedOrigin(request.url, host) ||
                (paths != null && request.url.encodedPath !in paths) ||
                request.header("Cookie") != null ||
                (forbidAuthorization && request.header("Authorization") != null)) {
                throw IOException("blocked")
            }
            return chain.proceed(request)
        }
    }

    /** Copies the Authorization value of the native dashboard request only, into this instance. */
    internal class TokenCapture : Interceptor {
        @Volatile private var value: String? = null

        val captured: String? get() = value

        fun clear() {
            value = null
        }

        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            if (request.method == "POST" && request.url.encodedPath == DASHBOARD_PATH) {
                request.header("Authorization")?.takeIf { TOKEN_HEADER.matches(it) }?.let { value = it }
            }
            return chain.proceed(request)
        }
    }

    private fun OkHttpClient.Builder.isolated(): OkHttpClient.Builder = apply {
        interceptors().clear()
        networkInterceptors().clear()
        cookieJar(CookieJar.NO_COOKIES)
        cache(null)
        followRedirects(false)
        followSslRedirects(false)
        retryOnConnectionFailure(false)
    }

    /** The only transport that may carry the Etebase token: guard first, then capture. */
    internal fun etebaseTransport(base: OkHttpClient, capture: TokenCapture): OkHttpClient =
        base.newBuilder().isolated()
            .addInterceptor(OriginGuard(ETEBASE_HOST))
            .addInterceptor(capture)
            .build()

    /** Billing's transport: one path, no Authorization, no cookies. */
    internal fun billingTransport(base: OkHttpClient): OkHttpClient =
        base.newBuilder().isolated()
            .addInterceptor(OriginGuard(BILLING_HOST, setOf(SUMMARY_PATH), forbidAuthorization = true))
            .build()

    /**
     * The informational notice as a display-only [BillingManager.SubscriptionStatus]:
     * [BillingManager.SubscriptionStatus.unreachable] when there is nothing to show, null when it
     * could not be read.
     */
    fun load(context: Context, account: Account): BillingManager.SubscriptionStatus? {
        val settings = try {
            AccountSettings(context, account)
        } catch (e: Exception) {
            return log(Outcome.UNAVAILABLE, null)
        }
        preflight(settings.uri?.toString(), BuildConfig.DEBUG_REMOTE_URL)
            ?: return log(Outcome.NOT_HOSTED, BillingManager.SubscriptionStatus.unreachable())
        val session = settings.etebaseSession ?: return log(Outcome.NO_SESSION, null)
        val capture = TokenCapture()
        val (outcome, status) = requestNotice(
            session,
            etebaseTransport(HttpClient.sharedClient, capture),
            capture,
            billingTransport(HttpClient.sharedClient),
        )
        return log(outcome, status)
    }

    private fun log(outcome: Outcome, status: BillingManager.SubscriptionStatus?): BillingManager.SubscriptionStatus? {
        Logger.log.fine("Subscription notice outcome: $outcome")
        return status
    }

    /**
     * Restores [session] over [etebase], lets the native client make its dashboard request (its
     * result or error is ignored), then requires the captured header, issues one status proof on the
     * same origin and exchanges it at Billing over [billing]. Never falls back to a login proof or
     * bearer. The captured header and the proof are dropped before returning.
     */
    internal fun requestNotice(
        session: String,
        etebase: OkHttpClient,
        capture: TokenCapture,
        billing: OkHttpClient,
    ): Pair<Outcome, BillingManager.SubscriptionStatus?> {
        try {
            val account = com.etebase.client.Account.restore(
                com.etebase.client.Client.create(etebase, ETEBASE_ROOT), session, null)
            try {
                account.fetchDashboardUrl()
            } catch (e: Exception) {
                // Only the request matters; the dashboard answer is not used.
            }
            val header = capture.captured ?: return Outcome.NO_TOKEN to null
            val issue = Request.Builder()
                .url(ETEBASE_ROOT + STATUS_PROOF_PATH.removePrefix("/"))
                .header("Authorization", header)
                .post(ByteArray(0).toRequestBody(null))
                .build()
            val proof = etebase.newCall(issue).execute().use { response ->
                when {
                    response.code == 404 -> return Outcome.UNSUPPORTED to null
                    response.code != 200 -> return Outcome.UNAVAILABLE to null
                    else -> parseStatusProof(response.body?.string()) ?: return Outcome.PARSE to null
                }
            }
            val body = JSONObject().put("contractVersion", 1).put("statusProof", proof).toString()
            val summary = Request.Builder().url(SUMMARY_URL).post(body.toRequestBody(JSON)).build()
            return billing.newCall(summary).execute().use { response ->
                when {
                    response.code == 404 || response.code == 503 -> Outcome.UNSUPPORTED to null
                    response.code != 200 -> Outcome.UNAVAILABLE to null
                    else -> parseSummary(response.body?.string())?.let { Outcome.OK to it } ?: (Outcome.PARSE to null)
                }
            }
        } catch (e: Exception) {
            return Outcome.UNAVAILABLE to null
        } finally {
            // The proof is local to this call and goes out of scope here.
            capture.clear()
        }
    }

    private fun exactKeys(json: JSONObject, keys: Set<String>): Boolean =
        json.length() == keys.size && keys.all { json.has(it) }

    private fun isoInstant(value: Any?): String? =
        (value as? String)?.takeIf { runCatching { Instant.parse(it) }.isSuccess }

    internal fun parseStatusProof(body: String?): String? {
        val json = runCatching { JSONObject(body ?: return null) }.getOrNull() ?: return null
        if (!exactKeys(json, setOf("statusProof"))) return null
        return (json.opt("statusProof") as? String)?.takeIf { it.length in 43..256 }
    }

    /**
     * Strict contract-version-1 summary parser. A null notice is "nothing to show"
     * ([BillingManager.SubscriptionStatus.unreachable]); anything malformed or unknown is null.
     */
    internal fun parseSummary(body: String?): BillingManager.SubscriptionStatus? {
        val json = runCatching { JSONObject(body ?: return null) }.getOrNull() ?: return null
        if (!exactKeys(json, setOf("contractVersion", "notice"))) return null
        if (json.opt("contractVersion") != 1) return null
        val notice = json.opt("notice")
        if (notice == JSONObject.NULL) return BillingManager.SubscriptionStatus.unreachable()
        if (notice !is JSONObject) return null
        return when (notice.opt("kind")) {
            "trial_days_left" -> {
                if (!exactKeys(notice, setOf("kind", "trialEndsAt", "daysRemaining"))) return null
                val endsAt = isoInstant(notice.opt("trialEndsAt")) ?: return null
                val days = (notice.opt("daysRemaining") as? Int)?.takeIf { it >= 1 } ?: return null
                BillingManager.SubscriptionStatus("trialing", "trial", null, endsAt, days)
            }
            "trial_ended" -> {
                if (!exactKeys(notice, setOf("kind", "endedAt"))) return null
                val endedAt = isoInstant(notice.opt("endedAt")) ?: return null
                BillingManager.SubscriptionStatus("expired", "trial", null, endedAt, null)
            }
            "access_ended" -> {
                if (!exactKeys(notice, setOf("kind", "endedAt"))) return null
                val raw = notice.opt("endedAt")
                val endedAt = if (raw == JSONObject.NULL) null else isoInstant(raw) ?: return null
                BillingManager.SubscriptionStatus("expired", null, null, endedAt, null)
            }
            else -> null
        }
    }
}
