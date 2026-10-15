package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.MsgpackCoreNoteMeta.Walk
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Merge
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Peek
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Why
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.BeforeClass
import org.junit.Test
import org.msgpack.core.MessageBufferPacker
import org.msgpack.core.MessageFormat
import org.msgpack.core.MessageIntegerOverflowException
import org.msgpack.core.MessagePack
import org.msgpack.core.MessageStringCodingException
import org.msgpack.core.MessageTypeException
import org.msgpack.core.buffer.MessageBuffer
import java.io.ByteArrayOutputStream
import java.io.File
import java.math.BigInteger
import java.util.EnumSet
import java.util.Random
import java.util.TreeMap

private const val HEX = "0123456789abcdef"

private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

private fun hex(b: ByteArray, from: Int = 0, to: Int = b.size): String {
    val sb = StringBuilder((to - from) * 2)
    for (i in from until to) {
        val v = b[i].toInt() and 0xff
        sb.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
    }
    return sb.toString()
}

/** For messages: an input of up to 100 bytes in full, a longer one as its first 100 bytes and its size. */
private fun cut(b: ByteArray?): String = when {
    b == null -> "null"
    b.size <= 100 -> hex(b)
    else -> hex(b, 0, 100) + "... (${b.size} bytes)"
}

/** For messages: printable ASCII as it is, every other UTF-16 unit as its number, so that the output stays ASCII. */
private fun quote(s: String?): String {
    if (s == null) return "null"
    val sb = StringBuilder("'")
    for (c in s.take(60)) if (c.code in 0x20..0x7e) sb.append(c) else sb.append("<U+%04X>".format(c.code))
    if (s.length > 60) sb.append("... (${s.length} chars)")
    return sb.append("'").toString()
}

private fun show(m: Merge): String = when (m) {
    is Merge.Merged -> "Merged ${cut(m.bytes)} name ${quote(m.name)}"
    is Merge.Refused -> "Refused(${m.key}, ${m.why})"
    is Merge.NotAMap -> "NotAMap(${m.reason})"
}

private fun show(p: Peek?): String = if (p == null) "null" else "Peek(${quote(p.name)}, ${p.mtime})"

/** The plain keys name and mtime as bytes: a str header at each of its four widths, then the text. */
private val PLAIN_KEYS = listOf(
    "a46e616d65", "d9046e616d65", "da00046e616d65", "db000000046e616d65",
    "a56d74696d65", "d9056d74696d65", "da00056d74696d65", "db000000056d74696d65",
).map { unhex(it) }

/** Whether the bytes from [from] up to [to] are the plain key name or mtime at any string width. */
private fun isPlainKey(bytes: ByteArray, from: Int, to: Int): Boolean = PLAIN_KEYS.any { key ->
    key.size == to - from && key.indices.all { bytes[from + it] == key[it] }
}

/**
 * The same inputs through [NoteMetaCodec] and through a second implementation of merge, fresh and peek
 * on msgpack-core 0.9.12 ([MsgpackCoreNoteMeta]), in its three walk variants. The public result calls
 * LIBRARY_SKIP, LEAF_SKIP and HEADERS_ONLY forms (a), (b) and (c); form (c) is [NoteMetaMsgpack].
 *
 * What is asserted:
 * - LEAF_SKIP and HEADERS_ONLY, the two careful walks, give the same result as the codec on every
 *   input. A difference fails the test and is listed.
 * - LIBRARY_SKIP, the library's own skipValue on every key and value, gives the same result wherever
 *   the codec accepts the input as one map. That is the independent check of the codec's own skipping:
 *   on such input every count is at most the size of the input, far below the 2^30 at which skipValue fails.
 * - Inside the comparison nothing is thrown out of a library-side call. Anything that is (an Error
 *   included) becomes a line and fails the test.
 * - For the random documents that the codec merges, the output is also held against the input: every
 *   byte after the map header and outside the two replaced values has to be in the output, in order.
 *
 * What is counted and printed: the inputs on which LIBRARY_SKIP accepts what the codec refuses as
 * NotAMap. skipValue is the method of CVE-2026-90473, and those inputs are its failing cases. That
 * every such input contains the published map32 pattern (a count from 2^30 to 2^31 - 1; from 2^31 on
 * skipValue throws MessageSizeException) is asserted; an input without it would be counted by its
 * length only and fail the test.
 *
 * The same result means: both sides Merged with identical bytes and the same name; or the same
 * Refused; or both NotAMap for a reason of the same kind (see [sameKindOfRefusal] and [difference]);
 * and the same peek, where null equals null.
 *
 * What a difference of zero can and cannot show: on the library side only the format layer is the
 * library's. The key rules, the count checks, the order of the output and the handling of the name
 * are the codec's own code or a copy of it (see the heads of NoteMetaMsgpack.kt and
 * MsgpackCoreNoteMeta.kt), so a mistake in one of them, or any mistake both sides share, gives no
 * difference here.
 *
 * The counts (comparisons for each corpus, differences for each variant, allocation figures, the
 * reasons on both sides) go to standard output, which Gradle keeps in the XML result of this class.
 * Every test has a time limit, and all inputs are synthetic.
 */
class NoteMetaCodecComparisonTest {

    private val libs = Walk.values().map { MsgpackCoreNoteMeta(it) }

    private fun lib(walk: Walk) = libs[walk.ordinal]

    // ---- the comparison ----

    private class Corpus(val title: String) {
        var inputs = 0L
        var merged = 0L
        var refused = 0L
        var notAMap = 0L

        /** Anything thrown out of a library-side call. */
        val thrown = ArrayList<String>()
        var thrownTotal = 0L

        /** LEAF_SKIP or HEADERS_ONLY differs from the codec. */
        val careful = ArrayList<String>()
        val carefulTotal = LongArray(Walk.values().size)

        /** LIBRARY_SKIP differs from the codec on input the codec accepts as one map. */
        val skipWhereAccepted = ArrayList<String>()
        var skipWhereAcceptedTotal = 0L

        /** LIBRARY_SKIP accepts input that the codec refuses as NotAMap; the lines are of the inputs with the published map32 pattern. */
        val skipAccepts = ArrayList<String>()
        var skipAcceptsTotal = 0L

        /**
         * The same, where the input has no map32 header byte followed by a count from 2^30 to 2^31 - 1.
         * It fails the test, and this record keeps its length only, never its bytes. (A line of a careful
         * walk or of a thrown call on the same input would still show its first 100 bytes.)
         */
        val skipAcceptsOther = ArrayList<String>()
        var skipAcceptsOtherTotal = 0L

        /**
         * LIBRARY_SKIP and the codec both refuse, for reasons of two kinds, where LIBRARY_SKIP is held to the
         * kind (see [difference]). Kept like the accepts: with its bytes only if it has the map32 pattern.
         */
        val skipOtherRefusal = ArrayList<String>()
        var skipOtherRefusalTotal = 0L

        /** Every reason a library side gave for NotAMap, for each walk: its own messages and the names of exception classes. */
        val libraryReasons = Array(Walk.values().size) { HashSet<String>() }

        fun summary(): String {
            val sb = StringBuilder()
            sb.append("corpus $title: $inputs comparisons (codec: Merged $merged, Refused $refused, NotAMap $notAMap)\n")
            sb.append("  LEAF_SKIP differences: ${carefulTotal[Walk.LEAF_SKIP.ordinal]}\n")
            sb.append("  HEADERS_ONLY differences: ${carefulTotal[Walk.HEADERS_ONLY.ordinal]}\n")
            sb.append("  LIBRARY_SKIP differences on input the codec accepts: $skipWhereAcceptedTotal\n")
            sb.append("  LIBRARY_SKIP accepts input the codec refuses as NotAMap: $skipAcceptsTotal")
            if (skipAcceptsTotal > 0) sb.append(" (of these, without the byte df followed by a count from 2^30 to 2^31 - 1: $skipAcceptsOtherTotal)")
            sb.append("\n")
            sb.append("  LIBRARY_SKIP refuses for a reason of another kind than the codec's, where it is held to the kind: $skipOtherRefusalTotal\n")
            sb.append("  thrown out of a library-side call: $thrownTotal\n")
            for (line in thrown) sb.append("    threw: $line\n")
            for (line in careful) sb.append("    careful walk: $line\n")
            for (line in skipWhereAccepted) sb.append("    LIBRARY_SKIP on accepted input: $line\n")
            for (line in skipAccepts) sb.append("    LIBRARY_SKIP accepts: $line\n")
            for (line in skipAcceptsOther) sb.append("    LIBRARY_SKIP accepts, no such map32 count: $line\n")
            for (line in skipOtherRefusal) sb.append("    LIBRARY_SKIP refuses for a reason of another kind: $line\n")
            return sb.toString()
        }
    }

    /**
     * Whether the input has the byte df (map32) followed by a count from 2^30 to 2^31 - 1, the published
     * case of skipValue. From 2^31 on skipValue throws MessageSizeException.
     */
    private fun hasBigMap32(raw: ByteArray?): Boolean {
        if (raw == null) return false
        for (i in 0 until raw.size - 1) {
            if ((raw[i].toInt() and 0xff) == 0xdf && (raw[i + 1].toInt() and 0xff) in 0x40..0x7f) return true
        }
        return false
    }

    /**
     * Both sides NotAMap is the same result only when the reasons are of one kind (for LIBRARY_SKIP see
     * [difference]): the same message; or the library's exception for a 32-bit count or length of 2^31 or more
     * where the codec says that a count or a length runs past the end; or the library's exception for a
     * read that ran out of input where the codec says that a length runs past the end.
     */
    private fun sameKindOfRefusal(codec: String, library: String): Boolean = when (library) {
        codec -> true
        "MessageSizeException" -> codec == COUNT_PAST_END || codec == LENGTH_PAST_END
        "MessageInsufficientBufferException" -> codec == LENGTH_PAST_END
        else -> false
    }

    /**
     * The comparison itself, without a call into either side: null when the library side's result is the
     * same as the codec's, else the line that says how it differs.
     *
     * Both sides NotAMap under LIBRARY_SKIP: where the codec refuses a container count, LIBRARY_SKIP has
     * no such check for nested values and refuses later, for another reason, so there it is not held to
     * a kind. For every other reason of the codec it is held to the same kinds as the careful walks, and
     * for the reserved byte 0xc1 to skipValue's own exception.
     */
    private fun difference(walk: Walk, raw: ByteArray?, name: String, mtime: Long, mine: Merge, minePeek: Peek?, theirs: Merge, theirPeek: Peek?): String? {
        val sameMerge = when {
            mine is Merge.Merged && theirs is Merge.Merged -> mine.bytes.contentEquals(theirs.bytes) && mine.name == theirs.name
            mine is Merge.NotAMap && theirs is Merge.NotAMap -> when {
                walk != Walk.LIBRARY_SKIP -> sameKindOfRefusal(mine.reason, theirs.reason)
                mine.reason == COUNT_PAST_END -> true
                mine.reason == RESERVED_BYTE -> theirs.reason == "MessageNeverUsedFormatException"
                else -> sameKindOfRefusal(mine.reason, theirs.reason)
            }
            else -> mine == theirs
        }
        return when {
            !sameMerge -> "merge differs on ${cut(raw)} with name ${quote(name)} and mtime $mtime: codec ${show(mine)}, library ${show(theirs)}"
            minePeek != theirPeek -> "peek differs on ${cut(raw)}: codec ${show(minePeek)}, library ${show(theirPeek)}"
            else -> null
        }
    }

    /** Puts one difference where it belongs. [mine] is the codec's result for [raw], [theirs] the library side's. */
    private fun record(c: Corpus, walk: Walk, raw: ByteArray?, mine: Merge, theirs: Merge, line: String) {
        when {
            walk != Walk.LIBRARY_SKIP -> {
                c.carefulTotal[walk.ordinal]++
                if (c.careful.size < KEPT) c.careful.add("$walk $line")
            }
            mine !is Merge.NotAMap -> {
                c.skipWhereAcceptedTotal++
                if (c.skipWhereAccepted.size < KEPT) c.skipWhereAccepted.add(line)
            }
            theirs is Merge.NotAMap -> {
                // Both refuse, for reasons of two kinds: not an accept. Its bytes are kept only with the map32 pattern.
                c.skipOtherRefusalTotal++
                if (c.skipOtherRefusal.size < KEPT) {
                    c.skipOtherRefusal.add(if (hasBigMap32(raw)) line else "an input of ${raw?.size} bytes: codec ${show(mine)}, library ${show(theirs)}")
                }
            }
            hasBigMap32(raw) -> {
                c.skipAcceptsTotal++
                if (c.skipAccepts.size < KEPT_ACCEPTS) c.skipAccepts.add(line)
            }
            else -> {
                // Without the map32 pattern, which no corpus has: this record keeps the length, not the bytes.
                c.skipAcceptsTotal++
                c.skipAcceptsOtherTotal++
                if (c.skipAcceptsOther.size < KEPT) c.skipAcceptsOther.add("an input of ${raw?.size} bytes")
            }
        }
    }

