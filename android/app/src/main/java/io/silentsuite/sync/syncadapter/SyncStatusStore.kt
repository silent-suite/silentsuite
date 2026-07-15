package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import io.silentsuite.sync.AccountSettings
import java.security.MessageDigest
import java.util.UUID

/** Local, privacy-bounded evidence from completed Android provider syncs. */
class SyncStatusStore internal constructor(
    private val storage: Storage,
    private val mainAccountKey: (Account) -> String = { account -> hashIdentity(account.type, account.name, null) },
    private val childAccountKey: (Account) -> String = { account -> hashIdentity(account.type, account.name, null) },
) {
    enum class Service { CALENDAR, CONTACTS, TASKS }
    enum class FailureCategory {
        NETWORK, AUTHENTICATION, PERMISSION, PROVIDER, STORAGE, CONFIGURATION, SETUP_REQUIRED,
        PARENT_REFRESH, CHILD_REMOVED, UNKNOWN
    }
    enum class ChildResult { SUCCESS, FAILURE, REMOVED }
    sealed class ContactsStart {
        data class Started(val attemptId: String) : ContactsStart()
        object SetupRequired : ContactsStart()
        object StorageFailure : ContactsStart()
    }
    enum class ChildWrite { RECORDED, REJECTED, STORAGE_FAILURE }

    data class Status(
        val lastSuccessAt: Long? = null,
        val lastFailureAt: Long? = null,
        val lastFailureCategory: FailureCategory? = null,
        val latestGenerationIncomplete: Boolean = false,
        val pendingChildren: Int = 0,
    )

    /** Snapshot this before AccountManager removal, then pass it to [clear] after removal is confirmed. */
    data class MainIdentity internal constructor(internal val storageKey: String)

    interface Storage {
        fun get(key: String): String?

        /** Atomically applies the complete mutation and reports whether it reached durable storage. */
        fun commit(puts: Map<String, String> = emptyMap(), removes: Set<String> = emptySet()): Boolean
    }

    private data class Outcome(
        val successAt: Long? = null,
        val failureAt: Long? = null,
        val failureCategory: FailureCategory? = null,
    )

    private data class ContactsRecord(
        val outcome: Outcome = Outcome(),
        val attemptId: String? = null,
        val expected: Set<String> = emptySet(),
        val terminal: Map<String, ChildResult> = emptyMap(),
    )

    constructor(context: Context) : this(
        PreferencesStorage(context.applicationContext),
        mainAccountKey = { account ->
            val creationId = AccountManager.get(context.applicationContext)
                .getUserData(account, AccountSettings.KEY_CREATION_ID)
            hashIdentity(account.type, account.name, creationId)
        },
    )

    fun identity(account: Account): MainIdentity = MainIdentity(mainAccountKey(account))

    @Synchronized
    fun status(account: Account, service: Service): Status = synchronized(STORE_LOCK) {
        val identity = mainAccountKey(account)
        val key = recordKey(identity, service)
        if (service == Service.CONTACTS) {
            val record = readContacts(identity)
            val incomplete = record.attemptId != null && record.terminal.keys != record.expected
            statusOf(record.outcome, incomplete, (record.expected - record.terminal.keys).size).failClosedIfNeeded(key)
        } else {
            statusOf(readOutcome(key)).failClosedIfNeeded(key)
        }
    }

    @Synchronized
    fun recordSuccess(account: Account, service: Service, timestamp: Long = System.currentTimeMillis()): Boolean = synchronized(STORE_LOCK) {
        require(service != Service.CONTACTS) { "Contacts outcomes are generation-scoped" }
        val key = recordKey(mainAccountKey(account), service)
        val current = readOutcome(key)
        commitRecord(key, encodeOutcome(current.copy(successAt = orderedAfter(timestamp, current.failureAt))))
    }

    @Synchronized
    fun recordFailure(
        account: Account,
        service: Service,
        category: FailureCategory,
        timestamp: Long = System.currentTimeMillis(),
    ): Boolean = synchronized(STORE_LOCK) {
        require(service != Service.CONTACTS) { "Contacts outcomes are generation-scoped" }
        val key = recordKey(mainAccountKey(account), service)
        val current = readOutcome(key)
        commitRecord(key, encodeOutcome(current.copy(
            failureAt = orderedAfter(timestamp, current.successAt),
            failureCategory = category,
        )))
    }

    /** Starts the only Contacts attempt allowed to update user-facing state. */
    @Synchronized
    fun beginContacts(account: Account, childAccounts: Set<Account>): ContactsStart = synchronized(STORE_LOCK) {
        val identity = mainAccountKey(account)
        val current = readContacts(identity)
        val expected = childAccounts.mapTo(linkedSetOf()) { childAccountKey(it) }
        if (expected.isEmpty()) {
            val failed = current.copy(
                outcome = failedOutcome(current.outcome, FailureCategory.SETUP_REQUIRED),
                attemptId = null,
                expected = emptySet(),
                terminal = emptyMap(),
            )
            if (writeContacts(identity, failed)) ContactsStart.SetupRequired else ContactsStart.StorageFailure
        } else {
            val attempt = UUID.randomUUID().toString()
            val pending = current.copy(attemptId = attempt, expected = expected, terminal = emptyMap())
            if (writeContacts(identity, pending)) ContactsStart.Started(attempt) else ContactsStart.StorageFailure
        }
    }

    @Synchronized
    fun failContactsParent(account: Account, category: FailureCategory = FailureCategory.PARENT_REFRESH): Boolean = synchronized(STORE_LOCK) {
        val identity = mainAccountKey(account)
        val current = readContacts(identity)
        writeContacts(identity, current.copy(
            outcome = failedOutcome(current.outcome, category),
            attemptId = null,
            expected = emptySet(),
            terminal = emptyMap(),
        ))
    }

    @Synchronized
    fun recordContactsChild(
        account: Account,
        attemptId: String,
        childAccount: Account,
        result: ChildResult,
        failureCategory: FailureCategory = FailureCategory.PROVIDER,
    ): ChildWrite = synchronized(STORE_LOCK) {
        val identity = mainAccountKey(account)
        recordContactsChild(identity, attemptId, childAccount, result, failureCategory)
    }

    private fun recordContactsChild(
        identity: String,
        attemptId: String,
        childAccount: Account,
        result: ChildResult,
        failureCategory: FailureCategory,
    ): ChildWrite {
        val current = readContacts(identity)
        val child = childAccountKey(childAccount)
        if (current.attemptId != attemptId || child !in current.expected || child in current.terminal)
            return ChildWrite.REJECTED

        val terminal = current.terminal + (child to result)
        val outcome = when {
            result == ChildResult.FAILURE -> failedOutcome(current.outcome, failureCategory)
            result == ChildResult.REMOVED -> failedOutcome(current.outcome, FailureCategory.CHILD_REMOVED)
            terminal.keys == current.expected && terminal.values.all { it == ChildResult.SUCCESS } ->
                current.outcome.copy(successAt = orderedAfter(System.currentTimeMillis(), current.outcome.failureAt))
            else -> current.outcome
        }
        if (writeContacts(identity, current.copy(outcome = outcome, terminal = terminal)))
            ChildWrite.RECORDED
        else
            ChildWrite.STORAGE_FAILURE
    }

    @Synchronized
    fun recordContactsChildRemoved(account: Account, childAccount: Account): Boolean = synchronized(STORE_LOCK) {
        val identity = mainAccountKey(account)
        val attempt = readContacts(identity).attemptId ?: return@synchronized false
        recordContactsChild(identity, attempt, childAccount, ChildResult.REMOVED, FailureCategory.PROVIDER) == ChildWrite.RECORDED
    }

    @Synchronized
    fun clear(account: Account): Boolean = clear(identity(account))

    /** Clears an exact creation generation without consulting a possibly-removed AccountManager row. */
    @Synchronized
    fun clear(identity: MainIdentity): Boolean = synchronized(STORE_LOCK) {
        val keys = Service.values().mapTo(linkedSetOf()) { recordKey(identity.storageKey, it) }
        val sentinels = keys.mapTo(linkedSetOf(), ::faultKey)
        val committed = storage.commit(removes = keys + sentinels)
        if (committed) {
            keys.forEach { failedWrites.remove(it) }
        } else {
            persistFaults(keys)
        }
        committed
    }

    private fun statusOf(outcome: Outcome, incomplete: Boolean = false, pending: Int = 0) = Status(
        outcome.successAt, outcome.failureAt, outcome.failureCategory, incomplete, pending,
    )

    private fun Status.failClosedIfNeeded(key: String): Status {
        val storedFault = storage.get(faultKey(key))
        val failureAt = storedFault?.let(::decodeFault) ?: failedWrites[key]
        if (storedFault == null && failureAt == null) return this
        return copy(
            lastFailureAt = failureAt ?: failureTimestampFor(key, 0L),
            lastFailureCategory = FailureCategory.STORAGE,
            latestGenerationIncomplete = latestGenerationIncomplete || key.endsWith(".${Service.CONTACTS.name}"),
        )
    }

    private fun failedOutcome(outcome: Outcome, category: FailureCategory, timestamp: Long = System.currentTimeMillis()) =
        outcome.copy(failureAt = orderedAfter(timestamp, outcome.successAt), failureCategory = category)

    private fun orderedAfter(timestamp: Long, previous: Long?): Long = maxOf(timestamp, (previous ?: Long.MIN_VALUE) + 1)
    private fun recordKey(identity: String, service: Service) = "status.$identity.${service.name}"

    private fun writeContacts(identity: String, record: ContactsRecord) =
        recordKey(identity, Service.CONTACTS).let { commitRecord(it, encodeContacts(record)) }

    private fun commitRecord(key: String, value: String): Boolean {
        val committed = storage.commit(mapOf(key to value), setOf(faultKey(key)))
        if (committed) {
            failedWrites.remove(key)
        } else {
            persistFaults(setOf(key))
        }
        return committed
    }

    /** One bounded recovery write. Total-disk failure remains visible in-process and to the caller. */
    private fun persistFaults(keys: Set<String>) {
        val now = System.currentTimeMillis()
        val timestamps = keys.associateWith { failureTimestampFor(it, now) }
        val sentinels = timestamps.mapKeys { faultKey(it.key) }.mapValues { encodeFault(it.value) }
        val persisted = storage.commit(sentinels)
        if (persisted) {
            keys.forEach { failedWrites.remove(it) }
        } else {
            failedWrites.putAll(timestamps)
        }
    }

    private fun failureTimestampFor(key: String, candidate: Long): Long {
        val parts = storage.get(key)?.split('|', limit = 4).orEmpty()
        val success = parts.getOrNull(1)?.toLongOrNull()
        val failure = parts.getOrNull(2)?.toLongOrNull()
        return maxOf(
            candidate,
            orderedAfterValue(success),
            orderedAfterValue(failure),
        )
    }

    private fun orderedAfterValue(value: Long?): Long = when (value) {
        null -> 0L
        Long.MAX_VALUE -> Long.MAX_VALUE
        else -> value + 1
    }

    private fun encodeFault(timestamp: Long) = "$FAULT_VERSION|$timestamp|STORAGE"

    private fun decodeFault(value: String): Long? {
        val parts = value.split('|', limit = 3)
        if (parts.size != 3 || parts[0] != FAULT_VERSION || parts[2] != "STORAGE") return null
        val timestamp = parts[1].toLongOrNull() ?: return null
        val latestAccepted = System.currentTimeMillis().let { now ->
            if (now > Long.MAX_VALUE - MAX_FUTURE_SKEW_MILLIS) Long.MAX_VALUE else now + MAX_FUTURE_SKEW_MILLIS
        }
        return timestamp.takeIf { it in 0..latestAccepted }
    }

    private fun readContacts(identity: String): ContactsRecord {
        val value = storage.get(recordKey(identity, Service.CONTACTS)) ?: return ContactsRecord()
        val parts = value.split('|', limit = 6)
        if (parts.size != 6 || parts[0] != RECORD_VERSION)
            return ContactsRecord(failedOutcome(Outcome(), FailureCategory.STORAGE))
        val outcome = decodeOutcome((listOf(RECORD_VERSION) + parts.subList(1, 4)).joinToString("|"))
        val attempt = parts[4].ifBlank { null }
        val sets = parts[5].split(';', limit = 2)
        val expected = sets.getOrElse(0) { "" }.split(',').filter { it.isNotBlank() }.toSet()
        val terminal = sets.getOrElse(1) { "" }.split(',').mapNotNull {
            val key = it.substringBefore(':', "")
            val result = runCatching { ChildResult.valueOf(it.substringAfter(':', "")) }.getOrNull()
            if (key.isBlank() || result == null) null else key to result
        }.toMap()
        if (attempt == null && expected.isEmpty() && terminal.isEmpty()) return ContactsRecord(outcome)
        if (attempt == null || expected.isEmpty() || terminal.keys.any { it !in expected })
            return ContactsRecord(failedOutcome(outcome, FailureCategory.STORAGE))
        return ContactsRecord(outcome, attempt, expected, terminal)
    }

    private fun encodeContacts(record: ContactsRecord): String {
        val expected = record.expected.sorted().joinToString(",")
        val terminal = record.terminal.toSortedMap().entries.joinToString(",") { "${it.key}:${it.value.name}" }
        return "$RECORD_VERSION|${encodeOutcome(record.outcome).substringAfter('|')}|${record.attemptId.orEmpty()}|$expected;$terminal"
    }

    private fun readOutcome(key: String) = storage.get(key)?.let(::decodeOutcome) ?: Outcome()
    private fun encodeOutcome(outcome: Outcome) = listOf(
        RECORD_VERSION,
        outcome.successAt?.toString().orEmpty(),
        outcome.failureAt?.toString().orEmpty(),
        outcome.failureCategory?.name.orEmpty(),
    ).joinToString("|")

    private fun decodeOutcome(value: String): Outcome {
        val parts = value.split('|', limit = 4)
        if (parts.size != 4 || parts[0] != RECORD_VERSION) return failedOutcome(Outcome(), FailureCategory.STORAGE)
        val success = parts[1].takeIf { it.isNotBlank() }?.toLongOrNull()
        val failure = parts[2].takeIf { it.isNotBlank() }?.toLongOrNull()
        val category = parts[3].takeIf { it.isNotBlank() }?.let { runCatching { FailureCategory.valueOf(it) }.getOrNull() }
        if ((parts[1].isNotBlank() && success == null) ||
            (parts[2].isNotBlank() && failure == null) ||
            (parts[3].isNotBlank() && category == null) ||
            (failure == null) != (category == null))
            return failedOutcome(Outcome(successAt = success), FailureCategory.STORAGE)
        return Outcome(success, failure, category)
    }

    companion object {
        const val EXTRA_CONTACTS_ATTEMPT = "io.silentsuite.sync.CONTACTS_ATTEMPT"
        private const val RECORD_VERSION = "1"
        private const val FAULT_VERSION = "1"
        private const val MAX_FUTURE_SKEW_MILLIS = 5 * 60 * 1000L
        private val STORE_LOCK = Any()
        private val failedWrites = mutableMapOf<String, Long>()

        private fun hashIdentity(type: String?, name: String?, creationId: String?): String {
            val bytes = MessageDigest.getInstance("SHA-256")
                .digest("$type\u0000$name\u0000${creationId.orEmpty()}".toByteArray(Charsets.UTF_8))
            return bytes.joinToString("") { "%02x".format(it) }
        }

        private fun faultKey(recordKey: String) = "fault.$recordKey"
    }

    private class PreferencesStorage(context: Context) : Storage {
        private val preferences = context.getSharedPreferences("sync_status_v1", Context.MODE_PRIVATE)
        override fun get(key: String) = preferences.getString(key, null)
        override fun commit(puts: Map<String, String>, removes: Set<String>): Boolean {
            val editor = preferences.edit()
            removes.forEach(editor::remove)
            puts.forEach(editor::putString)
            return editor.commit()
        }
    }
}
