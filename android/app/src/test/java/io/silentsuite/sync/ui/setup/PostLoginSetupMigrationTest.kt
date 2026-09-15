package io.silentsuite.sync.ui.setup

import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.Reason
import org.junit.Assert.assertEquals
import org.junit.Test

class PostLoginSetupMigrationTest {
    private class MemoryStore(var rowsValue: List<PostLoginSetupMigration.Row>) : PostLoginSetupMigration.Store {
        var version = 0
        var failState = false
        var recoveryWrites = 0
        var failRecovery = false
        var failMarker = false
        var failCreationId = false
        var recoveredId: String? = null
        override fun marker() = version
        override fun rows() = rowsValue
        override fun write(row: PostLoginSetupMigration.Row, key: String, value: String?): Boolean {
            if ((failState && key == "post_login_setup_state_v1") || (failCreationId && key == "post_login_creation_id")) return false
            rowsValue = rowsValue.map {
                if (it.key != row.key) it else when (key) {
                    AccountSettings.KEY_SETTINGS_VERSION -> it.copy(legacy = it.legacy.copy(version = value))
                    "post_login_creation_id" -> it.copy(creationId = value)
                    "post_login_setup_state_v1" -> it.copy(state = value)
                    else -> it
                }
            }
            val updated = rowsValue.first { it.key == row.key }
            return when (key) {
                AccountSettings.KEY_SETTINGS_VERSION -> updated.legacy.version == value
                "post_login_creation_id" -> updated.creationId == value
                "post_login_setup_state_v1" -> updated.state == value
                else -> false
            }
        }
        override fun recordRecovery(row: PostLoginSetupMigration.Row) = !failRecovery.also { if (!failRecovery) { recoveryWrites++; recoveredId=row.creationId } }
        override fun writeMarker(version: Int) = !failMarker.also { if (!failMarker) this.version = version }
    }
    @Test fun `empty row classification does not publish a marker`() {
        val store = MemoryStore(emptyList())
        assertEquals(true, PostLoginSetupMigration.classifyRows(store) { _, _ -> true })
        assertEquals(0, store.marker())
    }
    @Test fun `creation id readback failure withholds marker`() {
        val store=MemoryStore(listOf(PostLoginSetupMigration.Row("t\\u0000a",PostLoginSetupMigration.LegacyRow("2","a",null,"session",false),null,null))).apply { failCreationId=true }
        assertEquals(false,PostLoginSetupMigration.bootstrap(store){_,_->true}); assertEquals(0,store.marker())
    }
    @Test fun `state failure records the same durable generation`() {
        val store=MemoryStore(listOf(PostLoginSetupMigration.Row("t\\u0000a",PostLoginSetupMigration.LegacyRow("2","a",null,"session",false),null,null))).apply { failState=true }
        assertEquals(true,PostLoginSetupMigration.bootstrap(store){_,_->true}); assertEquals(store.rows().single().creationId,store.recoveredId)
    }
    @Test fun `pending reconciliation accepts durable registry fallback when account state write fails`() {
        val calls = mutableListOf<String>()
        assertEquals(true, PostLoginSetupMigration.persistPendingRecovery(
            writeState = { calls += "state"; false },
            updateRegistry = { calls += "registry"; true }
        ))
        assertEquals(listOf("state", "registry"), calls)
        assertEquals(false, PostLoginSetupMigration.persistPendingRecovery(
            writeState = { true },
            updateRegistry = { false }
        ))
    }
    @Test fun `valid legacy row completes and invalid rows recover`() {
        assertEquals(PostLoginSetupState.COMPLETE, PostLoginSetupMigration.classify(PostLoginSetupMigration.LegacyRow("2", "user", null, "session", false)) { _, _ -> true })
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, PostLoginSetupMigration.classify(PostLoginSetupMigration.LegacyRow("bad", "user", null, "session", false)))
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, PostLoginSetupMigration.classify(PostLoginSetupMigration.LegacyRow("2", "", null, "session", false)))
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, PostLoginSetupMigration.classify(PostLoginSetupMigration.LegacyRow("2", "user", "ftp://host", "session", false)))
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, PostLoginSetupMigration.classify(PostLoginSetupMigration.LegacyRow("2", "user", null, "", false)))
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, PostLoginSetupMigration.classify(PostLoginSetupMigration.LegacyRow("2", "user", null, "session", true)))
    }

    @Test fun `legacy completion requires a locally parseable established session and supported migration`() {
        val valid = PostLoginSetupMigration.LegacyRow("0", "user", "https://example.test", "session", false)
        assertEquals(PostLoginSetupState.COMPLETE, PostLoginSetupMigration.classify(valid) { _, _ -> true })
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, PostLoginSetupMigration.classify(valid) { _, _ -> false })
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, PostLoginSetupMigration.classify(valid.copy(version = "3")) { _, _ -> true })
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, PostLoginSetupMigration.classify(valid.copy(uri = "https://")) { _, _ -> true })
    }

    @Test fun `marker is withheld when a row cannot be classified or durably recovered`() {
        val invalid = PostLoginSetupMigration.Row("type\u0000alice",
            PostLoginSetupMigration.LegacyRow("bad", "alice", null, "session", false), null, null)
        val store = MemoryStore(listOf(invalid)).apply { failState = true; failRecovery = true }
        assertEquals(false, PostLoginSetupMigration.bootstrap(store) { _, _ -> true })
        assertEquals(0, store.marker())
    }

    @Test fun `marker write failure remains restartable and raw migration never invokes AccountSettings`() {
        val valid = PostLoginSetupMigration.Row("type\u0000alice",
            PostLoginSetupMigration.LegacyRow("0", "alice", null, "session", false), null, null)
        val store = MemoryStore(listOf(valid)).apply { failMarker = true }
        assertEquals(false, PostLoginSetupMigration.bootstrap(store) { _, _ -> true })
        assertEquals(0, store.marker())
    }

    @Test fun `restart reloads every durable row before marker commit`() {
        val store = MemoryStore(listOf(
            PostLoginSetupMigration.Row("type\u0000alice", PostLoginSetupMigration.LegacyRow("0", "alice", null, "session", false), null, null),
            PostLoginSetupMigration.Row("type\u0000bob", PostLoginSetupMigration.LegacyRow("2", "bob", null, "session", false), null, null)
        ))
        assertEquals(true, PostLoginSetupMigration.bootstrap(store) { _, _ -> true })
        assertEquals(1, store.marker())
        store.rows().forEach {
            assertEquals(PostLoginSetupState.COMPLETE.name, it.state)
            org.junit.Assert.assertTrue(!it.creationId.isNullOrBlank())
        }
        assertEquals(true, PostLoginSetupMigration.bootstrap(store) { _, _ -> true })
    }

    @Test fun `classification failures name their durable boundary and match the boolean view`() {
        val legacy = PostLoginSetupMigration.Row("type\u0000a", PostLoginSetupMigration.LegacyRow("2", "a", null, "session", false), null, null)
        val creation = MemoryStore(listOf(legacy)).apply { failCreationId = true }
        assertEquals(Reason.CLASSIFY_CREATION_ID_WRITE_FAILED, PostLoginSetupMigration.classifyRowsOutcome(creation) { _, _ -> true })
        assertEquals(false, PostLoginSetupMigration.classifyRows(creation) { _, _ -> true })
        val state = MemoryStore(listOf(legacy)).apply { failState = true; failRecovery = true }
        assertEquals(Reason.CLASSIFY_STATE_RECOVERY_FAILED, PostLoginSetupMigration.classifyRowsOutcome(state) { _, _ -> true })
        val pending = PostLoginSetupMigration.Row("type\u0000p", PostLoginSetupMigration.LegacyRow("2", "p", null, "session", true), null, null)
        val pendingStore = MemoryStore(listOf(pending)).apply { failRecovery = true }
        assertEquals(Reason.CLASSIFY_PENDING_ROW_RECOVERY_FAILED, PostLoginSetupMigration.classifyRowsOutcome(pendingStore) { _, _ -> true })
        assertEquals(Reason.NONE, PostLoginSetupMigration.classifyRowsOutcome(MemoryStore(listOf(legacy))) { _, _ -> true })
    }

    private class ReconcileFake(
        var registry: MutableList<AccountCreationRegistry.Record>?,
        val rows: Map<String, Pair<String?, PostLoginSetupState?>>,
    ) : PostLoginSetupMigration.ReconcileOps<String> {
        var failClear = false
        var failQuarantine = false
        var failActivate = false
        var failStateWrite = false
        val calls = mutableListOf<String>()
        override fun records() = registry?.toList()
        override fun locate(record: AccountCreationRegistry.Record): String? = record.accountName.takeIf { it in rows }
        override fun creationId(row: String): String? = rows.getValue(row).first
        override fun state(row: String): PostLoginSetupState? = rows.getValue(row).second
        override fun clearOwned(record: AccountCreationRegistry.Record): Boolean {
            calls.add("clear:${record.accountName}")
            if (failClear) return false
            registry?.remove(record)
            return true
        }
        override fun quarantine(record: AccountCreationRegistry.Record): Boolean {
            calls.add("quarantine:${record.accountName}")
            return !failQuarantine
        }
        override fun activate(record: AccountCreationRegistry.Record): Boolean {
            calls.add("activate:${record.accountName}")
            return !failActivate
        }
        override fun writeRecoveryState(row: String): Boolean {
            calls.add("state:$row")
            return !failStateWrite
        }
    }

    private fun record(name: String, id: String) =
        AccountCreationRegistry.Record(name, id, AccountCreationRegistry.Phase.CREATING, 1L, "type")

    @Test fun `reconcile failures are typed and unreadable ownership performs no mutation`() {
        val unreadable = ReconcileFake(null, emptyMap())
        assertEquals(Reason.RECONCILE_REGISTRY_UNREADABLE, PostLoginSetupMigration.reconcileRecords(unreadable))
        assertEquals(emptyList<String>(), unreadable.calls)

        val missing = ReconcileFake(mutableListOf(record("gone", "g1")), emptyMap()).apply { failClear = true }
        assertEquals(Reason.RECONCILE_CLEAR_MISSING_ROW_FAILED, PostLoginSetupMigration.reconcileRecords(missing))

        val exact = ReconcileFake(mutableListOf(record("a", "id")), mapOf("a" to ("id" to PostLoginSetupState.COMPLETE)))
        exact.failActivate = true
        assertEquals(Reason.RECONCILE_ACTIVATE_FAILED, PostLoginSetupMigration.reconcileRecords(exact))
        assertEquals(listOf("activate:a"), exact.calls)
        exact.failActivate = false
        exact.failClear = true
        exact.calls.clear()
        assertEquals(Reason.RECONCILE_CLEAR_OWNED_FAILED, PostLoginSetupMigration.reconcileRecords(exact))
        assertEquals(listOf("activate:a", "clear:a"), exact.calls)

        val partial = ReconcileFake(mutableListOf(record("p", "pid")), mapOf("p" to ("pid" to PostLoginSetupState.CREATING)))
        partial.failStateWrite = true
        assertEquals(Reason.NONE, PostLoginSetupMigration.reconcileRecords(partial))
        partial.failQuarantine = true
        assertEquals(Reason.RECONCILE_RECOVERY_RECORD_FAILED, PostLoginSetupMigration.reconcileRecords(partial))
    }

    @Test fun `stale same-name ownership is quarantined only and siblings keep exact ownership`() {
        val fake = ReconcileFake(
            mutableListOf(record("same", "stale-id"), record("sibling", "sibling-id")),
            mapOf("same" to ("new-id" to PostLoginSetupState.COMPLETE), "sibling" to ("sibling-id" to PostLoginSetupState.COMPLETE)),
        )
        assertEquals(Reason.NONE, PostLoginSetupMigration.reconcileRecords(fake))
        assertEquals(listOf("quarantine:same", "activate:sibling", "clear:sibling"), fake.calls)
        fake.calls.clear()
        fake.failQuarantine = true
        assertEquals(Reason.RECONCILE_QUARANTINE_MISMATCH_FAILED, PostLoginSetupMigration.reconcileRecords(fake))
        assertEquals(listOf("quarantine:same"), fake.calls)
    }

    @Test fun `repeated reconcile after success is idempotent`() {
        val fake = ReconcileFake(mutableListOf(record("a", "id")), mapOf("a" to ("id" to PostLoginSetupState.COMPLETE)))
        assertEquals(Reason.NONE, PostLoginSetupMigration.reconcileRecords(fake))
        fake.calls.clear()
        assertEquals(Reason.NONE, PostLoginSetupMigration.reconcileRecords(fake))
        assertEquals(emptyList<String>(), fake.calls)
    }
}