    /** One input, with one name and mtime, through the codec and the three variants. [label] says where the input comes from. */
    private fun compare(c: Corpus, raw: ByteArray?, name: String = "New", mtime: Long = 5, label: () -> String = { "" }) {
        if (c.inputs and 0xfffL == 0L && Thread.currentThread().isInterrupted) {
            throw IllegalStateException("stopped: the test ran past its time limit")
        }
        c.inputs++
        val mine = NoteMetaCodec.merge(raw, name, mtime)
        val minePeek = NoteMetaCodec.peek(raw)
        when (mine) {
            is Merge.Merged -> c.merged++
            is Merge.Refused -> c.refused++
            is Merge.NotAMap -> c.notAMap++
        }
        for (walk in Walk.values()) {
            // Whatever the library side throws becomes a line: an OutOfMemoryError, a StackOverflowError or
            // any exception must not end the run.
            val theirs = try {
                lib(walk).merge(raw, name, mtime)
            } catch (t: Throwable) {
                c.thrownTotal++
                if (c.thrown.size < KEPT) c.thrown.add(labeled(label, "$walk merge threw ${t.javaClass.name} on ${cut(raw)}"))
                continue
            }
            val theirPeek = try {
                lib(walk).peek(raw)
            } catch (t: Throwable) {
                c.thrownTotal++
                if (c.thrown.size < KEPT) c.thrown.add(labeled(label, "$walk peek threw ${t.javaClass.name} on ${cut(raw)}"))
                continue
            }
            if (theirs is Merge.NotAMap) c.libraryReasons[walk.ordinal].add(theirs.reason)
            if (mine is Merge.NotAMap && theirs is Merge.NotAMap) countReasons(walk, mine.reason, theirs.reason)
            val line = difference(walk, raw, name, mtime, mine, minePeek, theirs, theirPeek) ?: continue
            record(c, walk, raw, mine, theirs, labeled(label, line))
        }
    }

    private fun labeled(label: () -> String, line: String): String = label().let { if (it.isEmpty()) line else "$it: $line" }

    /** What every corpus has to satisfy. [expected] is the number of comparisons the corpus is known to make. */
    private fun verify(c: Corpus, expected: Long) {
        assertTrue("corpus ${c.title} is empty", c.inputs > 0)
        assertEquals("corpus ${c.title}: the number of comparisons", expected, c.inputs)
        assertTrue("a library-side call threw ${c.thrownTotal} times; the first ${c.thrown.size}:\n" + c.thrown.joinToString("\n"), c.thrownTotal == 0L)
        val careful = c.carefulTotal[Walk.LEAF_SKIP.ordinal] + c.carefulTotal[Walk.HEADERS_ONLY.ordinal]
        assertTrue(
            "LEAF_SKIP or HEADERS_ONLY differs from the codec $careful times; the first ${c.careful.size}:\n" + c.careful.joinToString("\n"),
            careful == 0L,
        )
        assertTrue(
            "LIBRARY_SKIP differs from the codec on ${c.skipWhereAcceptedTotal} inputs the codec accepts; the first ${c.skipWhereAccepted.size}:\n" +
                c.skipWhereAccepted.joinToString("\n"),
            c.skipWhereAcceptedTotal == 0L,
        )
        assertTrue(
            "LIBRARY_SKIP accepts ${c.skipAcceptsOtherTotal} inputs the codec refuses that have no map32 count from 2^30 to 2^31 - 1. " +
                "The published defect of skipValue does not explain that: look at the library, and at the refusal that the codec " +
                "and the careful walks share; the first ${c.skipAcceptsOther.size}: " + c.skipAcceptsOther.joinToString(", "),
            c.skipAcceptsOtherTotal == 0L,
        )
        assertTrue(
            "LIBRARY_SKIP and the codec refuse ${c.skipOtherRefusalTotal} inputs for reasons of two kinds where the kind has to be the same; " +
                "the first ${c.skipOtherRefusal.size}:\n" + c.skipOtherRefusal.joinToString("\n"),
            c.skipOtherRefusalTotal == 0L,
        )
        // The library side refuses through its own checks or through the library's two exceptions for input
        // that runs out or declares a size of 2^31 or more (and, where skipValue meets 0xc1, a third). Any
        // other class here, for example an IndexOutOfBoundsException out of the buffer class, would mean
        // that malformed input reached code that did not expect it.
        for (walk in Walk.values()) {
            val allowed = if (walk == Walk.LIBRARY_SKIP) REFUSALS + "MessageNeverUsedFormatException" else REFUSALS
            val other = c.libraryReasons[walk.ordinal] - allowed
            assertTrue("$walk refused input for a reason that is not expected: $other", other.isEmpty())
        }
    }

    private fun finish(c: Corpus, expected: Long) {
        print(c.summary())
        verify(c, expected)
    }

    // ---- the inputs of the codec's own tests, each with what that test expects of the codec ----

    private enum class Kind { MERGES, MERGES_TO, REFUSES, NOT_A_MAP, PEEKS, PEEKS_NULL }

    private class Case(val hex: String, val kind: Kind, val detail: String = "", val peek: Peek? = null, val name: String = "New", val mtime: Long = 5)

    private fun merges(hex: String) = Case(hex, Kind.MERGES)

    private fun mergesTo(hex: String, out: String, name: String = "New", mtime: Long = 5) = Case(hex, Kind.MERGES_TO, out, name = name, mtime = mtime)

    private fun refuses(hex: String, key: String, why: Why) = Case(hex, Kind.REFUSES, "Refused($key, $why)")

    private fun notAMap(hex: String, reason: String) = Case(hex, Kind.NOT_A_MAP, "NotAMap($reason)")

    private fun peeks(hex: String, name: String?, mtime: Long?) = Case(hex, Kind.PEEKS, peek = Peek(name, mtime))

    private fun peeksNull(hex: String) = Case(hex, Kind.PEEKS_NULL)

    /**
     * The 20 fixtures of NoteMetaCodecTest and every hand-encoded input of its tests, by the name of the
     * test each comes from, each with the expectation of that test (for a fixture: that it merges), so a
     * copying mistake fails here.
     */
    private fun copiedCases(): List<Case> {
        val fixtures = NoteMetaCodecTest().allFixtures
        // f float32 1.0, s str32 'ab', b bin32 [1], a array32 [1], m map32 {a: 1}, x y z w fixext 2, 4, 8 and 16, v ext16
        val never = "a166ca3f800000" + "a173db000000026162" + "a162c60000000101" + "a161dd0000000101" + "a16ddf00000001a16101" +
            "a178d50701ff" + "a179d60701020304" + "a17ad707" + "00".repeat(8) + "a177d807" + "00".repeat(16) + "a176c8000207abab"
        val overlongMtime = "f08081adf08081b4f08081a9f08081adf08081a5"
        val longKey = "78".repeat(40)
        val count = COUNT_PAST_END
        val length = LENGTH_PAST_END
        return fixtures.map { merges(it) } + listOf(
            // widths the web never writes survive byte for byte
            mergesTo("8ca46e616d65a141a56d74696d6501$never", "8ca46e616d65a34e6577a56d74696d6505$never"),
            // a missing mtime or name is added after the other entries
            mergesTo("82a56d74696d6501a16ba131", "83a56d74696d6505a16ba131a46e616d65a34e6577"),
            // name and mtime keys written at any string width are the same keys
            mergesTo("82da00046e616d65a141db000000056d74696d6501", "82da00046e616d65a34e6577db000000056d74696d6505"),
            // a repeated name or mtime is refused rather than guessed
            refuses("82a46e616d65a161a46e616d65a162", "name", Why.REPEATED),
            refuses("82a56d74696d6501a56d74696d6502", "mtime", Why.REPEATED),
            refuses("82a46e616d65a161d9046e616d65a162", "name", Why.REPEATED),
            refuses("82a46e616d65a161da00046e616d65a162", "name", Why.REPEATED),
            refuses("82a56d74696d6501db000000056d74696d6502", "mtime", Why.REPEATED),
            // a key the typed decoder reads as name or mtime is refused
            refuses("8201a34f6c64a56d74696d6505", "name", Why.ALIASED),
            refuses("82cc01a34f6c64a56d74696d6505", "name", Why.ALIASED),
            refuses("82a46e616d65a34f6c640205", "mtime", Why.ALIASED),
            refuses("82a46e616d65a34f6c64cd000205", "mtime", Why.ALIASED),
            refuses("82a46e616d65a34f6c64cf000000000000000205", "mtime", Why.ALIASED),
            refuses("82c4046e616d65a34f6c64a56d74696d6505", "name", Why.ALIASED),
            refuses("82a46e616d65a141c4056d74696d6505", "mtime", Why.ALIASED),
            mergesTo("8200a141a56d74696d6501", "8300a141a56d74696d6505a46e616d65a34e6577"),
            mergesTo("8203a141a56d74696d6501", "8303a141a56d74696d6505a46e616d65a34e6577"),
            mergesTo("8204a141a56d74696d6501", "8304a141a56d74696d6505a46e616d65a34e6577"),
            mergesTo("820aa141a56d74696d6501", "830aa141a56d74696d6505a46e616d65a34e6577"),
            mergesTo("82d001a141a56d74696d6501", "83d001a141a56d74696d6505a46e616d65a34e6577"),
            // a malformed UTF-8 key the web reads as name or mtime is refused
            refuses("82a8c1aec1a1c1adc1a5a55469746c65a56d74696d6505", "name", Why.ALIASED),
            refuses("82a6e081ae616d65a141a56d74696d6501", "name", Why.ALIASED),
            refuses("82a7f08081ae616d65a141a56d74696d6501", "name", Why.ALIASED),
            refuses("82a46e616d65a141a6c1ad74696d6505", "mtime", Why.ALIASED),
            refuses("83a46e616d65a55469746c65a8c1aec1a1c1adc1a5a54f74686572a56d74696d6505", "name", Why.ALIASED),
            refuses("82a46e616dc1a55469746c65a56d74696d6505", "name", Why.ALIASED),
            // keys longer than 16 bytes are read the same lenient way
            refuses("82a46e616d65a141b4${overlongMtime}05", "mtime", Why.ALIASED),
            refuses("82a46e616d65a141b1${overlongMtime.substring(0, 32)}f005", "mtime", Why.ALIASED),
            mergesTo("82a46e616d65a141d928${longKey}01", "83a46e616d65a34e6577d928${longKey}01a56d74696d6505"),
            // other malformed or near-miss keys are copied as they are
            mergesTo("83a46e616d65a141a56d74696d6501a2c328a178", "83a46e616d65a34e6577a56d74696d6505a2c328a178"),
            mergesTo("82a56e616dc3a9a141a56d74696d6501", "83a56e616dc3a9a141a56d74696d6505a46e616d65a34e6577"),
            // a repeated key this app does not use is copied as it is
            mergesTo("83a46e616d65a161a16b01a16b02", "84a46e616d65a16ea16b01a16b02a56d74696d6501", name = "n", mtime = 1),
            // anything that is not exactly one well-formed map is reported, never guessed at
            notAMap("9101", "the top level is not a map"),
            notAMap("c0", "the top level is not a map"),
            notAMap(fixtures[0] + "00", "trailing bytes after the map"),
            // hostile lengths and counts are refused before any work
            notAMap("dfffffffff", count),
            notAMap("81a178ddffffffff", count),
            notAMap("81a178dfffffffff", count),
            notAMap("81a1789f0101", count),
            notAMap("81a178dbffffffff", length),
            notAMap("81a178c9ffffffff01", length),
            notAMap("81a178c70507abababab", length),
            notAMap("81a178d807" + "00".repeat(15), length),
            notAMap("81a178c1", "reserved type 0xc1"),
            // peek reads what the typed decoder would and also what it rejects (the two float32 inputs)
            peeks("82a46e616d65a141a56d74696d65ca3fc00000", "A", 1),
            peeks("82a46e616d65a141a56d74696d65cac0200000", "A", -2),
            // peek leaves out values it cannot trust
            peeks("82a46e616d6505a56d74696d6501", null, 1),
            peeks("81a46e616d65a2c328", null, null),
            peeks("82a46e616d65a16ea56d74696d65a131", "n", null),
            peeks("81a56d74696d65cfffffffffffffffff", null, null),
            peeks("81a56d74696d65cb7ff8000000000000", null, null),
            peeks("82a46e616d65a161a46e616d65a162", null, null),
            peeks("83a46e616d65a161a56d74696d6501a56d74696d6502", "a", null),
            peeks("83a46e616d65a141a56d74696d650501a142", null, 5),
            peeks("82a8c1aec1a1c1adc1a5a55469746c65a56d74696d6505", null, 5),
            peeks("83a46e616d65a141a56d74696d650502a142", "A", null),
            peeksNull("9101"),
        )
    }

