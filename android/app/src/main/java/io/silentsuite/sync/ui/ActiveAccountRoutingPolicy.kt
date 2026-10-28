package io.silentsuite.sync.ui

/**
 * Fail-closed selection policy independent of Android account I/O. A saved generation selects only its
 * exact row, unless no row of the app type carries the saved name at all: [savedNamePresent] comes from
 * raw membership before any generation filtering, so a same-name row with another generation or none
 * still blocks. Only then is it treated like nothing saved, and only a sole eligible row is chosen.
 */
object ActiveAccountRoutingPolicy {
    data class Candidate(val name: String, val creationId: String)

    /** The saved exact identity names a row that no longer exists in any generation. */
    fun savedNameAbsent(savedName: String?, savedGeneration: String?, savedNamePresent: Boolean): Boolean =
        savedName != null && savedGeneration != null && !savedNamePresent

    fun select(savedName: String?, savedGeneration: String?, savedNamePresent: Boolean, eligible: List<Candidate>): Candidate? =
        if (savedNameAbsent(savedName, savedGeneration, savedNamePresent))
            eligible.singleOrNull()
        else if (savedGeneration != null)
            eligible.singleOrNull { it.name == savedName && it.creationId == savedGeneration }
        else if (savedName != null)
            eligible.singleOrNull { it.name == savedName }
        else eligible.singleOrNull()
}
