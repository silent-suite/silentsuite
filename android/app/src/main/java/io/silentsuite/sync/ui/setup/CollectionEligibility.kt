package io.silentsuite.sync.ui.setup

/** Pure remote-inventory reconciliation. Cache presence and display names never participate. */
object CollectionEligibility {
    data class Collection(
        val type: String,
        val writable: Boolean,
        val removed: Boolean = false,
        val uid: String = type
    )
    enum class Continuation { READY, LIMITED, RECOVERY }

    fun qualifyingTypes(inventory: List<Collection>, required: Set<String>): Set<String> =
        inventory.asSequence().filter { !it.removed && it.writable && it.type in required }
            .map { it.type }.toSet()
    /** Active remote types drive integrations even when the user only has read access. */
    fun activeTypes(inventory: List<Collection>, required: Set<String>): Set<String> =
        inventory.asSequence().filter { !it.removed && it.type in required }.map { it.type }.toSet()

    fun missingTypes(inventory: List<Collection>, required: List<String>): List<String> {
        val qualifying = qualifyingTypes(inventory, required.toSet())
        return required.filterNot { it in qualifying }
    }

    /** The caller creates only the first result, then inventories again after every upload. */
    fun nextMissing(inventory: List<Collection>, required: List<String>): List<String> =
        missingTypes(inventory, required)

    fun continuation(inventory: List<Collection>): Continuation = when {
        inventory.any { !it.removed && it.writable } -> Continuation.READY
        inventory.any { !it.removed } -> Continuation.LIMITED
        else -> Continuation.RECOVERY
    }
}
