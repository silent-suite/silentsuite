package io.silentsuite.sync.ui.setup

import io.silentsuite.sync.ui.setup.AccountCreationRegistry.DecodeStatus
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountCreationRegistryTest {
    private fun read(raw: String?) = AccountCreationRegistry(object : AccountCreationRegistry.Store {
        override fun read() = raw
        override fun commit(value: String?) = false
    })

    @Test fun `decode status names the rejecting step and never changes what is accepted`() {
        val hex = "616c696365"
        val valid = "$hex|$hex|$hex|PREPARED|1"
        listOf(
            null to DecodeStatus.NOT_STORED,
            "v1\n" to DecodeStatus.OK, "v1" to DecodeStatus.OK, "v1\n$valid\n" to DecodeStatus.OK, "v1\n\n$valid" to DecodeStatus.OK,
            "v1\n||$hex|RECOVERY_REQUIRED|-9223372036854775808\n" to DecodeStatus.OK,
            "" to DecodeStatus.INVALID_HEADER, "not-json" to DecodeStatus.INVALID_HEADER, "v2\n$valid\n" to DecodeStatus.INVALID_HEADER,
            "v1\r\n" to DecodeStatus.INVALID_HEADER, " v1\n" to DecodeStatus.INVALID_HEADER, "V1\n" to DecodeStatus.INVALID_HEADER,
            "v1\n$hex|$hex|$hex|PREPARED\n" to DecodeStatus.INVALID_FIELD_COUNT,
            "v1\n$valid|00\n" to DecodeStatus.INVALID_FIELD_COUNT, "v1\n \n" to DecodeStatus.INVALID_FIELD_COUNT,
            "v1\n6|$hex|$hex|PREPARED|1\n" to DecodeStatus.INVALID_ENCODING,
            "v1\n$hex|zz|$hex|PREPARED|1\n" to DecodeStatus.INVALID_ENCODING,
            "v1\n$hex|$hex|alice|PREPARED|1\n" to DecodeStatus.INVALID_ENCODING,
            "v1\n$hex|$hex|$hex|prepared|1\n" to DecodeStatus.INVALID_PHASE,
            "v1\n$hex|$hex|$hex|UNKNOWN|1\n" to DecodeStatus.INVALID_PHASE,
            "v1\n$hex|$hex|$hex||1\n" to DecodeStatus.INVALID_PHASE,
            "v1\n$hex|$hex|$hex|PREPARED|\n" to DecodeStatus.INVALID_TIMESTAMP,
            "v1\n$hex|$hex|$hex|PREPARED|1.5\n" to DecodeStatus.INVALID_TIMESTAMP,
            "v1\n$hex|$hex|$hex|PREPARED|9223372036854775808\n" to DecodeStatus.INVALID_TIMESTAMP,
            // A readable first row never rescues a later rejected row.
            "v1\n$valid\n$hex|$hex|$hex|CREATING|soon\n" to DecodeStatus.INVALID_TIMESTAMP,
        ).forEachIndexed { index, (raw, expected) ->
            val registry = read(raw)
            val result = registry.readResult()
            assertEquals("case $index", expected, result.status)
            val readable = expected == DecodeStatus.OK || expected == DecodeStatus.NOT_STORED
            assertEquals("case $index", readable, result.records != null)
            assertEquals("case $index", result.records, registry.records())
        }
        assertEquals(emptyList<AccountCreationRegistry.Record>(), read(null).readResult().records)
        assertEquals(
            listOf(AccountCreationRegistry.Record("alice", "alice", AccountCreationRegistry.Phase.PREPARED, 1, "alice")),
            read("v1\n$valid\n").readResult().records,
        )
    }

    @Test fun `unexpected decode failures keep only a bounded kind`() {
        for (step in DecodeStatus.values()) {
            assertEquals(step, AccountCreationRegistry.failureStatus(NumberFormatException("secret"), step))
            assertEquals(DecodeStatus.UNEXPECTED_RUNTIME_EXCEPTION,
                AccountCreationRegistry.failureStatus(IndexOutOfBoundsException("secret"), step))
            assertEquals(DecodeStatus.UNEXPECTED_ERROR, AccountCreationRegistry.failureStatus(OutOfMemoryError("secret"), step))
            assertEquals(DecodeStatus.UNEXPECTED_OTHER, AccountCreationRegistry.failureStatus(java.io.IOException("secret"), step))
        }
        assertEquals(
            listOf("OK", "NOT_STORED", "INVALID_HEADER", "INVALID_FIELD_COUNT", "INVALID_ENCODING", "INVALID_PHASE",
                "INVALID_TIMESTAMP", "UNEXPECTED_RUNTIME_EXCEPTION", "UNEXPECTED_ERROR", "UNEXPECTED_OTHER"),
            DecodeStatus.values().map { it.name },
        )
    }

    @Test fun `every phase round trips through the production encoding`() {
        val storage = object : AccountCreationRegistry.Store {
            var value: String? = null
            override fun read() = value
            override fun commit(value: String?) = true.also { this.value = value }
        }
        val registry = AccountCreationRegistry(storage)
        val records = AccountCreationRegistry.Phase.values().mapIndexed { index, phase ->
            AccountCreationRegistry.Record("name|$index\né名", "id-$index", phase, Long.MAX_VALUE - index, "type")
        }
        records.forEach { record ->
            assertTrue(registry.prepare(record.copy(phase = AccountCreationRegistry.Phase.PREPARED)))
            assertTrue(registry.updateOwned(record))
        }
        val result = registry.readResult()
        assertEquals(AccountCreationRegistry.DecodeStatus.OK, result.status)
        assertEquals(records.toSet(), result.records!!.toSet())
        records.forEach { assertTrue(registry.clearOwned(it.accountType, it.accountName, it.creationId)) }
        assertEquals("v1\n", storage.value)
        assertEquals(AccountCreationRegistry.DecodeStatus.OK, registry.readResult().status)
    }

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
