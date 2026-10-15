package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.NoteMetaCodec.Merge
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Peek
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Why
import org.msgpack.core.MessageFormat
import org.msgpack.core.MessageFormat.*
import org.msgpack.core.MessageIntegerOverflowException
import org.msgpack.core.MessagePack
import org.msgpack.core.MessageUnpacker
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/*
 * Test only. This file is form (c) of the comparison of NoteMetaCodec with msgpack-core 0.9.12:
 * merge, fresh and peek of the codec, written on the library's low-level API in the way that never
 * calls skipValue. The public result of the comparison names its three forms (a), (b) and (c), and
 * NoteMetaCodecComparisonTest runs this one under the name HEADERS_ONLY. Nothing here ships: the
 * library is a testImplementation dependency, and the app uses NoteMetaCodec.
 *
 * The file holds the whole form, so that what it calls can be checked by reading this file alone:
 * the scan, the walk over keys and values, and the rules above the format layer. Those rules are
 * the codec's, written a second time here. The refusal loop in merge, webMayRead, regionEquals and
 * finiteToLong are the codec's text unchanged; the two slots are the codec's without its comments;
 * the strict decoder for the name differs in one line. The scan loop, the two checks of a count
 * against the bytes left and the key kinds are the same rules written again on the library's reads,
 * and the order of the output on its packer. This is their only copy in the test sources.
 * wellFormed and the result types are the codec's own.
 *
 * Forms (a) and (b) are in another test file. They do call skipValue, and they run the scan and the
 * rules of this file with steps of their own for passing over a key or a value. That is the only
 * reason why the class and its three steps passKey, pass and leaf are open. An object made as
 * NoteMetaMsgpack() runs the steps of this file and no others. The comparison makes its
 * HEADERS_ONLY side that way, and the test described below checks that too.
 *
 * Library calls this file makes:
 *   - MessagePack.UnpackerConfig: the four settings of STRICT, and newUnpacker over a byte array
 *     (the whole input in the scan, the one value of mtime in peek).
 *   - MessageUnpacker: getNextFormat, hasNext and getTotalReadBytes; unpackMapHeader and
 *     unpackArrayHeader; unpackNil, unpackBoolean, unpackLong, unpackBigInteger and unpackDouble;
 *     unpackRawStringHeader, unpackBinaryHeader and unpackExtensionTypeHeader (and the length of
 *     the header it returns); and readPayload(array, 0, n) into the scratch array of this object.
 *   - MessageFormat: the format constants, and valueOf on one byte.
 *   - MessagePack.PackerConfig: withBufferSize and newBufferPacker.
 *   - MessageBufferPacker: packMapHeader, packRawStringHeader, addPayload, packLong and
 *     toByteArray, and packString for the two key names "name" and "mtime" only.
 *   - MessageIntegerOverflowException is caught by name. Any other RuntimeException or IOException
 *     thrown in the scan is caught: merge returns NotAMap with the simple name of that class as its
 *     reason, and peek gives null. An Error is not caught here; the comparison catches Throwable
 *     and fails on it. The calls after the scan (the packer in merge; in peek MessageFormat.valueOf
 *     for the name and the second unpacker for mtime) are outside that handling, as the comments
 *     there say.
 *
 * Library calls this file never makes: skipValue, the method of CVE-2026-90473; unpackValue, the
 * method of CVE-2026-90472; packValue; unpackString; readPayloadAsReference; and readPayload with
 * one argument. A test in NoteMetaCodecComparisonTest reads this file and fails if one of those
 * names, or the name of the class that holds forms (a) and (b), stands anywhere outside this
 * comment, or if the code below names readPayload more than once.
 */

/** Test only: form (c): merge, fresh and peek of [NoteMetaCodec] on msgpack-core's low-level API. */
internal open class NoteMetaMsgpack {
    private class NotOneMap(message: String) : Exception(message)

    private class Slot(val key: String) {
        var plain = 0
        var aliases = 0
        var valueStart = -1
        var valueEnd = -1
        val trusted get() = plain == 1 && aliases == 0
    }

    private class Scan(val raw: ByteArray, val count: Int, val bodyStart: Int) {
        val name = Slot("name")
        val mtime = Slot("mtime")
    }

    private enum class KeyKind { OTHER, NAME, MTIME, NAME_ALIAS, MTIME_ALIAS }

    private val scratch = ByteArray(4096)