    /** Seven inputs that are not in the codec's tests, with expected results written by hand. */
    private fun addedCases(): List<Case> = listOf(
        // A top-level header wider than its count needs. This is the one place where the codec does not keep
        // an encoding, since it writes the header again at the smallest width.
        mergesTo("de0000", "82a46e616d65a34e6577a56d74696d6505"),
        mergesTo("df00000000", "82a46e616d65a34e6577a56d74696d6505"),
        mergesTo("de0002a46e616d65a141a56d74696d6501", "82a46e616d65a34e6577a56d74696d6505"),
        mergesTo("df00000001a17801", "83a17801a46e616d65a34e6577a56d74696d6505"),
        // Inputs chosen because a less careful use of the library could go wrong on them: an unsigned 64-bit
        // value above Long.MAX_VALUE, an ext of type -1 that is not a timestamp length, and a name that is a
        // binary value.
        mergesTo("81a178cfffffffffffffffff", "83a178cfffffffffffffffffa46e616d65a34e6577a56d74696d6505"),
        mergesTo("81a178c703ff010203", "83a178c703ff010203a46e616d65a34e6577a56d74696d6505"),
        peeks("81a46e616d65c40141", null, null),
    )

    private fun ownCases(): List<Case> = copiedCases() + addedCases()

    private fun checkOwn(c: Case) {
        val raw = unhex(c.hex)
        val merge = NoteMetaCodec.merge(raw, c.name, c.mtime)
        when (c.kind) {
            Kind.MERGES -> assertTrue(c.hex, merge is Merge.Merged)
            Kind.MERGES_TO -> assertEquals(c.hex, c.detail, (merge as? Merge.Merged)?.let { hex(it.bytes) })
            Kind.REFUSES, Kind.NOT_A_MAP -> assertEquals(c.hex, c.detail, show(merge))
            Kind.PEEKS -> assertEquals(c.hex, c.peek, NoteMetaCodec.peek(raw))
            Kind.PEEKS_NULL -> assertNull(c.hex, NoteMetaCodec.peek(raw))
        }
    }

    /** {'': 0} 65534 times in a map16, hand-encoded: the one input of the codec's tests whose merge writes a map32 header. */
    private fun map65534(): ByteArray = ByteArrayOutputStream().apply {
        write(unhex("defffe"))
        repeat(65534) {
            write(0xa0)
            write(0x00)
        }
    }.toByteArray()

    /** Every distinct input of [ownCases], and the 65534-entry map after them. */
    private fun ownInputs(): List<ByteArray> = ownCases().map { it.hex }.distinct().map { unhex(it) } + listOf(map65534())

    // ---- 1 ----

    /**
     * android/app/build.gradle sets msgpack.universal-buffer=true for unit tests, which makes msgpack-core
     * use MessageBufferU, its buffer class on top of ByteBuffer. By the library's source that is the class
     * it picks on Android. On the branch of the library evaluation a device case asserts that, with the
     * property not set: theMetadataFormOnMsgpackCoreRunsInTheMinifiedBuildAndGivesWhatTheCodecGives.
     */
    @Test(timeout = 30_000)
    fun `msgpack-core runs on its ByteBuffer-based buffer class in these tests`() {
        assertEquals("MessageBufferU", MessageBuffer.wrap(ByteArray(1)).javaClass.simpleName)
        println("msgpack-core is loaded from ${MessagePack::class.java.protectionDomain?.codeSource?.location}")
    }

    // ---- 2 ----

    @Test(timeout = 120_000)
    fun `every input of the codec's own tests gives the same result`() {
        val copied = copiedCases()
        val added = addedCases()
        for (case in copied + added) checkOwn(case)
        assertEquals(
            "NoteMetaCodecTest.allFixtures changed. Corpora 2, 3 and 4 are built from it: update this number, the text " +
                "'inputs 0 to 19 are the fixtures', and the counts passed to finish() in tests 2, 3 and 4 (each failure prints the new count)",
            20,
            NoteMetaCodecTest().allFixtures.size,
        )

        val corpus = Corpus("2, the inputs of the codec's own tests, each with ${WRITES.size} names and mtimes")
        for ((name, mtime) in WRITES) {
            compare(corpus, null, name, mtime) { "null" }
            compare(corpus, ByteArray(0), name, mtime) { "the empty array" }
        }
        assertEquals("NotAMap(empty)", show(NoteMetaCodec.merge(null, "n", 1)))
        assertEquals("NotAMap(empty)", show(NoteMetaCodec.merge(ByteArray(0), "n", 1)))

        // Where an exception of the library is the cause, the reason on the library side is the name of its
        // class. That is a difference in wording only; sameKindOfRefusal says which pairs count as the same.
        for ((input, codecReason, libraryReason) in listOf(
            Triple("dfffffffff", COUNT_PAST_END, "MessageSizeException"),
            Triple("81a178dbffffffff", LENGTH_PAST_END, "MessageSizeException"),
            Triple("81a178de00", LENGTH_PAST_END, "MessageInsufficientBufferException"),
        )) {
            assertEquals(input, "NotAMap($codecReason)", show(NoteMetaCodec.merge(unhex(input), "New", 5)))
            for (walk in listOf(Walk.LEAF_SKIP, Walk.HEADERS_ONLY)) {
                assertEquals("$walk $input", "NotAMap($libraryReason)", show(lib(walk).merge(unhex(input), "New", 5)))
            }
        }

        // What tells the three variants apart. A fixstr that promises five bytes and has none: LEAF_SKIP
        // hands it to skipValue, which runs out of input; HEADERS_ONLY reads the header and refuses the
        // length itself, so it does not call skipValue on a payload.
        assertEquals("NotAMap(MessageInsufficientBufferException)", show(lib(Walk.LEAF_SKIP).merge(unhex("81a178a5"), "New", 5)))
        assertEquals("NotAMap($LENGTH_PAST_END)", show(lib(Walk.HEADERS_ONLY).merge(unhex("81a178a5"), "New", 5)))
        // A container of each of the six formats that promises more than is there: both careful walks read
        // the header and refuse the count themselves, so neither hands a container to skipValue;
        // LIBRARY_SKIP does, and skipValue runs out of input.
        for (input in listOf("81a1789201", "81a1788101", "81a178dc000201", "81a178dd0000000201", "81a178de000101", "81a178df0000000101")) {
            for (walk in listOf(Walk.LEAF_SKIP, Walk.HEADERS_ONLY)) {
                assertEquals("$walk $input", "NotAMap($COUNT_PAST_END)", show(lib(walk).merge(unhex(input), "New", 5)))
            }
            assertEquals(input, "NotAMap(MessageInsufficientBufferException)", show(lib(Walk.LIBRARY_SKIP).merge(unhex(input), "New", 5)))
        }

        val inputs = ownInputs()
        for ((i, raw) in inputs.withIndex()) for ((name, mtime) in WRITES) compare(corpus, raw, name, mtime) { "input $i" }

        // The 65534-entry map grows to a map32 header on both sides.
        val big = inputs.last()
        val grown = (NoteMetaCodec.merge(big, "n", 5) as Merge.Merged).bytes
        assertEquals("df00010000", hex(grown, 0, 5))
        assertEquals(big.size + 2 + 14, grown.size)
        for (walk in Walk.values()) assertTrue("$walk", (lib(walk).merge(big, "n", 5) as Merge.Merged).bytes.contentEquals(grown))

        // fresh, on every variant
        var fresh = 0
        for ((name, mtime) in WRITES) {
            val mine = NoteMetaCodec.fresh(name, mtime)
            for (walk in Walk.values()) {
                val theirs = lib(walk).fresh(name, mtime)
                assertTrue("$walk fresh ${quote(name)} $mtime: codec ${cut(mine.bytes)}, library ${cut(theirs.bytes)}", mine.bytes.contentEquals(theirs.bytes))
                assertEquals("$walk fresh ${quote(name)} $mtime", mine.name, theirs.name)
                fresh++
            }
        }
        println(
            "corpus 2: ${copied.size + added.size} cases: ${copied.size} copied from the codec's tests with that test's expectation, " +
                "${added.size} added with a hand-written expectation; ${inputs.size} distinct inputs with the 65534-entry map (inputs 0 to 19 are the fixtures), " +
                "and null and the empty array; $fresh fresh comparisons",
        )
        finish(corpus, 588)
    }

    // ---- 3 ----

    @Test(timeout = 120_000)
    fun `every prefix of every valid input gives the same result`() {
        val corpus = Corpus("3, the prefixes of every input of corpus 2 that the codec accepts")
        var sources = 0
        var sampled = 0
        for ((i, full) in ownInputs().withIndex()) {
            if (NoteMetaCodec.merge(full, "New", 5) is Merge.NotAMap) continue
            sources++
            if (full.size <= EVERY_PREFIX_UP_TO) {
                for (length in 1 until full.size) compare(corpus, full.copyOf(length)) { "the first $length bytes of input $i" }
            } else {
                // Every prefix of a large input would be quadratic in its size: the first and the last 64
                // lengths, and every 1021st in between.
                sampled++
                val lengths = sortedSetOf<Int>()
                for (length in 1..64) lengths.add(length)
                for (length in full.size - 64 until full.size) lengths.add(length)
                for (length in 65 until full.size - 64 step 1021) lengths.add(length)
                for (length in lengths) compare(corpus, full.copyOf(length)) { "the first $length bytes of input $i" }
            }
        }
        println("corpus 3: $sources accepted inputs; every proper prefix of those of at most $EVERY_PREFIX_UP_TO bytes, a sample of the prefixes of $sampled larger ones")
        // A proper prefix of one complete map is never one complete map.
        assertEquals("the codec accepts no proper prefix", 0L, corpus.merged + corpus.refused)
        finish(corpus, 2958)
    }

    // ---- 4 ----

    @Test(timeout = 300_000)
    fun `every single-byte change of the small inputs gives the same result`() {
        val corpus = Corpus("4, every one-byte change, removal and insertion in the inputs of corpus 2 of at most 64 bytes")
        // the index is the one of corpus 2: inputs 0 to 19 are the fixtures
        val small = ownInputs().withIndex().filter { it.value.size <= 64 }
        val inserted = intArrayOf(0x00, 0x80, 0x90, 0xa0, 0xc1, 0xc4, 0xdc, 0xde, 0xdf, 0xff)
        for ((i, original) in small) {
            val work = original.copyOf()
            for (at in work.indices) {
                val saved = work[at]
                for (v in 0..255) {
                    if (v.toByte() == saved) continue
                    work[at] = v.toByte()
                    compare(corpus, work) { "input $i, byte $at changed from ${hex(byteArrayOf(saved))} to ${hex(byteArrayOf(v.toByte()))}" }
                }
                work[at] = saved
            }
            for (at in original.indices) {
                compare(corpus, original.copyOfRange(0, at) + original.copyOfRange(at + 1, original.size)) { "input $i, byte $at removed" }
            }
            for (at in 0..original.size) for (v in inserted) {
                compare(corpus, original.copyOfRange(0, at) + v.toByte() + original.copyOfRange(at, original.size)) {
                    "input $i, ${hex(byteArrayOf(v.toByte()))} inserted at $at"
                }
            }
        }
        println("corpus 4: ${small.size} inputs of at most 64 bytes, ${small.sumOf { it.value.size }} bytes together")
        finish(corpus, 375_524)
    }

    // ---- 5 ----

    /**
     * A header that declares a length or a count. [width] is the size of the number field, 0 where the
     * number is part of the type byte; one declared unit promises [unit] bytes (1, or 2 for a map entry
     * of two one-byte values), after [extra] bytes (the type byte of an ext).
     */
    private class Shape(val type: Int, val width: Int, val unit: Int, val extra: Int, val numbers: LongArray) {
        fun header(n: Long): ByteArray = ByteArray(1 + width).also {
            it[0] = type.toByte()
            for (i in 0 until width) it[1 + i] = (n ushr (8 * (width - 1 - i))).toByte()
        }

        fun promised(n: Long): Long = extra + n * unit
    }

    private fun shapes(): List<Shape> {
        val one = longArrayOf(0, 1, 2, 15, 16, 17, 31, 32, 255)
        val two = one + longArrayOf(256, 65535)
        val four = two + longArrayOf(65536, 0x3fffffff, 0x40000000, 0x7fffffff, 0x80000000, 0xffffffff)
        val list = ArrayList<Shape>()
        list.add(Shape(0xd9, 1, 1, 0, one)) // str8, str16, str32
        list.add(Shape(0xda, 2, 1, 0, two))
        list.add(Shape(0xdb, 4, 1, 0, four))
        list.add(Shape(0xc4, 1, 1, 0, one)) // bin8, bin16, bin32
        list.add(Shape(0xc5, 2, 1, 0, two))
        list.add(Shape(0xc6, 4, 1, 0, four))
        list.add(Shape(0xc7, 1, 1, 1, one)) // ext8, ext16, ext32
        list.add(Shape(0xc8, 2, 1, 1, two))
        list.add(Shape(0xc9, 4, 1, 1, four))
        list.add(Shape(0xdc, 2, 1, 0, two)) // array16, array32
        list.add(Shape(0xdd, 4, 1, 0, four))
        list.add(Shape(0xde, 2, 2, 0, two)) // map16, map32
        list.add(Shape(0xdf, 4, 2, 0, four))
        for (n in 0..31) list.add(Shape(0xa0 or n, 0, 1, 0, longArrayOf(n.toLong()))) // fixstr
        for (n in 0..15) list.add(Shape(0x90 or n, 0, 1, 0, longArrayOf(n.toLong()))) // fixarray
        for (n in 0..15) list.add(Shape(0x80 or n, 0, 2, 0, longArrayOf(n.toLong()))) // fixmap
        for ((i, n) in longArrayOf(1, 2, 4, 8, 16).withIndex()) list.add(Shape(0xd4 + i, 0, 1, 1, longArrayOf(n))) // fixext
        return list
    }

