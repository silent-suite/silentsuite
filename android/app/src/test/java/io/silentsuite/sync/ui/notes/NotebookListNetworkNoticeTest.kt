package io.silentsuite.sync.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Where the notebook list reads the network for its line, and what a reading that fails does. The
 * runtime test shows the line on a device with the reading pinned. This test keeps the text of the
 * parts no device step can tell apart: the thread, the branch that keeps the reading, the log line.
 */
class NotebookListNetworkNoticeTest {
    @Test fun `the list reads the network with its rows off the main thread, keeps it only for the account generation it checked, and a failed reading logs its class only`() {
        val loader = File("src/main/java/io/silentsuite/sync/ui/notes/NotesLoader.kt").readText().replace("\r\n", "\n")
        val start = "fun network(context: Context, account: Account): NotesNetworkState? = try {"
        assertEquals("the reading for the list is one function", 1, loader.split(start).size - 1)
        val reader = loader.substringAfter(start).substringBefore("\n    }\n")
        val logLine = "Logger.log.warning(\"The network could not be read for the notebook list: \${e.javaClass.name}\")"
        for (text in listOf(
            "val accountSettings = AccountSettings(appContext, account)",
            "NotesNetworkPolicy.AccountRule(accountSettings.syncWifiOnly, accountSettings.syncWifiOnlySSID)",
            "AccountSettings.notesNetworkSettings(AccountManager.get(appContext), account)",
            "NotesNetwork.read(appContext, withWifiName = rule.wifiOnly && rule.networkName != null)",
            "} catch (_: InvalidAccountException) {",
            "} catch (e: RuntimeException) {",
            logLine,
        )) {
            assertEquals("exactly once in NotesLoader.network: $text", 1, reader.split(text).size - 1)
        }
        assertEquals("the log line of a failed reading is the only one, and it gives the class of the failure, never a network",
            1, reader.split("Logger.log.").size - 1)
        assertFalse("nothing else in NotesLoader.network writes a log line", reader.contains("Log.") || reader.contains("println"))

        val fragment = File("src/main/java/io/silentsuite/sync/ui/notes/NotebookListFragment.kt").readText().replace("\r\n", "\n")
        val call = "NotesLoader.network(appContext, account)"
        assertEquals("the list reads the network in one place", 1, fragment.split(call).size - 1)
        assertEquals("no other read of the network in the list, whatever its arguments", 1, fragment.split("NotesLoader.network(").size - 1)
        val blockStart = "withContext(Dispatchers.IO) {"
        assertEquals("the list has one block that runs off the main thread", 1, fragment.split(blockStart).size - 1)
        val block = fragment.substringAfter(blockStart).substringBefore("\n            }\n")
        val rowsAt = block.indexOf("NotesLoader.notebooks(appContext, account, creationId)")
        assertTrue("inside the block that runs off the main thread, and after the rows: the runtime test's waits rely on that order",
            rowsAt in 0 until block.indexOf(call))
        assertEquals("and only after a load that found the exact account generation", 1,
            block.split("if (rows is NotesLoad.Loaded) NotesLoader.network(appContext, account) else null").size - 1)
        val keep = "network = seen"
        assertTrue("the cut above is the off-thread block alone: it ends before the main thread goes on and before the reading is kept",
            !block.contains("return@launch") && !block.contains(keep))
        assertEquals("the reading is kept in one place", 1, fragment.split(keep).size - 1)
        assertEquals("the reading is assigned nowhere else, so a load that read nothing keeps the line it had", 1, fragment.split("network = ").size - 1)
        val checkedAt = fragment.indexOf("is NotesLoad.Loaded -> if (current.exactAccountStillCurrent()) {")
        val keepAt = fragment.indexOf(keep)
        assertTrue("after the check of the exact account generation, inside its branch",
            checkedAt in 0 until keepAt && keepAt < fragment.indexOf("} else {", checkedAt))
    }
}
