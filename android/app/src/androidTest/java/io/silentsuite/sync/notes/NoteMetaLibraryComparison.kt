package io.silentsuite.sync.notes

import android.util.Log
import io.silentsuite.sync.notes.edit.NoteMetaCodec
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Merge
import io.silentsuite.sync.notes.edit.NoteMetaLibraryEvaluation

/**
 * Evaluation only. Runs the fixed inputs of [NoteMetaBindingComparison] through [NoteMetaCodec] and
 * through the form of the same merge that is written on msgpack-core, in the app as it is built for
 * this test: the minified debug build. The form is reached the one way main code offers,
 * [NoteMetaLibraryEvaluation]. This file names no class of the library, so the test APK gives the
 * debug build no keep rule for the library that a release build would not have.
 *
 * What it can show: that the library loads and runs in this build on this device, which buffer
 * class it chose, and that on these inputs the form gives what the codec gives. What it cannot
 * show: a release build, which is installed nowhere; a phone; input outside the table; and the
 * rules above the format layer, which the form shares with the codec.
 */
internal object NoteMetaLibraryComparison {
    private const val TAG = "NoteMetaCompare"

    class Report(
        val bufferClass: String,
        val merged: Int,
        val refused: Int,
        val notAMap: Int,
        val peeks: Int,
        val outputPeeks: Int,
        val freshes: Int,
        /** For each input both sides refuse as not a map: the codec's reason and the form's. */
        val reasons: Map<String, Pair<String, String>>,
        val differences: List<String>,
    )

    private fun show(m: Merge): String = when (m) {
        is Merge.Merged -> "Merged, ${m.bytes.size} bytes"
        is Merge.Refused -> "Refused(${m.key}, ${m.why})"
        is Merge.NotAMap -> "NotAMap(${m.reason})"
    }

    fun run(): Report {
        val differences = ArrayList<String>()
        fun say(what: String) {
            differences += what.take(300)
        }
        val reasons = LinkedHashMap<String, Pair<String, String>>()
        var merged = 0
        var refused = 0
        var notAMap = 0
        var peeks = 0
        var outputPeeks = 0
        val merges = NoteMetaBindingComparison.fixedMerges()
        for (case in merges) {
            val mine = NoteMetaCodec.merge(case.raw, case.name, case.mtime)
            val theirs = NoteMetaLibraryEvaluation.merge(case.raw, case.name, case.mtime)
            when (mine) {
                is Merge.Merged -> {
                    merged++
                    if (theirs !is Merge.Merged) {
                        say("merge ${case.id}: the codec merges and the form gives ${show(theirs)}")
                    } else {
                        if (!mine.bytes.contentEquals(theirs.bytes)) {
                            say("merge ${case.id}: the outputs are not the same bytes (${mine.bytes.size} and ${theirs.bytes.size} bytes)")
                        }
                        if (mine.name != theirs.name) say("merge ${case.id}: the two sides report different names")
                        outputPeeks++
                        val out = NoteMetaCodec.peek(mine.bytes)
                        val theirOut = NoteMetaLibraryEvaluation.peek(mine.bytes)
                        if (out != theirOut) say("merge ${case.id}: the codec reads the merged output as $out and the form as $theirOut")
                    }
                }
                is Merge.Refused -> {
                    refused++
                    if (mine != theirs) say("merge ${case.id}: the codec gives ${show(mine)} and the form gives ${show(theirs)}")
                }
                is Merge.NotAMap -> {
                    notAMap++
                    if (theirs is Merge.NotAMap) {
                        reasons[case.id] = mine.reason to theirs.reason
                    } else {
                        say("merge ${case.id}: the codec gives ${show(mine)} and the form gives ${show(theirs)}")
                    }
                }
            }
            peeks++
            val read = NoteMetaCodec.peek(case.raw)
            val theirRead = NoteMetaLibraryEvaluation.peek(case.raw)
            if (read != theirRead) say("peek ${case.id}: the codec reads $read and the form reads $theirRead")
        }
        var freshes = 0
        for ((name, mtime) in NoteMetaBindingComparison.fixedFreshPairs()) {
            freshes++
            val mine = NoteMetaCodec.fresh(name, mtime)
            val theirs = NoteMetaLibraryEvaluation.fresh(name, mtime)
            if (!mine.bytes.contentEquals(theirs.bytes) || mine.name != theirs.name) {
                say("fresh of ${name.length} chars at $mtime: the two sides differ")
            }
        }
        val bufferClass = NoteMetaLibraryEvaluation.bufferClassName()
        Log.i(TAG, "library form: buffer class $bufferClass; java.runtime.name=${System.getProperty("java.runtime.name")}; " +
            "msgpack.universal-buffer=${System.getProperty("msgpack.universal-buffer")}")
        Log.i(TAG, "library form: ${merges.size} merges (codec: Merged $merged, Refused $refused, NotAMap $notAMap), $peeks reads of an input, " +
            "$outputPeeks reads of a merged output, $freshes fresh pairs, ${differences.size} differences; reasons $reasons")
        return Report(bufferClass, merged, refused, notAMap, peeks, outputPeeks, freshes, reasons, differences)
    }
}