    @Test(timeout = 120_000)
    fun `declared lengths and counts past the end give the same result`() {
        val corpus = Corpus("5, declared lengths and counts as a value, as a key and at the top level")
        val all = shapes()
        var headers = 0
        var unbounded = 0
        for (shape in all) for (n in shape.numbers) {
            headers++
            // Followed by no byte, by one and, where the promise is at most 200,000 bytes, by all but one, all,
            // or one more than the bytes it promises (nil bytes). A header that promises more is followed by
            // no byte or by one only.
            val promised = shape.promised(n)
            if (promised > 200_000) unbounded++
            val following = sortedSetOf(0, 1)
            for (k in longArrayOf(promised - 1, promised, promised + 1)) if (k >= 0 && k <= 200_000) following.add(k.toInt())
            for (k in following) {
                val head = shape.header(n)
                val item = head + ByteArray(k) { 0xc0.toByte() }
                compare(corpus, unhex("81a178") + item) { "${hex(head)} and $k bytes, as the value of key x" }
                compare(corpus, unhex("81") + item + unhex("01")) { "${hex(head)} and $k bytes, as a key with the value 1 after it" }
                compare(corpus, item) { "${hex(head)} and $k bytes, at the top level" }
            }
        }
        println("corpus 5: ${all.size} header types, $headers headers with a declared number, $unbounded of them promising more than 200000 bytes")
        finish(corpus, 3069)

        // Like test 9 this holds only while skipValue has the published defect: the four accepts of this corpus,
        // in the order the headers are made. It also shows that a real difference reaches a corpus through compare().
        val accepts = listOf(
            "df40000000 and 0 bytes, as the value of key x: merge differs on 81a178df40000000 ",
            "df40000000 and 0 bytes, as a key with the value 1 after it: merge differs on 81df4000000001 ",
            "df7fffffff and 0 bytes, as the value of key x: merge differs on 81a178df7fffffff ",
            "df7fffffff and 0 bytes, as a key with the value 1 after it: merge differs on 81df7fffffff01 ",
        )
        assertEquals(4L, corpus.skipAcceptsTotal)
        assertEquals(accepts.size, corpus.skipAccepts.size)
        for ((i, start) in accepts.withIndex()) assertTrue(corpus.skipAccepts[i], corpus.skipAccepts[i].startsWith(start))
    }

    // ---- 6 ----

    @Test(timeout = 120_000)
    fun `deep nesting gives the same result`() {
        val corpus = Corpus("6, 200000 levels of nesting, complete and one byte short")
        // [..], {'': ..}, the same as array16 and map16, and as array32 and map32
        for (level in listOf("91", "81a0", "dc0001", "de0001a0", "dd00000001", "df00000001a0")) {
            val unit = unhex(level)
            val input = ByteArrayOutputStream().apply {
                write(unhex("81a178"))
                repeat(200_000) { write(unit) }
                write(0xc0)
            }.toByteArray()
            assertTrue("$level: the codec merges the complete input", NoteMetaCodec.merge(input, "New", 5) is Merge.Merged)
            compare(corpus, input) { "200000 levels of $level" }
            val short = input.copyOf(input.size - 1)
            assertTrue("$level: the codec refuses the input one byte short", NoteMetaCodec.merge(short, "New", 5) is Merge.NotAMap)
            compare(corpus, short) { "200000 levels of $level, one byte short" }
        }
        finish(corpus, 12)
    }

    // ---- 7 ----

    /** HotSpot's allocation counter for this thread, by reflection since unit tests compile against android.jar. */
    @Suppress("DEPRECATION") // Thread.id: its replacement does not exist on the JDK 17 that runs the unit tests
    private fun allocationCounter(): () -> Long {
        val bean = Class.forName("java.lang.management.ManagementFactory").getMethod("getThreadMXBean").invoke(null)
        val mx = Class.forName("com.sun.management.ThreadMXBean")
        val counter = mx.getMethod("getThreadAllocatedBytes", Long::class.javaPrimitiveType)
        // Without a working counter every figure below would be 0.
        assertTrue("allocation counting is supported", mx.getMethod("isThreadAllocatedMemorySupported").invoke(bean) as Boolean)
        assertTrue("allocation counting is enabled", mx.getMethod("isThreadAllocatedMemoryEnabled").invoke(bean) as Boolean)
        val id = Thread.currentThread().id
        return { counter.invoke(bean, id) as Long }
    }

    private fun hugeMap(header: String, entry: String, entries: Int): ByteArray {
        val head = unhex(header)
        val one = unhex(entry)
        val out = ByteArray(head.size + one.size * entries)
        head.copyInto(out)
        for (i in 0 until entries) one.copyInto(out, head.size + i * one.size)
        return out
    }

    @Test(timeout = 300_000)
    fun `huge maps give the same result and the allocation of both sides is reported`() {
        val corpus = Corpus("7, huge maps")
        val allocated = allocationCounter()
        assertTrue("the counter reports a value", allocated() >= 0)
        val inputs = listOf(
            // the input of the codec's own memory test
            "2,000,000 entries of '' to 0 (a0 00)" to hugeMap("df001e8480", "a000", 2_000_000),
            // an ext value for each entry
            "2,000,000 entries of '' to a fixext1 (a0 d4 07 00)" to hugeMap("df001e8480", "a0d40700", 2_000_000),
            // an unsigned integer key for each entry
            "2,000,000 entries of 0 to 0 (00 00)" to hugeMap("df001e8480", "0000", 2_000_000),
            // an unsigned 64-bit key above Long.MAX_VALUE for each entry: unpackLong reports each one with an exception
            "200,000 entries of 18446744073709551615 to 0 (cf ff ff ff ff ff ff ff ff 00)" to hugeMap("df00030d40", "cfffffffffffffffff00", 200_000),
            // an unsigned 64-bit value for each entry, in the form the web writes a millisecond mtime
            "1,000,000 entries of '' to 1758800000000 as an unsigned 64-bit value (a0 cf 00 00 01 99 80 a6 34 00)" to
                hugeMap("df000f4240", "a0cf0000019980a63400", 1_000_000),
        )
        // Class loading and first-use work are not what is measured.
        val small = unhex("84a46e616d65a141a56d74696d65010000cfffffffffffffffff00")
        repeat(300) {
            NoteMetaCodec.merge(small, "warm", 1)
            NoteMetaCodec.peek(small)
            for (walk in Walk.values()) {
                lib(walk).merge(small, "warm", 1)
                lib(walk).peek(small)
            }
        }
        val idle = allocated().let { allocated() - it }
        val lines = ArrayList<String>()
        lines.add("allocation in bytes on the test thread, and time, for one call each (two readings of the counter with nothing between them: $idle bytes)")
        lines.add("'within' and 'over' hold each figure against the bounds of the codec's own memory test: merge under 3 times the input size, peek under 64 KiB")
        lines.add("the times are of single calls in a warm JVM, to show the order of magnitude; they are not a benchmark")
        lines.add("LIBRARY_SKIP reads an integer key through a second unpacker; its figures on the two inputs with integer keys come from that, not from skipValue")

        /** One merge of [input] and one peek of its output: the output, and the bytes allocated by each. */
        fun measure(label: String, input: ByteArray, merge: (ByteArray) -> Merge, peek: (ByteArray) -> Peek?): Pair<ByteArray, LongArray> {
            var before = allocated()
            var started = System.nanoTime()
            val out = (merge(input) as Merge.Merged).bytes
            val mergeNanos = System.nanoTime() - started
            val merging = allocated() - before
            before = allocated()
            started = System.nanoTime()
            val peeked = peek(out)
            val peekNanos = System.nanoTime() - started
            val peeking = allocated() - before
            assertEquals(label, Peek("n", 1), peeked)
            lines.add(
                "    $label: merge $merging bytes (${if (merging < 3L * input.size) "within" else "over"}) in ${mergeNanos / 1_000_000} ms, " +
                    "peek of the merged output $peeking bytes (${if (peeking < 64 * 1024) "within" else "over"}) in ${peekNanos / 1_000_000} ms",
            )
            return out to longArrayOf(merging, peeking)
        }

        for ((title, input) in inputs) {
            compare(corpus, input, "n", 1) { title }
            lines.add("  $title, ${input.size} bytes")
            val (out, figures) = measure("codec", input, { NoteMetaCodec.merge(it, "n", 1) }, { NoteMetaCodec.peek(it) })
            // The bounds of the codec's own memory test, here on every one of these inputs.
            assertTrue("$title: the codec's merge allocated ${figures[0]} bytes for ${input.size}", figures[0] < 3L * input.size)
            assertTrue("$title: the codec's peek allocated ${figures[1]} bytes for ${out.size}", figures[1] < 64 * 1024)
            for (walk in Walk.values()) {
                val side = lib(walk)
                val theirs = measure(walk.name, input, { side.merge(it, "n", 1) }, { side.peek(it) }).first
                assertTrue("$walk $title: the same bytes as the codec", theirs.contentEquals(out))
            }
        }

        // What a name read costs through the library's own string read (R7 in MsgpackCoreNoteMeta), next to a whole peek.
        val title = unhex("a947726f636572696573") // 'Groceries'
        val note = unhex("82a46e616d65a947726f636572696573a56d74696d65cf0000019980a63400")
        repeat(300) { MsgpackCoreNoteMeta.STRICT.newUnpacker(title).unpackString() }
        var before = allocated()
        repeat(1000) { MsgpackCoreNoteMeta.STRICT.newUnpacker(title).unpackString() }
        val throughLibrary = (allocated() - before) / 1000
        before = allocated()
        repeat(1000) { NoteMetaCodec.peek(note) }
        val codecPeek = (allocated() - before) / 1000
        lines.add("  one read of a 9-byte name through a second unpacker and unpackString on strict settings: $throughLibrary (mean of 1000)")
        lines.add("  one whole peek of a two-entry note, mean of 1000: codec $codecPeek")
        for (walk in Walk.values()) {
            val side = lib(walk)
            before = allocated()
            repeat(1000) { side.peek(note) }
            lines.add("  one whole peek of a two-entry note, mean of 1000: $walk ${(allocated() - before) / 1000}")
        }
        println(lines.joinToString("\n"))
        finish(corpus, 5)
    }

    // ---- 8 ----

    /** Writes random well-formed documents. Seeded, so every run compares the same inputs. */
    private class Gen(seed: Long, private val seen: MutableSet<MessageFormat>) {
        private val r = Random(seed)
        private val out = ByteArrayOutputStream()

        /**
         * The top-level entries of the last document, in their order: where the key starts, where the value
         * starts, and where the entry ends.
         */
        val entries = ArrayList<IntArray>()
        private var valueStart = 0

        /** The formats written inside the values of the last document that stand under a key other than name and mtime. */
        val insideOtherValues: MutableSet<MessageFormat> = EnumSet.noneOf(MessageFormat::class.java)
        private var inOtherValue = false

        private fun be(v: Long, n: Int) {
            for (i in n - 1 downTo 0) out.write(((v ushr (8 * i)) and 0xff).toInt())
        }

        private fun head(type: Int) {
            val format = MessageFormat.valueOf(type.toByte())
            seen.add(format)
            if (inOtherValue) insideOtherValues.add(format)
            out.write(type)
        }

        /**
         * A header for [n]: two times out of three at the smallest width, otherwise at any width that
         * holds it. [fixed] is the base of the one-byte form and [t8] the type with an 8-bit field; -1
         * where the family has none.
         */
        private fun sized(n: Int, fixed: Int, fixedMax: Int, t8: Int, t16: Int, t32: Int) {
            val widths = ArrayList<Int>(4)
            if (fixed >= 0 && n <= fixedMax) widths.add(0)
            if (t8 >= 0 && n <= 0xff) widths.add(1)
            if (n <= 0xffff) widths.add(2)
            widths.add(4)
            when (if (r.nextInt(3) != 0) widths[0] else widths[r.nextInt(widths.size)]) {
                0 -> head(fixed or n)
                1 -> {
                    head(t8)
                    be(n.toLong(), 1)
                }
                2 -> {
                    head(t16)
                    be(n.toLong(), 2)
                }
                else -> {
                    head(t32)
                    be(n.toLong(), 4)
                }
            }
        }

