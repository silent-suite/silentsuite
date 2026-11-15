package io.silentsuite.sync.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The note editor's source rules that its behavior tests cannot see. These read source text, so code can reach the same
 * thing another way and pass; they pin what the editor does today, and review covers the rest.
 */
class NoteEditorContractTest {
    private fun read(path: String) = File(path).readText().replace("\r\n", "\n")
    private fun code(text: String) = text.replace(Regex("(?s)/\\*.*?\\*/"), "").replace(Regex("//[^\n]*"), "")

    private val model = read("src/main/java/io/silentsuite/sync/ui/notes/NoteEditorViewModel.kt")
    private val modelCode = code(model)
    private val screen = read("src/main/java/io/silentsuite/sync/ui/notes/NoteViewFragment.kt")
    private val editing = read("src/main/java/io/silentsuite/sync/ui/notes/NoteEditing.kt")

    /** The body of the private function [name] in the ViewModel. */
    private fun function(name: String): String = model.substringAfter("    private fun $name(").substringBefore("\n    }\n")

    @Test fun `every store call of the editor runs on the IO dispatcher`() {
        // The functions that call the store, and the only places they are called from.
        val storeCalls = listOf("store.read(", "store.landed(", "store.notebook(", "store.saveLocal(", "store.editorOpened(",
            "store.editorClosed(", "store.observe(", "PendingNotesStore.forIdentity(")
        for (call in storeCalls) assertTrue("$call is made", modelCode.contains(call))
        val ioEntries = mapOf(
            "openNote(uid)" to 2,
            "if (uid == null) openNewNote() else openNote(uid)" to 1,
            "saveOnIo(draft) to session.handle?.noteUid" to 1,
            "closeHandle(store, handle)" to 2,
        )
        for ((call, times) in ioEntries) {
            assertEquals("$call on IO", times, modelCode.split("withContext(Dispatchers.IO) { $call }").size - 1)
        }
        assertEquals("openNote is called only there", 3, Regex("\\bopenNote\\(uid\\)").findAll(modelCode).count())
        assertEquals("saveOnIo is called only there", 1, Regex("\\bsaveOnIo\\(draft\\)").findAll(modelCode).count())
        assertEquals("closeHandle is called only there", 2, Regex("\\bcloseHandle\\(store, handle\\)").findAll(modelCode).count())
        // The status line's read, and the sync request, each inside a block on the IO dispatcher.
        val status = model.substringAfter("    private suspend fun refreshStatusStep() {").substringBefore("\n    }\n")
        assertTrue(status.indexOf("withContext(Dispatchers.IO) {") in 0 until status.indexOf("store.observe(handle.noteUid)"))
        val request = function("requestSync")
        assertTrue(request.indexOf("withContext(Dispatchers.IO) {") in 0 until request.indexOf("NotesSyncCoordinator.request("))
        // The helpers that call the store are reached only from those functions.
        assertEquals(1, Regex("\\bpin\\(store, uid, note\\)").findAll(modelCode).count())
        assertTrue(function("openNote").contains("pin(store, uid, note)"))
        assertEquals(1, Regex("\\battempt\\(draft\\)").findAll(modelCode).count())
        assertTrue(function("saveOnIo").contains("SaveRun.run { attempt(draft) }"))
        assertTrue(function("saveOnIo").contains("startNewNote()"))
        // The steps run in the app's scope, not the ViewModel's, so closing the screen does not stop a save.
        assertTrue(model.contains("private val background = CoroutineScope(SupervisorJob() + Dispatchers.Default)"))
        assertFalse("no store call in viewModelScope", modelCode.substringAfter("viewModelScope.launch {").substringBefore("\n        }").contains("store"))
    }

