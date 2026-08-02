package io.silentsuite.sync.syncadapter

/** Frozen d357c52 v1 read path, independent from the lifecycle-v2 reader. */
internal class FrozenBaselineV1StatusReader(
    private val read: (String) -> String?,
    private val failedWrites: Map<String, Long> = emptyMap(),
) {
    data class Status(val successAt: Long? = null, val failureAt: Long? = null,
        val failureCategory: String? = null, val incomplete: Boolean = false, val pendingChildren: Int = 0)

    private data class Outcome(val success: Long? = null, val failure: Long? = null,
        val category: String? = null)

    private data class ContactsRecord(
        val outcome: Outcome = Outcome(),
        val attemptId: String? = null,
        val expected: Set<String> = emptySet(),
        val terminal: Map<String, String> = emptyMap(),
    )

    fun status(key: String, contacts: Boolean): Status {
        val status = if (contacts) {
            val record = readContacts(key)
            Status(record.outcome.success, record.outcome.failure, record.outcome.category,
                record.attemptId != null && record.terminal.keys != record.expected,
                (record.expected - record.terminal.keys).size)
        } else {
            val outcome = read(key)?.let(::decodeOutcome) ?: Outcome()
            Status(outcome.success, outcome.failure, outcome.category)
        }
        return status.failClosedIfNeeded(key, contacts)
    }

    private fun readContacts(key: String): ContactsRecord {
        val value = read(key) ?: return ContactsRecord()
        val parts = value.split('|', limit = 6)
        if (parts.size != 6 || parts[0] != RECORD_VERSION)
            return ContactsRecord(failedOutcome(Outcome(), STORAGE))
        val outcome = decodeOutcome((listOf(RECORD_VERSION) + parts.subList(1, 4)).joinToString("|"))
        val attempt = parts[4].ifBlank { null }
        val sets = parts[5].split(';', limit = 2)
        val expected = sets.getOrElse(0) { "" }.split(',').filter { it.isNotBlank() }.toSet()
        val terminal = sets.getOrElse(1) { "" }.split(',').mapNotNull {
            val child = it.substringBefore(':', "")
            val result = it.substringAfter(':', "").takeIf { value -> value in CHILD_RESULTS }
            if (child.isBlank() || result == null) null else child to result
        }.toMap()
        if (attempt == null && expected.isEmpty() && terminal.isEmpty()) return ContactsRecord(outcome)
        if (attempt == null || expected.isEmpty() || terminal.keys.any { it !in expected })
            return ContactsRecord(failedOutcome(outcome, STORAGE))
        return ContactsRecord(outcome, attempt, expected, terminal)
    }

    private fun decodeOutcome(value: String): Outcome {
        val parts = value.split('|', limit = 4)
        if (parts.size != 4 || parts[0] != RECORD_VERSION) return failedOutcome(Outcome(), STORAGE)
        val success = parts[1].takeIf { it.isNotBlank() }?.toLongOrNull()
        val failure = parts[2].takeIf { it.isNotBlank() }?.toLongOrNull()
        val category = parts[3].takeIf { it.isNotBlank() }?.takeIf { it in CATEGORIES }
        if ((parts[1].isNotBlank() && success == null) ||
            (parts[2].isNotBlank() && failure == null) ||
            (parts[3].isNotBlank() && category == null) ||
            (failure == null) != (category == null))
            return failedOutcome(Outcome(success = success), STORAGE)
        return Outcome(success, failure, category)
    }

    private fun failedOutcome(outcome: Outcome, category: String, timestamp: Long = System.currentTimeMillis()) =
        outcome.copy(failure = orderedAfter(timestamp, outcome.success), category = category)

    private fun orderedAfter(timestamp: Long, previous: Long?) = maxOf(timestamp, (previous ?: Long.MIN_VALUE) + 1)

    private fun Status.failClosedIfNeeded(key: String, contacts: Boolean): Status {
        val storedFault = read("fault.$key")
        val failureAt = storedFault?.let(::decodeFault) ?: failedWrites[key]
        if (storedFault == null && failureAt == null) return this
        return copy(failureAt = failureAt ?: failureTimestampFor(key, 0L),
            failureCategory = STORAGE, incomplete = incomplete || contacts)
    }

    private fun failureTimestampFor(key: String, candidate: Long): Long {
        val parts = read(key)?.split('|', limit = 4).orEmpty()
        val success = parts.getOrNull(1)?.toLongOrNull()
        val failure = parts.getOrNull(2)?.toLongOrNull()
        return maxOf(candidate, orderedAfterValue(success), orderedAfterValue(failure))
    }

    private fun orderedAfterValue(value: Long?): Long = when (value) {
        null -> 0L
        Long.MAX_VALUE -> Long.MAX_VALUE
        else -> value + 1
    }

    private fun decodeFault(value: String): Long? {
        val parts = value.split('|', limit = 3)
        if (parts.size != 3 || parts[0] != FAULT_VERSION || parts[2] != STORAGE) return null
        val timestamp = parts[1].toLongOrNull() ?: return null
        val latestAccepted = System.currentTimeMillis().let { now ->
            if (now > Long.MAX_VALUE - MAX_FUTURE_SKEW_MILLIS) Long.MAX_VALUE else now + MAX_FUTURE_SKEW_MILLIS
        }
        return timestamp.takeIf { it in 0..latestAccepted }
    }

    companion object {
        private const val RECORD_VERSION = "1"
        private const val FAULT_VERSION = "1"
        private const val STORAGE = "STORAGE"
        private const val MAX_FUTURE_SKEW_MILLIS = 5 * 60 * 1000L
        private val CATEGORIES = setOf("NETWORK", "AUTHENTICATION", "PERMISSION", "PROVIDER", STORAGE,
            "CONFIGURATION", "SETUP_REQUIRED", "PARENT_REFRESH", "CHILD_REMOVED", "UNKNOWN")
        private val CHILD_RESULTS = setOf("SUCCESS", "FAILURE", "REMOVED")
    }
}
