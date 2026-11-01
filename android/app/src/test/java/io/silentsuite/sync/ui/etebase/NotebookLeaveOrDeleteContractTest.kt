package io.silentsuite.sync.ui.etebase

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Text checks of the leave and delete of a Notes notebook: only the Notes branch of the two screens every collection
 * type shares changed, the discard comes after the server call and before the Notes run, every dialog is shown through
 * one helper that checks the saved state, and the words for a store that could not be listed call nothing a discard.
 */
class NotebookLeaveOrDeleteContractTest {
    private val etebase = File("src/main/java/io/silentsuite/sync/ui/etebase")

    private fun source(name: String) = File(etebase, name).readText().replace("\r\n", "\n")

    /** [name]'s code, without comments, so a KDoc that names something does not count. */
    private fun code(name: String) =
        source(name).replace(Regex("(?s)/\\*.*?\\*/"), "").replace(Regex("//[^\n]*"), "")

    /** What follows [start] in [text], up to the first closing brace at [indent]: one function or block. */
    private fun body(text: String, start: String, indent: String = "    ") =
        text.substringAfter(start, "").substringBefore("\n$indent}\n")

    private val newFiles = listOf("NotebookLeaveOrDelete.kt", "NotebookLeaveOrDeletePolicy.kt",
        "NotebookLeaveOrDeleteDialogFragment.kt")

    private companion object {
        /** The Notes branches' confirmed delete and leave, in EditCollectionFragment and CollectionMembersFragment. */
        const val DELETE_NOTEBOOK = "private fun deleteNotebook(identity: CollectionLifecycleIdentity, shown: "
        const val LEAVE_NOTEBOOK = "private fun leaveNotebook(identity: CollectionLifecycleIdentity, shown: "
    }

    private fun resources(name: String) = File("src/main/res/values/$name").readText().replace("\r\n", "\n")

    /** The text of the string resource [name] in the default resources. */
    private fun stringText(name: String): String =
        Regex("<string name=\"$name\">(.*?)</string>").find(resources("strings.xml"))?.groupValues?.get(1)
            ?: throw AssertionError("no string $name")

    /** The texts of each quantity of the plurals resource [name]. */
    private fun pluralTexts(name: String): List<String> {
        val items = Regex("(?s)<plurals name=\"$name\">(.*?)</plurals>").find(resources("plurals.xml"))
            ?.groupValues?.get(1) ?: throw AssertionError("no plurals $name")
        return Regex("<item quantity=\"\\w+\">(.*?)</item>").findAll(items).map { it.groupValues[1] }.toList()
    }

    @Test fun `only the Notes branch of the shared delete and leave changed, and other types keep today's code`() {
        val edit = source("EditCollectionFragment.kt")
        val delete = body(edit, "private fun deleteColection() {")
        assertTrue(delete, delete.startsWith("\n        val identity = CollectionLifecycleIdentity.from(arguments)\n" +
            "        if (identity != null && identity.collectionType == Constants.ETEBASE_TYPE_NOTES) {\n" +
            "            askBeforeNotebookDelete(identity)\n            return\n        }\n"))
        val today = delete.substringAfter("            return\n        }\n")
        for (kept in listOf(".setTitle(R.string.delete_collection_confirm_title)",
                ".setMessage(getString(R.string.delete_collection_confirm_warning, name))",
                ".setPositiveButton(android.R.string.yes) { dialog, _ ->\n                    doDeleteCollection()",
                ".setNegativeButton(android.R.string.no) { _, _ -> }")) {
            assertTrue(kept, today.contains(kept))
        }
        // Today's delete deletes a copy, marks the screen's own collection deleted only once the upload went
        // through, and asks nothing of the Notes store.
        val doDelete = body(edit, "private fun doDeleteCollection() {")
        assertTrue(doDelete.contains("val col = colMgr.cacheLoad(colMgr.cacheSave(onScreen))\n") &&
            doDelete.contains("col.delete()\n") &&
            doDelete.contains("if (!uploadCollection(identity, applicationContext, col)) return@withContext false") &&
            doDelete.contains("onScreen.delete()\n"))
        assertFalse(doDelete.contains("Notebook"))

        val members = source("CollectionMembersFragment.kt")
        val leave = body(members, "v.findViewById<Button>(R.id.leave).setOnClickListener {", "            ")
        assertTrue(leave, leave.startsWith(
            "\n                val identity = CollectionLifecycleIdentity.from(arguments)\n" +
            "                if (identity != null && identity.collectionType == Constants.ETEBASE_TYPE_NOTES) {\n" +
            "                    askBeforeNotebookLeave(identity, leavesWhenNothing = true)\n" +
            "                    return@setOnClickListener\n" +
            "                }\n"))
        val other = leave.substringAfter("return@setOnClickListener\n                }\n")
        assertTrue(other.contains("membersManager.leave()") &&
            other.contains("requestSync(applicationContext, model.value!!.account)"))
        assertFalse("a leave of another type still has no catch", other.contains("catch"))
        assertFalse(other.contains("Notebook"))
        assertTrue("the catch of a failed leave is the Notes one's alone",
            body(members, LEAVE_NOTEBOOK).contains("} catch (e: EtebaseException) {"))
    }

