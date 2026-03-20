/*
 * Copyright 2026 Silent Suite
 * Modified by Silent Suite
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

package io.silentsuite.sync.billing

import android.accounts.Account
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.Constants
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.utils.NotificationUtils
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.logging.Level

/**
 * Manages subscription status checks for SilentSuite accounts.
 *
 * Checks the billing API (GET /subscription) to determine if the user's
 * subscription allows sync. Results are cached both in-memory and to
 * SharedPreferences to avoid hitting the API on every sync cycle.
 *
 * Subscription states:
 * - trialing: Active trial, full sync allowed
 * - active: Paid and current, full sync allowed
 * - past_due: Payment failed but retrying, full sync allowed
 * - cancelled: Subscription ended, sync BLOCKED (read-only mode)
 * - expired: Subscription expired, sync BLOCKED (read-only mode)
 *
 * When the billing API is unreachable, sync is ALLOWED (optimistic mode)
 * to avoid breaking sync during development or temporary API outages.
 * After 24h of unreachable API with no cached status, a soft warning is shown.
 */
class BillingManager private constructor() {

    data class SubscriptionStatus(
        val status: String,
        val plan: String?,
        val billingInterval: String?,
        val renewalDate: String?,
        val trialDaysRemaining: Int?,
        val fetchedAt: Long = System.currentTimeMillis()
    ) {
        val isSyncAllowed: Boolean
            get() = status !in BLOCKED_STATES

        val isExpiredOrCancelled: Boolean
            get() = status in BLOCKED_STATES

        val isTrial: Boolean
            get() = status == "trialing"

        val isActive: Boolean
            get() = status == "active"

        val isPastDue: Boolean
            get() = status == "past_due"

        val isUnknown: Boolean
            get() = status == "unknown"

        val displayPlan: String
            get() = when (plan) {
                "personal" -> "Personal Plan"
                "founding" -> "Founding Member"
                "trial" -> "Trial"
                else -> plan?.replaceFirstChar { it.uppercase() } ?: "SilentSuite"
            }

        companion object {
            private val BLOCKED_STATES = setOf("cancelled", "expired")

            /** Default status when billing API is unreachable — allows sync (optimistic) */
            fun unreachable(): SubscriptionStatus = SubscriptionStatus(
                status = "unknown",
                plan = null,
                billingInterval = null,
                renewalDate = null,
                trialDaysRemaining = null
            )
        }
    }

    companion object {
        @Volatile
        private var instance: BillingManager? = null

        /** Cache TTL: 5 minutes for in-memory cache */
        private const val CACHE_TTL_MS = 5 * 60 * 1000L

        /** After 24h of failed billing checks, show a soft warning */
        private const val DEGRADED_MODE_THRESHOLD_MS = 24 * 60 * 60 * 1000L

        private const val PREFS_NAME = "billing_cache"
        private const val PREF_STATUS = "status"
        private const val PREF_PLAN = "plan"
        private const val PREF_BILLING_INTERVAL = "billing_interval"
        private const val PREF_RENEWAL_DATE = "renewal_date"
        private const val PREF_TRIAL_DAYS = "trial_days"
        private const val PREF_FETCHED_AT = "fetched_at"
        private const val PREF_LAST_SUCCESSFUL_FETCH = "last_successful_fetch"

        const val NOTIFICATION_SUBSCRIPTION_EXPIRED = 50

        /**
         * Base URL for the billing API.
         */
        const val BILLING_API_BASE_URL = "https://api.silentsuite.io"

        /** URL for subscription management / reactivation */
        const val BILLING_MANAGE_URL = "https://app.silentsuite.io/settings/billing"

        fun getInstance(): BillingManager {
            return instance ?: synchronized(this) {
                instance ?: BillingManager().also { instance = it }
            }
        }
    }

    /** Per-account in-memory subscription status cache */
    private val cache = ConcurrentHashMap<String, SubscriptionStatus>()

