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

    @Test fun `stored output never ends in a newline while earlier accepted forms stay readable`() {
        val storage = object : AccountCreationRegistry.Store {
            var value: String? = null
            var commits = 0
            override fun read() = value
            override fun commit(value: String?) = true.also { commits++; this.value = value }
        }
        val registry = AccountCreationRegistry(storage)
        val a = AccountCreationRegistry.Record("a", "i", AccountCreationRegistry.Phase.PREPARED, 1, "t")
        val b = AccountCreationRegistry.Record("b", "j", AccountCreationRegistry.Phase.PREPARED, 2, "t")
        // Exact stored form after every kind of mutation: newline separated, never newline terminated.
        assertTrue(registry.prepare(b))
        assertEquals("v1\n74|62|6a|PREPARED|2", storage.value)
        assertTrue(registry.prepare(a))
        assertEquals("v1\n74|61|69|PREPARED|1\n74|62|6a|PREPARED|2", storage.value)
        assertTrue(registry.updateOwned(a.copy(phase = AccountCreationRegistry.Phase.RECOVERY_REQUIRED)))
        assertEquals("v1\n74|61|69|RECOVERY_REQUIRED|1\n74|62|6a|PREPARED|2", storage.value)
        assertTrue(registry.clearOwned("t", "a", "i"))
        assertEquals("v1\n74|62|6a|PREPARED|2", storage.value)
        assertTrue(registry.clearOwned("t", "b", "j"))
        assertEquals("v1", storage.value)
        assertEquals(DecodeStatus.OK, registry.readResult().status)
        assertEquals(emptyList<AccountCreationRegistry.Record>(), registry.records())

        // The newline-terminated form written by earlier builds is still read identically,
        storage.value = "v1\n"
        assertEquals(emptyList<AccountCreationRegistry.Record>(), registry.readResult().records)
        storage.value = "v1\n74|61|69|PREPARED|1\n74|62|6a|PREPARED|2\n"
        assertEquals(DecodeStatus.OK, registry.readResult().status)
        assertEquals(listOf(a, b), registry.records())
        assertEquals("i", registry.get("t", "a")!!.creationId)
        // and the next owned mutation of such a readable store keeps every record.
        assertTrue(registry.updateOwned(a.copy(phase = AccountCreationRegistry.Phase.CREATING)))
        assertEquals("v1\n74|61|69|CREATING|1\n74|62|6a|PREPARED|2", storage.value)

        // Whitespace persisted after a terminal newline stays rejected unless it is exactly the legacy
        // four-space shape covered by the next test: nothing trims or skips it, and no mutator writes.
        listOf(
            "v1\n74|61|69|PREPARED|1\n\t" to DecodeStatus.INVALID_FIELD_COUNT,
            "v1    " to DecodeStatus.INVALID_HEADER,
            "v1\n74|61|69|PREPARED|1    " to DecodeStatus.INVALID_TIMESTAMP,
        ).forEachIndexed { index, (damaged, expected) ->
            storage.value = damaged
            storage.commits = 0
            val result = registry.readResult()
            assertEquals("case $index", expected, result.status)
            assertEquals("case $index", null, result.records)
            assertEquals("case $index", null, registry.records())
            assertEquals("case $index", null, registry.get("t", "a"))
            assertFalse("case $index", registry.prepare(b.copy(accountName = "c")))
            assertFalse("case $index", registry.updateOwned(a.copy(phase = AccountCreationRegistry.Phase.CREATING)))
            assertFalse("case $index", registry.clearOwned("t", "a", "i"))
            assertEquals("case $index", 0, storage.commits)
            assertTrue("case $index", storage.value == damaged)
        }
    }

    @Test fun `legacy terminal padding is read losslessly and only in that shape`() {
        val storage = object : AccountCreationRegistry.Store {
            var value: String? = null
            var commits = 0
            override fun read() = value
            override fun commit(value: String?) = true.also { commits++; this.value = value }
        }
        val registry = AccountCreationRegistry(storage)
        val a = AccountCreationRegistry.Record("a", "i", AccountCreationRegistry.Phase.PREPARED, 1, "t")
        val b = AccountCreationRegistry.Record("b", "j", AccountCreationRegistry.Phase.PREPARED, 2, "t")
        val paddedEmpty = "v1\n    "
        val paddedPopulated = "v1\n74|61|69|PREPARED|1\n74|62|6a|PREPARED|2\n    "

        // One extra stored shape is readable: a newline terminated value the platform preferences file
        // padded with exactly four spaces. It yields the records a plain store gives, and reading writes
        // nothing at all, so a padded store stays padded until an ordinary mutation rewrites it.
        listOf(
            paddedEmpty to emptyList<AccountCreationRegistry.Record>(),
            paddedPopulated to listOf(a, b),
        ).forEachIndexed { index, (padded, expected) ->
            storage.value = padded
            storage.commits = 0
            val result = registry.readResult()
            assertEquals("case $index", DecodeStatus.OK, result.status)
            assertEquals("case $index", expected, result.records)
            assertEquals("case $index", expected, registry.records())
            assertEquals("case $index", expected.firstOrNull(), registry.get("t", "a"))
            assertEquals("case $index", 0, storage.commits)
            assertEquals("case $index", padded, storage.value)
        }

        // Ownership on a recovered store is the ordinary one: a stale creation id cannot mutate or clear,
        // and a duplicate prepare still leaves the first owner's record, all without writing.
        storage.value = paddedPopulated
        storage.commits = 0
        assertFalse(registry.updateOwned(a.copy(creationId = "stale", phase = AccountCreationRegistry.Phase.CREATING)))
        assertFalse(registry.clearOwned("t", "a", "stale"))
        assertFalse(registry.prepare(a.copy(creationId = "other")))
        assertEquals(0, storage.commits)
        assertEquals(paddedPopulated, storage.value)
        // The first owned mutation keeps every record and leaves the canonical newline-free form.
        assertTrue(registry.updateOwned(a.copy(phase = AccountCreationRegistry.Phase.CREATING)))
        assertEquals("v1\n74|61|69|CREATING|1\n74|62|6a|PREPARED|2", storage.value)
        assertEquals(1, storage.commits)

        // Every other stored value keeps exactly the rejection it has today: other whitespace, padding in
        // the wrong place, and payloads this encoder would never have written.
        listOf(
            "v1\n\t" to DecodeStatus.INVALID_FIELD_COUNT,                                             // a tab, not spaces
            "v1\n   " to DecodeStatus.INVALID_FIELD_COUNT,                                            // three spaces
            "v1\n     " to DecodeStatus.INVALID_FIELD_COUNT,                                          // five spaces
            "v1\n    \n    " to DecodeStatus.INVALID_FIELD_COUNT,                                     // padded twice
            "v1    " to DecodeStatus.INVALID_HEADER,                                                  // no terminal newline
            "v1    \n    " to DecodeStatus.INVALID_HEADER,                                            // padded header line
            "v1\n74|61|69|PREPARED|1    " to DecodeStatus.INVALID_TIMESTAMP,                          // padding inside a row
            "v2\n    " to DecodeStatus.INVALID_HEADER,                                                // unknown version
            "v1\n74|61|69|PREPARED|1\n74|61|69|CREATING|3\n    " to DecodeStatus.INVALID_FIELD_COUNT, // duplicate key
            "v1\n74|ff|69|PREPARED|1\n    " to DecodeStatus.INVALID_FIELD_COUNT,                      // invalid UTF-8 field
            "v1\n74|61|6A|PREPARED|1\n    " to DecodeStatus.INVALID_FIELD_COUNT,                      // uppercase hex
            "v1\n74|61|69|PREPARED|+1\n    " to DecodeStatus.INVALID_FIELD_COUNT,                     // signed timestamp
            "v1\n74|61|69|PREPARED|01\n    " to DecodeStatus.INVALID_FIELD_COUNT,                     // leading-zero timestamp
            "v1\n74|62|6a|PREPARED|2\n74|61|69|PREPARED|1\n    " to DecodeStatus.INVALID_FIELD_COUNT, // rows out of order
            "v1\n74|61|69|PREPARED|1\n\n    " to DecodeStatus.INVALID_FIELD_COUNT,                    // interior blank line
        ).forEachIndexed { index, (damaged, expected) ->
            storage.value = damaged
            storage.commits = 0
            val result = registry.readResult()
            assertEquals("malformed case $index", expected, result.status)
            assertEquals("malformed case $index", null, result.records)
            assertEquals("malformed case $index", null, registry.records())
            assertEquals("malformed case $index", null, registry.get("t", "a"))
            assertFalse("malformed case $index", registry.prepare(b.copy(accountName = "c")))
            assertFalse("malformed case $index", registry.updateOwned(a.copy(phase = AccountCreationRegistry.Phase.CREATING)))
            assertFalse("malformed case $index", registry.clearOwned("t", "a", "i"))
            assertEquals("malformed case $index", 0, storage.commits)
            assertEquals("malformed case $index", damaged, storage.value)
        }
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
        assertEquals("v1", storage.value)
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
