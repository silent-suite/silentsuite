package io.silentsuite.sync.ui.report

import io.silentsuite.sync.syncadapter.SyncStatusStore
import java.net.URI

/**
 * Builds the "Report a problem" payload, schema 1 (`contracts/problem-report.schema.json`).
 *
 * Plain Kotlin with no Android framework calls, so JVM tests run the real builder and serializer.
 * Diagnostics hold only allowlisted enum values, a filtered version name and clamped counts: never
 * account names, server addresses, collection data, exception text or device identifiers.
 */
object ProblemReport {
    const val ENDPOINT = "https://report.silentsuite.io/v1/reports"
    const val SUPPORT_EMAIL = "support@silentsuite.io"
    const val PRIVACY_POLICY_URL = "https://silentsuite.io/privacy"

    const val MAX_SUMMARY_CHARS = 120
    const val MAX_SUMMARY_BYTES = 480
    const val MAX_DESCRIPTION_CHARS = 4000
    const val MAX_DESCRIPTION_BYTES = 16000
    const val MAX_CONTACT_CHARS = 254
    const val MAX_BODY_BYTES = 32 * 1024
    private const val MAX_VERSION_NAME_LENGTH = 32
    private const val MAX_VERSION_CODE = 99_999_999
    private const val MAX_COUNT = 999
    private const val MAX_ERROR_CODES = 10
    private const val HOUR_MILLIS = 3_600_000L

    private val CONTACT_EMAIL = Regex("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,189}$")

    /** Output order of error codes; the same finite list as the schema's `androidErrorCode`. */
    private val ERROR_CODE_ORDER = listOf(
        "network", "authentication", "permission", "provider", "storage", "configuration",
        "setup_required", "parent_refresh", "child_removed", "interrupted", "unknown",
        "startup_failed", "other",
    )

    enum class Kind(val wire: String) { PROBLEM("problem"), FEATURE("feature") }
    enum class Field { SUMMARY, DESCRIPTION, CONTACT_EMAIL, BODY }
    enum class Problem { REQUIRED, TOO_LONG, CONTROL_CHARACTER, INVALID }

    class InvalidReport(val field: Field, val problem: Problem) :
        IllegalArgumentException("${field.name}: ${problem.name}")

    enum class StartupOutcome(val wire: String) {
        SUCCEEDED("succeeded"), FAILED("failed"), NOT_RECORDED("not_recorded")
    }

    /** One account reduced to a hosted/custom flag and its per-service sync evidence. No name, no URL. */
    data class AccountState(val customServer: Boolean, val statuses: List<SyncStatusStore.Status>)

    data class DiagnosticsInput(
        val versionName: String,
        val versionCode: Int,
        val androidSdk: Int,
        val accounts: List<AccountState>,
        val startupOutcome: StartupOutcome,
        val nowMillis: Long,
    )

