package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AccountCreationCoordinatorTest {
    private class Fake : AccountCreationCoordinator.Seams {
        var exists = false; var add = true; var fail: String? = null; var failAccountCreatedWrite = false; var stateWrites = 0; var quarantineSucceeds = true; val calls = mutableListOf<String>()
        override fun rowExists() = exists
        override fun prepare(id: String) = (fail != "prepare").also { calls += "prepare" }
        override fun add() = add.also { calls += "add" }
        override fun writeAndReadBack(key: String, value: String?): Boolean {
            if (key == "post_login_setup_state_v1") stateWrites++
            calls += key
            return fail != key && !(failAccountCreatedWrite && key == "post_login_setup_state_v1" && stateWrites == 2)
        }
        override fun activateAndReadBack() = (fail != "active").also { calls += "active" }
        override fun phase(id: String, phase: AccountCreationRegistry.Phase) = (fail != "phase").also { calls += "phase" }
        override fun clear(id: String) = (fail != "clear").also { calls += "clear" }
        override fun quarantine(id: String) = quarantineSucceeds.also { calls += "quarantine" }
    }
    @Test fun `post add pre boundary faults invoke durable recovery quarantine`() {
        val fake=Fake().apply { fail="uri" }; AccountCreationCoordinator(fake).create("one", fields)
        org.junit.Assert.assertTrue(fake.calls.contains("quarantine"))
    }
    @Test fun `failed durable recovery quarantine is reported separately`() {
        assertEquals(AccountCreationCoordinator.Result.QUARANTINE_FAILED,
            AccountCreationCoordinator(Fake().apply { fail="uri"; quarantineSucceeds=false }).create("one", fields))
    }
    private val fields = listOf("uri" to null, "user_name" to "alice", "version" to "2", "etebase_session" to "established")

    @Test fun `existing duplicate and false add never advance another row`() {
        assertEquals(AccountCreationCoordinator.Result.EXISTS_OR_BUSY, AccountCreationCoordinator(Fake().apply { exists = true }).create("one", fields))
        assertEquals(AccountCreationCoordinator.Result.NOT_ADDED, AccountCreationCoordinator(Fake().apply { add = false }).create("one", fields))
    }
    @Test fun `essential fields precede account created boundary and every pre boundary fault quarantines`() {
        val ordered = Fake()
        assertEquals(AccountCreationCoordinator.Result.CREATED, AccountCreationCoordinator(ordered).create("one", fields))
        assertEquals(listOf("prepare", "add", "post_login_creation_id", "phase", "post_login_setup_state_v1", "uri", "user_name", "version", "etebase_session", "post_login_setup_state_v1", "active", "clear"), ordered.calls)
        listOf("post_login_creation_id", "phase", "uri", "user_name", "version", "etebase_session").forEach { fault ->
            assertEquals("fault=$fault", AccountCreationCoordinator.Result.QUARANTINED,
                AccountCreationCoordinator(Fake().apply { fail = fault }).create("one", fields))
        }
        assertEquals(AccountCreationCoordinator.Result.QUARANTINED,
            AccountCreationCoordinator(Fake().apply { failAccountCreatedWrite = true }).create("one", fields))
    }

    @Test fun `post boundary activation or cleanup failure preserves account created without quarantine`() {
        listOf("active", "clear").forEach { fault ->
            val fake = Fake().apply { fail = fault }
            assertEquals(AccountCreationCoordinator.Result.ACCOUNT_CREATED_QUARANTINED,
                AccountCreationCoordinator(fake).create("one", fields))
            org.junit.Assert.assertFalse(fake.calls.contains("quarantine"))
        }
    }

    @Test fun `creator leaves account created staging solely to caller dispatcher`() {
        val creator = File("src/main/java/io/silentsuite/sync/ui/setup/CreateAccountFragment.kt").readText()
        val coordinator = File("src/main/java/io/silentsuite/sync/ui/setup/AccountCreationCoordinator.kt").readText()
        assertFalse(creator.contains("override fun configureAndReadBack"))
        assertFalse(creator.contains("override fun accountCreated"))
        assertFalse(coordinator.contains("fun configureAndReadBack"))
        assertFalse(coordinator.contains("fun accountCreated"))
        assertTrue(creator.contains("AccountCreationCompletionDispatcher"))
        assertTrue(creator.contains("?.onAccountCreated(account, id) ?: true"))
    }
}
