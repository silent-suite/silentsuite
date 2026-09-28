package io.silentsuite.sync.notes.edit

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * Note metadata is a msgpack map that every client writes: the web, other Etebase apps, and this
 * app. The binding's typed `ItemMetadata` drops any field it does not know (measured in the spike),
 * so a save merges only `name` and `mtime` into the raw map and copies every other entry byte for
 * byte, the way the web keeps other clients' fields.
 *
 * The input comes from collaborators in shared notebooks, so it is parsed defensively: every length
 * and container count is checked against the bytes that remain before any work, skipping is
 * iterative so deep nesting costs no stack, and nothing is kept per entry, so memory does not grow
 * with the number of entries.
 */
internal object NoteMetaCodec {

    sealed class Merge {
        /**
         * The merged map: one map, no trailing bytes, header at the smallest width for its count.
         * [name] is the name as written (an unpaired surrogate becomes U+FFFD), which is what a typed
         * read of the result returns. The web reads it the same, with one exception: it decodes a
         * string over 200 bytes with TextDecoder, which drops a leading U+FEFF, so such a title
         * starting with that invisible character reads there without it. The title is written as
         * typed, as the web writes its own, and the web reads its own such titles without it too.
         */
        class Merged(val bytes: ByteArray, val name: String) : Merge()

        /** Which value is current cannot be known, so the save is refused rather than guessed. */
        data class Refused(val key: String, val why: Why) : Merge()

        /** Not exactly one well-formed map. The caller falls back to typed metadata and logs it. */
        data class NotAMap(val reason: String) : Merge()
    }

    enum class Why {
        /** The plain string key appears more than once. */
        REPEATED,

        /**
         * Another client reads a different key as this one: the typed decoder maps unsigned integer
         * keys 1 and 2 to name and mtime and matches binary keys by their bytes, and the web decodes
         * malformed UTF-8 in keys leniently. Writing the plain key next to it would give the typed
         * decoder a duplicate field and the web a different value than Android sees.
         */
        ALIASED,
    }

    /** `name` and `mtime` as another client wrote them, readable even where the typed decoder fails. */
    data class Peek(val name: String?, val mtime: Long?)

    private val NAME = "name".toByteArray(Charsets.UTF_8)
    private val MTIME = "mtime".toByteArray(Charsets.UTF_8)

    fun merge(raw: ByteArray?, name: String, mtime: Long): Merge {
        val scan = try {
            scan(raw)
        } catch (e: Malformed) {
            return Merge.NotAMap(e.message ?: "malformed")
        }
        for (slot in arrayOf(scan.name, scan.mtime)) {
            if (slot.aliases > 0) return Merge.Refused(slot.key, Why.ALIASED)
            if (slot.plain > 1) return Merge.Refused(slot.key, Why.REPEATED)
        }
        val bytes = scan.bytes
        val written = wellFormed(name)
        val out = ByteArrayOutputStream(bytes.size + written.length * 3 + 32)
        writeMapHeader(out, scan.count + (if (scan.name.plain == 0) 1 else 0) + (if (scan.mtime.plain == 0) 1 else 0))
        // At most two values are replaced; everything between them is copied in one piece.
        val present = listOf(scan.name, scan.mtime).filter { it.plain == 1 }.sortedBy { it.valueStart }
        var from = scan.bodyStart
        for (slot in present) {
            out.write(bytes, from, slot.valueStart - from)
            if (slot === scan.name) writeString(out, written) else writeInt(out, mtime)
            from = slot.valueEnd
        }
        out.write(bytes, from, bytes.size - from)
        if (scan.name.plain == 0) {
            writeString(out, "name")
            writeString(out, written)
        }
        if (scan.mtime.plain == 0) {
            writeString(out, "mtime")
            writeInt(out, mtime)
        }
        return Merge.Merged(out.toByteArray(), written)
    }

    /**
     * Reads `name` (a string of valid UTF-8) and `mtime` (an integer, or a finite float truncated
     * toward zero) without the typed decoder. Null when the input is not one well-formed map; a field
     * that is missing, repeated, aliased, or of another type comes back as null.
     */
    fun peek(raw: ByteArray?): Peek? {
        val scan = try {
            scan(raw)
        } catch (e: Malformed) {
            return null
        }
        val name = scan.name.takeIf { it.trusted }?.let { stringValue(scan.bytes, it.valueStart) }
        val mtime = scan.mtime.takeIf { it.trusted }?.let { numberValue(scan.bytes, it.valueStart) }
        return Peek(name, mtime)
    }

