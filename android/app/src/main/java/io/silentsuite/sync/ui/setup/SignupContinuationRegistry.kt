package io.silentsuite.sync.ui.setup

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Process-only links between hosted signup and the LoginActivity that launched it. */
object SignupContinuationRegistry {
    private val continuations = ConcurrentHashMap<String, String>()

    fun issue(flowId: String): String {
        remove(flowId)
        val token = UUID.randomUUID().toString()
        continuations[token] = flowId
        return token
    }

    fun isValid(token: String?): Boolean = token != null && continuations.containsKey(token)

    fun consume(token: String?, flowId: String): Boolean =
        token != null && continuations.remove(token, flowId)

    fun remove(flowId: String) {
        continuations.entries
            .filter { it.value == flowId }
            .forEach { continuations.remove(it.key, flowId) }
    }
}
