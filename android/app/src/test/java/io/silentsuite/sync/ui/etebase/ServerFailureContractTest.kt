package io.silentsuite.sync.ui.etebase

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Text checks that the server calls of Manage members, Invitations and Revisions catch a failure (offline or a server
 * error) instead of letting it reach the default handler and crash the app, and that the screen then says so.
 * Cancellation still propagates. The calls need a live Etebase server, so this is checked on the source.
 */
class ServerFailureContractTest {
    private val etebase = File("src/main/java/io/silentsuite/sync/ui/etebase")

    private fun code(name: String) = File(etebase, name).readText().replace("\r\n", "\n")
        .replace(Regex("(?s)/\\*.*?\\*/"), "").replace(Regex("//[^\n]*"), "")

    /** What follows [start] in [text], up to the first closing brace at [indent]: one function or block. */
    private fun body(text: String, start: String, indent: String = "    "): String {
        assertTrue("found: $start", text.contains(start))
        return text.substringAfter(start).substringBefore("\n$indent}\n")
    }

    private fun strings() = File("src/main/res/values/strings.xml").readText()

    /**
     * The failure of [model]'s latest load in [source] shows: the flag is cleared when a load starts, so an earlier
     * failure is not replayed after a later success, and with rows from an earlier load on screen (which hide the
     * empty text) the error is said in a toast as well.
     */
    private fun assertLatestLoadFailureShows(source: String, load: String, model: String, error: String) {
        assertTrue("$model clears the failure when a load starts",
            load.indexOf("loadFailed.value = false") in 0 until load.indexOf("viewModelScope.launch {"))
        val shown = body(source, "        $model.observeLoadFailed(viewLifecycleOwner) { failed ->", "        ")
        assertTrue(shown.contains("if (!failed) return@observeLoadFailed"))
        assertTrue(shown.contains("emptyTextView?.setText(R.string.$error)"))
        assertTrue("with earlier rows on screen the error is a toast too",
            shown.contains("if ((listAdapter?.count ?: 0) > 0)") &&
                shown.contains("Toast.makeText(requireContext(), R.string.$error, Toast.LENGTH_LONG).show()"))
    }

    /** [block] catches every failure of its server call and rethrows cancellation. */
    private fun assertCatches(what: String, block: String) {
        assertTrue("$what catches a failed server call", block.contains("} catch (e: Exception) {"))
        assertTrue("$what rethrows cancellation", block.contains("if (e is CancellationException) throw e"))
        assertFalse("$what does not log the server's message", block.contains("Logger.log.warning(\"\$e") ||
            block.contains("e.message") || block.contains("e.localizedMessage"))
    }

    @Test fun `loading and removing members catch a failed server call and the screen says so`() {
        val source = code("CollectionMembersListFragment.kt")
        val load = body(source, "    fun loadMembers(")
        assertCatches("loadMembers", load)
        assertTrue(load.contains("loadFailed.value = true"))
        val remove = body(source, "    fun removeMember(")
        assertCatches("removeMember", remove)
        assertTrue(remove.contains("onFailure()"))

        val view = body(source, "    override fun onViewCreated(")
        assertTrue(view.contains("membersModel.observeLoadFailed(viewLifecycleOwner)"))
        assertTrue(view.contains("R.string.collection_members_list_load_error"))
        assertTrue(source.contains("R.string.collection_members_remove_error"))
        assertTrue(strings().contains("name=\"collection_members_list_load_error\""))
        assertLatestLoadFailureShows(source, load, "membersModel", "collection_members_list_load_error")
    }

    @Test fun `leaving a collection of another type than Notes catches a failed server call and keeps the screen`() {
        val source = code("CollectionMembersFragment.kt")
        val leave = body(source, "v.findViewById<Button>(R.id.leave).setOnClickListener {", "            ")
        val other = leave.substringAfter("return@setOnClickListener\n                }\n")
        assertCatches("leave", other)
        val caught = other.substringAfter("} catch (e: Exception) {").substringBefore("} finally {")
        assertTrue(caught.contains("R.string.collection_members_leave_error"))
        assertFalse("a failed leave keeps the screen", caught.contains("finish()"))
        assertTrue(strings().contains("name=\"collection_members_leave_error\""))
    }

    @Test fun `loading and rejecting invitations catch a failed server call and the screen says so`() {
        val source = code("InvitationsListFragment.kt")
        val load = body(source, "    fun loadInvitations(")
        assertCatches("loadInvitations", load)
        assertTrue(load.contains("loadFailed.value = true"))
        val reject = body(source, "    fun reject(")
        assertCatches("reject", reject)
        assertTrue(reject.contains("onFailure()"))

        val view = body(source, "    override fun onViewCreated(")
        assertTrue(view.contains("invitationsModel.observeLoadFailed(viewLifecycleOwner)"))
        assertTrue(view.contains("R.string.invitations_load_error"))
        assertTrue(source.contains("R.string.invitations_reject_error"))
        assertTrue(strings().contains("name=\"invitations_load_error\""))
        assertLatestLoadFailureShows(source, load, "invitationsModel", "invitations_load_error")
        assertTrue(strings().contains("name=\"invitations_reject_error\""))
    }

    @Test fun `loading revisions catches a failed server call and the screen says so`() {
        val source = code("ItemRevisionsListFragment.kt")
        val load = body(source, "    fun loadRevisions(")
        assertCatches("loadRevisions", load)
        assertTrue(load.contains("loadFailed.value = true"))

        val view = body(source, "    override fun onViewCreated(")
        assertTrue(view.contains("revisionsModel.observeLoadFailed(viewLifecycleOwner)"))
        assertTrue(view.contains("R.string.journal_revisions_load_error"))
        assertTrue(strings().contains("name=\"journal_revisions_load_error\""))
        assertLatestLoadFailureShows(source, load, "revisionsModel", "journal_revisions_load_error")
    }
}