    /**
     * Check if sync is allowed for the given account.
     *
     * This is the main entry point called from SyncAdapterService.onPerformSync().
     *
     * @return true if sync should proceed, false if subscription is expired/cancelled
     */
    fun isSyncAllowed(context: Context, account: Account): Boolean {
        val status = getSubscriptionStatus(context, account)
        if (!status.isSyncAllowed) {
            Logger.log.info("Sync blocked for ${account.name}: subscription status is '${status.status}'")
            showExpiredNotification(context, account)
        } else {
            // Clear any previous expiry notification when subscription is good
            dismissExpiredNotification(context)
        }
        return status.isSyncAllowed
    }

    /**
     * Get the subscription status for an account, using cache when available.
     * Checks in-memory cache first, then persistent cache, then fetches from API.
     */
    fun getSubscriptionStatus(context: Context, account: Account): SubscriptionStatus {
        // 1. Check in-memory cache
        val cached = cache[account.name]
        val now = System.currentTimeMillis()

        if (cached != null && (now - cached.fetchedAt) < CACHE_TTL_MS) {
            Logger.log.fine("Using in-memory cached subscription status for ${account.name}: ${cached.status}")
            return cached
        }

        // 2. Fetch fresh from API
        val fresh = fetchSubscriptionStatus(context, account)
        cache[account.name] = fresh

        // 3. Persist to SharedPreferences if it's a real result (not unreachable)
        if (!fresh.isUnknown) {
            persistStatus(context, account.name, fresh)
        } else {
            // API unreachable — check persistent cache for degraded mode
            val persisted = loadPersistedStatus(context, account.name)
            if (persisted != null) {
                val lastSuccessfulFetch = getLastSuccessfulFetch(context, account.name)
                if (lastSuccessfulFetch > 0 && (now - lastSuccessfulFetch) > DEGRADED_MODE_THRESHOLD_MS) {
                    Logger.log.warning("Billing API unreachable for >24h for ${account.name}, using last known status: ${persisted.status}")
                    showDegradedModeWarning(context)
                }
                // Use persisted status (but with current timestamp for cache purposes)
                val withUpdatedTime = persisted.copy(fetchedAt = now)
                cache[account.name] = withUpdatedTime
                return withUpdatedTime
            }
        }

        return fresh
    }

    /**
     * Invalidate the cached subscription status for an account.
     * Call this when the user logs in, changes plan, or reactivates.
     */
    fun invalidateCache(context: Context, accountName: String) {
        cache.remove(accountName)
        val prefs = context.getSharedPreferences("${PREFS_NAME}_$accountName", Context.MODE_PRIVATE)
        prefs.edit().clear().apply()
    }

    // --- Persistent cache ---

    private fun persistStatus(context: Context, accountName: String, status: SubscriptionStatus) {
        val prefs = context.getSharedPreferences("${PREFS_NAME}_$accountName", Context.MODE_PRIVATE)
        prefs.edit()
            .putString(PREF_STATUS, status.status)
            .putString(PREF_PLAN, status.plan)
            .putString(PREF_BILLING_INTERVAL, status.billingInterval)
            .putString(PREF_RENEWAL_DATE, status.renewalDate)
            .putInt(PREF_TRIAL_DAYS, status.trialDaysRemaining ?: -1)
            .putLong(PREF_FETCHED_AT, status.fetchedAt)
            .putLong(PREF_LAST_SUCCESSFUL_FETCH, status.fetchedAt)
            .apply()
    }

    private fun loadPersistedStatus(context: Context, accountName: String): SubscriptionStatus? {
        val prefs = context.getSharedPreferences("${PREFS_NAME}_$accountName", Context.MODE_PRIVATE)
        val status = prefs.getString(PREF_STATUS, null) ?: return null
        val trialDays = prefs.getInt(PREF_TRIAL_DAYS, -1)
        return SubscriptionStatus(
            status = status,
            plan = prefs.getString(PREF_PLAN, null),
            billingInterval = prefs.getString(PREF_BILLING_INTERVAL, null),
            renewalDate = prefs.getString(PREF_RENEWAL_DATE, null),
            trialDaysRemaining = if (trialDays >= 0) trialDays else null,
            fetchedAt = prefs.getLong(PREF_FETCHED_AT, 0)
        )
    }

