package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountCreationRegistryTest {
    @Test fun `preflight rejects exact existing row and registry owns matching repair only`() {
        assertFalse(AccountCreationRegistry.canPrepare("alice", setOf("alice")))
        assertTrue(AccountCreationRegistry.canPrepare("alice", emptySet()))
        val record = AccountCreationRegistry.Record("alice", "opaque-id", AccountCreationRegistry.Phase.PREPARED, 1)
        assertTrue(AccountCreationRegistry.owns(record, "opaque-id"))
        assertFalse(AccountCreationRegistry.owns(record, "other"))
        assertFalse(AccountCreationRegistry.owns(record, null))
    }

    @Test fun `versioned map retains two names and stale clear cannot remove newer record`() {
        val storage = object : AccountCreationRegistry.Store {
            var value: String? = null
            override fun read() = value
            override fun commit(value: String?) = true.also { this.value = value }
        }
        val registry = AccountCreationRegistry(storage)
        val alice = AccountCreationRegistry.Record("alice", "one", AccountCreationRegistry.Phase.PREPARED, 1, "type")
        val bob = AccountCreationRegistry.Record("bob", "two", AccountCreationRegistry.Phase.PREPARED, 2, "type")
        assertTrue(registry.prepare(alice)); assertTrue(registry.prepare(bob))
        assertFalse(registry.clearOwned("type", "alice", "stale"))
        assertEquals("one", registry.get("type", "alice")!!.creationId)
        assertEquals("two", registry.get("type", "bob")!!.creationId)
    }

    @Test fun `corrupt registry fails closed`() {
        val storage = object : AccountCreationRegistry.Store {
            override fun read() = "not-json"
            override fun commit(value: String?) = true
        }
        assertFalse(AccountCreationRegistry(storage).prepare(
            AccountCreationRegistry.Record("alice", "id", AccountCreationRegistry.Phase.PREPARED, 1, "type")))
    }

    @Test fun `prepared record is not overwritten and an owned phase transition is verified`() {
        val storage = object : AccountCreationRegistry.Store {
            var value: String? = null
            override fun read() = value
            override fun commit(value: String?) = true.also { this.value = value }
        }
        val registry = AccountCreationRegistry(storage)
        val prepared = AccountCreationRegistry.Record("alice", "id", AccountCreationRegistry.Phase.PREPARED, 1, "type")
        assertTrue(registry.prepare(prepared))
        assertFalse(registry.prepare(prepared.copy(creationId = "other")))
        assertTrue(registry.updateOwned(prepared.copy(phase = AccountCreationRegistry.Phase.CREATING)))
        assertEquals(AccountCreationRegistry.Phase.CREATING, registry.get("type", "alice")!!.phase)
    }

    @Test fun `stale phase update cannot delete a newer owner`() {
        val storage = object : AccountCreationRegistry.Store {
            var value: String? = null
            override fun read() = value
            override fun commit(value: String?) = true.also { this.value = value }
        }
        val registry = AccountCreationRegistry(storage)
        val newer = AccountCreationRegistry.Record("alice", "new", AccountCreationRegistry.Phase.PREPARED, 2, "type")
        assertTrue(registry.prepare(newer))
        assertFalse(registry.updateOwned(newer.copy(creationId = "stale", phase = AccountCreationRegistry.Phase.CREATING)))
        assertEquals(newer, registry.get("type", "alice"))
    }

    @Test fun `replaying identical exact-owned recovery succeeds`() {
        val storage = object : AccountCreationRegistry.Store {
            var value: String? = null
            override fun read() = value
            override fun commit(value: String?) = true.also { this.value = value }
        }
        val registry = AccountCreationRegistry(storage)
        val recovery = AccountCreationRegistry.Record(
            "alice", "exact", AccountCreationRegistry.Phase.RECOVERY_REQUIRED, 3, "type")
        assertTrue(registry.prepare(recovery))
        assertTrue(registry.updateOwned(recovery))
        assertEquals(recovery, registry.get("type", "alice"))
        assertFalse(registry.updateOwned(recovery.copy(creationId = "stale")))
    }
}
