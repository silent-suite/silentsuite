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
 */
internal object PendingCodec {
    const val FORMAT_VERSION = 1
    private const val ENTRY_MAGIC = 0x53534E50 // "SSNP"
    private const val RECORD_MAGIC = 0x53534E52 // "SSNR"
    private const val KIND_LANDED = 1
    private const val KIND_NOTEBOOK = 2
    private const val KIND_SEQUENCE = 3
    private const val MAX_BLOB = 64 * 1024 * 1024

    sealed class Decoded<out T> {
        data class Ok<T>(val value: T) : Decoded<T>()
        data class Bad(val reason: String) : Decoded<Nothing>()
    }

    fun encodeEntry(e: PendingEntry): ByteArray = withChecksum { out ->
        out.writeInt(ENTRY_MAGIC)
        out.writeByte(FORMAT_VERSION)
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
        writeBlob(out, e.blob)
    }

    fun decodeEntry(bytes: ByteArray): Decoded<PendingEntry> = open(bytes, ENTRY_MAGIC) { input ->
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
        val blob = readBlob(input)
        try {
            PendingEntry(noteUid, notebookUid, state, version, revision, isCreate, sent, failureCount,
                lastFailureAt, lastFailureCategory, origin, held, blob)
        } catch (e: IllegalArgumentException) {
            throw IOException(e.message)
        }
    }

    fun encodeLanded(r: LandedRecord): ByteArray = withChecksum { out ->
        out.writeInt(RECORD_MAGIC)
        out.writeByte(FORMAT_VERSION)
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
        out.writeByte(FORMAT_VERSION)
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
        out.writeByte(FORMAT_VERSION)
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
        out.writeInt(blob.size)
        out.write(blob)
    }

    private fun readBlob(input: DataInputStream): ByteArray {
        val size = input.readInt()
        if (size < 0 || size > MAX_BLOB || size > input.available()) throw IOException("blob size $size")
        return ByteArray(size).also { input.readFully(it) }
    }

    /** Writes the fields, then appends a CRC32 over them. */
    private fun withChecksum(write: (DataOutputStream) -> Unit): ByteArray {
        val body = ByteArrayOutputStream()
        DataOutputStream(body).use(write)
        val bytes = body.toByteArray()
        val crc = CRC32().apply { update(bytes) }.value.toInt()
        return bytes + byteArrayOf((crc ushr 24).toByte(), (crc ushr 16).toByte(), (crc ushr 8).toByte(), crc.toByte())
    }

    /** Checks the CRC, magic, and format version, parses, and requires the parse to use every byte. */
    private fun <T> open(bytes: ByteArray, magic: Int, parse: (DataInputStream) -> T): Decoded<T> {
        if (bytes.size < 9) return Decoded.Bad("too short")
        val body = bytes.copyOfRange(0, bytes.size - 4)
        val stored = ((bytes[bytes.size - 4].toInt() and 0xff) shl 24) or ((bytes[bytes.size - 3].toInt() and 0xff) shl 16) or
            ((bytes[bytes.size - 2].toInt() and 0xff) shl 8) or (bytes[bytes.size - 1].toInt() and 0xff)
        if (CRC32().apply { update(body) }.value.toInt() != stored) return Decoded.Bad("checksum mismatch")
        return try {
            DataInputStream(ByteArrayInputStream(body)).use { input ->
                if (input.readInt() != magic) return Decoded.Bad("wrong magic")
                val format = input.readUnsignedByte()
                if (format != FORMAT_VERSION) return Decoded.Bad("format version $format")
                val value = parse(input)
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
