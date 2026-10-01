package io.silentsuite.sync.syncadapter

/** Owner recorded in an address-book row's user data. */
internal data class AddressBookOwner(val name: String, val type: String)

internal enum class AddressBookCleanupDecision { KEEP_OWNED, DELETE_ORPHAN, SKIP_UNREADABLE_OWNER }

/**
 * Orphan policy for address-book child rows, kept free of platform types so it is unit-testable.
 *
 * A row whose owner metadata cannot be read is skipped rather than deleted: the row may already
 * have been removed by a concurrent sign-out after it was enumerated, or its ownership is
 * genuinely unknown. Neither case justifies deleting contacts or aborting the sweep.
 */
internal object AddressBookCleanupPolicy {
    fun decide(mainAccountNames: Collection<String>, owner: AddressBookOwner?): AddressBookCleanupDecision = when {
        owner == null -> AddressBookCleanupDecision.SKIP_UNREADABLE_OWNER
        owner.name in mainAccountNames -> AddressBookCleanupDecision.KEEP_OWNED
        else -> AddressBookCleanupDecision.DELETE_ORPHAN
    }

    /** Reads each child's owner exactly once and returns the children to delete, in enumeration order. */
    fun <T> orphans(mainAccountNames: Collection<String>, children: List<T>, ownerOf: (T) -> AddressBookOwner?): List<T> =
        children.filter { decide(mainAccountNames, ownerOf(it)) == AddressBookCleanupDecision.DELETE_ORPHAN }
}