        private fun str(b: ByteArray) {
            sized(b.size, 0xa0, 31, 0xd9, 0xda, 0xdb)
            out.write(b)
        }

        private fun bin(b: ByteArray) {
            sized(b.size, -1, 0, 0xc4, 0xc5, 0xc6)
            out.write(b)
        }

        private fun arrayHeader(n: Int) = sized(n, 0x90, 15, -1, 0xdc, 0xdd)

        private fun mapHeader(n: Int) = sized(n, 0x80, 15, -1, 0xde, 0xdf)

        private fun ext(type: Int, data: ByteArray) {
            val fixed = when (data.size) {
                1 -> 0xd4
                2 -> 0xd5
                4 -> 0xd6
                8 -> 0xd7
                16 -> 0xd8
                else -> -1
            }
            if (fixed >= 0 && r.nextInt(3) != 0) head(fixed) else sized(data.size, -1, 0, 0xc7, 0xc8, 0xc9)
            out.write(type)
            out.write(data)
        }

        /** [v] in any integer format that holds it, not only the smallest. */
        private fun int(v: Long) {
            val types = ArrayList<Int>(10)
            if (v >= 0 && v <= 0x7f) types.add(FIXINT)
            if (v >= -32 && v <= -1) types.add(FIXINT)
            if (v >= 0 && v <= 0xff) types.add(0xcc)
            if (v >= 0 && v <= 0xffff) types.add(0xcd)
            if (v >= 0 && v <= 0xffffffffL) types.add(0xce)
            if (v >= 0) types.add(0xcf)
            if (v >= -128 && v <= 127) types.add(0xd0)
            if (v >= -32768 && v <= 32767) types.add(0xd1)
            if (v >= Int.MIN_VALUE && v <= Int.MAX_VALUE) types.add(0xd2)
            types.add(0xd3)
            when (val t = types[r.nextInt(types.size)]) {
                FIXINT -> head(v.toInt() and 0xff)
                0xcc, 0xd0 -> {
                    head(t)
                    be(v, 1)
                }
                0xcd, 0xd1 -> {
                    head(t)
                    be(v, 2)
                }
                0xce, 0xd2 -> {
                    head(t)
                    be(v, 4)
                }
                else -> {
                    head(t)
                    be(v, 8)
                }
            }
        }

        /** An unsigned 64-bit value above Long.MAX_VALUE. */
        private fun aboveLong() {
            head(0xcf)
            be(r.nextLong() or Long.MIN_VALUE, 8)
        }

        private fun float32() {
            val f = if (r.nextInt(3) == 0) Float.fromBits(r.nextInt()) else FLOATS[r.nextInt(FLOATS.size)]
            head(0xca)
            be(f.toRawBits().toLong(), 4)
        }

        private fun float64() {
            val d = if (r.nextInt(3) == 0) Double.fromBits(r.nextLong()) else DOUBLES[r.nextInt(DOUBLES.size)]
            head(0xcb)
            be(d.toRawBits(), 8)
        }

        fun long(): Long = when (r.nextInt(4)) {
            0 -> LONGS[r.nextInt(LONGS.size)]
            1 -> r.nextInt(5).toLong()
            else -> r.nextLong() shr r.nextInt(64)
        }

        fun title(): String = TITLES[r.nextInt(TITLES.size)]

        /** Mostly short; sometimes around a width boundary of the length field. */
        private fun size(): Int = when (r.nextInt(2000)) {
            0 -> 65530 + r.nextInt(12)
            in 1..40 -> 250 + r.nextInt(12)
            in 41..120 -> 28 + r.nextInt(8)
            in 121..300 -> r.nextInt(400)
            else -> r.nextInt(24)
        }

        private fun bytes(n: Int) = ByteArray(n).also { r.nextBytes(it) }

        private fun ascii(n: Int) = ByteArray(n) { (0x20 + r.nextInt(0x5f)).toByte() }

        private fun text(): ByteArray = when (r.nextInt(8)) {
            0 -> VALID[r.nextInt(VALID.size)].toByteArray(Charsets.UTF_8)
            1 -> unhex(INVALID[r.nextInt(INVALID.size)])
            else -> ascii(size())
        }

        private fun count(depth: Int): Int = when (r.nextInt(40)) {
            0 -> if (depth < 2) 15 + r.nextInt(3) else 2
            in 1..10 -> 0
            else -> 1 + r.nextInt(if (depth < 2) 4 else 2)
        }

        /** One value in any of the 35 formats; containers down to three levels below the top-level map. */
        private fun value(depth: Int) {
            when (r.nextInt(if (depth >= 3) 24 else 30)) {
                0 -> head(0xc0)
                1 -> head(0xc2)
                2 -> head(0xc3)
                in 3..7 -> int(long())
                8 -> aboveLong()
                9, 10 -> float32()
                11, 12 -> float64()
                in 13..17 -> str(text())
                18, 19 -> bin(bytes(size()))
                in 20..23 -> ext(r.nextInt(256), bytes(if (r.nextInt(3) == 0) size() else EXT_SIZES[r.nextInt(EXT_SIZES.size)]))
                in 24..26 -> {
                    val n = count(depth)
                    arrayHeader(n)
                    repeat(n) { value(depth + 1) }
                }
                else -> {
                    val n = count(depth)
                    mapHeader(n)
                    repeat(n) {
                        // name and mtime inside a nested map are not the note's name and mtime
                        when (r.nextInt(10)) {
                            0 -> str(NAME)
                            1 -> str(MTIME)
                            2 -> int(r.nextInt(5).toLong())
                            3 -> value(depth + 1)
                            else -> str(ascii(r.nextInt(8)))
                        }
                        value(depth + 1)
                    }
                }
            }
        }

        /** 'name' or 'mtime' with some of its letters as overlong forms of two, three or four bytes. */
        private fun overlong(target: ByteArray): ByteArray {
            val o = ByteArrayOutputStream()
            for (b in target) {
                val c = b.toInt()
                when (r.nextInt(4)) {
                    0 -> o.write(c)
                    1 -> {
                        o.write(0xc0 or (c shr 6))
                        o.write(0x80 or (c and 0x3f))
                    }
                    2 -> {
                        o.write(0xe0)
                        o.write(0x80 or (c shr 6))
                        o.write(0x80 or (c and 0x3f))
                    }
                    else -> {
                        o.write(0xf0)
                        o.write(0x80)
                        o.write(0x80 or (c shr 6))
                        o.write(0x80 or (c and 0x3f))
                    }
                }
            }
            return o.toByteArray()
        }

        private fun nameValue() {
            when (r.nextInt(10)) {
                in 0..5 -> str(text())
                6 -> bin(ascii(r.nextInt(6)))
                7 -> int(long())
                else -> value(1)
            }
        }

        private fun mtimeValue() {
            when (r.nextInt(10)) {
                in 0..3 -> int(long())
                4 -> aboveLong()
                5 -> float32()
                6, 7 -> float64()
                8 -> str(ascii(r.nextInt(6)))
                else -> value(1)
            }
        }

        /** [v] in any unsigned integer format, which is what the typed decoder reads as a field index. */
        private fun unsignedInt(v: Int) {
            when (r.nextInt(5)) {
                0 -> head(v)
                1 -> {
                    head(0xcc)
                    be(v.toLong(), 1)
                }
                2 -> {
                    head(0xcd)
                    be(v.toLong(), 2)
                }
                3 -> {
                    head(0xce)
                    be(v.toLong(), 4)
                }
                else -> {
                    head(0xcf)
                    be(v.toLong(), 8)
                }
            }
        }

        /** A key that another client reads as [target]: binary, a field index, overlong UTF-8, or a sequence cut off at its end. */
        private fun aliasKey(target: ByteArray) {
            when (r.nextInt(4)) {
                0 -> bin(target)
                1 -> unsignedInt(if (target === NAME) 1 else 2)
                2 -> str(overlong(target))
                else -> str(target.copyOf(target.size - 1) + LEADS[r.nextInt(LEADS.size)])
            }
        }

        /** The entries for one of the two keys this app writes: none, the plain key once, twice, next to an alias, or an alias alone. */
        private fun planned(target: ByteArray, writers: MutableList<() -> Unit>) {
            // the plain key at any string width
            val plain: () -> Unit = {
                str(target)
                valueStart = out.size()
                if (target === NAME) nameValue() else mtimeValue()
            }
            val alias: () -> Unit = {
                aliasKey(target)
                valueStart = out.size()
                value(1)
            }
            when (r.nextInt(16)) {
                in 0..2 -> {}
                in 3..11 -> writers.add(plain)
                12 -> {
                    writers.add(plain)
                    writers.add(plain)
                }
                13 -> {
                    writers.add(plain)
                    writers.add(alias)
                }
                else -> writers.add(alias)
            }
        }

        /** An entry under any other key. */
        private fun other() {
            val keyStart = out.size()
            when (r.nextInt(20)) {
                // 0 to 4 in any integer format, signed or unsigned: unsigned 1 and 2 are aliases, the rest are not
                0 -> int(r.nextInt(5).toLong())
                1 -> str(unhex(NEAR[r.nextInt(NEAR.size)]))
                in 2..11 -> str(text())
                // any value as a key
                else -> value(1)
            }
            valueStart = out.size()
            // A random key can be the plain key name or mtime by chance; then its value is not one a merge copies.
            inOtherValue = valueStart - keyStart !in 5..10 || !isPlainKey(out.toByteArray(), keyStart, valueStart)
            value(1)
            inOtherValue = false
        }

        fun document(): ByteArray {
            out.reset()
            entries.clear()
            insideOtherValues.clear()
            val writers = ArrayList<() -> Unit>()
            planned(NAME, writers)
            planned(MTIME, writers)
            val others = when (r.nextInt(20)) {
                0 -> 0
                1 -> 11 + r.nextInt(6) // with name and mtime around the fixmap limit, so that an appended entry crosses it
                else -> r.nextInt(6)
            }
            repeat(others) { writers.add { other() } }
            writers.shuffle(r)
            mapHeader(writers.size)
            for (write in writers) {
                val start = out.size()
                write()
                entries.add(intArrayOf(start, valueStart, out.size()))
            }
            return out.toByteArray()
        }

        /** [doc] cut short, with one byte changed, one inserted, one removed, and one added after its end. */
        fun damaged(doc: ByteArray): List<ByteArray> {
            val list = ArrayList<ByteArray>(5)
            list.add(doc.copyOf(r.nextInt(doc.size)))
            list.add(doc.copyOf().also {
                val at = r.nextInt(it.size)
                it[at] = (it[at] + 1 + r.nextInt(255)).toByte()
            })
            val at = r.nextInt(doc.size + 1)
            list.add(doc.copyOfRange(0, at) + r.nextInt(256).toByte() + doc.copyOfRange(at, doc.size))
            val gone = r.nextInt(doc.size)
            list.add(doc.copyOfRange(0, gone) + doc.copyOfRange(gone + 1, doc.size))
            list.add(doc + r.nextInt(256).toByte())
            return list
        }

        private companion object {
            const val FIXINT = -1
            val NAME = "name".toByteArray(Charsets.UTF_8)
            val MTIME = "mtime".toByteArray(Charsets.UTF_8)
            val LEADS = byteArrayOf(0xc1.toByte(), 0xc3.toByte(), 0xe0.toByte(), 0xf0.toByte())

            // nam, names, Name, mtim, mtimes, name and a zero byte, nam and e with an acute accent
            val NEAR = listOf("6e616d", "6e616d6573", "4e616d65", "6d74696d", "6d74696d6573", "6e616d6500", "6e616dc3a9")

            // not UTF-8: a stray lead byte, 0xff, an overlong slash, an encoded surrogate, above U+10FFFF, cut off, a stray continuation byte
            val INVALID = listOf("c328", "ff", "c0af", "eda080", "f4908080", "e282", "80", "41c2")
            val VALID = listOf("", "A", "Groceries", "Eink\u00e4ufe f\u00fcr die Woche \ud83d\uded2", "\ufeffstarts with U+FEFF", "\u0000")
            val TITLES = listOf(
                "New", "", "n", "A title that is longer than thirty-one bytes for str8", "Eink\u00e4ufe f\u00fcr die Woche \ud83d\uded2",
                "A\ud800B", "\udc00", "x".repeat(31), "x".repeat(32), "x".repeat(255), "x".repeat(256),
            )
            val EXT_SIZES = intArrayOf(0, 1, 2, 3, 4, 8, 12, 16, 17)
            val LONGS = longArrayOf(
                0, 1, 2, 127, 128, 255, 256, 65535, 65536, 2147483647, 2147483648, 4294967295, 4294967296, 1758800000000, Long.MAX_VALUE,
                -1, -32, -33, -128, -129, -32768, -32769, -2147483648, -2147483649, Long.MIN_VALUE,
            )

            // around the two ends of the long range, where finiteToLong decides, and the values that are not numbers
            val DOUBLES = doubleArrayOf(
                0.0, -0.0, 1.5, -2.5, 1758800000000.5, 9.223372036854775807E18, 9.223372036854774784E18, -9.223372036854775808E18,
                -9.223372036854777856E18, 1.0E19, -1.0E19, Double.MAX_VALUE, Double.MIN_VALUE, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY,
            )
            val FLOATS = floatArrayOf(
                0f, -0f, 1.5f, -2.5f, 9.223372E18f, 9.2233715E18f, -9.223372E18f, -9.223373E18f, 1.0E19f, Float.MAX_VALUE, Float.MIN_VALUE,
                Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY,
            )
        }
    }

