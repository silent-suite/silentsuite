package io.silentsuite.sync.notes.edit

import com.etebase.client.exceptions.MsgPackException
import io.silentsuite.sync.notes.edit.NotePushStep.NotBuilt
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decisions [EtebasePushRemote] makes before anything is uploaded, which need no item of the
 * binding: whether a pending change gives a title of its own, what is written over a copy's metadata,
 * and whether what was written reads back. Where the answer is no, the text is held with the reason
 * ([NotBuilt]); neither typed metadata nor the typed decoder is the fallback.
 */
class EtebasePushRemoteTest {
    private fun hex(s: String) = s.replace(" ", "").chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private fun str(s: String) = byteArrayOf((0xa0 + s.length).toByte()) + s.toByteArray(Charsets.UTF_8)

    private fun map(vararg entries: Pair<ByteArray, ByteArray>) =
        entries.fold(byteArrayOf((0x80 + entries.size).toByte())) { bytes, (key, value) -> bytes + key + value }

    private fun notBuilt(raw: ByteArray?): NotBuilt =
        assertThrows(NotBuilt::class.java) { EtebasePushRemote.metadataToWrite(raw, "Plan", 3_000L) }

    @Test fun `a map another client wrote keeps every other field, byte for byte`() {
        val theirs = map(str("name") to str("Old"), str("color") to str("#00ff00"), str("mtime") to byteArrayOf(5), str("x") to hex("c0"))
        val merged = EtebasePushRemote.metadataToWrite(theirs, "Plan", 3_000L)
        assertEquals("Plan", merged.name)
        assertArrayEquals(map(str("name") to str("Plan"), str("color") to str("#00ff00"), str("mtime") to hex("cd0bb8"), str("x") to hex("c0")),
            merged.bytes)
    }

    @Test fun `metadata that is not one map is never written over, with typed metadata or anything else`() {
        val cases = mapOf(
            "an array" to hex("91 a1 78"),
            "nil" to hex("c0"),
            "a string" to str("name"),
            "a map cut short" to hex("81"),
            "a map with a byte after it" to map(str("name") to str("Old")) + hex("c0"),
            "a reserved type byte" to hex("c1"),
        )
        for ((what, raw) in cases) {
            val refused = notBuilt(raw)
            assertEquals(what, HeldReason.UNREADABLE_METADATA, refused.reason)
            assertTrue(what, refused.message!!.startsWith("note metadata is not one map"))
        }
    }

    @Test fun `a map that gives the title or the time more than once, or under another client's key, is not written over either`() {
        val repeated = map(str("name") to str("A secret title"), str("name") to str("Another secret title"))
        val aliased = map(hex("01") to str("A secret title"), str("mtime") to byteArrayOf(5))
        val repeatedTime = map(str("mtime") to byteArrayOf(5), str("mtime") to byteArrayOf(6))
        for (raw in listOf(repeated, aliased, repeatedTime)) {
            val refused = notBuilt(raw)
            assertEquals(HeldReason.UNREADABLE_METADATA, refused.reason)
            assertFalse("the message goes to the log, so it names the key and nothing a user wrote", refused.message!!.contains("secret"))
        }
        assertEquals("note metadata names name ambiguously (REPEATED)", notBuilt(repeated).message)
        assertEquals("note metadata names name ambiguously (ALIASED)", notBuilt(aliased).message)
        assertEquals("note metadata names mtime ambiguously (REPEATED)", notBuilt(repeatedTime).message)
    }

    @Test fun `only where there is no metadata at all is a fresh map written`() {
        val fresh = NoteMetaCodec.fresh("Plan", 3_000L).bytes
        assertArrayEquals(map(str("name") to str("Plan"), str("mtime") to hex("cd0bb8")), fresh)
        assertArrayEquals(fresh, EtebasePushRemote.metadataToWrite(null, "Plan", 3_000L).bytes)
        assertArrayEquals(fresh, EtebasePushRemote.metadataToWrite(ByteArray(0), "Plan", 3_000L).bytes)
        // One byte is not "no metadata", whatever it is.
        assertEquals(HeldReason.UNREADABLE_METADATA, notBuilt(hex("00")).reason)
    }

    @Test fun `what was written passes when it reads back exactly that`() {
        EtebasePushRemote.requireReadBack("Plan", 3_000L) { "Plan" to 3_000L }
    }

