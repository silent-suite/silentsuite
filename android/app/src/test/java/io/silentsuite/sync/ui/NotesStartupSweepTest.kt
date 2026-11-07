package io.silentsuite.sync.ui

import io.silentsuite.sync.notes.edit.PendingNotesDiscardPermits
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.Companion.StoreFolders
import io.silentsuite.sync.notes.edit.PendingNotesStore.SaveOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendOutcome
import io.silentsuite.sync.ui.NotesStartupSweep.HoldBack
import io.silentsuite.sync.ui.NotesStartupSweep.Outcome
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.CreationId
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Row
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

/**
 * The startup sweep of Notes stores whose account is gone: what it reads and in which order, when it holds back, which
 * stores it removes, and where the app starts it. Real stores in a temporary no_backup folder, opened by folder name
 * as on a device, and the real record beside them unless a case passes its own; the account list and the
 * active-account preference are stand-ins.
 */
class NotesStartupSweepTest {
    @get:Rule val tmp = TemporaryFolder()

    private val noBackup by lazy { tmp.newFolder("no_backup") }
    private val pending get() = File(noBackup, PendingNotesStore.PENDING)
    private val record get() = File(noBackup, NotesLastActiveRecord.FILE)

    /** Replaces the target in one step on Windows too, where these tests also run, as in PendingNotesStoreTest. */
    private val atomicMove: (File, File) -> Unit = { from, to ->
        java.nio.file.Files.move(from.toPath(), to.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }

    @After fun reset() {
        PendingNotesStore.resetForTesting()
    }

    private fun row(name: String) = Row(name, CreationId.Readable("gen-$name"))

    private fun identity(name: String) = name to "gen-$name"

    private fun folderOf(name: String) = PendingNotesStore.identityDir(noBackup, TYPE, name, "gen-$name").name

    private fun storeOf(name: String) = PendingNotesStore.forNoBackup(noBackup, TYPE, name, "gen-$name", {}, atomicMove)

    /** The store in [folder], opened by its name as the sweep opens it on a device. */
    private fun opened(folder: String) = PendingNotesStore.forNoBackupDirectory(noBackup, folder, {}, atomicMove)

    /**
     * [name]'s store with nothing unsynced: its one note was pushed while an editor was open, so it keeps the
     * notebook's copy, the landed record and the counter. Gives its folder.
     */
    private fun cleanStore(name: String): String {
        val store = storeOf(name)
        val editor = store.editorOpened("n1")
        assertTrue(store.saveLocal(editor, "n1", "b1", "r1", "text".toByteArray(), isCreate = false,
            notebookCopy = "key b1".toByteArray()) is SaveOutcome.Saved)
        assertEquals(SendOutcome.Done, store.completeSend("n1", store.beginSend("n1")!!.version, "r1",
            "landed".toByteArray()))
        assertEquals(setOf("n1.landed", "b1.notebook", "sequence"), store.dir.list()!!.toSet())
        return store.dir.name
    }

    /** [name]'s store with one note that has not synced, and its notebook's copy. Gives its folder. */
    private fun storeWithNote(name: String): String {
        val store = storeOf(name)
        assertTrue(store.saveLocal("n1", "b1", "r1", "text of n1".toByteArray(), isCreate = false,
            notebookCopy = "key b1".toByteArray()) is SaveOutcome.Saved)
        return store.dir.name
    }

    /** Every file and folder under [root], by relative path, with each file's bytes, as in NotesRemovalOfferTest. */
    private fun tree(root: File) = root.walk().associate { f ->
        f.relativeTo(root).path to (if (f.isFile) f.readBytes().toList() else null)
    }

    private fun gone(folder: String) = folder !in pending.list()!!

    /** What the sweep asked of its readings, in order; "open" with the folder it opened. */
    private val asked = ArrayList<String>()

    private val openedFolders get() = asked.filter { it.startsWith("open ") }.map { it.removePrefix("open ") }

    /**
     * One run, as at a new start of the app: no store instance is kept from before. notes-pending is listed for real,
     * and the record is the real one in [noBackup] unless [lastActive] and [remember] say otherwise.
     */
    private fun sweep(
        rows: () -> List<Row>? = { listOf(row("live")) },
        active: () -> Pair<String, String>? = { null },
        folders: () -> StoreFolders = { PendingNotesStore.storeDirectories(noBackup) },
        lastActive: () -> NotesLastActiveRecord.Read = { NotesLastActiveRecord.read(noBackup) },
        remember: (String?) -> Unit = { NotesLastActiveRecord.write(noBackup, it) },
        open: (String) -> PendingNotesStore = ::opened,
    ): Outcome {
        PendingNotesStore.resetForTesting()
        return NotesStartupSweep.sweep(noBackup, TYPE,
            folders = { asked += "folders"; folders() },
            rows = { asked += "rows"; rows() },
            active = { asked += "active"; active() },
            lastActive = { asked += "lastActive"; lastActive() },
            remember = { asked += "remember"; remember(it) },
            open = { asked += "open $it"; open(it) })
    }

    /** The messages logged while [block] runs. */
    private fun logged(block: () -> Unit): List<String> {
        val lines = mutableListOf<String>()
        val handler = object : java.util.logging.Handler() {
            override fun publish(record: java.util.logging.LogRecord) { lines += record.message }
            override fun flush() = Unit
            override fun close() = Unit
        }
        io.silentsuite.sync.log.Logger.log.addHandler(handler)
        try {
            block()
        } finally {
            io.silentsuite.sync.log.Logger.log.removeHandler(handler)
        }
        return lines
    }

    /**
     * A run held back for [reason]: nothing was opened, the record was not written unless writing it is what
     * failed, and nothing under no_backup changed.
     */
    private fun assertHeldBack(reason: HoldBack, run: () -> Outcome) {
        asked.clear()
        val before = tree(noBackup)
        assertEquals(Outcome.HeldBack(reason), run())
        assertEquals("nothing opened", emptyList<String>(), openedFolders)
        if (reason != HoldBack.RECORD_WRITE_FAILED) assertFalse("no record write", "remember" in asked)
        assertEquals("byte for byte", before, tree(noBackup))
    }

    // ---- which stores go ----

    @Test fun `with no store folder the sweep reads no account, and a clean orphan goes while an owned store is never opened`() {
        // notes-pending was never made: nothing else is read, and nothing is logged.
        var outcome: Outcome? = null
        assertEquals(emptyList<String>(), logged { outcome = NotesStartupSweep.report { sweep() } })
        assertEquals(Outcome.NoStores, outcome)
        assertEquals(listOf("folders"), asked)
        // Names of a kind this build does not know only: no store folder either.
        assertTrue(File(pending, "attachments").mkdirs())
        asked.clear()
        assertEquals(Outcome.NoStores, sweep())
        assertEquals(listOf("folders"), asked)
        assertFalse(record.exists())

        // A clean orphan beside the store of a present account that holds a note.
        assertTrue(File(pending, "attachments").delete())
        val live = storeWithNote("live")
        val orphan = cleanStore("orphan")
        val owned = tree(File(pending, live))
        asked.clear()
        val lines = logged { outcome = NotesStartupSweep.report { sweep() } }
        assertEquals(Outcome.Swept(1, 0, 0, 0, 0), outcome)
        assertTrue("the orphan is gone", gone(orphan))
        assertEquals("byte for byte", owned, tree(File(pending, live)))
        assertEquals("the ownership first, then one store", listOf("folders", "rows", "active", "lastActive",
            "open $orphan"), asked)
        assertEquals("counts only",
            listOf("Notes startup sweep: 1 removed, 0 kept, 0 not finished, 0 failed, 0 other names"), lines)
    }

    @Test fun `an orphan with a note and no permit is kept as it was, and Settings still lists it, while a clean one goes`() {
        val withNote = storeWithNote("a")
        val clean = cleanStore("b")
        val before = tree(File(pending, withNote))
        assertEquals(Outcome.Swept(1, 1, 0, 0, 0), sweep())
        assertEquals("byte for byte", before, tree(File(pending, withNote)))
        assertTrue(gone(clean))
        val rows = UnsyncedNotesStores.read(noBackup, emptyList(), open = ::opened).rows
        assertEquals(listOf(withNote), rows.map { it.directory })
        assertEquals(1, rows.single().answer!!.count)
        assertFalse("nothing closed it", rows.single().stopped)
    }

    @Test fun `a name that is not a store folder is counted, never opened, and stays as it was`() {
        val clean = cleanStore("a")
        File(pending, "future.dat").writeBytes("of a newer build".toByteArray())
        assertEquals(Outcome.Swept(1, 0, 0, 0, 1), sweep())
        assertTrue(gone(clean))
        assertEquals("of a newer build", File(pending, "future.dat").readText())
        assertEquals(listOf(clean), openedFolders)
    }

    @Test fun `a store that cannot be opened counts as failed, and the next one is still swept`() {
        val (first, second) = listOf(cleanStore("a"), cleanStore("b")).sorted()
        val before = tree(File(pending, first))
        val outcome = sweep(open = { if (it == first) throw IOException("could not open") else opened(it) })
        assertEquals(Outcome.Swept(1, 0, 0, 1, 0), outcome)
        assertEquals("byte for byte", before, tree(File(pending, first)))
        assertTrue(gone(second))
    }

    @Test fun `any throw while the sweep runs is logged by its class name alone, and goes no further`() {
        var outcome: Outcome? = Outcome.NoStores
        val lines = logged { outcome = NotesStartupSweep.report { throw AssertionError("a/b/c n1 alice") } }
        assertNull(outcome)
        assertEquals(listOf("Notes startup sweep failed: java.lang.AssertionError"), lines)
    }

    // ---- what the sweep holds back on ----

    @Test fun `a notes-pending that cannot be listed holds back before any account is read`() {
        cleanStore("a")
        lateinit var lines: List<String>
        assertHeldBack(HoldBack.ROOT_UNLISTABLE) {
            var outcome: Outcome? = null
            lines = logged { outcome = NotesStartupSweep.report { sweep(folders = { throw IOException("unlisted") }) } }
            outcome!!
        }
        assertEquals(listOf("folders"), asked)
        assertEquals(listOf("Notes startup sweep: held back (ROOT_UNLISTABLE)"), lines)
    }

    // The hold-backs before the record step run with a preference to name, so a record write made too early would
    // change the tree.

    @Test fun `an account list that cannot be read holds back`() {
        cleanStore("a")
        assertHeldBack(HoldBack.ACCOUNTS_UNREADABLE) { sweep(rows = { null }, active = { identity("b") }) }
        assertHeldBack(HoldBack.ACCOUNTS_UNREADABLE) {
            sweep(rows = { throw SecurityException("no access") }, active = { identity("b") })
        }
    }

    @Test fun `a row whose creation id does not read holds back, among rows whose ids read`() {
        cleanStore("a")
        NotesLastActiveRecord.write(noBackup, folderOf("c"))
        assertHeldBack(HoldBack.ROW_WITHOUT_ID) {
            sweep(rows = { listOf(row("live"), Row("blank", CreationId.Unreadable), row("other")) },
                active = { identity("b") })
        }
    }

    @Test fun `an account list with no row holds back`() {
        cleanStore("a")
        assertHeldBack(HoldBack.NO_ACCOUNTS) { sweep(rows = { emptyList() }, active = { identity("b") }) }
    }

    @Test fun `an active-account preference that cannot be read holds back`() {
        cleanStore("a")
        assertHeldBack(HoldBack.ACTIVE_UNREADABLE) { sweep(active = { throw ClassCastException("not a String") }) }
    }

    @Test fun `a record that holds anything but one store folder name holds back`() {
        cleanStore("a")
        record.writeText("x")
        assertHeldBack(HoldBack.LAST_ACTIVE_UNREADABLE) { sweep(active = { identity("b") }) }
    }

    @Test fun `a record that must change and cannot be written holds back, and one that need not change is not written`() {
        val a = cleanStore("a")
        val failing: (String?) -> Unit = { throw IOException("could not write") }
        // No record yet, and a preference to name.
        assertHeldBack(HoldBack.RECORD_WRITE_FAILED) { sweep(active = { identity("b") }, remember = failing) }
        assertFalse(record.exists())
        // A record of another folder.
        NotesLastActiveRecord.write(noBackup, folderOf("c"))
        assertHeldBack(HoldBack.RECORD_WRITE_FAILED) { sweep(active = { identity("b") }, remember = failing) }
        assertEquals(folderOf("c"), record.readText())
        // A record that names the preference's folder already is not written, so the run goes on.
        NotesLastActiveRecord.write(noBackup, folderOf("b"))
        asked.clear()
        assertEquals(Outcome.Swept(1, 0, 0, 0, 0), sweep(active = { identity("b") }, remember = failing))
        assertFalse("remember" in asked)
        assertTrue(gone(a))
    }

    // ---- what owns a store ----

    @Test fun `the store the active-account preference names is never opened, though no row holds it`() {
        val named = cleanStore("a")
        val other = cleanStore("b")
        val before = tree(File(pending, named))
        assertEquals(Outcome.Swept(1, 0, 0, 0, 0), sweep(active = { identity("a") }))
        assertEquals("byte for byte", before, tree(File(pending, named)))
        assertEquals(listOf(other), openedFolders)
        assertTrue(gone(other))
        // With no preference, and no record of one, nothing names it.
        cleanStore("c")
        assertEquals(Outcome.Swept(2, 0, 0, 0, 0), sweep(lastActive = { NotesLastActiveRecord.Read.Missing }))
        assertTrue(gone(named))
    }

    @Test fun `the store the preference named at the last sweep is kept once the preference moved on, and goes at the next one`() {
        val a = cleanStore("a")
        NotesLastActiveRecord.write(noBackup, a)
        val before = tree(File(pending, a))
        assertEquals(Outcome.Swept(0, 0, 0, 0, 0), sweep(active = { identity("b") }))
        assertEquals("byte for byte", before, tree(File(pending, a)))
        assertEquals("nothing opened", emptyList<String>(), openedFolders)
        assertEquals(NotesLastActiveRecord.Read.Holds(folderOf("b")), NotesLastActiveRecord.read(noBackup))
        // The next sweep that goes ahead with the preference unchanged keeps it no longer.
        assertEquals(Outcome.Swept(1, 0, 0, 0, 0), sweep(active = { identity("b") }))
        assertTrue(gone(a))
    }

    @Test fun `with no preference the record is left as it was, and its store is kept`() {
        val a = cleanStore("a")
        NotesLastActiveRecord.write(noBackup, a)
        val before = tree(noBackup)
        assertEquals(Outcome.Swept(0, 0, 0, 0, 0), sweep(active = { null }))
        assertEquals("byte for byte", before, tree(noBackup))
        assertFalse("remember" in asked)
    }

    // ---- what the sweep's code names ----

    private val ui = File("src/main/java/io/silentsuite/sync/ui")

    /** [file]'s code, without comments, so a KDoc that names something does not count. */
    private fun code(file: File) = file.readText().replace("\r\n", "\n")
        .replace(Regex("(?s)/\\*.*?\\*/"), "").replace(Regex("//[^\n]*"), "")

    private fun calls(pattern: String, text: String) = Regex(pattern).findAll(text).map { it.groupValues[1] }.toList()

    @Test fun `the sweep reaches the stores, the accounts and the record through these calls alone`() {
        val sweep = code(File(ui, "NotesStartupSweep.kt"))
        assertEquals(setOf("storeDirectories", "forDirectory", "identityDir"),
            calls("""PendingNotesStore\.(\w+)\(""", sweep).toSet())
        // An opened store is asked one thing.
        assertEquals(1, Regex("""\bopen\(""").findAll(sweep).count())
        assertEquals(listOf("discardOrphan"), calls("""\bopen\([^()]*\)\.(\w+)\(""", sweep))
        assertEquals(listOf("rows"), calls("""PendingNotesRemovalGuard\.(\w+)\(""", sweep))
        assertEquals(listOf("savedIdentity"), calls("""ActiveAccountManager\.(\w+)""", sweep))
        assertEquals(listOf("read", "write"), calls("""NotesLastActiveRecord\.(\w+)\(""", sweep))
        assertFalse(sweep.contains(NotesLastActiveRecord.FILE) || Regex("""\bFILE\b""").containsMatchIn(sweep))
        for (word in listOf("discardStore(", "clearAll", "acknowledge", "withdrawAcknowledgement", ".record(",
                "removalCheck(", "UnlistedAbsent", "coverForTesting", "unregister(", "clearStopped", "stoppedIn",
                "discardNotebook", "unsyncedInNotebook", "PendingNotesDiscardPermits", "forIdentity(", "forNoBackup",
                "notebookFile(", "NOTEBOOK", "presentAccounts(", "NotesRemovalAllowance", "AccountRowChanges",
                "AccountSettings(", "setUserData", "writeVerified", "removeAccount", "addAccount", "getActiveAccount",
                "getActiveIdentity", "setActiveAccount", "clearActiveAccount", "replaceIfActive",
                "getSharedPreferences", "AccountCreationRegistry", "EtebaseLocalCache", "getEtebase",
                "etebaseSession", "HttpClient", "okhttp", "java.net", "requestSync", "deleteRecursively", ".delete(",
                "Files.delete", "listFiles", "renameTo")) {
            assertFalse(word, sweep.contains(word))
        }
        assertFalse(Regex("""\bOs\.""").containsMatchIn(sweep))
        assertFalse(Regex("""\b(exists|notExists|isFile|isDirectory)\b""").containsMatchIn(sweep))
        for (word in listOf("notes_enabled", "notesEnabled", "NotesFeature")) {
            assertFalse(word, sweep.contains(word, ignoreCase = true))
        }
    }

    @Test fun `the record names no account and no other Notes file, and of the store only its folder pattern`() {
        val record = code(File(ui, "NotesLastActiveRecord.kt"))
        assertEquals(listOf("STORE_DIRECTORY"), calls("""PendingNotesStore\.(\w+)""", record))
        for (word in listOf("AccountManager", "ActiveAccountManager", "getSharedPreferences",
                "PendingNotesDiscardPermits", "NotesRemovalAllowance", "AccountRowChanges")) {
            assertFalse(word, record.contains(word))
        }
        assertFalse(Regex("""\bPENDING\b""").containsMatchIn(record))
    }

    @Test fun `the app starts the sweep in one place, after the bootstrap and after its other background checks`() {
        val main = File("src/main/java")
        val app = code(File(main, "io/silentsuite/sync/App.kt"))
        val call = "io.silentsuite.sync.ui.NotesStartupSweep.launchIn(applicationScope, this)"
        assertEquals(listOf(call), app.lines().filter { "NotesStartupSweep" in it }.map { it.trim() })
        val at = app.indexOf(call)
        assertTrue(app.indexOf("PostLoginStartupChecks.runAtLaunch(this)") in 0 until at)
        // Not inside the other launch, where a throw from the task checks would skip it.
        val launch = app.indexOf("applicationScope.launch(Dispatchers.IO) {")
        assertTrue(launch >= 0)
        var depth = 0
        val end = (app.indexOf('{', launch) until app.length).first { i ->
            when (app[i]) { '{' -> depth++; '}' -> depth-- }
            depth == 0
        }
        assertTrue(end < at)
        fun naming(word: String) = main.walk().filter { it.isFile && it.extension in setOf("kt", "java") }
            .filter { Regex("""\b$word\b""").containsMatchIn(code(it)) }
            .map { it.relativeTo(main).invariantSeparatorsPath }.sorted().toList()
        assertEquals(listOf("io/silentsuite/sync/App.kt", "io/silentsuite/sync/ui/NotesStartupSweep.kt"),
            naming("launchIn"))
        assertEquals(listOf("io/silentsuite/sync/ui/NotesStartupSweep.kt"), naming("atStart"))
    }

    private companion object {
        const val TYPE = "io.silentsuite"
    }
}
