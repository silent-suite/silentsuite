package io.silentsuite.sync.notes

import android.util.Log
import com.etebase.client.Item
import com.etebase.client.ItemManager
import com.etebase.client.ItemMetadata
import com.etebase.client.exceptions.EtebaseException
import io.silentsuite.sync.notes.NoteMetaBindingComparison.DecodeReason.*
import io.silentsuite.sync.notes.NoteMetaBindingComparison.MergeReason.*
import io.silentsuite.sync.notes.edit.NoteMetaCodec
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Merge
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Peek

/**
 * Compares [NoteMetaCodec], which reads and writes note metadata as raw msgpack, with the Etebase
 * binding's typed `ItemMetadata`, which the rest of the app reads and writes metadata with. The typed
 * side is native code that a JVM test cannot load, so the comparison runs on a device, on items of a
 * notebook that is never uploaded.
 *
 * There are three directions over a fixed table. Decoding sets a typed read against
 * [NoteMetaCodec.peek]. Merging sets [NoteMetaCodec.merge] against a typed update: read, set name and
 * mtime, write back, which is how the app changes typed metadata everywhere else. Encoding sets the
 * typed writer against [NoteMetaCodec.fresh]. Every row pins what both sides do. Where the two are
 * expected to differ, the row names the reason ([DecodeReason], [MergeReason]). A row that does
 * anything else is a difference, and the test fails on any difference.
 *
 * An input the binding does not expect can end the process inside native code instead of failing a
 * test, so every typed call is made by [Binding], behind the two screens below. What the screens keep
 * out is not compared:
 * - empty metadata, metadata over [MAX_BYTES] bytes, the reserved type byte, lengths and counts that
 *   run past the end, nesting deeper than [MAX_DEPTH] (which leaves out the web's two 40-level
 *   fixtures) and containers of more than [MAX_COUNT] entries;
 * - text that holds U+0000, in the input or on its way into a setter;
 * - a title above U+FFFF or with an unpaired surrogate on its way into a typed setter, on every API
 *   level, so the typed writer's bytes for such a title are never set against the codec's;
 * - below API [FOUR_BYTE_TEXT_FROM_API], any input that holds a byte 0xf0 to 0xf4, so no title above
 *   U+FFFF passes through the typed side there in any direction;
 * - keys that the web reads as name or mtime through four-byte overlong forms: they hold the byte
 *   0xf0 and are in no row.
 * The table is a table: nothing here is generated, and nothing is searched.
 */
internal object NoteMetaBindingComparison {
    private const val TAG = "NoteMetaCompare"

    // ---- what one call into the typed side gives ----

    sealed class Typed {
        /** The five fields the typed decoder knows, as its getters return them. */
        data class Read(
            val name: String?,
            val mtime: Long?,
            val type: String? = null,
            val description: String? = null,
            val color: String? = null,
        ) : Typed()

        /**
         * The binding threw: the exception's simple class name and its message. As a pin, [message] is
         * a fragment that the message must contain, in any letter case.
         */
        data class Refused(val exception: String, val message: String) : Typed()

        /** The raw metadata after a typed write. */
        class Written(val bytes: ByteArray) : Typed()

        /** A screen kept the call from the binding. */
        data class NotSent(val rule: Rule) : Typed()

        /** The raw metadata did not come back as it was set, so no typed call was made on it. */
        data object RawChanged : Typed()
    }

    /** Why a call is not made. The first six belong to the read screen, the last three to the setter screen. */
    enum class Rule(val setter: Boolean = false) {
        EMPTY,
        TOO_LARGE,
        NOT_WALKABLE,
        TOO_DEEP_OR_TOO_MANY,
        NUL_IN_TEXT,
        FOUR_BYTE_TEXT,
        SETTER_TOO_LONG(true),
        SETTER_NUL(true),
        SETTER_SURROGATE(true),
    }

    /** The typed calls a row can make: on its input, on what the codec wrote for it, and on what the typed side wrote. */
    enum class Call { READ, UPDATE, READ_CODEC_OUTPUT, READ_TYPED_OUTPUT, WRITE, CREATE }

    data class NotSentCall(val row: String, val call: Call, val rule: Rule)

    /** How many rows of each direction were compared, which is all whose input the read screen let through. */
    data class Compared(val decode: Int, val merge: Int, val encode: Int, val extraMerge: Int)

    class Report(val compared: Compared, val notSent: List<NotSentCall>, val differences: List<String>) {
        /** The differences as a failure message: the first [SHOWN_DIFFERENCES], then how many more there are. */
        fun text(): String = differences.take(SHOWN_DIFFERENCES).joinToString("\n") +
            (if (differences.size > SHOWN_DIFFERENCES) "\n... and ${differences.size - SHOWN_DIFFERENCES} more" else "")
    }

    // ---- what the rows pin ----

    /** How a typed read and [NoteMetaCodec.peek] of the same bytes relate. The first two are agreement. */
    enum class DecodeClass(val agreement: Boolean) {
        /** Both read, and name and mtime are equal. */
        SAME(true),

        /** The typed decoder refuses and peek gives null. */
        BOTH_REFUSE(true),

        /** The typed decoder refuses and peek reads. */
        TYPED_REFUSES(false),

        /** Both read, and name or mtime differs. */
        VALUE_DIFFERS(false),

        /** The typed decoder reads and peek gives null. */
        CODEC_REFUSES(false),
    }

    /** Why a decode row is expected to differ. */
    enum class DecodeReason(val of: DecodeClass) {
        /** The typed mtime is a 64-bit integer and takes no float. peek truncates a finite float toward zero and gives null for NaN. */
        FLOAT_MTIME(DecodeClass.TYPED_REFUSES),

        /** The typed decoder refuses a map that repeats a field it knows. peek gives null for the repeated field only and still reads the other. */
        REPEATED(DecodeClass.TYPED_REFUSES),

        /** Unsigned integer key 1 is the name to the typed decoder, so next to the plain key it is a repeated field. peek gives null for the name. */
        ALIAS_NEXT_TO_PLAIN(DecodeClass.TYPED_REFUSES),

        /** name or mtime holds a value the typed field cannot take. peek gives null for that field and reads the other. */
        UNUSABLE_VALUE(DecodeClass.TYPED_REFUSES),

        /**
         * The typed decoder refuses the whole map for something the codec does not read: an integer or
         * nil key that it does not take as a field, a repeated type, or a description that is no string.
         * peek reads name and mtime as if the entry were any unknown one.
         */
        OUTSIDE_NAME_AND_MTIME(DecodeClass.TYPED_REFUSES),

        /**
         * The typed decoder reads unsigned integer keys 1 and 2, at any width, and a binary key that holds
         * the field's name, as the field. peek gives null for that field, because a merge would put the
         * plain key next to it.
         */
        INDEX_OR_BINARY_ALIAS(DecodeClass.VALUE_DIFFERS),

        /**
         * A malformed UTF-8 key that the web reads as name sits next to the plain key. The typed decoder
         * ignores it and reads the plain value. peek gives null, because the web shows the other value.
         */
        WEB_ALIAS_NEXT_TO_PLAIN(DecodeClass.VALUE_DIFFERS),

        /** The name's value is binary data that is valid UTF-8, which the typed decoder takes for a string. peek reads strings only. */
        BINARY_NAME(DecodeClass.VALUE_DIFFERS),

        /** The typed decoder reads the first value and ignores what follows it. The codec takes exactly one map. */
        TRAILING(DecodeClass.CODEC_REFUSES),

        /** The typed decoder reads an array of five by position. The codec takes a map only. */
        POSITIONAL_ARRAY(DecodeClass.CODEC_REFUSES),
    }

    /** Which of the two, [NoteMetaCodec.merge] and the typed update, writes. */
    enum class MergeClass(val needsReason: Boolean) {
        /**
         * Both write. That is agreement when the typed decoder reads the same five fields from both
         * outputs (the new name and mtime, and type, description and color as it read them from the
         * input), peek reads the new name and mtime from both, the codec's output keeps every other
         * entry of the input byte for byte and in order, and the typed output has exactly the pinned
         * keys. Whether the two outputs are the same bytes is pinned per row.
         */
        BOTH_WRITE(false),

        /** The codec merges, and the typed update refuses at its read. */
        CODEC_ONLY(true),

        /** The codec refuses or answers that the input is not a map, and the typed update writes. */
        TYPED_ONLY(true),

        /** Neither writes, which is agreement. */
        NEITHER(false),

        /**
         * No typed setter may take the name, so there is no typed update on any API level. The codec
         * merges, and the typed decoder reads its output where the read screen lets it.
         */
        CODEC_ALONE(false),
    }

    /** Why the two outputs of a merge row differ in shape, or why only one side writes. */
    enum class MergeReason(val of: MergeClass) {
        /**
         * The typed update writes the five fields it knows, so every other entry of the input is gone
         * from its output. The codec keeps each one byte for byte.
         */
        UNKNOWN_DROPPED(MergeClass.BOTH_WRITE),

        /**
         * Integer keys 0, 3 and 4 are type, description and color to the typed decoder. The typed update
         * writes them back under their string keys, and the codec copies the integer-keyed entry. Both
         * outputs read the same through the typed decoder.
         */
        REKEYED(MergeClass.BOTH_WRITE),

        /**
         * The typed decoder refused the input for the name or mtime value itself, and the merge replaces
         * that value, so the typed decoder reads the codec's output.
         */
        REPAIRED(MergeClass.CODEC_ONLY),

        /**
         * The input is refused for something outside name and mtime, which the merge copies, so the
         * typed decoder refuses the codec's output the same way. The app reads a merge back through the
         * typed decoder before it uploads and holds a note like this one.
         */
        STILL_REFUSED(MergeClass.CODEC_ONLY),

        /**
         * The typed decoder read the alias as the field, and the typed update writes plain keys only. The
         * codec refuses, since a raw merge would add the plain key next to the alias.
         */
        ALIAS_REWRITTEN(MergeClass.TYPED_ONLY),

        /** The typed decoder never saw the malformed key, and the typed update drops it. The codec refuses. */
        WEB_ALIAS_DROPPED(MergeClass.TYPED_ONLY),

        /**
         * The typed decoder read past what is not one map, and the typed update writes one clean map. The
         * codec answers that the input is not a map.
         */
        NOT_ONE_MAP_REWRITTEN(MergeClass.TYPED_ONLY),
    }

    /**
     * What a merge row pins: the class and its reason, what the codec answers ([MERGED], [NOT_A_MAP] or
     * a refusal), whether the two outputs are the same bytes where both write, and the keys of the typed
     * output where the typed side writes.
     */
    private class MergePin(
        val merge: MergeClass,
        val why: MergeReason?,
        val codec: String,
        val identical: Boolean?,
        val keys: List<String>,
    )

    private class Row(
        val id: String,
        val hex: String,
        /** A [Typed.Read] or a [Typed.Refused]. */
        val typed: Typed,
        val peek: Peek?,
        val decode: DecodeClass,
        val why: DecodeReason?,
        val merge: MergePin,
    ) {
        val raw = unhex(hex)

        fun mergeCase() = MergeCase(id, raw, typed, NEW_NAME, NEW_MTIME, NEW_NAME, merge)
    }

