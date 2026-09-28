package io.silentsuite.sync.notes.edit

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.IOException
import java.util.zip.CRC32

/**
 * On-disk format of the pending store: a magic number, a format version, the fields, and a CRC32
 * over everything before it. A file that fails any check decodes to [Decoded.Bad] and is kept,
 * never guessed at. A newer format version is also [Decoded.Bad], so a downgrade cannot misread it.
 *
 * Entry files (format 2) put every field except the blob in a header with its own length and CRC32
 * ahead of the blob, so a screen that only counts entries reads a few hundred bytes per file instead
 * of every blob. Format 1 entry files (no header section) are still read, and rewritten as format 2
 * on their next change.
 */
internal object PendingCodec {
    const val ENTRY_FORMAT_VERSION = 2
    const val RECORD_FORMAT_VERSION = 1
    private const val ENTRY_FORMAT_V1 = 1
    private const val ENTRY_MAGIC = 0x53534E50 // "SSNP"
    private const val RECORD_MAGIC = 0x53534E52 // "SSNR"
    private const val KIND_LANDED = 1
    private const val KIND_NOTEBOOK = 2
    private const val KIND_SEQUENCE = 3
    /** The largest blob the store keeps; a larger save is refused before anything is written. */
    const val MAX_BLOB = 64 * 1024 * 1024
    /** Bytes before a format 2 entry header: magic, format version, header length. */
    const val ENTRY_PREFIX = 9
    /** A header only holds uids, counters, and short strings; anything larger is damage. */
    private const val MAX_HEADER = 64 * 1024

    sealed class Decoded<out T> {
        data class Ok<T>(val value: T) : Decoded<T>()
        data class Bad(val reason: String) : Decoded<Nothing>()
    }

    /** What [decodeEntryHeader] found: the header, or that the file is format 1 and needs a full read. */
    sealed class HeaderRead {
        data class Header(val header: PendingNotesStore.EntryHeader) : HeaderRead()
        object NeedsFullRead : HeaderRead()
    }

    fun encodeEntry(e: PendingEntry): ByteArray {
        val header = ByteArrayOutputStream().also { buffer -> DataOutputStream(buffer).use { writeEntryFields(it, e) } }.toByteArray()
        return withChecksum { out ->
            out.writeInt(ENTRY_MAGIC)
            out.writeByte(ENTRY_FORMAT_VERSION)
            out.writeInt(header.size)
            out.write(header)
            out.writeInt(crc(header, header.size))
            writeBlob(out, e.blob)
        }
    }

    fun decodeEntry(bytes: ByteArray): Decoded<PendingEntry> = openEntry(bytes) { format, input ->
        if (format == ENTRY_FORMAT_V1) {
            // Format 1 has the blob right after the fields, so it is read once they are.
            readEntryFields(input) { readBlob(input) }
        } else {
            val header = readHeaderSection(input)
            val blob = readBlob(input)
            DataInputStream(ByteArrayInputStream(header)).use { fields ->
                val entry = readEntryFields(fields) { blob }
                if (fields.available() != 0) throw IOException("trailing header bytes")
                entry
            }
        }
    }

    /**
     * Reads only the header of a format 2 entry from [prefix], the first bytes of the file: at least
     * [ENTRY_PREFIX] plus the header length and 4. The header's own CRC is checked; the blob and the
     * file CRC are not, so a damaged blob is found only by a full read.
     */
    fun decodeEntryHeader(prefix: ByteArray): Decoded<HeaderRead> {
        if (prefix.size < ENTRY_PREFIX) return Decoded.Bad("too short")
        return try {
            DataInputStream(ByteArrayInputStream(prefix)).use { input ->
                if (input.readInt() != ENTRY_MAGIC) return Decoded.Bad("wrong magic")
                when (val format = input.readUnsignedByte()) {
                    ENTRY_FORMAT_V1 -> Decoded.Ok(HeaderRead.NeedsFullRead)
                    ENTRY_FORMAT_VERSION -> {
                        val header = readHeaderSection(input)
                        DataInputStream(ByteArrayInputStream(header)).use { fields ->
                            val e = readEntryFields(fields) { ByteArray(0) }
                            Decoded.Ok(HeaderRead.Header(PendingNotesStore.EntryHeader(e.noteUid, e.notebookUid, e.state, e.version)))
                        }
                    }
                    else -> Decoded.Bad("format version $format")
                }
            }
        } catch (e: EOFException) {
            Decoded.Bad("truncated")
        } catch (e: IOException) {
            Decoded.Bad(e.message ?: "unreadable")
        }
    }