    @Test fun `the discard comes after the server call and before the Notes run, and the delete deletes a copy`() {
        val edit = source("EditCollectionFragment.kt")
        val delete = body(edit, DELETE_NOTEBOOK)
        // The screen's own collection is marked deleted only once the server has the delete, and is never uploaded:
        // a screen the IO block outlives then cannot bring the notebook back with a Save.
        val steps = listOf("NotebookLeaveOrDelete.remove(shown,",
            "val col = colMgr.cacheLoad(colMgr.cacheSave(cachedCollection.col))", "col.delete()",
            "val uploaded = uploadCollection(identity, applicationContext, col)",
            "if (uploaded) cachedCollection.col.delete()\n", "uploaded\n",
            "discard = { NotebookLeaveOrDelete.discard(applicationContext, identity, it) })", "requestSync(")
        val at = steps.map { delete.indexOf(it) }
        assertTrue("$at", at.first() >= 0 && at.zipWithNext().all { (a, b) -> a < b })
        assertEquals("the copy's delete, then the screen's own after the upload",
            listOf("col.delete()", "cachedCollection.col.delete()"),
            Regex("[\\w.]*\\.delete\\(\\)").findAll(delete).map { it.value }.toList())
        val upload = body(edit, "private fun uploadCollection(")
        assertFalse("the upload names no discard",
            upload.contains("NotebookLeaveOrDelete") || upload.contains("discard"))

        val members = source("CollectionMembersFragment.kt")
        val leave = body(members, LEAVE_NOTEBOOK)
        val leaveSteps = listOf("NotebookLeaveOrDelete.remove(shown,", "membersManager.leave()",
            "discard = { NotebookLeaveOrDelete.discard(applicationContext, identity, it) })", "requestSync(")
        val leaveAt = leaveSteps.map { leave.indexOf(it) }
        assertTrue("$leaveAt", leaveAt.first() >= 0 && leaveAt.zipWithNext().all { (a, b) -> a < b })
    }

    /**
     * [name]'s classes without the Notes code of this flow: its section, from the line holding [section] up to [next],
     * the function after it, and [gate], the Notes branch of Delete or Leave. What is left is today's code.
     */
    private fun today(name: String, section: String, next: String, gate: String): String {
        val screen = source(name)
        val from = screen.indexOf(section)
        val to = if (from < 0) -1 else screen.indexOf(next, from)
        assertTrue("$name: the Notes section is found", from >= 0 && to > from)
        val rest = screen.removeRange(from, to)
        assertEquals("$name: the Notes gate is found once", 1, rest.split(gate).size - 1)
        return rest.replace(gate, "").substringAfter("\nclass ")
    }

    @Test fun `today's checks outside the Notes code keep their number, so the Notes code cannot stand in for them`() {
        val edit = today("EditCollectionFragment.kt", "    // ---- the delete of a Notes notebook",
            "    private fun saveCollection() {",
            "        val identity = CollectionLifecycleIdentity.from(arguments)\n" +
            "        if (identity != null && identity.collectionType == Constants.ETEBASE_TYPE_NOTES) {\n" +
            "            askBeforeNotebookDelete(identity)\n            return\n        }\n")
        val members = today("CollectionMembersFragment.kt", "    // ---- the leave of a Notes notebook",
            "    private fun addMemberClicked() {",
            "                if (identity != null && identity.collectionType == Constants.ETEBASE_TYPE_NOTES) {\n" +
            "                    askBeforeNotebookLeave(identity, leavesWhenNothing = true)\n" +
            "                    return@setOnClickListener\n                }\n")
        for ((name, text) in listOf("EditCollectionFragment.kt" to edit, "CollectionMembersFragment.kt" to members)) {
            assertFalse("$name: all of the Notes code is cut out", text.contains("Notebook"))
        }
        // CollectionLifecycleContractTest and SiblingMaterialAccessibilityContractTest find these anywhere in a file,
        // and the Notes code holds the same text, so here they are counted in today's code alone, as on main.
        fun counts(text: String, checks: List<String>) = checks.associateWith { text.split(it).size - 1 }
        val identity = "CollectionLifecycleIdentity.from(arguments)"
        // The account checks are named for the context they pass, not for a thread: saveFixtureCollection checks with
        // the application context on the main thread as well.
        val withScreen = "identity.validate(requireContext())"
        val withApplication = "identity.validate(applicationContext)"
        val guard = "if (loadingModel.isLoading) return\n"
        val upload = "uploadCollection(identity, applicationContext, col)"
        assertEquals("EditCollectionFragment.kt",
            mapOf(identity to 5, withScreen to 3, withApplication to 8, guard to 2, upload to 2),
            counts(edit, listOf(identity, withScreen, withApplication, guard, upload)))
        assertEquals("CollectionMembersFragment.kt", mapOf(identity to 7, withScreen to 6, withApplication to 4),
            counts(members, listOf(identity, withScreen, withApplication)))
    }

