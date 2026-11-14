package io.silentsuite.sync.birthdays

import io.silentsuite.sync.syncadapter.SyncStatusStore
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Birthdays run-ownership decision (plan amendment G2 §2.1, J1): whether one maintenance run may use
 * the main account row it re-selected, from that row's presence, the creation generation read from it, the
 * identity the run was admitted for, and the identity that generation resolves to. The checks run in a
 * fixed order (no row, missing or blank generation, no admission, mismatch), and the generation's identity
 * is resolved only once every earlier check has passed, so a missing row, generation or admission is never
 * resolved.
 *
 * Against the neutral scaffold (always NO_ACCOUNT, fail-closed) the two no-row tests pass, as controls, and
 * every other test fails on its first assertion.
 */
class BirthdayOwnershipTest {
    private val admittedIdentity = checkNotNull(SyncStatusStore.identityFromStorageKey("a".repeat(64)))
    private val otherIdentity = checkNotNull(SyncStatusStore.identityFromStorageKey("b".repeat(64)))

    /** Resolves every generation to [result], and records each generation it is asked for, in order. */
    private class Resolver(private val result: SyncStatusStore.MainIdentity) : (String) -> SyncStatusStore.MainIdentity {
        val asked = ArrayList<String>()
        override fun invoke(creationId: String): SyncStatusStore.MainIdentity {
            asked += creationId
            return result
        }
    }

    @Test fun aListedRowWhoseGenerationResolvesToTheAdmittedIdentityProceeds() {
        val resolver = Resolver(admittedIdentity)
        assertEquals(BirthdayOwnership.PROCEED, birthdayOwnership(true, "gen-1", admittedIdentity, resolver))
        assertEquals("the listed generation is resolved once, as read", listOf("gen-1"), resolver.asked)
    }

    @Test fun aGenerationThatResolvesToAnotherIdentityIsAStaleRun() {
        val resolver = Resolver(otherIdentity)
        assertEquals(BirthdayOwnership.STALE_RUN, birthdayOwnership(true, "gen-2", admittedIdentity, resolver))
        assertEquals("the listed generation is resolved once, as read", listOf("gen-2"), resolver.asked)
    }

    @Test fun noListedRowIsNoAccountAndResolvesNothing() {
        val resolver = Resolver(admittedIdentity)
        assertEquals(BirthdayOwnership.NO_ACCOUNT, birthdayOwnership(false, "gen-1", admittedIdentity, resolver))
        assertEquals("no generation is resolved without a row", emptyList<String>(), resolver.asked)
    }

    @Test fun noListedRowOutranksAMissingGenerationAndAMissingAdmission() {
        val resolver = Resolver(admittedIdentity)
        assertEquals(BirthdayOwnership.NO_ACCOUNT, birthdayOwnership(false, null, null, resolver))
        assertEquals("no generation is resolved without a row", emptyList<String>(), resolver.asked)
    }

    @Test fun aMissingOrBlankGenerationIsNoGenerationAndResolvesNothing() {
        for (creationId in listOf(null, "", " ", "\t")) {
            val resolver = Resolver(admittedIdentity)
            assertEquals("generation [$creationId]", BirthdayOwnership.NO_GENERATION,
                birthdayOwnership(true, creationId, admittedIdentity, resolver))
            assertEquals("generation [$creationId] is not resolved", emptyList<String>(), resolver.asked)
        }
    }

    @Test fun aMissingGenerationOutranksAMissingAdmission() {
        val resolver = Resolver(admittedIdentity)
        assertEquals(BirthdayOwnership.NO_GENERATION, birthdayOwnership(true, null, null, resolver))
        assertEquals("no generation is resolved", emptyList<String>(), resolver.asked)
    }

    @Test fun noAdmittedIdentityIsNoAdmissionAndResolvesNothing() {
        val resolver = Resolver(admittedIdentity)
        assertEquals(BirthdayOwnership.NO_ADMISSION, birthdayOwnership(true, "gen-1", null, resolver))
        assertEquals("nothing is resolved without an admitted identity", emptyList<String>(), resolver.asked)
    }
}
