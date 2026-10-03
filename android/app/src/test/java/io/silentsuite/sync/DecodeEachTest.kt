package io.silentsuite.sync

import com.etebase.client.exceptions.EtebaseException
import com.etebase.client.exceptions.MsgPackException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DecodeEachTest {
    @Test fun `an undecodable entry is reported and left out while the others still decode`() {
        val reported = mutableListOf<Pair<String, EtebaseException>>()
        val decoded = decodeEach(
            listOf("good-1", "float-mtime", "good-2", "duplicate-name"),
            uidOf = { it },
            decode = {
                // What the binding throws for a note another app wrote with a fractional mtime or a repeated key.
                if (it.startsWith("good")) it.uppercase() else throw MsgPackException("invalid type: floating point")
            },
            onUndecodable = { uid, error -> reported += uid to error },
        )
        assertEquals(listOf("GOOD-1", "GOOD-2"), decoded)
        assertEquals(listOf("float-mtime", "duplicate-name"), reported.map { it.first })
        assertTrue(reported.all { it.second is MsgPackException })
    }

    @Test fun `only binding decode errors are treated as undecodable data`() {
        assertThrows(IllegalStateException::class.java) {
            decodeEach<String, String>(listOf("a"), uidOf = { it }, decode = { error("a real bug") }, onUndecodable = { _, _ -> })
        }
    }

    @Test fun `an empty list stays empty`() {
        assertEquals(emptyList<String>(),
            decodeEach(emptyList<String>(), uidOf = { it }, decode = { it }, onUndecodable = { _, _ -> }))
    }
}
