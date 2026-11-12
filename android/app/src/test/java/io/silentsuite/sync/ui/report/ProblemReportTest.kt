package io.silentsuite.sync.ui.report

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.syncadapter.SyncStatusStore.FailureCategory
import io.silentsuite.sync.ui.report.ProblemReport.AccountState
import io.silentsuite.sync.ui.report.ProblemReport.DiagnosticsInput
import io.silentsuite.sync.ui.report.ProblemReport.Field
import io.silentsuite.sync.ui.report.ProblemReport.InvalidReport
import io.silentsuite.sync.ui.report.ProblemReport.Kind
import io.silentsuite.sync.ui.report.ProblemReport.Problem
import io.silentsuite.sync.ui.report.ProblemReport.StartupOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ProblemReportTest {
    private val now = 1_800_000_000_000L
    private val hour = 3_600_000L
    private val hosted = "https://server.silentsuite.io/"

    private fun input(
        accounts: List<AccountState> = listOf(AccountState(false, listOf(SyncStatusStore.Status(lastSuccessAt = now - 1000)))),
        startup: StartupOutcome = StartupOutcome.SUCCEEDED,
        versionName: String = "0.5.18-beta",
    ) = DiagnosticsInput(versionName, 5018, 34, accounts, startup, now)

    private fun parse(json: String): JsonObject = JsonParser().parse(json).asJsonObject
    private fun keys(obj: JsonObject) = obj.entrySet().map { it.key }.toSet()
    private fun diagnostics(input: DiagnosticsInput) = parse(ProblemReport.diagnosticsJson(input))
    private fun codes(obj: JsonObject) = obj.getAsJsonArray("error_codes").map(JsonElement::getAsString)

    private fun expectInvalid(field: Field, problem: Problem, block: () -> Unit) {
        try {
            block()
            fail("expected $field $problem")
        } catch (e: InvalidReport) {
            assertEquals(field, e.field)
            assertEquals(problem, e.problem)
        }
    }

    private fun build(summary: String = "Sync stops", description: String = "Details", contact: String = "",
                      diagnostics: String? = null, kind: Kind = Kind.PROBLEM) =
        ProblemReport.build(kind, summary, description, contact, diagnostics)

    @Test
    fun payloadHasOnlyTheSchemaKeysAndAllowlistedDiagnostics() {
        val preview = ProblemReport.diagnosticsJson(input())
        val body = parse(build(contact = "me@example.org", diagnostics = preview))
        assertEquals(setOf("schema", "kind", "surface", "summary", "description", "contact_email", "diagnostics"), keys(body))
        assertEquals(1, body.get("schema").asInt)
        assertEquals("problem", body.get("kind").asString)
        assertEquals("android", body.get("surface").asString)
        val diagnostics = body.getAsJsonObject("diagnostics")
        assertEquals(setOf("app_version", "platform", "server", "sync_status", "last_success", "error_codes", "fields"),
            keys(diagnostics))
        assertEquals(setOf("version_code", "accounts", "startup_outcome"), keys(diagnostics.getAsJsonObject("fields")))
        assertEquals("0.5.18-beta", diagnostics.get("app_version").asString)
        assertEquals("android-34", diagnostics.get("platform").asString)
        assertEquals("hosted", diagnostics.get("server").asString)
        assertEquals("synced", diagnostics.get("sync_status").asString)
        assertEquals("under_1h", diagnostics.get("last_success").asString)
        assertEquals(emptyList<String>(), codes(diagnostics))
        assertEquals(5018, diagnostics.getAsJsonObject("fields").get("version_code").asInt)
        assertEquals(1, diagnostics.getAsJsonObject("fields").get("accounts").asInt)
        assertEquals("succeeded", diagnostics.getAsJsonObject("fields").get("startup_outcome").asString)
    }

    @Test
    fun withoutDiagnosticsOrContactThoseKeysAreAbsent() {
        val body = parse(build(kind = Kind.FEATURE))
        assertEquals(setOf("schema", "kind", "surface", "summary", "description"), keys(body))
        assertEquals("feature", body.get("kind").asString)
    }

    @Test
    fun previewTextIsEmbeddedByteForByte() {
        val preview = ProblemReport.diagnosticsJson(input())
        val body = build(diagnostics = preview)
        assertTrue(body.endsWith(",\"diagnostics\":$preview}"))
        assertEquals(parse(preview).toString(), parse(body).getAsJsonObject("diagnostics").toString())
    }

    @Test
    fun identifierShapedPrivateValuesNeverReachThePayload() {
        val custom = "https://private-meeting-title.example.org:8443/Private_Meeting_Title/"
        val account = AccountState(
            ProblemReport.isCustomServer(custom, hosted),
            listOf(SyncStatusStore.Status(lastFailureAt = now, lastFailureCategory = null)),
        )
        val preview = ProblemReport.diagnosticsJson(input(listOf(account), versionName = "Private_Meeting_Title <x>"))
        val body = build(diagnostics = preview)
        listOf("Private_Meeting_Title", "private-meeting-title", "example.org", "8443", "<x>").forEach {
            assertFalse(it, body.contains(it))
        }
        val diagnostics = parse(preview)
        assertEquals("custom", diagnostics.get("server").asString)
        assertEquals("PrivateMeetingTitlex", diagnostics.get("app_version").asString)
        // A failure without a known category is reported as "other", never by any name.
        assertEquals(listOf("other"), codes(diagnostics))
    }

    @Test
    fun everyFailureCategoryMapsIntoTheSchemaEnum() {
        val schema = parse(File("../../contracts/problem-report.schema.json").readText())
        val allowed = schema.getAsJsonObject("\$defs").getAsJsonObject("androidErrorCode").getAsJsonArray("enum")
            .map(JsonElement::getAsString).toSet()
        FailureCategory.values().forEach { assertTrue(it.name, ProblemReport.errorCode(it) in allowed) }
        assertEquals("other", ProblemReport.errorCode(null))
        assertTrue("startup_failed" in allowed)
        val all = FailureCategory.values().map {
            AccountState(false, listOf(SyncStatusStore.Status(lastFailureAt = now, lastFailureCategory = it)))
        }
        val reported = codes(diagnostics(input(all, StartupOutcome.FAILED)))
        assertTrue(reported.size <= 10)
        assertEquals(reported.distinct(), reported)
        assertTrue(reported.all { it in allowed })
    }

    @Test
    fun syncStatusAndLastSuccessUseOnlyTheirEnums() {
        fun status(vararg statuses: SyncStatusStore.Status) = diagnostics(input(listOf(AccountState(false, statuses.toList()))))
        assertEquals("unknown", diagnostics(input(emptyList())).get("sync_status").asString)
        assertEquals("unknown", diagnostics(input(emptyList())).get("last_success").asString)
        assertEquals("never", status(SyncStatusStore.Status()).get("last_success").asString)
        assertEquals("unknown", status(SyncStatusStore.Status()).get("sync_status").asString)
        assertEquals("syncing", status(SyncStatusStore.Status(activeAttemptId = "a")).get("sync_status").asString)
        assertEquals("offline", status(SyncStatusStore.Status(lastSuccessAt = now - 2 * hour, lastFailureAt = now,
            lastFailureCategory = FailureCategory.NETWORK)).get("sync_status").asString)
        val error = status(
            SyncStatusStore.Status(lastFailureAt = now, lastFailureCategory = FailureCategory.NETWORK),
            SyncStatusStore.Status(lastFailureAt = now, lastFailureCategory = FailureCategory.AUTHENTICATION),
        )
        assertEquals("error", error.get("sync_status").asString)
        assertEquals(listOf("network", "authentication"), codes(error))
        // A later success clears the earlier failure.
        val recovered = status(SyncStatusStore.Status(lastSuccessAt = now - 5 * hour, lastFailureAt = now - 6 * hour,
            lastFailureCategory = FailureCategory.NETWORK))
        assertEquals("synced", recovered.get("sync_status").asString)
        assertEquals("under_1d", recovered.get("last_success").asString)
        assertEquals(emptyList<String>(), codes(recovered))
        assertEquals("storage", codes(status(SyncStatusStore.Status(structuralStorageFailure = true))).single())
        assertEquals("under_7d", status(SyncStatusStore.Status(lastSuccessAt = now - 48 * hour)).get("last_success").asString)
        assertEquals("over_7d", status(SyncStatusStore.Status(lastSuccessAt = now - 200 * hour)).get("last_success").asString)
        assertEquals("startup_failed", codes(diagnostics(input(startup = StartupOutcome.FAILED))).single())
        assertEquals("not_recorded", diagnostics(input(startup = StartupOutcome.NOT_RECORDED))
            .getAsJsonObject("fields").get("startup_outcome").asString)
    }

    @Test
    fun countsAndVersionsAreClampedAndFiltered() {
        val many = List(1200) { AccountState(false, emptyList()) }
        val clamped = parse(ProblemReport.diagnosticsJson(DiagnosticsInput("", -5, -1, many, StartupOutcome.NOT_RECORDED, now)))
        assertEquals(999, clamped.getAsJsonObject("fields").get("accounts").asInt)
        assertEquals(0, clamped.getAsJsonObject("fields").get("version_code").asInt)
        assertEquals("unknown", clamped.get("app_version").asString)
        assertEquals("android-0", clamped.get("platform").asString)
        assertEquals(32, ProblemReport.safeVersionName("1".repeat(100)).length)
    }

    @Test
    fun customServerIsAFlagFromTheStoredUri() {
        assertFalse(ProblemReport.isCustomServer(null, hosted))
        assertFalse(ProblemReport.isCustomServer("https://server.silentsuite.io/", hosted))
        assertFalse(ProblemReport.isCustomServer("https://SERVER.silentsuite.io:443/partner/", hosted))
        assertTrue(ProblemReport.isCustomServer("https://server.silentsuite.io:8443/", hosted))
        assertTrue(ProblemReport.isCustomServer("http://server.silentsuite.io/", hosted))
        assertTrue(ProblemReport.isCustomServer("https://etebase.example.org/", hosted))
        assertTrue(ProblemReport.isCustomServer("not a uri", hosted))
    }

    @Test
    fun maximumFourByteTextAndContactFitAndOneMoreCodePointIsRejected() {
        val emoji = "😀"
        val contact = "a".repeat(64) + "@" + "b".repeat(189)
        val body = build(emoji.repeat(120), emoji.repeat(4000), contact, ProblemReport.diagnosticsJson(input()))
        val bytes = body.toByteArray(Charsets.UTF_8).size
        assertTrue("body is $bytes bytes", bytes <= ProblemReport.MAX_BODY_BYTES)
        assertTrue("4-byte characters are written raw", body.contains(emoji.repeat(120)))
        assertEquals(emoji.repeat(4000), parse(body).get("description").asString)
        assertEquals(contact, parse(body).get("contact_email").asString)
        expectInvalid(Field.SUMMARY, Problem.TOO_LONG) { build(summary = emoji.repeat(121)) }
        expectInvalid(Field.DESCRIPTION, Problem.TOO_LONG) { build(description = emoji.repeat(4001)) }
        expectInvalid(Field.CONTACT_EMAIL, Problem.INVALID) { build(contact = "a".repeat(65) + "@example.org") }
    }

    @Test
    fun maximumEscapedCharactersFitAndRoundTrip() {
        listOf("\"", "\\", "\n", "\t").forEach { escaped ->
            val description = "x" + escaped.repeat(3998) + "y"
            val summary = "s" + escaped.repeat(118) + "t"
            val body = build(summary, description, diagnostics = ProblemReport.diagnosticsJson(input()))
            assertTrue(body.toByteArray(Charsets.UTF_8).size <= ProblemReport.MAX_BODY_BYTES)
            assertEquals(description, parse(body).get("description").asString)
            assertEquals(summary, parse(body).get("summary").asString)
            expectInvalid(Field.DESCRIPTION, Problem.TOO_LONG) { build(description = "x" + escaped.repeat(3999) + "y") }
        }
    }

    @Test
    fun controlCharactersAreRejectedAndLineEndingsNormalised() {
        listOf("\u0000", "\u0007", "\u000b", "\u000c", "\r", "\u001b", "\u007f", "\u0085", "\u009f").forEach { control ->
            expectInvalid(Field.SUMMARY, Problem.CONTROL_CHARACTER) { build(summary = "a${control}b") }
            expectInvalid(Field.DESCRIPTION, Problem.CONTROL_CHARACTER) { build(description = "a${control}b") }
        }
        expectInvalid(Field.DESCRIPTION, Problem.INVALID) { build(description = "a\uD83Db") }
        expectInvalid(Field.DESCRIPTION, Problem.INVALID) { build(description = "a\uDE00b") }
        // Lone surrogates at either end, in the summary too: the relay rejects them, so they never reach Send.
        expectInvalid(Field.SUMMARY, Problem.INVALID) { build(summary = "ab\uD83D") }
        expectInvalid(Field.SUMMARY, Problem.INVALID) { build(summary = "\uDE00ab") }
        expectInvalid(Field.DESCRIPTION, Problem.INVALID) { build(description = "\uDE00\uD83D") }
        val body = build(description = "line one\r\nline\ttwo")
        assertEquals("line one\nline\ttwo", parse(body).get("description").asString)
        assertFalse(body.contains("\\r"))
    }

    @Test
    fun emptyTextAndBadEmailAreRejected() {
        expectInvalid(Field.SUMMARY, Problem.REQUIRED) { build(summary = "  \n ") }
        expectInvalid(Field.DESCRIPTION, Problem.REQUIRED) { build(description = "") }
        listOf("no-at-sign", "a@b@c", "name with space@example.org", "<a@example.org>").forEach {
            expectInvalid(Field.CONTACT_EMAIL, Problem.INVALID) { build(contact = it) }
        }
        assertNull(parse(build(contact = "   ")).get("contact_email"))
    }

    @Test
    fun serializerDoesNotEscapeNonAscii() {
        val text = "é 漢字   <tag> & = ' / ok"
        val body = build(summary = text, description = text)
        assertTrue(body.contains("\"summary\":\"$text\""))
        assertEquals(text, parse(body).get("summary").asString)
    }

    @Test
    fun reportSourcesUseNoAccountClientNamesLogsOrDeviceIdentifiers() {
        val sources = File("src/main/java/io/silentsuite/sync/ui/report").listFiles()!!
            .filter { it.extension == "kt" }.joinToString("\n") { it.readText() }
        listOf("sync.HttpClient", "account.name", "Build.MODEL", "Build.MANUFACTURER", "Build.DEVICE",
            "Build.FINGERPRINT", "ANDROID_ID", "stackTrace", "StackTrace", "Log.", "Logger").forEach {
            assertFalse("report source must not use $it", sources.contains(it))
        }
        assertEquals(1, Regex(Regex.escape("ProblemReport.ENDPOINT")).findAll(sources).count())
    }

    @Test
    fun emailTextCarriesTheSameReportAndFrozenDiagnostics() {
        val preview = ProblemReport.diagnosticsJson(input())
        assertEquals("Problem report: Sync stops", ProblemReport.emailSubject(Kind.PROBLEM, " Sync stops\r\n"))
        assertEquals("Feature request: Dark mode", ProblemReport.emailSubject(Kind.FEATURE, "Dark mode"))
        assertEquals("Details\nmore\n\nDiagnostic info:\n$preview", ProblemReport.emailBody("Details\r\nmore", preview))
        assertEquals("Details", ProblemReport.emailBody("Details", null))
        assertEquals("support@silentsuite.io", ProblemReport.SUPPORT_EMAIL)
        assertEquals("https://silentsuite.io/privacy#problem-reports", ProblemReport.PRIVACY_POLICY_URL)
    }
}
