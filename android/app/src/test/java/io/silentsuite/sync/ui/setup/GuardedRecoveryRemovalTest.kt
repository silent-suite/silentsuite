package io.silentsuite.sync.ui.setup

import io.silentsuite.sync.notes.edit.PendingNotesStore.RemovalHold
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class GuardedRecoveryRemovalTest {
    private class Run(private val allows: () -> Boolean, private val removed: Boolean = true) {
        val steps = mutableListOf<String>()
        val answers = mutableListOf<Boolean>()
        var hold: RemovalHold? = null

        fun begin(): Run {
            GuardedRecoveryRemoval.begin(
                allows = { given -> steps += "allows"; hold = given; allows() },
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
        assertEquals(listOf("allows", "remove, held true", "callback, held false"), yes.steps)
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
        assertEquals(listOf("allows", "remove, held true", "callback, held false"), failed.steps)
        assertEquals(listOf(false), failed.answers)

        var hold: RemovalHold? = null
        val thrown = IllegalStateException("remove")
        val caught = assertThrows(IllegalStateException::class.java) {
            GuardedRecoveryRemoval.begin(allows = { hold = it; true }, remove = { throw thrown }, onMain = { it() },
                callback = {})
        }
        assertSame(thrown, caught)
        assertTrue(hold!!.released)
    }

    @Test fun `setup recovery's removal goes through the guard, off the main thread`() {
        val model = File("src/main/java/io/silentsuite/sync/ui/setup/PostLoginSetupViewModel.kt").readText()
            .replace("\r\n", "\n")
        val begin = model.substringAfter("override fun begin(callback: (Boolean) -> Unit) {", "")
            .substringBefore("\n            }\n")
        assertTrue(begin, begin.contains("viewModelScope.launch(Dispatchers.IO) {\n                    " +
            "GuardedRecoveryRemoval.begin("))
        assertTrue(begin, begin.contains(
            "allows = { hold -> GuardedRecoveryRemoval.allowsOnDevice(appContext, account, hold) },"))
        // Its removal never asks the authenticator, so it takes the refusal notification away itself.
        assertTrue(begin, begin.contains("remove = { done ->\n" +
            "                            val cleared = NotesRemovalNotice.clearAfter(appContext, done)\n" +
            "                            AndroidCompat.removeAccount(manager, account, cleared)\n"))
        assertEquals("the one removal of the row is the guarded one", 1,
            Regex("""AndroidCompat\.removeAccount\(""").findAll(model).count())
    }
}