    /** How many bytes of a format 2 entry hold its prefix and header, read from the first [ENTRY_PREFIX] bytes; null when out of range. */
    fun entryHeaderEnd(prefix: ByteArray): Int? {
        if (prefix.size < ENTRY_PREFIX) return null
        val length = ((prefix[5].toInt() and 0xff) shl 24) or ((prefix[6].toInt() and 0xff) shl 16) or
            ((prefix[7].toInt() and 0xff) shl 8) or (prefix[8].toInt() and 0xff)
        return if (length in 0..MAX_HEADER) ENTRY_PREFIX + length + 4 else null
    }

    private fun writeEntryFields(out: DataOutputStream, e: PendingEntry) {
        out.writeUTF(e.noteUid)
        out.writeUTF(e.notebookUid)
        out.writeByte(stateCode(e.state))
        out.writeLong(e.version)
        out.writeUTF(e.revision)
        out.writeBoolean(e.isCreate)
        out.writeInt(e.sent.size)
        e.sent.forEach(out::writeUTF)
        out.writeInt(e.failureCount)
        out.writeLong(e.lastFailureAt ?: -1L)
        out.writeUTF(e.lastFailureCategory.orEmpty())
        out.writeBoolean(e.origin != null)
        e.origin?.let {
            out.writeUTF(it.noteUid)
            out.writeUTF(it.revision)
            out.writeLong(it.version)
            out.writeUTF(it.serverRevision)
        }
        out.writeBoolean(e.held != null)
        e.held?.let {
            out.writeUTF(it.reason.name)
            out.writeLong(it.at)
        }
    }

    /** Reads every field but the blob, then takes the blob from [blob]. */
    private fun readEntryFields(input: DataInputStream, blob: () -> ByteArray): PendingEntry {
        val noteUid = input.readUTF()
        val notebookUid = input.readUTF()
        val state = stateOf(input.readUnsignedByte())
        val version = input.readLong()
        val revision = input.readUTF()
        val isCreate = input.readBoolean()
        val sentCount = input.readInt()
        if (sentCount < 0 || sentCount > PendingEntry.MAX_SENT) throw IOException("sent count $sentCount")
        val sent = List(sentCount) { input.readUTF() }
        val failureCount = input.readInt()
        if (failureCount < 0) throw IOException("failure count $failureCount")
        val lastFailureAt = input.readLong().takeIf { it >= 0 }
        val lastFailureCategory = input.readUTF().ifEmpty { null }
        val origin = if (input.readBoolean()) PendingEntry.Origin(input.readUTF(), input.readUTF(), input.readLong(), input.readUTF()) else null
        val held = if (input.readBoolean()) {
            val reasonName = input.readUTF()
            val reason = HeldReason.values().firstOrNull { it.name == reasonName } ?: throw IOException("held reason $reasonName")
            PendingEntry.Held(reason, input.readLong())
        } else null
        val bytes = blob()
        return try {
            PendingEntry(noteUid, notebookUid, state, version, revision, isCreate, sent, failureCount,
                lastFailureAt, lastFailureCategory, origin, held, bytes)
        } catch (e: IllegalArgumentException) {
            throw IOException(e.message)
        }
    }

    /** The header length, the header, and its CRC; returns the checked header bytes. */
    private fun readHeaderSection(input: DataInputStream): ByteArray {
        val length = input.readInt()
        if (length < 0 || length > MAX_HEADER || length > input.available()) throw IOException("header size $length")
        val header = ByteArray(length).also { input.readFully(it) }
        if (input.readInt() != crc(header, length)) throw IOException("header checksum mismatch")
        return header
    }

    fun encodeLanded(r: LandedRecord): ByteArray = withChecksum { out ->
        out.writeInt(RECORD_MAGIC)
        out.writeByte(RECORD_FORMAT_VERSION)
        out.writeByte(KIND_LANDED)
        out.writeUTF(r.noteUid)
        out.writeUTF(r.revision)
        out.writeLong(r.version)
        writeBlob(out, r.blob)
    }

    fun decodeLanded(bytes: ByteArray): Decoded<LandedRecord> = open(bytes, RECORD_MAGIC) { input ->
        if (input.readUnsignedByte() != KIND_LANDED) throw IOException("not a landed record")
        LandedRecord(input.readUTF(), input.readUTF(), input.readLong(), readBlob(input))
    }

    fun encodeNotebook(notebookUid: String, blob: ByteArray): ByteArray = withChecksum { out ->
        out.writeInt(RECORD_MAGIC)
        out.writeByte(RECORD_FORMAT_VERSION)
        out.writeByte(KIND_NOTEBOOK)
        out.writeUTF(notebookUid)
        writeBlob(out, blob)
    }