    /**
     * The bytes of a generated document that a merge has to copy: everything after the map header except
     * the values under the plain keys name and mtime, as runs from a first index up to an end index.
     * [entries] is what the generator recorded. Only for a document the codec merges: there each plain key
     * occurs at most once, and its value is the one that is replaced.
     */
    private fun copiedRuns(doc: ByteArray, entries: List<IntArray>): List<IntArray> {
        val runs = ArrayList<IntArray>()
        var from = if (entries.isEmpty()) doc.size else entries[0][0]
        for (entry in entries) {
            if (isPlainKey(doc, entry[0], entry[1])) {
                runs.add(intArrayOf(from, entry[1])) // up to the end of the plain key
                from = entry[2] // and on after its value
            }
        }
        runs.add(intArrayOf(from, doc.size))
        return runs.filter { it[1] > it[0] }
    }

    /**
     * Output against input. Null when every run of [doc] is in [out] byte for byte, in the order of the
     * input and without overlap, the first one directly after the map header of [out] and each later one
     * after at least one byte (the value that was replaced in front of it); else what is missing.
     *
     * Not checked here: the count in the header of [out], the replaced values, the appended entries, and
     * whatever else stands between the runs or after the last one. Those are compared between the sides
     * and pinned by the expected outputs of tests 2 and 13.
     */
    private fun firstMissingRun(doc: ByteArray, runs: List<IntArray>, out: ByteArray): String? {
        // the header of the output: a fixmap byte, or de or df with a count of two or four bytes
        var cursor = when (out[0].toInt() and 0xff) {
            0xde -> 3
            0xdf -> 5
            else -> 1
        }
        for ((i, run) in runs.withIndex()) {
            val length = run[1] - run[0]
            val found = if (i == 0) (if (regionMatches(out, cursor, doc, run[0], length)) cursor else -1) else indexOf(out, cursor + 1, doc, run[0], length)
            if (found < 0) return "bytes ${run[0]} to ${run[1]} of the input are not in the output from byte $cursor on"
            cursor = found + length
        }
        return null
    }

    private fun regionMatches(a: ByteArray, at: Int, b: ByteArray, start: Int, length: Int): Boolean {
        if (at < 0 || at + length > a.size) return false
        for (i in 0 until length) if (a[at + i] != b[start + i]) return false
        return true
    }

    private fun indexOf(hay: ByteArray, from: Int, needle: ByteArray, start: Int, length: Int): Int {
        var at = from
        while (at + length <= hay.size) {
            if (regionMatches(hay, at, needle, start, length)) return at
            at++
        }
        return -1
    }

    @Test(timeout = 300_000)
    fun `seeded random documents give the same result`() {
        val corpus = Corpus("8, seeded random documents, each also damaged in five ways")
        val seen: MutableSet<MessageFormat> = EnumSet.noneOf(MessageFormat::class.java)
        val copied: MutableSet<MessageFormat> = EnumSet.noneOf(MessageFormat::class.java)
        val results = TreeMap<String, Int>()
        val lacking = ArrayList<String>()
        var lackingTotal = 0
        var documents = 0
        var bytes = 0L
        var held = 0
        var heldRuns = 0L
        var heldBytes = 0L
        for (seed in 1L..RANDOM_SEEDS) {
            val gen = Gen(seed, seen)
            repeat(RANDOM_DOCUMENTS_FOR_EACH_SEED) { n ->
                val doc = gen.document()
                val name = gen.title()
                val mtime = gen.long()
                val mine = NoteMetaCodec.merge(doc, name, mtime)
                if (mine is Merge.NotAMap) fail("the codec refuses a generated, well-formed document (${mine.reason}): seed $seed, document $n, ${cut(doc)}")
                val peek = NoteMetaCodec.peek(doc)
                val kind = (if (mine is Merge.Refused) show(mine) else "Merged") +
                    ", peek " + (if (peek?.name != null) "with" else "without") + " a name and " + (if (peek?.mtime != null) "with" else "without") + " an mtime"
                results[kind] = (results[kind] ?: 0) + 1
                documents++
                bytes += doc.size
                compare(corpus, doc, name, mtime) { "seed $seed, document $n" }

                if (mine is Merge.Merged) {
                    copied.addAll(gen.insideOtherValues)
                    // Output against input: what the generator wrote outside the two replaced values has to be
                    // in the codec's output and in the output of each careful walk.
                    val runs = copiedRuns(doc, gen.entries)
                    held++
                    heldRuns += runs.size
                    for (run in runs) heldBytes += run[1] - run[0]
                    firstMissingRun(doc, runs, mine.bytes)?.let {
                        lackingTotal++
                        if (lacking.size < KEPT) lacking.add("seed $seed, document $n, codec: $it; input ${cut(doc)}")
                    }
                    for (walk in listOf(Walk.LEAF_SKIP, Walk.HEADERS_ONLY)) {
                        val theirs = try {
                            lib(walk).merge(doc, name, mtime)
                        } catch (t: Throwable) {
                            continue // compare has recorded it above as a line
                        }
                        // a result other than Merged is a difference, which compare has recorded above
                        if (theirs is Merge.Merged) {
                            firstMissingRun(doc, runs, theirs.bytes)?.let {
                                lackingTotal++
                                if (lacking.size < KEPT) lacking.add("seed $seed, document $n, $walk: $it; input ${cut(doc)}")
                            }
                        }
                    }
                }

                for ((j, damaged) in gen.damaged(doc).withIndex()) compare(corpus, damaged, name, mtime) { "seed $seed, document $n, damage $j" }
            }
        }
        // 35 formats and the reserved byte 0xc1, which no well-formed document contains.
        val real = EnumSet.complementOf(EnumSet.of(MessageFormat.NEVER_USED))
        assertEquals(35, real.size)
        assertEquals("the generated documents use every format", real, seen)
        assertEquals("every format occurs inside a value that the codec copied in a document it merged", real, copied)
        println("corpus 8: $documents documents from $RANDOM_SEEDS seeds, $bytes bytes together, all ${seen.size} formats, each also inside a copied value of a merged document")
        println(
            "corpus 8, output against input: $held merged documents, $heldRuns runs of $heldBytes input bytes outside the replaced values, " +
                "each looked for in the output of the codec, of LEAF_SKIP and of HEADERS_ONLY; outputs that lack a run: $lackingTotal",
        )
        for (line in lacking) println("  output lacks input bytes: $line")
        println("corpus 8, what the codec makes of the undamaged documents:")
        for ((kind, n) in results) println("  $kind: $n")
        finish(corpus, 960_000)
        assertEquals("merged documents held against their input", 86_042, held)
        assertEquals("runs held against the output", 173_443L, heldRuns)
        assertEquals("input bytes held against the output", 17_881_760L, heldBytes)
        assertTrue("$lackingTotal outputs of a merge lack bytes of the input; the first ${lacking.size}:\n" + lacking.joinToString("\n"), lackingTotal == 0)
    }

    // ---- 9 ----

    /**
     * This test asserts a defect of msgpack-core 0.9.12 on purpose. It fails when the dependency is raised
     * to a release that fixes skipValue, which is the signal to look at the comparison again.
     */
    @Test(timeout = 30_000)
    fun `the library's own skipValue accepts input that is not one map`() {
        // A map32 header that claims 2^30 entries, and nothing after it: skipValue returns as if it had skipped a whole value.
        val alone = MessagePack.newDefaultUnpacker(unhex("df40000000"))
        alone.skipValue()
        assertEquals(5L, alone.totalReadBytes)
        assertTrue(!alone.hasNext())

        // {x: that header}: 8 bytes that are not one map. Published as CVE-2026-90473. The count has to be from
        // 2^30 to 2^31 - 1; from 2^31 on skipValue throws MessageSizeException.
        for (input in listOf("81a178df40000000", "81a178df7fffffff")) {
            val raw = unhex(input)
            assertEquals(input, "NotAMap(a container count runs past the end of the input)", show(NoteMetaCodec.merge(raw, "New", 5)))
            assertNull(input, NoteMetaCodec.peek(raw))
            for (walk in listOf(Walk.LEAF_SKIP, Walk.HEADERS_ONLY)) {
                assertTrue("$walk $input", lib(walk).merge(raw, "New", 5) is Merge.NotAMap)
                assertNull("$walk $input", lib(walk).peek(raw))
            }
            // The library's own skip accepts it, and the result is not a well-formed map: the inner header
            // now claims the appended name and mtime as its entries.
            val skipped = lib(Walk.LIBRARY_SKIP).merge(raw, "New", 5)
            assertEquals(input, "Merged 83${input.substring(2)}a46e616d65a34e6577a56d74696d6505 name 'New'", show(skipped))
            assertEquals(input, Peek(null, null), lib(Walk.LIBRARY_SKIP).peek(raw))
            assertTrue(input, NoteMetaCodec.merge((skipped as Merge.Merged).bytes, "New", 5) is Merge.NotAMap)
        }
        // One below 2^30 skipValue runs out of input, as it should.
        assertTrue(lib(Walk.LIBRARY_SKIP).merge(unhex("81a178df3fffffff"), "New", 5) is Merge.NotAMap)
    }

    // ---- 10 ----

    @Test(timeout = 120_000)
    fun `the library's writers agree with the codec's at every width boundary`() {
        val packer = MessagePack.newDefaultBufferPacker()
        fun packed(write: (MessageBufferPacker) -> Unit): ByteArray {
            packer.clear()
            write(packer)
            return packer.toByteArray()
        }
        fun written(write: (ByteArrayOutputStream) -> Unit): ByteArray = ByteArrayOutputStream().also(write).toByteArray()

        // integers: the values of the codec's own table, their neighbors, the ends of the range, and seeded random ones
        val table = longArrayOf(
            0, 127, 128, 255, 256, 65535, 65536, 4294967295, 4294967296, 1758800000000,
            -1, -32, -33, -128, -129, -32768, -32769, -2147483648, -2147483649,
        )
        val longs = sortedSetOf(Long.MIN_VALUE, Long.MIN_VALUE + 1, Long.MAX_VALUE - 1, Long.MAX_VALUE)
        for (v in table) for (d in -2L..2L) longs.add(v + d)
        var integers = 0
        for (v in longs) {
            assertEquals("packLong $v", hex(written { NoteMetaCodec.writeInt(it, v) }), hex(packed { it.packLong(v) }))
            integers++
        }
        val random = Random(20261011)
        repeat(200_000) {
            val v = random.nextLong() shr random.nextInt(64)
            if (!written { NoteMetaCodec.writeInt(it, v) }.contentEquals(packed { it.packLong(v) })) fail("packLong $v differs from writeInt")
            integers++
        }

        // strings: the header for a length, as merge writes the name, and packString for text that is well-formed
        var strings = 0
        for (length in intArrayOf(0, 1, 30, 31, 32, 33, 254, 255, 256, 257, 65534, 65535, 65536, 65537)) {
            val s = "x".repeat(length)
            val mine = written { NoteMetaCodec.writeString(it, s) }
            val header = hex(mine, 0, mine.size - length)
            assertEquals("packRawStringHeader $length", header, hex(packed { it.packRawStringHeader(length) }))
            assertTrue("packString of $length chars", mine.contentEquals(packed { it.packString(s) }))
            assertTrue("packRawStringHeader and addPayload for $length bytes", mine.contentEquals(packed {
                it.packRawStringHeader(length)
                it.addPayload(s.toByteArray(Charsets.UTF_8))
            }))
            strings++
        }
        for (s in listOf("Eink\u00e4ufe f\u00fcr die Woche \ud83d\uded2", "\ufeff", "\u00e9".repeat(16), "\u00e9".repeat(128), "\ud83d\uded2".repeat(200), WRITES[3].first.repeat(30))) {
            assertTrue("packString ${quote(s)}", written { NoteMetaCodec.writeString(it, s) }.contentEquals(packed { it.packString(s) }))
            strings++
        }

        // map headers
        var maps = 0
        for (count in intArrayOf(0, 1, 14, 15, 16, 17, 65534, 65535, 65536, 65537, Int.MAX_VALUE)) {
            assertEquals("packMapHeader $count", hex(written { NoteMetaCodec.writeMapHeader(it, count.toLong()) }), hex(packed { it.packMapHeader(count) }))
            maps++
        }

        // the two defaults the notes in MsgpackCoreNoteMeta name
        assertEquals(8192, MessagePack.PackerConfig().bufferFlushThreshold)
        assertEquals(512, MessagePack.PackerConfig().smallStringOptimizationThreshold)
        println("writers: $integers integers, $strings strings, $maps map headers compared, no difference")
    }