    /**
     * The diagnostics object as the exact JSON text that is shown in the preview and embedded
     * unchanged in the sent body. Indented so the preview is readable; whitespace is valid JSON.
     */
    fun diagnosticsJson(input: DiagnosticsInput): String {
        val statuses = input.accounts.flatMap { it.statuses }
        val failing = statuses.filter(::isFailing)
        val syncStatus = when {
            input.accounts.isEmpty() -> "unknown"
            statuses.any { it.activeAttemptId != null || it.activeRequestId != null } -> "syncing"
            failing.isNotEmpty() ->
                if (failing.all { failureCode(it) == "network" }) "offline" else "error"
            statuses.any { it.lastSuccessAt != null } -> "synced"
            else -> "unknown"
        }
        val latestSuccess = statuses.mapNotNull { it.lastSuccessAt }.maxOrNull()
        val lastSuccess = when {
            latestSuccess == null -> if (input.accounts.isEmpty()) "unknown" else "never"
            else -> {
                val age = (input.nowMillis - latestSuccess).coerceAtLeast(0)
                when {
                    age < HOUR_MILLIS -> "under_1h"
                    age < 24 * HOUR_MILLIS -> "under_1d"
                    age < 7 * 24 * HOUR_MILLIS -> "under_7d"
                    else -> "over_7d"
                }
            }
        }
        val codes = failing.mapTo(mutableSetOf(), ::failureCode)
        if (input.startupOutcome == StartupOutcome.FAILED) codes += "startup_failed"
        val errorCodes = ERROR_CODE_ORDER.filter { it in codes }.take(MAX_ERROR_CODES)
        val server = if (input.accounts.any { it.customServer }) "custom" else "hosted"

        return buildString {
            append("{\n")
            append("  \"app_version\": ").append(quote(safeVersionName(input.versionName))).append(",\n")
            append("  \"platform\": ").append(quote("android-${input.androidSdk.coerceAtLeast(0)}")).append(",\n")
            append("  \"server\": ").append(quote(server)).append(",\n")
            append("  \"sync_status\": ").append(quote(syncStatus)).append(",\n")
            append("  \"last_success\": ").append(quote(lastSuccess)).append(",\n")
            append("  \"error_codes\": [").append(errorCodes.joinToString(", ", transform = ::quote)).append("],\n")
            append("  \"fields\": {\n")
            append("    \"version_code\": ").append(input.versionCode.coerceIn(0, MAX_VERSION_CODE)).append(",\n")
            append("    \"accounts\": ").append(input.accounts.size.coerceIn(0, MAX_COUNT)).append(",\n")
            append("    \"startup_outcome\": ").append(quote(input.startupOutcome.wire)).append("\n")
            append("  }\n")
            append("}")
        }
    }

    /**
     * Validates the user's text and returns the exact UTF-8 JSON body to send.
     * [diagnosticsJson] must be the frozen output of [diagnosticsJson], or null when the box is unticked.
     */
    fun build(
        kind: Kind,
        summary: String,
        description: String,
        contactEmail: String,
        diagnosticsJson: String?,
    ): String {
        val cleanSummary = cleanText(summary, Field.SUMMARY, MAX_SUMMARY_CHARS, MAX_SUMMARY_BYTES)
        val cleanDescription = cleanText(description, Field.DESCRIPTION, MAX_DESCRIPTION_CHARS, MAX_DESCRIPTION_BYTES)
        val contact = cleanContact(contactEmail)
        val body = buildString {
            append("{\"schema\":1")
            append(",\"kind\":").append(quote(kind.wire))
            append(",\"surface\":\"android\"")
            append(",\"summary\":").append(quote(cleanSummary))
            append(",\"description\":").append(quote(cleanDescription))
            if (contact != null) append(",\"contact_email\":").append(quote(contact))
            if (diagnosticsJson != null) append(",\"diagnostics\":").append(diagnosticsJson)
            append('}')
        }
        if (body.toByteArray(Charsets.UTF_8).size > MAX_BODY_BYTES) throw InvalidReport(Field.BODY, Problem.TOO_LONG)
        return body
    }

    /** Subject for "Email instead"; the text is not validated because nothing goes through the relay. */
    fun emailSubject(kind: Kind, summary: String): String =
        (if (kind == Kind.PROBLEM) "Problem report: " else "Feature request: ") + normalize(summary)

    /** Body for "Email instead" and, after the subject, for Copy. */
    fun emailBody(description: String, diagnosticsJson: String?): String = buildString {
        append(normalize(description))
        if (diagnosticsJson != null) append("\n\nDiagnostic info:\n").append(diagnosticsJson)
    }

    /** True when the account's stored server URI is not the built-in hosted service. */
    fun isCustomServer(accountUri: String?, hostedUri: String): Boolean {
        // Accounts without a stored URI use the built-in hosted server (Constants.etebaseServiceUrl).
        if (accountUri == null) return false
        val account = try {
            URI(accountUri)
        } catch (_: Exception) {
            return true
        }
        val hosted = URI(hostedUri)
        return !(account.scheme.equals(hosted.scheme, ignoreCase = true) &&
            account.host.equals(hosted.host, ignoreCase = true) &&
            effectivePort(account) == effectivePort(hosted))
    }

    /** Same filtering as StartupDiagnosticReport.safeVersionName, kept here so startup code stays untouched. */
    internal fun safeVersionName(raw: String): String =
        raw.filter { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it in "._+-" }
            .take(MAX_VERSION_NAME_LENGTH)
            .ifEmpty { "unknown" }

