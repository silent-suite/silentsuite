package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class AccountCreationCoordinatorTest {
    private class Fake : AccountCreationCoordinator.Seams {
        var exists = false; var add = true; var fail: String? = null; val calls = mutableListOf<String>()
        override fun rowExists() = exists
        override fun prepare(id: String) = (fail != "prepare").also { calls += "prepare" }
        override fun add() = add.also { calls += "add" }
        override fun writeAndReadBack(key: String, value: String?) = (fail != key).also { calls += key }
        override fun configureAndReadBack() = (fail != "config").also { calls += "config" }
        override fun accountCreated(id: String) = (fail != "created").also { calls += "created" }
        override fun activateAndReadBack() = (fail != "active").also { calls += "active" }
        override fun phase(id: String, phase: AccountCreationRegistry.Phase) = (fail != "phase").also { calls += "phase" }
        override fun clear(id: String) = (fail != "clear").also { calls += "clear" }
        override fun quarantine(id: String) = true.also { calls += "quarantine" }
    }
    @Test fun `post add pre boundary faults invoke durable recovery quarantine`() {
        val fake=Fake().apply { fail="uri" }; AccountCreationCoordinator(fake).create("one", fields)
        org.junit.Assert.assertTrue(fake.calls.contains("quarantine"))
    }
    private val fields = listOf("uri" to null, "user_name" to "alice", "version" to "2", "etebase_session" to "established")

    @Test fun `existing duplicate and false add never advance another row`() {
        assertEquals(AccountCreationCoordinator.Result.EXISTS_OR_BUSY, AccountCreationCoordinator(Fake().apply { exists = true }).create("one", fields))
        assertEquals(AccountCreationCoordinator.Result.NOT_ADDED, AccountCreationCoordinator(Fake().apply { add = false }).create("one", fields))
    }
    @Test fun `every post add write config activation or registry failure quarantines`() {
        listOf("post_login_creation_id", "phase", "uri", "user_name", "version", "etebase_session", "config", "post_login_setup_state_v1", "created").forEach { fault ->
            assertEquals("fault=$fault", AccountCreationCoordinator.Result.QUARANTINED,
                AccountCreationCoordinator(Fake().apply { fail = fault }).create("one", fields))
        }
    }

    @Test fun `post boundary activation or cleanup failure preserves success and quarantines`() {
        listOf("active", "clear").forEach { fault ->
            assertEquals(AccountCreationCoordinator.Result.ACCOUNT_CREATED_QUARANTINED,
                AccountCreationCoordinator(Fake().apply { fail = fault }).create("one", fields))
        }
    }
}