    @Test fun `the new code names no permit, acknowledgement or whole-store discard, nor asks exists`() {
        val forbidden = listOf("discardStore", "acknowledge(", "acknowledged(", "coverForTesting",
            "PendingNotesDiscardPermits", "clearAll", "unregister")
        for (name in newFiles + listOf("EditCollectionFragment.kt", "CollectionMembersFragment.kt")) {
            val code = code(name)
            for (word in forbidden) assertFalse("$name names $word", code.contains(word))
        }
        for (name in newFiles) {
            assertFalse(name, Regex("""\b(exists|notExists|isFile|isDirectory)\b""").containsMatchIn(code(name)))
        }
    }

    @Test fun `every dialog of the flow is shown through one helper that checks the saved state`() {
        val dialog = code("NotebookLeaveOrDeleteDialogFragment.kt")
        val show = body(dialog, "internal fun show(", "        ")
        assertTrue(show.contains("if (!host.isAdded || host.childFragmentManager.isStateSaved) return false"))
        assertTrue(show.contains(
            "val open = host.childFragmentManager.findFragmentByTag(tag) as? NotebookLeaveOrDeleteDialogFragment\n"))
        assertTrue(show.contains("if (open != null && !open.ended) return true"))
        assertTrue(show.contains("}.show(host.childFragmentManager, tag)"))
        assertEquals("made and shown there alone", listOf(1, 1),
            listOf("NotebookLeaveOrDeleteDialogFragment()", ".show(").map { dialog.split(it).size - 1 })
        assertTrue("a failure shows through it too", body(dialog, "internal fun failed(", "        ")
            .contains("if (show(host, identity, kind, Step.FAILED, UnsyncedNotes.NOTHING, message, kept, stopped)) " +
                "return"))
        for (name in listOf("EditCollectionFragment.kt", "CollectionMembersFragment.kt")) {
            val screen = code(name)
            val uses = Regex("NotebookLeaveOrDeleteDialogFragment\\.(\\w+)\\(").findAll(screen)
                .map { it.groupValues[1] }.toSet()
            assertEquals(name, setOf("show", "failed"), uses)
            assertFalse(name, screen.contains("NotebookLeaveOrDeleteDialogFragment()"))
        }
    }

    @Test fun `a screen takes an answer for its own notebook once it is loaded, and the last question closes it`() {
        for ((name, confirmed) in listOf("EditCollectionFragment.kt" to DELETE_NOTEBOOK,
                "CollectionMembersFragment.kt" to LEAVE_NOTEBOOK)) {
            val screen = source(name)
            val answer = body(screen, "internal fun onNotebookAnswer(")
            val at = listOf("if (identity != CollectionLifecycleIdentity.from(arguments)) return",
                "if (step == Step.AGAIN) {", "if (!notebookLoaded(identity)) return",
                "when (val next = NotebookLeaveOrDeletePolicy.answered(answer, shown, fromThisProcess)) {")
                .map { answer.indexOf(it) }
            assertTrue("$name $at", at.first() >= 0 && at.zipWithNext().all { (a, b) -> a < b })
            // Either answer to the one more question closes the screen, which holds the notebook as it was: Keep at
            // once, and Discard once it ran.
            val again = body(screen, "private fun answerAgain(")
            assertTrue(name, again.substringAfter("    ) {\n").startsWith(
                "        val next = NotebookLeaveOrDeletePolicy.answered(answer, now, fromThisProcess)\n" +
                "        if (next == Next.CountAgain) {\n            askAgainOnceMore(identity)\n            return\n" +
                "        }\n        if (next !is Next.Proceed) {\n            activity?.finish()\n" +
                "            return\n        }\n"))
            assertTrue(name, again.contains(
                "} finally {\n                loadingModel.setLoading(false)\n                activity?.finish()\n"))
            // When it cannot be asked, nothing more is deleted, and that is said.
            val run = body(screen, confirmed)
            assertTrue(name, run.contains(
                "is After.AskAgainAfter -> if (!showNotebookStep(identity, Step.AGAIN, after.now)) {\n" +
                "                        NotebookLeaveOrDelete.postResult(applicationContext, " +
                "R.string.notes_notebook_kept_changed)\n                        activity?.finish()\n"))
            // A leave or delete that went through, or an account that changed, closes the screen too.
            assertTrue(name, run.contains("                    After.Quiet, is After.Say -> activity?.finish()\n"))
            assertTrue(name, run.contains("} catch (e: CancellationException) {") && run.contains("throw e\n"))
        }
    }

