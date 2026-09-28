package io.silentsuite.sync.notes.edit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingCodecTest {
    private val full = PendingEntry(
        noteUid = "note_A-1", notebookUid = "book-1", state = PendingEntry.State.HELD, version = 7,
        revision = "rev-7", isCreate = true, sent = listOf("rev-5", "rev-6"), failureCount = 3,
        lastFailureAt = 1_758_800_000_000, lastFailureCategory = "READ_ONLY",
        origin = PendingEntry.Origin("note-orig", "rev-orig", 4, "srv-9"), held = PendingEntry.Held(HeldReason.READ_ONLY, 1_758_800_000_500),
        blob = byteArrayOf(0, 1, 2, -1, 127, -128),
    )

    private fun ok(bytes: ByteArray) = (PendingCodec.decodeEntry(bytes) as PendingCodec.Decoded.Ok).value

    private fun bad(bytes: ByteArray) = (PendingCodec.decodeEntry(bytes) as PendingCodec.Decoded.Bad).reason

    @Test fun `every field survives a round trip`() {
        assertEquals(full, ok(PendingCodec.encodeEntry(full)))
        val minimal = PendingEntry("n", "b", PendingEntry.State.UPSERT, 1, "r", false, blob = ByteArray(0))
        assertEquals(minimal, ok(PendingCodec.encodeEntry(minimal)))
    }

    @Test fun `a flipped byte anywhere is caught by the checksum`() {
        val bytes = PendingCodec.encodeEntry(full)
        for (i in bytes.indices) {
            val damaged = bytes.copyOf().also { it[i] = (it[i].toInt() xor 0x40).toByte() }
            assertTrue("byte $i", PendingCodec.decodeEntry(damaged) is PendingCodec.Decoded.Bad)
        }
    }

    @Test fun `a file cut short at any point is unreadable never partial`() {
        val bytes = PendingCodec.encodeEntry(full)
        for (length in 0 until bytes.size) {
            assertTrue("length $length", PendingCodec.decodeEntry(bytes.copyOf(length)) is PendingCodec.Decoded.Bad)
        }
    }

    @Test fun `a newer format version is refused so a downgrade cannot misread it`() {
        val bytes = PendingCodec.encodeEntry(full)
        val body = bytes.copyOfRange(0, bytes.size - 4).also { it[4] = 3 }
        val crc = java.util.zip.CRC32().apply { update(body) }.value.toInt()
        val reencoded = body + byteArrayOf((crc ushr 24).toByte(), (crc ushr 16).toByte(), (crc ushr 8).toByte(), crc.toByte())
        assertEquals("format version 3", bad(reencoded))
        assertEquals("format version 3", (PendingCodec.decodeEntryHeader(reencoded) as PendingCodec.Decoded.Bad).reason)
    }

    // ---- the header section read on its own ----

    private fun header(bytes: ByteArray) = PendingCodec.decodeEntryHeader(bytes.copyOf(PendingCodec.entryHeaderEnd(bytes)!!))

    @Test fun `the header reads on its own from the first bytes of the file`() {
        val bytes = PendingCodec.encodeEntry(full)
        val read = (header(bytes) as PendingCodec.Decoded.Ok).value as PendingCodec.HeaderRead.Header
        assertEquals(PendingNotesStore.EntryHeader("note_A-1", "book-1", PendingEntry.State.HELD, 7), read.header)
        assertTrue("the header ends before the blob", PendingCodec.entryHeaderEnd(bytes)!! < bytes.size - full.blob.size)
    }

    @Test fun `a damaged header is caught by its own checksum`() {
        val bytes = PendingCodec.encodeEntry(full)
        val end = PendingCodec.entryHeaderEnd(bytes)!!
        for (i in PendingCodec.ENTRY_PREFIX until end) {
            val damaged = bytes.copyOf().also { it[i] = (it[i].toInt() xor 0x40).toByte() }
            assertTrue("byte $i", PendingCodec.decodeEntryHeader(damaged.copyOf(end)) is PendingCodec.Decoded.Bad)
        }
        assertTrue("a cut header is refused", PendingCodec.decodeEntryHeader(bytes.copyOf(end - 1)) is PendingCodec.Decoded.Bad)
    }

    @Test fun `a format 1 file asks for a full read and a header length out of range is refused`() {
        assertEquals(PendingCodec.Decoded.Ok(PendingCodec.HeaderRead.NeedsFullRead), PendingCodec.decodeEntryHeader(unhex(v1Upsert)))
        val bytes = PendingCodec.encodeEntry(full).copyOf()
        bytes[5] = 0x7f
        assertEquals(null, PendingCodec.entryHeaderEnd(bytes))
    }

    @Test fun `a blob over the limit is refused when writing, not only when reading`() {
        val huge = full.copy(blob = ByteArray(PendingCodec.MAX_BLOB + 1))
        assertThrows(java.io.IOException::class.java) { PendingCodec.encodeEntry(huge) }
    }

    @Test fun `records of one kind are not read as another`() {
        val landed = PendingCodec.encodeLanded(LandedRecord("n", "r", 12, byteArrayOf(9)))
        val notebook = PendingCodec.encodeNotebook("book", byteArrayOf(8))
        assertTrue(PendingCodec.decodeEntry(landed) is PendingCodec.Decoded.Bad)
        assertTrue(PendingCodec.decodeNotebook(landed) is PendingCodec.Decoded.Bad)
        assertTrue(PendingCodec.decodeLanded(notebook) is PendingCodec.Decoded.Bad)
        assertEquals(LandedRecord("n", "r", 12, byteArrayOf(9)), (PendingCodec.decodeLanded(landed) as PendingCodec.Decoded.Ok).value)
        val sequence = PendingCodec.encodeSequence(41)
        assertEquals(41L, (PendingCodec.decodeSequence(sequence) as PendingCodec.Decoded.Ok).value)
        assertTrue(PendingCodec.decodeSequence(landed) is PendingCodec.Decoded.Bad)
        assertTrue(PendingCodec.decodeLanded(sequence) is PendingCodec.Decoded.Bad)
        val (uid, blob) = (PendingCodec.decodeNotebook(notebook) as PendingCodec.Decoded.Ok).value
        assertEquals("book", uid)
        assertArrayEquals(byteArrayOf(8), blob)
    }

    @Test fun `the sent list is capped at the oldest end`() {
        var e = PendingEntry("n", "b", PendingEntry.State.UPSERT, 1, "r0", false, blob = ByteArray(0))
        for (i in 1..(PendingEntry.MAX_SENT + 5)) e = e.withSent("r$i")
        assertEquals(PendingEntry.MAX_SENT, e.sent.size)
        assertEquals("r6", e.sent.first())
        assertEquals(e, e.withSent("r${PendingEntry.MAX_SENT + 5}"))
        assertEquals(e, ok(PendingCodec.encodeEntry(e)))
    }

    // ---- byte layouts, frozen: a change here needs a new format version and a migration ----

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private val v2Upsert = "53534e50020000003c00066e6f74652d310006626f6f6b2d3101000000000000000300057265762d33010000000100057265762d3200000000ffffffffffffffff00000000bacf634300000003010203594d24b4"
    private val v2Deleted = "53534e50020000004c00066e6f74652d320006626f6f6b2d3102000000000000000900057265762d64000000000200057265762d6100057265762d62000000020000019980a6340000095452414e5349454e54000030ed609400000001099f4f157b"
    private val v2Held = "53534e50020000006500066e6f74652d330006626f6f6b2d3203000000000000000c00057265762d68000000000000000000ffffffffffffffff00000100066e6f74652d3000057265762d6f000000000000000500057372762d3701000852454a45435445440000019980a635f4e41a9e3e000000005b9e02ad"

    @Test fun `format 2 entry files read back exactly and are written byte for byte the same`() {
        for ((hex, entry) in listOf(v2Upsert to v1UpsertEntry, v2Deleted to v1DeletedEntry, v2Held to v1HeldEntry)) {
            assertEquals(entry, ok(unhex(hex)))
            assertArrayEquals(unhex(hex), PendingCodec.encodeEntry(entry))
        }
    }

    private val v1UpsertEntry = PendingEntry("note-1", "book-1", PendingEntry.State.UPSERT, 3, "rev-3", true, listOf("rev-2"), blob = byteArrayOf(1, 2, 3))
    private val v1DeletedEntry = PendingEntry("note-2", "book-1", PendingEntry.State.DELETE, 9, "rev-d", false, listOf("rev-a", "rev-b"),
        failureCount = 2, lastFailureAt = 1_758_800_000_000, lastFailureCategory = "TRANSIENT", blob = byteArrayOf(9))
    private val v1HeldEntry = PendingEntry("note-3", "book-2", PendingEntry.State.HELD, 12, "rev-h", false,
        origin = PendingEntry.Origin("note-0", "rev-o", 5, "srv-7"), held = PendingEntry.Held(HeldReason.REJECTED, 1_758_800_000_500), blob = byteArrayOf())

    private val v1Upsert = "53534e500100066e6f74652d310006626f6f6b2d3101000000000000000300057265762d33010000000100057265762d3200000000ffffffffffffffff0000000000000003010203f0a8313a"
    private val v1Deleted = "53534e500100066e6f74652d320006626f6f6b2d3102000000000000000900057265762d64000000000200057265762d6100057265762d62000000020000019980a6340000095452414e5349454e5400000000000109ac938006"
    private val v1Held = "53534e500100066e6f74652d330006626f6f6b2d3203000000000000000c00057265762d68000000000000000000ffffffffffffffff00000100066e6f74652d3000057265762d6f000000000000000500057372762d3701000852454a45435445440000019980a635f400000000ee7456a7"
    private val v1Landed = "53534e52010100066e6f74652d3100057265762d330000000000000003000000020707cd071a42"
    private val v1Notebook = "53534e5201020006626f6f6b2d31000000010593bd6838"
    private val v1Sequence = "53534e520103000000000000002acae55218"

    @Test fun `format 1 entry files still read back exactly, and are written as format 2`() {
        for ((hex, entry) in listOf(v1Upsert to v1UpsertEntry, v1Deleted to v1DeletedEntry, v1Held to v1HeldEntry)) {
            assertEquals(entry, ok(unhex(hex)))
            assertEquals(PendingCodec.ENTRY_FORMAT_VERSION, PendingCodec.encodeEntry(entry)[4].toInt())
        }
    }

    @Test fun `version 1 landed notebook and sequence records read back exactly and are written the same`() {
        val landed = LandedRecord("note-1", "rev-3", 3, byteArrayOf(7, 7))
        assertEquals(landed, (PendingCodec.decodeLanded(unhex(v1Landed)) as PendingCodec.Decoded.Ok).value)
        assertArrayEquals(unhex(v1Landed), PendingCodec.encodeLanded(landed))
        val (uid, blob) = (PendingCodec.decodeNotebook(unhex(v1Notebook)) as PendingCodec.Decoded.Ok).value
        assertEquals("book-1", uid)
        assertArrayEquals(byteArrayOf(5), blob)
        assertArrayEquals(unhex(v1Notebook), PendingCodec.encodeNotebook("book-1", byteArrayOf(5)))
        assertEquals(42L, (PendingCodec.decodeSequence(unhex(v1Sequence)) as PendingCodec.Decoded.Ok).value)
        assertArrayEquals(unhex(v1Sequence), PendingCodec.encodeSequence(42))
    }
}