    fun merge(raw: ByteArray?, name: String, mtime: Long): Merge {
        val scan = try {
            scan(raw)
        } catch (e: NotOneMap) {
            return Merge.NotAMap(e.message ?: "malformed")
        } catch (e: RuntimeException) {
            // Fail closed: every MessagePackException is a RuntimeException, and any other
            // RuntimeException out of the library or its buffer class is treated the same. The reason
            // names the class, so the comparison can list which ones occurred.
            return Merge.NotAMap(e.javaClass.simpleName)
        } catch (e: IOException) {
            // Declared by the unpacker's read methods; an array input has no reason to throw it.
            return Merge.NotAMap(e.javaClass.simpleName)
        }
        for (slot in arrayOf(scan.name, scan.mtime)) {
            if (slot.aliases > 0) return Merge.Refused(slot.key, Why.ALIASED)
            if (slot.plain > 1) return Merge.Refused(slot.key, Why.REPEATED)
        }
        // From here on the offsets are the scan's. An exception below would be a defect, and it is left to
        // reach the comparison, which reports it as a line.
        val written = NoteMetaCodec.wellFormed(name)
        val nameBytes = written.toByteArray(Charsets.UTF_8)
        val packer = PACKER.newBufferPacker()
        fun copy(from: Int, to: Int) {
            if (to > from) packer.addPayload(scan.raw, from, to - from)
        }
        fun writeName() {
            packer.packRawStringHeader(nameBytes.size)
            if (nameBytes.isNotEmpty()) packer.addPayload(nameBytes)
        }
        packer.packMapHeader(scan.count + (if (scan.name.plain == 0) 1 else 0) + (if (scan.mtime.plain == 0) 1 else 0))
        var from = scan.bodyStart
        for (slot in listOf(scan.name, scan.mtime).filter { it.plain == 1 }.sortedBy { it.valueStart }) {
            copy(from, slot.valueStart)
            if (slot === scan.name) writeName() else packer.packLong(mtime)
            from = slot.valueEnd
        }
        copy(from, scan.raw.size)
        if (scan.name.plain == 0) {
            packer.packString("name")
            writeName()
        }
        if (scan.mtime.plain == 0) {
            packer.packString("mtime")
            packer.packLong(mtime)
        }
        return Merge.Merged(packer.toByteArray(), written)
    }

    fun fresh(name: String, mtime: Long): Merge.Merged = merge(byteArrayOf(0x80.toByte()), name, mtime) as Merge.Merged

    fun peek(raw: ByteArray?): Peek? {
        val scan = try {
            scan(raw)
        } catch (e: NotOneMap) {
            return null
        } catch (e: RuntimeException) {
            return null // fail closed, as in merge
        } catch (e: IOException) {
            return null
        }
        // As in merge, the two reads below work on offsets of the scan and are outside the catch: anything
        // thrown there reaches the comparison, which reports it as a line.
        val name = scan.name.takeIf { it.trusted }?.let { stringValue(scan.raw, it.valueStart, it.valueEnd) }
        val mtime = scan.mtime.takeIf { it.trusted }?.let { numberValue(scan.raw, it.valueStart, it.valueEnd) }
        return Peek(name, mtime)
    }

    /** Exactly one map that uses every byte of [raw], read in one pass. */
    private fun scan(raw: ByteArray?): Scan {
        if (raw == null || raw.isEmpty()) throw NotOneMap("empty")
        // Over a byte array the position of the unpacker is the index of the next unread byte.
        val u = STRICT.newUnpacker(raw)
        val top = u.nextFormat
        if (top != FIXMAP && top != MAP16 && top != MAP32) throw NotOneMap("the top level is not a map")
        val count = u.unpackMapHeader()
        val scan = Scan(raw, count, u.totalReadBytes.toInt())
        if (2L * count > raw.size - scan.bodyStart) throw NotOneMap("a container count runs past the end of the input")
        for (i in 0 until count) {
            val keyStart = u.totalReadBytes.toInt()
            val keyFormat = u.nextFormat
            val index = passKey(u, raw, keyFormat, keyStart)
            val keyEnd = u.totalReadBytes.toInt()
            pass(u, raw)
            val valueEnd = u.totalReadBytes.toInt()
            val kind = keyKind(raw, keyFormat, keyStart, keyEnd, index)
            val slot = when (kind) {
                KeyKind.OTHER -> continue
                KeyKind.NAME, KeyKind.NAME_ALIAS -> scan.name
                KeyKind.MTIME, KeyKind.MTIME_ALIAS -> scan.mtime
            }
            if (kind == KeyKind.NAME || kind == KeyKind.MTIME) {
                if (slot.plain++ == 0) {
                    slot.valueStart = keyEnd
                    slot.valueEnd = valueEnd
                }
            } else {
                slot.aliases++
            }
        }
        if (u.hasNext()) throw NotOneMap("trailing bytes after the map")
        return scan
    }

