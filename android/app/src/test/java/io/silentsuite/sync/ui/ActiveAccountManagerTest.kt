package io.silentsuite.sync.ui

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ActiveAccountManagerTest {
    /**
     * getAll gives [all], then [later] on any further call. getString casts like the platform, or gives [strings]
     * instead when set. Both stand for a commit landing between two reads.
     */
    private class Prefs(
        private val all: Map<String, Any?>,
        private val strings: Map<String, String?>? = null,
        private val later: Map<String, Any?> = all
    ) : SharedPreferences {
        private var calls = 0
        override fun getAll(): Map<String, *> = if (calls++ == 0) all else later
        override fun getString(key: String, defValue: String?): String? =
            if (strings != null) (if (key in strings) strings[key] else defValue) else (all[key] as String?) ?: defValue
        override fun getStringSet(key: String, defValues: Set<String>?): Set<String>? = throw UnsupportedOperationException()
        override fun getInt(key: String, defValue: Int): Int = throw UnsupportedOperationException()
        override fun getLong(key: String, defValue: Long): Long = throw UnsupportedOperationException()
        override fun getFloat(key: String, defValue: Float): Float = throw UnsupportedOperationException()
        override fun getBoolean(key: String, defValue: Boolean): Boolean = throw UnsupportedOperationException()
        override fun contains(key: String): Boolean = key in all
        override fun edit(): SharedPreferences.Editor = throw UnsupportedOperationException()
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) =
            throw UnsupportedOperationException()
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) =
            throw UnsupportedOperationException()
    }

    private val pairA = mapOf("account_name" to "a", "creation_id" to "gen-a")
    private val pairB = mapOf("account_name" to "b", "creation_id" to "gen-b")

    @Test fun `name comes from the same snapshot as the id`() {
        val prefs = Prefs(pairB, mapOf("account_name" to "a", "creation_id" to "gen-b"), later = pairA)
        assertEquals("b" to "gen-b", ActiveAccountManager.savedIdentity(prefs))
    }

    @Test fun `id comes from the same snapshot as the name`() {
        val prefs = Prefs(pairB, mapOf("account_name" to "b", "creation_id" to "gen-a"), later = pairA)
        assertEquals("b" to "gen-b", ActiveAccountManager.savedIdentity(prefs))
    }

    @Test fun `both present gives the pair`() {
        assertEquals("b" to "gen-b", ActiveAccountManager.savedIdentity(Prefs(pairB)))
    }

    @Test fun `no preference gives null`() {
        assertNull(ActiveAccountManager.savedIdentity(Prefs(emptyMap())))
    }

    @Test fun `missing id gives null`() {
        assertNull(ActiveAccountManager.savedIdentity(Prefs(mapOf("account_name" to "b"))))
    }

    @Test fun `missing name gives null`() {
        assertNull(ActiveAccountManager.savedIdentity(Prefs(mapOf("creation_id" to "gen-b"))))
    }

    @Test fun `blank name gives null`() {
        assertNull(ActiveAccountManager.savedIdentity(Prefs(mapOf("account_name" to " ", "creation_id" to "gen-b"))))
    }

    @Test fun `blank id gives null`() {
        assertNull(ActiveAccountManager.savedIdentity(Prefs(mapOf("account_name" to "b", "creation_id" to " "))))
    }

    @Test(expected = ClassCastException::class) fun `a name that is not a String throws`() {
        ActiveAccountManager.savedIdentity(Prefs(mapOf("account_name" to 7, "creation_id" to "gen-b")))
    }

    @Test(expected = ClassCastException::class) fun `an id that is not a String throws`() {
        ActiveAccountManager.savedIdentity(Prefs(mapOf("account_name" to "b", "creation_id" to 7L)))
    }

    @Test(expected = ClassCastException::class) fun `an id that is not a String throws even with no name`() {
        ActiveAccountManager.savedIdentity(Prefs(mapOf("creation_id" to 7L)))
    }

    @Test(expected = ClassCastException::class) fun `an id that is not a String throws even with a blank name`() {
        ActiveAccountManager.savedIdentity(Prefs(mapOf("account_name" to "", "creation_id" to 7L)))
    }
}
