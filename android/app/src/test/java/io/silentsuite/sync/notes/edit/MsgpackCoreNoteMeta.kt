package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.NoteMetaCodec.Merge
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Peek
import org.msgpack.core.MessageFormat
import org.msgpack.core.MessageFormat.*
import org.msgpack.core.MessageIntegerOverflowException
import org.msgpack.core.MessagePack
import org.msgpack.core.MessageUnpacker

/*
 * Test only. merge, fresh and peek of NoteMetaCodec written a second time on the low-level API of
 * msgpack-core 0.9.12, so that the two can be compared input by input (NoteMetaCodecComparisonTest).
 * Nothing in this file ships: forms (a) and (b) are test code. On the branch of the library evaluation
 * the library is an implementation dependency and form (c) is in main code, where the app does not
 * use it (see the head of NoteMetaMsgpack.kt).
 *
 * The three forms, which the rest of this file and the comparison test call variants. The public
 * result of the comparison names them (a), (b) and (c), in the order of Walk: (a) is LIBRARY_SKIP,
 * (b) is LEAF_SKIP, (c) is HEADERS_ONLY. Form (c), which never calls skipValue, is the class
 * NoteMetaMsgpack in a file of its own, NoteMetaMsgpack.kt, together with the scan and every rule
 * above the format layer. Forms (a) and (b) are in this file: each is that class with steps of its
 * own for passing over a key or a value, and those steps call skipValue. In both files the letters
 * (a), (b) and (c) mean these three forms and nothing else.
 *
 * What is the library's and what is the app's. The library does the format layer: which format comes
 * next, the header and typed reads, the position, and the packer's widths. Everything above that is a
 * rule of the codec and is the same code or a copy of it, held once for the three forms in
 * NoteMetaMsgpack.kt: the scan loop, the two checks of a count against the bytes left, the two
 * slots, the key rules (webMayRead, regionEquals), the order of the refusals and of the output,
 * finiteToLong, and the strict decoder for the name. wellFormed is the codec's own function, called
 * from there.
 * Agreement between the codec and a variant therefore shows that the two format layers give the same
 * byte ranges, formats, numbers and widths. It does not test those rules, and it cannot show a
 * mistake that both sides share. The independent check of the codec's own skipping of nested values
 * is LIBRARY_SKIP on input the codec accepts: there every count is at most the size of the input,
 * far below the 2^30 at which skipValue fails, and its result has to equal the codec's.
 *
 * What this comment says about the inside of the library (how skipValue counts, when addPayload
 * copies, what readPayload(int) and readPayloadAsReference allocate, what UnpackerConfig can limit)
 * is from reading the 0.9.12 sources, not from a run. What was observed on the jar is pinned by the
 * tests of NoteMetaCodecComparisonTest that call the library directly: the buffer class, skipValue
 * on a map32 header, the widths the writers choose, packString on an unpaired surrogate, the default
 * and the strict unpacker settings, and unpackLong above Long.MAX_VALUE.
 *
 * Requirement by requirement, each part marked with the way it is met: [call] is one direct library
 * call, [slice] is possible only by slicing the original array at offsets taken from
 * getTotalReadBytes, [none] is not possible through the library.
 *
 * R1  One map that uses every byte: [call] getNextFormat is FIXMAP, MAP16 or MAP32, then unpackMapHeader
 *     (an int; MessageSizeException for a count of 2^31 or more); [call] hasNext is false after the walk.
 *     The early check of the count against the bytes left is app code and needs the position: [slice].
 * R2  Every other key and value is copied byte for byte: [slice] only. The offsets before and after each
 *     key and value come from getTotalReadBytes, and that span of the original array goes to the
 *     packer with addPayload. addPayload copies the span into the packer's buffer when it fits there
 *     and is at most the flush threshold (8192 by default); any other span is added by reference.
 *     writePayload always copies. The value model (unpackValue, the method of CVE-2026-90472, then
 *     packValue) is not used and was not run: it decodes and encodes again, which is what R2 rules
 *     out.
 *     Passing over a value whose content is not needed, three ways (see Walk):
 *       LIBRARY_SKIP  skipValue on every key and value. On a map32 header that declares from 2^30
 *                     to 2^31 - 1 entries it returns normally in the middle of the input
 *                     (CVE-2026-90473); from 2^31 on it throws MessageSizeException. Not usable on
 *                     a container.
 *       LEAF_SKIP     An app loop with a long counter that is checked against the bytes left. Maps
 *                     go through unpackMapHeader, arrays through unpackArrayHeader, the reserved
 *                     byte 0xc1 (format NEVER_USED) is refused, a key in an unsigned integer format
 *                     is read with unpackLong (R6), and every other value goes through skipValue.
 *                     skipValue decrements its counter for every value; a value that is not a
 *                     container adds nothing to it, so the counter goes from 1 to 0 and the
 *                     branches that add a container count are not reached. This still calls the
 *                     method the advisory names.
 *       HEADERS_ONLY  No skipValue. NIL unpackNil; BOOLEAN unpackBoolean; POSFIXINT, NEGFIXINT,
 *                     UINT8, UINT16, UINT32 and INT8 to INT64 unpackLong; UINT64 unpackBigInteger
 *                     (a BigInteger per value, two above Long.MAX_VALUE; unpackLong throws there);
 *                     FLOAT32 and FLOAT64 unpackDouble;
 *                     FIXSTR and STR8 to STR32 unpackRawStringHeader; BIN8 to BIN32
 *                     unpackBinaryHeader; FIXEXT1 to FIXEXT16 and EXT8 to EXT32
 *                     unpackExtensionTypeHeader (one small object per ext value). The payload bytes
 *                     are read into a scratch array with readPayload(array, 0, n) after an app check
 *                     of the length against the bytes left, since the unpacker's own skip for
 *                     payload bytes is private. readPayload(int) and readPayloadAsReference are not
 *                     used: both can allocate from the declared length.
 * R3  Replace in place, or append: finding the value is [slice]; writing is [call]: packRawStringHeader plus
 *     addPayload for the name, packLong for mtime, packString for the two appended key names.
 * R4  The map header at the smallest width for the new count: [call] packMapHeader.
 * R5  A repeated plain key: app code. The format is [call] getNextFormat; the key bytes are [slice].
 * R6  Aliases. Unsigned integer keys: [call] getNextFormat is POSFIXINT or UINT8 to UINT64, and the
 *     careful variants then read the key with unpackLong on the walk's own unpacker, which allocates
 *     nothing; a value above Long.MAX_VALUE arrives as MessageIntegerOverflowException after the
 *     nine bytes are consumed, which costs one exception for such a key. (LIBRARY_SKIP has no typed
 *     read on the walk, so it decodes the key through a second unpacker, which allocates per integer
 *     key.) Binary keys: [call] the format, [slice] the bytes. Malformed UTF-8 that the web reads leniently:
 *     [none] through the library; [slice] with the codec's webMayRead on the raw bytes.
 * R7  Strict UTF-8 for the name that peek returns: possible as [call] with an UnpackerConfig whose two
 *     coding actions are REPORT and unpackString, but that takes a second unpacker and its decode
 *     buffer of 8192 chars for every call. In NoteMetaMsgpack.kt the name is decoded as [slice]: the
 *     app's own strict decoder over the raw slice, as the codec does. The comparison test pins what
 *     unpackString does on both settings.
 * R8  mtime numbers: [call] unpackLong for the integer formats (MessageIntegerOverflowException gives
 *     null), unpackDouble for the two float formats, then the codec's finiteToLong. One second
 *     unpacker for each peek, not for each entry.
 * R9  Limits. Lengths and counts against the bytes left: app code with [slice] the position; the library
 *     itself only fails when a read runs out of input (MessageInsufficientBufferException) or a
 *     32-bit field is 2^31 or more (MessageSizeException). No recursion: the app loop. Nothing kept
 *     for an entry: the scan holds the array, the count, the body start and two slots; what the
 *     library allocates on the way is measured in the comparison test. UnpackerConfig has one limit
 *     on a size, stringSizeLimit, which applies to unpackString and unpackValue only (bufferSize
 *     and stringDecoderBufferSize set buffer sizes, not limits); it cannot express any of these
 *     limits.
 * R10 Writer widths: [call]. The U+FFFD rule stays app code in front of the writer; packString alone
 *     writes a question mark for an unpaired surrogate.
 */

