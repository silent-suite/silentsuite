package io.silentsuite.sync.ui.setup

import io.silentsuite.sync.notes.edit.PendingNotesStore.RemovalHold
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class GuardedRecoveryRemovalTest {
    private class Run(
        private val allows: () -> Boolean,
        private val removed: Boolean = true,
        private val exact: () -> Boolean = { true },
    ) {
        val steps = mutableListOf<String>()
        val answers = mutableListOf<Boolean>()
        var hold: RemovalHold? = null

        fun begin(): Run {
            GuardedRecoveryRemoval.begin(
                allows = { given -> steps += "allows"; hold = given; allows() },
                exact = { steps += "exact, held ${!hold!!.released}"; exact() },
                remove = { done ->
                    steps += "remove, held ${!hold!!.released}"
                    done(removed)
                },
                onMain = { steps += "main"; it() },
                callback = { answers += it; steps += "callback, held ${!hold!!.released}" })
            return this
        }
    }

    @Test fun `only the guard's yes starts the removal, and every no reports a removal that did not finish`() {
        val yes = Run({ true }).begin()
        assertEquals(listOf("allows", "exact, held true", "remove, held true", "callback, held false"), yes.steps)
        assertEquals("the removal reports itself", listOf(true), yes.answers)

        val no = Run({ false }).begin()
        assertEquals(listOf("allows", "main", "callback, held false"), no.steps)
        assertEquals(listOf(false), no.answers)

        for (thrown in listOf(IllegalStateException("guard"), OutOfMemoryError("guard"))) {
            val failed = Run({ throw thrown }).begin()
            assertEquals("$thrown", listOf("allows", "main", "callback, held false"), failed.steps)
            assertEquals("$thrown", listOf(false), failed.answers)
        }
    }

    @Test fun `the hold of the guard's store checks lasts until the removal reports, whatever it reports, or throws`() {
        val failed = Run({ true }, removed = false).begin()
        assertEquals(listOf("allows", "exact, held true", "remove, held true", "callback, held false"), failed.steps)
        assertEquals(listOf(false), failed.answers)

        var hold: RemovalHold? = null
        val thrown = IllegalStateException("remove")
        val caught = assertThrows(IllegalStateException::class.java) {
            GuardedRecoveryRemoval.begin(allows = { hold = it; true }, exact = { true }, remove = { throw thrown },
                onMain = { it() }, callback = {})
        }
        assertSame(thrown, caught)
        assertTrue(hold!!.released)
    }

    /** One device's account row and creation registry, by name, as the recheck reads them. */
    private class Device(var rowId: String?, var registryId: String?, var rowPresent: Boolean = true) {
        fun exact(creationId: String) = GuardedRecoveryRemoval.sameGeneration(
            registryId == creationId, rowPresent, rowId.takeIf { rowPresent }, creationId)

        /** Another removal of the row, then a sign-in with the same name up to [rowIdWritten]. */
        fun replace(rowIdWritten: Boolean) {
            rowPresent = false; registryId = null
            registryId = "replacement"; rowPresent = true; rowId = if (rowIdWritten) "replacement" else null
        }
    }

    @Test fun `a row replaced while the guard runs is never removed, whether or not its new id is written yet`() {
        for (rowIdWritten in listOf(true, false)) {
            val device = Device(rowId = "recovering", registryId = "recovering")
            val run = Run({ device.replace(rowIdWritten); true }, exact = { device.exact("recovering") }).begin()
            assertEquals("$rowIdWritten", listOf("allows", "exact, held true", "main", "callback, held false"),
                run.steps)
            assertEquals(listOf(false), run.answers)
        }
        // Without the replacement the same run removes the row.
        val device = Device(rowId = "recovering", registryId = "recovering")
        val run = Run({ true }, exact = { device.exact("recovering") }).begin()
        assertEquals(listOf("allows", "exact, held true", "remove, held true", "callback, held false"), run.steps)
    }

    @Test fun `the recheck throwing reports a removal that did not finish and releases the hold`() {
        for (thrown in listOf(IllegalStateException("exact"), OutOfMemoryError("exact"))) {
            val run = Run({ true }, exact = { throw thrown }).begin()
            assertEquals("$thrown", listOf("allows", "exact, held true", "main", "callback, held false"), run.steps)
            assertEquals(listOf(false), run.answers)
        }
    }

    @Test fun `the generation is recovery's while the registry names it and the row has that id or none yet`() {
        val id = "recovering"
        assertTrue(GuardedRecoveryRemoval.sameGeneration(true, true, id, id))
        // Creation stopped before it wrote the id: still recovery's own, as before this check.
        assertTrue(GuardedRecoveryRemoval.sameGeneration(true, true, null, id))
        assertTrue(GuardedRecoveryRemoval.sameGeneration(true, true, "", id))
        assertFalse("another generation's id", GuardedRecoveryRemoval.sameGeneration(true, true, "other", id))
        assertFalse("the registry moved on", GuardedRecoveryRemoval.sameGeneration(false, true, id, id))
        assertFalse("the registry moved on", GuardedRecoveryRemoval.sameGeneration(false, true, null, id))
        assertFalse("nothing to remove", GuardedRecoveryRemoval.sameGeneration(true, false, null, id))
    }

    @Test fun `creation and the recheck with the removal take the same lock`() {
        val create = File("src/main/java/io/silentsuite/sync/ui/setup/CreateAccountFragment.kt").readText()
        assertTrue(create.contains("private val CREATION_LOCK = AccountCreationRegistry.ROW_LOCK"))
        assertTrue(create.contains("synchronized(CREATION_LOCK) {"))
        val removal = File("src/main/java/io/silentsuite/sync/ui/setup/GuardedRecoveryRemoval.kt").readText()
            .replace("\r\n", "\n")
        val locked = removal.substringAfter("synchronized(AccountCreationRegistry.ROW_LOCK) {", "")
        assertTrue(locked, locked.indexOf("exact()") in 0 until locked.indexOf("remove { removed ->"))
    }

    @Test fun `setup recovery's removal goes through the guard, off the main thread`() {
        val model = File("src/main/java/io/silentsuite/sync/ui/setup/PostLoginSetupViewModel.kt").readText()
            .replace("\r\n", "\n")
        val begin = model.substringAfter("override fun begin(callback: (Boolean) -> Unit) {", "")
            .substringBefore("\n            }\n")
        assertTrue(begin, begin.contains("viewModelScope.launch(Dispatchers.IO) {\n                    " +
            "GuardedRecoveryRemoval.begin("))
        assertTrue(begin, begin.contains(
            "allows = { hold -> GuardedRecoveryRemoval.allowsOnDevice(appContext, account, hold) },\n" +
            "                        exact = { GuardedRecoveryRemoval.exactOnDevice(appContext, account, creationId) },"))
        // Its removal never asks the authenticator, so it takes the refusal notification away itself.
        assertTrue(begin, begin.contains("remove = { done ->\n" +
            "                            val cleared = NotesRemovalNotice.clearAfter(appContext, done)\n" +
            "                            AndroidCompat.removeAccount(manager, account, cleared)\n"))
        assertEquals("the one removal of the row is the guarded one", 1,
            Regex("""AndroidCompat\.removeAccount\(""").findAll(model).count())
    }
}
