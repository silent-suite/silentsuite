package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Text checks of the guard of account removals for unsynced Notes: what it reads, and what it must never read, take or
 * write (the maintainer's rules of 2026-10-18 and 2026-10-20 on #709). They see the names, calls and references written
 * in the app's source files, not a value handed on at run time. They pin where those names appear, which catches an
 * ordinary new use; code written to reach the same things another way (a helper declared in one of the pinned files, a
 * bare call inside a scope function, another API that deletes files, reflection) is for review and the behavior tests.
 */
class UnsyncedNotesRemovalContractTest {
    private val ui = File("src/main/java/io/silentsuite/sync/ui")

    /**
     * [file]'s code, without comments, so a KDoc that names something does not count, with comments and strings
     * bounded as the compilers bound them: Java's backslash-u escapes first, a lone CR as a line end, a block comment
     * as a space. Escapes inside a Kotlin string are kept as written. Strings, characters and names in backticks stay
     * whole, so a comment marker inside one hides nothing after it; a template in a Kotlin string, opened by as many
     * dollar signs as the string's own, is read as code, so a string inside it is one too; Kotlin's block comments
     * nest.
     */
    private fun code(file: File): String = Code(file.readText(), file.extension == "kt").read()

    private class Code(source: String, private val kotlin: Boolean) {
        private val text = (if (kotlin) source else unicode(source)).replace("\r\n", "\n").replace('\r', '\n')
        private val out = StringBuilder(text.length)
        private var i = 0

        fun read(): String {
            scan(template = false)
            return out.toString()
        }

        /** Copies code up to the end of the text, or, in a [template], up to its closing brace. */
        private fun scan(template: Boolean) {
            var depth = 0
            while (i < text.length) {
                val c = text[i]
                val dollars = if (kotlin) dollarsAt(i) else 0
                when {
                    text.startsWith("//", i) -> while (i < text.length && text[i] != '\n') i++
                    text.startsWith("/*", i) -> comment()
                    dollars > 0 && text.startsWith("\"", i + dollars) -> {
                        out.append(text, i, i + dollars)
                        i += dollars
                        string(if (text.startsWith("\"\"\"", i)) "\"\"\"" else "\"", dollars)
                    }
                    text.startsWith("\"\"\"", i) -> string("\"\"\"", 1)
                    c == '"' -> string("\"", 1)
                    c == '\'' || c == '`' -> {
                        var e = i + 1
                        while (e < text.length && text[e] != c && text[e] != '\n') {
                            e += if (c == '\'' && text[e] == '\\') 2 else 1
                        }
                        e = minOf(e + 1, text.length)
                        out.append(text, i, e)
                        i = e
                    }
                    template && c == '}' && depth == 0 -> return
                    else -> {
                        if (template && c == '{') depth++
                        if (template && c == '}') depth--
                        out.append(c)
                        i++
                    }
                }
            }
        }

        /** Skips a block comment, leaving a space and its line ends. */
        private fun comment() {
            var depth = 1
            var lines = 0
            i += 2
            while (depth > 0 && i < text.length) {
                val step = when {
                    text.startsWith("*/", i) -> -1
                    kotlin && text.startsWith("/*", i) -> 1
                    else -> 0
                }
                if (step == 0 && text[i] == '\n') lines++
                depth += step
                i += if (step == 0) 1 else 2
            }
            out.append(' ').append("\n".repeat(lines))
        }

        /** Copies a string whose templates open with [dollars] dollar signs; a Java text block takes escapes. */
        private fun string(quote: String, dollars: Int) {
            val raw = quote.length == 3
            val escapes = !raw || !kotlin
            out.append(quote)
            i += quote.length
            while (i < text.length) {
                val run = if (kotlin) dollarsAt(i) else 0
                when {
                    text.startsWith(quote, i) -> {
                        var e = i + quote.length
                        if (raw && kotlin) while (e < text.length && text[e] == '"') e++
                        out.append(text, i, e)
                        i = e
                        return
                    }
                    !raw && text[i] == '\n' -> return
                    escapes && text[i] == '\\' -> {
                        out.append(text, i, minOf(i + 2, text.length))
                        i += 2
                    }
                    run >= dollars && text.startsWith("{", i + run) -> {
                        out.append(text, i, i + run + 1)
                        i += run + 1
                        scan(template = true)
                        if (i < text.length) {
                            out.append('}')
                            i++
                        }
                    }
                    run >= dollars && nameEnd(i + run) > 0 -> {
                        val e = nameEnd(i + run)
                        out.append(text, i, e)
                        i = e
                    }
                    run > 0 -> {
                        out.append(text, i, i + run)
                        i += run
                    }
                    else -> {
                        out.append(text[i])
                        i++
                    }
                }
            }
        }

        /** Past the closing backtick of a name in backticks at [at], closed on its own line; 0 if it isn't. */
        private fun nameEnd(at: Int): Int {
            if (!text.startsWith("`", at)) return 0
            var e = at + 1
            while (e < text.length && text[e] != '`' && text[e] != '\n') e++
            return if (e < text.length && text[e] == '`' && e > at + 1) e + 1 else 0
        }

        private fun dollarsAt(at: Int): Int {
            var e = at
            while (e < text.length && text[e] == '$') e++
            return e - at
        }

        private companion object {
            /** Java's backslash-u escapes, read first; one after an odd run of backslashes is not an escape. */
            fun unicode(raw: String): String {
                val out = StringBuilder(raw.length)
                var j = 0
                var slashes = 0
                while (j < raw.length) {
                    val c = raw[j]
                    if (c == '\\' && slashes % 2 == 0) {
                        var u = j + 1
                        while (u < raw.length && raw[u] == 'u') u++
                        val hex = if (u > j + 1 && u + 4 <= raw.length) raw.substring(u, u + 4) else ""
                        if (hex.length == 4 && hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
                            out.append(hex.toInt(16).toChar())
                            j = u + 4
                            slashes = 0
                            continue
                        }
                    }
                    out.append(c)
                    slashes = if (c == '\\') slashes + 1 else 0
                    j++
                }
                return out.toString()
            }
        }
    }

    private val guard get() = code(File(ui, "PendingNotesRemovalGuard.kt"))

    /**
     * The code of every Kotlin and Java file in the java and kotlin folders of every source set the app is built from:
     * all but test and androidTest.
     */
    private val sources: Map<File, String> by lazy {
        File("src").listFiles().orEmpty().filter { it.name !in setOf("test", "androidTest") }
            .flatMap { set -> listOf("java", "kotlin").map { File(set, it) } }
            .flatMap { it.walk().toList() }.filter { it.isFile && it.extension in setOf("kt", "java") }
            .associateWith { code(it) }
    }

    /**
     * The names of the [sources] whose code matches [word], sorted, one for each file: a file of the same name in
     * another package or source set shows as a second entry.
     */
    private fun naming(word: Regex) = sources.filterValues { word.containsMatchIn(it) }.keys.map { it.name }.sorted()

    /** An import directive, by its dotted path, which may break between its parts and before an alias. */
    private val imports = Regex("""\bimport\s+(static\s+)?(`?\w+`?\s*\.\s*)*(`?\w+`?|\*)(\s*\bas\s+`?\w+`?)?\s*;?""")

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

    @Test fun `each question that decides a removal hands its hold on to every store check the guard makes`() {
        val answer = code(File(ui, "NotesRemovalAnswer.kt"))
        val recovery = code(File(ui, "setup/GuardedRecoveryRemoval.kt"))
        assertTrue(answer, answer.contains("PendingNotesRemovalGuard.decision(context, Account(name, type), hold)"))
        assertTrue(recovery, recovery.contains("PendingNotesRemovalGuard.allows(context, account, hold)"))
        assertTrue(guard.contains("decision(context, account, hold).verdict == Verdict.ALLOW"))
        assertTrue(Regex("""\n\s*hold = hold\)\)\n\s*val verdict = decision\.verdict\n""").containsMatchIn(guard))
        assertTrue(guard.contains("check = { open(it).removalCheck(hold) })"))
    }

    @Test fun `the names these checks follow are written out, never renamed or taken with a star`() {
        // An import with as, a star import of a member and a type alias would let code use the guard, its verdict, the
        // allowance, the answer or a hold under a name the checks below don't follow.
        val pinned = """\b(PendingNotesRemovalGuard|NotesRemovalAllowance|NotesRemovalAnswer|RemovalHold)\b"""
        assertEquals(emptyList<String>(), naming(Regex("""\bimport\s+(static\s+)?(`?\w+`?\s*\.\s*)*`?$pinned`?""" +
            """(\s*\.\s*`?\w+`?)*\s*(\.\s*\*|\bas\b)""")))
        // A type alias names what it renames in its own file, so no file that names one of them declares one. Their
        // nested types (Verdict, Decision) are named outside the guard's file only through it or an import of it.
        val alias = Regex("""\btypealias\b""")
        val named = Regex(pinned)
        assertEquals(emptyList<String>(),
            sources.filterValues { alias.containsMatchIn(it) && named.containsMatchIn(it) }.keys.map { it.name })
    }

    @Test fun `only the guard asks a removal check, and the files that act on its verdict delete nothing`() {
        // An absent answer is one check, which a removal of that account alone may take as nothing to lose: no other
        // code asks a removal check or names that answer, so no clear, discard or sweep can take it for gone.
        val asking = listOf("PendingNotesRemovalGuard.kt", "PendingNotesStore.kt")
        assertEquals(asking, naming(Regex("""\bremovalCheck\b""")))
        assertEquals(asking, naming(Regex("""\bUnlistedAbsent\b""")))
        // Only the two questions that decide a removal hold the checked stores' saves back: a hold is made by a call
        // or a constructor reference (Kotlin's or Java's), either in backticks or not.
        assertEquals(listOf("GuardedRecoveryRemoval.kt", "NotesRemovalAnswer.kt"),
            naming(Regex("""\bRemovalHold`?\s*(\(\s*\)|::\s*new\b)|::\s*`?RemovalHold\b""")))
        // Every file whose code names the guard, so a file that starts to use it, by any call, reference or import,
        // shows here.
        assertEquals(listOf("GuardedRecoveryRemoval.kt", "NotesRemovalAllowance.kt", "NotesRemovalAnswer.kt",
            "NotesRemovalDialogFragment.kt", "NotesRemovalNotice.kt", "NotesRemovalOffer.kt", "NotesRemovalSection.kt",
            "NotesStartupSweep.kt", "PendingNotesRemovalGuard.kt", "UnsyncedNotesStores.kt"),
            naming(Regex("""\bPendingNotesRemovalGuard\b""")))
        // Outside its own declaration the guard is never taken as a value (a scope function's receiver, an argument),
        // only through these members: a new way to reach its verdict fails here instead of passing the pattern below.
        // Its name and its members count in backticks too; only an import directive itself is left out.
        val bare = Regex("""\bPendingNotesRemovalGuard\b(?!`?\s*(\.|::))""")
        assertEquals(listOf("PendingNotesRemovalGuard.kt"),
            sources.filterValues { bare.containsMatchIn(imports.replace(it, " ")) }.keys.map { it.name }.sorted())
        val member = Regex("""\bPendingNotesRemovalGuard`?\s*(\.|::)\s*`?(\w+)""")
        assertEquals(listOf("Cause", "CreationId", "Decision", "Row", "Verdict", "allows", "decision", "foundByPath",
            "rows"), sources.values.flatMap { text -> member.findAll(text).map { it.groupValues[2] }.toList() }
            .distinct().sorted())
        // A verdict is named only by its constants, and the verdicts are listed only through entries, in the dialog's
        // check of a reason (Verdict.entries.any): every name in a chain after Verdict is pinned, so a way through a
        // constant to all of them (declaringJavaClass.enumConstants) shows here. No type argument list opens with
        // Verdict, as Kotlin's enum helpers would need, and those helpers, which can take theirs from the expected
        // type, are used in one other file alone.
        val chain = Regex("""\bVerdict`?((\s*(\.|::)\s*`?\w+`?)+)""")
        assertEquals(listOf("any", "entries"), sources.values.flatMap { text ->
            chain.findAll(text).flatMap { Regex("""\w+""").findAll(it.groupValues[1]).map { word -> word.value } }
                .toList() }.filterNot { it.matches(Regex("""[A-Z][A-Z_]*""")) }.distinct().sorted())
        assertEquals(emptyList<String>(),
            naming(Regex("""<\s*((out|in)\s+)?(`?\w+`?\s*\.\s*)*`?Verdict\b""")))
        assertEquals(listOf("SyncStatusStore.kt"), naming(Regex("""\b(enumValues|enumValueOf|enumEntries)\b""")))
        // The files that ask for the guard's verdict, by a call, a member import or a function reference, compare with
        // an allowed one or list the verdicts are these alone, and none of them deletes, discards, clears, unregisters
        // or sweeps a store, by a call or a reference, or writes a permit.
        val verdict = Regex("""\bPendingNotesRemovalGuard`?\s*(\.|::)\s*`?(decide|decision|allows)\b|""" +
            """\bVerdict`?\s*(\.|::)\s*`?(ALLOW|entries)\b""")
        val acting = sources.filterValues { verdict.containsMatchIn(it) }
        assertEquals(listOf("GuardedRecoveryRemoval.kt", "NotesRemovalAllowance.kt", "NotesRemovalAnswer.kt",
            "NotesRemovalDialogFragment.kt", "NotesRemovalOffer.kt", "NotesRemovalSection.kt",
            "PendingNotesRemovalGuard.kt"), acting.keys.map { it.name }.sorted())
        val deleting = Regex("""\b(delete\w*|unregister\w*|discardStore|discardOrphan|discardNotebook|""" +
            """discardLocked|clearAll|clearLanded|clearStopped|removeReplacedOriginal|removeListed|removeExactly|""" +
            """removeEntry|sweep|NotesStartupSweep)\b|\.\s*`?discard`?\s*\(\s*[^)\s]|::\s*`?discard\b""")
        for ((file, text) in acting) {
            assertEquals(file.name, null, deleting.find(text)?.value)
            if (file.name != "PendingNotesRemovalGuard.kt") {
                assertFalse(file.name, text.contains("PendingNotesDiscardPermits"))
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
        // The dialog carries the confirmation's id, the row, the reason for its words and the process token: no
        // counter, fingerprint, slot or verdict, so a dialog Android restores can only show words and check again.
        assertEquals(listOf("putString(ARG_SHOWN, shown.id)", "putString(ARG_TYPE, shown.key.type)",
            "putString(ARG_NAME, shown.key.name)",
            "putStringArrayList(ARG_REASON, ArrayList(shown.reason.map { it.name }.sorted()",
            "putString(ARG_PROCESS, ProcessIncarnation.current()"),
            Regex("""put\w+\([^)]*\)""").findAll(dialog).map { it.value }.toList())
        // Only the confirmation of this process confirms; one restored in another checks again.
        assertEquals(1, Regex("""\bmodel\.confirm\(""").findAll(dialog).count())
        assertTrue(dialog.contains("if (step == Restore.SHOWN) model.confirm(id) else model.open(type, name)"))
        assertTrue(dialog.contains("val step = restore(ProcessIncarnation.isCurrent(args.getString(ARG_PROCESS)),"))
        // A dialog that has ended may follow its own tap, whose removal may be running: it says only that it ended,
        // and a Result without a name, a tap that found its confirmation ended, says the account wasn't removed.
        assertTrue(dialog, Regex("""if \(step == Restore\.ENDED \|\| reason == null\) \{\s*""" +
            """return builder\.setMessage\(R\.string\.notes_remove_uncheckable_ended\)\s""").containsMatchIn(dialog))
        assertEquals(1, Regex("""\bnotes_remove_uncheckable_ended_tap\b""").findAll(dialog).count())
        assertEquals(1, Regex("""\bResult\([^()]*,\s*(name\s*=\s*)?null\)""").findAll(dialog).count())
    }

    @Test fun `the removal section reads with the stores, off the main thread, and says nothing was tried`() {
        val fragment = code(File(ui, "UnsyncedNotesFragment.kt"))
        assertTrue(fragment, Regex("""withContext\(Dispatchers\.IO\) \{\s*UnsyncedNotesStores\.read\(getApplication\(\)\) """ +
            """to NotesRemovalSection\.read\(getApplication\(\)\)\s*\}""").containsMatchIn(fragment))
        // The screen's read, and the Settings hub row's, off the main thread with its stores too.
        assertEquals(2, Regex("""NotesRemovalSection\.read\(""").findAll(fragment).count())
        assertTrue(fragment.contains("withContext(Dispatchers.IO) {\n                    " +
            "UnsyncedNotesStores.read(app) to NotesRemovalSection.read(app)\n                }"))
        // Set together, the section first, so the listing's rows show with it.
        assertTrue(fragment.contains("mutableSection.value = section\n                mutableListing.value = read"))
        assertTrue(fragment.contains(
            "listing.rows.isEmpty() && (section == null || section.empty) -> addNote(KEY_NONE, R.string.notes_stores_none)"))
        // The section reads the accounts the way the guard does, and never names a store.
        val section = code(File(ui, "NotesRemovalSection.kt"))
        assertTrue(section.contains("AccountManager.get(context).getAccountsByType(App.accountType).map { it.name }"))
        for (word in listOf("UnsyncedNotesStores", "PendingNotesStore", "presentAccounts", "discard", "removeAccount",
                "setUserData")) {
            assertFalse(word, section.contains(word))
        }
        for (name in listOf("notes_removal_section_title", "notes_removal_section_store", "notes_removal_section_confirm",
                "notes_removal_section_unchecked")) {
            val text = stringText(name)
            for (word in listOf("wasn’t removed", "not removed", "Nothing was removed", "refused", "attempt")) {
                assertFalse("$name: $word", text.contains(word, ignoreCase = true))
            }
            assertTrue(name, text.contains("Android settings") || text.contains("finish checking"))
            assertFalse(name, text.contains("%"))
        }
        // While the accounts can't be read, the guard may still allow a removal, so that heading claims no refusal.
        assertTrue(fragment.contains("setTitle(if (section.accountsUnread) " +
            "R.string.notes_removal_section_title_unread\n" +
            "                else R.string.notes_removal_section_title)"))
        val unread = stringText("notes_removal_section_title_unread")
        for (word in listOf("can’t", "cannot", "refused", "not removed", "wasn’t removed", "attempt", "%")) {
            assertFalse("unread heading: $word", unread.contains(word, ignoreCase = true))
        }
        assertTrue(unread, unread.contains("Android settings"))
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
        // A tap that finds its confirmation ended says so before any removal, so its "didn't remove" is true: in the
        // branch that returns before the tap takes the confirmation, never in done, which can run after the removal.
        val ended = tap.indexOf("mutableResult.value = Result(Outcome.CHANGED, null)")
        assertTrue(tap, ended >= 0 && ended < tap.indexOf("offer.confirm("))
        assertTrue(tap, Regex("""if \(key == null\) \{\s*mutableResult\.value = Result\(Outcome\.CHANGED, null\)\s*""" +
            """return\s*\}\s*confirming = id\n""").containsMatchIn(tap))
    }

    @Test fun `only the authenticator's answer asks the allowance, and the stores never name it`() {
        val main = File("src/main/java")
        // Every file whose code names the allowance, so a file that starts to use it shows here; of these, the answer
        // alone asks it, by a call or a function reference.
        assertEquals(listOf("NotesRemovalAllowance.kt", "NotesRemovalAnswer.kt", "NotesRemovalDialogFragment.kt",
            "NotesRemovalOffer.kt", "UnsyncedNotesFragment.kt"), naming(Regex("""\bNotesRemovalAllowance\b""")))
        assertEquals(listOf("NotesRemovalAnswer.kt"), naming(Regex("""NotesRemovalAllowance\b[^\n]*""" +
            """(\.\s*`?answer`?\s*\(|::\s*`?answer\b)|allowance`?\s*(\.\s*`?answer`?\s*\(|::\s*`?answer\b)""")))
        // Any member it is named with is one of these: its nested types and the process instance.
        val member = Regex("""\bNotesRemovalAllowance`?\s*(\.|::)\s*`?(\w+)""")
        assertEquals(listOf("Counts", "Fingerprint", "FolderStat", "Key", "Mint", "Shown", "process"),
            sources.values.flatMap { text -> member.findAll(text).map { it.groupValues[2] }.toList() }
                .distinct().sorted())
        // The files that can reach an allowance, by any use of it besides its nested types (its process instance, its
        // constructor, a value of its type), name no answer at all besides the allowance and the answer, so a scope
        // function can't ask it either.
        val reach = Regex("""\bNotesRemovalAllowance\b""" +
            """(?!`?\s*\.\s*`?(Counts|Fingerprint|FolderStat|Key|Mint|Shown)\b)""")
        val reaching = sources.filterValues { reach.containsMatchIn(it) }
        assertEquals(listOf("NotesRemovalAllowance.kt", "NotesRemovalAnswer.kt", "NotesRemovalDialogFragment.kt",
            "NotesRemovalOffer.kt"), reaching.keys.map { it.name }.sorted())
        assertEquals(listOf("NotesRemovalAllowance.kt", "NotesRemovalAnswer.kt"),
            reaching.filterValues { Regex("""\banswer\b""").containsMatchIn(it) }.keys.map { it.name }.sorted())
        // The allowance names its answer once, where it declares it, so no member of its own hands it on under another
        // name; the answer asks it in its two steps below alone, and names the word once more in its log line.
        assertEquals(1, Regex("""\banswer\b""").findAll(allowance).count())
        val answer = code(File(ui, "NotesRemovalAnswer.kt"))
        assertEquals(listOf("allowance.answer(", "allowance.answer(", "answer:"),
            Regex("""\S*\banswer\b\S?""").findAll(answer).map { it.value }.toList())
        // The answer is made in its own file alone, named only by the authenticator and the confirmation, and through
        // these members alone, so a new way into it shows here.
        assertEquals(listOf("NotesRemovalAnswer.kt"),
            naming(Regex("""\bNotesRemovalAnswer`?\s*\(|::\s*`?NotesRemovalAnswer\b""")))
        assertEquals(listOf("AccountAuthenticatorService.kt", "NotesRemovalAnswer.kt", "NotesRemovalDialogFragment.kt"),
            naming(Regex("""\bNotesRemovalAnswer\b""")))
        val answerMember = Regex("""\bNotesRemovalAnswer`?\s*(\.|::)\s*`?(\w+)""")
        assertEquals(listOf("Asking", "allowedInApp", "allowedOnDevice", "askInApp", "withheldInApp"),
            sources.values.flatMap { text -> answerMember.findAll(text).map { it.groupValues[2] }.toList() }
                .distinct().sorted())
        // The guard's decision first, its store checks taking one hold, the fingerprint only for an eligible verdict,
        // then the allowance; a throw anywhere takes the row's slot out and answers no. Only a yes hands the hold on.
        val allowed = answer.substringAfter("fun allowed(type: String?, name: String?): Boolean {", "")
            .substringBefore("\n    }\n")
        val steps = listOf("val hold = RemovalHold()", "seams.decision(type, name, hold)",
            "if (decided.verdict.eligible) seams.fingerprint(decided) else null",
            "allowance.answer(Key(type, name, decided.creationId), decided.verdict, fingerprint)",
            "} catch (t: Throwable) {", "Verdict.REFUSE_FAILED, null)", "if (yes) seams.held(hold) else hold.release()")
        assertTrue(allowed, steps.all { allowed.contains(it) })
        assertEquals(steps.sortedBy { allowed.indexOf(it) }, steps)
        assertEquals("one log line, with no name",
            listOf("Logger.log.info(\"Notes removal answer: \$verdict, allowed \$allowed\")"),
            answer.lines().filter { "Logger." in it }.map { it.trim() })
        // The authenticator answers through it alone, with a result and never an intent: the whole override is this.
        val authenticator = code(File(main, "io/silentsuite/sync/syncadapter/AccountAuthenticatorService.kt"))
        val override = authenticator.substringAfter("override fun getAccountRemovalAllowed(", "")
            .substringBefore("\n    }\n")
        assertEquals("response: AccountAuthenticatorResponse?, account: Account?): Bundle =\n" +
            "            Bundle(1).apply {\n" +
            "                putBoolean(AccountManager.KEY_BOOLEAN_RESULT, " +
            "NotesRemovalAnswer.allowedOnDevice(context, account))\n" +
            "            }", override.trimEnd())
        assertEquals(1, Regex("""NotesRemovalAnswer\.""").findAll(authenticator).count())
        // And no other code asks the device's answer, so only Android's own question gets it.
        assertEquals(listOf("AccountAuthenticatorService.kt", "NotesRemovalAnswer.kt"),
            naming(Regex("""\ballowedOnDevice\b""")))
        for (store in listOf("notes/edit/PendingNotesStore.kt", "notes/edit/PendingNotesDiscardPermits.kt",
                "ui/UnsyncedNotesStores.kt")) {
            val text = code(File(main, "io/silentsuite/sync/$store"))
            assertFalse(store, text.contains("NotesRemovalAllowance") || text.contains("AccountRowChanges"))
        }
        // The authenticator runs in the app's own process, as no manifest of this module's source sets (but test and
        // androidTest) names a process, and it overrides no cloning of accounts.
        val manifests = File("src").listFiles().orEmpty().filter { it.name !in setOf("test", "androidTest") }
            .map { File(it, "AndroidManifest.xml") }.filter { it.isFile }
        assertTrue(manifests.toString(), manifests.any { it.parentFile.name == "main" })
        for (manifest in manifests) {
            assertFalse(manifest.path, manifest.readText().contains("android:process"))
        }
        for (word in listOf("getAccountCredentialsForCloning", "addAccountFromCredentials")) {
            assertFalse(word, authenticator.contains(word))
        }
    }

    @Test fun `a no during the confirmation's removal waits for its outcome, posted unless its screen says it`() {
        val tap = dialog.substringAfter("fun confirm(id: String) {\n", "").substringBefore("\n    }\n")
        val marked = tap.indexOf("val marked = NotesRemovalAnswer.askInApp(key.type, key.name)")
        assertTrue(tap, marked > tap.indexOf("confirming = id\n") && marked < tap.indexOf("offer.confirm("))
        assertTrue(tap, tap.contains("asking += marked"))
        // The mark ends on the main thread with the outcome set, as onCleared runs there, so one of the two ends it;
        // once the user has left the screen (onPause, which comes first on Home, Back, Recents and the power
        // button), or for an outcome that can't say whether the account was removed, the no the mark took is
        // posted then.
        assertTrue(tap, Regex("""viewModelScope\.launch \{\s*asking -= marked\s*""" +
            """if \(inFront && outcome != Outcome\.UNKNOWN\) marked\.done\(\) """ +
            """else marked\.left\(\)\?\.let \{ post\(it\) \}\s*""" +
            """if \(confirming == id\) confirming = null\s*mutableResult\.value = Result\(outcome, key\.name\)\s*\}""")
            .containsMatchIn(tap))
        val cleared = dialog.substringAfter("override fun onCleared() {\n", "").substringBefore("\n    }\n")
        assertTrue(cleared, cleared.contains("for (marked in asking) marked.left()?.let { post(it) }"))
        val screen = code(File(ui, "UnsyncedNotesFragment.kt"))
        assertTrue(screen, screen.contains("super.onResume()\n        removal.inFront = true\n"))
        assertTrue(screen, screen.contains("override fun onPause() {\n        removal.inFront = false\n" +
            "        super.onPause()\n    }"))
        assertTrue(dialog.contains("\n    var inFront = false\n"))
        assertTrue(cleared, cleared.trimEnd().endsWith("asking.clear()"))
        assertTrue(dialog.contains("private fun post(kind: NotesRemovalNotice.Kind) {\n        try {\n" +
            "            NotesRemovalNotice.post(getApplication(), kind)\n        } catch (ignored: Exception) {\n"))
        // On the device, the answer asks the marks themselves.
        val answer = code(File(ui, "NotesRemovalAnswer.kt"))
        assertTrue(Regex("""override fun withheldInApp\(type: String, name: String, kind: Kind\) =\s*""" +
            """NotesRemovalAnswer\.withheldInApp\(type, name, kind\)\n""").containsMatchIn(answer))
        assertTrue(answer.contains(
            "override fun allowedInApp(type: String, name: String) = NotesRemovalAnswer.allowedInApp(type, name)\n"))
        // Only the confirmation marks a removal, and only the answer asks the marks or clears them. The mark's class is
        // named there and in the confirmation alone, it declares these functions alone, and no other code names its
        // withhold or allow by name (a call, a reference, an infix call or the name written in a string).
        assertEquals(listOf("NotesRemovalAnswer.kt", "NotesRemovalDialogFragment.kt"),
            naming(Regex("""\baskInApp\b""")))
        assertEquals(listOf("NotesRemovalAnswer.kt"), naming(Regex("""\b(withheldInApp|allowedInApp)\b""")))
        assertEquals(listOf("NotesRemovalAnswer.kt", "NotesRemovalDialogFragment.kt"), naming(Regex("""\bAsking\b""")))
        val asking = answer.substringAfter("internal class Asking(", "").substringBefore("\n    }\n")
        assertEquals(listOf("fun withhold", "fun allow", "fun done", "fun left", "private fun end"),
            Regex("""(?m)^\s*((\w+\s+)*fun\s+`?\w+`?)""").findAll(asking).map { it.groupValues[1] }.toList())
        assertEquals(listOf("NotesRemovalAnswer.kt"), naming(Regex("""\b(withhold|allow)\b""")))
        // By name, the confirmation names askInApp once, at its tap; done four times (the mark's done in its
        // outcome, and its own done where it declares it, hands it to the offer and calls it on a retry); left twice
        // (its outcome and onCleared); and its set of marks five times (its declaration and the four uses above).
        assertTrue(dialog.contains("private val asking = mutableSetOf<NotesRemovalAnswer.Asking>()\n"))
        assertTrue(dialog.contains("offer.confirm(key.type, key.name, id, tapped, ::done)") &&
            dialog.contains("fun done(outcome: Outcome) {") && dialog.contains("done(Outcome.RETRY)"))
        assertEquals(listOf(1, 4, 2, 5), listOf("askInApp", "done", "left", "asking")
            .map { Regex("""\b$it\b""").findAll(dialog).count() })
        // Only the screen's onResume and onPause set the flag, besides its declaration: any other write could keep a
        // screen the user has left counted as in front, and drop the no. No other file names it, as a Java setInFront
        // or a property reference included. In these two it shows only where the checks above put it, by name (a write,
        // a reference, a name that shadows it, the name written in a string): declared and read in the confirmation,
        // set in the screen's onResume and onPause. A blank line follows its declaration, so no accessor sits directly
        // under it, and none of the five files below gives a member a JVM name of its own with a Jvm annotation.
        assertEquals(listOf("NotesRemovalDialogFragment.kt", "UnsyncedNotesFragment.kt"),
            naming(Regex("(?i)infront")))
        assertEquals(2, Regex("(?i)infront").findAll(dialog).count())
        assertEquals(2, Regex("(?i)infront").findAll(screen).count())
        assertTrue(dialog.contains("\n    var inFront = false\n\n"))
        for (name in listOf("NotesRemovalAnswer.kt", "NotesRemovalAllowance.kt", "NotesRemovalDialogFragment.kt",
                "UnsyncedNotesFragment.kt", "PendingNotesRemovalGuard.kt")) {
            assertFalse(name, Regex("""\bJvm\w+""").containsMatchIn(code(File(ui, name))))
        }
    }

    /** The text of the string resource [name] in the default resources. */
    private fun stringText(name: String): String =
        Regex("<string name=\"$name\">(.*?)</string>").find(File("src/main/res/values/strings.xml").readText())
            ?.groupValues?.get(1) ?: throw AssertionError("no string $name")

    @Test fun `the refusal notification names no account, shows the same text when locked, and opens Unsynced Notes`() {
        val notice = code(File(ui, "NotesRemovalNotice.kt"))
        // Nothing of an account reaches it: no Account, no name, no user data.
        assertFalse(notice, Regex("""\bAccount\b|\bname\b|getUserData|accountName""").containsMatchIn(notice))
        // The two wrappers for the app's own removals take a function, so the match ends inside its type.
        assertEquals(listOf("fun kind(decision: Decision?)", "fun text(kind: Kind)", "fun post(context: Context, kind: Kind)",
            "fun clearAfter(context: Context, callback: (Boolean)", "fun afterRemoval(clear: ()",
            "fun clear(context: Context)"), Regex("""fun \w+\([^)]*\)""").findAll(notice).map { it.value }.toList())
        for (said in listOf("if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return",
                ".setVisibility(NotificationCompat.VISIBILITY_PUBLIC)", ".setAutoCancel(true)",
                "AppSettingsActivity.newUnsyncedNotesIntent(context)",
                "PendingIntent.getActivity(context, Constants.NOTIFICATION_NOTES_REMOVAL_REFUSED, open,",
                "PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE",
                "NotificationUtils.notify(context, Constants.NOTIFICATION_NOTES_REMOVAL_REFUSED, notification)")) {
            assertTrue(said, notice.contains(said))
        }
        assertEquals("one post", 1, Regex("""\.notify\(""").findAll(notice).count())
        assertFalse("no public version that differs", notice.contains("setPublicVersion"))
        for (kind in listOf("store", "confirm", "unchecked")) {
            val text = stringText("notes_removal_refused_$kind")
            assertFalse(kind, text.contains("%"))
            assertTrue(kind, text.contains("so the account wasn’t removed") ||
                text.contains("and the account wasn’t removed"))
            // Scoped to the attempt: a confirmed discard of the same store may have deleted text before it.
            assertTrue(kind, text.contains("This attempt deleted no Notes text."))
            assertFalse(kind, text.contains("No Notes text was deleted") || text.contains("nothing", ignoreCase = true))
        }
        assertFalse(stringText("notes_removal_refused_title").contains("%"))
        // A store refusal may be another account's store, one that can't be read, or a race: no claim of what was found.
        assertFalse(stringText("notes_removal_refused_store").contains("found"))
        // Android settings refuses these again while their cause lasts (unsynced or unreadable changes, names of an
        // unknown kind, an eligible verdict), so neither says to try again.
        for (kind in listOf("store", "confirm")) {
            assertFalse("$kind: a retry from Android settings gets the same answer while its cause lasts",
                stringText("notes_removal_refused_$kind").contains("try again", ignoreCase = true))
        }
        // A check that couldn't finish may pass later: the maintainer's answer on #709, 2026-10-22, asks it to say so.
        assertTrue(stringText("notes_removal_refused_unchecked").endsWith("Try again later, or tap for details."))
    }

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
        // A result that leaves the account says only that this attempt didn't remove it, never that nothing was.
        for (result in listOf("readable", "changed", "retry")) {
            val text = stringText("notes_remove_uncheckable_$result")
            assertTrue(result, text.startsWith("This attempt didn’t remove %1\$s"))
            assertFalse(result, text.contains("Nothing was removed"))
        }
        // READABLE also follows a folder shown gone, and CHANGED a moved counter, a replaced confirmation or a creation
        // in progress: neither claims that a folder reads again or that the accounts changed.
        assertFalse(stringText("notes_remove_uncheckable_readable").contains("can read"))
        assertFalse(stringText("notes_remove_uncheckable_changed").contains("accounts", ignoreCase = true))
        assertEquals("%1\$s was removed from this device.", stringText("notes_remove_uncheckable_done"))
        // Rows that cannot be read after Android answered prove nothing either way, and the app's own lists cannot
        // answer for a row without a readable creation id.
        val unknown = stringText("notes_remove_uncheckable_unknown")
        assertFalse(unknown.contains("Nothing was removed") || unknown.contains("Review the list"))
        // A dialog that has ended may follow its own tap, whose removal may be running, so it says only that it ended.
        // A tap on one stops before any removal, so it says, as the others do, that this attempt didn't remove it.
        assertEquals("This confirmation has ended.", stringText("notes_remove_uncheckable_ended"))
        val endedTap = stringText("notes_remove_uncheckable_ended_tap")
        assertEquals("This attempt didn’t remove the account, because this confirmation had ended.", endedTap)
        assertFalse(endedTap.contains("%") || endedTap.contains("delet", ignoreCase = true))
        assertFalse(Regex("""<!-- Settings, Unsynced Notes: the one-time confirmed removal[^\n]*Placeholder""")
            .containsMatchIn(File("src/main/res/values/strings.xml").readText()))
    }
}