    // ---- 11 ----

    @Test(timeout = 30_000)
    fun `packString alone writes a question mark for an unpaired surrogate`() {
        val lone = "A\ud800B"
        val packer = MessagePack.newDefaultBufferPacker()
        packer.packString(lone)
        assertEquals("a3413f42", hex(packer.toByteArray()))
        // the same above the packer's limit for short strings (512 chars), where it encodes another way
        packer.clear()
        packer.packString("x".repeat(300) + "\ud800" + "y".repeat(300))
        val longer = packer.toByteArray()
        assertEquals(604, longer.size)
        assertEquals("da0259", hex(longer, 0, 3))
        assertEquals(0x3f, longer[303].toInt())

        // The codec writes U+FFFD and returns the name as written, and so does every variant here,
        // because wellFormed stays in front of the writer.
        val mine = NoteMetaCodec.fresh(lone, 6)
        assertEquals("82a46e616d65a541efbfbd42a56d74696d6506", hex(mine.bytes))
        assertEquals("A\ufffdB", mine.name)
        for (walk in Walk.values()) {
            val theirs = lib(walk).fresh(lone, 6)
            assertEquals("$walk", hex(mine.bytes), hex(theirs.bytes))
            assertEquals("$walk", mine.name, theirs.name)
        }

        // What a writer gives that hands the raw title to packString.
        packer.clear()
        packer.packMapHeader(2).packString("name").packString(lone).packString("mtime").packLong(6)
        assertEquals("82a46e616d65a3413f42a56d74696d6506", hex(packer.toByteArray()))
    }

    // ---- 12 ----

    @Test(timeout = 30_000)
    fun `default unpacker settings read a binary value as a string and replace malformed UTF-8`() {
        val strict = MsgpackCoreNoteMeta.STRICT
        // a binary value, bin8 'A'
        assertEquals("A", MessagePack.newDefaultUnpacker(unhex("c40141")).unpackString())
        assertThrows(MessageTypeException::class.java) { strict.newUnpacker(unhex("c40141")).unpackString() }
        // malformed UTF-8, c3 28
        assertEquals("\ufffd(", MessagePack.newDefaultUnpacker(unhex("a2c328")).unpackString())
        assertThrows(MessageStringCodingException::class.java) { strict.newUnpacker(unhex("a2c328")).unpackString() }
        // a binary key read through the string header read
        assertEquals(4, MessagePack.newDefaultUnpacker(unhex("c4046e616d65")).unpackRawStringHeader())
        assertThrows(MessageTypeException::class.java) { strict.newUnpacker(unhex("c4046e616d65")).unpackRawStringHeader() }
        // The binary header read takes a fixstr byte on any settings, so what a key is has to come from getNextFormat.
        assertEquals(4, strict.newUnpacker(unhex("a46e616d65")).unpackBinaryHeader())
        assertThrows(MessageTypeException::class.java) { strict.newUnpacker(unhex("d9046e616d65")).unpackBinaryHeader() }
        // On strict settings unpackString reads valid text as the codec's decoder does.
        assertEquals(
            "Eink\u00e4ufe f\u00fcr die Woche \ud83d\uded2",
            strict.newUnpacker(unhex("bd45696e6bc3a47566652066c3bc722064696520576f63686520f09f9b92")).unpackString(),
        )
        assertEquals(8192, MessagePack.UnpackerConfig().stringDecoderBufferSize)

        // What the codec and every variant here make of the two values as a name.
        for (input in listOf("81a46e616d65c40141", "81a46e616d65a2c328")) {
            assertEquals(input, Peek(null, null), NoteMetaCodec.peek(unhex(input)))
            for (walk in Walk.values()) assertEquals("$walk $input", Peek(null, null), lib(walk).peek(unhex(input)))
        }
        // And of the binary key: an alias of name on every side.
        val binaryKey = unhex("82c4046e616d65a34f6c64a56d74696d6505")
        assertEquals(Merge.Refused("name", Why.ALIASED), NoteMetaCodec.merge(binaryKey, "New", 5))
        for (walk in Walk.values()) assertEquals("$walk", Merge.Refused("name", Why.ALIASED), lib(walk).merge(binaryKey, "New", 5))
    }

    // ---- 13 ----

    @Test(timeout = 30_000)
    fun `unpackLong refuses an unsigned 64-bit value above the largest long, and the careful walks still copy it`() {
        val u = MessagePack.newDefaultUnpacker(unhex("cfffffffffffffffff01"))
        assertThrows(MessageIntegerOverflowException::class.java) { u.unpackLong() }
        // It throws after it has consumed the nine bytes; the walks rely on that where such a value is a key.
        assertEquals(9L, u.totalReadBytes)
        assertEquals(1L, u.unpackLong())
        assertEquals(BigInteger("18446744073709551615"), MessagePack.newDefaultUnpacker(unhex("cfffffffffffffffff")).unpackBigInteger())

        // as a value, as a key, and as a key next to name and mtime
        val expected = mapOf(
            "81a178cfffffffffffffffff" to "83a178cfffffffffffffffffa46e616d65a34e6577a56d74696d6505",
            "81cfffffffffffffffff01" to "83cfffffffffffffffff01a46e616d65a34e6577a56d74696d6505",
            "83a46e616d65a141cfffffffffffffffff01a56d74696d6501" to "83a46e616d65a34e6577cfffffffffffffffff01a56d74696d6505",
        )
        for ((input, output) in expected) {
            assertEquals(input, output, hex((NoteMetaCodec.merge(unhex(input), "New", 5) as Merge.Merged).bytes))
            for (walk in Walk.values()) assertEquals("$walk $input", output, hex((lib(walk).merge(unhex(input), "New", 5) as Merge.Merged).bytes))
        }
        // as mtime it is not a usable number on either side, and the rest of the map is still read
        val asMtime = unhex("82a46e616d65a141a56d74696d65cfffffffffffffffff")
        assertEquals(Peek("A", null), NoteMetaCodec.peek(asMtime))
        for (walk in Walk.values()) assertEquals("$walk", Peek("A", null), lib(walk).peek(asMtime))
        // a signed key 1 is not the typed decoder's field 1
        val signedKey = unhex("82d001a141a56d74696d6501")
        for (walk in Walk.values()) {
            assertEquals("$walk", "83d001a141a56d74696d6505a46e616d65a34e6577", hex((lib(walk).merge(signedKey, "New", 5) as Merge.Merged).bytes))
        }
    }

    // ---- 14 ----

