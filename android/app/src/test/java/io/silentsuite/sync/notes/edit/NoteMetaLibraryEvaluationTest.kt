package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.NoteMetaCodec.Merge
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Evaluation only. What holds the msgpack-core evaluation to its limits: which files of main code
 * and the debug source set may name the library and the form written on it, that device tests reach
 * the form only through its one caller, which rule keeps both in the minified builds, and that the
 * caller runs the library form and not the codec. The first three are checks of text and say so.
 * A fifth test, also a check of text, holds the inputs of the device measurement to the five huge
 * maps of comparison test 7.
 */
class NoteMetaLibraryEvaluationTest {
    private val form = "NoteMetaMsgpack.kt"
    private val caller = "NoteMetaLibraryEvaluation.kt"

    private fun sources(root: String): List<File> =
        File(root).walkTopDown().filter { it.isFile && it.extension in setOf("kt", "java", "xml") }.toList()

    private fun naming(root: String, text: String): List<String> =
        sources(root).filter { it.readText().contains(text) }.map { it.name }.sorted()

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test fun `in main code only the form and its one caller name msgpack-core, and no other file names either of them`() {
        assertTrue("main code is read from the directory of the app module", sources("src/main").size > 100)
        assertEquals("the files of main code that name a class of msgpack-core", listOf(caller, form), naming("src/main", "org.msgpack"))
        assertEquals("the files of main code that name the form", listOf(caller, form), naming("src/main", "NoteMetaMsgpack"))
        assertEquals("the files of main code that name the caller", listOf(caller, form), naming("src/main", "NoteMetaLibraryEvaluation"))
        // The debug build has a source set of its own, and its code is app code in the APK that the device
        // tests run on. No file there may name any of the three, and a new source set fails here.
        assertEquals("the source sets of the app module", listOf("androidTest", "debug", "main", "test"),
            File("src").listFiles()!!.filter { it.isDirectory }.map { it.name }.sorted())
        assertTrue("the debug source set is read from the directory of the app module", sources("src/debug").isNotEmpty())
        for (text in listOf("org.msgpack", "NoteMetaMsgpack", "NoteMetaLibraryEvaluation")) {
            assertEquals("the files of the debug source set that name $text", emptyList<String>(), naming("src/debug", text))
        }
        val text = File("src/main/java/io/silentsuite/sync/notes/edit/$caller").readText()
        assertEquals("the caller names msgpack-core once, in its import of MessageBuffer", 1, text.split("org.msgpack").size - 1)
        assertTrue(text.contains("import org.msgpack.core.buffer.MessageBuffer"))
        assertEquals("the caller makes the one form of main code", 1, text.split("NoteMetaMsgpack()").size - 1)
        for (call in listOf("form.merge(raw, name, mtime)", "form.fresh(name, mtime)", "form.peek(raw)")) {
            assertEquals("once in the caller: $call", 1, text.split(call).size - 1)
        }
        for (call in listOf("NoteMetaCodec.merge(", "NoteMetaCodec.fresh(", "NoteMetaCodec.peek(")) {
            assertEquals("the caller never calls the codec: $call", 0, text.split(call).size - 1)
        }
    }

    @Test fun `no device test names msgpack-core or the form, so the test APK gives the debug build no keep rule for the library`() {
        assertTrue("device tests are read from the directory of the app module", sources("src/androidTest").size > 10)
        assertEquals(emptyList<String>(), naming("src/androidTest", "org.msgpack"))
        assertEquals(emptyList<String>(), naming("src/androidTest", "NoteMetaMsgpack"))
    }