    @Test fun `each dialog's buttons send the answer they name, and only a confirmation sends the discard`() {
        val dialog = code("NotebookLeaveOrDeleteDialogFragment.kt")
        /** The builder calls of one step, up to its create(). */
        fun step(name: String) = dialog.substringAfter("Step.$name -> ", "").substringBefore(".create()")
        fun sent(text: String) = Regex("send\\(Answer\\.(\\w+)\\)").findAll(text).map { it.groupValues[1] }.toList()
        // The count: Sync now, and going on only where it is offered, which leads to the separate confirmation.
        val count = step("COUNT")
        assertTrue(count.contains(
            ".setPositiveButton(R.string.account_synchronize_now) { _, _ -> send(Answer.SYNC_NOW) }"))
        val offered = count.indexOf("if (NotebookLeaveOrDeletePolicy.offersGoingOn(shown)) it.setNeutralButton(")
        val goOn = count.indexOf("}) { _, _ -> send(Answer.GO_ON_WITHOUT_SYNCING) }")
        assertTrue("$offered $goOn", offered >= 0 && offered < goOn)
        assertEquals("the count never confirms", listOf("SYNC_NOW", "GO_ON_WITHOUT_SYNCING"), sent(count))
        // Today's question, the confirmation and the one more question each confirm with one button.
        assertTrue(step("PLAIN").contains(".setPositiveButton(android.R.string.yes) { _, _ -> send(Answer.DISCARD) }"))
        assertTrue(step("DISCARD").contains("}) { _, _ -> send(Answer.DISCARD) }"))
        assertTrue(step("AGAIN").contains(
            ".setPositiveButton(R.string.notes_notebook_discard) { _, _ -> send(Answer.DISCARD) }"))
        for ((name, answers) in listOf("PLAIN" to listOf("DISCARD"), "DISCARD" to listOf("DISCARD"),
                "AGAIN" to listOf("KEEP", "DISCARD"), "FAILED" to emptyList())) {
            assertEquals(name, answers, sent(step(name)))
        }
    }

    @Test fun `a delete with nothing unsynced asks today's question, and such a leave goes on at once`() {
        val ask = body(source("EditCollectionFragment.kt"),
            "private fun askBeforeNotebookDelete(identity: CollectionLifecycleIdentity) {")
        assertTrue(ask.contains("Start.Plain -> showNotebookStep(identity, Step.PLAIN, UnsyncedNotes.NOTHING)\n"))
        assertFalse("a delete always asks first", ask.contains("deleteNotebook("))
        val dialog = code("NotebookLeaveOrDeleteDialogFragment.kt")
        val plain = dialog.substringAfter("Step.PLAIN -> ", "").substringBefore("Step.COUNT -> ")
        assertTrue(plain.contains(".setTitle(R.string.delete_collection_confirm_title)\n"))
        assertTrue(plain.contains(".setMessage(plainWarning(collectionModel.value))\n"))
        // Today's words with the notebook's name, which follows the collection once it has loaded.
        assertTrue(plain.contains("collectionModel.observe(this) { dialog.setMessage(plainWarning(it)) }"))
        val warning = body(dialog, "private fun plainWarning(collection: CachedCollection?): String")
        assertTrue(warning.contains("getString(R.string.delete_collection_confirm_warning, it)"))
        val leave = body(source("CollectionMembersFragment.kt"),
            "private fun askBeforeNotebookLeave(identity: CollectionLifecycleIdentity, leavesWhenNothing: Boolean) {")
        assertTrue(leave.contains(
            "Start.Plain -> if (leavesWhenNothing) leaveNotebook(identity, UnsyncedNotes.NOTHING)\n"))
    }

    /**
     * Each withContext(Dispatchers.IO) block of [text], from its opening brace to the brace that closes it. Braces are
     * counted as they come: the screens' code has none in a string or a character that does not pair.
     */
    private fun ioBlocks(text: String): List<IntRange> =
        Regex("""withContext\(\s*Dispatchers\.IO\s*\)\s*\{""").findAll(text).map { open ->
            var depth = 0
            var close = -1
            for (i in open.range.last until text.length) {
                if (text[i] == '{') depth++
                if (text[i] == '}' && --depth == 0) {
                    close = i
                    break
                }
            }
            assertTrue("an IO block that does not close", close > open.range.last)
            open.range.last..close
        }.toList()

    /** A call or callable reference of a member of the glue: the member is group 2, so a nested type is not one. */
    private val glueCall = Regex("""\bNotebookLeaveOrDelete\s*(\.|::)\s*([a-z]\w*)""")

    /** A call or callable reference of a member of the pending store, or of its companion. */
    private val storeCall = Regex("""\bPendingNotesStore(\s*\.\s*Companion)?\s*(\.|::)\s*([a-z]\w*)""")