    /**
     * One merge: [name] and [mtime] written onto [raw], whose typed read is pinned as [input].
     * [written] is the name the codec writes for [name].
     */
    private class MergeCase(
        val id: String,
        val raw: ByteArray,
        val input: Typed,
        val name: String,
        val mtime: Long,
        val written: String,
        val pin: MergePin,
    )

    /**
     * One row of the typed writer. With [hex] null it is a pair of name and mtime whose typed bytes must
     * equal [NoteMetaCodec.fresh]; else it is a set of fields only the typed writer can write, pinned to
     * [hex]. [alsoCreated] writes a pair through both of the binding's entry points.
     */
    private class EncodeRow(val id: String, val fields: Typed.Read, val hex: String? = null, val alsoCreated: Boolean = false)

    // ---- the table ----

    private const val MSGPACK = "MsgPackException"
    private const val MERGED = "Merged"
    private const val NOT_A_MAP = "NotAMap"
    private val NAME_MTIME = listOf("name", "mtime")

    /** The mtime of most fixtures. */
    private const val T0 = 1758800000000L

    /** What every merge row writes: a name with a three-byte character, which a typed setter may take, and an mtime that needs eight bytes. */
    private const val NEW_NAME = "Merged title \u2713 2"
    private const val NEW_MTIME = 1758900000123L

    private const val CART_TITLE = "Eink\u00E4ufe f\u00FCr die Woche \uD83D\uDED2"
    private const val LONE_SURROGATE_TITLE = "A\uD800B"

    // The fixtures of NoteMetaCodecTest, under its names. That test checks that these are the same bytes.
    private const val WEB_NOTE = "82a46e616d65a947726f636572696573a56d74696d65cf0000019980a63400"
    private const val WEB_NOTE_EXTRA = "83a46e616d65a947726f636572696573a56d74696d65cf0000019980a63400a56578747261a76b6565702d6d65"
    private const val WEB_NOTE_NESTED = "85a46e616d65a5506c616e73a56d74696d65cf0000019980a63400a47461677392a161a162a66e657374656482a17801a17992c3c0a362696ec403010203"
    private const val WEB_LONG_TITLE = "82a46e616d65d93541207469746c652074686174206973206c6f6e676572207468616e207468697274792d6f6e6520627974657320666f722073747238a56d74696d65cf0000019980a63400"
    private const val WEB_UNICODE_TITLE = "82a46e616d65bd45696e6bc3a47566652066c3bc722064696520576f63686520f09f9b92a56d74696d65cf0000019980a63400"
    private const val WEB_FLOAT_MTIME = "82a46e616d65a5466c6f6174a56d74696d65cb4279980a63400800"
    private const val WEB_NO_MTIME = "81a46e616d65ab4f6e6c792061206e616d65"
    private const val WEB_EMPTY = "80"
    private const val WEB_FIFTEEN_NO_MTIME = "8fa26b3000a26b3101a26b3202a26b3303a26b3404a26b3505a26b3606a26b3707a26b3808a26b3909a36b31300aa36b31310ba36b31320ca36b31330da46e616d65a16e"
    private const val WEB_SIXTEEN = "de0010a26b3000a26b3101a26b3202a26b3303a26b3404a26b3505a26b3606a26b3707a26b3808a26b3909a36b31300aa36b31310ba36b31320ca36b31330da36b31340ea36b31350f"
    private const val WEB_NEGATIVE = "83a46e616d65a34f6c64a56d74696d65fba564656c7461d1ff38"
    private const val WEB_DATE_SECONDS = "84a46e616d65a144a56d74696d65cf0000019980a63400a47768656ed6ff68d52880a56578747261a76b6565702d6d65"
    private const val WEB_DATE_MILLIS = "84a46e616d65a144a56d74696d65cf0000019980a63400a47768656ed7ff1d53530068d52880a56578747261a76b6565702d6d65"
    private const val WEB_DATE_FAR = "84a46e616d65a144a56d74696d65cf0000019980a63400a47768656ec70cff00000000ffffff172b5af000a56578747261a76b6565702d6d65"
    private const val WEB_EXT = "86a46e616d65a145a56d74696d65cf0000019980a63400a36f6e65d407aba57468726565c70307abababa67477656e7479c71407ababababababababababababababababababababa56578747261a76b6565702d6d65"
    private const val TYPED_ALL = "85a474797065a174a46e616d65a55479706564a56d74696d65cf0000019980a63400ab6465736372697074696f6ea164a5636f6c6f72a723616162626363"
    private const val MTIME_FIRST = "83a56d74696d6501a56578747261a178a46e616d65a141"

    // After name and mtime, one field per value width the web writes, built from the same pieces as in NoteMetaCodecTest.
    private val WEB_WIDTHS = "8ca46e616d65a157a56d74696d65cf0000019980a63400" +
        "a473333030da012c" + "78".repeat(300) + "a462333030c5012c" + "07".repeat(300) +
        "a56172723136dc0010000102030405060708090a0b0c0d0e0f" +
        "a56f626a3136de0010a26b3000a26b3101a26b3202a26b3303a26b3404a26b3505a26b3606a26b3707a26b3808a26b3909a36b31300aa36b31310ba36b31320ca36b31330da36b31340ea36b31350f" +
        "a46e323030ccc8a56e6d313030d09ca56e3130306bce000186a0a66e6d3130306bd2fffe7960a66e6d32653430d3ffffff0000000000a166cb3fe0000000000000"

    // What the typed writer gives for a name, for a name and an mtime, and for those with an empty type.
    private const val TYPED_NAME = "81a46e616d65a55479706564"
    private const val TYPED_NAME_MTIME = "82a46e616d65a55479706564a56d74696d65cf0000019980a63400"
    private const val TYPED_EMPTY_TYPE = "83a474797065a0a46e616d65a55479706564a56d74696d65cf0000019980a63400"

    private fun reads(name: String?, mtime: Long?, type: String? = null, description: String? = null, color: String? = null) =
        Typed.Read(name, mtime, type, description, color)

    private fun peek(name: String?, mtime: Long?) = Peek(name, mtime)

    private fun same(id: String, hex: String, typed: Typed.Read, merge: MergePin) =
        Row(id, hex, typed, Peek(typed.name, typed.mtime), DecodeClass.SAME, null, merge)

    private fun bothRefuse(id: String, hex: String, fragment: String, merge: MergePin) =
        Row(id, hex, Typed.Refused(MSGPACK, fragment), null, DecodeClass.BOTH_REFUSE, null, merge)

    private fun typedRefuses(id: String, hex: String, fragment: String, peek: Peek, why: DecodeReason, merge: MergePin) =
        Row(id, hex, Typed.Refused(MSGPACK, fragment), peek, DecodeClass.TYPED_REFUSES, why, merge)

    private fun valueDiffers(id: String, hex: String, typed: Typed.Read, peek: Peek, why: DecodeReason, merge: MergePin) =
        Row(id, hex, typed, peek, DecodeClass.VALUE_DIFFERS, why, merge)

    private fun codecRefuses(id: String, hex: String, typed: Typed.Read, why: DecodeReason, merge: MergePin) =
        Row(id, hex, typed, null, DecodeClass.CODEC_REFUSES, why, merge)

    private fun bothWrite(identical: Boolean, why: MergeReason? = null, keys: List<String> = NAME_MTIME) =
        MergePin(MergeClass.BOTH_WRITE, why, MERGED, identical, keys)

    private fun codecOnly(why: MergeReason) = MergePin(MergeClass.CODEC_ONLY, why, MERGED, null, emptyList())

    private fun typedOnly(why: MergeReason, codec: String) = MergePin(MergeClass.TYPED_ONLY, why, codec, null, NAME_MTIME)

    private fun neither(codec: String) = MergePin(MergeClass.NEITHER, null, codec, null, emptyList())

    private fun codecAlone() = MergePin(MergeClass.CODEC_ALONE, null, MERGED, null, emptyList())

    private fun aliased(key: String) = "Refused($key, ALIASED)"

    private fun repeated(key: String) = "Refused($key, REPEATED)"