    @Test fun `the rule that keeps the app's package keeps the form and its caller, in the rules both build types share`() {
        // The modifier includedescriptorclasses of this rule also keeps, as classes, the five library
        // classes named in the signatures of the form's compiled members. Everything else of the library
        // is there only if R8 finds it reachable or a rule of its own keeps it.
        val rules = File("proguard-rules.txt").readText()
        assertEquals("the line that keeps the app's package", 1, rules.split("-keep,includedescriptorclasses class io.silentsuite.sync.** { *; }").size - 1)
        val build = File("build.gradle").readText()
        assertEquals("debug and release both shrink with proguard-rules.txt", 2,
            build.split("proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.txt'").size - 1)
        assertEquals("debug and release both have minification on", 2, build.split("minifyEnabled true").size - 1)
        assertEquals("no build type switches it off", 0, build.split("minifyEnabled false").size - 1)
        assertFalse("the rules only debug has say nothing about the library", File("proguard-debug-test-rules.pro").readText().contains("org.msgpack"))
        assertEquals("the library is declared once", 1, build.split("org.msgpack:msgpack-core").size - 1)
        assertTrue("and as a dependency of the app itself", build.contains("    implementation 'org.msgpack:msgpack-core:0.9.12'"))
    }

    @Test fun `the caller runs the library form and not the codec, and the form answers as the codec does`() {
        // The two-entry note of the web's encoder, as NoteMetaCodecTest and the device table have it.
        val note = unhex("82a46e616d65a947726f636572696573a56d74696d65cf0000019980a63400")
        val mine = NoteMetaCodec.merge(note, "New", 5) as Merge.Merged
        val theirs = NoteMetaLibraryEvaluation.merge(note, "New", 5) as Merge.Merged
        assertArrayEquals(mine.bytes, theirs.bytes)
        assertEquals(mine.name, theirs.name)
        assertEquals(NoteMetaCodec.peek(note), NoteMetaLibraryEvaluation.peek(note))
        assertArrayEquals(NoteMetaCodec.fresh("n", 1).bytes, NoteMetaLibraryEvaluation.fresh("n", 1).bytes)
        // The same note with one more entry after the last replaced value (webNoteExtra in NoteMetaCodecTest,
        // WEB_NOTE_EXTRA in the device table): both sides have to copy what follows the two values they replace.
        val extra = unhex("83a46e616d65a947726f636572696573a56d74696d65cf0000019980a63400a56578747261a76b6565702d6d65")
        val mineExtra = NoteMetaCodec.merge(extra, "New", 5) as Merge.Merged
        val theirsExtra = NoteMetaLibraryEvaluation.merge(extra, "New", 5) as Merge.Merged
        assertArrayEquals(mineExtra.bytes, theirsExtra.bytes)
        // What tells the two apart: the row cutAtAValueBoundary of the device table, a map of two that
        // ends after its first entry. The codec refuses in its own words. The form passes on the name of
        // the exception msgpack-core throws when a read runs out of input.
        val cut = unhex("82a46e616d65a141")
        assertEquals(Merge.NotAMap("a length runs past the end of the input"), NoteMetaCodec.merge(cut, "New", 5))
        assertEquals(Merge.NotAMap("MessageInsufficientBufferException"), NoteMetaLibraryEvaluation.merge(cut, "New", 5))
        assertNull(NoteMetaLibraryEvaluation.peek(cut))
        // Unit tests run with msgpack.universal-buffer=true (build.gradle), so here the class follows from
        // that setting. On a device nothing sets it; what the library chooses there is for a device run to show.
        assertEquals("org.msgpack.core.buffer.MessageBufferU", NoteMetaLibraryEvaluation.bufferClassName())
    }

    @Test fun `the device measurement builds the five huge maps of comparison test 7 and no other`() {
        val call = Regex("hugeMap\\(\"([0-9a-f]+)\", \"([0-9a-f]+)\", ([0-9_]+)\\)")
        fun calls(path: String) = call.findAll(File(path).readText()).map { it.groupValues.drop(1) }.toList()
        val unit = calls("src/test/java/io/silentsuite/sync/notes/edit/NoteMetaCodecComparisonTest.kt")
        val device = calls("src/androidTest/java/io/silentsuite/sync/notes/NoteMetaAllocationOnDeviceTest.kt")
        assertEquals("comparison test 7 has five huge maps", 5, unit.size)
        assertEquals("the device measurement builds the same five, in the same order", unit, device)
    }
}
