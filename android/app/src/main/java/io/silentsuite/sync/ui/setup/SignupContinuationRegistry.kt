package io.silentsuite.sync.ui.setup

import androidx.annotation.VisibleForTesting
import io.silentsuite.sync.BuildConfig
import java.util.UUID

/** Atomic process-only ownership for hosted-signup continuation tokens. */
object SignupContinuationRegistry {
    enum class ClaimResult {
        NEW_PENDING, SAME_FLOW_PENDING, SAME_FLOW_HANDLED, EXPIRED_SAME_FLOW, OTHER_FLOW, UNKNOWN
    }
    data class ClaimRef(val generation: Long, val deadline: Long)
    sealed class Route {
        data class ROUTABLE(val flowId: String) : Route()
        object UNKNOWN : Route()
    }

    private enum class ClaimState { PENDING, HANDLED }
    private data class Claim(
        val token: String,
        val flowId: String,
        val state: ClaimState,
        val generation: Long,
        val deadline: Long,
    )

    private val activeByFlow = LinkedHashMap<String, String>()
    private val activeByToken = LinkedHashMap<String, String>()
    private val claimsByToken = LinkedHashMap<String, Claim>()

    private var nextGeneration = 1L
    private const val PENDING_MILLIS = 10_000L
    private const val HANDLED_MILLIS = 60_000L

    @Synchronized
    fun issue(flowId: String): String {
        require(flowId.isNotBlank())
        remove(flowId)
        val token = UUID.randomUUID().toString()
        activeByFlow[flowId] = token
        activeByToken[token] = flowId
        return token
    }

    @Synchronized
    fun route(token: String?): Route {
        val now = SetupElapsedClock.now()
        expire(now)
        if (token == null) return Route.UNKNOWN
        activeByToken[token]?.let { return Route.ROUTABLE(it) }
        claimsByToken[token]?.let {
            if (it.state == ClaimState.PENDING && now >= it.deadline) return Route.UNKNOWN
            return Route.ROUTABLE(it.flowId)
        }
        return Route.UNKNOWN
    }

    @Synchronized
    fun claim(token: String?, flowId: String): ClaimResult {
        val now = SetupElapsedClock.now()
        expire(now)
        if (token == null) return ClaimResult.UNKNOWN
        claimsByToken[token]?.let {
            return when {
                it.flowId != flowId -> ClaimResult.OTHER_FLOW
                it.state == ClaimState.PENDING && now >= it.deadline -> ClaimResult.EXPIRED_SAME_FLOW
                it.state == ClaimState.PENDING -> ClaimResult.SAME_FLOW_PENDING
                else -> ClaimResult.SAME_FLOW_HANDLED
            }
        }
        val owner = activeByToken[token] ?: return ClaimResult.UNKNOWN
        if (owner != flowId) return ClaimResult.OTHER_FLOW
        val generation = allocateGeneration()
        activeByToken.remove(token)
        activeByFlow.remove(flowId, token)
        val deadline = checkedDeadline(SetupElapsedClock.now(), PENDING_MILLIS)
        claimsByToken[token] = Claim(token, flowId, ClaimState.PENDING, generation, deadline)
        return ClaimResult.NEW_PENDING
    }

    @Synchronized
    fun markHandled(token: String, flowId: String): Boolean {
        expire()
        val claim = claimsByToken[token] ?: return false
        if (claim.flowId != flowId || claim.state != ClaimState.PENDING ||
            SetupElapsedClock.now() >= claim.deadline) return false
        val generation = allocateGeneration()
        val deadline = checkedDeadline(SetupElapsedClock.now(), HANDLED_MILLIS)
        claimsByToken[token] = claim.copy(
            state = ClaimState.HANDLED,
            generation = generation,
            deadline = deadline,
        )
        return true
    }

    @Synchronized
    fun pendingClaimRef(token: String, flowId: String): ClaimRef? {
        expire()
        val claim = claimsByToken[token] ?: return null
        if (claim.flowId != flowId || claim.state != ClaimState.PENDING) return null
        return ClaimRef(claim.generation, claim.deadline)
    }

    @Synchronized
    fun rollbackExpired(token: String, flowId: String, reference: ClaimRef): Boolean {
        val claim = claimsByToken[token] ?: return false
        if (claim.flowId != flowId || claim.state != ClaimState.PENDING ||
            claim.generation != reference.generation || claim.deadline != reference.deadline ||
            SetupElapsedClock.now() < reference.deadline) return false
        return claimsByToken.remove(token, claim)
    }

    @Synchronized
    fun revoke(token: String, flowId: String): Boolean {
        val activeRemoved = activeByToken.remove(token, flowId)
        if (activeRemoved) activeByFlow.remove(flowId, token)
        val claim = claimsByToken[token]
        val claimRemoved = claim?.flowId == flowId && claimsByToken.remove(token, claim)
        return activeRemoved || claimRemoved
    }

    @Synchronized
    fun isValid(token: String?): Boolean = route(token) is Route.ROUTABLE

    @Synchronized
    fun remove(flowId: String) {
        activeByFlow.remove(flowId)?.let { activeByToken.remove(it, flowId) }
        claimsByToken.entries.removeAll { it.value.flowId == flowId }
    }

    @Synchronized
    @VisibleForTesting
    internal fun resetForTests() {
        check(BuildConfig.DEBUG)
        activeByFlow.clear()
        activeByToken.clear()
        claimsByToken.clear()
        nextGeneration = 1L
    }

    @Synchronized
    @VisibleForTesting
    internal fun isEmptyForTests(): Boolean {
        check(BuildConfig.DEBUG)
        return activeByFlow.isEmpty() && activeByToken.isEmpty() && claimsByToken.isEmpty()
    }

    private fun expire(now: Long = SetupElapsedClock.now()) {
        claimsByToken.entries.removeAll {
            it.value.state == ClaimState.HANDLED && now >= it.value.deadline
        }
    }


    private fun allocateGeneration(): Long {
        if (nextGeneration <= 0) error("Continuation generation invalid")
        if (nextGeneration == Long.MAX_VALUE) error("Continuation generation exhausted")
        val generation = nextGeneration
        nextGeneration += 1
        return generation
    }

    private fun checkedDeadline(now: Long, duration: Long): Long =
        if (now > Long.MAX_VALUE - duration) Long.MAX_VALUE else now + duration
}