    @Test fun `a count that throws could not be counted, and the screens reach the store only inside IO blocks`() {
        val glue = code("NotebookLeaveOrDelete.kt")
        assertTrue(glue.contains(
            "fun count(context: Context, identity: CollectionLifecycleIdentity): UnsyncedNotes = runCatching {\n" +
            "        store(context, identity).unsyncedInNotebook(requireNotNull(identity.collectionUid))\n" +
            "    }.getOrDefault(NotebookLeaveOrDeletePolicy.countFailed)\n"))
        // The glue opens the store in one place, and only its count, its discard and its check of a stopped discard use
        // it. That check also reads, from memory, the folders of stopped instances when the store cannot be opened.
        assertEquals("the glue's calls of the store", listOf("forIdentity", "identityDir", "stoppedIn"),
            storeCall.findAll(glue).map { it.groupValues[3] }.toList())
        val opener = Regex("""\bstore\(""")
        val opens = Regex("""\bstore\(context, identity\)""").findAll(glue).map { it.range.first }.toList()
        assertEquals("the count's, the discard's and the check's", 3, opens.size)
        assertEquals("and no other use of the opener", 4, opener.findAll(glue).count())
        for ((at, function) in opens.zip(listOf("fun count(", "fun discard(", "fun stopped("))) {
            assertEquals(function, glue.lastIndexOf("    $function", at), glue.lastIndexOf("    fun ", at))
        }
        // Sync now asks for a Notes run and touches no pending store, so it stays on the main thread.
        val sync = body(glue, "fun syncNotesNow(context: Context, identity: CollectionLifecycleIdentity): SyncAsked {")
        assertTrue("Sync now is found", sync.contains("NotesSyncCoordinator.request("))
        assertFalse(sync, opener.containsMatchIn(sync) || storeCall.containsMatchIn(sync))
        // Nor does it through the glue's own members, called by their plain names, and neither does the result
        // posting, which may run on any thread.
        val reachesStore = Regex("""(?<![.\w])(store|count|discard|stopped|remove|again)\(""")
        val posting = glue.substringAfter("    fun postResult(context: Context, text: CharSequence) {", "")
        assertTrue("the result posting is found", posting.contains("Toast.makeText("))
        for (part in listOf(sync, posting)) assertFalse(part, reachesStore.containsMatchIn(part))
        for (name in listOf("NotebookLeaveOrDeletePolicy.kt", "NotebookLeaveOrDeleteDialogFragment.kt")) {
            assertEquals(name, emptyList<String>(), storeCall.findAll(code(name)).map { it.value }.toList())
        }
        // The dialog calls no member of the glue but postResult, and the policy none.
        val dialog = code("NotebookLeaveOrDeleteDialogFragment.kt")
        assertEquals("the dialog's", listOf("postResult"),
            glueCall.findAll(dialog).map { it.groupValues[2] }.distinct().toList())
        assertEquals("the policy's", emptyList<String>(),
            glueCall.findAll(code("NotebookLeaveOrDeletePolicy.kt")).map { it.value }.toList())

        val onIo = mapOf("count" to 3, "discard" to 2, "stopped" to 1, "remove" to 1, "again" to 1, "running" to 1,
            "cancel" to 1)
        for (name in listOf("EditCollectionFragment.kt", "CollectionMembersFragment.kt")) {
            val screen = code(name)
            assertFalse(name, screen.contains("unsyncedInNotebook") || screen.contains("PendingNotesStore"))
            assertEquals(name, 3, screen.split("NotebookLeaveOrDelete.count(applicationContext, identity)").size - 1)
            val io = ioBlocks(screen)
            val calls = glueCall.findAll(screen).toList()
            assertEquals("$name: the glue's members a screen calls",
                (onIo.keys + setOf("postResult", "syncNotesNow")).sorted(),
                calls.map { it.groupValues[2] }.distinct().sorted())
            // Each store call, the check of a stopped discard and the cancel of the Notes run starts inside a
            // withContext(Dispatchers.IO) block: the block of the count before the first dialog, which also runs for
            // an answer from a dialog made in another process to any step but the one more question, the block of the
            // confirmed run, the block of the one more question's again(), and the block of its count for an answer to
            // the one more question from a dialog made in another process.
            val reaching = calls.filter { it.groupValues[2] in onIo }
            assertEquals(name, onIo, reaching.groupingBy { it.groupValues[2] }.eachCount())
            for (call in reaching) {
                assertTrue("$name: ${call.value} is not inside withContext(Dispatchers.IO)",
                    io.any { call.range.first in it })
            }
            val syncs = calls.filter { it.groupValues[2] == "syncNotesNow" }
            assertEquals(name, 1, syncs.size)
            assertFalse("$name: Sync now runs on the main thread", io.any { syncs.single().range.first in it })
        }
    }

