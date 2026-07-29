package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.resource.LocalAddressBook
import java.security.MessageDigest
import java.util.UUID

/**
 * Privacy-bounded, exact-generation sync evidence. V1 keys remain terminal-only rollback shadows;
 * lifecycle evidence is kept exclusively in v2 keys.
 */
class SyncStatusStore internal constructor(
    private val storage: Storage,
    private val mainAccountKey: (Account) -> String = { hashIdentity(it.type, it.name, null) },
    private val childAccountKey: (Account) -> String? = { hashIdentity(it.type, it.name, null) },
) {
    enum class Service { CALENDAR, CONTACTS, TASKS }
    enum class FailureCategory {
        NETWORK, AUTHENTICATION, PERMISSION, PROVIDER, STORAGE, CONFIGURATION, SETUP_REQUIRED,
        PARENT_REFRESH, CHILD_REMOVED, UNKNOWN, INTERRUPTED
    }
    enum class TerminalResult { SUCCESS, FAILURE }
    enum class ChildResult { SUCCESS, FAILURE, REMOVED, SKIPPED }
    /** Completion callers must retry storage failures, never stale/superseded callbacks. */
    enum class MutationResult { RECORDED, REJECTED, STORAGE_FAILURE }
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
        val lastTerminalAt: Long? = null,
        val lastTerminalResult: TerminalResult? = null,
        val activeRequestId: String? = null,
        val requestedAt: Long? = null,
        val activeAttemptId: String? = null,
        val attemptStartedAt: Long? = null,
        val attemptRequestId: String? = null,
        val latestGenerationIncomplete: Boolean = false,
        val pendingChildren: Int = 0,
        /** A malformed record or failed write overrides otherwise usable historical evidence. */
        val structuralStorageFailure: Boolean = false,
    )

    data class MainIdentity internal constructor(internal val storageKey: String)
    data class ChildIdentity internal constructor(internal val storageKey: String)

    interface Storage {
        fun get(key: String): String?
        fun commit(puts: Map<String, String> = emptyMap(), removes: Set<String> = emptySet()): Boolean
    }

    private data class Outcome(
        val successAt: Long? = null,
        val failureAt: Long? = null,
        val failureCategory: FailureCategory? = null,
    )

    private data class ContactsGeneration(
        val expected: Set<String> = emptySet(),
        val terminal: Map<String, Pair<ChildResult, FailureCategory?>> = emptyMap(),
    )

    private data class LegacyContacts(val outcome: Outcome, val incomplete: Boolean)

    private data class V2Record(
        val revision: Long = 0,
        val outcome: Outcome = Outcome(),
        val terminalAt: Long? = null,
        val terminalResult: TerminalResult? = null,
        val requestId: String? = null,
        val requestedAt: Long? = null,
        val attemptId: String? = null,
        val attemptStartedAt: Long? = null,
        val attemptRequestId: String? = null,
        val contacts: ContactsGeneration = ContactsGeneration(),
    )

    private sealed class V2Read {
        data class Valid(val record: V2Record) : V2Read()
        object Absent : V2Read()
        object Malformed : V2Read()
    }

    constructor(context: Context) : this(
        PreferencesStorage(context.applicationContext),
        mainAccountKey = { account ->
            val creationId = AccountManager.get(context.applicationContext)
                .getUserData(account, AccountSettings.KEY_CREATION_ID)
            hashIdentity(account.type, account.name, creationId)
        },
        childAccountKey = { account ->
            AccountManager.get(context.applicationContext)
                .getUserData(account, LocalAddressBook.USER_DATA_CREATION_ID)
                ?.takeIf(::isSafeOpaqueId)
                ?.let { hashIdentity(account.type, account.name, it) }
        },
    )

    fun identity(account: Account) = MainIdentity(mainAccountKey(account))
    internal fun identity(account: Account, creationId: String) = MainIdentity(hashIdentity(account.type, account.name, creationId))
    internal fun childIdentity(account: Account): ChildIdentity? =
        childAccountKey(account)?.takeIf(::isSha256Id)?.let(::ChildIdentity)
    internal fun childIdentity(account: Account, creationId: String): ChildIdentity {
        require(isSafeOpaqueId(creationId))
        return ChildIdentity(hashIdentity(account.type, account.name, creationId))
    }

    @Synchronized
    fun status(account: Account, service: Service): Status = synchronized(STORE_LOCK) {
        status(mainAccountKey(account), service)
    }

    /** Reads a generation captured before a later same-name account replacement. */
    @Synchronized
    internal fun status(identity: MainIdentity, service: Service): Status = synchronized(STORE_LOCK) {
        status(identity.storageKey, service)
    }

    private fun status(identity: String, service: Service): Status {
        val v1Key = recordKey(identity, service)
        val v2Key = v2RecordKey(identity, service)
        val v1 = readV1(v1Key, service)
        val v1Malformed = storage.get(v1Key)?.let { !isValidV1(it, service) } == true
        val v2 = readV2(v2Key, service)
        val result = when (v2) {
            is V2Read.Valid -> statusOf(v2.record, service)
            V2Read.Absent -> statusOf(v1, service, legacyIncomplete = service == Service.CONTACTS && readLegacyContactsIncomplete(v1Key))
                .copy(structuralStorageFailure = v1Malformed)
            V2Read.Malformed -> statusOf(v1, service).copy(
                lastFailureCategory = FailureCategory.STORAGE,
                activeRequestId = null,
                requestedAt = null,
                activeAttemptId = null,
                attemptStartedAt = null,
                attemptRequestId = null,
                latestGenerationIncomplete = false,
                pendingChildren = 0,
                structuralStorageFailure = true,
            )
        }
        return result.failClosedIfNeeded(v1Key, v2Key, service == Service.CONTACTS)
    }

    /** Records all requested services atomically before Android scheduling is attempted. */
    @Synchronized
    fun recordRequested(account: Account, services: Set<Service>, requestId: String, requestedAt: Long): Boolean = synchronized(STORE_LOCK) {
        require(isSafeOpaqueId(requestId))
        requireValidTimestamp(requestedAt)
        val identity = mainAccountKey(account)
        val targeted = services.toSortedSet(compareBy { it.ordinal })
        if (targeted.isEmpty()) return@synchronized true
        val puts = linkedMapOf<String, String>()
        targeted.forEach { service ->
            val current = readOrLegacy(identity, service)
            puts[v2RecordKey(identity, service)] = encodeV2(current.copy(
                revision = nextRevision(current.revision), requestId = requestId, requestedAt = requestedAt,
                attemptId = null, attemptStartedAt = null, attemptRequestId = null,
                contacts = if (service == Service.CONTACTS) ContactsGeneration() else current.contacts,
            ))
        }
        commitLifecycle(puts, targeted.mapTo(linkedSetOf()) { v2FaultKey(identity, it) })
    }

    @Synchronized
    fun beginAttempt(account: Account, service: Service, attemptId: String, startedAt: Long, requestId: String?): Boolean = synchronized(STORE_LOCK) {
        beginAttemptResult(mainAccountKey(account), service, attemptId, startedAt, requestId) == MutationResult.RECORDED
    }

    @Synchronized
    fun beginAttemptResult(account: Account, service: Service, attemptId: String, startedAt: Long, requestId: String?): MutationResult = synchronized(STORE_LOCK) {
        beginAttemptResult(mainAccountKey(account), service, attemptId, startedAt, requestId)
    }

    @Synchronized
    internal fun beginAttemptResult(identity: MainIdentity, service: Service, attemptId: String,
        startedAt: Long, requestId: String?): MutationResult = synchronized(STORE_LOCK) {
        beginAttemptResult(identity.storageKey, service, attemptId, startedAt, requestId)
    }

    private fun beginAttemptResult(identity: String, service: Service, attemptId: String, startedAt: Long, requestId: String?): MutationResult {
        require(isSafeOpaqueId(attemptId))
        require(requestId == null || isSafeOpaqueId(requestId))
        requireValidTimestamp(startedAt)
        val current = readOrLegacy(identity, service)
        if (requestId != null && current.requestId != null && current.requestId != requestId) return MutationResult.REJECTED
        // Android still runs when request evidence could not commit. Its correlated attempt repairs
        // that evidence instead of making the eventual terminal callback a permanent no-op.
        val repairedRequest = requestId?.takeIf { current.requestId == null }
        val next = current.copy(revision = nextRevision(current.revision), requestId = current.requestId ?: repairedRequest,
            requestedAt = current.requestedAt ?: repairedRequest?.let { startedAt }, attemptId = attemptId,
            attemptStartedAt = startedAt, attemptRequestId = requestId?.takeIf { current.requestId == it || repairedRequest != null },
            contacts = if (service == Service.CONTACTS) ContactsGeneration() else current.contacts)
        return commitLifecycleResult(mapOf(v2RecordKey(identity, service) to encodeV2(next)), setOf(v2FaultKey(identity, service)))
    }

    @Synchronized
    fun recordSuccess(account: Account, service: Service, timestamp: Long = System.currentTimeMillis()): Boolean = synchronized(STORE_LOCK) {
        require(service != Service.CONTACTS) { "Contacts outcomes are generation-scoped" }
        recordTerminal(mainAccountKey(account), service, null, null, TerminalResult.SUCCESS, null, timestamp) == MutationResult.RECORDED
    }

    @Synchronized
    fun recordSuccess(account: Account, service: Service, attemptId: String, timestamp: Long): Boolean = synchronized(STORE_LOCK) {
        require(service != Service.CONTACTS) { "Contacts outcomes are generation-scoped" }
        recordSuccessResult(account, service, attemptId, null, timestamp) == MutationResult.RECORDED
    }

    @Synchronized
    fun recordFailure(account: Account, service: Service, category: FailureCategory, timestamp: Long = System.currentTimeMillis()): Boolean = synchronized(STORE_LOCK) {
        require(service != Service.CONTACTS) { "Contacts outcomes are generation-scoped" }
        recordTerminal(mainAccountKey(account), service, null, null, TerminalResult.FAILURE, category, timestamp) == MutationResult.RECORDED
    }

    @Synchronized
    fun recordFailure(account: Account, service: Service, attemptId: String, category: FailureCategory, timestamp: Long): Boolean = synchronized(STORE_LOCK) {
        require(service != Service.CONTACTS) { "Contacts outcomes are generation-scoped" }
        recordFailureResult(account, service, attemptId, null, category, timestamp) == MutationResult.RECORDED
    }

    @Synchronized
    fun recordSuccessResult(account: Account, service: Service, attemptId: String, requestId: String?, timestamp: Long): MutationResult = synchronized(STORE_LOCK) {
        require(service != Service.CONTACTS) { "Contacts outcomes are generation-scoped" }
        recordTerminal(mainAccountKey(account), service, attemptId, requestId, TerminalResult.SUCCESS, null, timestamp)
    }

    @Synchronized
    internal fun recordSuccessResult(identity: MainIdentity, service: Service, attemptId: String,
        requestId: String?, timestamp: Long): MutationResult = synchronized(STORE_LOCK) {
        require(service != Service.CONTACTS) { "Contacts outcomes are generation-scoped" }
        recordTerminal(identity.storageKey, service, attemptId, requestId, TerminalResult.SUCCESS, null, timestamp)
    }

    @Synchronized
    fun recordFailureResult(account: Account, service: Service, attemptId: String, requestId: String?, category: FailureCategory, timestamp: Long): MutationResult = synchronized(STORE_LOCK) {
        require(service != Service.CONTACTS) { "Contacts outcomes are generation-scoped" }
        recordTerminal(mainAccountKey(account), service, attemptId, requestId, TerminalResult.FAILURE, category, timestamp)
    }

    @Synchronized
    internal fun recordFailureResult(identity: MainIdentity, service: Service, attemptId: String,
        requestId: String?, category: FailureCategory, timestamp: Long): MutationResult = synchronized(STORE_LOCK) {
        require(service != Service.CONTACTS) { "Contacts outcomes are generation-scoped" }
        recordTerminal(identity.storageKey, service, attemptId, requestId, TerminalResult.FAILURE, category, timestamp)
    }

    /** Starts a Contacts parent generation when this adapter was not admitted by the shared boundary. */
    @Synchronized
    fun beginContacts(
        account: Account,
        childAccounts: Set<Account>,
        startedAt: Long = System.currentTimeMillis(),
        requestId: String? = null,
        attemptId: String = UUID.randomUUID().toString(),
    ): ContactsStart = synchronized(STORE_LOCK) {
        val identity = mainAccountKey(account)
        val childIdentities = childIdentities(childAccounts) ?: return@synchronized ContactsStart.StorageFailure
        if (beginAttemptResult(identity, Service.CONTACTS, attemptId, startedAt, requestId) != MutationResult.RECORDED)
            return@synchronized ContactsStart.StorageFailure
        attachContactsChildKeys(identity, attemptId, childIdentities.mapTo(sortedSetOf()) { it.storageKey }, startedAt, requestId)
    }

    /** Attaches immutable child evidence to the parent attempt admitted before any early return. */
    @Synchronized
    fun attachContactsChildren(account: Account, attemptId: String, childAccounts: Set<Account>, startedAt: Long,
        requestId: String? = null): ContactsStart = synchronized(STORE_LOCK) {
        val childIdentities = childIdentities(childAccounts) ?: return@synchronized ContactsStart.StorageFailure
        attachContactsChildKeys(mainAccountKey(account), attemptId,
            childIdentities.mapTo(sortedSetOf()) { it.storageKey }, startedAt, requestId)
    }

    @Synchronized
    internal fun attachContactsChildren(identity: MainIdentity, attemptId: String, childIdentities: Set<ChildIdentity>,
        startedAt: Long, requestId: String? = null): ContactsStart = synchronized(STORE_LOCK) {
        attachContactsChildKeys(identity.storageKey, attemptId,
            childIdentities.mapTo(sortedSetOf()) { it.storageKey }, startedAt, requestId)
    }

    private fun attachContactsChildKeys(identity: String, attemptId: String, expected: Set<String>, startedAt: Long,
        requestId: String?): ContactsStart {
        require(isSafeOpaqueId(attemptId))
        require(requestId == null || isSafeOpaqueId(requestId))
        val current = readOrLegacy(identity, Service.CONTACTS)
        require(expected.all(::isSha256Id))
        val repairingFailedAdmission = current.attemptId == null &&
            hasLifecycleFault(identity, Service.CONTACTS) &&
            (requestId == null || current.requestId == null || current.requestId == requestId)
        if (current.attemptId != attemptId && !repairingFailedAdmission) return ContactsStart.StorageFailure
        // The real parent sync is allowed to run after its initial lifecycle commit fails. Admit
        // that same correlated generation here, where its complete immutable child set is known.
        // A current/newer attempt is never replaced, and a successful newer lifecycle write has
        // already cleared the fault sentinel, so stale generations remain rejected.
        val repairedRequest = requestId?.takeIf { current.requestId == null }
        val admitted = if (repairingFailedAdmission) current.copy(
            requestId = current.requestId ?: repairedRequest,
            requestedAt = current.requestedAt ?: repairedRequest?.let { startedAt },
            attemptId = attemptId,
            attemptStartedAt = startedAt,
            attemptRequestId = requestId?.takeIf { current.requestId == it || repairedRequest != null },
            contacts = ContactsGeneration(expected),
        ) else current.copy(contacts = ContactsGeneration(expected))
        if (expected.isEmpty()) {
            return if (recordTerminal(identity, Service.CONTACTS, attemptId, requestId,
                    TerminalResult.FAILURE, FailureCategory.SETUP_REQUIRED, startedAt) == MutationResult.RECORDED)
                ContactsStart.SetupRequired else ContactsStart.StorageFailure
        }
        val next = admitted.copy(revision = nextRevision(current.revision))
        return if (commitLifecycle(mapOf(v2RecordKey(identity, Service.CONTACTS) to encodeV2(next)),
                setOf(v2FaultKey(identity, Service.CONTACTS)))) ContactsStart.Started(attemptId) else ContactsStart.StorageFailure
    }

    @Synchronized
    fun failContactsParent(account: Account, attemptId: String, category: FailureCategory = FailureCategory.PARENT_REFRESH): Boolean = synchronized(STORE_LOCK) {
        return@synchronized failContactsParentResult(account, attemptId, null, category) == MutationResult.RECORDED
    }

    @Synchronized
    fun failContactsParentResult(account: Account, attemptId: String, requestId: String? = null,
        category: FailureCategory = FailureCategory.PARENT_REFRESH): MutationResult = synchronized(STORE_LOCK) {
        failContactsParentResult(MainIdentity(mainAccountKey(account)), attemptId, requestId, category)
    }

    @Synchronized
    internal fun failContactsParentResult(identity: MainIdentity, attemptId: String, requestId: String? = null,
        category: FailureCategory = FailureCategory.PARENT_REFRESH): MutationResult = synchronized(STORE_LOCK) {
        recordTerminal(identity.storageKey, Service.CONTACTS, attemptId, requestId,
            TerminalResult.FAILURE, category, System.currentTimeMillis())
    }

    @Synchronized
    fun recordContactsChild(account: Account, attemptId: String, childAccount: Account, result: ChildResult,
        failureCategory: FailureCategory = FailureCategory.PROVIDER, timestamp: Long = System.currentTimeMillis()): ChildWrite = synchronized(STORE_LOCK) {
        val identity = mainAccountKey(account)
        val childIdentity = childIdentity(childAccount) ?: return@synchronized ChildWrite.REJECTED
        recordContactsChild(identity, attemptId, childIdentity, result, failureCategory, timestamp)
    }

    @Synchronized
    internal fun recordContactsChild(identity: MainIdentity, attemptId: String, childIdentity: ChildIdentity, result: ChildResult,
        failureCategory: FailureCategory = FailureCategory.PROVIDER,
        timestamp: Long = System.currentTimeMillis()): ChildWrite = synchronized(STORE_LOCK) {
        recordContactsChild(identity.storageKey, attemptId, childIdentity, result, failureCategory, timestamp)
    }

    private fun recordContactsChild(identity: String, attemptId: String, childIdentity: ChildIdentity, result: ChildResult,
        failureCategory: FailureCategory, timestamp: Long): ChildWrite {
        val current = readOrLegacy(identity, Service.CONTACTS)
        val child = childIdentity.storageKey
        require(isSafeOpaqueId(attemptId))
        require(isSha256Id(child))
        if (current.attemptId != attemptId || child !in current.contacts.expected || child in current.contacts.terminal)
            return ChildWrite.REJECTED
        val category = when (result) {
            ChildResult.FAILURE -> failureCategory
            ChildResult.REMOVED -> FailureCategory.CHILD_REMOVED
            ChildResult.SUCCESS, ChildResult.SKIPPED -> null
        }
        require(isValidChildResultCategory(result, category))
        val terminal = current.contacts.terminal + (child to (result to category))
        if (terminal.keys != current.contacts.expected) {
            val next = current.copy(revision = nextRevision(current.revision), contacts = current.contacts.copy(terminal = terminal))
            return if (commitLifecycle(mapOf(v2RecordKey(identity, Service.CONTACTS) to encodeV2(next)),
                    setOf(v2FaultKey(identity, Service.CONTACTS)))) ChildWrite.RECORDED else ChildWrite.STORAGE_FAILURE
        }
        val failure = terminal.values.mapNotNull { it.second }.minByOrNull(::childFailureRank)
        val written = if (failure == null && terminal.values.any { it.first == ChildResult.SKIPPED })
            finishWithoutOutcomeResult(identity, Service.CONTACTS, attemptId) == MutationResult.RECORDED
        else if (failure == null)
            recordTerminal(identity, Service.CONTACTS, attemptId, null, TerminalResult.SUCCESS, null, timestamp) == MutationResult.RECORDED
        else recordTerminal(identity, Service.CONTACTS, attemptId, null, TerminalResult.FAILURE, failure, timestamp) == MutationResult.RECORDED
        return if (written) ChildWrite.RECORDED else ChildWrite.STORAGE_FAILURE
    }

    @Synchronized
    fun recordContactsChildRemoved(account: Account, childAccount: Account): Boolean = synchronized(STORE_LOCK) {
        recordContactsChildRemoved(MainIdentity(mainAccountKey(account)), childAccount)
    }

    /** Uses the main generation captured before asynchronous child-account removal. */
    @Synchronized
    internal fun recordContactsChildRemoved(identity: MainIdentity, childAccount: Account): Boolean = synchronized(STORE_LOCK) {
        val childIdentity = childIdentity(childAccount) ?: return@synchronized false
        recordContactsChildRemoved(identity, childIdentity)
    }

    /** Uses both generations captured before asynchronous child-account removal. */
    @Synchronized
    internal fun recordContactsChildRemoved(identity: MainIdentity, childIdentity: ChildIdentity): Boolean = synchronized(STORE_LOCK) {
        val attempt = readOrLegacy(identity.storageKey, Service.CONTACTS).attemptId ?: return@synchronized false
        recordContactsChild(identity.storageKey, attempt, childIdentity, ChildResult.REMOVED,
            FailureCategory.PROVIDER, System.currentTimeMillis()) == ChildWrite.RECORDED
    }

    private fun childIdentities(accounts: Set<Account>): Set<ChildIdentity>? {
        val identities = accounts.mapNotNull(::childIdentity).toSet()
        return identities.takeIf { it.size == accounts.size }
    }

    @Synchronized
    fun finishWithoutOutcome(account: Account, service: Service, attemptId: String): Boolean = synchronized(STORE_LOCK) {
        finishWithoutOutcomeResult(mainAccountKey(account), service, attemptId) == MutationResult.RECORDED
    }

    @Synchronized
    fun finishWithoutOutcomeResult(account: Account, service: Service, attemptId: String): MutationResult = synchronized(STORE_LOCK) {
        finishWithoutOutcomeResult(mainAccountKey(account), service, attemptId)
    }

    @Synchronized
    internal fun finishWithoutOutcomeResult(identity: MainIdentity, service: Service, attemptId: String): MutationResult =
        synchronized(STORE_LOCK) {
            finishWithoutOutcomeResult(identity.storageKey, service, attemptId)
        }

    private fun finishWithoutOutcomeResult(identity: String, service: Service, attemptId: String): MutationResult {
        val current = readOrLegacy(identity, service)
        if (current.attemptId != attemptId) return MutationResult.REJECTED
        val next = current.copy(revision = nextRevision(current.revision),
            requestId = current.requestId?.takeUnless { current.attemptRequestId != null },
            requestedAt = current.requestedAt?.takeUnless { current.attemptRequestId != null },
            attemptId = null, attemptStartedAt = null, attemptRequestId = null, contacts = ContactsGeneration())
        return commitLifecycleResult(mapOf(v2RecordKey(identity, service) to encodeV2(next)), setOf(v2FaultKey(identity, service)))
    }

    @Synchronized
    fun rebaseFutureLifecycle(account: Account, service: Service, now: Long): Boolean = synchronized(STORE_LOCK) {
        rebaseFutureLifecycleResult(MainIdentity(mainAccountKey(account)), service, now) == MutationResult.RECORDED
    }

    @Synchronized
    fun rebaseFutureLifecycleResult(account: Account, service: Service, now: Long): MutationResult = synchronized(STORE_LOCK) {
        rebaseFutureLifecycleResult(MainIdentity(mainAccountKey(account)), service, now)
    }

    @Synchronized
    internal fun rebaseFutureLifecycle(identity: MainIdentity, service: Service, now: Long): Boolean = synchronized(STORE_LOCK) {
        return@synchronized rebaseFutureLifecycleResult(identity, service, now) == MutationResult.RECORDED
    }

    private fun rebaseFutureLifecycleResult(identity: MainIdentity, service: Service, now: Long): MutationResult {
        requireValidTimestamp(now)
        val current = readOrLegacy(identity.storageKey, service)
        val next = current.copy(
            requestedAt = current.requestedAt?.takeIf { it <= now } ?: current.requestedAt?.let { now },
            attemptStartedAt = current.attemptStartedAt?.takeIf { it <= now } ?: current.attemptStartedAt?.let { now },
        )
        if (next == current) return MutationResult.RECORDED
        return commitLifecycleResult(mapOf(v2RecordKey(identity.storageKey, service) to encodeV2(next.copy(revision = nextRevision(current.revision)))),
            setOf(v2FaultKey(identity.storageKey, service)))
    }

    @Synchronized
    fun expireStale(account: Account, service: Service, now: Long, platformActive: Boolean, platformPending: Boolean,
        interruptionAfterMillis: Long = DEFAULT_INTERRUPTION_AFTER_MILLIS): Boolean = synchronized(STORE_LOCK) {
        return@synchronized expireStaleResult(MainIdentity(mainAccountKey(account)), service, now, platformActive, platformPending,
            interruptionAfterMillis) == MutationResult.RECORDED
    }

    @Synchronized
    fun expireStaleResult(account: Account, service: Service, now: Long, platformActive: Boolean, platformPending: Boolean,
        interruptionAfterMillis: Long = DEFAULT_INTERRUPTION_AFTER_MILLIS): MutationResult = synchronized(STORE_LOCK) {
        expireStaleResult(MainIdentity(mainAccountKey(account)), service, now, platformActive, platformPending, interruptionAfterMillis)
    }

    @Synchronized
    internal fun expireStale(identity: MainIdentity, service: Service, now: Long, platformActive: Boolean, platformPending: Boolean,
        interruptionAfterMillis: Long = DEFAULT_INTERRUPTION_AFTER_MILLIS): Boolean = synchronized(STORE_LOCK) {
        return@synchronized expireStaleResult(identity, service, now, platformActive, platformPending, interruptionAfterMillis) == MutationResult.RECORDED
    }

    private fun expireStaleResult(identity: MainIdentity, service: Service, now: Long, platformActive: Boolean, platformPending: Boolean,
        interruptionAfterMillis: Long): MutationResult {
        val current = readOrLegacy(identity.storageKey, service)
        // A failed rebase leaves an untrusted future timestamp. Do not turn that failed repair
        // into an interruption using stale wall-clock evidence.
        if (hasLifecycleFault(identity.storageKey, service)) return MutationResult.REJECTED
        val lifecycleAt = current.attemptStartedAt ?: current.requestedAt ?: return MutationResult.RECORDED
        // These are successful observations that require no write. REJECTED is reserved for stale
        // correlation or unsafe evidence; boolean callers therefore keep their success semantics.
        if (platformActive || platformPending || age(now, lifecycleAt) < interruptionAfterMillis)
            return MutationResult.RECORDED
        return recordTerminal(identity.storageKey, service, current.attemptId, null, TerminalResult.FAILURE, FailureCategory.INTERRUPTED, now,
            requireAttempt = current.attemptId != null)
    }

    @Synchronized
    fun clear(account: Account): Boolean = clear(identity(account))

    /** Clears both namespaces only after confirmed exact-generation removal. */
    @Synchronized
    fun clear(identity: MainIdentity): Boolean = synchronized(STORE_LOCK) {
        val v1 = Service.values().mapTo(linkedSetOf()) { recordKey(identity.storageKey, it) }
        val v2 = Service.values().mapTo(linkedSetOf()) { v2RecordKey(identity.storageKey, it) }
        val removes = linkedSetOf<String>().apply {
            addAll(v1); addAll(v2); addAll(v1.map(::faultKey)); addAll(v2.map(::faultKey))
        }
        val committed = storage.commit(removes = removes)
        if (committed) (v1 + v2).forEach { failedWrites.remove(it) } else persistFaults(v1 + v2)
        committed
    }

    private fun recordTerminal(identity: String, service: Service, attemptId: String?, repairRequestId: String?, result: TerminalResult,
        category: FailureCategory?, timestamp: Long, requireAttempt: Boolean = attemptId != null): MutationResult {
        requireValidTimestamp(timestamp)
        val current = readOrLegacy(identity, service)
        if (!requireAttempt && attemptId == null && current.attemptId != null) return MutationResult.REJECTED
        val repairingFailedAdmission = requireAttempt && current.attemptId == null &&
            hasLifecycleFault(identity, service) &&
            (repairRequestId == null || current.requestId == null || current.requestId == repairRequestId)
        if (requireAttempt && current.attemptId != attemptId && !repairingFailedAdmission) return MutationResult.REJECTED
        // V2 revision and terminal result establish event order; retain its observed wall-clock time.
        val at = timestamp
        val outcome = when (result) {
            TerminalResult.SUCCESS -> current.outcome.copy(successAt = at)
            TerminalResult.FAILURE -> current.outcome.copy(failureAt = at, failureCategory = requireNotNull(category))
        }
        // A request-only lifecycle is the stale work being terminalized. Preserve a request only
        // when a separate, uncorrelated attempt produced this terminal outcome.
        val retainUnrelatedRequest = current.requestId != null &&
            ((current.attemptId != null && current.attemptRequestId == null) ||
                (repairingFailedAdmission && repairRequestId == null))
        val terminal = current.copy(revision = nextRevision(current.revision), outcome = outcome, terminalAt = at,
            terminalResult = result, requestId = current.requestId.takeIf { retainUnrelatedRequest },
            requestedAt = current.requestedAt.takeIf { retainUnrelatedRequest }, attemptId = null, attemptStartedAt = null,
            attemptRequestId = null, contacts = ContactsGeneration())
        val v2Key = v2RecordKey(identity, service)
        val v1Key = recordKey(identity, service)
        val shadow = if (result == TerminalResult.SUCCESS) Outcome(successAt = shadowAt(at, readV1(v1Key, service)))
        // interrupted -> FailureCategory.UNKNOWN keeps frozen v1 readers conservative and valid.
        else Outcome(failureAt = shadowAt(at, readV1(v1Key, service)),
            failureCategory = if (category == FailureCategory.INTERRUPTED) FailureCategory.UNKNOWN else category)
        val v1Value = if (service == Service.CONTACTS) encodeLegacyContacts(shadow) else encodeOutcome(shadow)
        return commitTerminalResult(mapOf(v2Key to encodeV2(terminal), v1Key to v1Value), v1Key, v2Key)
    }

    /** Terminal repair clears both namespaces only after the full atomic commit succeeds. */
    private fun commitTerminalResult(puts: Map<String, String>, v1Key: String, v2Key: String): MutationResult {
        val committed = storage.commit(puts, removeBothFaultSentinels(v1Key, v2Key))
        if (committed) {
            failedWrites.remove(v1Key)
            failedWrites.remove(v2Key)
        } else persistFaults(setOf(v1Key, v2Key), retainInProcess = true)
        return if (committed) MutationResult.RECORDED else MutationResult.STORAGE_FAILURE
    }

    private fun removeBothFaultSentinels(v1Key: String, v2Key: String) = setOf(faultKey(v1Key), faultKey(v2Key))

    private fun commitLifecycle(puts: Map<String, String>, removes: Set<String>): Boolean {
        return commitLifecycleResult(puts, removes) == MutationResult.RECORDED
    }

    private fun commitLifecycleResult(puts: Map<String, String>, removes: Set<String>): MutationResult {
        val committed = storage.commit(puts, removes)
        if (committed) puts.keys.forEach { failedWrites.remove(it) } else persistFaults(puts.keys)
        return if (committed) MutationResult.RECORDED else MutationResult.STORAGE_FAILURE
    }

    private fun hasLifecycleFault(identity: String, service: Service): Boolean {
        val key = v2RecordKey(identity, service)
        return storage.get(faultKey(key)) != null || failedWrites.containsKey(key)
    }

    private fun readOrLegacy(identity: String, service: Service) = when (val v2 = readV2(v2RecordKey(identity, service), service)) {
        is V2Read.Valid -> v2.record
        else -> legacyAsV2(readV1(recordKey(identity, service), service), service)
    }

    private fun legacyAsV2(outcome: Outcome, service: Service): V2Record {
        val terminalAt = outcome.latestTimestamp()
        val result = terminalAt?.let { if (outcome.failureAt == it) TerminalResult.FAILURE else TerminalResult.SUCCESS }
        return V2Record(outcome = outcome, terminalAt = terminalAt, terminalResult = result,
            contacts = if (service == Service.CONTACTS) ContactsGeneration() else ContactsGeneration())
    }

    private fun statusOf(record: V2Record, service: Service, legacyIncomplete: Boolean = false): Status {
        val pending = (record.contacts.expected - record.contacts.terminal.keys).size
        return Status(record.outcome.successAt, record.outcome.failureAt, record.outcome.failureCategory,
            record.terminalAt, record.terminalResult, record.requestId, record.requestedAt, record.attemptId,
            record.attemptStartedAt, record.attemptRequestId,
            legacyIncomplete || (service == Service.CONTACTS && record.attemptId != null && pending > 0), pending)
    }

    private fun statusOf(outcome: Outcome, service: Service, legacyIncomplete: Boolean = false): Status {
        val terminalAt = outcome.latestTimestamp()
        val terminal = terminalAt?.let {
            if ((outcome.failureAt ?: Long.MIN_VALUE) >= (outcome.successAt ?: Long.MIN_VALUE)) TerminalResult.FAILURE else TerminalResult.SUCCESS
        }
        return Status(outcome.successAt, outcome.failureAt, outcome.failureCategory, terminalAt, terminal,
            latestGenerationIncomplete = legacyIncomplete && service == Service.CONTACTS)
    }

    private fun Status.failClosedIfNeeded(v1Key: String, v2Key: String, contacts: Boolean): Status {
        val rawFaults = listOf(v2Key, v1Key).map { key -> storage.get(faultKey(key)) }
        val malformedFault = rawFaults.any { it != null && decodeFault(it) == null }
        val fault = listOf(v2Key, v1Key).mapNotNull { key ->
            storage.get(faultKey(key))?.let(::decodeFault) ?: failedWrites[key]
        }.firstOrNull()
        if (fault == null && !malformedFault) return this
        return copy(lastFailureAt = maxOf(lastFailureAt ?: 0L, fault ?: 0L), lastFailureCategory = FailureCategory.STORAGE,
            latestGenerationIncomplete = latestGenerationIncomplete || contacts, structuralStorageFailure = true)
    }

    private fun readV2(key: String, service: Service): V2Read {
        val value = storage.get(key) ?: return V2Read.Absent
        val parts = value.split('|', limit = 13)
        if (parts.size != 13 || parts[0] != V2_VERSION) return V2Read.Malformed
        val revision = parts[1].toLongOrNull()?.takeIf { it >= 0 } ?: return V2Read.Malformed
        val parsedSuccess = parseOptionalTimestamp(parts[2]); if (parsedSuccess is OptionalValue.Invalid) return V2Read.Malformed
        val parsedFailure = parseOptionalTimestamp(parts[3]); if (parsedFailure is OptionalValue.Invalid) return V2Read.Malformed
        val parsedCategory = parseOptionalEnum<FailureCategory>(parts[4]); if (parsedCategory is OptionalValue.Invalid) return V2Read.Malformed
        val parsedTerminalAt = parseOptionalTimestamp(parts[5]); if (parsedTerminalAt is OptionalValue.Invalid) return V2Read.Malformed
        val parsedTerminal = parseOptionalEnum<TerminalResult>(parts[6]); if (parsedTerminal is OptionalValue.Invalid) return V2Read.Malformed
        val success = (parsedSuccess as OptionalValue.Valid<Long>).value
        val failure = (parsedFailure as OptionalValue.Valid<Long>).value
        val category = (parsedCategory as OptionalValue.Valid<FailureCategory>).value
        val terminalAt = (parsedTerminalAt as OptionalValue.Valid<Long>).value
        val terminal = (parsedTerminal as OptionalValue.Valid<TerminalResult>).value
        val requestId = parts[7].ifBlank { null }
        val parsedRequestedAt = parseOptionalTimestamp(parts[8]); if (parsedRequestedAt is OptionalValue.Invalid) return V2Read.Malformed
        val requestedAt = (parsedRequestedAt as OptionalValue.Valid<Long>).value
        val attemptId = parts[9].ifBlank { null }
        val parsedAttemptAt = parseOptionalTimestamp(parts[10]); if (parsedAttemptAt is OptionalValue.Invalid) return V2Read.Malformed
        val attemptAt = (parsedAttemptAt as OptionalValue.Valid<Long>).value
        val attemptRequest = parts[11].ifBlank { null }
        if ((failure == null) != (category == null) || (terminalAt == null) != (terminal == null) ||
            (requestId == null) != (requestedAt == null) || (attemptId == null) != (attemptAt == null) ||
            (attemptRequest != null && attemptId == null) || (attemptRequest != null && attemptRequest != requestId) ||
            (requestId != null && !isSafeOpaqueId(requestId)) || (attemptId != null && !isSafeOpaqueId(attemptId)) ||
            (attemptRequest != null && !isSafeOpaqueId(attemptRequest))) return V2Read.Malformed
        if ((success != null || failure != null) && terminalAt == null) return V2Read.Malformed
        if (terminal == TerminalResult.SUCCESS && terminalAt != success || terminal == TerminalResult.FAILURE && terminalAt != failure)
            return V2Read.Malformed
        val contacts = decodeContacts(parts[12], service == Service.CONTACTS) ?: return V2Read.Malformed
        if (service == Service.CONTACTS && contacts.hasEvidence() && attemptId == null) return V2Read.Malformed
        if (service == Service.CONTACTS && attemptId != null && contacts.isFullyTerminal()) return V2Read.Malformed
        return V2Read.Valid(V2Record(revision, Outcome(success, failure, category), terminalAt, terminal, requestId,
            requestedAt, attemptId, attemptAt, attemptRequest, contacts))
    }

    private fun encodeV2(record: V2Record) = listOf(V2_VERSION, record.revision, record.outcome.successAt.orEmpty(),
        record.outcome.failureAt.orEmpty(), record.outcome.failureCategory?.name.orEmpty(), record.terminalAt.orEmpty(),
        record.terminalResult?.name.orEmpty(), record.requestId.orEmpty(), record.requestedAt.orEmpty(),
        record.attemptId.orEmpty(), record.attemptStartedAt.orEmpty(), record.attemptRequestId.orEmpty(),
        encodeContacts(record.contacts)).joinToString("|")

    private fun decodeContacts(value: String, contactsService: Boolean): ContactsGeneration? {
        if (!contactsService) return if (value.isEmpty()) ContactsGeneration() else null
        if (value.isEmpty()) return ContactsGeneration()
        val fields = value.split(';', limit = 2)
        if (fields.size != 2) return null
        val expectedRaw = fields[0].split(',').filter { it.isNotBlank() }
        val terminalRaw = fields[1]
        val expected = expectedRaw.toSortedSet()
        val terminal = linkedMapOf<String, Pair<ChildResult, FailureCategory?>>()
        if (expected.isEmpty() || expected.size != expectedRaw.size || expected.any { !isSha256Id(it) }) return null
        terminalRaw.split(',').filter { it.isNotBlank() }.forEach { entry ->
            val pieces = entry.split(':', limit = 3)
            val child = pieces.getOrNull(0).orEmpty()
            val result = nullableEnum<ChildResult>(pieces.getOrNull(1).orEmpty()) ?: return null
            val parsedCategory = parseOptionalEnum<FailureCategory>(pieces.getOrNull(2).orEmpty())
            if (parsedCategory is OptionalValue.Invalid) return null
            val category = (parsedCategory as OptionalValue.Valid<FailureCategory>).value
            if (child !in expected || child in terminal ||
                !isSha256Id(child) || !isValidChildResultCategory(result, category)) return null
            terminal[child] = result to category
        }
        return ContactsGeneration(expected, terminal)
    }

    private fun encodeContacts(contacts: ContactsGeneration): String {
        if (contacts.expected.isEmpty()) return ""
        return contacts.expected.sorted().joinToString(",") + ";" + contacts.terminal.toSortedMap().entries.joinToString(",") {
            "${it.key}:${it.value.first.name}:${it.value.second?.name.orEmpty()}"
        }
    }

    private fun readV1(key: String, service: Service): Outcome = if (service == Service.CONTACTS)
        decodeLegacyContacts(storage.get(key)) else decodeOutcome(storage.get(key))

    private fun isValidV1(value: String, service: Service): Boolean {
        val fields = value.split('|', limit = if (service == Service.CONTACTS) 6 else 4)
        if (fields.size != if (service == Service.CONTACTS) 6 else 4) return false
        if (fields[0] != V1_VERSION) return false
        val success = parseOptionalTimestamp(fields[1]) as? OptionalValue.Valid<Long> ?: return false
        val failure = parseOptionalTimestamp(fields[2]) as? OptionalValue.Valid<Long> ?: return false
        val category = parseOptionalEnum<FailureCategory>(fields[3]) as? OptionalValue.Valid<FailureCategory> ?: return false
        if ((failure.value == null) != (category.value == null) || category.value == FailureCategory.INTERRUPTED) return false
        if (service != Service.CONTACTS) return true
        return readLegacyContacts(value) != null
    }

    private fun readLegacyContactsIncomplete(key: String): Boolean {
        return readLegacyContacts(storage.get(key))?.incomplete == true
    }

    private fun decodeLegacyContacts(value: String?): Outcome {
        return readLegacyContacts(value)?.outcome ?: Outcome(failureAt = 0, failureCategory = FailureCategory.STORAGE)
    }

    private fun readLegacyContacts(value: String?): LegacyContacts? {
        val parts = value?.split('|', limit = 6) ?: return LegacyContacts(Outcome(), false)
        if (parts.size != 6 || parts[0] != V1_VERSION) return null
        val outcome = decodeOutcome(parts.take(4).joinToString("|"))
        if (outcome.failureCategory == FailureCategory.STORAGE && parts[3] != FailureCategory.STORAGE.name) return null
        val attempt = parts[4].ifBlank { null }
        val fields = parts[5].split(';', limit = 2)
        if (fields.size != 2) return null
        val expectedRaw = fields[0].split(',').filter { it.isNotBlank() }
        val expected = expectedRaw.toSet()
        if (expected.size != expectedRaw.size) return null
        val terminal = linkedMapOf<String, ChildResult>()
        for (entry in fields[1].split(',').filter { it.isNotBlank() }) {
            val pieces = entry.split(':', limit = 2)
            val child = pieces.getOrNull(0).orEmpty()
            val result = nullableEnum<ChildResult>(pieces.getOrNull(1).orEmpty()) ?: return null
            if (result == ChildResult.SKIPPED || child !in expected || child in terminal) return null
            terminal[child] = result
        }
        if (attempt == null && expected.isEmpty() && terminal.isEmpty()) return LegacyContacts(outcome, false)
        if (attempt == null || expected.isEmpty()) return null
        return LegacyContacts(outcome, terminal.keys != expected)
    }

    private fun encodeLegacyContacts(outcome: Outcome) = "${encodeOutcome(outcome)}||;"
    private fun decodeOutcome(value: String?): Outcome {
        val parts = value?.split('|', limit = 4) ?: return Outcome()
        if (parts.size != 4 || parts[0] != V1_VERSION) return Outcome(failureAt = 0, failureCategory = FailureCategory.STORAGE)
        val parsedSuccess = parseOptionalTimestamp(parts[1]); if (parsedSuccess is OptionalValue.Invalid) return Outcome(failureAt = 0, failureCategory = FailureCategory.STORAGE)
        val success = (parsedSuccess as OptionalValue.Valid<Long>).value
        val parsedFailure = parseOptionalTimestamp(parts[2]); if (parsedFailure is OptionalValue.Invalid) return Outcome(success, 0, FailureCategory.STORAGE)
        val failure = (parsedFailure as OptionalValue.Valid<Long>).value
        val parsedCategory = parseOptionalEnum<FailureCategory>(parts[3]); if (parsedCategory is OptionalValue.Invalid) return Outcome(success, 0, FailureCategory.STORAGE)
        val category = (parsedCategory as OptionalValue.Valid<FailureCategory>).value
        if ((failure == null) != (category == null) || category == FailureCategory.INTERRUPTED) return Outcome(success, 0, FailureCategory.STORAGE)
        return Outcome(success, failure, category)
    }
    private fun encodeOutcome(outcome: Outcome) = listOf(V1_VERSION, outcome.successAt.orEmpty(), outcome.failureAt.orEmpty(),
        outcome.failureCategory?.name.orEmpty()).joinToString("|")

    private fun nullableTimestamp(value: String): Long? {
        if (value.isEmpty()) return null
        return value.toLongOrNull()?.takeIf { it >= 0 }
    }
    private fun parseOptionalTimestamp(value: String): OptionalValue<Long> = when {
        value.isEmpty() -> OptionalValue.Valid(null)
        value.toLongOrNull()?.let { it >= 0 } == true -> OptionalValue.Valid(value.toLong())
        else -> OptionalValue.Invalid
    }
    private inline fun <reified T : Enum<T>> parseOptionalEnum(value: String): OptionalValue<T> =
        if (value.isEmpty()) OptionalValue.Valid(null) else nullableEnum<T>(value)?.let { OptionalValue.Valid(it) } ?: OptionalValue.Invalid
    private sealed class OptionalValue<out T> {
        data class Valid<T>(val value: T?) : OptionalValue<T>()
        object Invalid : OptionalValue<Nothing>()
    }
    private inline fun <reified T : Enum<T>> nullableEnum(value: String): T? =
        if (value.isEmpty()) null else enumValues<T>().firstOrNull { it.name == value }
    private fun Long?.orEmpty() = this?.toString().orEmpty()
    private fun Outcome.latestTimestamp() = when {
        successAt == null -> failureAt
        failureAt == null -> successAt
        failureAt >= successAt -> failureAt
        else -> successAt
    }
    private fun nextRevision(revision: Long) = if (revision == Long.MAX_VALUE) Long.MAX_VALUE else revision + 1
    private fun requireValidTimestamp(value: Long) = require(value >= 0)
    private fun saturatingOrderedAfter(candidate: Long, previous: Long) = when {
        candidate < 0 -> 0L
        previous == Long.MAX_VALUE -> Long.MAX_VALUE
        else -> maxOf(candidate, previous + 1)
    }
    private fun shadowAt(candidate: Long, shadow: Outcome) = saturatingOrderedAfter(candidate,
        maxOf(shadow.successAt ?: 0L, shadow.failureAt ?: 0L))
    private fun age(now: Long, timestamp: Long) = if (now <= timestamp) 0L else now - timestamp
    private fun childFailureRank(category: FailureCategory) = listOf(FailureCategory.AUTHENTICATION, FailureCategory.PERMISSION,
        FailureCategory.CONFIGURATION, FailureCategory.STORAGE, FailureCategory.NETWORK, FailureCategory.PROVIDER,
         FailureCategory.CHILD_REMOVED, FailureCategory.UNKNOWN).indexOf(category).let { if (it < 0) Int.MAX_VALUE else it }

    private fun ContactsGeneration.hasEvidence() = expected.isNotEmpty() || terminal.isNotEmpty()
    private fun ContactsGeneration.isFullyTerminal() = expected.isNotEmpty() && terminal.keys == expected
    private fun isValidChildResultCategory(result: ChildResult, category: FailureCategory?) = when (result) {
        ChildResult.SUCCESS, ChildResult.SKIPPED -> category == null
        ChildResult.REMOVED -> category == FailureCategory.CHILD_REMOVED
        ChildResult.FAILURE -> category != null && category in CHILD_FAILURE_CATEGORIES
    }
    private fun persistFaults(keys: Set<String>, retainInProcess: Boolean = false) {
        val timestamp = System.currentTimeMillis().coerceAtLeast(0)
        val puts = keys.associate { key ->
            faultKey(key) to "$FAULT_VERSION|${failureTimestampFor(v1ShadowKey(key), timestamp)}|STORAGE"
        }
        if (storage.commit(puts) && !retainInProcess) keys.forEach { failedWrites.remove(it) }
        else keys.forEach { key -> failedWrites[key] = failureTimestampFor(v1ShadowKey(key), timestamp) }
    }
    private fun v1ShadowKey(key: String) = if (key.startsWith("status_v2."))
        "status.${key.removePrefix("status_v2.")}" else key
    private fun failureTimestampFor(key: String, candidate: Long): Long {
        val parts = storage.get(key)?.split('|', limit = 4).orEmpty()
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
        return parts.getOrNull(1)?.toLongOrNull()?.takeIf { parts.size == 3 && parts[0] == FAULT_VERSION && parts[2] == "STORAGE" && it >= 0 }
    }

    private fun recordKey(identity: String, service: Service) = "status.$identity.${service.name}"
    private fun v2RecordKey(identity: String, service: Service) = "status_v2.$identity.${service.name}"
    private fun v2FaultKey(identity: String, service: Service) = "fault.status_v2.$identity.${service.name}"
    private fun faultKey(recordKey: String) = "fault.$recordKey"

    companion object {
        const val EXTRA_CONTACTS_ATTEMPT = "io.silentsuite.sync.CONTACTS_ATTEMPT"
        const val EXTRA_CONTACTS_MAIN_IDENTITY = "io.silentsuite.sync.CONTACTS_MAIN_IDENTITY"
        const val EXTRA_CONTACTS_CHILD_IDENTITY = "io.silentsuite.sync.CONTACTS_CHILD_IDENTITY"
        const val EXTRA_SYNC_ATTEMPT = "io.silentsuite.sync.SYNC_ATTEMPT"
        const val EXTRA_SYNC_MAIN_IDENTITY = "io.silentsuite.sync.SYNC_MAIN_IDENTITY"
        const val DEFAULT_INTERRUPTION_AFTER_MILLIS = 30L * 60L * 1000L
        private const val V1_VERSION = "1"
        private const val V2_VERSION = "2"
        private const val FAULT_VERSION = "1"
        private const val MAX_OPAQUE_ID_LENGTH = 128
        private const val SHA256_HEX_LENGTH = 64
        private val CHILD_FAILURE_CATEGORIES = setOf(FailureCategory.NETWORK, FailureCategory.AUTHENTICATION,
            FailureCategory.PERMISSION, FailureCategory.PROVIDER, FailureCategory.STORAGE,
            FailureCategory.CONFIGURATION, FailureCategory.UNKNOWN)
        private val STORE_LOCK = Any()
        private val failedWrites = mutableMapOf<String, Long>()
        private fun isSafeOpaqueId(value: String) = value.length in 1..MAX_OPAQUE_ID_LENGTH &&
            value.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '.' || it == '_' || it == '-' }
        internal fun identityFromStorageKey(storageKey: String?): MainIdentity? =
            storageKey?.takeIf(::isSha256Id)?.let(::MainIdentity)
        internal fun childIdentityFromStorageKey(storageKey: String?): ChildIdentity? =
            storageKey?.takeIf(::isSha256Id)?.let(::ChildIdentity)
        private fun isSha256Id(value: String) = value.length == SHA256_HEX_LENGTH &&
            value.all { it in '0'..'9' || it in 'a'..'f' }
        private fun hashIdentity(type: String?, name: String?, creationId: String?): String = MessageDigest.getInstance("SHA-256")
            .digest("$type\u0000$name\u0000${creationId.orEmpty()}".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
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
