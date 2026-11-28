package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Text checks of the Settings way out for unsynced Notes, which must work offline and without a session (the
 * maintainer's condition of 2026-10-18 on #709) and decides nothing from File.exists().
 */
class UnsyncedNotesContractTest {
    private val ui = File("src/main/java/io/silentsuite/sync/ui")

    /** Every source file of the way out and of the sign-out dialogs it shares its words with. */
    private val files: List<File>
        get() = ui.listFiles()!!.filter { it.name.startsWith("UnsyncedNotes") && it.name.endsWith(".kt") }
            .sortedBy { it.name }

    /** [file]'s code, without comments, so a KDoc that names something does not count. */
    private fun code(file: File) = file.readText().replace("\r\n", "\n")
        .replace(Regex("(?s)/\\*.*?\\*/"), "").replace(Regex("//[^\n]*"), "")

    @Test fun `the Unsynced Notes files name no network, session or sync start`() {
        assertTrue(files.map { it.name }.containsAll(listOf("UnsyncedNotesStores.kt", "UnsyncedNotesDiscardPolicy.kt",
            "UnsyncedNotesFragment.kt", "UnsyncedNotesEntry.kt")))
        val forbidden = listOf("HttpClient", "EtebaseLocalCache", "getEtebase", "etebaseSession", "KEY_ETEBASE_SESSION",
            "okhttp", "java.net", "NotesSyncRunner", "requestSync", ".request(", "clearAll")
        for (file in files) {
            val code = code(file)
            for (word in forbidden) assertFalse("${file.name} names $word", code.contains(word, ignoreCase = true))
        }
    }

    @Test fun `the Unsynced Notes files decide nothing from exists, notExists, isFile or isDirectory`() {
        // File.exists() answers false for a check that failed as well as for a file that is not there.
        for (file in files) {
            assertFalse(file.name, Regex("""\b(exists|notExists|isFile|isDirectory)\b""").containsMatchIn(code(file)))
        }
    }

    @Test fun `the Settings discard opens stores only through forDirectory`() {
        val stores = code(File(ui, "UnsyncedNotesStores.kt"))
        assertTrue(stores.contains("PendingNotesStore.forDirectory(context"))
        for (other in listOf("forNoBackup", "forIdentity", "PendingNotesStore.open(")) {
            assertFalse(other, stores.contains(other))
        }
    }

    /**
     * A store call: a member or callable reference of UnsyncedNotesStores or PendingNotesStore, so a nested type such
     * as PendingNotesStore.DiscardOutcome, which the policy imports, is not one. The class is group 1, the member 4.
     */
    private val storeCall =
        Regex("""\b(UnsyncedNotesStores|PendingNotesStore)(\s*\.\s*Companion)?\s*(\.|::)\s*([a-z]\w*)""")

    @Test fun `the Unsynced Notes screens reach the stores only on the IO dispatcher`() {
        val fragment = code(File(ui, "UnsyncedNotesFragment.kt"))
        val calls = storeCall.findAll(fragment).toList()
        assertEquals("the read the hub row and the sign-in item share, the screen's read, its discard and its read " +
            "of one store again",
            listOf("UnsyncedNotesStores.read", "UnsyncedNotesStores.read", "UnsyncedNotesStores.discard",
                "UnsyncedNotesStores.reread"),
            calls.map { it.groupValues[1] + "." + it.groupValues[4] })
        // Where a withContext(Dispatchers.IO) block's first statement starts: each call must start there.
        val onIo = Regex("""withContext\(\s*Dispatchers\.IO\s*\)\s*\{\s*""").findAll(fragment)
            .map { it.range.last + 1 }.toSet()
        for (call in calls) {
            assertTrue("${call.value} is not inside withContext(Dispatchers.IO)", call.range.first in onIo)
        }
        assertFalse("no account read in the screen", fragment.contains("AccountManager"))

        val others = listOf("UnsyncedNotesDiscardPolicy.kt", "AppSettingsActivity.kt", "UnsyncedNotesEntry.kt",
            "setup/LoginActivity.kt", "setup/PostLoginSetupActivity.kt")
        for (name in others) {
            assertEquals(name, emptyList<String>(), storeCall.findAll(code(File(ui, name))).map { it.value }.toList())
        }
    }

    /** What follows [start] in [text], up to the first closing brace at [indent]: one function or block. */
    private fun body(text: String, start: String, indent: String = "    ") =
        text.substringAfter(start, "").substringBefore("\n$indent}\n")

    private fun setupSource(name: String) = File(ui, "setup/$name").readText().replace("\r\n", "\n")

    @Test fun `the sign-in item is added in every mode and opens the account-free settings`() {
        val login = setupSource("LoginActivity.kt")
        val menu = body(login, "override fun onCreateOptionsMenu(menu: Menu): Boolean {")
        assertTrue(menu, menu.contains(
            "menuInflater.inflate(R.menu.activity_login, menu)\n" +
                "        unsyncedNotes.addTo(menu)\n        return true"))
        assertFalse("in every mode, Android's Add account included", menu.contains("authenticatorMode") ||
            menu.contains("if ("))
        val selected = body(login, "override fun onOptionsItemSelected(item: MenuItem): Boolean {")
        val opens = selected.indexOf("if (unsyncedNotes.opens(item)) return true")
        assertTrue("after Up, before the default", opens > selected.indexOf("android.R.id.home") &&
            opens < selected.indexOf("return super.onOptionsItemSelected(item)"))

        val entry = code(File(ui, "UnsyncedNotesEntry.kt"))
        assertTrue(entry.contains(
            "menu.add(Menu.NONE, ITEM_ID, Menu.NONE, R.string.settings_unsynced_notes).apply {\n" +
            "            setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)\n            isVisible = shown\n        }"))
        assertTrue(entry.contains("activity.startActivity(AppSettingsActivity.newUnsyncedNotesIntent(activity))"))
        // Help's item has no id, so 0; resource ids and android.R.id.home are 0x01000000 and above.
        assertTrue(UnsyncedNotesEntry.ITEM_ID in 1 until 0x01000000)

        // Settings with no account at all, and the screen itself as the root: no hub, so the sign-in screen reaches
        // neither Recover deleted contacts nor any account's categories, and Back returns to it.
        val settings = File(ui, "AppSettingsActivity.kt").readText().replace("\r\n", "\n")
        val intent = settings.substringAfter("fun newUnsyncedNotesIntent(context: Context): Intent =", "")
            .substringBefore("\n\n")
        assertTrue(intent, intent.contains("newIntent(context).putExtra(EXTRA_UNSYNCED_NOTES, true)"))
        assertFalse(intent.contains("EXTRA_ACCOUNT") || intent.contains("EXTRA_CREATION_ID"))
        assertTrue(settings.contains(
            "if (intent.getBooleanExtra(EXTRA_UNSYNCED_NOTES, false)) showUnsyncedNotesAsRoot()"))
        val root = body(settings, "private fun showUnsyncedNotesAsRoot() {")
        assertTrue(root.contains("replace(android.R.id.content, UnsyncedNotesFragment()).commitNow()") &&
            !root.contains("addToBackStack"))
    }

    @Test fun `the setup screen offers the item outside render and below onCreate`() {
        val setup = setupSource("PostLoginSetupActivity.kt")
        val onCreate = setup.indexOf("override fun onCreate")
        assertEquals("the first override of that name is onCreate itself", setup.indexOf("override fun onCreate("),
            onCreate)
        val menu = setup.indexOf("override fun onCreateOptionsMenu(menu: Menu): Boolean {\n" +
            "        unsyncedNotes.addTo(menu)\n        return true\n    }")
        val selected = setup.indexOf("override fun onOptionsItemSelected(item: MenuItem): Boolean =\n" +
            "        unsyncedNotes.opens(item) || super.onOptionsItemSelected(item)")
        assertTrue("below onCreate", onCreate in 0 until menu && onCreate < selected)
        val render = setup.substringAfter("private fun render(", "").substringBefore("\n    private fun")
        assertTrue(render.isNotEmpty())
        assertFalse("outside render", render.contains("unsyncedNotes") || render.contains("Menu"))
        assertEquals("no extra of its own", 2, Regex("putExtra\\(").findAll(setup).count())
    }

    @Test fun `the item hides only while the hub row's rule finds nothing, and shows until a read answers`() {
        val entry = code(File(ui, "UnsyncedNotesEntry.kt"))
        assertTrue("shown until a read answers", entry.contains("private var shown = true"))
        assertTrue("read again on every resume", entry.contains(
            "if (event == Lifecycle.Event.ON_RESUME) refresh()"))
        assertTrue("a read that throws shows it", Regex(
            """UnsyncedNotesFragment\.anythingToShow\(app\)\s*\} catch \(e: CancellationException\) \{\s*throw e\s*""" +
                """\} catch \(e: Exception\) \{\s*true\s*\}""").containsMatchIn(entry))
        assertEquals("one place sets it after a read", listOf("shown = anything"),
            Regex("""(?m)^\s+(shown = .*)$""").findAll(entry).map { it.groupValues[1] }.toList())

        // The same rule as the Settings hub row, from the same read.
        val fragment = code(File(ui, "UnsyncedNotesFragment.kt"))
        val anything = body(fragment, "internal suspend fun anythingToShow(app: Context): Boolean {", "        ")
        assertTrue(anything, anything.contains("val (listing, removal) = readHub(app)") && anything.contains(
            "return summary != null || UnsyncedNotesDiscardPolicy.hubRemoval(summary, removal) != null"))
        val hub = body(fragment, "internal fun refreshHubRow(fragment: Fragment, row: Preference) {", "        ")
        assertTrue(hub, hub.contains("val (listing, removal) = readHub(app)") &&
            hub.contains("row.isVisible = summary != null || removalOnly != null"))

        for (name in listOf("setup/LoginActivity.kt", "setup/PostLoginSetupActivity.kt")) {
            assertTrue(name, setupSource(name.removePrefix("setup/"))
                .contains("private val unsyncedNotes = UnsyncedNotesEntry(this)"))
        }
    }
}