    @Test fun `the dialogs carry this process's token, and each screen compares it after the notebook and before the policy`() {
        val dialog = source("NotebookLeaveOrDeleteDialogFragment.kt")
        assertTrue("every dialog is made with this process's token", body(dialog, "internal fun show(", "        ")
            .contains("putString(ARG_PROCESS, ProcessIncarnation.current())"))
        assertTrue("it is read as given, null for a dialog with none",
            dialog.contains("val shownIn = args.getString(ARG_PROCESS)\n"))
        assertFalse("a dialog with none is not taken as this process's", dialog.contains("getString(ARG_PROCESS)!!"))
        val send = body(dialog, "fun send(answer: Answer) {", "        ")
        for (host in listOf("EditCollectionFragment", "CollectionMembersFragment")) {
            assertTrue(host, send.contains("is $host -> host.onNotebookAnswer(notebook, step, answer, shown, shownIn)"))
        }
        for ((name, again) in listOf(
                "EditCollectionFragment.kt" to "Next.CountAgain -> askBeforeNotebookDelete(identity)\n",
                "CollectionMembersFragment.kt" to
                    "Next.CountAgain -> askBeforeNotebookLeave(identity, leavesWhenNothing = false)\n")) {
            val screen = source(name)
            val answer = body(screen, "internal fun onNotebookAnswer(")
            assertTrue("$name takes the token with no default", answer.contains("        shownIn: String?,\n    ) {"))
            val at = listOf("if (identity != CollectionLifecycleIdentity.from(arguments)) return",
                "val fromThisProcess = ProcessIncarnation.isCurrent(shownIn)\n", "if (step == Step.AGAIN) {",
                "answerAgain(identity, answer, shown, fromThisProcess)",
                "when (val next = NotebookLeaveOrDeletePolicy.answered(answer, shown, fromThisProcess)) {")
                .map { answer.indexOf(it) }
            assertTrue("$name $at", at.first() >= 0 && at.zipWithNext().all { (a, b) -> a < b })
            assertTrue("$name counts again", answer.contains(again))
            // The one more question from another process is counted again too, and discards nothing.
            val once = body(code(name), "private fun askAgainOnceMore(identity: CollectionLifecycleIdentity) {")
            assertTrue(name, once.contains(
                "withContext(Dispatchers.IO) { NotebookLeaveOrDelete.count(applicationContext, identity) }"))
            assertTrue(name, once.contains(
                "if (now.anything && now.listed && showNotebookStep(identity, Step.AGAIN, now)) return@launch\n"))
            assertFalse(name, Regex("""NotebookLeaveOrDelete\.(discard|remove|again)\b""").containsMatchIn(once))
        }
        val policy = source("NotebookLeaveOrDeletePolicy.kt")
        val signature = "fun answered(answer: Answer, shown: UnsyncedNotes, fromThisProcess: Boolean): Next {"
        assertTrue("the policy takes it with no default", policy.contains(signature))
        val answered = body(policy, signature)
        assertTrue("and decides an answer from another process before any answer",
            answered.indexOf("if (!fromThisProcess) return Next.CountAgain") in
                0 until answered.indexOf("return when (answer) {"))
    }

    @Test fun `a dialog that has sent its answer does not hold back its own step`() {
        val dialog = code("NotebookLeaveOrDeleteDialogFragment.kt")
        assertTrue("only the dialog sets it", dialog.contains("internal var ended = false\n        private set"))
        assertTrue("an answer ends it before it is sent",
            body(dialog, "fun send(answer: Answer) {", "        ").startsWith("\n            ended = true\n"))
        assertEquals("and nothing else does", 1, dialog.split("ended = true").size - 1)
        val show = body(dialog, "internal fun show(", "        ")
        assertFalse("the old lookup", show.contains("findFragmentByTag(tag) != null"))
        val check = show.indexOf("if (open != null && !open.ended) return true")
        assertTrue("an ended dialog is passed over before a new one is made",
            check >= 0 && check < show.indexOf("NotebookLeaveOrDeleteDialogFragment().apply {"))
    }

    @Test fun `a failure after a confirmation never says nothing was deleted while a discard of the store has stopped`() {
        for ((name, confirmed) in listOf("EditCollectionFragment.kt" to DELETE_NOTEBOOK,
                "CollectionMembersFragment.kt" to LEAVE_NOTEBOOK)) {
            val run = body(code(name), confirmed)
            // Read on IO, as the server step starts.
            assertTrue(name, run.contains("server = {\n                            " +
                "stoppedBefore = NotebookLeaveOrDelete.stopped(applicationContext, identity)\n"))
            assertTrue(name, run.contains("var stoppedBefore = false"))
            assertEquals(name, 1, run.split("stoppedBefore = NotebookLeaveOrDelete.stopped(").size - 1)
        }
        val dialog = code("NotebookLeaveOrDeleteDialogFragment.kt")
        val line = body(dialog, "private fun line(context: Context, kept: Boolean, stopped: Boolean): String? = when {",
            "        ")
        val steps = listOf("!kept -> null", "stopped -> context.getString(R.string.notes_discard_not_finished)",
            "else -> context.getString(R.string.notes_notebook_failed_kept)").map { line.indexOf(it) }
        assertTrue("$steps", steps.first() >= 0 && steps.zipWithNext().all { (a, b) -> a < b })
        assertTrue(body(dialog, "internal fun failure(", "        ").contains("line(context, kept, stopped)"))
        assertTrue(stringText("notes_discard_not_finished").contains("may already be deleted"))
        // The glue asks the store's own state, and from memory the folders of stopped instances when it cannot open it.
        assertTrue(code("NotebookLeaveOrDelete.kt").contains(
            "fun stopped(context: Context, identity: CollectionLifecycleIdentity): Boolean = runCatching {\n" +
            "        store(context, identity).clearStopped()\n    }.getOrElse {\n" +
            "        PendingNotesStore.identityDir(context.noBackupFilesDir, identity.account.type, " +
            "identity.account.name,\n            identity.creationId).name in " +
            "PendingNotesStore.stoppedIn(context.noBackupFilesDir)\n    }\n"))
    }

