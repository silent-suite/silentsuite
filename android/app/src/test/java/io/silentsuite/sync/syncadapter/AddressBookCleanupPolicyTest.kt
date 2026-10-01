package io.silentsuite.sync.syncadapter

import org.junit.Assert.assertEquals
import org.junit.Test

class AddressBookCleanupPolicyTest {
    private val appType = "io.silentsuite"
    private val alice = AddressBookOwner("alice@example.invalid", appType)
    private val bob = AddressBookOwner("bob@example.invalid", appType)

    @Test fun `owner metadata that disappears between enumeration and read is skipped without aborting the sweep`() {
        // Sign-out removes the child concurrently: the platform still enumerates the row, but its
        // user data is already gone by the time the sweep reads it.
        val reads = mutableListOf<String>()
        val orphans = AddressBookCleanupPolicy.orphans(
            mainAccountNames = setOf(alice.name),
            children = listOf("alice-child", "vanished-child", "bob-child"),
        ) { child ->
            reads += child
            when (child) {
                "alice-child" -> alice
                "vanished-child" -> null
                "bob-child" -> bob
                else -> error("unexpected child $child")
            }
        }
        assertEquals(listOf("bob-child"), orphans)
        assertEquals(listOf("alice-child", "vanished-child", "bob-child"), reads)
    }

    @Test fun `unreadable owner is never treated as an orphan`() {
        assertEquals(AddressBookCleanupDecision.SKIP_UNREADABLE_OWNER,
            AddressBookCleanupPolicy.decide(emptySet(), null))
        assertEquals(AddressBookCleanupDecision.SKIP_UNREADABLE_OWNER,
            AddressBookCleanupPolicy.decide(setOf(alice.name), null))
    }

    @Test fun `child of the removed main is an orphan while the sibling child is kept`() {
        // alice signed out and bob is the activated sibling.
        val remaining = setOf(bob.name)
        assertEquals(AddressBookCleanupDecision.DELETE_ORPHAN, AddressBookCleanupPolicy.decide(remaining, alice))
        assertEquals(AddressBookCleanupDecision.KEEP_OWNED, AddressBookCleanupPolicy.decide(remaining, bob))
    }

    @Test fun `no remaining main account makes every readable child an orphan`() {
        assertEquals(AddressBookCleanupDecision.DELETE_ORPHAN, AddressBookCleanupPolicy.decide(emptySet(), alice))
    }

    @Test fun `same name main of another type keeps the child rather than widening deletion`() {
        // Ownership is resolved by main-account name today; a type mismatch must never delete.
        val otherType = AddressBookOwner(alice.name, "other.type")
        assertEquals(AddressBookCleanupDecision.KEEP_OWNED,
            AddressBookCleanupPolicy.decide(setOf(alice.name), otherType))
    }
}
