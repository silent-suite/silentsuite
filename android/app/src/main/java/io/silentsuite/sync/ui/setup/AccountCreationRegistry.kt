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

    /**
     * Content-free classification of one decode: never registry values, identifiers, lengths,
     * row positions or exception text. A failure only names the validation step that rejected.
     */
    enum class DecodeStatus {
        OK, NOT_STORED, INVALID_HEADER, INVALID_FIELD_COUNT, INVALID_ENCODING, INVALID_PHASE, INVALID_TIMESTAMP,
        UNEXPECTED_RUNTIME_EXCEPTION, UNEXPECTED_ERROR, UNEXPECTED_OTHER
    }
    /** One read: [records] is null for exactly the stored values that make records() null. */
    class ReadResult(val records: List<Record>?, val status: DecodeStatus)

    fun get(accountType: String, accountName: String): Record? = synchronized(LOCK) { decode(store.read())?.get(key(accountType, accountName)) }
    fun records(): List<Record>? = readResult().records
    fun readResult(): ReadResult = synchronized(LOCK) {
        val (rows, status) = decodeResult(store.read()); ReadResult(rows?.values?.toList(), status)
    }
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

    private fun decode(raw: String?): MutableMap<String, Record>? = decodeResult(raw).first

    /**
     * Strict decode first. One legacy stored shape is then read back: a value ending in exactly a
     * newline and four spaces, which is what the platform preferences file returns for the
     * newline-terminated values earlier builds wrote. It is accepted only when the value without
     * that padding is byte for byte what this encoder would write for the rows it contains, plus
     * that terminal newline. Every other value keeps exactly the rejection it has today.
     *
     * Read-only: nothing is repaired, committed or read back here, so a recovered store stays as it
     * is until an ordinary mutation rewrites it through the usual commit path.
     */
    private fun decodeResult(raw: String?): Pair<MutableMap<String, Record>?, DecodeStatus> {
        val strict = decodeExact(raw)
        if (strict.first != null || raw == null || !raw.endsWith(LEGACY_PADDED_ENDING)) return strict
        val payload = raw.substring(0, raw.length - LEGACY_PADDING.length)
        val rows = decodeExact(payload).first ?: return strict
        return if (encode(rows) + "\n" == payload) rows to DecodeStatus.OK else strict
    }

    private fun decodeExact(raw: String?): Pair<MutableMap<String, Record>?, DecodeStatus> {
        if (raw == null) return mutableMapOf<String, Record>() to DecodeStatus.NOT_STORED
        // Names the validation step in progress; what is accepted or rejected is unchanged.
        var step = DecodeStatus.INVALID_HEADER
        return try {
            val parts = raw.split("\n"); require(parts.firstOrNull() == "v$VERSION")
            val output = mutableMapOf<String, Record>()
            parts.drop(1).filter { it.isNotEmpty() }.forEach { line ->
                step = DecodeStatus.INVALID_FIELD_COUNT
                val values = line.split('|'); require(values.size == 5)
                step = DecodeStatus.INVALID_ENCODING
                val type = unescape(values[0]); val name = unescape(values[1]); val creationId = unescape(values[2])
                step = DecodeStatus.INVALID_PHASE
                val phase = Phase.valueOf(values[3])
                step = DecodeStatus.INVALID_TIMESTAMP
                output[key(type, name)] = Record(name, creationId, phase, values[4].toLong(), type)
            }
            output to DecodeStatus.OK
        } catch (error: Throwable) {
            // Still fails closed on anything thrown; only the coarse kind survives, never the message.
            null to failureStatus(error, step)
        }
    }
    // Newlines only separate lines: what this writes ends in the header or in a row, never in a
    // newline. Older stored values are newline terminated, and the platform preferences file pads
    // those with four spaces, the one legacy shape decodeResult reads back without rewriting it.
    private fun encode(rows: Map<String, Record>): String =
        (listOf("v$VERSION") + rows.values.sortedBy { key(it.accountType, it.accountName) }.map { r ->
            "${escape(r.accountType)}|${escape(r.accountName)}|${escape(r.creationId)}|${r.phase.name}|${r.timestamp}"
        }).joinToString("\n")
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
        /** Indentation the platform preferences file appends after a value's terminal newline. */
        private const val LEGACY_PADDING = "    "
        private const val LEGACY_PADDED_ENDING = "\n    "
        fun canPrepare(accountName: String, existingNames: Set<String>) = accountName !in existingNames
        fun owns(record: Record?, creationId: String?) = record != null && creationId != null && record.creationId == creationId
        /** Every validation rejection is an IllegalArgumentException; anything else keeps only a coarse kind. */
        internal fun failureStatus(error: Throwable, step: DecodeStatus): DecodeStatus = when (error) {
            is IllegalArgumentException -> step
            is RuntimeException -> DecodeStatus.UNEXPECTED_RUNTIME_EXCEPTION
            is Error -> DecodeStatus.UNEXPECTED_ERROR
            else -> DecodeStatus.UNEXPECTED_OTHER
        }
        fun open(context: Context) = AccountCreationRegistry(object : Store {
            private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            override fun read() = prefs.getString(KEY, null)
            override fun commit(value: String?) = prefs.edit().apply { if (value == null) remove(KEY) else putString(KEY, value) }.commit()
        })
    }
}