    @Test fun `only the one more question cannot be canceled, and only it answers from its negative button`() {
        val dialog = code("NotebookLeaveOrDeleteDialogFragment.kt")
        assertEquals("Cancel on the count and the confirmation, with no listener", 2,
            dialog.split(".setNegativeButton(android.R.string.cancel, null)").size - 1)
        assertEquals("No on today's question, as before", 1,
            dialog.split(".setNegativeButton(android.R.string.no, null)").size - 1)
        assertEquals("and Keep", 4, dialog.split(".setNegativeButton(").size - 1)
        assertTrue(dialog.contains(".setNegativeButton(R.string.notes_notebook_keep) { _, _ -> send(Answer.KEEP) }"))
        assertFalse("nothing has started when a dialog is canceled", dialog.contains("onCancel"))
        assertEquals(1, dialog.split("isCancelable = false").size - 1)
        assertTrue(body(dialog, "Step.AGAIN -> {", "            ").contains("isCancelable = false"))
        // All of the answer, the names it was counted from included, is kept and read back.
        for (field in listOf("count", "sequence", "unreadable", "listed", "names")) {
            val arg = "ARG_" + field.uppercase()
            assertTrue("$field is kept", Regex("put\\w+\\($arg, [^\\n]*shown\\.$field\\b").containsMatchIn(dialog))
            assertTrue("$field is read back", Regex("args\\.get\\w+\\($arg\\)").containsMatchIn(dialog))
        }
        assertEquals("the notebook's name is not among the arguments", listOf("KIND", "STEP", "COUNT", "SEQUENCE",
            "UNREADABLE", "LISTED", "NAMES", "FAILURE", "KEPT", "STOPPED", "PROCESS"),
            Regex("private const val ARG_(\\w+) = ").findAll(dialog).map { it.groupValues[1] }.toList())
    }

    @Test fun `results are posted from any thread through the main looper and the application context`() {
        val glue = code("NotebookLeaveOrDelete.kt")
        val post = body(glue, "fun postResult(context: Context, text: CharSequence) {")
        assertTrue(post.contains("val application = context.applicationContext"))
        assertTrue(post.contains(
            "Handler(Looper.getMainLooper()).post { Toast.makeText(application, text, Toast.LENGTH_LONG).show() }"))
        for ((name, confirmed) in listOf("EditCollectionFragment.kt" to DELETE_NOTEBOOK,
                "CollectionMembersFragment.kt" to LEAVE_NOTEBOOK)) {
            val screen = code(name)
            for (block in listOf(confirmed, "private fun answerAgain(")) {
                assertFalse("$name $block", body(screen, block).contains("Toast.makeText"))
            }
            // Posted from inside the IO block, which runs to its end when the screen goes.
            val run = body(screen, confirmed)
            assertTrue(name, run.substringAfter("withContext(Dispatchers.IO) {", "").substringBefore("when (after) {")
                .contains("if (it is After.Say) NotebookLeaveOrDelete.postResult(applicationContext, it.text)"))
            val again = body(screen, "private fun answerAgain(")
            assertTrue(name, again.substringAfter("withContext(Dispatchers.IO) {", "").substringBefore("} finally {")
                .contains("if (after is After.Say) NotebookLeaveOrDelete.postResult(applicationContext, after.text)"))
            // A server call that failed after a confirmation of changes to discard says that nothing was deleted, or,
            // while a discard of the store has stopped, that some may already be deleted.
            assertTrue(name, run.substringAfter("} catch (e: EtebaseException) {", "")
                .contains("kept = shown.anything, stopped = stoppedBefore)"))
        }
        // A message shows two lines at most, so the fallback of a failure says first that nothing was deleted.
        val failed = body(code("NotebookLeaveOrDeleteDialogFragment.kt"), "internal fun failed(", "        ")
        val kept = failed.indexOf("listOfNotNull(line(context, kept, stopped),")
        assertTrue("$kept", kept >= 0 && kept < failed.indexOf("context.getString(R.string.exception)"))
        val sync = body(glue, "fun syncNotesNow(context: Context, identity: CollectionLifecycleIdentity): SyncAsked {")
        val validate = sync.indexOf("if (!identity.validate(context)) return SyncAsked.NOT_ASKED")
        assertTrue(validate >= 0 && validate < sync.indexOf("AccountSettings.notesEnabled("))
    }

