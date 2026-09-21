package io.silentsuite.sync.ui.setup

import android.content.Context
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry

/**
 * Synthetic SharedPreferences controls for [RegistryProcessBoundaryRuntimeTest]. They live in their
 * own test-only preferences file and never touch the ownership registry. Everything reported from
 * here is a control name, an enum or a capped count: never a stored value, code point or hash.
 */
object RegistryTransportControls {
    private const val PREFS = "registry_transport_controls_test"
    private const val MAX_REPORTED_SUFFIX = 16

    /** Same shape as the header-only registry value, stored through plain SharedPreferences. */
    const val REGISTRY_TWIN = "header_plain"

    /** Distinct from every AndroidJUnitRunner per-test status code. */
    private const val EVIDENCE_STATUS_CODE = 2
    private const val EVIDENCE_KEY = "registryTransport"

    enum class Change { EXACT, TRAILING_WHITESPACE_APPENDED, MISSING, OTHER }
    enum class Suffix { NONE, SPACES_ONLY, OTHER_WHITESPACE }

    data class Observation(val change: Change, val suffix: Suffix = Suffix.NONE, val suffixLength: Int = 0) {
        fun render(): String =
            if (change == Change.TRAILING_WHITESPACE_APPENDED) "${change.name}/${suffix.name}/$suffixLength" else change.name
    }

    private val controls = linkedMapOf(
        REGISTRY_TWIN to "v1",
        // The form earlier builds stored; kept to keep showing what the boundary does to it.
        "header_newline" to "v1\n",
        "row_plain" to "v1\n61|62|63|PREPARED|1",
        "row_newline" to "v1\n61|62|63|PREPARED|1\n",
        "inner_newlines" to "a\n\nb",
        "double_newline_end" to "a\n\n",
        "newline_only" to "\n",
    )

    /** Controls that do not end in a newline; these are the ones that must survive a fresh process. */
    val plainEndingNames: List<String> = controls.filterValues { !it.endsWith("\n") }.keys.toList()

    /** Diagnostic only: these may come back padded, but never missing or otherwise altered. */
    val newlineEndingNames: List<String> = controls.filterValues { it.endsWith("\n") }.keys.toList()

    /** Publishes the evidence line in the instrumentation transcript whether or not the test passes. */
    fun report(evidence: String) {
        InstrumentationRegistry.getInstrumentation()
            .sendStatus(EVIDENCE_STATUS_CODE, Bundle().apply { putString(EVIDENCE_KEY, evidence) })
    }

    fun commit(context: Context): Boolean {
        val editor = prefs(context).edit()
        controls.forEach { (name, value) -> editor.putString(name, value) }
        return editor.commit()
    }

    fun observe(context: Context): Map<String, Observation> {
        val stored = prefs(context)
        return controls.mapValues { (name, expected) -> classify(expected, stored.getString(name, null)) }
    }

    fun classify(expected: String, actual: String?): Observation {
        if (actual == null) return Observation(Change.MISSING)
        if (actual == expected) return Observation(Change.EXACT)
        if (!actual.startsWith(expected)) return Observation(Change.OTHER)
        val suffix = actual.substring(expected.length)
        if (!suffix.all { it == ' ' || it == '\t' || it == '\n' || it == '\r' }) return Observation(Change.OTHER)
        return Observation(
            Change.TRAILING_WHITESPACE_APPENDED,
            if (suffix.all { it == ' ' }) Suffix.SPACES_ONLY else Suffix.OTHER_WHITESPACE,
            minOf(suffix.length, MAX_REPORTED_SUFFIX),
        )
    }

    /** One content-free line carried by every reader assertion message. */
    fun evidence(probe: AccountCreationRegistry.DecodeStatus, registry: Observation, observed: Map<String, Observation>): String =
        "registry-transport probe=${probe.name} registry=${registry.render()} " +
            observed.entries.joinToString(" ") { (name, observation) -> "$name=${observation.render()}" }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