    @Test fun `the save request is automatic and made in the same step as the save, only after the text was written`() {
        assertEquals("one request", 1, Regex(Regex.escape(".request(")).findAll(modelCode).count())
        assertTrue(function("requestSync").contains("NotesSyncCoordinator.request(app, account, creationId, NotesSyncPolicy.Trigger.SAVE)"))
        val step = model.substringAfter("    private suspend fun saveStep() {").substringBefore("\n    }\n")
        val save = step.indexOf("saveOnIo(draft)")
        val written = step.indexOf("if (result is SaveResult.Saved || result is SaveResult.SavedToHolding) {")
        val request = step.indexOf("requestSync(SYNC_DELAY_MILLIS)")
        assertTrue("in the save step, after the save, once it wrote the text", save in 0 until written && written < request)
        val close = model.substringAfter("    override fun onCleared() {").substringBefore("\n    }\n")
        assertTrue("a closing editor saves, then asks at once", close.indexOf("saveStep()") in 0 until close.indexOf("requestSync(0)"))
        assertTrue(close.contains("background.launch {"))
    }

    @Test fun `the editor writes metadata only through the codec, never a typed setMeta`() {
        for ((name, text) in listOf("NoteEditorViewModel" to modelCode, "NoteEditing" to code(editing))) {
            assertFalse("$name: no typed setMeta", Regex("\\.setMeta\\s*\\(").containsMatchIn(text))
        }
        assertTrue(modelCode.contains("NoteEditing.metadataToWrite(before, name, mtime)"))
        assertTrue(modelCode.contains("item.setMetaRaw(merged.bytes)"))
        assertTrue(modelCode.contains("item.setMetaRaw(NoteMetaCodec.fresh(NoteEditing.UNTITLED, System.currentTimeMillis()).bytes)"))
        assertTrue(code(editing).contains("when (val merge = NoteMetaCodec.merge(raw, name, mtime)) {"))
    }

    @Test fun `no version or sequence goes into saved state, and the fields keep no text there`() {
        for ((name, text) in listOf("NoteEditorViewModel" to code(model), "NoteViewFragment" to code(screen))) {
            for (banned in listOf("SavedStateHandle", "onSaveInstanceState", "putLong(", "putInt(", "putSerializable(", "putParcelable(\"")) {
                assertFalse("$name: no $banned", text.contains(banned))
            }
        }
        // The arguments carry the account, the generation, the notebook and the note uid: strings, never a version.
        val args = screen.substringAfter("        fun newInstance(").substringBefore("\n        }\n")
        assertEquals(listOf("ARG_ACCOUNT", "ARG_CREATION_ID", "ARG_NOTEBOOK_UID", "ARG_NOTE_UID"),
            Regex("put\\w+\\((ARG_\\w+)").findAll(args).map { it.groupValues[1] }.toList())
        val layout = read("src/main/res/layout/fragment_note_view.xml")
        for (field in listOf("note_title_edit", "note_body_edit")) {
            val tag = layout.substringAfter("android:id=\"@+id/$field\"").substringBefore("/>")
            assertTrue("$field keeps no text in saved state", tag.contains("android:saveEnabled=\"false\""))
            assertTrue("$field asks the keyboard not to learn", tag.contains("flagNoPersonalizedLearning"))
            assertTrue("$field asks for no suggestions", tag.contains("textNoSuggestions"))
        }
    }

    @Test fun `the editor's own Cut and Copy mark the clip sensitive`() {
        val layout = read("src/main/res/layout/fragment_note_view.xml")
        assertEquals("both fields", 2, layout.split("<io.silentsuite.sync.ui.notes.SensitiveEditText").size - 1)
        assertFalse("no plain field", layout.contains("<EditText"))
        val field = code(read("src/main/java/io/silentsuite/sync/ui/notes/SensitiveEditText.kt"))
        assertTrue(field.contains("if (id != android.R.id.copy && id != android.R.id.cut) return super.onTextContextMenuItem(id)"))
        assertTrue(field.contains("SensitiveClip.copy(context,"))
        assertFalse(field.contains("setPrimaryClip"))
        assertFalse(code(screen).contains("setPrimaryClip"))
    }

