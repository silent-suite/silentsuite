package io.silentsuite.sync.notes

import android.util.Log
import com.etebase.client.Collection
import com.etebase.client.CollectionManager
import com.etebase.client.exceptions.EtebaseException
import io.silentsuite.sync.Constants

/**
 * Issue 974, characterization only: what the binding's typed `Collection.meta` does to collection
 * metadata entries it does not know, when a collection is saved the way EditCollectionFragment's Save
 * does it (read the typed metadata, set name, description, mtime and, except for address books,
 * color, write it back). It fixes nothing and changes no production code.
 *
 * Every collection is made from raw bytes with `create_raw` and never uploaded. The raw bytes are
 * read back with `Collection.metaRaw` and decoded with the test's own [TestMsgPack], never with the
 * code under test. Item metadata is not used anywhere here: [NoteMetaBindingComparison] covers items,
 * and nothing in this file assumes that a collection behaves like an item.
 *
 * Each case pins, in this order:
 * - RAW_INTACT: the raw metadata comes back as it was set (otherwise the case stops);
 * - READ_PINNED: the typed read gives the five pinned fields;
 * - READ_DOES_NOT_WRITE: a typed read leaves the raw metadata as it was;
 * - SAVE_ONE_MAP, SAVE_KEYS: the typed output is one map with exactly the pinned keys, in order;
 * - UNKNOWN_DROPPED: no entry outside the five typed fields is left in the typed output. This is the
 *   issue's claim, pinned as the expected outcome. A case that fails here does not reproduce it;
 * - SAVE_VALUES, REREAD_TYPED: the typed output holds what Save set, by the raw bytes and by a typed read.
 * The key order and every pin above are expectations drawn from source reading; this file is how they
 * are checked, on a device.
 */
internal object CollectionMetaRoundTripProbe {
    private const val TAG = "CollectionMetaProbe"

    private const val T0 = 1758800000000L

    /** What every Save here writes. The name has a three-byte character and nothing above U+FFFF. */
    private const val NEW_NAME = "Renamed ✓"
    private const val NEW_DESCRIPTION = "Edited on Android"
    private const val NEW_MTIME = 1758900000123L

    /** The color int Save reads off the color square; [NEW_COLOR] is what Save's own expression makes of it. */
    private val COLOR_INT: Int = 0xFF3366CC.toInt()
    private val NEW_COLOR: String = String.format("#%06X", 0xFFFFFF and COLOR_INT)

    /** A name with U+1F5D3 (UTF-8 f0 9f 97 93), as another client could have stored it. Read only in this stage. */
    private const val EMOJI_NAME = "Familie 🗓"

    private val KNOWN = setOf("type", "name", "mtime", "description", "color")
    private val SAVE_KEYS = listOf("name", "mtime", "description", "color")

    /** The control's input, by hand, so a change in [TestMsgPack] cannot change the fixtures unseen. */
    private const val KNOWN_ONLY_HEX =
        "84a46e616d65a4576f726ba56d74696d65cf0000019980a63400ab6465736372697074696f6ea6536861726564a5636f6c6f72a723414142424343"

    data class Read(val name: String?, val mtime: Long?, val type: String?, val description: String?, val color: String?)

    class Report(val compared: Int, val uids: List<String>, val differences: List<String>) {
        fun text(): String = differences.joinToString("\n")
    }

    private class Case(
        val id: String,
        val collectionType: String,
        val input: LinkedHashMap<String, Any?>,
        val read: Read,
        /** The color the typed output must hold: Save's for calendars, task lists and notebooks, the input's for address books. */
        val color: String?,
        /** The name Save writes. */
        val newName: String = NEW_NAME,
    ) {
        val raw: ByteArray = TestMsgPack.encode(input)
        val foreign: List<String> = input.keys.filter { it !in KNOWN }
        val expected = Read(newName, NEW_MTIME, read.type, NEW_DESCRIPTION, color)
    }

    private fun map(vararg entries: Pair<String, Any?>) = linkedMapOf(*entries)

