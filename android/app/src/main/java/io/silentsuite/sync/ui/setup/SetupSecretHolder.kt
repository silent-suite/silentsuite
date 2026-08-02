package io.silentsuite.sync.ui.setup

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.VisibleForTesting
import io.silentsuite.sync.BuildConfig
import java.lang.ref.WeakReference
import java.util.UUID

/** One injectable elapsed clock for every account-entry deadline. */
internal object SetupElapsedClock {
    @Volatile
    internal var nowForTest: (() -> Long)? = null
        set(value) {
            check(value == null || BuildConfig.DEBUG)
            field = value
        }

    fun now(): Long {
        val testClock = nowForTest
        if (testClock != null) {
            check(BuildConfig.DEBUG)
            return testClock()
        }
        return SystemClock.elapsedRealtime()
    }
}

/** Process-only setup material, isolated by an opaque owner lease. */
object SetupSecretHolder {
    const val LEASE_REF_VERSION = 1
    enum class LeaseKind { LOGIN, CREDENTIAL_CHANGE }
    enum class LeaseState { UNBOUND, BOUND, REBINDING, RETIRED }
    enum class CommitKind { HOLDER_MUTATION, SETTINGS_WRITE, FRAGMENT_COMMIT, AUTHENTICATOR_RESULT, UI_PUBLICATION, DISMISSAL }

    data class OwnerLease(val ownerId: String, val generation: Long, val kind: LeaseKind)
    data class LeaseRefV1(val ownerId: String, val generation: Long, val kind: LeaseKind)
    data class BindingToken internal constructor(
        val lease: OwnerLease,
        internal val bindingGeneration: Long,
        internal val instanceNonce: String,
    )
    data class OperationToken internal constructor(
        val lease: OwnerLease,
        internal val revision: Long,
        val credentials: LoginCredentials?,
        val configuration: BaseConfigurationFinder.Configuration?,
    )

    private data class Record(
        val lease: OwnerLease,
        var credentials: LoginCredentials?,
        var configuration: BaseConfigurationFinder.Configuration?,
        var state: LeaseState,
        var deadline: Long,
        var revision: Long,
        val tracksBinding: Boolean,
        var bindingGeneration: Long,
        var instanceNonce: String?,
        var boundOwner: WeakReference<Any>?,
        val committed: MutableSet<CommitKind> = mutableSetOf(),
    )

    private val records = LinkedHashMap<String, Record>()
    private val handler = Handler(Looper.getMainLooper())
    private var nextGeneration = 1L
    private const val UNBOUND_MILLIS = 5_000L
    private const val REBIND_MILLIS = 2_000L

    @Synchronized
    fun issue(kind: LeaseKind, credentials: LoginCredentials? = null, bound: Boolean = true): OwnerLease {
        if (nextGeneration <= 0) error("Setup lease generation invalid")
        if (nextGeneration == Long.MAX_VALUE) error("Setup lease generation exhausted")
        val generation = nextGeneration
        nextGeneration += 1
        val lease = OwnerLease(UUID.randomUUID().toString(), generation, kind)
        val now = SetupElapsedClock.now()
        records[lease.ownerId] = Record(
            lease,
            credentials,
            null,
            if (bound) LeaseState.BOUND else LeaseState.UNBOUND,
            if (bound) Long.MAX_VALUE else checkedDeadline(now, UNBOUND_MILLIS),
            0,
            tracksBinding = !bound,
            bindingGeneration = 0,
            instanceNonce = null,
            boundOwner = null,
        )
        if (!bound) scheduleExpiry(lease, 0, records.getValue(lease.ownerId).deadline)
        return lease
    }

    fun reference(lease: OwnerLease) = LeaseRefV1(lease.ownerId, lease.generation, lease.kind)

    @Synchronized
    fun resolve(reference: LeaseRefV1): OwnerLease? = current(reference.ownerId, reference.generation, reference.kind)?.lease

    @Synchronized
    fun bind(lease: OwnerLease, candidate: Any, instanceNonce: String): BindingToken? {
        val record = current(lease) ?: return null
        if (!record.tracksBinding || instanceNonce.isBlank()) return null
        val bound = record.boundOwner?.get()
        if (record.state == LeaseState.BOUND && bound != null && bound !== candidate) return null
        if (record.bindingGeneration == Long.MAX_VALUE) return retire(record).let { null }
        record.bindingGeneration += 1
        record.instanceNonce = instanceNonce
        record.boundOwner = WeakReference(candidate)
        record.state = LeaseState.BOUND
        record.deadline = Long.MAX_VALUE
        advanceRevision(record)
        return BindingToken(record.lease, record.bindingGeneration, instanceNonce)
    }

    @Synchronized
    fun releaseBinding(token: BindingToken, candidate: Any, changingConfigurations: Boolean): Boolean {
        val record = current(token.lease) ?: return false
        if (!record.tracksBinding || record.bindingGeneration != token.bindingGeneration ||
            record.instanceNonce != token.instanceNonce || record.boundOwner?.get() !== candidate) return false
        if (!changingConfigurations) return retire(record)
        record.state = LeaseState.REBINDING
        record.boundOwner = WeakReference(null)
        record.deadline = checkedDeadline(SetupElapsedClock.now(), REBIND_MILLIS)
        advanceRevision(record)
        scheduleExpiry(record.lease, record.bindingGeneration, record.deadline)
        return true
    }

