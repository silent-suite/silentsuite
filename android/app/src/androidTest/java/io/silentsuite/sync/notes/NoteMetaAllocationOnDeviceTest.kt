package io.silentsuite.sync.notes

import android.os.Build
import android.os.Debug
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.silentsuite.sync.notes.edit.NoteMetaCodec
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Merge
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Peek
import io.silentsuite.sync.notes.edit.NoteMetaLibraryEvaluation
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.MessageDigest

/**
 * Evaluation only, and a measurement, not a regression test. It is not in the runtime ledger and no
 * workflow or script names it, so by those files no lane of CI runs it. Run it by its class name on
 * a test emulator and read its lines under the log tag NoteMetaCompare.
 *
 * What it measures: the bytes allocated by one merge and by one peek of its output, for the codec
 * and for the form on msgpack-core, on the five huge maps of test 7 of NoteMetaCodecComparisonTest.
 * For the two-entry note of the device table it measures peeks only: the mean of 1000 peeks of the
 * note itself. No other input. The counter is the platform's own count for the calling thread
 * (android.os.Debug, deprecated), and from API 23 on also the runtime's count for the whole process,
 * which its documentation calls approximate. A control allocation shows first whether either counts
 * on this device.
 *
 * What the figures are: cumulative counts for single calls, in the debuggable debug build, on an
 * emulator. They are not peak heap, not a release build, not a phone and not a benchmark. The times
 * are of single calls, each a separate call made before the counted one, outside the pair of calls
 * that start and stop allocation counting.
 *
 * What it prints next to the figures: for both sides and each input, the word "within" or "over"
 * for the two bounds of the codec's own memory test, merge under 3 times the input size and peek
 * under 64 KiB. They are read from this thread's counter where the control shows that it counts,
 * else from the process's, and the line says which.
 *
 * What it asserts: that a counter counts, and that both sides give the same output on every input.
 * It asserts no bound. Which bounds a form on the library has to meet is not decided.
 */
@RunWith(AndroidJUnit4::class)
class NoteMetaAllocationOnDeviceTest {
    /** Bytes counted for one call: on the calling thread, and in the whole process where the runtime gives that. */
    private class Count(val thread: Int, val process: Long?)

    private class Figures(val merge: Count, val peek: Count, val mergeMillis: Long, val peekMillis: Long, val size: Int, val digest: ByteArray)

    @Test fun whatTheCodecAndTheFormOnMsgpackCoreAllocateOnThisDeviceForTheHugeMapsOfTheUnitComparison() {
        // The five inputs of test 7 of NoteMetaCodecComparisonTest, in its order. A unit test holds this list to that one.
        val inputs: List<() -> ByteArray> = listOf(
            { hugeMap("df001e8480", "a000", 2_000_000) },
            { hugeMap("df001e8480", "a0d40700", 2_000_000) },
            { hugeMap("df001e8480", "0000", 2_000_000) },
            { hugeMap("df00030d40", "cfffffffffffffffff00", 200_000) },
            { hugeMap("df000f4240", "a0cf0000019980a63400", 1_000_000) },
        )
        say("API ${Build.VERSION.SDK_INT}, heap limit ${Runtime.getRuntime().maxMemory()} bytes, buffer class ${NoteMetaLibraryEvaluation.bufferClassName()}")
        val note = NoteMetaBindingComparison.fixedMerges().first { it.id == "webNote" }.raw
        // A warm-up on the two-entry note, to keep class loading and first use out of the counted calls.
        // Each counted call also follows a timed call of the same kind on the same input.
        repeat(300) {
            NoteMetaCodec.merge(note, "warm", 1)
            NoteMetaCodec.peek(note)
            NoteMetaLibraryEvaluation.merge(note, "warm", 1)
            NoteMetaLibraryEvaluation.peek(note)
        }
        // Without a counter that counts, every figure below would mean nothing.
        val (array, control) = counted { ByteArray(CONTROL_BYTES) }
        assertEquals(CONTROL_BYTES, array.size)
        val threadCounts = control.thread >= CONTROL_BYTES && control.thread < 2 * CONTROL_BYTES
        val processCounts = control.process != null && control.process >= CONTROL_BYTES && control.process < 2 * CONTROL_BYTES
        say("control, an array of $CONTROL_BYTES bytes: this thread counted ${control.thread} (usable: $threadCounts), the process ${control.process} (usable: $processCounts)")
        assertTrue("neither counter counts on this device: ${control.thread} and ${control.process} for an array of $CONTROL_BYTES bytes", threadCounts || processCounts)

        for ((index, build) in inputs.withIndex()) {
            val input = build()
            val codec = measure(input, { NoteMetaCodec.merge(it, "n", 1) }, { NoteMetaCodec.peek(it) })
            val form = measure(input, { NoteMetaLibraryEvaluation.merge(it, "n", 1) }, { NoteMetaLibraryEvaluation.peek(it) })
            say("input ${index + 1} of ${inputs.size}: ${input.size} bytes; the codec's two bounds here: merge under ${3L * input.size}, peek under ${64 * 1024}")
            say("    codec: ${line(codec)}")
            say("    form on msgpack-core: ${line(form)}")
            // Printed and not asserted: which side is within the two bounds on this input, by the counter that counts here.
            say("    codec, held against the two bounds: ${verdicts(codec, input.size, threadCounts)}")
            say("    form on msgpack-core, held against the two bounds: ${verdicts(form, input.size, threadCounts)}")
            assertEquals("input ${index + 1}: the two outputs have the same size", codec.size, form.size)
            assertArrayEquals("input ${index + 1}: the two outputs are the same bytes, by their SHA-256", codec.digest, form.digest)
        }

        val codecPeek = counted { repeat(1000) { NoteMetaCodec.peek(note) } }.second
        val formPeek = counted { repeat(1000) { NoteMetaLibraryEvaluation.peek(note) } }.second
        say("one whole peek of the two-entry note, mean of 1000, on this thread: codec ${codecPeek.thread / 1000}, form on msgpack-core ${formPeek.thread / 1000}")
    }

