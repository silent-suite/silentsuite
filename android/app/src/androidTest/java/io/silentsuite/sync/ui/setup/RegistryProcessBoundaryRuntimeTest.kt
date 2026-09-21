package io.silentsuite.sync.ui.setup

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.ui.setup.AccountCreationRegistry.DecodeStatus
import io.silentsuite.sync.ui.setup.AccountCreationRegistry.Phase
import io.silentsuite.sync.ui.setup.AccountCreationRegistry.Record
import java.io.File
import java.io.FileOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cross-process persistence gate for the ownership registry. Every method is one half of a
 * writer/reader pair that android/scripts/run-registry-process-boundary.sh runs as separate
 * `am instrument` invocations with the app process terminated in between. A reader run alone, or in
 * the writer's process, fails by design. It is deliberately outside the focused runtime ledger.
 *
 * Nothing here resets storage: registry state is only changed through the production mutators,
 * and an unreadable registry fails the writer instead of being replaced.
 */
class RegistryProcessBoundaryRuntimeTest {
    private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val stateFile get() = File(File(context.filesDir, "registry-process-boundary"), "writer-state")

    // No account of this type exists, so launch reconciliation owns the rows' later cleanup.
    private val accountType = "io.silentsuite.boundary.invalid"
    private val populated = listOf(
        Record("boundary|prepared\né名", "boundary-id-prepared", Phase.PREPARED, 1L, accountType),
        Record("boundary-creating", "boundary-id-creating", Phase.CREATING, Long.MAX_VALUE, accountType),
        Record("", "boundary-id-recovery", Phase.RECOVERY_REQUIRED, Long.MIN_VALUE, accountType),
    )

    @Test fun writerCommitsEmptyRegistryThroughProductionStore() {
        val registry = AccountCreationRegistry.open(context)
        clearThroughProductionMutators(registry)
        val seed = populated.first()
        assertTrue(registry.prepare(seed))
        assertTrue(registry.clearOwned(seed.accountType, seed.accountName, seed.creationId))
        // A stored header-only value, not an absent key: the reader must tell these apart.
        assertEquals("v1\n", storedValue())
        assertEquals(DecodeStatus.OK, registry.readResult().status)
        writeState("empty")
    }

    @Test fun readerLoadsEmptyRegistryInFreshProcess() {
        assertFreshProcessAfterWriter("empty")
        val beforeLaunch = requireProbe()
        assertEquals(DecodeStatus.OK, beforeLaunch.status)
        assertEquals(emptyList<Record>(), beforeLaunch.records)
        assertEquals(PostLoginStartupOutcome.SUCCEEDED, PostLoginStartupChecks.snapshot().launchOutcome)
        assertEquals("v1\n", storedValue())
    }

    @Test fun writerCommitsEveryPhaseThroughProductionStore() {
        assertEquals(Phase.values().toSet(), populated.map { it.phase }.toSet())
        val registry = AccountCreationRegistry.open(context)
        clearThroughProductionMutators(registry)
        populated.forEach { record ->
            assertTrue(registry.prepare(record.copy(phase = Phase.PREPARED)))
            if (record.phase != Phase.PREPARED) assertTrue(registry.updateOwned(record))
        }
        assertEquals(populated.toSet(), requireNotNull(registry.readResult().records).toSet())
        writeState("populated")
    }

    @Test fun readerLoadsEveryPhaseInFreshProcess() {
        assertFreshProcessAfterWriter("populated")
        val beforeLaunch = requireProbe()
        assertEquals(DecodeStatus.OK, beforeLaunch.status)
        assertEquals(populated.size, requireNotNull(beforeLaunch.records).size)
        assertEquals(populated.toSet(), requireNotNull(beforeLaunch.records).toSet())
        // The real launch check then ran over that state: rows without an account are cleared.
        assertEquals(PostLoginStartupOutcome.SUCCEEDED, PostLoginStartupChecks.snapshot().launchOutcome)
        assertEquals(emptyList<Record>(), AccountCreationRegistry.open(context).records())
    }

    private fun clearThroughProductionMutators(registry: AccountCreationRegistry) {
        val existing = requireNotNull(registry.records()) { "Registry is unreadable; refusing to reset it" }
        existing.forEach { assertTrue(registry.clearOwned(it.accountType, it.accountName, it.creationId)) }
    }

    private fun storedValue(): String? =
        context.getSharedPreferences("account_creation_registry", Context.MODE_PRIVATE).getString("rows", null)

    private fun requireProbe(): AccountCreationRegistry.ReadResult = requireNotNull(RegistryProcessBoundaryProbe.beforeLaunch) {
        "Run with -e ${RegistryProcessBoundaryProbe.RUNNER_ARGUMENT} true"
    }

    private fun writeState(kind: String) {
        val parent = requireNotNull(stateFile.parentFile)
        assertTrue(parent.isDirectory || parent.mkdirs())
        FileOutputStream(stateFile).use { stream ->
            stream.write("${RegistryProcessBoundaryProbe.processNonce}\n$kind\n".toByteArray(Charsets.UTF_8))
            stream.fd.sync()
        }
    }

    /** Consumes the writer's state so one write can never satisfy two readers. */
    private fun assertFreshProcessAfterWriter(kind: String) {
        assertTrue("No writer ran before this reader", stateFile.isFile)
        val state = stateFile.readText(Charsets.UTF_8).split("\n")
        assertTrue("Writer state could not be consumed", stateFile.delete())
        assertEquals(3, state.size)
        assertEquals(kind, state[1])
        assertEquals(36, state[0].length)
        assertNotEquals("Reader shares the writer's process", state[0], RegistryProcessBoundaryProbe.processNonce)
    }
}
