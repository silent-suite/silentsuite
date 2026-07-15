package io.silentsuite.sync.ui

/** Fail-closed selection policy independent of Android account I/O. */
object ActiveAccountRoutingPolicy {
    data class Candidate(val name: String, val creationId: String)
    fun select(savedName: String?, savedGeneration: String?, eligible: List<Candidate>): Candidate? =
        if (savedGeneration != null)
            eligible.singleOrNull { it.name == savedName && it.creationId == savedGeneration }
        else if (savedName != null)
            eligible.singleOrNull { it.name == savedName }
        else eligible.singleOrNull()
}