    /** One merge of [input] and one peek of its output, each run twice: timed outside allocation counting, then counted. */
    private fun measure(input: ByteArray, merge: (ByteArray) -> Merge, peek: (ByteArray) -> Peek?): Figures {
        val mergeMillis = timed { merge(input) }
        val (output, merging) = counted { (merge(input) as Merge.Merged).bytes }
        val peekMillis = timed { peek(output) }
        val (peeked, peeking) = counted { peek(output) }
        assertEquals(Peek("n", 1), peeked)
        return Figures(merging, peeking, mergeMillis, peekMillis, output.size, MessageDigest.getInstance("SHA-256").digest(output))
    }

    private fun timed(block: () -> Any?): Long {
        val started = System.nanoTime()
        block()
        return (System.nanoTime() - started) / 1_000_000
    }

    /**
     * What [block] allocates: on this thread by the platform's deprecated counter, and in the whole
     * process by the runtime's own statistic where there is one.
     */
    @Suppress("DEPRECATION")
    private fun <T> counted(block: () -> T): Pair<T, Count> {
        Debug.startAllocCounting()
        try {
            val before = processAllocated()
            Debug.resetThreadAllocSize()
            val result = block()
            val thread = Debug.getThreadAllocSize()
            val after = processAllocated()
            return result to Count(thread, if (before != null && after != null) after - before else null)
        } finally {
            Debug.stopAllocCounting()
        }
    }

    /** The runtime's count of bytes allocated in this process, from API 23 on. */
    private fun processAllocated(): Long? =
        if (Build.VERSION.SDK_INT >= 23) Debug.getRuntimeStat("art.gc.bytes-allocated")?.toLongOrNull() else null

    private fun line(f: Figures): String =
        "merge ${f.merge.thread} bytes on this thread (${f.merge.process} in the process) in ${f.mergeMillis} ms, " +
            "peek of the merged output ${f.peek.thread} bytes on this thread (${f.peek.process} in the process) in ${f.peekMillis} ms"

    /**
     * For one side, "within" or "over" for its merge against 3 times the input size and for its peek
     * against 64 KiB. The figures are this thread's where the control showed that its counter counts,
     * else the process's, and the text says which. Printed only: no bound is asserted.
     */
    private fun verdicts(f: Figures, inputSize: Int, threadCounts: Boolean): String {
        val merge = if (threadCounts) f.merge.thread.toLong() else f.merge.process
        val peek = if (threadCounts) f.peek.thread.toLong() else f.peek.process
        val counter = if (threadCounts) "this thread's counter" else "the process's counter"
        return "merge ${word(merge, 3L * inputSize)}, peek ${word(peek, 64L * 1024)}, read from $counter"
    }

    private fun word(counted: Long?, bound: Long): String = when {
        counted == null -> "not read"
        counted < bound -> "within"
        else -> "over"
    }

    private fun hugeMap(header: String, entry: String, entries: Int): ByteArray {
        val head = unhex(header)
        val one = unhex(entry)
        val out = ByteArray(head.size + one.size * entries)
        head.copyInto(out)
        for (i in 0 until entries) one.copyInto(out, head.size + i * one.size)
        return out
    }

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun say(line: String) {
        Log.i(TAG, "allocation: $line")
    }

    private companion object {
        const val TAG = "NoteMetaCompare"
        const val CONTROL_BYTES = 1_048_576
    }
}
