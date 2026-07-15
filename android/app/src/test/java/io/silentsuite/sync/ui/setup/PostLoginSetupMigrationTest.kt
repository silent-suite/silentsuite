package io.silentsuite.sync.ui.setup

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
    @Test fun `creation id readback failure withholds marker`() {
        val store=MemoryStore(listOf(PostLoginSetupMigration.Row("t\\u0000a",PostLoginSetupMigration.LegacyRow("2","a",null,"session",false),null,null))).apply { failCreationId=true }
        assertEquals(false,PostLoginSetupMigration.bootstrap(store){_,_->true}); assertEquals(0,store.marker())
    }
    @Test fun `state failure records the same durable generation`() {
        val store=MemoryStore(listOf(PostLoginSetupMigration.Row("t\\u0000a",PostLoginSetupMigration.LegacyRow("2","a",null,"session",false),null,null))).apply { failState=true }
        assertEquals(true,PostLoginSetupMigration.bootstrap(store){_,_->true}); assertEquals(store.rows().single().creationId,store.recoveredId)
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
}