    /**
     * The comparison turned on itself. On the corpora the two careful walks never differ from the codec,
     * so nothing there shows that a difference would be reported. Here the function that decides is given
     * hand-made results, each kind of difference once, and the function that sorts a difference and the
     * checks at the end of a corpus are given hand-made cases too.
     */
    @Test(timeout = 30_000)
    fun `the comparison reports each kind of difference`() {
        val b = unhex("81a46e616d65a16e")
        val merged = Merge.Merged(b, "n")
        val refused = Merge.Refused("name", Why.ALIASED)
        val peek = Peek("n", 1)
        fun d(mine: Merge, theirs: Merge, theirPeek: Peek? = peek, walk: Walk = Walk.LEAF_SKIP) = difference(walk, b, "n", 1, mine, peek, theirs, theirPeek)

        // The same result gives no line.
        assertNull(d(merged, Merge.Merged(b.copyOf(), "n")))
        assertNull(d(refused, Merge.Refused("name", Why.ALIASED)))
        // NotAMap on both sides for reasons of one kind is the same result, under every walk.
        for (walk in Walk.values()) {
            for ((codec, library) in listOf(
                COUNT_PAST_END to COUNT_PAST_END,
                COUNT_PAST_END to "MessageSizeException",
                LENGTH_PAST_END to "MessageSizeException",
                LENGTH_PAST_END to "MessageInsufficientBufferException",
                "trailing bytes after the map" to "trailing bytes after the map",
            )) {
                assertNull("$walk $codec / $library", d(Merge.NotAMap(codec), Merge.NotAMap(library), walk = walk))
            }
        }
        // For reasons of two kinds it is a difference under the careful walks. LIBRARY_SKIP is held to the kind
        // as well, except where the codec's reason is the count message, and it has its own exception for 0xc1.
        for ((codec, library, underLibrarySkip) in listOf(
            Triple(COUNT_PAST_END, "MessageInsufficientBufferException", false),
            Triple(COUNT_PAST_END, LENGTH_PAST_END, false),
            Triple(COUNT_PAST_END, "trailing bytes after the map", false),
            Triple(RESERVED_BYTE, "MessageNeverUsedFormatException", false),
            Triple(RESERVED_BYTE, "MessageSizeException", true),
            Triple(LENGTH_PAST_END, COUNT_PAST_END, true),
            Triple("the top level is not a map", "MessageSizeException", true),
            Triple("the top level is not a map", "MessageInsufficientBufferException", true),
            Triple("trailing bytes after the map", "MessageInsufficientBufferException", true),
            Triple("trailing bytes after the map", "IndexOutOfBoundsException", true),
        )) {
            for (walk in listOf(Walk.LEAF_SKIP, Walk.HEADERS_ONLY)) {
                assertNotNull("$walk $codec / $library", d(Merge.NotAMap(codec), Merge.NotAMap(library), walk = walk))
            }
            val skipped = d(Merge.NotAMap(codec), Merge.NotAMap(library), walk = Walk.LIBRARY_SKIP)
            if (underLibrarySkip) assertNotNull("LIBRARY_SKIP $codec / $library", skipped) else assertNull("LIBRARY_SKIP $codec / $library", skipped)
        }
        // Under the careful walks the reserved byte has to be refused by the walk itself, under LIBRARY_SKIP by skipValue.
        assertNull(d(Merge.NotAMap(RESERVED_BYTE), Merge.NotAMap(RESERVED_BYTE)))
        assertNotNull(d(Merge.NotAMap(RESERVED_BYTE), Merge.NotAMap(RESERVED_BYTE), walk = Walk.LIBRARY_SKIP))

        // Each kind of difference gives a line, under every walk: other bytes, fewer bytes, more bytes, another
        // name, another kind of result, another Refused, another peek.
        val lastByteChanged = b.copyOf().also { it[it.size - 1] = 0x6f }
        for (walk in Walk.values()) {
            for (theirs in listOf(
                Merge.Merged(lastByteChanged, "n"), Merge.Merged(b.copyOf(b.size - 1), "n"), Merge.Merged(b + 0.toByte(), "n"), Merge.Merged(b, "o"),
                refused, Merge.NotAMap("x"),
            )) {
                assertNotNull("$walk Merged against ${show(theirs)}", d(merged, theirs, walk = walk))
            }
            for (theirs in listOf(Merge.Refused("mtime", Why.ALIASED), Merge.Refused("name", Why.REPEATED), merged, Merge.NotAMap("x"))) {
                assertNotNull("$walk Refused against ${show(theirs)}", d(refused, theirs, walk = walk))
            }
            for (theirs in listOf(merged, refused)) {
                assertNotNull("$walk NotAMap against ${show(theirs)}", d(Merge.NotAMap("x"), theirs, walk = walk))
            }
            for (theirPeek in listOf(null, Peek("o", 1), Peek(null, 1), Peek("n", 2), Peek("n", null))) {
                assertNotNull("$walk peek ${show(theirPeek)}", d(merged, Merge.Merged(b, "n"), theirPeek, walk))
            }
        }
        // The line names the input and both results.
        assertEquals(
            "merge differs on 81a46e616d65a16e with name 'n' and mtime 1: codec Merged 81a46e616d65a16e name 'n', library NotAMap(x)",
            d(merged, Merge.NotAMap("x")),
        )
        assertEquals("peek differs on 81a46e616d65a16e: codec Peek('n', 1), library Peek('n', 2)", d(merged, Merge.Merged(b, "n"), Peek("n", 2)))

        // Where a difference is put.
        val sorted = Corpus("hand-made")
        record(sorted, Walk.LEAF_SKIP, b, merged, Merge.NotAMap("x"), "line 1")
        record(sorted, Walk.HEADERS_ONLY, b, Merge.NotAMap("x"), merged, "line 2")
        assertEquals(1L, sorted.carefulTotal[Walk.LEAF_SKIP.ordinal])
        assertEquals(1L, sorted.carefulTotal[Walk.HEADERS_ONLY.ordinal])
        assertEquals(listOf("LEAF_SKIP line 1", "HEADERS_ONLY line 2"), sorted.careful)
        record(sorted, Walk.LIBRARY_SKIP, b, merged, refused, "line 3")
        record(sorted, Walk.LIBRARY_SKIP, b, refused, Merge.NotAMap("x"), "line 4")
        assertEquals(2L, sorted.skipWhereAcceptedTotal)
        assertEquals(listOf("line 3", "line 4"), sorted.skipWhereAccepted)
        val withThePattern = unhex("81a178df40000000")
        record(sorted, Walk.LIBRARY_SKIP, withThePattern, Merge.NotAMap(COUNT_PAST_END), merged, "line 5")
        assertEquals(1L, sorted.skipAcceptsTotal)
        assertEquals(0L, sorted.skipAcceptsOtherTotal)
        assertEquals(listOf("line 5"), sorted.skipAccepts)
        // A hand-made case, not a result of the library: an input the codec refuses, recorded here as if
        // LIBRARY_SKIP had accepted it, without the published pattern. It is counted and kept by its length,
        // and neither its line nor its bytes are printed.
        val noPattern = unhex("81a178a5616263") // {x: a fixstr that promises five bytes and has three}
        record(sorted, Walk.LIBRARY_SKIP, noPattern, Merge.NotAMap(LENGTH_PAST_END), merged, "line 6 on ${hex(noPattern)}")
        assertEquals(2L, sorted.skipAcceptsTotal)
        assertEquals(1L, sorted.skipAcceptsOtherTotal)
        assertEquals(listOf("line 5"), sorted.skipAccepts)
        assertEquals(listOf("an input of 7 bytes"), sorted.skipAcceptsOther)
        assertTrue(!sorted.summary().contains("line 6") && !sorted.summary().contains(hex(noPattern)))
        assertTrue(sorted.summary().contains("an input of 7 bytes"))
        // Both sides refuse, for reasons of two kinds where LIBRARY_SKIP is held to the kind: that is not an
        // accept. It has a count of its own, and its bytes are kept only if it has the pattern.
        val twoKinds = Merge.NotAMap("MessageInsufficientBufferException")
        record(sorted, Walk.LIBRARY_SKIP, noPattern, Merge.NotAMap("trailing bytes after the map"), twoKinds, "line 7 on ${hex(noPattern)}")
        record(sorted, Walk.LIBRARY_SKIP, withThePattern, Merge.NotAMap("trailing bytes after the map"), twoKinds, "line 8")
        assertEquals(2L, sorted.skipOtherRefusalTotal)
        assertEquals(2L, sorted.skipAcceptsTotal)
        assertEquals(
            listOf("an input of 7 bytes: codec NotAMap(trailing bytes after the map), library NotAMap(MessageInsufficientBufferException)", "line 8"),
            sorted.skipOtherRefusal,
        )
        assertTrue(!sorted.summary().contains("line 7") && !sorted.summary().contains(hex(noPattern)))

        // The pattern itself: the byte df followed by a byte from 40 to 7f, anywhere in the input.
        assertTrue(hasBigMap32(unhex("df40")) && hasBigMap32(unhex("00df7f")))
        assertTrue(!hasBigMap32(unhex("df3f")) && !hasBigMap32(unhex("df80")) && !hasBigMap32(unhex("40df")) && !hasBigMap32(unhex("df")) && !hasBigMap32(null))

        // Output against input, on {name: 'A', x: 1} with the two entries as the generator records them: what
        // has to be copied is the key name and the entry x: 1, and the value 'A' is the one that is replaced.
        val doc = unhex("82a46e616d65a141a17801")
        assertTrue(isPlainKey(doc, 1, 6) && isPlainKey(unhex("d9046e616d65"), 0, 6) && isPlainKey(unhex("db000000056d74696d65"), 0, 10))
        assertTrue(!isPlainKey(doc, 8, 10) && !isPlainKey(unhex("a46e616d66"), 0, 5) && !isPlainKey(unhex("c4046e616d65"), 0, 6))
        val runs = copiedRuns(doc, listOf(intArrayOf(1, 6, 8), intArrayOf(8, 10, 11)))
        assertEquals(listOf(listOf(1, 6), listOf(8, 11)), runs.map { it.toList() })
        assertNull(firstMissingRun(doc, runs, unhex("83a46e616d65a34e6577a17801a56d74696d6505")))
        for (output in listOf(
            "83a46e616d65a34e6577a17802a56d74696d6505", // a copied byte changed
            "83a46e616d65a34e6577a178a56d74696d6505", // a copied byte dropped
            "8300a46e616d65a34e6577a17801a56d74696d6505", // a byte between the header and the first copied run
            "83a17801a46e616d65a34e6577a56d74696d6505", // the entries in another order (fails at the first run)
            "83a46e616d65a17801a56d74696d6505", // no value where the replaced one was
        )) {
            assertNotNull(output, firstMissingRun(doc, runs, unhex(output)))
        }
        // Three runs, on {name: 'A', x: 1, mtime: 1, y: 2}: the order of the later runs, and a later run that is missing.
        val doc3 = unhex("84a46e616d65a141a17801a56d74696d6501a17902")
        val runs3 = copiedRuns(doc3, listOf(intArrayOf(1, 6, 8), intArrayOf(8, 10, 11), intArrayOf(11, 17, 18), intArrayOf(18, 20, 21)))
        assertEquals(listOf(listOf(1, 6), listOf(8, 17), listOf(18, 21)), runs3.map { it.toList() })
        assertNull(firstMissingRun(doc3, runs3, unhex("84a46e616d65a34e6577a17801a56d74696d6505a17902")))
        assertNotNull("the two later runs in the other order", firstMissingRun(doc3, runs3, unhex("84a46e616d65a34e6577a17902a17801a56d74696d6505")))
        assertNotNull("the last run dropped", firstMissingRun(doc3, runs3, unhex("84a46e616d65a34e6577a17801a56d74696d6505")))

        // What a corpus has to satisfy.
        fun filled(change: (Corpus) -> Unit) = Corpus("hand-made").also {
            it.inputs = 3
            change(it)
        }
        verify(filled { }, 3)
        // Accepts with the map32 pattern, and the third exception where LIBRARY_SKIP meets 0xc1, do not fail a corpus.
        verify(
            filled {
                it.skipAcceptsTotal = 5
                it.libraryReasons[Walk.LIBRARY_SKIP.ordinal].add("MessageNeverUsedFormatException")
            },
            3,
        )
        val wrong = listOf<(Corpus) -> Unit>(
            { it.inputs = 0 },
            { it.inputs = 2 },
            { it.thrownTotal = 1 },
            { it.carefulTotal[Walk.LEAF_SKIP.ordinal] = 1 },
            { it.carefulTotal[Walk.HEADERS_ONLY.ordinal] = 1 },
            { it.skipWhereAcceptedTotal = 1 },
            { it.skipAcceptsOtherTotal = 1 },
            { it.skipOtherRefusalTotal = 1 },
            { it.libraryReasons[Walk.LEAF_SKIP.ordinal].add("IndexOutOfBoundsException") },
            { it.libraryReasons[Walk.HEADERS_ONLY.ordinal].add("MessageNeverUsedFormatException") },
            { it.libraryReasons[Walk.LIBRARY_SKIP.ordinal].add("IllegalStateException") },
        )
        for ((i, change) in wrong.withIndex()) {
            try {
                verify(filled(change), 3)
            } catch (expected: AssertionError) {
                continue
            }
            fail("a corpus with hand-made defect $i passes")
        }
    }

    // ---- 15 ----

    /**
     * HEADERS_ONLY, the form the public result calls (c), is the class NoteMetaMsgpack in a file of its
     * own, so that what it calls of the library can be checked by reading that one file. This holds the
     * file to it, and the comparison to the file.
     *
     * The file is read as text and its head comment, the first block comment, is set aside; that
     * comment lists the calls the file never makes and has to name skipValue. What is checked:
     * - The rest of the file, code and comments alike, contains none of these names anywhere: skipValue;
     *   unpackValue and packValue, the value model; unpackString; readPayloadAsReference; and the name
     *   of the class that holds the two forms that do call skipValue, so that the file cannot reach one
     *   of these calls through that class.
     * - The rest of the file contains the name readPayload once, in its three-argument form: the read
     *   into the scratch array.
     * - The class behind HEADERS_ONLY in this comparison is NoteMetaMsgpack itself, not a subclass.
     *
     * What no check of one file's text can see: a declaration in another file of the same package,
     * which the file could use without an import; and a name put together at run time.
     */
    @Test(timeout = 30_000)
    fun `the file of the form without skipValue names none of the calls it says it never makes`() {
        val source = File("src/main/java/io/silentsuite/sync/notes/edit/NoteMetaMsgpack.kt").readText()
        val open = source.indexOf("/*")
        val close = source.indexOf("*/", open)
        assertTrue("NoteMetaMsgpack.kt has a head comment", open >= 0 && close > open)
        val header = source.substring(open, close + 2)
        val code = source.removeRange(open, close + 2)
        // The line of the file for a position in the text without the head comment.
        fun line(at: Int) = source.take(if (at < open) at else at + header.length).count { it == '\n' } + 1
        // The list of the calls never made is in the part that is set aside, and the file is the one that is meant.
        assertTrue("the head comment of NoteMetaMsgpack.kt names skipValue", header.contains("skipValue"))
        assertTrue("the file declares the class", code.contains("internal open class NoteMetaMsgpack"))
        for (name in listOf("skipValue", "unpackValue", "packValue", "unpackString", "readPayloadAsReference", "MsgpackCoreNoteMeta")) {
            val at = code.indexOf(name)
            if (at >= 0) fail("NoteMetaMsgpack.kt names $name outside its head comment, in line ${line(at)}")
        }
        val reads = Regex("readPayload").findAll(code).map { line(it.range.first) }.toList()
        assertEquals("NoteMetaMsgpack.kt names readPayload outside its head comment in lines $reads; the number of them", 1, reads.size)
        assertTrue(
            "the one readPayload of NoteMetaMsgpack.kt, in line ${reads[0]}, is the read into the scratch array",
            code.contains("u.readPayload(scratch, 0, n)"),
        )
        assertEquals("HEADERS_ONLY is NoteMetaMsgpack itself, not a subclass", NoteMetaMsgpack::class.java, lib(Walk.HEADERS_ONLY).form.javaClass)
    }

    companion object {
        /** How many lines of one kind a corpus keeps for its message; the totals are always complete. */
        private const val KEPT = 50
        private const val KEPT_ACCEPTS = 1000

        private const val COUNT_PAST_END = "a container count runs past the end of the input"
        private const val LENGTH_PAST_END = "a length runs past the end of the input"
        private const val RESERVED_BYTE = "reserved type 0xc1"

        /** The reasons a library side may give for NotAMap: the walk's own checks, and the two exceptions of the library's reads. */
        private val REFUSALS = setOf(
            "empty",
            "the top level is not a map",
            COUNT_PAST_END,
            LENGTH_PAST_END,
            "reserved type 0xc1",
            "trailing bytes after the map",
            "MessageInsufficientBufferException",
            "MessageSizeException",
        )

        /**
         * Only test 1 would notice that the tests run on the library's other buffer class, so the setting is
         * required of every run.
         */
        @BeforeClass
        @JvmStatic
        fun requireTheUniversalBuffer() {
            assertEquals(
                "run these tests through Gradle: android/app/build.gradle sets msgpack.universal-buffer=true for unit tests",
                "true",
                System.getProperty("msgpack.universal-buffer"),
            )
        }

        private const val EVERY_PREFIX_UP_TO = 4096
        private const val RANDOM_SEEDS = 64L
        private const val RANDOM_DOCUMENTS_FOR_EACH_SEED = 2500

        /** Names and mtimes to write: the widths of the name, text outside ASCII, an unpaired surrogate, the ends of the long range. */
        private val WRITES: List<Pair<String, Long>> = listOf(
            "New" to 5L,
            "" to 0L,
            "A title that is longer than thirty-one bytes for str8" to 1758800000000L,
            "Eink\u00e4ufe f\u00fcr die Woche \ud83d\uded2" to -1L,
            "A\ud800B" to Long.MIN_VALUE,
            "x".repeat(300) to Long.MAX_VALUE,
            "\ufeff" + "y".repeat(70_000) to 4294967296L,
        )

        /** Both sides NotAMap: the codec's reason, the library side's reason, and the count for each walk. */
        private val reasons = HashMap<String, HashMap<String, LongArray>>()

        private fun countReasons(walk: Walk, codec: String, library: String) {
            synchronized(reasons) {
                reasons.getOrPut(codec) { HashMap() }.getOrPut(library) { LongArray(Walk.values().size) }[walk.ordinal]++
            }
        }

        @AfterClass
        @JvmStatic
        fun printReasons() {
            synchronized(reasons) {
                println("Both sides NotAMap, by reason. codec reason / library-side reason: comparisons under LIBRARY_SKIP, LEAF_SKIP, HEADERS_ONLY")
                for (codec in reasons.keys.sorted()) {
                    val byLibrary = reasons.getValue(codec)
                    for (library in byLibrary.keys.sorted()) {
                        val n = byLibrary.getValue(library)
                        println("  $codec / $library: ${n[Walk.LIBRARY_SKIP.ordinal]}, ${n[Walk.LEAF_SKIP.ordinal]}, ${n[Walk.HEADERS_ONLY.ordinal]}")
                    }
                }
            }
        }
    }
}
