package io.silentsuite.sync.ui.setup

import android.content.Context

/**
 * androidTest-only writer of the two exact registry values [RegistryProcessBoundaryRuntimeTest]
 * cannot produce through the production mutators: the newline-terminated form earlier builds
 * stored, and one synthetic value no encoder ever wrote.
 *
 * There is no caller-supplied value, no clear and no remove, so this is not a general raw-write
 * seam. The legacy form is only ever appended to a store the production reader already accepts,
 * and every write is verified by reading it back.
 */
object RegistryLegacySeed {
    private const val PREFS = "account_creation_registry"
    private const val KEY = "rows"

    /** Rejected by the strict decoder and by legacy recovery alike: a tab is not the padded shape. */
    const val MALFORMED = "v1\n\t"

    /**
     * Appends the terminal newline earlier builds wrote. False unless the current value is readable
     * through the production decoder and is not newline terminated already, so an unreadable or
     * already legacy store is never overwritten.
     */
    fun appendLegacyNewline(context: Context): Boolean {
        if (AccountCreationRegistry.open(context).readResult().status != AccountCreationRegistry.DecodeStatus.OK) {
            return false
        }
        val prefs = prefs(context)
        val current = prefs.getString(KEY, null) ?: return false
        if (current.endsWith("\n")) return false
        val legacy = current + "\n"
        return prefs.edit().putString(KEY, legacy).commit() && prefs.getString(KEY, null) == legacy
    }

    /** Stores [MALFORMED]; the lane runs this last so no later writer sees an unreadable store. */
    fun seedMalformed(context: Context): Boolean {
        val prefs = prefs(context)
        return prefs.edit().putString(KEY, MALFORMED).commit() && prefs.getString(KEY, null) == MALFORMED
    }

    /** Content-free: only whether the synthetic value is still stored byte for byte. */
    fun malformedValueIntact(context: Context): Boolean = prefs(context).getString(KEY, null) == MALFORMED

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
