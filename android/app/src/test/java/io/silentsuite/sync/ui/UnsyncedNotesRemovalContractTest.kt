package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Text checks of the guard of account removals for unsynced Notes: what it reads, and what it must never read, take or
 * write (the maintainer's rules of 2026-10-18 and 2026-10-20 on #709).
 */
class UnsyncedNotesRemovalContractTest {
    private val ui = File("src/main/java/io/silentsuite/sync/ui")

    /** [file]'s code, without comments, so a KDoc that names something does not count. */
    private fun code(file: File) = file.readText().replace("\r\n", "\n")
        .replace(Regex("(?s)/\\*.*?\\*/"), "").replace(Regex("//[^\n]*"), "")

    private val guard get() = code(File(ui, "PendingNotesRemovalGuard.kt"))

    @Test fun `the guard reads creation ids only through getUserData, and builds no account settings`() {
        // The AccountSettings constructor takes its class monitor and may write user data.
        assertFalse(Regex("""\bAccountSettings\(""").containsMatchIn(guard))
        val reads = Regex("""KEY_CREATION_ID""").findAll(guard).count()
        assertTrue(reads > 0)
        assertEquals("every read of it is a getUserData", reads,
            Regex("""getUserData\([^()]*AccountSettings\.KEY_CREATION_ID\)""").findAll(guard).count())
        for (word in listOf("setUserData", "writeVerified", "presentAccounts(", "removeAccount", "addAccount")) {
            assertFalse(word, guard.contains(word))
        }
    }

    @Test fun `the guard names no Notes setting, cache, session or network, and decides nothing from exists`() {
        for (word in listOf("notes_enabled", "notesEnabled", "NotesFeature", "EtebaseLocalCache", "getEtebase",
                "etebaseSession", "HttpClient", "okhttp", "java.net", "requestSync", "clearAll", "discardStore",
                "coverForTesting")) {
            assertFalse(word, guard.contains(word, ignoreCase = true))
        }
        assertFalse(Regex("""\b(exists|notExists|isFile|isDirectory)\b""").containsMatchIn(guard))
    }

    @Test fun `only the guard asks a removal check, and the files that act on its verdict delete nothing`() {
        val main = File("src/main/java").walk().filter { it.isFile && it.extension in setOf("kt", "java") }
            .associate { it.name to code(it) }
        fun naming(word: Regex) = main.filterValues { word.containsMatchIn(it) }.keys.sorted()
        // An absent answer is one check, which a removal of that account alone may take as nothing to lose: no other
        // code asks a removal check or names that answer, so no clear, discard or sweep can take it for gone.
        val asking = listOf("PendingNotesRemovalGuard.kt", "PendingNotesStore.kt")
        assertEquals(asking, naming(Regex("""\bremovalCheck\(""")))
        assertEquals(asking, naming(Regex("""\bUnlistedAbsent\b""")))
        // The files that ask for the guard's verdict, or compare with an allowed one, are these alone, and none of them
        // clears, discards, unregisters or deletes, or writes a permit.
        val acting = naming(Regex("""\bPendingNotesRemovalGuard\.(decide|decision|allows)\b|\bVerdict\.ALLOW\b"""))
        assertEquals(listOf("NotesRemovalAllowance.kt", "NotesRemovalOffer.kt", "PendingNotesRemovalGuard.kt"), acting)
        for (file in acting) {
            for (word in listOf("""\bdiscardStore\(""", """\bclearAll\b""", """\bunregister\(""",
                    """\bdeleteRecursively\b""", """\.delete\(""", """\bdeleteIfExists\b""", """\bFiles\.delete\b""")) {
                assertFalse("$file: $word", Regex(word).containsMatchIn(main.getValue(file)))
            }
            if (file != "PendingNotesRemovalGuard.kt") {
                assertFalse(file, main.getValue(file).contains("PendingNotesDiscardPermits"))
            }
        }
        // The guard names the permit records only for a reader of notes-discard that lists: its rename throws.
        assertEquals(listOf("import io.silentsuite.sync.notes.edit.PendingNotesDiscardPermits",
            "PendingNotesDiscardPermits(File(noBackup, PendingNotesDiscardPermits.ROOT), syncDirectory = {},"),
            guard.lines().map { it.trim() }.filter { "PendingNotesDiscardPermits" in it })
        assertEquals(1, Regex("""\n\s*rename = \{ _, _ -> throw IOException\("this reader only lists"\) \}, """ +
            """presence = presence\)\.listNames\(\)\n""").findAll(guard).count())
    }

    @Test fun `the guard's log line holds its verdict and a count only`() {
        val logs = guard.lines().filter { "Logger." in it }.map { it.trim() }
        assertEquals(listOf("Logger.log.info(\"Notes removal guard: \$verdict after \$checks store checks\")"), logs)
    }

    private val allowance get() = code(File(ui, "NotesRemovalAllowance.kt"))
    private val offer get() = code(File(ui, "NotesRemovalOffer.kt"))
    private val dialog get() = code(File(ui, "NotesRemovalDialogFragment.kt"))

    @Test fun `the allowance lives in memory only, and its lock is a leaf`() {
        for (word in listOf("File", "SharedPreferences", "getSharedPreferences", "setUserData", "Bundle", "Parcelable",
                "Serializable", "Intent", "savedInstanceState", "Logger", "AccountManager", "removeAccount",
                "PendingNotesStore", "PendingNotesRemovalGuard.decision", "AccountSettings", "KEY_CREATION_ID")) {
            assertFalse(word, Regex("""\b${Regex.escape(word)}\b""").containsMatchIn(allowance))
        }
        assertEquals("one lock", 1, Regex("""private val lock = Any\(\)""").findAll(allowance).count())
        // The dialog carries the confirmation's id alone.
        assertEquals(listOf("putString(ARG_SHOWN, shown)"), Regex("""put\w+\([^)]*\)""").findAll(dialog)
            .map { it.value }.toList())
    }

    @Test fun `the button removes the account through AccountManager itself, after its mint`() {
        assertFalse(offer.contains("AndroidCompat"))
        assertEquals(1, Regex("""\.removeAccount\(""").findAll(offer).count())
        assertTrue(offer.contains("AccountManager.get(context).removeAccount(Account(name, type),"))
        val confirm = offer.substringAfter("fun confirm(", "").substringBefore("\n    }\n")
        val mint = confirm.indexOf("allowance.mint(")
        assertTrue(confirm, mint >= 0 && mint < confirm.indexOf("afterMintForTesting") &&
            confirm.indexOf("afterMintForTesting") < confirm.indexOf("seams.remove("))
        assertEquals("the seam that removes is called from the tap alone", 1, Regex("""seams\.remove\(""")
            .findAll(offer).count())
    }

    @Test fun `the allowance of this process counts the real account rows and the boot clock`() {
        assertTrue(allowance, Regex("""val process = NotesRemovalAllowance\(\s*AccountRowChanges\.mainType\s*,\s*""" +
            """NotesFolderListings::count\s*,\s*SystemClock::elapsedRealtime\b""").containsMatchIn(allowance))
    }

    @Test fun `the fingerprint's change time keeps its nanoseconds`() {
        assertTrue(offer, Regex("""stat\.st_ctim\.tv_sec \* 1_000_000_000L \+ stat\.st_ctim\.tv_nsec""")
            .containsMatchIn(offer))
        assertFalse("whole seconds miss a change in the same one", Regex("""\bst_ctime\b(?!')""").containsMatchIn(
            offer.substringAfter("private fun folderStat(")))
    }

    @Test fun `the tap takes its time first, and hands it to the offer`() {
        val tap = dialog.substringAfter("fun confirm(id: String) {\n", "").substringBefore("\n    }\n")
        assertTrue(tap, tap.trimStart().startsWith("val tapped = NotesRemovalAllowance.process.now()"))
        assertEquals(1, Regex("""offer\.confirm\(key\.type, key\.name, id, tapped, ::done\)""").findAll(tap).count())
    }

    @Test fun `nothing answers for the authenticator yet, and the stores never name the allowance`() {
        val main = File("src/main/java")
        val answers = Regex("""NotesRemovalAllowance\b[^\n]*\.answer\(|allowance\.answer\(""")
        val answering = main.walk().filter { it.isFile && it.extension == "kt" }
            .filter { file -> answers.containsMatchIn(code(file)) }.map { it.name }.toList()
        assertEquals(emptyList<String>(), answering)
        for (store in listOf("notes/edit/PendingNotesStore.kt", "notes/edit/PendingNotesDiscardPermits.kt",
                "ui/UnsyncedNotesStores.kt")) {
            val text = code(File(main, "io/silentsuite/sync/$store"))
            assertFalse(store, text.contains("NotesRemovalAllowance") || text.contains("AccountRowChanges"))
        }
        // The authenticator runs in the app's own process, and overrides no cloning of accounts.
        assertFalse(File("src/main/AndroidManifest.xml").readText().contains("android:process"))
        val authenticator = code(File(main, "io/silentsuite/sync/syncadapter/AccountAuthenticatorService.kt"))
        for (word in listOf("getAccountCredentialsForCloning", "addAccountFromCredentials")) {
            assertFalse(word, authenticator.contains(word))
        }
    }

    /** The text of the string resource [name] in the default resources. */
    private fun stringText(name: String): String =
        Regex("<string name=\"$name\">(.*?)</string>").find(File("src/main/res/values/strings.xml").readText())
            ?.groupValues?.get(1) ?: throw AssertionError("no string $name")

    @Test fun `each confirmation says what may remain, and promises nothing`() {
        for (reason in listOf("root", "permits", "both", "unknown_kind")) {
            val text = stringText("notes_remove_uncheckable_text_$reason")
            for (said in listOf("%1\$s", "may remain on this device", "may no longer sync")) {
                assertTrue("$reason: $said", text.contains(said))
            }
            // About Notes alone: what Android does with calendars, contacts and tasks is not promised.
            for (word in listOf("recover", "restore", "back up", "safe", "later", "deleted", "calendar", "contact",
                    "task")) {
                assertFalse("$reason: $word", text.contains(word, ignoreCase = true))
            }
        }
        assertEquals("Remove %1\$s from this device?", stringText("notes_remove_uncheckable_title"))
        assertEquals("Remove account", stringText("notes_remove_uncheckable_confirm"))
        for (result in listOf("readable", "changed", "retry")) {
            assertTrue(result, stringText("notes_remove_uncheckable_$result").startsWith("Nothing was removed."))
        }
        // Rows that cannot be read after Android answered prove nothing either way, and a confirmation that ended
        // claims no change of the accounts.
        assertFalse(stringText("notes_remove_uncheckable_unknown").contains("Nothing was removed"))
        assertFalse(stringText("notes_remove_uncheckable_ended").contains("changed"))
    }
}