    private val CASES: List<Case> = listOf(
        Case("calendarForeign", Constants.ETEBASE_TYPE_CALENDAR,
            map("name" to "Work", "mtime" to T0, "description" to "Shared", "color" to "#AABBCC",
                "x-foreign-flag" to true, "x-foreign-order" to 3L, "x-foreign-nested" to map("k" to "v")),
            Read("Work", T0, null, "Shared", "#AABBCC"), NEW_COLOR),
        Case("tasksForeign", Constants.ETEBASE_TYPE_TASKS,
            map("name" to "Chores", "mtime" to T0, "color" to "#010203", "x-foreign" to "keep-me"),
            Read("Chores", T0, null, null, "#010203"), NEW_COLOR),
        Case("notebookForeign", Constants.ETEBASE_TYPE_NOTES,
            map("name" to "Plans", "mtime" to T0, "x-foreign" to "keep-me"),
            Read("Plans", T0, null, null, null), NEW_COLOR),
        // Save sets no color on an address book, so the color read from the input is written back.
        Case("addressBookForeign", Constants.ETEBASE_TYPE_ADDRESS_BOOK,
            map("name" to "Family", "mtime" to T0, "color" to "#112233", "x-foreign" to "keep-me"),
            Read("Family", T0, null, null, "#112233"), "#112233"),
        // Control: nothing unknown, so nothing may be missing and nothing may be added.
        Case("calendarKnownOnly", Constants.ETEBASE_TYPE_CALENDAR,
            map("name" to "Work", "mtime" to T0, "description" to "Shared", "color" to "#AABBCC"),
            Read("Work", T0, null, "Shared", "#AABBCC"), NEW_COLOR),
        // A name above U+FFFF, read through the typed getter only; Save then writes an ASCII-and-BMP name.
        Case("calendarEmojiNameRead", Constants.ETEBASE_TYPE_CALENDAR,
            map("name" to EMOJI_NAME, "mtime" to T0, "x-foreign" to "keep-me"),
            Read(EMOJI_NAME, T0, null, null, null), NEW_COLOR),
    )

    val CASE_COUNT: Int get() = CASES.size

    /** EditCollectionFragment.saveCollection, lines 530-563, with the screen's values fixed. */
    private fun saveAsEditCollectionDoes(col: Collection, collectionType: String, name: String) {
        val meta = col.meta
        meta.name = name
        meta.description = NEW_DESCRIPTION
        meta.mtime = NEW_MTIME
        when (collectionType) {
            Constants.ETEBASE_TYPE_CALENDAR, Constants.ETEBASE_TYPE_TASKS, Constants.ETEBASE_TYPE_NOTES ->
                meta.color = String.format("#%06X", 0xFFFFFF and COLOR_INT)
            Constants.ETEBASE_TYPE_ADDRESS_BOOK -> {
            }
        }
        col.meta = meta
    }

    private fun typed(col: Collection): Read = col.meta.let { Read(it.name, it.mtime, it.itemType, it.description, it.color) }

    /** Runs every case on its own never-uploaded collection of [colMgr]. The caller checks that nothing was sent. */
    fun run(colMgr: CollectionManager): Report {
        val uids = ArrayList<String>()
        val differences = ArrayList<String>()
        var compared = 0
        for (case in CASES) {
            Log.i(TAG, "case ${case.id}: ${case.raw.size} bytes")
            val col = colMgr.create_raw(case.collectionType, case.raw, ByteArray(0))
            uids += col.uid
            differences += caseDifferences(case, col)
            compared++
        }
        Log.i(TAG, "done: $compared cases, ${differences.size} differences")
        return Report(compared, uids, differences)
    }

    private fun caseDifferences(case: Case, col: Collection): List<String> {
        val out = ArrayList<String>()
        fun say(what: String) {
            out += "${case.id}: $what"
        }
        val before = col.metaRaw
        if (!before.contentEquals(case.raw)) {
            say("RAW_INTACT: the raw metadata came back as ${hex(before)}, not as set")
            return out
        }
        val read = try {
            typed(col)
        } catch (e: EtebaseException) {
            say("READ_PINNED: the typed read was refused: ${e.javaClass.simpleName}")
            return out
        }
        if (read != case.read) say("READ_PINNED: the typed read gave $read where ${case.read} is pinned")
        if (!col.metaRaw.contentEquals(case.raw)) say("READ_DOES_NOT_WRITE: a typed read changed the raw metadata")
        Log.i(TAG, "save ${case.id}")
        saveAsEditCollectionDoes(col, case.collectionType, case.newName)
        out += saveDifferences(case, col.metaRaw, typed(col))
        return out
    }