    @Test fun `the read-back takes the name from the raw bytes and the time from the typed decoder`() {
        // A character above U+FFFF: the title never passes through a typed string, on any Android version.
        val title = "Plan \uD83D\uDED2"
        val raw = NoteMetaCodec.fresh(title, 3_000L).bytes
        // The bytes say 3_000 and the typed decoder's stand-in says 4_000: the time is the typed one.
        assertEquals(title to 4_000L, EtebasePushRemote.readBack(raw) { 4_000L })
        EtebasePushRemote.requireReadBack(title, 4_000L) { EtebasePushRemote.readBack(raw) { 4_000L } }
    }

    @Test fun `bytes that give no name do not read back`() {
        val notOneMap = hex("91 a1 78")
        assertEquals(null to 3_000L, EtebasePushRemote.readBack(notOneMap) { 3_000L })
        val refused = assertThrows(NotBuilt::class.java) {
            EtebasePushRemote.requireReadBack("Plan", 3_000L) { EtebasePushRemote.readBack(notOneMap) { 3_000L } }
        }
        assertEquals(HeldReason.READ_BACK_FAILED, refused.reason)
    }

    @Test fun `a typed decoder that rejects the map fails the read-back`() {
        val raw = NoteMetaCodec.fresh("Plan", 3_000L).bytes
        val refused = assertThrows(NotBuilt::class.java) {
            EtebasePushRemote.requireReadBack("Plan", 3_000L) { EtebasePushRemote.readBack(raw) { throw MsgPackException("x") } }
        }
        assertEquals(HeldReason.READ_BACK_FAILED, refused.reason)
    }

    @Test fun `a pending change gives its name and time from its raw metadata`() {
        assertEquals("Plan" to 5L, EtebasePushRemote.pendingNameAndMtime(NoteMetaCodec.fresh("Plan", 5L).bytes) { 9_000L })
        assertEquals("with no time of its own, the time of the run", "Plan" to 9_000L,
            EtebasePushRemote.pendingNameAndMtime(map(str("name") to str("Plan"))) { 9_000L })
        assertEquals("an empty title is a title", "" to 5L, EtebasePushRemote.pendingNameAndMtime(NoteMetaCodec.fresh("", 5L).bytes) { 9_000L })
    }

    @Test fun `a pending change with no readable name is held, never read through the typed decoder`() {
        val cases = mapOf(
            "no metadata" to null,
            "empty metadata" to ByteArray(0),
            "an array" to hex("91 78"),
            "a map cut short" to hex("81"),
            "an empty map" to hex("80"),
            "a name that is a number" to map(str("name") to byteArrayOf(5), str("mtime") to byteArrayOf(1)),
            "a repeated name" to map(str("name") to str("A secret title"), str("name") to str("Another secret title")),
            "a name only under another client's key" to map(hex("01") to str("A secret title"), str("mtime") to byteArrayOf(5)),
            "a name beside one under another client's key" to map(str("name") to str("A secret title"), hex("01") to str("Another secret title")),
            "a name that is not UTF-8" to map(str("name") to hex("a2 c3 28")),
        )
        for ((what, raw) in cases) {
            val refused = assertThrows(what, NotBuilt::class.java) { EtebasePushRemote.pendingNameAndMtime(raw) { 9_000L } }
            assertEquals(what, HeldReason.NOT_BUILT, refused.reason)
            assertEquals(what, "the pending change's metadata gives no readable name", refused.message)
        }
    }

    @Test fun `a note that reads back differently is not sent, and says why`() {
        val differently = listOf<Pair<String?, Long?>>("Plan?" to 3_000L, "Plan" to 3_001L, null to 3_000L, "Plan" to null, "" to 3_000L)
        for (read in differently) {
            val refused = assertThrows(NotBuilt::class.java) { EtebasePushRemote.requireReadBack("Plan", 3_000L) { read } }
            assertEquals("$read", HeldReason.READ_BACK_FAILED, refused.reason)
        }
    }

    @Test fun `a typed read that fails counts as not read back, and any other error is not swallowed`() {
        val refused = assertThrows(NotBuilt::class.java) {
            EtebasePushRemote.requireReadBack("Plan", 3_000L) { throw MsgPackException("a message that may quote a secret title") }
        }
        assertEquals(HeldReason.READ_BACK_FAILED, refused.reason)
        assertTrue(refused.message!!.contains("MsgPackException"))
        assertFalse("the binding's own message is not passed on", refused.message!!.contains("secret"))

        assertThrows(InterruptedException::class.java) { EtebasePushRemote.requireReadBack("Plan", 3_000L) { throw InterruptedException() } }
        assertThrows(IllegalStateException::class.java) { EtebasePushRemote.requireReadBack("Plan", 3_000L) { error("unexpected") } }
    }
}