    @Synchronized
    fun compareBinding(token: BindingToken, candidate: Any): Boolean {
        val record = current(token.lease) ?: return false
        return record.tracksBinding && record.state == LeaseState.BOUND &&
            record.bindingGeneration == token.bindingGeneration &&
            record.instanceNonce == token.instanceNonce && record.boundOwner?.get() === candidate
    }

    @Synchronized
    fun setLoginCredentials(lease: OwnerLease, credentials: LoginCredentials): Boolean = current(lease)?.let {
        it.credentials = credentials
        advanceRevision(it)
        true
    } ?: false

    @Synchronized
    fun getLoginCredentials(lease: OwnerLease): LoginCredentials? = current(lease)?.credentials

    @Synchronized
    fun clearLoginCredentials(lease: OwnerLease): Boolean = current(lease)?.let {
        it.credentials = null
        advanceRevision(it)
        true
    } ?: false

    @Synchronized
    fun setPendingConfiguration(lease: OwnerLease, configuration: BaseConfigurationFinder.Configuration): Boolean = current(lease)?.let {
        it.configuration = configuration
        advanceRevision(it)
        true
    } ?: false

    @Synchronized
    fun getPendingConfiguration(lease: OwnerLease): BaseConfigurationFinder.Configuration? = current(lease)?.configuration

    @Synchronized
    fun clearCredentialsAndConfiguration(lease: OwnerLease): Boolean = current(lease)?.let {
        it.credentials = null
        it.configuration = null
        advanceRevision(it)
        true
    } ?: false

    @Synchronized
    fun beginOperation(lease: OwnerLease): OperationToken? = current(lease)?.let {
        OperationToken(it.lease, it.revision, it.credentials, it.configuration)
    }

    @Synchronized
    fun commitIfCurrent(token: OperationToken, kind: CommitKind): Boolean {
        val record = current(token.lease) ?: return false
        if (record.revision != token.revision || !record.committed.add(kind)) return false
        return true
    }

    /** Retire only authority that has not been claimed by a live bound replacement. */
    @Synchronized
    fun retireUnboundOrRebinding(lease: OwnerLease): Boolean {
        val record = current(lease) ?: return false
        if (!record.tracksBinding || record.state == LeaseState.BOUND) return false
        retire(record)
        return true
    }

    @Synchronized
    fun compareOperation(token: OperationToken): Boolean =
        current(token.lease)?.revision == token.revision

    @Synchronized
    fun compareCurrent(lease: OwnerLease): Boolean = current(lease) != null

    @Synchronized
    fun revoke(lease: OwnerLease): Boolean {
        val record = current(lease) ?: return false
        return retire(record)
    }

    /** Instrumentation-only process reset; release callers fail closed. */
    @Synchronized
    @VisibleForTesting
    internal fun resetForTests() {
        check(BuildConfig.DEBUG)
        records.values.forEach {
            it.credentials = null
            it.configuration = null
            it.state = LeaseState.RETIRED
        }
        records.clear()
        SetupElapsedClock.nowForTest = null
    }

    @VisibleForTesting
    @Synchronized
    internal fun isEmptyForTests(): Boolean {
        check(BuildConfig.DEBUG)
        return records.isEmpty()
    }

    private fun current(lease: OwnerLease): Record? = current(lease.ownerId, lease.generation, lease.kind)

    private fun current(ownerId: String, generation: Long, kind: LeaseKind): Record? {
        val record = records[ownerId] ?: return null
        if (record.lease.generation != generation || record.lease.kind != kind || record.state == LeaseState.RETIRED) return null
        if (record.tracksBinding && record.state == LeaseState.BOUND && record.boundOwner?.get() == null) {
            retireWeakOwner(record)
            return null
        }
        if ((record.state == LeaseState.UNBOUND || record.state == LeaseState.REBINDING) &&
            SetupElapsedClock.now() >= record.deadline) {
            retire(record)
            return null
        }
        return record
    }

    private fun advanceRevision(record: Record) {
        if (record.revision == Long.MAX_VALUE) {
            retire(record)
            return
        }
        record.revision += 1
        record.committed.clear()
    }

    private fun retireWeakOwner(record: Record): Boolean = retire(record)

    private fun retire(record: Record): Boolean {
        record.credentials = null
        record.configuration = null
        record.state = LeaseState.RETIRED
        record.boundOwner = null
        record.instanceNonce = null
        return records.remove(record.lease.ownerId, record)
    }

    private fun scheduleExpiry(lease: OwnerLease, bindingGeneration: Long, deadline: Long) {
        val delay = (deadline - SetupElapsedClock.now()).coerceAtLeast(0L)
        handler.postDelayed({ retireExpired(lease, bindingGeneration, deadline) }, delay)
    }

    @Synchronized
    private fun retireExpired(lease: OwnerLease, bindingGeneration: Long, deadline: Long) {
        val record = records[lease.ownerId] ?: return
        if (record.lease != lease || record.bindingGeneration != bindingGeneration || record.deadline != deadline ||
            record.state !in setOf(LeaseState.UNBOUND, LeaseState.REBINDING) ||
            SetupElapsedClock.now() < deadline) return
        retire(record)
    }

    private fun checkedDeadline(now: Long, duration: Long): Long =
        if (now > Long.MAX_VALUE - duration) Long.MAX_VALUE else now + duration
}