    /**
     * Passes over one key. A key in an unsigned integer format is a field index to the typed decoder, so
     * its value is returned; every other key gives [NO_INDEX].
     */
    protected open fun passKey(u: MessageUnpacker, raw: ByteArray, f: MessageFormat, start: Int): Long {
        val unsigned = f == POSFIXINT || f == UINT8 || f == UINT16 || f == UINT32 || f == UINT64
        if (!unsigned) {
            pass(u, raw)
            return NO_INDEX
        }
        return try {
            u.unpackLong()
        } catch (e: MessageIntegerOverflowException) {
            // Above Long.MAX_VALUE, so not a field index. unpackLong throws after it has consumed the nine
            // bytes; the walk goes on only if the position says so.
            if (u.totalReadBytes != start + 9L) throw NotOneMap("the position after an integer overflow is not the end of the value")
            NO_INDEX
        }
    }

    /** Passes over one value, containers included. */
    protected open fun pass(u: MessageUnpacker, raw: ByteArray) {
        var pending = 1L
        while (pending > 0) {
            pending--
            when (val f = u.nextFormat) {
                FIXMAP, MAP16, MAP32 -> pending += 2L * u.unpackMapHeader()
                FIXARRAY, ARRAY16, ARRAY32 -> pending += u.unpackArrayHeader()
                NEVER_USED -> throw NotOneMap("reserved type 0xc1")
                else -> leaf(u, f, raw)
            }
            // Every value takes at least one byte, so more values than bytes left cannot be there.
            if (pending > raw.size - u.totalReadBytes) throw NotOneMap("a container count runs past the end of the input")
        }
    }

    protected open fun leaf(u: MessageUnpacker, f: MessageFormat, raw: ByteArray) {
        when (f) {
            NIL -> u.unpackNil()
            BOOLEAN -> u.unpackBoolean()
            UINT64 -> u.unpackBigInteger() // unpackLong throws above Long.MAX_VALUE
            POSFIXINT, NEGFIXINT, UINT8, UINT16, UINT32, INT8, INT16, INT32, INT64 -> u.unpackLong()
            FLOAT32, FLOAT64 -> u.unpackDouble()
            FIXSTR, STR8, STR16, STR32 -> payload(u, u.unpackRawStringHeader(), raw)
            BIN8, BIN16, BIN32 -> payload(u, u.unpackBinaryHeader(), raw)
            FIXEXT1, FIXEXT2, FIXEXT4, FIXEXT8, FIXEXT16, EXT8, EXT16, EXT32 -> payload(u, u.unpackExtensionTypeHeader().length, raw)
            else -> error("containers and 0xc1 are handled by the caller")
        }
    }

    /**
     * MessageUnpacker's skip for payload bytes is private, so they are read into a scratch array. The
     * length is checked against the bytes left first; nothing is allocated from it.
     */
    private fun payload(u: MessageUnpacker, length: Int, raw: ByteArray) {
        if (length < 0 || length > raw.size - u.totalReadBytes) throw NotOneMap("a length runs past the end of the input")
        var left = length
        while (left > 0) {
            val n = minOf(left, scratch.size)
            u.readPayload(scratch, 0, n)
            left -= n
        }
    }

    private fun keyKind(raw: ByteArray, f: MessageFormat, start: Int, end: Int, index: Long): KeyKind = when (f) {
        FIXSTR, STR8, STR16, STR32 -> {
            val from = start + headerSize(f)
            when {
                regionEquals(raw, from, end, NAME_BYTES) -> KeyKind.NAME
                regionEquals(raw, from, end, MTIME_BYTES) -> KeyKind.MTIME
                webMayRead(raw, from, end, NAME_BYTES) -> KeyKind.NAME_ALIAS
                webMayRead(raw, from, end, MTIME_BYTES) -> KeyKind.MTIME_ALIAS
                else -> KeyKind.OTHER
            }
        }
        BIN8, BIN16, BIN32 -> {
            val from = start + headerSize(f)
            when {
                regionEquals(raw, from, end, NAME_BYTES) -> KeyKind.NAME_ALIAS
                regionEquals(raw, from, end, MTIME_BYTES) -> KeyKind.MTIME_ALIAS
                else -> KeyKind.OTHER
            }
        }
        // Unsigned formats only: the typed decoder reads them as field indexes (1 name, 2 mtime); a signed 1 is not one.
        POSFIXINT, UINT8, UINT16, UINT32, UINT64 -> when (index) {
            1L -> KeyKind.NAME_ALIAS
            2L -> KeyKind.MTIME_ALIAS
            else -> KeyKind.OTHER
        }
        else -> KeyKind.OTHER
    }