    /**
     * The inputs of the decode and merge directions. Each row gives the bytes, the typed read (five
     * fields, or the fragment of the refusal's message), what peek gives where that is not the same name
     * and mtime, the reason where the two are expected to differ, and what a merge of [NEW_NAME] and
     * [NEW_MTIME] does on each side.
     *
     * What a row pins for the typed side is what the binding gave on a device, not what its source says
     * it should give. The reasons are read from its source. The wording of a refusal is serde's or rmp-serde's, so a
     * new version of the binding can fail a row by changing a message alone.
     */
    private val ROWS: List<Row> = listOf(
        // What the web's encoder writes.
        same("webNote", WEB_NOTE, reads("Groceries", T0), bothWrite(identical = true)),
        same("webNoteExtra", WEB_NOTE_EXTRA, reads("Groceries", T0), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("webNoteNested", WEB_NOTE_NESTED, reads("Plans", T0), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("webLongTitle", WEB_LONG_TITLE, reads("A title that is longer than thirty-one bytes for str8", T0), bothWrite(identical = true)),
        same("webUnicodeTitle", WEB_UNICODE_TITLE, reads(CART_TITLE, T0), bothWrite(identical = true)),
        typedRefuses("webFloatMtime", WEB_FLOAT_MTIME, "expected i64", peek("Float", T0), FLOAT_MTIME, codecOnly(REPAIRED)),
        same("webNoMtime", WEB_NO_MTIME, reads("Only a name", null), bothWrite(identical = true)),
        same("webEmpty", WEB_EMPTY, reads(null, null), bothWrite(identical = true)),
        same("webFifteenNoMtime", WEB_FIFTEEN_NO_MTIME, reads("n", null), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("webSixteen", WEB_SIXTEEN, reads(null, null), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("webNegative", WEB_NEGATIVE, reads("Old", -5), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("webDateSeconds", WEB_DATE_SECONDS, reads("D", T0), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("webDateMillis", WEB_DATE_MILLIS, reads("D", T0), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("webDateFar", WEB_DATE_FAR, reads("D", T0), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("webExt", WEB_EXT, reads("E", T0), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("webWidths", WEB_WIDTHS, reads("W", T0), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("mtimeFirst", MTIME_FIRST, reads("A", 1), bothWrite(identical = false, UNKNOWN_DROPPED)),

        // What the typed writer writes. Its fields stay in its own order, and the codec writes into them in place.
        same("typedName", TYPED_NAME, reads("Typed", null), bothWrite(identical = true)),
        same("typedNameMtime", TYPED_NAME_MTIME, reads("Typed", T0), bothWrite(identical = true)),
        same("typedAll", TYPED_ALL, reads("Typed", T0, type = "t", description = "d", color = "#aabbcc"),
            bothWrite(identical = true, keys = listOf("type", "name", "mtime", "description", "color"))),
        same("typedEmptyType", TYPED_EMPTY_TYPE, reads("Typed", T0, type = ""), bothWrite(identical = true, keys = listOf("type", "name", "mtime"))),
        same("withType", "83a474797065a0a46e616d65a141a56d74696d6501", reads("A", 1, type = ""), bothWrite(identical = true, keys = listOf("type", "name", "mtime"))),

        // Headers, keys and values at widths the web does not write. The codec keeps a key at the width it
        // had and the typed writer writes it at the smallest, so the two rows with wider keys differ in bytes.
        same("map16TwoEntries", "de0002a46e616d65a141a56d74696d6501", reads("A", 1), bothWrite(identical = true)),
        same("map32TwoEntries", "df00000002a46e616d65a141a56d74696d6501", reads("A", 1), bothWrite(identical = true)),
        same("str8KeyName", "82d9046e616d65a141a56d74696d6501", reads("A", 1), bothWrite(identical = false)),
        same("str16And32Keys", "82da00046e616d65a141db000000056d74696d6501", reads("A", 1), bothWrite(identical = false)),
        same("nameStr32", "82a46e616d65db0000000141a56d74696d6501", reads("A", 1), bothWrite(identical = true)),
        same("mtimeInt64One", "82a46e616d65a141a56d74696d65d30000000000000001", reads("A", 1), bothWrite(identical = true)),
        same("mtimeInt8MinusOne", "82a46e616d65a141a56d74696d65d0ff", reads("A", -1), bothWrite(identical = true)),
        same("mtimeMaxLong", "82a46e616d65a16ea56d74696d65cf7fffffffffffffff", reads("n", Long.MAX_VALUE), bothWrite(identical = true)),
        same("mtimeMinLong", "82a46e616d65a16ea56d74696d65d38000000000000000", reads("n", Long.MIN_VALUE), bothWrite(identical = true)),

        // Names and mtimes that are nil, empty or unusual text.
        same("nilName", "82a46e616d65c0a56d74696d6501", reads(null, 1), bothWrite(identical = true)),
        same("mtimeNil", "82a46e616d65a16ea56d74696d65c0", reads("n", null), bothWrite(identical = true)),
        same("emptyName", "82a46e616d65a0a56d74696d6501", reads("", 1), bothWrite(identical = true)),
        same("bomName", "82a46e616d65a4efbbbf41a56d74696d6501", reads("\uFEFFA", 1), bothWrite(identical = true)),

        // Entries neither side reads as name or mtime.
        same("nestedName", "83a46e616d65a141a56d74696d6501a16e81a46e616d65a142", reads("A", 1), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("fixextValue", "83a46e616d65a141a56d74696d6501a178d40100", reads("A", 1), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("dateExtValue", "83a46e616d65a141a56d74696d6501a177d6ff00000000", reads("A", 1), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("float32Value", "83a46e616d65a141a56d74696d6501a166ca3f800000", reads("A", 1), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("invalidUtf8OtherKey", "83a46e616d65a141a56d74696d6501a2c328a178", reads("A", 1), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("unknownDuplicate", "84a46e616d65a141a56d74696d6501a178a161a178a162", reads("A", 1), bothWrite(identical = false, UNKNOWN_DROPPED)),
        same("nearMissKey", "82a56e616dc3a9a141a56d74696d6501", reads(null, 1), bothWrite(identical = false, UNKNOWN_DROPPED)),

        // Integer keys, and a nil key. To the typed decoder an unsigned one is a field's position: 0 type, 1 name, 2 mtime, 3 description, 4 color.
        valueDiffers("intKeyOne", "8201a178a56d74696d6501", reads("x", 1), peek(null, 1), INDEX_OR_BINARY_ALIAS, typedOnly(ALIAS_REWRITTEN, aliased("name"))),
        valueDiffers("intKeyTwo", "82a46e616d65a34f6c640205", reads("Old", 5), peek("Old", null), INDEX_OR_BINARY_ALIAS, typedOnly(ALIAS_REWRITTEN, aliased("mtime"))),
        valueDiffers("uint8KeyOne", "82cc01a34f6c64a56d74696d6505", reads("Old", 5), peek(null, 5), INDEX_OR_BINARY_ALIAS, typedOnly(ALIAS_REWRITTEN, aliased("name"))),
        valueDiffers("uint16KeyTwo", "82a46e616d65a34f6c64cd000205", reads("Old", 5), peek("Old", null), INDEX_OR_BINARY_ALIAS, typedOnly(ALIAS_REWRITTEN, aliased("mtime"))),
        valueDiffers("uint32KeyOne", "82ce00000001a34f6c64a56d74696d6505", reads("Old", 5), peek(null, 5), INDEX_OR_BINARY_ALIAS, typedOnly(ALIAS_REWRITTEN, aliased("name"))),
        valueDiffers("uint64KeyTwo", "82a46e616d65a34f6c64cf000000000000000205", reads("Old", 5), peek("Old", null), INDEX_OR_BINARY_ALIAS, typedOnly(ALIAS_REWRITTEN, aliased("mtime"))),
        typedRefuses("plainNamePlusIndexOne", "83a46e616d65a141a56d74696d650501a142", "duplicate field `name`", peek(null, 5), ALIAS_NEXT_TO_PLAIN, neither(aliased("name"))),
        same("intKeyZero", "8200a141a56d74696d6501", reads(null, 1, type = "A"), bothWrite(identical = false, REKEYED, listOf("type", "name", "mtime"))),
        same("intKeyThree", "8203a141a56d74696d6501", reads(null, 1, description = "A"), bothWrite(identical = false, REKEYED, listOf("name", "mtime", "description"))),
        same("intKeyFour", "8204a141a56d74696d6501", reads(null, 1, color = "A"), bothWrite(identical = false, REKEYED, listOf("name", "mtime", "color"))),
        typedRefuses("intKeyTen", "820aa178a56d74696d6501", "expected field index", peek(null, 1), OUTSIDE_NAME_AND_MTIME, codecOnly(STILL_REFUSED)),
        typedRefuses("int8KeyOne", "82d001a34f6c64a56d74696d6505", "expected field identifier", peek(null, 5), OUTSIDE_NAME_AND_MTIME, codecOnly(STILL_REFUSED)),
        typedRefuses("negativeFixintKey", "82ffa141a56d74696d6501", "expected field identifier", peek(null, 1), OUTSIDE_NAME_AND_MTIME, codecOnly(STILL_REFUSED)),
        typedRefuses("nilKey", "82c0a141a56d74696d6501", "expected field identifier", peek(null, 1), OUTSIDE_NAME_AND_MTIME, codecOnly(STILL_REFUSED)),

        // Binary keys that hold a field's name.
        valueDiffers("binKeyName", "82c4046e616d65a141a56d74696d6501", reads("A", 1), peek(null, 1), INDEX_OR_BINARY_ALIAS, typedOnly(ALIAS_REWRITTEN, aliased("name"))),
        valueDiffers("binKeyMtime", "82a46e616d65a141c4056d74696d6505", reads("A", 5), peek("A", null), INDEX_OR_BINARY_ALIAS, typedOnly(ALIAS_REWRITTEN, aliased("mtime"))),
        valueDiffers("bin16KeyName", "82c500046e616d65a141a56d74696d6501", reads("A", 1), peek(null, 1), INDEX_OR_BINARY_ALIAS, typedOnly(ALIAS_REWRITTEN, aliased("name"))),
        valueDiffers("bin32KeyMtime", "82a46e616d65a141c6000000056d74696d6505", reads("A", 5), peek("A", null), INDEX_OR_BINARY_ALIAS, typedOnly(ALIAS_REWRITTEN, aliased("mtime"))),

        // Malformed UTF-8 keys that the web reads as name or mtime and the typed decoder ignores.
        same("invalidUtf8NameAlias", "82a8c1aec1a1c1adc1a5a55469746c65a56d74696d6505", reads(null, 5), typedOnly(WEB_ALIAS_DROPPED, aliased("name"))),
        same("overlong3ByteNameAlias", "82a6e081ae616d65a141a56d74696d6501", reads(null, 1), typedOnly(WEB_ALIAS_DROPPED, aliased("name"))),
        same("cutOffNameAlias", "82a46e616dc1a55469746c65a56d74696d6505", reads(null, 5), typedOnly(WEB_ALIAS_DROPPED, aliased("name"))),
        same("overlongMtimeAlias", "82a46e616d65a141a6c1ad74696d6505", reads("A", null), typedOnly(WEB_ALIAS_DROPPED, aliased("mtime"))),
        valueDiffers("overlongAliasWithPlainName", "83a46e616d65a55469746c65a8c1aec1a1c1adc1a5a54f74686572a56d74696d6505", reads("Title", 5), peek(null, 5),
            WEB_ALIAS_NEXT_TO_PLAIN, typedOnly(WEB_ALIAS_DROPPED, aliased("name"))),

        // Repeated fields.
        typedRefuses("dupName", "83a46e616d65a141a46e616d65a142a56d74696d6501", "duplicate field `name`", peek(null, 1), REPEATED, neither(repeated("name"))),
        typedRefuses("dupNameTwoWidths", "82a46e616d65a161d9046e616d65a162", "duplicate field `name`", peek(null, null), REPEATED, neither(repeated("name"))),
        typedRefuses("dupMtime", "83a46e616d65a161a56d74696d6501a56d74696d6502", "duplicate field `mtime`", peek("a", null), REPEATED, neither(repeated("mtime"))),
        typedRefuses("typeDuplicate", "84a474797065a0a474797065a0a46e616d65a141a56d74696d6501", "duplicate field `type`", peek("A", 1), OUTSIDE_NAME_AND_MTIME, codecOnly(STILL_REFUSED)),

        // Values the typed fields cannot take, or take differently.
        typedRefuses("nameInteger", "82a46e616d6505a56d74696d6501", "expected a string", peek(null, 1), UNUSABLE_VALUE, codecOnly(REPAIRED)),
        typedRefuses("nameInvalidUtf8", "82a46e616d65a2c328a56d74696d6501", "utf", peek(null, 1), UNUSABLE_VALUE, codecOnly(REPAIRED)),
        valueDiffers("nameBinary", "82a46e616d65c40141a56d74696d6501", reads("A", 1), peek(null, 1), BINARY_NAME, bothWrite(identical = true)),
        typedRefuses("mtimeString", "82a46e616d65a16ea56d74696d65a131", "expected i64", peek("n", null), UNUSABLE_VALUE, codecOnly(REPAIRED)),
        typedRefuses("mtimeAboveLong", "82a46e616d65a16ea56d74696d65cfffffffffffffffff", "expected i64", peek("n", null), UNUSABLE_VALUE, codecOnly(REPAIRED)),
        typedRefuses("mtimeTrue", "82a46e616d65a16ea56d74696d65c3", "expected i64", peek("n", null), UNUSABLE_VALUE, codecOnly(REPAIRED)),
        typedRefuses("mtimeFloat32", "82a46e616d65a141a56d74696d65ca3fc00000", "expected i64", peek("A", 1), FLOAT_MTIME, codecOnly(REPAIRED)),
        typedRefuses("mtimeNaN", "82a46e616d65a141a56d74696d65cb7ff8000000000000", "expected i64", peek("A", null), FLOAT_MTIME, codecOnly(REPAIRED)),
        typedRefuses("descriptionNumber", "81ab6465736372697074696f6e07", "expected a string", peek(null, null), OUTSIDE_NAME_AND_MTIME, codecOnly(STILL_REFUSED)),

        // What is not exactly one map.
        codecRefuses("trailingByte", WEB_NOTE + "00", reads("Groceries", T0), TRAILING, typedOnly(NOT_ONE_MAP_REWRITTEN, NOT_A_MAP)),
        codecRefuses("twoMaps", "8080", reads(null, null), TRAILING, typedOnly(NOT_ONE_MAP_REWRITTEN, NOT_A_MAP)),
        codecRefuses("arrayOfFive", "95c0a14101c0c0", reads("A", 1), POSITIONAL_ARRAY, typedOnly(NOT_ONE_MAP_REWRITTEN, NOT_A_MAP)),
        bothRefuse("notAMap", "92a141a142", "expected struct ItemMetadata", neither(NOT_A_MAP)),
        bothRefuse("topLevelNil", "c0", "expected struct ItemMetadata", neither(NOT_A_MAP)),
        // A map of two that ends after its first entry.
        bothRefuse("cutAtAValueBoundary", "82a46e616d65a141", "IO error", neither(NOT_A_MAP)),
    )

    private val DECODE_TALLY = mapOf(
        DecodeClass.SAME to 48,
        DecodeClass.BOTH_REFUSE to 3,
        DecodeClass.TYPED_REFUSES to 18,
        DecodeClass.VALUE_DIFFERS to 12,
        DecodeClass.CODEC_REFUSES to 3,
    )

    private val MERGE_TALLY = mapOf(
        MergeClass.BOTH_WRITE to 45,
        MergeClass.CODEC_ONLY to 14,
        MergeClass.TYPED_ONLY to 18,
        MergeClass.NEITHER to 7,
        MergeClass.CODEC_ALONE to 0,
    )

    private fun extra(id: String, name: String, mtime: Long, written: String = name, pin: MergePin = bothWrite(identical = true)) =
        MergeCase(id, unhex(WEB_NOTE), reads("Groceries", T0), name, mtime, written, pin)

    /**
     * Six more merges, all onto webNote: names and mtimes at other widths through both sides, and two
     * names that no typed setter may take. For those two the codec's side is compared alone: the name it
     * reports, what peek reads back, and what the typed decoder reads from its output. The lone surrogate
     * must be written, reported and read back as U+FFFD.
     */
    private val EXTRA_MERGES: List<MergeCase> = listOf(
        extra("name300mtimeNeg", "x".repeat(300), -1L),
        extra("name70000mtimeZero", "y".repeat(70_000), 0L),
        extra("emptyNameMaxLong", "", Long.MAX_VALUE),
        extra("name31mtimeMinLong", "z".repeat(31), Long.MIN_VALUE),
        extra("loneSurrogate", LONE_SURROGATE_TITLE, 7L, written = "A\uFFFDB", pin = codecAlone()),
        extra("cartTitle", CART_TITLE, T0, pin = codecAlone()),
    )

    private const val ENCODE_PAIRS = 32
    private const val ENCODE_TYPED_ONLY = 4

    /**
     * The encode direction. For each pair the typed writer and [NoteMetaCodec.fresh] must give the same
     * bytes, which the typed decoder and peek must both read as that name and mtime. There is no
     * expected difference here. The names sit on both sides of every string width and hold two-byte and
     * three-byte characters, two of them have their char count and their byte count on different sides of
     * a width, and the mtimes sit on both sides of every integer width.
     *
     * The four rows after the pairs pin what only the typed writer can write: unset fields left out, and
     * type, description and color in its own order.
     */
    private val ENCODE_ROWS: List<EncodeRow> =
        listOf(
            "", "Typed", "z".repeat(31), "z".repeat(32), "x".repeat(255), "x".repeat(256), "y".repeat(65_535), "y".repeat(65_536),
            "Eink\u00E4ufe f\u00FCr die Woche \u2713", NEW_NAME, "\u00E9".repeat(17), "\u00E9".repeat(128),
        ).map { EncodeRow("${it.length} chars at T0", reads(it, T0), alsoCreated = it == "Typed") } +
            listOf(
                0L, 127L, 128L, 255L, 256L, 65_535L, 65_536L, 4_294_967_295L, 4_294_967_296L,
                -1L, -32L, -33L, -128L, -129L, -32_768L, -32_769L, -2_147_483_648L, -2_147_483_649L,
                Long.MAX_VALUE, Long.MIN_VALUE,
            ).map { EncodeRow("Typed at $it", reads("Typed", it)) } +
            listOf(
                EncodeRow("typedEmpty", reads(null, null), WEB_EMPTY),
                EncodeRow("typedName", reads("Typed", null), TYPED_NAME),
                EncodeRow("typedAll", reads("Typed", T0, type = "t", description = "d", color = "#aabbcc"), TYPED_ALL),
                EncodeRow("typedEmptyType", reads("Typed", T0, type = ""), TYPED_EMPTY_TYPE),
            )

    // ---- the screens ----

    /** The most bytes of metadata that go to the typed side. */
    private const val MAX_BYTES = 70_018

    /** The most containers inside one another, the top level counted. */
    private const val MAX_DEPTH = 3

    /** The most entries of one map, or elements of one array. */
    private const val MAX_COUNT = 18

    /** The most chars of a string that goes to a typed setter. */
    private const val MAX_SETTER_CHARS = 70_000

    /** From this API level on, the rows of [FOUR_BYTE_ROWS] may hold a byte 0xf0 to 0xf4. Below it nothing may. */
    private const val FOUR_BYTE_TEXT_FROM_API = 23

    private val FOUR_BYTE_ROWS = setOf("webUnicodeTitle", "webDateFar", "cartTitle")

    private const val ANDROID_5 = 21

    /** One value's header. [from] and [end] bound its payload, and for a container [end] is where its first child starts. */
    private class Head(
        val from: Int,
        val end: Int,
        val container: Boolean = false,
        val children: Int = 0,
        val count: Int = 0,
        val text: Boolean = false,
    )

    /**
     * The header of the value at [at], or null when it is the reserved type or does not fit in the bytes
     * that remain. This is the test's own reading of msgpack: nothing in the screens or in the checks of
     * the outputs goes through the reader of the code under test.
     */
    private fun head(b: ByteArray, at: Int): Head? {
        val left = b.size - at - 1

        /** The big-endian number in the [bytes] bytes after the type byte, or -1 when the input ends inside it. */
        fun number(bytes: Int): Long {
            if (left < bytes) return -1
            var v = 0L
            for (i in 1..bytes) v = (v shl 8) or (b[at + i].toLong() and 0xff)
            return v
        }

        /** A value of [length] payload bytes after [header] more header bytes. */
        fun payload(header: Int, length: Long, text: Boolean = false): Head? =
            if (length < 0 || length > left - header) null
            else Head(at + 1 + header, at + 1 + header + length.toInt(), text = text)

        /** A container of [count] entries of [perEntry] values each. Every value takes a byte, so more values than bytes left do not fit. */
        fun container(header: Int, count: Long, perEntry: Int): Head? =
            if (count < 0 || count * perEntry > left - header) null
            else Head(at + 1 + header, at + 1 + header, container = true, children = (count * perEntry).toInt(), count = count.toInt())

        val type = b[at].toInt() and 0xff
        return when {
            type <= 0x7f || type >= 0xe0 -> payload(0, 0) // fixint
            type <= 0x8f -> container(0, (type and 0x0f).toLong(), 2) // fixmap
            type <= 0x9f -> container(0, (type and 0x0f).toLong(), 1) // fixarray
            type <= 0xbf -> payload(0, (type and 0x1f).toLong(), text = true) // fixstr
            else -> when (type) {
                0xc0, 0xc2, 0xc3 -> payload(0, 0) // nil, false, true
                0xc4, 0xd9 -> payload(1, number(1), text = true) // bin 8, str 8
                0xc5, 0xda -> payload(2, number(2), text = true) // bin 16, str 16
                0xc6, 0xdb -> payload(4, number(4), text = true) // bin 32, str 32
                0xc7 -> payload(2, number(1)) // ext 8: a length, a type byte, the data
                0xc8 -> payload(3, number(2))
                0xc9 -> payload(5, number(4))
                0xcc, 0xd0 -> payload(0, 1)
                0xcd, 0xd1 -> payload(0, 2)
                0xca, 0xce, 0xd2 -> payload(0, 4)
                0xcb, 0xcf, 0xd3 -> payload(0, 8)
                0xd4 -> payload(0, 2) // fixext 1: a type byte and one byte of data
                0xd5 -> payload(0, 3)
                0xd6 -> payload(0, 5)
                0xd7 -> payload(0, 9)
                0xd8 -> payload(0, 17)
                0xdc -> container(2, number(2), 1) // array 16
                0xdd -> container(4, number(4), 1) // array 32
                0xde -> container(2, number(2), 2) // map 16
                0xdf -> container(4, number(4), 2) // map 32
                else -> null // 0xc1 is no type
            }
        }
    }

    /**
     * Null when the typed decoder may read [raw] on API level [sdk], else the rule that keeps it out.
     * Each rule closes one way a typed call could end the process or come back cut:
     * - [Rule.EMPTY] and [Rule.TOO_LARGE]: sizes that have not been through the binding. [MAX_BYTES] has.
     * - [Rule.NOT_WALKABLE]: the walk must reach the last byte, so no length or count points past the
     *   end and no byte is left unseen. An input that ends at a value boundary with values still owed
     *   is walkable, and so are several values in a row.
     * - [Rule.TOO_DEEP_OR_TOO_MANY]: nesting and counts stay within what the largest rows of the table
     *   need, webNoteNested and the merged webSixteen.
     * - [Rule.NUL_IN_TEXT]: the binding hands text to the platform as a C string, so text with U+0000
     *   would come back cut at that character.
     * - [Rule.FOUR_BYTE_TEXT]: the binding hands a getter's text and an exception's message to the
     *   platform as UTF-8. Android 5 expects modified UTF-8 there, and with the JNI checks that a
     *   debuggable app runs under it aborts on a four-byte sequence. The rule looks at every byte of the
     *   input, which also covers a message that quotes a value, and at worst it keeps out more than it
     *   must: webDateFar has such a byte in a date. From API [FOUR_BYTE_TEXT_FROM_API] on, such bytes
     *   are let through for the rows named in [FOUR_BYTE_ROWS] and for nothing else.
     */
    private fun readScreen(id: String, raw: ByteArray, sdk: Int): Rule? {
        if (raw.isEmpty()) return Rule.EMPTY
        if (raw.size > MAX_BYTES) return Rule.TOO_LARGE
        // The values still to come in each open container, innermost last.
        val owed = ArrayList<Int>()
        var deepOrMany = false
        var nul = false
        var at = 0
        while (at < raw.size) {
            val h = head(raw, at) ?: return Rule.NOT_WALKABLE
            if (owed.isNotEmpty()) owed[owed.lastIndex] = owed[owed.lastIndex] - 1
            if (h.container) {
                if (owed.size >= MAX_DEPTH || h.count > MAX_COUNT) deepOrMany = true
                owed += h.children
            }
            if (h.text) for (i in h.from until h.end) if (raw[i].toInt() == 0) nul = true
            while (owed.isNotEmpty() && owed[owed.lastIndex] == 0) owed.removeAt(owed.lastIndex)
            at = h.end
        }
        if (deepOrMany) return Rule.TOO_DEEP_OR_TOO_MANY
        if (nul) return Rule.NUL_IN_TEXT
        val fourByte = raw.any { (it.toInt() and 0xff) in 0xf0..0xf4 }
        if (fourByte && (sdk < FOUR_BYTE_TEXT_FROM_API || id !in FOUR_BYTE_ROWS)) return Rule.FOUR_BYTE_TEXT
        return null
    }

    /**
     * Null when [s] may go to a typed setter, on every API level, else the rule that keeps it out. The
     * binding needs strict UTF-8 from a setter's string and gets the platform's modified UTF-8, which is
     * the same bytes only for text without U+0000 and without surrogates. So nothing above U+FFFF goes
     * in, paired or not.
     */
    private fun setterScreen(s: String): Rule? = when {
        s.length > MAX_SETTER_CHARS -> Rule.SETTER_TOO_LONG
        s.any { it.code == 0 } -> Rule.SETTER_NUL
        s.any { it.isSurrogate() } -> Rule.SETTER_SURROGATE
        else -> null
    }

    /**
     * The typed calls that are not made, in the order [run] meets them.
     *
     * On every API level: no typed setter may take the names of loneSurrogate (an unpaired surrogate)
     * and cartTitle (a character above U+FFFF), so the typed update of those two rows is not made. The
     * typed decoder still reads what the codec wrote for them.
     *
     * Below API [FOUR_BYTE_TEXT_FROM_API], nothing that holds a byte 0xf0 to 0xf4 is sent: the typed
     * read and the typed update of webUnicodeTitle and of webDateFar, and for cartTitle the typed read
     * of the codec's output as well.
     */
    fun expectedNotSent(sdk: Int): List<NotSentCall> {
        val everywhere = listOf(
            NotSentCall("loneSurrogate", Call.UPDATE, Rule.SETTER_SURROGATE),
            NotSentCall("cartTitle", Call.UPDATE, Rule.SETTER_SURROGATE),
        )
        if (sdk >= FOUR_BYTE_TEXT_FROM_API) return everywhere
        return listOf(
            NotSentCall("webUnicodeTitle", Call.READ, Rule.FOUR_BYTE_TEXT),
            NotSentCall("webDateFar", Call.READ, Rule.FOUR_BYTE_TEXT),
            NotSentCall("webUnicodeTitle", Call.UPDATE, Rule.FOUR_BYTE_TEXT),
            NotSentCall("webDateFar", Call.UPDATE, Rule.FOUR_BYTE_TEXT),
        ) + everywhere + NotSentCall("cartTitle", Call.READ_CODEC_OUTPUT, Rule.FOUR_BYTE_TEXT)
    }

    /**
     * How many rows of each direction are compared: all of them from API [FOUR_BYTE_TEXT_FROM_API] on,
     * and all but webUnicodeTitle and webDateFar below. The two extra merges without a typed update
     * count, since the codec's side of them is compared on every API level.
     */
    fun expectedCompared(sdk: Int): Compared =
        if (sdk >= FOUR_BYTE_TEXT_FROM_API) Compared(decode = 84, merge = 84, encode = 36, extraMerge = 6)
        else Compared(decode = 82, merge = 82, encode = 36, extraMerge = 6)

    // ---- the typed side ----

    /**
     * The only code that calls the binding's typed metadata. Each function screens what it is given
     * before the call, and logs the row before the call and the result after it, so that if the process
     * ever ends inside the binding the last log line names the row and the call.
     */
    private class Binding(private val itemMgr: ItemManager, private val sdk: Int) {
        /**
         * One scratch item carries every call except the creates, each of which makes an item of its own.
         * It is made from raw bytes, an empty map. None of the items is uploaded.
         */
        private val item: Item = itemMgr.create_raw(unhex(WEB_EMPTY), ByteArray(0))

        /** What the typed decoder makes of [raw]: its five getters, or its refusal. */
        fun typedRead(id: String, call: Call, raw: ByteArray): Typed {
            readScreen(id, raw, sdk)?.let { return Typed.NotSent(it) }
            log("$call $id: ${raw.size} bytes")
            item.metaRaw = raw
            // The binding does not interpret raw metadata, so it must come back as set.
            if (!item.metaRaw.contentEquals(raw)) return done(id, call, Typed.RawChanged)
            val result = try {
                val meta = item.meta
                Typed.Read(meta.name, meta.mtime, meta.itemType, meta.description, meta.color)
            } catch (e: EtebaseException) {
                refused(e)
            }
            return done(id, call, result)
        }

        /** The typed update of [raw]: read, set name and mtime, write back. It is refused when its read is. */
        fun typedUpdate(id: String, raw: ByteArray, name: String, mtime: Long): Typed {
            (readScreen(id, raw, sdk) ?: setterScreen(name))?.let { return Typed.NotSent(it) }
            log("${Call.UPDATE} $id: ${raw.size} bytes")
            item.metaRaw = raw
            val meta = try {
                item.meta
            } catch (e: EtebaseException) {
                return done(id, Call.UPDATE, refused(e))
            }
            meta.name = name
            meta.mtime = mtime
            item.meta = meta
            return done(id, Call.UPDATE, Typed.Written(item.metaRaw))
        }

        /**
         * The typed writer's bytes for [fields], unset ones left out: set on the scratch item for
         * [Call.WRITE], or through the item manager's create for [Call.CREATE], which is how the app
         * makes a new item.
         */
        fun typedWrite(id: String, call: Call, fields: Typed.Read): Typed {
            listOfNotNull(fields.name, fields.type, fields.description, fields.color)
                .firstNotNullOfOrNull(::setterScreen)?.let { return Typed.NotSent(it) }
            log("$call $id")
            val meta = ItemMetadata()
            fields.type?.let { meta.itemType = it }
            fields.name?.let { meta.name = it }
            fields.mtime?.let { meta.mtime = it }
            fields.description?.let { meta.description = it }
            fields.color?.let { meta.color = it }
            if (call == Call.CREATE) return done(id, call, Typed.Written(itemMgr.create(meta, "").metaRaw))
            item.meta = meta
            return done(id, call, Typed.Written(item.metaRaw))
        }

        private fun refused(e: EtebaseException) = Typed.Refused(e.javaClass.simpleName, e.message.orEmpty())

        private fun done(id: String, call: Call, result: Typed): Typed {
            log("$call $id -> ${show(result, LOG_CUT)}")
            return result
        }

        private fun log(line: String) {
            Log.i(TAG, line)
        }
    }

    // ---- the comparison ----

    private class DecodeObserved(val typed: Typed?, val peek: Peek?)

    private class MergeObserved(val codec: Merge, val update: Typed?, val ofCodec: Typed?, val ofUpdate: Typed?)

    private class EncodeObserved(val set: Typed?, val created: Typed?, val fresh: Merge.Merged?, val ofFresh: Typed?)

    /** As a pin: the typed side writes, whatever the bytes. */
    private val ANY_WRITE: Typed = Typed.Written(ByteArray(0))

    private val NO_BYTES = ByteArray(0)

    private fun matches(pinned: Typed, observed: Typed): Boolean = when (pinned) {
        is Typed.Read -> observed == pinned
        is Typed.Refused -> observed is Typed.Refused && observed.exception == pinned.exception &&
            observed.message.contains(pinned.message, ignoreCase = true)
        is Typed.Written -> observed is Typed.Written
        else -> false
    }

    /**
     * What is wrong with the result of one typed call, or null. A call that was not made must be one
     * that [expectedNotSent] lists for this API level, and one that it lists must not have been made.
     * [sent] is what the call was given. If Android 5 would have been given the same bytes, no text that
     * came back may hold a surrogate, since that text would have ended the process there: this way a
     * run on a newer device shows that what came back is safe on Android 5.
     */
    private fun typedDifference(id: String, call: Call, sdk: Int, sent: ByteArray, pinned: Typed, observed: Typed?): String? {
        val rule = expectedNotSent(sdk).firstOrNull { it.row == id && it.call == call }?.rule
        return when {
            observed == null -> "$call was not made"
            observed is Typed.NotSent -> if (observed.rule == rule) null else "$call was not made (${observed.rule})"
            rule != null -> "$call was made, where $rule keeps it from the binding on API $sdk"
            texts(observed).any { text -> text.any { it.isSurrogate() } } && readScreen(id, sent, ANDROID_5) == null ->
                "$call returned text that Android 5 could not take: ${show(observed)}"
            !matches(pinned, observed) -> "$call gave ${show(observed)} where ${if (pinned === ANY_WRITE) "a write" else show(pinned)} is pinned"
            else -> null
        }
    }

    private fun texts(t: Typed): List<String> = when (t) {
        is Typed.Read -> listOfNotNull(t.name, t.type, t.description, t.color)
        is Typed.Refused -> listOf(t.message)
        else -> emptyList()
    }

    private fun decodeClass(typed: Typed?, peek: Peek?): DecodeClass? = when (typed) {
        is Typed.Read -> when {
            peek == null -> DecodeClass.CODEC_REFUSES
            peek.name == typed.name && peek.mtime == typed.mtime -> DecodeClass.SAME
            else -> DecodeClass.VALUE_DIFFERS
        }
        is Typed.Refused -> if (peek == null) DecodeClass.BOTH_REFUSE else DecodeClass.TYPED_REFUSES
        else -> null
    }

    /** The class of [row] as its results make it, set against the class and the reason the row gives. */
    private fun decodeDifferences(row: Row, o: DecodeObserved, sdk: Int): List<String> {
        val out = ArrayList<String>()
        fun say(what: String) {
            out += "decode ${row.id}: $what".take(DIFFERENCE_CUT)
        }
        typedDifference(row.id, Call.READ, sdk, row.raw, row.typed, o.typed)?.let(::say)
        if (o.peek != row.peek) say("peek gave ${show(o.peek)} where ${show(row.peek)} is pinned")
        if (out.isNotEmpty() || o.typed is Typed.NotSent) return out
        val computed = decodeClass(o.typed, o.peek)
        val why = row.why
        when {
            computed != row.decode -> say("the results make it $computed, and the row says ${row.decode}")
            why == null && !row.decode.agreement -> say("${row.decode} needs a reason")
            why != null && why.of != row.decode -> say("the reason $why does not belong to ${row.decode}")
        }
        return out
    }

    private fun kind(m: Merge): String = when (m) {
        is Merge.Merged -> MERGED
        is Merge.Refused -> "Refused(${m.key}, ${m.why})"
        is Merge.NotAMap -> NOT_A_MAP
    }

    /** The class when the codec merged or not, and the typed update wrote (true), refused at its read (false) or was kept from a setter (null). */
    private fun mergeClass(codecMerged: Boolean, typedWrote: Boolean?): MergeClass? = when (typedWrote) {
        true -> if (codecMerged) MergeClass.BOTH_WRITE else MergeClass.TYPED_ONLY
        false -> if (codecMerged) MergeClass.CODEC_ONLY else MergeClass.NEITHER
        null -> if (codecMerged) MergeClass.CODEC_ALONE else null
    }

    /** What is wrong with a merge pin on its own, given the pinned typed read of the input, or null. */
    private fun pinProblem(input: Typed, pin: MergePin): String? {
        val why = pin.why
        // The typed update writes exactly where the typed read of the input is pinned as a read.
        val computed = mergeClass(pin.codec == MERGED, if (pin.merge == MergeClass.CODEC_ALONE) null else input is Typed.Read)
        return when {
            computed != pin.merge -> "its pins make it $computed, and it says ${pin.merge}"
            why == null && pin.merge.needsReason -> "${pin.merge} needs a reason"
            why != null && why.of != pin.merge -> "the reason $why does not belong to ${pin.merge}"
            (pin.identical != null) != (pin.merge == MergeClass.BOTH_WRITE) -> "byte identity is pinned where both write, and only there"
            pin.identical == true && why != null -> "outputs that differ in shape cannot be pinned as the same bytes"
            else -> null
        }
    }

    private fun mergeDifferences(case: MergeCase, o: MergeObserved, sdk: Int): List<String> {
        val pin = case.pin
        val out = ArrayList<String>()
        fun say(what: String) {
            out += "merge ${case.id}: $what".take(DIFFERENCE_CUT)
        }
        val codecKind = kind(o.codec)
        if (codecKind != pin.codec) {
            say("the codec gave $codecKind where ${pin.codec} is pinned" +
                (o.ofCodec?.let { ", and the typed decoder makes ${show(it)} of its output" } ?: ""))
            return out
        }
        val typedWrites = pin.merge == MergeClass.BOTH_WRITE || pin.merge == MergeClass.TYPED_ONLY
        typedDifference(case.id, Call.UPDATE, sdk, case.raw, if (typedWrites) ANY_WRITE else case.input, o.update)?.let {
            say(it)
            return out
        }
        // An input that the read screen keeps out on this API level is compared no further than the codec's answer above.
        if (o.update is Typed.NotSent && !o.update.rule.setter) return out
        val computed = mergeClass(o.codec is Merge.Merged, if (o.update is Typed.NotSent) null else o.update is Typed.Written)
        if (computed != pin.merge) {
            say("the results make it $computed, and the row says ${pin.merge}")
            return out
        }

        val input = case.input as? Typed.Read
        val reads = Typed.Read(case.written, case.mtime, input?.type, input?.description, input?.color)
        val both = Peek(case.written, case.mtime)
        val merged = o.codec as? Merge.Merged
        val written = (o.update as? Typed.Written)?.bytes
        if (merged != null) {
            if (merged.name != case.written) say("the codec reports the name ${text(merged.name)} where ${text(case.written)} is pinned")
            NoteMetaCodec.peek(merged.bytes).let { if (it != both) say("peek reads the codec's output as ${show(it)}, not as ${show(both)}") }
            entriesDifference(case.raw, merged.bytes)?.let(::say)
            // Where the input is refused for something the merge copies, the output is refused the same way.
            val pinned = if (pin.why == MergeReason.STILL_REFUSED) case.input else reads
            typedDifference(case.id, Call.READ_CODEC_OUTPUT, sdk, merged.bytes, pinned, o.ofCodec)?.let(::say)
        }
        if (written != null) {
            NoteMetaCodec.peek(written).let { if (it != both) say("peek reads the typed output as ${show(it)}, not as ${show(both)}") }
            typedDifference(case.id, Call.READ_TYPED_OUTPUT, sdk, written, reads, o.ofUpdate)?.let(::say)
            val keys = entries(written)?.map { keyName(it.key) }
            if (keys != pin.keys) say("the typed output has the keys $keys where ${pin.keys} are pinned")
        }
        if (merged != null && written != null && merged.bytes.contentEquals(written) != pin.identical) {
            say(
                if (pin.identical == true) "the two outputs are pinned as the same bytes and differ ${firstDifference(merged.bytes, written)}"
                else "the two outputs are the same bytes and are pinned as different"
            )
        }
        return out
    }

    private fun encodeDifferences(row: EncodeRow, o: EncodeObserved, sdk: Int): List<String> {
        val out = ArrayList<String>()
        fun say(what: String) {
            out += "encode ${row.id}: $what".take(DIFFERENCE_CUT)
        }
        fun bytes(call: Call, observed: Typed?): ByteArray? {
            typedDifference(row.id, call, sdk, NO_BYTES, ANY_WRITE, observed)?.let(::say)
            return (observed as? Typed.Written)?.bytes
        }
        if (row.hex != null) {
            val created = bytes(Call.CREATE, o.created) ?: return out
            val pinned = unhex(row.hex)
            if (!created.contentEquals(pinned)) say("the typed writer's bytes are not the pinned ones: they differ ${firstDifference(created, pinned)}")
            return out
        }
        val name = row.fields.name.orEmpty()
        val mtime = row.fields.mtime ?: 0L
        val set = bytes(Call.WRITE, o.set)
        val fresh = o.fresh
        if (fresh == null) {
            say("the codec wrote nothing")
            return out
        }
        if (fresh.name != name) say("the codec reports the name ${text(fresh.name)} where ${text(name)} is pinned")
        if (set != null) {
            if (!set.contentEquals(fresh.bytes)) say("the typed writer and the codec differ ${firstDifference(set, fresh.bytes)}")
            NoteMetaCodec.peek(set).let { if (it != Peek(name, mtime)) say("peek reads the typed writer's bytes as ${show(it)}") }
        }
        typedDifference(row.id, Call.READ_CODEC_OUTPUT, sdk, fresh.bytes, Typed.Read(name, mtime), o.ofFresh)?.let(::say)
        if (row.alsoCreated) {
            val created = bytes(Call.CREATE, o.created)
            if (created != null && set != null && !created.contentEquals(set)) {
                say("create and set give different bytes: they differ ${firstDifference(created, set)}")
            }
        }
        return out
    }

    // ---- the outputs, read with the test's own walker ----

    /** One top-level entry of a map: the bytes of its key and the bytes of its value. */
    private class Entry(val key: ByteArray, val value: ByteArray)

    /** Where the value that starts at [at] ends, or -1 when it does not fit. Containers are walked with a counter. */
    private fun valueEnd(b: ByteArray, at: Int): Int {
        var pos = at
        var pending = 1L
        while (pending > 0) {
            if (pos >= b.size) return -1
            val h = head(b, pos) ?: return -1
            pending += h.children - 1
            pos = h.end
        }
        return pos
    }

    /** The top-level entries of [b], or null when it is not exactly one map. */
    private fun entries(b: ByteArray): List<Entry>? {
        if (b.isEmpty()) return null
        val type = b[0].toInt() and 0xff
        if (type !in 0x80..0x8f && type != 0xde && type != 0xdf) return null
        val top = head(b, 0) ?: return null
        val out = ArrayList<Entry>(top.count)
        var at = top.end
        repeat(top.count) {
            val keyEnd = valueEnd(b, at)
            val end = if (keyEnd < 0) -1 else valueEnd(b, keyEnd)
            if (end < 0) return null
            out += Entry(b.copyOfRange(at, keyEnd), b.copyOfRange(keyEnd, end))
            at = end
        }
        return if (at == b.size) out else null
    }

    /** The text of a key that is a string of printable ASCII, at any width; any other key as its bytes in hex. */
    private fun keyName(key: ByteArray): String {
        val type = key[0].toInt() and 0xff
        val h = head(key, 0)
        val string = type in 0xa0..0xbf || type in 0xd9..0xdb
        return if (h != null && string && (h.from until h.end).all { key[it] in 0x20..0x7e }) String(key, h.from, h.end - h.from, Charsets.US_ASCII)
        else "0x" + hex(key)
    }

    /**
     * What the codec's output lost, changed or gained, or null. Every entry of the input other than the
     * ones under the plain name and mtime keys must be in the output with the same key bytes and value
     * bytes and in the same order, next to exactly one name entry and one mtime entry.
     */
    private fun entriesDifference(raw: ByteArray, output: ByteArray): String? {
        fun other(e: Entry) = keyName(e.key) !in NAME_MTIME
        val before = entries(raw)?.filter(::other) ?: return "the input is not one map"
        val all = entries(output) ?: return "the codec's output is not one map"
        for (key in NAME_MTIME) {
            val count = all.count { keyName(it.key) == key }
            if (count != 1) return "the codec's output has $count entries under $key"
        }
        val after = all.filter(::other)
        if (after.size != before.size) return "the codec's output has ${after.size} other entries where the input has ${before.size}"
        for (i in before.indices) {
            if (!after[i].key.contentEquals(before[i].key)) return "entry $i of the codec's output has the key ${hex(after[i].key)}, not ${hex(before[i].key)}"
            if (!after[i].value.contentEquals(before[i].value)) {
                return "entry $i of the codec's output, ${keyName(before[i].key)}, changed: the values differ ${firstDifference(after[i].value, before[i].value)}"
            }
        }
        return null
    }

    // ---- text for logs and failure messages: ASCII, and cut before it is built ----

    private const val HEX = "0123456789abcdef"
    private const val LOG_CUT = 120
    private const val DIFFERENCE_CUT = 300
    private const val SHOWN_DIFFERENCES = 40

    private fun unhex(s: String) = ByteArray(s.length / 2) { ((Character.digit(s[2 * it], 16) shl 4) or Character.digit(s[2 * it + 1], 16)).toByte() }

    /** At most [limit] bytes of [b] from [from] on, in hex. */
    private fun hex(b: ByteArray, from: Int = 0, limit: Int = 24): String {
        val end = minOf(b.size, from + limit)
        val out = StringBuilder(2 * (end - from) + 3)
        for (i in from until end) {
            val v = b[i].toInt() and 0xff
            out.append(HEX[v shr 4]).append(HEX[v and 0x0f])
        }
        if (end < b.size) out.append("...")
        return out.toString()
    }

    /** The first [cut] chars of [s] in quotes, with everything outside printable ASCII as a backslash-u escape. */
    private fun text(s: String?, cut: Int = 60): String {
        if (s == null) return "null"
        val out = StringBuilder(cut + 24).append('"')
        for (i in 0 until minOf(s.length, cut)) {
            val c = s[i].code
            if (c in 0x20..0x7e && c != 0x5c) {
                out.append(s[i])
            } else {
                out.append('\\').append('u').append(HEX[c shr 12]).append(HEX[(c shr 8) and 0x0f]).append(HEX[(c shr 4) and 0x0f]).append(HEX[c and 0x0f])
            }
        }
        out.append('"')
        if (s.length > cut) out.append("... (").append(s.length).append(" chars)")
        return out.toString()
    }

    private fun show(p: Peek?): String = if (p == null) "null" else "Peek(name=${text(p.name)}, mtime=${p.mtime})"

    private fun show(t: Typed?, cut: Int = 60): String = when (t) {
        null -> "no call"
        is Typed.Read -> buildString {
            append("Read(name=").append(text(t.name, cut)).append(", mtime=").append(t.mtime)
            t.type?.let { append(", type=").append(text(it, cut)) }
            t.description?.let { append(", description=").append(text(it, cut)) }
            t.color?.let { append(", color=").append(text(it, cut)) }
            append(')')
        }
        is Typed.Refused -> "Refused(${text(t.exception, cut)}: ${text(t.message, cut)})"
        is Typed.Written -> "Written(${t.bytes.size} bytes: ${hex(t.bytes)})"
        is Typed.NotSent -> "NotSent(${t.rule})"
        Typed.RawChanged -> "RawChanged"
    }

    private fun firstDifference(a: ByteArray, b: ByteArray): String {
        var i = 0
        while (i < a.size && i < b.size && a[i] == b[i]) i++
        return "at offset $i of ${a.size} and ${b.size} bytes, ${hex(a, i, 8)} against ${hex(b, i, 8)}"
    }

    // ---- the run ----

    /**
     * Runs every row against the binding, on a scratch item of [itemMgr]'s notebook. The caller checks
     * the report against [expectedCompared] and [expectedNotSent], so a run that lost rows or sent
     * nothing cannot pass by having no difference.
     */
    fun run(itemMgr: ItemManager, sdk: Int): Report {
        val binding = Binding(itemMgr, sdk)
        val notSent = ArrayList<NotSentCall>()
        val differences = ArrayList<String>()

        /** Whether the call was made. One that a screen kept out goes into the report. */
        fun made(id: String, call: Call, result: Typed?): Boolean {
            if (result is Typed.NotSent) notSent += NotSentCall(id, call, result.rule)
            return result != null && result !is Typed.NotSent
        }

        /** Whether the row was compared. It was not when the read screen kept its input out. */
        fun merge(case: MergeCase): Boolean {
            val update = binding.typedUpdate(case.id, case.raw, case.name, case.mtime)
            made(case.id, Call.UPDATE, update)
            val inputKeptOut = update is Typed.NotSent && !update.rule.setter
            val codec = NoteMetaCodec.merge(case.raw, case.name, case.mtime)
            val ofCodec = (codec as? Merge.Merged)?.takeUnless { inputKeptOut }?.let { binding.typedRead(case.id, Call.READ_CODEC_OUTPUT, it.bytes) }
            made(case.id, Call.READ_CODEC_OUTPUT, ofCodec)
            val ofUpdate = (update as? Typed.Written)?.let { binding.typedRead(case.id, Call.READ_TYPED_OUTPUT, it.bytes) }
            made(case.id, Call.READ_TYPED_OUTPUT, ofUpdate)
            differences += mergeDifferences(case, MergeObserved(codec, update, ofCodec, ofUpdate), sdk)
            return !inputKeptOut
        }

        var decoded = 0
        for (row in ROWS) {
            val typed = binding.typedRead(row.id, Call.READ, row.raw)
            if (made(row.id, Call.READ, typed)) decoded++
            differences += decodeDifferences(row, DecodeObserved(typed, NoteMetaCodec.peek(row.raw)), sdk)
        }
        val merged = ROWS.count { merge(it.mergeCase()) }
        val extraMerged = EXTRA_MERGES.count { merge(it) }
        var encoded = 0
        for (row in ENCODE_ROWS) {
            val observed = if (row.hex != null) {
                EncodeObserved(null, binding.typedWrite(row.id, Call.CREATE, row.fields), null, null)
            } else {
                val set = binding.typedWrite(row.id, Call.WRITE, row.fields)
                val created = if (row.alsoCreated) binding.typedWrite(row.id, Call.CREATE, row.fields) else null
                val fresh = NoteMetaCodec.fresh(row.fields.name.orEmpty(), row.fields.mtime ?: 0L)
                EncodeObserved(set, created, fresh, binding.typedRead(row.id, Call.READ_CODEC_OUTPUT, fresh.bytes))
            }
            val calls = listOf(Call.WRITE to observed.set, Call.CREATE to observed.created, Call.READ_CODEC_OUTPUT to observed.ofFresh)
            if (calls.count { (call, result) -> made(row.id, call, result) } > 0) encoded++
            differences += encodeDifferences(row, observed, sdk)
        }
        val compared = Compared(decoded, merged, encoded, extraMerged)
        Log.i(TAG, "done: $compared, ${notSent.size} calls not made, ${differences.size} differences")
        return Report(compared, notSent, differences)
    }

    // ---- the fixed inputs, for a comparison that makes no call into the binding ----

    /** One merge of the table: its bytes, and the name and mtime the table writes onto them. */
    class FixedMerge(val id: String, val raw: ByteArray, val name: String, val mtime: Long)

    /**
     * Every merge of the table in its order, the rows and then the extra merges. A read-only view for
     * [NoteMetaLibraryComparison], which runs the same inputs through the codec and through the form
     * of the merge that is written on msgpack-core. Nothing here calls the binding.
     */
    fun fixedMerges(): List<FixedMerge> = (ROWS.map { it.mergeCase() } + EXTRA_MERGES).map { FixedMerge(it.id, it.raw, it.name, it.mtime) }

    /** Every pair of name and mtime of the encode direction, in its order. */
    fun fixedFreshPairs(): List<Pair<String, Long>> = ENCODE_ROWS.filter { it.hex == null }.map { it.fields.name.orEmpty() to (it.fields.mtime ?: 0L) }

    // ---- the checks of this file itself, with no call into the binding ----

    private fun tableProblems(rows: List<Row>, encode: List<EncodeRow>, extra: List<MergeCase>): List<String> {
        val out = ArrayList<String>()
        if (rows.map { it.id }.toSet().size != rows.size) out += "a row id is repeated"
        if (rows.map { it.hex }.toSet().size != rows.size) out += "an input is repeated"
        for (cls in DecodeClass.values()) {
            val count = rows.count { it.decode == cls }
            if (count != DECODE_TALLY[cls]) out += "$count rows are $cls, not ${DECODE_TALLY[cls]}"
        }
        for (cls in MergeClass.values()) {
            val count = rows.count { it.merge.merge == cls }
            if (count != MERGE_TALLY[cls]) out += "$count rows are $cls, not ${MERGE_TALLY[cls]}"
        }
        for (row in rows) pinProblem(row.typed, row.merge)?.let { out += "${row.id}: $it" }
        for (case in extra) pinProblem(case.input, case.pin)?.let { out += "${case.id}: $it" }
        val everywhere = expectedCompared(Int.MAX_VALUE)
        if (rows.size != everywhere.decode || rows.size != everywhere.merge) out += "${rows.size} rows, not ${everywhere.decode}"
        if (extra.size != everywhere.extraMerge) out += "${extra.size} extra merges, not ${everywhere.extraMerge}"
        if (encode.size != everywhere.encode) out += "${encode.size} encode rows, not ${everywhere.encode}"
        if (encode.count { it.hex == null } != ENCODE_PAIRS) out += "${encode.count { it.hex == null }} encode pairs, not $ENCODE_PAIRS"
        if (encode.count { it.hex != null } != ENCODE_TYPED_ONLY) out += "${encode.count { it.hex != null }} typed-only rows, not $ENCODE_TYPED_ONLY"
        if (encode.map { it.id }.toSet().size != encode.size) out += "an encode row id is repeated"
        return out
    }

    /** A str 32 of the letter y that is [size] bytes with its header. */
    private fun longString(size: Int): ByteArray {
        val b = ByteArray(size) { 0x79 }
        b[0] = 0xdb.toByte()
        for (i in 0..3) b[1 + i] = ((size - 5) ushr (8 * (3 - i))).toByte()
        return b
    }

    /**
     * Shows, before any call into the binding, that the screens keep out what they must, that the walker
     * reads entries right, that the table matches its tallies, and that the comparison reports each kind
     * of hand-made difference exactly once. It works on the same functions the run uses and throws on the
     * first thing that does not hold.
     */
    fun selfCheck() {
        fun expect(holds: Boolean, what: String) {
            if (!holds) throw AssertionError("the comparison's own check failed: $what")
        }
        fun none(what: String, differences: List<String>) = expect(differences.isEmpty(), "$what gives no difference, and gave $differences")
        fun one(what: String, differences: List<String>, naming: String) =
            expect(differences.size == 1 && naming in differences[0], "$what gives one difference that says '$naming', and gave $differences")

        // The read screen. The API level is a parameter, so both of its branches run on every device.
        val cart = unhex(WEB_UNICODE_TITLE)
        expect(readScreen("webUnicodeTitle", cart, 21) == Rule.FOUR_BYTE_TEXT, "a four-byte character is kept out on API 21")
        expect(readScreen("webUnicodeTitle", cart, 22) == Rule.FOUR_BYTE_TEXT, "a four-byte character is kept out on API 22")
        expect(readScreen("webUnicodeTitle", cart, 23) == null, "a four-byte character is sent on API 23")
        expect(readScreen("webUnicodeTitle", cart, 36) == null, "a four-byte character is sent on API 36")
        expect(readScreen("webNote", cart, 36) == Rule.FOUR_BYTE_TEXT, "a four-byte character is sent only for the rows named for it")
        val keptOut = listOf(
            "" to Rule.EMPTY,
            "81a178c1" to Rule.NOT_WALKABLE, // the reserved type
            "81a178dbffffffff" to Rule.NOT_WALKABLE, // a length past the end
            "81a178dfffffffff" to Rule.NOT_WALKABLE, // a count past the end
            "82a46e616d65a241" to Rule.NOT_WALKABLE, // cut inside a payload
            "81" to Rule.NOT_WALKABLE, // a header and nothing after it
            "82a46e616d65a3410042a56d74696d6501" to Rule.NUL_IN_TEXT,
            "81a17891919101" to Rule.TOO_DEEP_OR_TOO_MANY, // four deep
            "dc0013" + "00".repeat(19) to Rule.TOO_DEEP_OR_TOO_MANY, // nineteen elements
        )
        for ((input, rule) in keptOut) for (sdk in listOf(21, 36)) {
            expect(readScreen("control", unhex(input), sdk) == rule, "$input is kept out by $rule on API $sdk")
        }
        expect(readScreen("control", longString(MAX_BYTES + 1), 36) == Rule.TOO_LARGE, "one byte over the size bound is kept out")
        for (input in listOf("81a178919101", "dc0012" + "00".repeat(18), "82a46e616d65a141")) for (sdk in listOf(21, 36)) {
            expect(readScreen("control", unhex(input), sdk) == null, "$input is sent on API $sdk")
        }
        expect(readScreen("control", longString(MAX_BYTES), 21) == null, "the size bound itself is sent")

        // The setter screen.
        val noSetter = listOf(
            LONE_SURROGATE_TITLE to Rule.SETTER_SURROGATE,
            "x\u0000y" to Rule.SETTER_NUL,
            "\uD83D\uDED2" to Rule.SETTER_SURROGATE,
            "y".repeat(MAX_SETTER_CHARS + 1) to Rule.SETTER_TOO_LONG,
        )
        for ((s, rule) in noSetter) expect(setterScreen(s) == rule, "${text(s)} is kept from a setter by $rule")
        for (s in listOf("", "Typed", "Eink\u00E4ufe \u2713", "y".repeat(MAX_SETTER_CHARS))) expect(setterScreen(s) == null, "${text(s)} may go to a setter")

        // The walker, against keys and values written out by hand.
        fun pairs(input: String) = entries(unhex(input))?.map { hex(it.key, 0, 64) + ":" + hex(it.value, 0, 64) }
        expect(
            pairs(WEB_NOTE_EXTRA) == listOf("a46e616d65:a947726f636572696573", "a56d74696d65:cf0000019980a63400", "a56578747261:a76b6565702d6d65"),
            "the entries of a map of three",
        )
        expect(pairs("de0002a46e616d65a141a56d74696d6501") == listOf("a46e616d65:a141", "a56d74696d65:01"), "the entries of a map 16")
        expect(pairs("92a141a142") == null && pairs(WEB_NOTE + "00") == null && pairs("82a46e616d65a141") == null, "what is not exactly one map has no entries")

        // The table: its tallies, and every row against its own pins.
        none("the table", tableProblems(ROWS, ENCODE_ROWS, EXTRA_MERGES))
        expect(tableProblems(ROWS.drop(1), ENCODE_ROWS, EXTRA_MERGES).isNotEmpty(), "a table with one row removed does not match the tallies")
        for (row in ROWS) none("row ${row.id} with what it pins", decodeDifferences(row, DecodeObserved(row.typed, row.peek), 36))

        // Decoding: one hand-made difference at a time.
        fun decode(row: Row, typed: Typed, peek: Peek?, sdk: Int = 36) = decodeDifferences(row, DecodeObserved(typed, peek), sdk)
        val plain = same("control", WEB_NOTE, reads("Groceries", T0), bothWrite(identical = true))
        val groceries = peek("Groceries", T0)
        none("a read as pinned", decode(plain, reads("Groceries", T0), groceries))
        one("a typed name one character off", decode(plain, reads("Grocerie", T0), groceries), "name=\"Grocerie\"")
        one("a typed mtime off by one", decode(plain, reads("Groceries", T0 + 1), groceries), "mtime=${T0 + 1}")
        one("a typed type", decode(plain, reads("Groceries", T0, type = "t"), groceries), "type=\"t\"")
        one("a typed description", decode(plain, reads("Groceries", T0, description = "d"), groceries), "description=\"d\"")
        one("a typed color", decode(plain, reads("Groceries", T0, color = "c"), groceries), "color=\"c\"")
        one("a peek that gives null where a value is pinned", decode(plain, reads("Groceries", T0), null), "peek gave null")
        one("a typed read that was not made", decode(plain, Typed.NotSent(Rule.NOT_WALKABLE), groceries), "was not made")
        one("text Android 5 could not take, from bytes it would be sent", decode(plain, reads("Groceries \uD83D\uDED2", T0), groceries), "Android 5")

        val refusing = typedRefuses("control", WEB_FLOAT_MTIME, "expected i64", peek("Float", T0), FLOAT_MTIME, codecOnly(REPAIRED))
        val float = peek("Float", T0)
        val refusal = Typed.Refused(MSGPACK, "invalid type: floating point `1758800000000.5`, expected i64")
        none("a refusal as pinned", decode(refusing, refusal, float))
        one("a read where a refusal is pinned", decode(refusing, reads("Float", T0), float), "gave Read(")
        one("a refusal where a read is pinned", decode(plain, refusal, groceries), "gave Refused(")
        one("a refusal for another reason", decode(refusing, Typed.Refused(MSGPACK, "duplicate field `mtime`"), float), "duplicate field")
        one("another exception class", decode(refusing, Typed.Refused("EncryptionException", refusal.message), float), "EncryptionException")

        val notOneMap = bothRefuse("control", "c0", "expected struct ItemMetadata", neither(NOT_A_MAP))
        val notStruct = Typed.Refused(MSGPACK, "invalid type: unit value, expected struct ItemMetadata")
        none("two refusals", decode(notOneMap, notStruct, null))
        one("a peek that reads where null is pinned", decode(notOneMap, notStruct, peek(null, null)), "peek gave Peek(")
        val nilName = same("control", "82a46e616d65c0a56d74696d6501", reads(null, 1), bothWrite(identical = true))
        one("an empty name where null is pinned", decode(nilName, reads(null, 1), peek("", 1)), "name=\"\"")

        val alias = "82c4046e616d65a141a56d74696d6501"
        val aliasPin = typedOnly(ALIAS_REWRITTEN, aliased("name"))
        val wrongClass = Row("control", alias, reads("A", 1), peek(null, 1), DecodeClass.SAME, null, aliasPin)
        one("a row whose class is not what its results make", decode(wrongClass, reads("A", 1), peek(null, 1)), "VALUE_DIFFERS")
        val wrongReason = Row("control", alias, reads("A", 1), peek(null, 1), DecodeClass.VALUE_DIFFERS, TRAILING, aliasPin)
        one("a reason of another class", decode(wrongReason, reads("A", 1), peek(null, 1)), "TRAILING")

        val fourByte = ROWS.first { it.id == "webUnicodeTitle" }
        none("a four-byte row that is not sent below API 23", decode(fourByte, Typed.NotSent(Rule.FOUR_BYTE_TEXT), fourByte.peek, sdk = 21))
        one("a four-byte row that is not sent on API 23", decode(fourByte, Typed.NotSent(Rule.FOUR_BYTE_TEXT), fourByte.peek, sdk = 23), "was not made")
        one("a four-byte row that is sent below API 23", decode(fourByte, fourByte.typed, fourByte.peek, sdk = 21), "was made")

        // Encoding: the two writers one byte of width apart, with every decoded value still equal.
        val pair = EncodeRow("control", reads("Typed", T0))
        fun encode(set: String) = encodeDifferences(
            pair, EncodeObserved(Typed.Written(unhex(set)), null, Merge.Merged(unhex(TYPED_NAME_MTIME), "Typed"), reads("Typed", T0)), 36,
        )
        none("two writers that give the same bytes", encode(TYPED_NAME_MTIME))
        one("two writers one integer width apart", encode(TYPED_NAME_MTIME.replace("cf0000019980a63400", "d30000019980a63400")), "at offset")
        val later = EncodeRow("control", reads("Typed", T0 + 1))
        val written = unhex(TYPED_NAME_MTIME)
        one(
            "typed bytes that peek reads as another mtime",
            encodeDifferences(later, EncodeObserved(Typed.Written(written), null, Merge.Merged(written, "Typed"), later.fields), 36),
            "peek reads the typed writer's bytes",
        )

        // Merging. These are the bytes of NEW_NAME and NEW_MTIME under their keys, and of two entries no side reads.
        val name = "a46e616d65b24d6572676564207469746c6520e29c932032"
        val mtime = "a56d74696d65cf00000199869c157b"
        val extra = "a56578747261a76b6565702d6d65"
        val more = "a16b01"
        val read = reads(NEW_NAME, NEW_MTIME)
        fun merge(case: MergeCase, codec: Merge, update: Typed?, ofCodec: Typed?, ofUpdate: Typed?) =
            mergeDifferences(case, MergeObserved(codec, update, ofCodec, ofUpdate), 36)
        fun both(case: MergeCase, codec: String, update: String, ofCodec: Typed? = read) =
            merge(case, Merge.Merged(unhex(codec), NEW_NAME), Typed.Written(unhex(update)), ofCodec, read)

        val twoUnknown = MergeCase(
            "control", unhex("84a46e616d65a947726f636572696573a56d74696d65cf0000019980a63400$extra$more"), reads("Groceries", T0),
            NEW_NAME, NEW_MTIME, NEW_NAME, bothWrite(identical = false, UNKNOWN_DROPPED),
        )
        val kept = "84$name$mtime$extra$more"
        val typedOutput = "82$name$mtime"
        none("a merge that keeps what the typed update drops", both(twoUnknown, kept, typedOutput))
        one("an unknown entry missing from the codec's output", both(twoUnknown, "83$name$mtime$extra", typedOutput), "other entries")
        one("one byte changed in an unknown value", both(twoUnknown, "84$name$mtime${extra.dropLast(2)}66$more", typedOutput), "changed")
        one("one entry more in the codec's output", both(twoUnknown, "85$name$mtime$extra${more}a17a02", typedOutput), "other entries")
        one("a key in the typed output that is not pinned", both(twoUnknown, kept, "83a474797065a0$name$mtime"), "has the keys")
        one("a read of the codec's output that was not made", both(twoUnknown, kept, typedOutput, ofCodec = Typed.NotSent(Rule.TOO_DEEP_OR_TOO_MANY)), "was not made")
        one("a read of the codec's output that was never asked for", both(twoUnknown, kept, typedOutput, ofCodec = null), "READ_CODEC_OUTPUT was not made")
        one("a codec output that peek reads as another mtime", both(twoUnknown, "84$name${mtime.dropLast(2)}7c$extra$more", typedOutput), "peek reads the codec's output")

        val typedMade = MergeCase("control", unhex(TYPED_NAME_MTIME), reads("Typed", T0), NEW_NAME, NEW_MTIME, NEW_NAME, bothWrite(identical = true))
        none("two outputs that are the same bytes", both(typedMade, typedOutput, typedOutput))
        one("two outputs pinned as the same bytes, one byte apart", both(typedMade, typedOutput, "82${name}a56d74696d65d300000199869c157b"), "differ at offset")
        val widerKey = MergeCase("control", unhex("82d9046e616d65a141a56d74696d6501"), reads("A", 1), NEW_NAME, NEW_MTIME, NEW_NAME, bothWrite(identical = false))
        one("two outputs pinned as different that are the same bytes", both(widerKey, typedOutput, typedOutput), "pinned as different")

        val refusedCase = MergeCase("control", unhex(alias), reads("A", 1), NEW_NAME, NEW_MTIME, NEW_NAME, aliasPin)
        val update = Typed.Written(unhex(typedOutput))
        none("a refusal of the codec as pinned", merge(refusedCase, Merge.Refused("name", NoteMetaCodec.Why.ALIASED), update, null, read))
        one("a merge where a refusal is pinned", merge(refusedCase, Merge.Merged(unhex(kept), NEW_NAME), update, null, read), "the codec gave Merged")
        one("a refusal for the other key", merge(refusedCase, Merge.Refused("mtime", NoteMetaCodec.Why.ALIASED), update, null, read), "Refused(mtime, ALIASED)")

        val lone = EXTRA_MERGES.first { it.id == "loneSurrogate" }
        val replaced = Merge.Merged(unhex("82a46e616d65a541efbfbd42a56d74696d6507"), lone.written)
        val noSetterCall = Typed.NotSent(Rule.SETTER_SURROGATE)
        none("a name no setter may take, on the codec's side alone", merge(lone, replaced, noSetterCall, reads(lone.written, 7), null))
        one("a reported name that is not the name written", merge(lone, Merge.Merged(replaced.bytes, lone.name), noSetterCall, reads(lone.written, 7), null), "reports the name")
        one("a typed update of a name no setter may take", merge(lone, replaced, Typed.Written(replaced.bytes), reads(lone.written, 7), null), "was made")
    }
}
