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
 * The two decisions [EtebasePushRemote] makes before anything is uploaded, which need no item of the
 * binding: what is written over a copy's metadata, and whether what was written reads back. Where the
 * answer is no, the text is held with the reason ([NotBuilt]); typed metadata is never the fallback.
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

    @Test fun `what was written passes when the typed decoder reads back exactly that`() {
        EtebasePushRemote.requireReadBack("Plan", 3_000L) { "Plan" to 3_000L }
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