    private fun getLastSuccessfulFetch(context: Context, accountName: String): Long {
        val prefs = context.getSharedPreferences("${PREFS_NAME}_$accountName", Context.MODE_PRIVATE)
        return prefs.getLong(PREF_LAST_SUCCESSFUL_FETCH, 0)
    }

    // --- Notifications ---

    /**
     * Show a persistent notification when subscription is expired/cancelled.
     * Tapping opens the billing management page in the browser.
     */
    private fun showExpiredNotification(context: Context, account: Account) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(BILLING_MANAGE_URL))
        val pendingIntent = PendingIntent.getActivity(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationUtils.newBuilder(context, NotificationUtils.CHANNEL_SYNC_ERRORS)
            .setSmallIcon(R.drawable.ic_error_light)
            .setContentTitle(context.getString(R.string.subscription_expired_message))
            .setContentText(context.getString(R.string.subscription_reactivate))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setOngoing(false)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()

        NotificationManagerCompat.from(context)
            .notify(NOTIFICATION_SUBSCRIPTION_EXPIRED, notification)
    }

    private fun dismissExpiredNotification(context: Context) {
        NotificationManagerCompat.from(context)
            .cancel(NOTIFICATION_SUBSCRIPTION_EXPIRED)
    }

    private fun showDegradedModeWarning(context: Context) {
        val notification = NotificationUtils.newBuilder(context, NotificationUtils.CHANNEL_SYNC_STATUS)
            .setSmallIcon(R.drawable.ic_sync_dark)
            .setContentTitle("SilentSuite")
            .setContentText("Unable to verify subscription — sync continues")
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()

        NotificationManagerCompat.from(context)
            .notify("degraded_billing", Constants.NOTIFICATION_ACCOUNT_UPDATE, notification)
    }

    // --- API fetch ---

    /**
     * Fetch subscription status from the billing API.
     */
    private fun fetchSubscriptionStatus(context: Context, account: Account): SubscriptionStatus {
        try {
            val settings = AccountSettings(context, account)

            // Self-hosted users or accounts without Etebase sessions skip billing check
            if (settings.etebaseSession == null) {
                Logger.log.fine("No Etebase session for ${account.name}, skipping billing check")
                return SubscriptionStatus.unreachable()
            }

            val httpClient = HttpClient.Builder(context, settings).build()
            val request = Request.Builder()
                .url("$BILLING_API_BASE_URL/subscription")
                .header("Authorization", "Token ${settings.etebaseSession}")
                .get()
                .build()

            val response = httpClient.okHttpClient.newCall(request).execute()
            response.use {
                if (!it.isSuccessful) {
                    Logger.log.warning("Billing API returned ${it.code} for ${account.name}, allowing sync (optimistic)")
                    return SubscriptionStatus.unreachable()
                }

                val body = it.body?.string() ?: return SubscriptionStatus.unreachable()
                return parseSubscriptionResponse(body)
            }
        } catch (e: Exception) {
            Logger.log.log(Level.WARNING, "Failed to check subscription status for ${account.name}, allowing sync", e)
            return SubscriptionStatus.unreachable()
        }
    }

    /**
     * Parse the JSON response from GET /subscription.
     *
     * Expected format:
     * {
     *   "subscriptionStatus": "active",
     *   "plan": "personal",
     *   "billingInterval": "monthly",
     *   "renewalDate": "2026-04-13T00:00:00Z",
     *   "trialDaysRemaining": null
     * }
     */
    private fun parseSubscriptionResponse(json: String): SubscriptionStatus {
        val obj = JSONObject(json)
        return SubscriptionStatus(
            status = obj.optString("subscriptionStatus", "unknown"),
            plan = obj.optString("plan", null),
            billingInterval = obj.optString("billingInterval", null),
            renewalDate = obj.optString("renewalDate", null),
            trialDaysRemaining = if (obj.has("trialDaysRemaining") && !obj.isNull("trialDaysRemaining"))
                obj.getInt("trialDaysRemaining") else null
        )
    }
}