    /** What is wrong with the typed output [after] of [case] and its typed reread [reread], or nothing. No binding call. */
    private fun saveDifferences(case: Case, after: ByteArray, reread: Read): List<String> {
        val out = ArrayList<String>()
        fun say(what: String) {
            out += "${case.id}: $what"
        }
        val decoded = try {
            TestMsgPack.decode(after) as? Map<*, *>
        } catch (e: RuntimeException) {
            null
        }
        if (decoded == null) {
            say("SAVE_ONE_MAP: the typed output is not one map: ${hex(after)}")
            return out
        }
        val keys = decoded.keys.map { it.toString() }
        if (keys != SAVE_KEYS) say("SAVE_KEYS: the typed output has the keys $keys where $SAVE_KEYS are pinned")
        val kept = case.foreign.filter { it in keys }
        if (kept.isNotEmpty()) say("UNKNOWN_DROPPED: the typed output kept $kept, so the issue's claim is not reproduced here")
        val values = Read(decoded["name"] as? String, decoded["mtime"] as? Long, decoded["type"] as? String,
            decoded["description"] as? String, decoded["color"] as? String)
        if (values != case.expected) say("SAVE_VALUES: the typed output holds $values where ${case.expected} is pinned")
        if (reread != case.expected) say("REREAD_TYPED: the typed reread gave $reread where ${case.expected} is pinned")
        return out
    }

    private fun hex(b: ByteArray, limit: Int = 48): String =
        b.take(limit).joinToString("") { "%02x".format(it.toInt() and 0xff) } + if (b.size > limit) "..." else ""

    private fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

    /** Shows, with no binding call, that the fixtures are what they say and that each kind of difference is reported. */
    fun selfCheck() {
        fun expect(holds: Boolean, what: String) {
            if (!holds) throw AssertionError("the collection probe's own check failed: $what")
        }
        val control = CASES.single { it.id == "calendarKnownOnly" }
        expect(control.raw.contentEquals(unhex(KNOWN_ONLY_HEX)), "the control's input is the pinned bytes, and is ${hex(control.raw, 80)}")
        expect(control.foreign.isEmpty(), "the control has no unknown entry")
        expect(CASES.count { it.foreign.isNotEmpty() } == 5, "five cases carry unknown entries")
        expect(CASES.map { it.id }.toSet().size == CASES.size, "no case id is repeated")
        expect(NEW_COLOR == "#3366CC", "Save's color expression gives #3366CC, and gave $NEW_COLOR")
        val emoji = CASES.single { it.id == "calendarEmojiNameRead" }.raw
        expect(hex(emoji, 80).contains("f09f9793"), "the emoji case holds U+1F5D3 as four-byte UTF-8")

        val case = CASES.single { it.id == "calendarForeign" }
        val good = map("name" to NEW_NAME, "mtime" to NEW_MTIME, "description" to NEW_DESCRIPTION, "color" to NEW_COLOR)
        fun diff(output: ByteArray, reread: Read = case.expected) = saveDifferences(case, output, reread)
        fun names(d: List<String>) = d.map { it.substringAfter(": ").substringBefore(':') }.toSet()
        expect(diff(TestMsgPack.encode(good)).isEmpty(), "the expected output gives no difference")
        val keptOne = LinkedHashMap(good).apply { put("x-foreign-flag", true) }
        expect(names(diff(TestMsgPack.encode(keptOne))) == setOf("SAVE_KEYS", "UNKNOWN_DROPPED"), "a kept unknown entry is reported")
        val noColor = LinkedHashMap(good).apply { remove("color") }
        expect(names(diff(TestMsgPack.encode(noColor))) == setOf("SAVE_KEYS", "SAVE_VALUES"), "a lost known field is reported")
        expect(names(diff(byteArrayOf(0xc0.toByte()))) == setOf("SAVE_ONE_MAP"), "an output that is not a map is reported")
        expect(names(diff(TestMsgPack.encode(good), case.expected.copy(mtime = 1))) == setOf("REREAD_TYPED"), "a wrong reread is reported")
    }
}
