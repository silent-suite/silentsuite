package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * What Sync now asks for while an adapter sync runs. The device tests pin that no adapter sync
 * runs, so no device step reaches that branch, and this test keeps its text.
 */
class SyncNowContractTest {
    private val main = File("src/main/java/io/silentsuite/sync")

    @Test fun `Sync now during an adapter sync asks for Notes alone, and only after the account check`() {
        val activity = File(main, "ui/AccountActivity.kt").readText().replace("\r\n", "\n")
        val start = "    private fun requestSync() {\n"
        assertEquals("Sync now is one function", 1, activity.split(start).size - 1)
        val body = activity.substringAfter(start).substringBefore("\n    }\n")
        val open = "if (isAdapterSyncActive()) {"
        assertEquals("Sync now has one branch for a running adapter sync", 1, body.split(open).size - 1)
        assertFalse("a running adapter sync does not end Sync now before Notes is asked for",
            body.contains("if (isAdapterSyncActive()) return"))

        val branch = body.substringAfter(open).substringBefore("\n        }\n")
        val notesOnly = "requestSync(applicationContext, account, notesOnly = true)"
        assertEquals("the branch asks for Notes alone, once", 1, branch.split(notesOnly).size - 1)
        assertTrue("and then returns", branch.trimEnd().endsWith("return"))
        assertTrue("after it has asked for Notes", branch.indexOf(notesOnly) < branch.lastIndexOf("return"))
        for (text in listOf("syncRequestOverride", "requestSync(applicationContext, account)", "model.loadAccount()", "Snackbar")) {
            assertFalse("no adapter request, reload or snackbar in the branch, as before: $text", branch.contains(text))
        }

        val check = "if (!exactAccountStillCurrent()) return"
        val full = "?: requestSync(applicationContext, account)\n"
        assertEquals("Sync now checks the exact account once", 1, body.split(check).size - 1)
        assertEquals("Sync now makes one full request", 1, body.split(full).size - 1)
        val checkAt = body.indexOf(check)
        val branchAt = body.indexOf(open)
        assertTrue("the branch comes after the account check and before the full request",
            checkAt in 0 until branchAt && branchAt < body.indexOf(full))
        assertEquals("nothing else in the account screen asks for Notes alone", 1, activity.split("notesOnly = true").size - 1)
    }

    @Test fun `a Notes-only request records and dispatches no adapter and makes the Notes request of a full one`() {
        val request = File(main, "syncadapter/RequestSync.kt").readText().replace("\r\n", "\n")
        assertTrue("every other caller makes a full request", request.contains("    notesOnly: Boolean = false,\n"))
        assertEquals("a Notes-only request has no adapter to record or dispatch", 1,
            request.split("val authorities = if (notesOnly) linkedMapOf<String, SyncStatusStore.Service>() else linkedMapOf(").size - 1)
        assertEquals("the flag is the parameter and that one use, so the Notes part does not depend on it", 2,
            request.split("notesOnly").size - 1)

        val record = "statusStore?.recordRequested(it, setOf(SyncStatusStore.Service.NOTES), requestId, System.currentTimeMillis())"
        val notes = "NotesSyncCoordinator.request(context, account, notesCreationId, NotesSyncPolicy.Trigger.MANUAL, requestId,"
        assertEquals("Notes is recorded as requested once", 1, request.split(record).size - 1)
        assertEquals("Notes is asked for once, as a run the user started", 1, request.split(notes).size - 1)
        assertTrue("Notes is recorded as requested before the request that carries the same id",
            request.indexOf(record) in 0 until request.indexOf(notes))
    }
}