    fun decodeNotebook(bytes: ByteArray): Decoded<Pair<String, ByteArray>> = open(bytes, RECORD_MAGIC) { input ->
        if (input.readUnsignedByte() != KIND_NOTEBOOK) throw IOException("not a notebook record")
        input.readUTF() to readBlob(input)
    }

    fun encodeSequence(value: Long): ByteArray = withChecksum { out ->
        out.writeInt(RECORD_MAGIC)
        out.writeByte(RECORD_FORMAT_VERSION)
        out.writeByte(KIND_SEQUENCE)
        out.writeLong(value)
    }

    fun decodeSequence(bytes: ByteArray): Decoded<Long> = open(bytes, RECORD_MAGIC) { input ->
        if (input.readUnsignedByte() != KIND_SEQUENCE) throw IOException("not a sequence record")
        input.readLong()
    }

    private fun stateCode(state: PendingEntry.State) = when (state) {
        PendingEntry.State.UPSERT -> 1
        PendingEntry.State.DELETE -> 2
        PendingEntry.State.HELD -> 3
    }

    private fun stateOf(code: Int) = when (code) {
        1 -> PendingEntry.State.UPSERT
        2 -> PendingEntry.State.DELETE
        3 -> PendingEntry.State.HELD
        else -> throw IOException("state $code")
    }

    private fun writeBlob(out: DataOutputStream, blob: ByteArray) {
        // Refused on the way in, not only on the way out, so nothing is written that could never be read.
        if (blob.size > MAX_BLOB) throw IOException("blob size ${blob.size}")
        out.writeInt(blob.size)
        out.write(blob)
    }

    private fun readBlob(input: DataInputStream): ByteArray {
        val size = input.readInt()
        if (size < 0 || size > MAX_BLOB || size > input.available()) throw IOException("blob size $size")
        return ByteArray(size).also { input.readFully(it) }
    }

    private fun crc(bytes: ByteArray, length: Int): Int = CRC32().apply { update(bytes, 0, length) }.value.toInt()

    /** Writes the fields, then appends a CRC32 over them. */
    private fun withChecksum(write: (DataOutputStream) -> Unit): ByteArray {
        val body = ByteArrayOutputStream()
        DataOutputStream(body).use(write)
        val bytes = body.toByteArray()
        val crc = crc(bytes, bytes.size)
        return bytes + byteArrayOf((crc ushr 24).toByte(), (crc ushr 16).toByte(), (crc ushr 8).toByte(), crc.toByte())
    }

    private fun <T> open(bytes: ByteArray, magic: Int, parse: (DataInputStream) -> T): Decoded<T> =
        checked(bytes, magic) { format, input ->
            if (format != RECORD_FORMAT_VERSION) throw IOException("format version $format")
            parse(input)
        }

    private fun <T> openEntry(bytes: ByteArray, parse: (Int, DataInputStream) -> T): Decoded<T> =
        checked(bytes, ENTRY_MAGIC) { format, input ->
            if (format != ENTRY_FORMAT_V1 && format != ENTRY_FORMAT_VERSION) throw IOException("format version $format")
            parse(format, input)
        }

    /** Checks the CRC and magic, parses, and requires the parse to use every byte. Reads [bytes] in place, without copying. */
    private fun <T> checked(bytes: ByteArray, magic: Int, parse: (Int, DataInputStream) -> T): Decoded<T> {
        if (bytes.size < 9) return Decoded.Bad("too short")
        val bodyLength = bytes.size - 4
        val stored = ((bytes[bodyLength].toInt() and 0xff) shl 24) or ((bytes[bodyLength + 1].toInt() and 0xff) shl 16) or
            ((bytes[bodyLength + 2].toInt() and 0xff) shl 8) or (bytes[bodyLength + 3].toInt() and 0xff)
        if (crc(bytes, bodyLength) != stored) return Decoded.Bad("checksum mismatch")
        return try {
            DataInputStream(ByteArrayInputStream(bytes, 0, bodyLength)).use { input ->
                if (input.readInt() != magic) return Decoded.Bad("wrong magic")
                val value = parse(input.readUnsignedByte(), input)
                if (input.available() != 0) return Decoded.Bad("trailing bytes")
                Decoded.Ok(value)
            }
        } catch (e: EOFException) {
            Decoded.Bad("truncated")
        } catch (e: IOException) {
            Decoded.Bad(e.message ?: "unreadable")
        }
    }
}
