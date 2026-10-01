package io.silentsuite.sync.ui.setup

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.ui.setup.AccountCreationRegistry.DecodeStatus
import io.silentsuite.sync.ui.setup.AccountCreationRegistry.Phase
import io.silentsuite.sync.ui.setup.AccountCreationRegistry.Record
import io.silentsuite.sync.ui.setup.RegistryProcessBoundaryProbe.Ending
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
 * Registry state is only changed through the production mutators, except for the two exact values
 * [RegistryLegacySeed] writes: the newline-terminated form earlier builds stored, and one synthetic
 * unreadable value seeded by the last pair. An unreadable registry fails a writer instead of being
 * replaced, and no reader ever writes.
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
        assertEquals("registry value in the writer process", exact, RegistryTransportControls.classify(EMPTY_REGISTRY, storedValue()))
        assertEquals(DecodeStatus.OK, registry.readResult().status)
        // Plain SharedPreferences controls in a separate test-only file; the registry is not involved.
        assertTrue("transport controls were not committed", RegistryTransportControls.commit(context))
        assertTrue(
            "transport controls changed inside the writer process",
            RegistryTransportControls.observe(context).values.all { it == exact },
        )
        writeState("empty")
    }

    @Test fun readerLoadsEmptyRegistryInFreshProcess() {
        assertFreshProcessAfterWriter("empty")
        val beforeLaunch = requireProbe()
        val controls = RegistryTransportControls.observe(context)
        val registryChange = RegistryTransportControls.classify(EMPTY_REGISTRY, storedValue())
        val evidence = RegistryTransportControls.evidence(beforeLaunch.status, registryChange, controls)
        RegistryTransportControls.report(evidence)
        // The experiment is only meaningful if every control came back and newline-free endings survived.
        assertTrue(
            "$evidence verdict=CONTROL_MISSING",
            controls.values.none { it.change == RegistryTransportControls.Change.MISSING },
        )
        assertTrue(
            "$evidence verdict=NEWLINE_FREE_ENDING_CHANGED",
            RegistryTransportControls.plainEndingNames.all { controls.getValue(it) == exact },
        )
        // Newline-terminated controls only document the boundary: padded is allowed, anything else is not.
        assertTrue(
            "$evidence verdict=NEWLINE_CONTROL_UNEXPECTED",
            RegistryTransportControls.newlineEndingNames.all {
                controls.getValue(it).change == RegistryTransportControls.Change.EXACT ||
                    controls.getValue(it).change == RegistryTransportControls.Change.TRAILING_WHITESPACE_APPENDED
            },
        )
        // The registry value and its identical plain control crossed the same boundary.
        assertEquals(
            "$evidence verdict=REGISTRY_DIFFERS_FROM_IDENTICAL_CONTROL",
            controls.getValue(RegistryTransportControls.REGISTRY_TWIN), registryChange,
        )
        assertEquals("$evidence verdict=REGISTRY_PROBE_STATUS", DecodeStatus.OK, beforeLaunch.status)
        assertEquals(emptyList<Record>(), beforeLaunch.records)
        assertEquals(PostLoginStartupOutcome.SUCCEEDED, PostLoginStartupChecks.snapshot().launchOutcome)
        assertEquals("$evidence verdict=REGISTRY_VALUE_CHANGED", exact, registryChange)
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

    @Test fun writerCommitsLegacyNewlineTerminatedEmptyRegistry() {
        val registry = AccountCreationRegistry.open(context)
        clearThroughProductionMutators(registry)
        val seed = populated.first()
        assertTrue(registry.prepare(seed))
        assertTrue(registry.clearOwned(seed.accountType, seed.accountName, seed.creationId))
        // The grammar earlier builds stored, produced by the platform serialization path itself:
        // the four spaces only appear once this file is parsed again in a fresh process.
        assertTrue("legacy newline was not seeded", RegistryLegacySeed.appendLegacyNewline(context))
        assertEquals(Ending.NEWLINE_TERMINATED, RegistryProcessBoundaryProbe.ending(context))
        assertEquals(DecodeStatus.OK, registry.readResult().status)
        assertEquals(emptyList<Record>(), registry.records())
        writeState("legacy-empty")
    }

    @Test fun readerRecoversLegacyPaddedEmptyRegistryInFreshProcess() {
        assertFreshProcessAfterWriter("legacy-empty")
        val beforeLaunch = requireProbe()
        // The fixture only means something if this process really loaded a padded value from disk,
        // so an unpadded one fails here instead of passing vacuously.
        assertEquals("verdict=LEGACY_PADDING_NOT_REPRODUCED",
            Ending.PADDED_FOUR_SPACES, RegistryProcessBoundaryProbe.beforeLaunchEnding)
        assertEquals("verdict=REGISTRY_PROBE_STATUS", DecodeStatus.OK, beforeLaunch.status)
        assertEquals(emptyList<Record>(), beforeLaunch.records)
        assertEquals(PostLoginStartupOutcome.SUCCEEDED, PostLoginStartupChecks.snapshot().launchOutcome)
        // Recovery is read-only, and an empty store has no row to reconcile, so it is still padded.
        assertEquals("verdict=PADDED_VALUE_REWRITTEN",
            Ending.PADDED_FOUR_SPACES, RegistryProcessBoundaryProbe.ending(context))
        assertEquals(emptyList<Record>(), AccountCreationRegistry.open(context).records())
    }

    @Test fun writerCommitsLegacyNewlineTerminatedEveryPhase() {
        assertEquals(Phase.values().toSet(), populated.map { it.phase }.toSet())
        val registry = AccountCreationRegistry.open(context)
        clearThroughProductionMutators(registry)
        populated.forEach { record ->
            assertTrue(registry.prepare(record.copy(phase = Phase.PREPARED)))
            if (record.phase != Phase.PREPARED) assertTrue(registry.updateOwned(record))
        }
        assertTrue("legacy newline was not seeded", RegistryLegacySeed.appendLegacyNewline(context))
        assertEquals(Ending.NEWLINE_TERMINATED, RegistryProcessBoundaryProbe.ending(context))
        assertEquals(populated.toSet(), requireNotNull(registry.readResult().records).toSet())
        writeState("legacy-populated")
    }

    @Test fun readerRecoversLegacyPaddedEveryPhaseInFreshProcess() {
        assertFreshProcessAfterWriter("legacy-populated")
        val beforeLaunch = requireProbe()
        assertEquals("verdict=LEGACY_PADDING_NOT_REPRODUCED",
            Ending.PADDED_FOUR_SPACES, RegistryProcessBoundaryProbe.beforeLaunchEnding)
        assertEquals("verdict=REGISTRY_PROBE_STATUS", DecodeStatus.OK, beforeLaunch.status)
        assertEquals(populated.size, requireNotNull(beforeLaunch.records).size)
        assertEquals(populated.toSet(), requireNotNull(beforeLaunch.records).toSet())
        // Ordinary launch reconciliation then ran over the recovered rows and cleared them, which is
        // also the only thing that rewrote the value: the read path itself never commits.
        assertEquals(PostLoginStartupOutcome.SUCCEEDED, PostLoginStartupChecks.snapshot().launchOutcome)
        assertEquals(emptyList<Record>(), AccountCreationRegistry.open(context).records())
        assertEquals("verdict=RECONCILED_VALUE_NOT_CANONICAL",
            exact, RegistryTransportControls.classify(EMPTY_REGISTRY, storedValue()))
    }

    @Test fun writerSeedsMalformedRegistryValue() {
        // Last pair in the lane: it deliberately leaves a value no decoder accepts, so no later
        // writer inherits it.
        assertTrue("malformed value was not seeded", RegistryLegacySeed.seedMalformed(context))
        assertEquals(DecodeStatus.INVALID_FIELD_COUNT, AccountCreationRegistry.open(context).readResult().status)
        writeState("malformed")
    }

    @Test fun readerKeepsMalformedRegistryUnreadableAndUntouchedInFreshProcess() {
        assertFreshProcessAfterWriter("malformed")
        val beforeLaunch = requireProbe()
        assertEquals("verdict=MALFORMED_VALUE_DECODED", DecodeStatus.INVALID_FIELD_COUNT, beforeLaunch.status)
        assertEquals(null, beforeLaunch.records)
        // Legacy recovery did not widen what is accepted: the gate still fails closed with the step.
        assertEquals(
            PostLoginStartupOutcome(
                PostLoginStartupOutcome.Phase.REGISTRY_READ,
                PostLoginStartupOutcome.Reason.REGISTRY_UNREADABLE,
                registryDecode = DecodeStatus.INVALID_FIELD_COUNT,
            ),
            PostLoginStartupChecks.snapshot().launchOutcome,
        )
        // Nothing repaired, cleared or rewrote the value it could not read.
        assertTrue("verdict=UNREADABLE_VALUE_CHANGED", RegistryLegacySeed.malformedValueIntact(context))
        assertEquals(null, AccountCreationRegistry.open(context).records())
    }

    private fun clearThroughProductionMutators(registry: AccountCreationRegistry) {
        val existing = requireNotNull(registry.records()) { "Registry is unreadable; refusing to reset it" }
        existing.forEach { assertTrue(registry.clearOwned(it.accountType, it.accountName, it.creationId)) }
    }

    private val exact = RegistryTransportControls.Observation(RegistryTransportControls.Change.EXACT)

    /** Read only, and only ever classified: the stored value never reaches an assertion message. */
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

    private companion object {
        /** What the production encoder stores for a registry with no rows: no terminal newline. */
        const val EMPTY_REGISTRY = "v1"
    }
}