    /**
     * Replaces each unpaired surrogate with U+FFFD, so the UTF-8 written is exactly the string a
     * typed read returns. `String.toByteArray` would write `?` instead, silently.
     */
    internal fun wellFormed(s: String): String {
        var sb: StringBuilder? = null
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) {
                sb?.append(c)?.append(s[i + 1])
                i += 2
                continue
            }
            if (Character.isSurrogate(c)) {
                if (sb == null) sb = StringBuilder(s.length).append(s, 0, i)
                sb.append('�')
            } else {
                sb?.append(c)
            }
            i++
        }
        return sb?.toString() ?: s
    }

    // ---- parsing ----

    private class Malformed(message: String) : Exception(message)

    /** Where one of the two keys this app writes was found. */
    private class Slot(val key: String) {
        /** Occurrences under the plain string key. */
        var plain = 0

        /** Occurrences under a key another client reads as this one (see [Why.ALIASED]). */
        var aliases = 0

        /** The first plain occurrence's value; only used when [plain] is 1. */
        var valueStart = -1
        var valueEnd = -1

        val trusted get() = plain == 1 && aliases == 0
    }

    private class Scan(val bytes: ByteArray, val count: Long, val bodyStart: Int) {
        val name = Slot("name")
        val mtime = Slot("mtime")
    }

    private enum class KeyKind { OTHER, NAME, MTIME, NAME_ALIAS, MTIME_ALIAS }

    /** Exactly one map that uses every byte of [raw], read in one pass. */
    private fun scan(raw: ByteArray?): Scan {
        if (raw == null || raw.isEmpty()) throw Malformed("empty")
        val reader = Reader(raw)
        val count = reader.mapHeader() ?: throw Malformed("the top level is not a map")
        reader.requirePending(2 * count)
        val scan = Scan(raw, count, reader.pos)
        for (i in 0 until count) {
            val keyStart = reader.pos
            reader.skipValue()
            val keyEnd = reader.pos
            reader.skipValue()
            val kind = keyKind(raw, keyStart, keyEnd)
            val slot = when (kind) {
                KeyKind.OTHER -> continue
                KeyKind.NAME, KeyKind.NAME_ALIAS -> scan.name
                KeyKind.MTIME, KeyKind.MTIME_ALIAS -> scan.mtime
            }
            if (kind == KeyKind.NAME || kind == KeyKind.MTIME) {
                if (slot.plain++ == 0) {
                    slot.valueStart = keyEnd
                    slot.valueEnd = reader.pos
                }
            } else {
                slot.aliases++
            }
        }
        if (reader.pos != raw.size) throw Malformed("trailing bytes after the map")
        return scan
    }

    private fun keyKind(b: ByteArray, start: Int, end: Int): KeyKind {
        val type = b[start].toInt() and 0xff
        return when {
            type in 0xa0..0xbf || type in 0xd9..0xdb -> {
                val from = start + headerSize(type)
                when {
                    regionEquals(b, from, end, NAME) -> KeyKind.NAME
                    regionEquals(b, from, end, MTIME) -> KeyKind.MTIME
                    webMayRead(b, from, end, NAME) -> KeyKind.NAME_ALIAS
                    webMayRead(b, from, end, MTIME) -> KeyKind.MTIME_ALIAS
                    else -> KeyKind.OTHER
                }
            }
            type in 0xc4..0xc6 -> {
                val from = start + headerSize(type)
                when {
                    regionEquals(b, from, end, NAME) -> KeyKind.NAME_ALIAS
                    regionEquals(b, from, end, MTIME) -> KeyKind.MTIME_ALIAS
                    else -> KeyKind.OTHER
                }
            }
            // Unsigned integers are field indexes to the typed decoder, in the order of its fields.
            type <= 0x7f || type in 0xcc..0xcf -> {
                val index = if (type <= 0x7f) type.toLong() else unsigned(b, start + 1, end - start - 1)
                val field = if (index in 0..TYPED_FIELDS.lastIndex) TYPED_FIELDS[index.toInt()] else null
                when (field) {
                    "name" -> KeyKind.NAME_ALIAS
                    "mtime" -> KeyKind.MTIME_ALIAS
                    else -> KeyKind.OTHER
                }
            }
            else -> KeyKind.OTHER
        }
    }

    /**
     * The typed decoder's fields in order, which is how it reads an unsigned integer key (measured on a
     * device for 1 and 2). A note merge writes only name and mtime, so only those two are refused as
     * aliases here; a notebook merge, which also writes description and color, must refuse 3 and 4 too.
     */
    private val TYPED_FIELDS = listOf("type", "name", "mtime", "description", "color")

    /**
     * Whether the web's decoder could read the key bytes in [from, end) as [target]. The web decodes
     * with @msgpack/msgpack 1.12.2, the same way in the browser as in Node, because Next.js provides
     * `process` in the browser bundle: a string of up to 200 bytes, key or value, goes through
     * utf8DecodeJs, and a longer one through TextDecoder; keys of up to 16 bytes are also cached by
     * their bytes. utf8DecodeJs does not validate: overlong forms decode to ASCII, and a sequence cut off
     * at the end of the key reads on into the bytes after it, so a cut-off sequence counts as a match.
     * TextDecoder turns malformed bytes into U+FFFD, so a key over 200 bytes never reads as a short
     * one, and checking every length is a safe superset. Valid UTF-8 decodes exactly, so a valid key
     * matches only when its bytes equal [target].
     */
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

    private fun headerSize(type: Int): Int = when (type) {
        0xd9, 0xc4 -> 2
        0xda, 0xc5 -> 3
        0xdb, 0xc6 -> 5
        else -> 1
    }

    private fun regionEquals(b: ByteArray, from: Int, end: Int, target: ByteArray): Boolean {
        if (end - from != target.size) return false
        for (i in target.indices) if (b[from + i] != target[i]) return false
        return true
    }

    /** The string at [at], decoded as strict UTF-8, or null when it is not a string or not valid. */
    private fun stringValue(b: ByteArray, at: Int): String? {
        val type = b[at].toInt() and 0xff
        val length = when {
            type in 0xa0..0xbf -> (type and 0x1f).toLong()
            type == 0xd9 -> unsigned(b, at + 1, 1)
            type == 0xda -> unsigned(b, at + 1, 2)
            type == 0xdb -> unsigned(b, at + 1, 4)
            else -> return null
        }
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(b, at + headerSize(type), length.toInt()))
                .toString()
        } catch (e: CharacterCodingException) {
            null
        }
    }

    private fun numberValue(b: ByteArray, at: Int): Long? {
        val type = b[at].toInt() and 0xff
        return when {
            type <= 0x7f -> type.toLong()
            type >= 0xe0 -> (type - 0x100).toLong()
            type == 0xcc -> unsigned(b, at + 1, 1)
            type == 0xcd -> unsigned(b, at + 1, 2)
            type == 0xce -> unsigned(b, at + 1, 4)
            type == 0xcf -> signed(b, at + 1, 8).takeIf { it >= 0 } // above Long.MAX_VALUE: not a usable mtime
            type == 0xd0 -> signed(b, at + 1, 1)
            type == 0xd1 -> signed(b, at + 1, 2)
            type == 0xd2 -> signed(b, at + 1, 4)
            type == 0xd3 -> signed(b, at + 1, 8)
            type == 0xca -> finiteToLong(java.lang.Float.intBitsToFloat(signed(b, at + 1, 4).toInt()).toDouble())
            type == 0xcb -> finiteToLong(java.lang.Double.longBitsToDouble(signed(b, at + 1, 8)))
            else -> null
        }
    }

    private fun finiteToLong(d: Double): Long? =
        if (d.isFinite() && d >= Long.MIN_VALUE.toDouble() && d < Long.MAX_VALUE.toDouble()) d.toLong() else null

    private class Reader(val bytes: ByteArray) {
        var pos = 0

        private fun remaining() = bytes.size - pos

        private fun need(n: Long) {
            if (n < 0 || n > remaining()) throw Malformed("a length runs past the end of the input")
        }

        private fun u(n: Int): Long {
            need(n.toLong())
            val v = unsigned(bytes, pos, n)
            pos += n
            return v
        }

        private fun skip(n: Long) {
            need(n)
            pos += n.toInt()
        }

        /** Every value takes at least one byte, so more values than bytes left is refused up front. */
        fun requirePending(values: Long) {
            if (values < 0 || values > remaining()) throw Malformed("a container count runs past the end of the input")
        }

        /** The entry count when the next value is a map, else null (and nothing consumed). */
        fun mapHeader(): Long? {
            need(1)
            val type = bytes[pos].toInt() and 0xff
            return when {
                type in 0x80..0x8f -> { pos++; (type and 0x0f).toLong() }
                type == 0xde -> { pos++; u(2) }
                type == 0xdf -> { pos++; u(4) }
                else -> null
            }
        }

        /**
         * Skips one value, containers included, without recursion: a counter holds the values still
         * to skip. Each step consumes at least one byte and the counter never exceeds the bytes left,
         * so the work is linear in the input and the stack does not grow with nesting.
         */
        fun skipValue() {
            var pending = 1L
            while (pending > 0) {
                pending--
                val type = u(1).toInt()
                val children: Long = when {
                    type <= 0x7f || type >= 0xe0 -> 0 // fixint
                    type in 0x80..0x8f -> 2L * (type and 0x0f)
                    type in 0x90..0x9f -> (type and 0x0f).toLong()
                    type in 0xa0..0xbf -> { skip((type and 0x1f).toLong()); 0 }
                    else -> when (type) {
                        0xc0, 0xc2, 0xc3 -> 0 // nil, false, true
                        0xc4, 0xd9 -> { skip(u(1)); 0 } // bin8, str8
                        0xc5, 0xda -> { skip(u(2)); 0 } // bin16, str16
                        0xc6, 0xdb -> { skip(u(4)); 0 } // bin32, str32
                        0xc7 -> { skip(u(1) + 1); 0 } // ext8: type byte + data
                        0xc8 -> { skip(u(2) + 1); 0 }
                        0xc9 -> { skip(u(4) + 1); 0 }
                        0xca -> { skip(4); 0 }
                        0xcb -> { skip(8); 0 }
                        0xcc, 0xd0 -> { skip(1); 0 }
                        0xcd, 0xd1 -> { skip(2); 0 }
                        0xce, 0xd2 -> { skip(4); 0 }
                        0xcf, 0xd3 -> { skip(8); 0 }
                        0xd4 -> { skip(2); 0 } // fixext1: type byte + 1
                        0xd5 -> { skip(3); 0 }
                        0xd6 -> { skip(5); 0 }
                        0xd7 -> { skip(9); 0 }
                        0xd8 -> { skip(17); 0 }
                        0xdc -> u(2)
                        0xdd -> u(4)
                        0xde -> 2 * u(2)
                        0xdf -> 2 * u(4)
                        else -> throw Malformed("reserved type 0x%02x".format(type)) // only 0xc1 is left
                    }
                }
                pending += children
                requirePending(pending)
            }
        }
    }

    private fun unsigned(bytes: ByteArray, at: Int, n: Int): Long {
        var v = 0L
        for (i in 0 until n) v = (v shl 8) or (bytes[at + i].toLong() and 0xff)
        return v
    }

    private fun signed(bytes: ByteArray, at: Int, n: Int): Long {
        val v = unsigned(bytes, at, n)
        val shift = 64 - 8 * n
        return (v shl shift) shr shift
    }

    // ---- writing, always at the smallest width ----

    internal fun writeMapHeader(out: ByteArrayOutputStream, count: Long) {
        when {
            count <= 15 -> out.write(0x80 or count.toInt())
            count <= 0xffff -> { out.write(0xde); writeBigEndian(out, count, 2) }
            else -> { out.write(0xdf); writeBigEndian(out, count, 4) }
        }
    }

    internal fun writeString(out: ByteArrayOutputStream, s: String) {
        val b = s.toByteArray(Charsets.UTF_8)
        when {
            b.size <= 31 -> out.write(0xa0 or b.size)
            b.size <= 0xff -> { out.write(0xd9); writeBigEndian(out, b.size.toLong(), 1) }
            b.size <= 0xffff -> { out.write(0xda); writeBigEndian(out, b.size.toLong(), 2) }
            else -> { out.write(0xdb); writeBigEndian(out, b.size.toLong(), 4) }
        }
        out.write(b)
    }

    internal fun writeInt(out: ByteArrayOutputStream, v: Long) {
        when {
            v in 0..0x7f -> out.write(v.toInt())
            v in -32..-1 -> out.write(v.toInt() and 0xff)
            v in 0..0xff -> { out.write(0xcc); writeBigEndian(out, v, 1) }
            v in 0..0xffff -> { out.write(0xcd); writeBigEndian(out, v, 2) }
            v in 0..0xffffffffL -> { out.write(0xce); writeBigEndian(out, v, 4) }
            v >= 0 -> { out.write(0xcf); writeBigEndian(out, v, 8) }
            v >= Byte.MIN_VALUE -> { out.write(0xd0); writeBigEndian(out, v, 1) }
            v >= Short.MIN_VALUE -> { out.write(0xd1); writeBigEndian(out, v, 2) }
            v >= Int.MIN_VALUE -> { out.write(0xd2); writeBigEndian(out, v, 4) }
            else -> { out.write(0xd3); writeBigEndian(out, v, 8) }
        }
    }

    private fun writeBigEndian(out: ByteArrayOutputStream, v: Long, n: Int) {
        for (i in n - 1 downTo 0) out.write(((v ushr (8 * i)) and 0xff).toInt())
    }
}
