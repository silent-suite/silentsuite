package io.silentsuite.sync.notes.edit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingCodecTest {
    private val full = PendingEntry(
        noteUid = "note_A-1", notebookUid = "book-1", state = PendingEntry.State.HELD, version = 7,
        revision = "rev-7", isCreate = true, sent = listOf("rev-5", "rev-6"), failureCount = 3,
        lastFailureAt = 1_758_800_000_000, lastFailureCategory = "READ_ONLY",
        origin = PendingEntry.Origin("note-orig", "rev-orig", 4, "srv-9"), held = PendingEntry.Held(HeldReason.READ_ONLY, 1_758_800_000_500),
        fromConflict = true, blob = byteArrayOf(0, 1, 2, -1, 127, -128),
    )

    private fun ok(bytes: ByteArray) = (PendingCodec.decodeEntry(bytes) as PendingCodec.Decoded.Ok).value

    private fun bad(bytes: ByteArray) = (PendingCodec.decodeEntry(bytes) as PendingCodec.Decoded.Bad).reason

    @Test fun `every field survives a round trip`() {
        assertEquals(full, ok(PendingCodec.encodeEntry(full)))
        val minimal = PendingEntry("n", "b", PendingEntry.State.UPSERT, 1, "r", false, blob = ByteArray(0))
        assertEquals(minimal, ok(PendingCodec.encodeEntry(minimal)))
    }

    @Test fun `every reason text can be held for is stored by its name and read back`() {
        for (reason in HeldReason.values()) {
            // No failure category, which is stored by name too and could stand in for a reason of the same name.
            val entry = full.copy(lastFailureCategory = null, held = PendingEntry.Held(reason, 1_758_800_000_500))
            val bytes = PendingCodec.encodeEntry(entry)
            assertEquals(reason, ok(bytes).held!!.reason)
            assertTrue("$reason is in the file by name", String(bytes, Charsets.ISO_8859_1).contains(reason.name))
        }
        // The names are what entry files hold, so none may change once a build has written one.
        assertEquals(listOf("READ_ONLY", "LOST_ACCESS", "NOTEBOOK_DELETED", "REJECTED", "REPEATED_CONFLICT",
            "UNREADABLE_METADATA", "READ_BACK_FAILED", "NOT_BUILT"), HeldReason.values().map { it.name })
    }

    @Test fun `the conflict mark is read back as it was written, set or not`() {
        for (marked in listOf(true, false)) {
            val entry = full.copy(fromConflict = marked)
            assertEquals(marked, ok(PendingCodec.encodeEntry(entry)).fromConflict)
        }
        assertTrue("the mark is part of an entry's identity", full != full.copy(fromConflict = false))
        // The mark is the last byte of the header, so the two files differ only there and in the checksums.
        val marked = PendingCodec.encodeEntry(full)
        val unmarked = PendingCodec.encodeEntry(full.copy(fromConflict = false))
        val markAt = PendingCodec.entryHeaderEnd(marked)!! - 5
        assertEquals(1, marked[markAt].toInt())
        assertEquals(0, unmarked[markAt].toInt())
        assertArrayEquals(marked.copyOf(markAt), unmarked.copyOf(markAt))
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
        assertEquals(PendingNotesStore.EntryHeader("note_A-1", "book-1", PendingEntry.State.HELD, 7,
            failureCount = 3, lastFailureAt = 1_758_800_000_000, lastFailureCategory = "READ_ONLY"), read.header)
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

    // Format 2 with the conflict mark as its last header field. The mark was added in place, before any
    // build had written format 2 on a user's device (design 3.8); from then on a new field needs format 3.
    // The upsert is the format 1 entry with the mark set; the delete and the held entry are unmarked.
    private val v2Upsert = "53534e50020000003d00066e6f74652d310006626f6f6b2d3101000000000000000300057265762d33010000000100057265762d3200000000ffffffffffffffff00000000014a6a00520000000301020389a5614f"
    private val v2Deleted = "53534e50020000004d00066e6f74652d320006626f6f6b2d3102000000000000000900057265762d64000000000200057265762d6100057265762d62000000020000019980a6340000095452414e5349454e54000000255055b0000000010996f19b9c"
    private val v2Held = "53534e50020000006600066e6f74652d330006626f6f6b2d3203000000000000000c00057265762d68000000000000000000ffffffffffffffff00000100066e6f74652d3000057265762d6f000000000000000500057372762d3701000852454a45435445440000019980a635f4001387e8b800000000748f775f"
    // Text held for a repeated conflict. The reason is stored by name, so this also freezes that name.
    private val v2HeldRepeated = "53534e50020000005800066e6f74652d340006626f6f6b2d3203000000000000000f00057265762d63010000000100057265762d6300000000ffffffffffffffff00000001001152455045415445445f434f4e464c4943540000019980a637e801c4ce1c20000000012a337b503d"
    private val v2HeldRepeatedEntry = PendingEntry("note-4", "book-2", PendingEntry.State.HELD, 15, "rev-c", true, listOf("rev-c"),
        held = PendingEntry.Held(HeldReason.REPEATED_CONFLICT, 1_758_800_001_000), fromConflict = true, blob = byteArrayOf(42))

    // The three format 2 layouts as they were before the mark, kept only to show they no longer read.
    private val v2UpsertBeforeMark = "53534e50020000003c00066e6f74652d310006626f6f6b2d3101000000000000000300057265762d33010000000100057265762d3200000000ffffffffffffffff00000000bacf634300000003010203594d24b4"
    private val v2DeletedBeforeMark = "53534e50020000004c00066e6f74652d320006626f6f6b2d3102000000000000000900057265762d64000000000200057265762d6100057265762d62000000020000019980a6340000095452414e5349454e54000030ed609400000001099f4f157b"
    private val v2HeldBeforeMark = "53534e50020000006500066e6f74652d330006626f6f6b2d3203000000000000000c00057265762d68000000000000000000ffffffffffffffff00000100066e6f74652d3000057265762d6f000000000000000500057372762d3701000852454a45435445440000019980a635f4e41a9e3e000000005b9e02ad"

    @Test fun `format 2 entry files read back exactly and are written byte for byte the same`() {
        val fixtures = listOf(v2Upsert to v1UpsertEntry.copy(fromConflict = true), v2Deleted to v1DeletedEntry,
            v2Held to v1HeldEntry, v2HeldRepeated to v2HeldRepeatedEntry)
        for ((hex, entry) in fixtures) {
            assertEquals(entry, ok(unhex(hex)))
            assertArrayEquals(unhex(hex), PendingCodec.encodeEntry(entry))
        }
    }

    @Test fun `a format 2 file from before the conflict mark is reported as unreadable, not read as unmarked`() {
        // Such files exist only where a build of the prototype branch ran. A committed one is kept and
        // reported like any file that cannot be read, and the header-only view refuses it the same way.
        // One left as an uncommitted first write (a ".new" with no committed file) does not read back
        // complete, so recovery drops it like any write that never finished.
        for (hex in listOf(v2UpsertBeforeMark, v2DeletedBeforeMark, v2HeldBeforeMark)) {
            val bytes = unhex(hex)
            assertEquals("truncated", bad(bytes))
            assertEquals("truncated", (PendingCodec.decodeEntryHeader(bytes.copyOf(PendingCodec.entryHeaderEnd(bytes)!!)) as PendingCodec.Decoded.Bad).reason)
        }
    }

    @Test fun `a format 2 header with a byte after its last field is refused by the full read and by the header read`() {
        fun int(v: Int) = byteArrayOf((v ushr 24).toByte(), (v ushr 16).toByte(), (v ushr 8).toByte(), v.toByte())
        fun crc(b: ByteArray) = java.util.zip.CRC32().apply { update(b) }.value.toInt()
        val bytes = PendingCodec.encodeEntry(full)
        val end = PendingCodec.entryHeaderEnd(bytes)!!
        // The same entry with one more header byte, and both checksums correct for it.
        val header = bytes.copyOfRange(PendingCodec.ENTRY_PREFIX, end - 4) + 0.toByte()
        val body = bytes.copyOf(5) + int(header.size) + header + int(crc(header)) + bytes.copyOfRange(end, bytes.size - 4)
        val file = body + int(crc(body))
        assertEquals("trailing header bytes", bad(file))
        assertEquals("trailing header bytes",
            (PendingCodec.decodeEntryHeader(file.copyOf(PendingCodec.entryHeaderEnd(file)!!)) as PendingCodec.Decoded.Bad).reason)
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
            assertFalse("format 1 has no conflict mark, so it reads as unmarked", ok(unhex(hex)).fromConflict)
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