    /** Explicit table: a category added later fails compilation here instead of leaking a name. */
    internal fun errorCode(category: SyncStatusStore.FailureCategory?): String = when (category) {
        SyncStatusStore.FailureCategory.NETWORK -> "network"
        SyncStatusStore.FailureCategory.AUTHENTICATION -> "authentication"
        SyncStatusStore.FailureCategory.PERMISSION -> "permission"
        SyncStatusStore.FailureCategory.PROVIDER -> "provider"
        SyncStatusStore.FailureCategory.STORAGE -> "storage"
        SyncStatusStore.FailureCategory.CONFIGURATION -> "configuration"
        SyncStatusStore.FailureCategory.SETUP_REQUIRED -> "setup_required"
        SyncStatusStore.FailureCategory.PARENT_REFRESH -> "parent_refresh"
        SyncStatusStore.FailureCategory.CHILD_REMOVED -> "child_removed"
        SyncStatusStore.FailureCategory.UNKNOWN -> "unknown"
        SyncStatusStore.FailureCategory.INTERRUPTED -> "interrupted"
        null -> "other"
    }

    internal fun normalize(raw: String): String = raw.replace("\r\n", "\n").trim()

    private fun cleanText(raw: String, field: Field, maxChars: Int, maxBytes: Int): String {
        val text = normalize(raw)
        if (text.isEmpty()) throw InvalidReport(field, Problem.REQUIRED)
        checkCharacters(text, field)
        if (text.codePointCount(0, text.length) > maxChars || text.toByteArray(Charsets.UTF_8).size > maxBytes)
            throw InvalidReport(field, Problem.TOO_LONG)
        return text
    }

    /** C0/C1 controls other than tab and newline are refused; so are unpaired surrogates. */
    private fun checkCharacters(text: String, field: Field) {
        var i = 0
        while (i < text.length) {
            val ch = text[i]
            if (Character.isHighSurrogate(ch)) {
                if (i + 1 >= text.length || !Character.isLowSurrogate(text[i + 1])) throw InvalidReport(field, Problem.INVALID)
                i += 2
                continue
            }
            if (Character.isLowSurrogate(ch)) throw InvalidReport(field, Problem.INVALID)
            if ((ch < ' ' && ch != '\n' && ch != '\t') || ch in '\u007f'..'\u009f')
                throw InvalidReport(field, Problem.CONTROL_CHARACTER)
            i++
        }
    }

    private fun cleanContact(raw: String): String? {
        val email = raw.trim()
        if (email.isEmpty()) return null
        if (email.length > MAX_CONTACT_CHARS || !CONTACT_EMAIL.matches(email))
            throw InvalidReport(Field.CONTACT_EMAIL, Problem.INVALID)
        return email
    }

    private fun isFailing(status: SyncStatusStore.Status) = status.structuralStorageFailure || latestIsFailure(status)

    private fun failureCode(status: SyncStatusStore.Status) =
        if (status.structuralStorageFailure) "storage" else errorCode(status.lastFailureCategory)

    // Same precedence as the account dashboard's latestIsFailure.
    private fun latestIsFailure(status: SyncStatusStore.Status): Boolean {
        val failureAt = status.lastFailureAt ?: return false
        return when (status.lastTerminalResult) {
            SyncStatusStore.TerminalResult.FAILURE -> true
            SyncStatusStore.TerminalResult.SUCCESS -> false
            null -> failureAt >= (status.lastSuccessAt ?: Long.MIN_VALUE)
        }
    }

    private fun effectivePort(uri: URI): Int = when {
        uri.port != -1 -> uri.port
        uri.scheme.equals("https", ignoreCase = true) -> 443
        uri.scheme.equals("http", ignoreCase = true) -> 80
        else -> -1
    }

    /** JSON string literal without ASCII escaping: only quote, backslash and control characters are escaped. */
    private fun quote(value: String): String = buildString(value.length + 2) {
        append('"')
        for (ch in value) {
            when (ch) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\t' -> append("\\t")
                else -> if (ch < ' ') append("\\u").append(ch.code.toString(16).padStart(4, '0')) else append(ch)
            }
        }
        append('"')
    }
}
