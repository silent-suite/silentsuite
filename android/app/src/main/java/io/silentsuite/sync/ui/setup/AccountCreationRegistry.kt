package io.silentsuite.sync.ui.setup

import android.content.Context

/**
 * Versioned non-secret ownership registry. Each mutator performs commit plus read-back and is
 * compare-and-clear by opaque creation id, so a stale recovery cannot erase a newer attempt.
 */
class AccountCreationRegistry(private val store: Store) {
    enum class Phase { PREPARED, CREATING, RECOVERY_REQUIRED }
    data class Record(val accountName: String, val creationId: String, val phase: Phase, val timestamp: Long,
                      val accountType: String = "")
    interface Store { fun read(): String?; fun commit(value: String?): Boolean }

    fun get(accountType: String, accountName: String): Record? = synchronized(LOCK) { decode(store.read())?.get(key(accountType, accountName)) }
    fun records(): List<Record>? = synchronized(LOCK) { decode(store.read())?.values?.toList() }
    fun prepare(record: Record): Boolean = synchronized(LOCK) { update(record.accountType, record.accountName) { current ->
        // A duplicate submit must leave the first owner's durable record intact.
        current ?: record
    } }
    fun updateOwned(record: Record): Boolean = synchronized(LOCK) {
        val current = decode(store.read())?.get(key(record.accountType, record.accountName))
            ?: return@synchronized false
        if (!owns(current, record.creationId)) return@synchronized false
        if (current == record) return@synchronized true
        update(record.accountType, record.accountName) { owned ->
            if (owns(owned, record.creationId)) record else owned
        }
    }
    fun clearOwned(accountType: String, accountName: String, creationId: String): Boolean = synchronized(LOCK) {
        update(accountType, accountName) { current -> if (owns(current, creationId)) null else current }
    }

    private fun update(type: String, name: String, mutation: (Record?) -> Record?): Boolean {
        val all = decode(store.read()) ?: return false // corrupt/unknown fails closed
        val key = key(type, name); val old = all[key]; val next = mutation(old)
        if (old == next) return false
        if (next == null) all.remove(key) else all[key] = next
        val encoded = encode(all)
        return store.commit(encoded) && store.read() == encoded
    }

    private fun decode(raw: String?): MutableMap<String, Record>? {
        if (raw == null) return mutableMapOf()
        return runCatching {
            val parts = raw.split("\n"); require(parts.firstOrNull() == "v$VERSION")
            mutableMapOf<String, Record>().also { output -> parts.drop(1).filter { it.isNotEmpty() }.forEach { line ->
                val values = line.split('|'); require(values.size == 5)
                val type = unescape(values[0]); val name = unescape(values[1]); output[key(type, name)] =
                    Record(name, unescape(values[2]), Phase.valueOf(values[3]), values[4].toLong(), type)
            }}
        }.getOrNull()
    }
    private fun encode(rows: Map<String, Record>): String = buildString {
        append("v").append(VERSION).append('\n'); rows.values.sortedBy { key(it.accountType, it.accountName) }.forEach { r ->
            append(escape(r.accountType)).append('|').append(escape(r.accountName)).append('|')
                .append(escape(r.creationId)).append('|').append(r.phase.name).append('|').append(r.timestamp).append('\n')
        }
    }
    private fun escape(value: String) = value.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    private fun unescape(value: String): String {
        require(value.length % 2 == 0)
        return String(ByteArray(value.length / 2) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }, Charsets.UTF_8)
    }
    private fun key(type: String, name: String) = "$type\u0000$name"

    companion object {
        private val LOCK = Any()
        private const val VERSION = 1; private const val PREFS = "account_creation_registry"; private const val KEY = "rows"
        fun canPrepare(accountName: String, existingNames: Set<String>) = accountName !in existingNames
        fun owns(record: Record?, creationId: String?) = record != null && creationId != null && record.creationId == creationId
        fun open(context: Context) = AccountCreationRegistry(object : Store {
            private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            override fun read() = prefs.getString(KEY, null)
            override fun commit(value: String?) = prefs.edit().apply { if (value == null) remove(KEY) else putString(KEY, value) }.commit()
        })
    }
}