    @Test fun `Undo, Redo, New note and the fields have labels`() {
        val menu = read("src/main/res/menu/note_editor_actions.xml")
        assertTrue(menu.contains("android:id=\"@+id/note_undo\"\n          android:title=\"@string/notes_editor_undo\""))
        assertTrue(menu.contains("android:id=\"@+id/note_redo\"\n          android:title=\"@string/notes_editor_redo\""))
        val list = read("src/main/res/layout/fragment_note_list.xml")
        assertTrue(list.substringAfter("android:id=\"@+id/notes_new_note\"").substringBefore("/>").contains("android:text=\"@string/notes_new_note\""))
        val layout = read("src/main/res/layout/fragment_note_view.xml")
        assertTrue(layout.substringAfter("android:id=\"@+id/note_title_edit\"").substringBefore("/>").contains("android:hint=\"@string/notes_editor_title_hint\""))
        assertTrue(layout.substringAfter("android:id=\"@+id/note_body_edit\"").substringBefore("/>").contains("android:hint=\"@string/notes_editor_body_hint\""))
        assertTrue("the status line is a polite live region",
            layout.substringAfter("android:id=\"@+id/note_status\"").substringBefore("/>").contains("android:accessibilityLiveRegion=\"polite\""))
    }

    @Test fun `every automatic sync settings text names saving a note`() {
        val strings = read("src/main/res/values/strings.xml")
        for (name in listOf("settings_notes_enabled_summary", "settings_notes_automatic_network_wifi", "settings_notes_automatic_network_any")) {
            val text = strings.substringAfter("<string name=\"$name\">").substringBefore("</string>")
            assertTrue("$name names a save: $text", text.contains("save a note"))
        }
        assertFalse("the read-only hint is gone with its uses", strings.contains("notes_read_only_hint"))
    }

    @Test fun `Back and Up ask the editor first, a leave saves first, and an answer is checked before anything is done`() {
        val activity = code(read("src/main/java/io/silentsuite/sync/ui/notes/NotesActivity.kt"))
        val up = activity.substringAfter("    private fun up() {").substringBefore("\n    }\n")
        assertTrue("the editor is asked before Up pops", up.indexOf("editor?.guardLeave() == true") in 0 until up.indexOf("popBackStackImmediate()"))
        assertEquals("onSupportNavigateUp and the toolbar's Up arrow both go there", 3, Regex("\\bup\\(\\)").findAll(activity).count())
        assertTrue(code(screen).contains("requireActivity().onBackPressedDispatcher.addCallback(viewLifecycleOwner, back)"))
        val back = screen.substringAfter("    private val back = object : OnBackPressedCallback(false) {").substringBefore("\n    }\n")
        assertTrue("Back asks the editor first", back.indexOf("if (guardLeave()) return") in 0 until back.indexOf("onBackPressed()"))
        val leave = model.substringAfter("    fun requestLeave() {").substringBefore("\n    }\n")
        assertTrue("in a step of the app's", leave.contains("background.launch {"))
        assertTrue("the save runs first, as a step", leave.indexOf("steps.withLock {") in 0 until leave.indexOf("saveStep()"))
        assertTrue(leave.indexOf("saveStep()") < leave.indexOf("NoteEditing.leave("))
        assertTrue(code(screen).contains("putString(ARG_PROCESS, ProcessIncarnation.current())"))
        val answered = screen.substringAfter("    internal fun leaveAnswered(").substringBefore("\n    }\n")
        val check = answered.indexOf("if (model.leavePromptAnswered(shownIn, shownNote) == null) {")
        assertTrue("an answer is checked", check > 0)
        for (act in listOf("copy()", "model.leaveWithoutSaving()")) assertTrue("$act only after the check", answered.indexOf(act) > check)
    }

    @Test fun `the editor makes no release, discard, hold or send`() {
        for (banned in listOf(".release(", ".discard(", "discardStore", "discardOrphan", "discardNotebook", "clearAll", ".hold(",
            ".rebase(", "beginSend", "startSend", "completeSend", "replaceWithNewNote", "Trigger.MANUAL")) {
            assertFalse("no $banned", modelCode.contains(banned) || code(screen).contains(banned))
        }
    }
}