    private fun headerSize(f: MessageFormat): Int = when (f) {
        STR8, BIN8 -> 2
        STR16, BIN16 -> 3
        STR32, BIN32 -> 5
        else -> 1
    }

    /**
     * The string in [start, end), decoded as strict UTF-8 with the app's own decoder, or null when the
     * value is not a string or not valid. The format comes from the library, the bytes from the array.
     */
    private fun stringValue(raw: ByteArray, start: Int, end: Int): String? {
        val f = MessageFormat.valueOf(raw[start])
        if (f != FIXSTR && f != STR8 && f != STR16 && f != STR32) return null
        val from = start + headerSize(f)
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(raw, from, end - from))
                .toString()
        } catch (e: CharacterCodingException) {
            null
        }
    }

    private fun numberValue(raw: ByteArray, start: Int, end: Int): Long? {
        val u = STRICT.newUnpacker(raw, start, end - start)
        return when (u.nextFormat) {
            FLOAT32, FLOAT64 -> finiteToLong(u.unpackDouble())
            POSFIXINT, NEGFIXINT, UINT8, UINT16, UINT32, UINT64, INT8, INT16, INT32, INT64 -> try {
                u.unpackLong()
            } catch (e: MessageIntegerOverflowException) {
                null // above Long.MAX_VALUE: not a usable mtime
            }
            else -> null
        }
    }

    // ---- copied unchanged from NoteMetaCodec, where they are private: rules of the app, not of the format ----

    private fun webMayRead(b: ByteArray, from: Int, end: Int, target: ByteArray): Boolean {
        var offset = from
        var n = 0
        while (offset < end) {
            if (n == target.size) return false
            val byte1 = b[offset].toInt() and 0xff
            val extra = when {
                byte1 and 0x80 == 0 -> 0
                byte1 and 0xe0 == 0xc0 -> 1
                byte1 and 0xf0 == 0xe0 -> 2
                byte1 and 0xf8 == 0xf0 -> 3
                else -> 0 // a stray continuation byte or 0xf8..0xff is kept as it is
            }
            if (offset + extra >= end) {
                n++ // cut off: its value depends on what follows the key
                break
            }
            var unit = when (extra) {
                0 -> byte1
                3 -> byte1 and 0x07
                else -> byte1 and 0x1f
            }
            for (k in 1..extra) unit = (unit shl 6) or (b[offset + k].toInt() and 0x3f)
            if (unit != (target[n].toInt() and 0xff)) return false
            n++
            offset += extra + 1
        }
        return n == target.size
    }

    private fun regionEquals(b: ByteArray, from: Int, end: Int, target: ByteArray): Boolean {
        if (end - from != target.size) return false
        for (i in target.indices) if (b[from + i] != target[i]) return false
        return true
    }

    private fun finiteToLong(d: Double): Long? =
        if (d.isFinite() && d >= Long.MIN_VALUE.toDouble() && d < Long.MAX_VALUE.toDouble()) d.toLong() else null

    companion object {
        internal const val NO_INDEX = -1L
        private val NAME_BYTES = "name".toByteArray(Charsets.UTF_8)
        private val MTIME_BYTES = "mtime".toByteArray(Charsets.UTF_8)

        /** Both coding actions REPORT and no reading of one raw family as the other. */
        internal val STRICT: MessagePack.UnpackerConfig = MessagePack.UnpackerConfig()
            .withActionOnMalformedString(CodingErrorAction.REPORT)
            .withActionOnUnmappableString(CodingErrorAction.REPORT)
            .withAllowReadingBinaryAsString(false)
            .withAllowReadingStringAsBinary(false)
        private val PACKER = MessagePack.PackerConfig().withBufferSize(512)
    }
}
