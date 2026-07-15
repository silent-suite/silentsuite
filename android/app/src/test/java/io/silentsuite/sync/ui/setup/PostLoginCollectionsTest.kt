package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class PostLoginCollectionsTest {
    @Test fun `active types retain read only integrations exclude removed and dedupe`() {
        val inventory=listOf(CollectionEligibility.Collection("calendar",false,uid="one"),CollectionEligibility.Collection("calendar",false,uid="one"),CollectionEligibility.Collection("tasks",false,removed=true,uid="gone"))
        org.junit.Assert.assertEquals(setOf("calendar"),CollectionEligibility.activeTypes(inventory,setOf("calendar","tasks")))
    }
    @Test fun `uncertain upload and cache failure refresh before retry and dedupe remote uid`() {
        val remote = mutableListOf<CollectionEligibility.Collection>()
        var creates = 0
        val result = CollectionReconciliation.reconcile(listOf("calendar"),
            refresh = { remote.toList() }, createAndCache = {
                creates++
                remote += CollectionEligibility.Collection("calendar", writable = true, uid = "stable-remote-id")
                throw IllegalStateException("cache failed after server upload")
            })
        assertEquals(CollectionReconciliation.Result.Ready, result)
        assertEquals(1, creates)
    }

    @Test fun `removed and read only rows do not satisfy one required type while another remains isolated`() {
        val inventory = listOf(
            CollectionEligibility.Collection("calendar", writable = true, uid = "cal"),
            CollectionEligibility.Collection("tasks", writable = true, removed = true, uid = "old-task"),
            CollectionEligibility.Collection("tasks", writable = false, uid = "shared-readonly")
        )
        assertEquals(listOf("tasks"), CollectionEligibility.missingTypes(inventory, listOf("calendar", "tasks")))
    }
    @Test fun `only active writable required types qualify`() {
        val inventory = listOf(
            CollectionEligibility.Collection("calendar", writable = true),
            CollectionEligibility.Collection("tasks", writable = false),
            CollectionEligibility.Collection("address_book", writable = true, removed = true),
            CollectionEligibility.Collection("calendar", writable = true)
        )
        assertEquals(setOf("calendar"), CollectionEligibility.qualifyingTypes(inventory, setOf("calendar", "tasks", "address_book")))
        assertEquals(listOf("tasks", "address_book"), CollectionEligibility.missingTypes(inventory, listOf("calendar", "tasks", "address_book")))
    }

    @Test fun `read only inventory permits limited continuation but no inventory does not`() {
        assertEquals(CollectionEligibility.Continuation.LIMITED, CollectionEligibility.continuation(listOf(CollectionEligibility.Collection("calendar", writable = false))))
        assertEquals(CollectionEligibility.Continuation.RECOVERY, CollectionEligibility.continuation(emptyList()))
    }

    @Test fun `reconciliation creates each missing type once and re inventories after partial work`() {
        val required = listOf("calendar", "tasks", "address_book")
        assertEquals(listOf("calendar", "tasks", "address_book"), CollectionEligibility.nextMissing(emptyList(), required))
        assertEquals(listOf("tasks", "address_book"), CollectionEligibility.nextMissing(
            listOf(CollectionEligibility.Collection("calendar", writable = true)), required))
    }

    @Test fun `permanently invisible server result is bounded and never duplicates forever`() {
        var creates = 0
        val result = CollectionReconciliation.reconcile(listOf("calendar"),
            refresh = { emptyList() }, createAndCache = { creates++ }, maxUncertainAttempts = 2)
        assertEquals(CollectionReconciliation.Result.Recovery, result)
        assertEquals(2, creates)
    }
}