    @Test fun `a store that could not be listed gets words that call nothing a discard and say nothing was deleted`() {
        val dialog = code("NotebookLeaveOrDeleteDialogFragment.kt")
        assertTrue(dialog.contains("val unlisted = text == Text.Unlisted\n"))
        // Its words in each step, and its labels chosen before any of a discard.
        assertTrue(dialog.contains("Text.Unlisted -> getString(R.string.notes_notebook_unsynced_unlisted)"))
        assertTrue(dialog.contains(
            "Text.Unlisted -> getString(if (delete) R.string.notes_notebook_acknowledge_delete\n" +
            "                        else R.string.notes_notebook_acknowledge_leave)"))
        assertTrue(dialog.contains("unlisted -> R.string.notes_continue_without_syncing\n"))
        assertTrue(dialog.contains("!unlisted -> R.string.notes_discard_title\n"))
        assertTrue(dialog.contains("unlisted -> R.string.notes_acknowledge_continue\n"))

        val messages = listOf("notes_notebook_unsynced_unlisted", "notes_notebook_acknowledge_delete",
            "notes_notebook_acknowledge_leave").map { stringText(it) }
        val labels = listOf("notes_notebook_maybe_unsynced_title", "notes_continue_without_syncing",
            "notes_notebook_acknowledge_title_delete", "notes_notebook_acknowledge_title_leave",
            "notes_acknowledge_continue").map { stringText(it) }
        for (text in messages + labels) {
            assertFalse("never called a discard: $text", text.contains("discard", ignoreCase = true))
            assertFalse("nothing is said to be removed: $text", text.contains("remove", ignoreCase = true))
            assertFalse(text, text.contains("cannot be undone") || text.contains("cannot be recovered"))
            val rest = listOf("deletes no unsynced Notes text", "no unsynced Notes text is deleted",
                "Delete the notebook", "the notebook is deleted")
                .fold(text) { left, allowed -> left.replace(allowed, "") }
            assertFalse("nothing is said to be deleted: $text", rest.contains("delet", ignoreCase = true))
        }
        for (text in messages) {
            assertTrue(text, text.contains("no unsynced Notes text") && text.contains("may remain on this device") &&
                text.contains("may no longer sync"))
        }
    }

    @Test fun `every notebook text that denies a deletion speaks of unsynced Notes text, first in each result`() {
        // After a delete that went through on the server, the attempt deleted the notebook with its synced notes. So a
        // text of this flow that denies a deletion names what its discard handles: unsynced Notes text.
        val denies = Regex("deleted no|deletes no|deletes nothing|nothing (is|was) deleted|\\bno\\b.* is deleted",
            RegexOption.IGNORE_CASE)
        val strings = Regex("<string name=\"(notes_notebook_\\w+)\">(.*?)</string>").findAll(resources("strings.xml"))
            .map { it.groupValues[1] to it.groupValues[2] }.toList()
        val plurals = Regex("<plurals name=\"(notes_notebook_\\w+)\">").findAll(resources("plurals.xml"))
            .flatMap { plural ->
                val name = plural.groupValues[1]
                pluralTexts(name).mapIndexed { i, text -> "$name[$i]" to text }
            }.toList()
        val unscoped = sortedMapOf<String, String>()
        for ((name, text) in strings + plurals) {
            for (sentence in text.split(Regex("(?<=[.?!])\\s+"))) {
                if (denies.containsMatchIn(sentence) && !sentence.contains("unsynced Notes text")) {
                    unscoped[name] = sentence
                }
            }
        }
        assertEquals(emptyMap<String, String>(), unscoped)
        // Each result says first what came of this attempt, in the maintainer's sign-out words: "This attempt" stays
        // true after a restart, when an earlier attempt may have deleted some.
        val results = listOf("notes_notebook_kept_unreadable", "notes_notebook_kept_changed",
            "notes_notebook_nothing_deleted", "notes_notebook_failed_kept")
        assertTrue(strings.map { it.first }.containsAll(results))
        val first = "This attempt deleted no unsynced Notes text"
        assertEquals(results.associateWith { first }, results.associateWith { stringText(it).take(first.length) })
    }

    @Test fun `every text that deletes changes not all counted says that those that can't be read stay`() {
        val uncounted = listOf("notes_notebook_unsynced_uncounted", "notes_notebook_discard_uncounted_delete",
            "notes_notebook_discard_uncounted_leave", "notes_notebook_again_uncounted_delete",
            "notes_notebook_again_uncounted_leave", "notes_notebook_discarded_readable").map { stringText(it) }
        for (text in uncounted) {
            assertTrue(text, text.contains("that can’t be read stay", ignoreCase = true))
        }
        // A count is shown only as a number of changes, never as 0, and each counted text has one for each quantity.
        for (name in listOf("notes_notebook_unsynced_delete", "notes_notebook_unsynced_leave",
                "notes_notebook_discard_delete", "notes_notebook_discard_leave", "notes_notebook_again_delete",
                "notes_notebook_again_leave")) {
            val items = pluralTexts(name)
            assertEquals(name, 2, items.size)
            for (item in items) assertTrue(item, item.contains("%d") && !item.contains(" 0 "))
        }
        val dialog = code("NotebookLeaveOrDeleteDialogFragment.kt")
        assertEquals("the count is formatted only for a counted answer", 3,
            dialog.split("text.count, text.count)").size - 1)
        assertEquals(3, dialog.split("is Text.Counted -> resources.getQuantityString(").size - 1)
    }
}