/**
 * Test only: the three forms of merge, fresh and peek on msgpack-core that NoteMetaCodecComparisonTest
 * compares with [NoteMetaCodec], chosen by [Walk]. Form (c) is [NoteMetaMsgpack]; forms (a) and (b),
 * which call skipValue, are the two private subclasses here.
 */
internal class MsgpackCoreNoteMeta(walk: Walk) {
    enum class Walk {
        /** Form (a). skipValue() on every key and value: the library's own skip, the method of CVE-2026-90473. */
        LIBRARY_SKIP,

        /** Form (b). Containers through header reads and a checked counter; skipValue() only on values that are not containers. */
        LEAF_SKIP,

        /** Form (c). No skipValue() at all: every format through its header read or typed read. It is [NoteMetaMsgpack] itself. */
        HEADERS_ONLY,
    }

    internal val form: NoteMetaMsgpack = when (walk) {
        Walk.LIBRARY_SKIP -> LibrarySkip()
        Walk.LEAF_SKIP -> LeafSkip()
        Walk.HEADERS_ONLY -> NoteMetaMsgpack()
    }

    fun merge(raw: ByteArray?, name: String, mtime: Long): Merge = form.merge(raw, name, mtime)

    fun fresh(name: String, mtime: Long): Merge.Merged = form.fresh(name, mtime)

    fun peek(raw: ByteArray?): Peek? = form.peek(raw)

    /** Form (a): the scan and the rules of [NoteMetaMsgpack], with skipValue() in place of its two steps over a key and over a value. */
    private class LibrarySkip : NoteMetaMsgpack() {
        override fun passKey(u: MessageUnpacker, raw: ByteArray, f: MessageFormat, start: Int): Long {
            val unsigned = f == POSFIXINT || f == UINT8 || f == UINT16 || f == UINT32 || f == UINT64
            u.skipValue()
            if (!unsigned) return NO_INDEX
            // This variant has no typed read on the walk, so the key is decoded a second time, through an
            // unpacker of its own: several small objects for every integer key.
            return try {
                STRICT.newUnpacker(raw, start, u.totalReadBytes.toInt() - start).unpackLong()
            } catch (e: MessageIntegerOverflowException) {
                NO_INDEX
            }
        }

        override fun pass(u: MessageUnpacker, raw: ByteArray) {
            u.skipValue()
        }
    }

    /**
     * Form (b): the scan, the rules and the container loop of [NoteMetaMsgpack], with skipValue() on every
     * value that is not a container, except a key in an unsigned integer format.
     */
    private class LeafSkip : NoteMetaMsgpack() {
        override fun leaf(u: MessageUnpacker, f: MessageFormat, raw: ByteArray) {
            u.skipValue()
        }
    }

    companion object {
        /** The unpacker settings of the three forms, the same object as in [NoteMetaMsgpack]; the comparison test reads the library through them too. */
        internal val STRICT: MessagePack.UnpackerConfig = NoteMetaMsgpack.STRICT
    }
}
