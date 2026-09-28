package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.NoteMetaCodec.Merge
import io.silentsuite.sync.notes.edit.NoteMetaCodec.Why
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream

/**
 * Inputs and expected outputs are the bytes the web's own encoder writes (@msgpack/msgpack 1.12.2,
 * the version etebase 0.43.1 uses, called with ignoreUndefined as etebase does), generated from the
 * objects named in each fixture, unless a fixture says it is hand-encoded or was captured from the
 * binding's typed writer on a device. Every expected merge equals the web's encoding of the same
 * object after the change.
 */
class NoteMetaCodecTest {
    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    private fun merged(raw: String, name: String, mtime: Long): String =
        hex((NoteMetaCodec.merge(unhex(raw), name, mtime) as Merge.Merged).bytes)

    private fun merge(raw: String) = NoteMetaCodec.merge(unhex(raw), "New", 5)

    private fun notAMap(raw: ByteArray?): String = (NoteMetaCodec.merge(raw, "n", 1) as Merge.NotAMap).reason

    // {name: 'Groceries', mtime: 1758800000000}
    private val webNote = "82a46e616d65a947726f636572696573a56d74696d65cf0000019980a63400"
    // {name: 'Groceries', mtime: 1758800000000, extra: 'keep-me'}
    private val webNoteExtra = "83a46e616d65a947726f636572696573a56d74696d65cf0000019980a63400a56578747261a76b6565702d6d65"
    // {name: 'Plans', mtime: ..., tags: ['a', 'b'], nested: {x: 1, y: [true, null]}, bin: Uint8Array [1, 2, 3]}
    private val webNoteNested = "85a46e616d65a5506c616e73a56d74696d65cf0000019980a63400a47461677392a161a162a66e657374656482a17801a17992c3c0a362696ec403010203"
    private val webLongTitle = "82a46e616d65d93541207469746c652074686174206973206c6f6e676572207468616e207468697274792d6f6e6520627974657320666f722073747238a56d74696d65cf0000019980a63400"
    // {name: 'Einkäufe für die Woche 🛒', mtime: ...}
    private val webUnicodeTitle = "82a46e616d65bd45696e6bc3a47566652066c3bc722064696520576f63686520f09f9b92a56d74696d65cf0000019980a63400"
    // {name: 'Float', mtime: 1758800000000.5}: a float the typed decoder rejects
    private val webFloatMtime = "82a46e616d65a5466c6f6174a56d74696d65cb4279980a63400800"
    private val webNoMtime = "81a46e616d65ab4f6e6c792061206e616d65"
    private val webEmpty = "80"
    // fourteen keys k0..k13 plus name: a fixmap with room for one more entry
    private val webFifteenNoMtime = "8fa26b3000a26b3101a26b3202a26b3303a26b3404a26b3505a26b3606a26b3707a26b3808a26b3909a36b31300aa36b31310ba36b31320ca36b31330da46e616d65a16e"
    private val webSixteen = "de0010a26b3000a26b3101a26b3202a26b3303a26b3404a26b3505a26b3606a26b3707a26b3808a26b3909a36b31300aa36b31310ba36b31320ca36b31330da36b31340ea36b31350f"
    // {name: 'Old', mtime: -5, delta: -200}
    private val webNegative = "83a46e616d65a34f6c64a56d74696d65fba564656c7461d1ff38"

    // {name: 'D', mtime: ..., when: Date, extra: 'keep-me'}: the web writes a Date as timestamp ext -1,
    // at 32 bits (d6ff) for whole seconds, 64 bits (d7ff) with milliseconds, and 96 bits (c70cff, an ext8) far out
    private val webDateSeconds = "84a46e616d65a144a56d74696d65cf0000019980a63400a47768656ed6ff68d52880a56578747261a76b6565702d6d65"
    private val webDateMillis = "84a46e616d65a144a56d74696d65cf0000019980a63400a47768656ed7ff1d53530068d52880a56578747261a76b6565702d6d65"
    private val webDateFar = "84a46e616d65a144a56d74696d65cf0000019980a63400a47768656ec70cff00000000ffffff172b5af000a56578747261a76b6565702d6d65"
    // {name: 'E', mtime: ..., one, three, twenty, extra}: ext type 7 through an ExtensionCodec with 1, 3 and 20 byte payloads
    private val webExt = "86a46e616d65a145a56d74696d65cf0000019980a63400a36f6e65d407aba57468726565c70307abababa67477656e7479c71407ababababababababababababababababababababa56578747261a76b6565702d6d65"

    // After name and mtime, one field per value width the web writes: s300 'x' x 300 (str16),
    // b300 300 bytes (bin16), arr16 [0..15] (array16), obj16 {k0: 0 .. k15: 15} (map16), n200 (uint8),
    // nm100 -100 (int8), n100k (uint32), nm100k (int32), nm2e40 -(2^40) (int64), f 0.5 (float64)
    private val widthsTail = "a473333030da012c" + "78".repeat(300) + "a462333030c5012c" + "07".repeat(300) +
        "a56172723136dc0010000102030405060708090a0b0c0d0e0f" +
        "a56f626a3136de0010a26b3000a26b3101a26b3202a26b3303a26b3404a26b3505a26b3606a26b3707a26b3808a26b3909a36b31300aa36b31310ba36b31320ca36b31330da36b31340ea36b31350f" +
        "a46e323030ccc8a56e6d313030d09ca56e3130306bce000186a0a66e6d3130306bd2fffe7960a66e6d32653430d3ffffff0000000000a166cb3fe0000000000000"
    private val webWidths = "8ca46e616d65a157a56d74696d65cf0000019980a63400$widthsTail"

    // {name: 'Deep', mtime: ..., deep: 40 nested arrays [[..1..]] or maps {a: {a: ..1..}}, extra: 'keep-me'}
    private val deepEnd = "01a56578747261a76b6565702d6d65"
    private val webDeepArray = "84a46e616d65a444656570a56d74696d65cf0000019980a63400a464656570" + "91".repeat(40) + deepEnd
    private val webDeepMap = "84a46e616d65a444656570a56d74696d65cf0000019980a63400a464656570" + "81a161".repeat(40) + deepEnd

    // Captured on a device from the binding's typed writer: type 't', name 'Typed', mtime, description 'd', color '#aabbcc'
    private val typedAll = "85a474797065a174a46e616d65a55479706564a56d74696d65cf0000019980a63400ab6465736372697074696f6ea164a5636f6c6f72a723616162626363"

    // hand-encoded: {mtime: 1, extra: 'x', name: 'A'}, both keys present with mtime first and a field between
    private val mtimeFirst = "83a56d74696d6501a56578747261a178a46e616d65a141"

    private val allFixtures = listOf(
        webNote, webNoteExtra, webNoteNested, webLongTitle, webUnicodeTitle, webFloatMtime, webNoMtime, webEmpty,
        webFifteenNoMtime, webSixteen, webNegative, webDateSeconds, webDateMillis, webDateFar, webExt, webWidths,
        webDeepArray, webDeepMap, typedAll, mtimeFirst,
    )

    // ---- merging produces exactly what the web would write for the same object ----

    @Test fun `a plain web note gets the new name and mtime and nothing else`() {
        assertEquals("82a46e616d65ab47726f6365726965732032a56d74696d65cf0000019980a63401",
            merged(webNote, "Groceries 2", 1758800000001))
    }

    @Test fun `a field this app does not know survives byte for byte`() {
        assertEquals("83a46e616d65a752656e616d6564a56d74696d65cf00000199869c1500a56578747261a76b6565702d6d65",
            merged(webNoteExtra, "Renamed", 1758900000000))
    }

    @Test fun `nested maps arrays booleans nil and binary values survive byte for byte`() {
        assertEquals("85a46e616d65a8506c616e73207632a56d74696d65cf00000199869c1500a47461677392a161a162a66e657374656482a17801a17992c3c0a362696ec403010203",
            merged(webNoteNested, "Plans v2", 1758900000000))
    }

    @Test fun `dates and other ext values survive byte for byte`() {
        assertEquals("84a46e616d65a34e6577a56d74696d6505a47768656ed6ff68d52880a56578747261a76b6565702d6d65", merged(webDateSeconds, "New", 5))
        assertEquals("84a46e616d65a34e6577a56d74696d6505a47768656ed7ff1d53530068d52880a56578747261a76b6565702d6d65", merged(webDateMillis, "New", 5))
        assertEquals("84a46e616d65a34e6577a56d74696d6505a47768656ec70cff00000000ffffff172b5af000a56578747261a76b6565702d6d65", merged(webDateFar, "New", 5))
        assertEquals("86a46e616d65a34e6577a56d74696d6505a36f6e65d407aba57468726565c70307abababa67477656e7479c71407ababababababababababababababababababababa56578747261a76b6565702d6d65",
            merged(webExt, "New", 5))
    }

    @Test fun `values of every width the web writes survive byte for byte`() {
        assertEquals("8ca46e616d65a34e6577a56d74696d6505$widthsTail", merged(webWidths, "New", 5))
    }

    @Test fun `widths the web never writes survive byte for byte`() {
        // hand-encoded: f float32 1.0, s str32 'ab', b bin32 [1], a array32 [1], m map32 {a: 1},
        // x y z w fixext 2, 4, 8 and 16, v ext16
        val tail = "a166ca3f800000" + "a173db000000026162" + "a162c60000000101" + "a161dd0000000101" + "a16ddf00000001a16101" +
            "a178d50701ff" + "a179d60701020304" + "a17ad707" + "00".repeat(8) + "a177d807" + "00".repeat(16) + "a176c8000207abab"
        assertEquals("8ca46e616d65a34e6577a56d74696d6505$tail", merged("8ca46e616d65a141a56d74696d6501$tail", "New", 5))
    }

    @Test fun `deep nesting the web writes and reads survives byte for byte`() {
        assertEquals("84a46e616d65a34e6577a56d74696d6505a464656570" + "91".repeat(40) + deepEnd, merged(webDeepArray, "New", 5))
        assertEquals("84a46e616d65a34e6577a56d74696d6505a464656570" + "81a161".repeat(40) + deepEnd, merged(webDeepMap, "New", 5))
    }

    @Test fun `metadata from the binding's typed writer merges to what the web would write`() {
        assertEquals("85a474797065a174a46e616d65a34e6577a56d74696d6505ab6465736372697074696f6ea164a5636f6c6f72a723616162626363",
            merged(typedAll, "New", 5))
    }

    @Test fun `long and non-ASCII titles are written at the right string width and unchanged values give identical bytes`() {
        assertEquals(webLongTitle, merged(webLongTitle, "A title that is longer than thirty-one bytes for str8", 1758800000000))
        assertEquals(webUnicodeTitle, merged(webUnicodeTitle, "Einkäufe für die Woche 🛒", 1758800000000))
    }

    @Test fun `a float mtime the typed decoder rejects is replaced by an integer`() {
        assertEquals("82a46e616d65a5466c6f6174a56d74696d65cf0000019980a63400", merged(webFloatMtime, "Float", 1758800000000))
    }

    @Test fun `a missing mtime or name is added after the other entries`() {
        assertEquals("82a46e616d65ab4f6e6c792061206e616d65a56d74696d65cf0000019980a63400", merged(webNoMtime, "Only a name", 1758800000000))
        assertEquals("82a46e616d65a178a56d74696d6501", merged(webEmpty, "x", 1))
        // hand-encoded: mtime first, then another key, and no name; the name goes after everything
        assertEquals("83a56d74696d6505a16ba131a46e616d65a34e6577", merged("82a56d74696d6501a16ba131", "New", 5))
    }

    @Test fun `both values are replaced in place whichever key comes first`() {
        // The two replacements are made in the order they appear in the input, with the bytes between copied once.
        assertEquals("83a56d74696d6505a56578747261a178a46e616d65a34e6577", merged(mtimeFirst, "New", 5))
    }

    @Test fun `name and mtime keys written at any string width are the same keys`() {
        // hand-encoded: name as str16, mtime as str32
        assertEquals("82da00046e616d65a34e6577db000000056d74696d6505", merged("82da00046e616d65a141db000000056d74696d6501", "New", 5))
    }

    @Test fun `adding the sixteenth entry grows the header from fixmap to map16`() {
        assertEquals("de0010a26b3000a26b3101a26b3202a26b3303a26b3404a26b3505a26b3606a26b3707a26b3808a26b3909a36b31300aa36b31310ba36b31320ca36b31330da46e616d65a772656e616d6564a56d74696d65cf00000199869c1500",
            merged(webFifteenNoMtime, "renamed", 1758900000000))
    }

    @Test fun `a map16 input is read and written as map16`() {
        val out = unhex(merged(webSixteen, "n", 5))
        assertEquals("de0012", hex(out.copyOfRange(0, 3)))
        assertEquals(NoteMetaCodec.Peek("n", 5), NoteMetaCodec.peek(out))
    }

    @Test fun `adding to a map of 65534 entries grows the header to map32`() {
        val input = ByteArrayOutputStream().apply {
            write(unhex("defffe"))
            repeat(65534) { write(0xa0); write(0x00) } // {'': 0} repeated, hand-encoded
        }.toByteArray()
        val out = (NoteMetaCodec.merge(input, "n", 5) as Merge.Merged).bytes
        assertEquals("df00010000", hex(out.copyOfRange(0, 5)))
        assertEquals(input.size + 2 + 14, out.size) // a wider header, then name 'n' and mtime 5 appended
        assertEquals(NoteMetaCodec.Peek("n", 5), NoteMetaCodec.peek(out))
    }

    @Test fun `negative integers keep their encodings`() {
        assertEquals("83a46e616d65a34f6c64a56d74696d65ffa564656c7461d1ff38", merged(webNegative, "Old", -1))
    }

    @Test fun `a blank name is written as an empty string like the web does`() {
        assertEquals(NoteMetaCodec.Peek("", 7), NoteMetaCodec.peek(unhex(merged(webNote, "", 7))))
    }

    @Test fun `a lone surrogate in a title is written as U+FFFD and reported as the name written`() {
        val result = NoteMetaCodec.merge(unhex(webEmpty), "A\uD800B", 6) as Merge.Merged
        assertEquals("82a46e616d65a541efbfbd42a56d74696d6506", hex(result.bytes))
        assertEquals("A�B", result.name)
        assertEquals(NoteMetaCodec.Peek(result.name, 6), NoteMetaCodec.peek(result.bytes))
    }

    @Test fun `only unpaired surrogates are replaced`() {
        val cart = "Einkauf 🛒"
        assertSame(cart, NoteMetaCodec.wellFormed(cart))
        assertEquals("", NoteMetaCodec.wellFormed(""))
        assertEquals("�x", NoteMetaCodec.wellFormed("\uDC00x"))
        assertEquals("x�", NoteMetaCodec.wellFormed("x\uD800"))
        assertEquals("�🛒", NoteMetaCodec.wellFormed("\uD83D🛒"))
        assertEquals("��", NoteMetaCodec.wellFormed("\uDED2\uD83D"))
    }

    // ---- refusing what cannot be merged safely ----

    @Test fun `a repeated name or mtime is refused rather than guessed`() {
        // hand-encoded, since no normal encoder writes them: {name: 'a', name: 'b'} and {mtime: 1, mtime: 2}
        assertEquals(Merge.Refused("name", Why.REPEATED), merge("82a46e616d65a161a46e616d65a162"))
        assertEquals(Merge.Refused("mtime", Why.REPEATED), merge("82a56d74696d6501a56d74696d6502"))
        // the same key at another string width is still the same key
        assertEquals(Merge.Refused("name", Why.REPEATED), merge("82a46e616d65a161d9046e616d65a162"))
        assertEquals(Merge.Refused("name", Why.REPEATED), merge("82a46e616d65a161da00046e616d65a162"))
        assertEquals(Merge.Refused("mtime", Why.REPEATED), merge("82a56d74696d6501db000000056d74696d6502"))
    }

    @Test fun `a key the typed decoder reads as name or mtime is refused`() {
        // Measured on a device: the typed decoder maps unsigned integer keys to field indexes
        // (1 name, 2 mtime) and matches binary keys by their bytes, so adding the plain key next to
        // one gives it a duplicate field. The web reads the integer keys as '1' and '2'.
        assertEquals(Merge.Refused("name", Why.ALIASED), merge("8201a34f6c64a56d74696d6505"))
        assertEquals(Merge.Refused("name", Why.ALIASED), merge("82cc01a34f6c64a56d74696d6505"))
        assertEquals(Merge.Refused("mtime", Why.ALIASED), merge("82a46e616d65a34f6c640205"))
        assertEquals(Merge.Refused("mtime", Why.ALIASED), merge("82a46e616d65a34f6c64cd000205"))
        assertEquals(Merge.Refused("mtime", Why.ALIASED), merge("82a46e616d65a34f6c64cf000000000000000205"))
        assertEquals(Merge.Refused("name", Why.ALIASED), merge("82c4046e616d65a34f6c64a56d74696d6505"))
        assertEquals(Merge.Refused("mtime", Why.ALIASED), merge("82a46e616d65a141c4056d74696d6505"))
        // other integer keys are not name or mtime: 0 is type, 3 and 4 are description and color (which a
        // notebook merge would refuse, a note merge copies), 10 and signed keys the typed decoder rejects anyway
        assertEquals("8300a141a56d74696d6505a46e616d65a34e6577", hex((merge("8200a141a56d74696d6501") as Merge.Merged).bytes))
        assertEquals("8303a141a56d74696d6505a46e616d65a34e6577", hex((merge("8203a141a56d74696d6501") as Merge.Merged).bytes))
        assertEquals("8304a141a56d74696d6505a46e616d65a34e6577", hex((merge("8204a141a56d74696d6501") as Merge.Merged).bytes))
        assertEquals("830aa141a56d74696d6505a46e616d65a34e6577", hex((merge("820aa141a56d74696d6501") as Merge.Merged).bytes))
        assertEquals("83d001a141a56d74696d6505a46e616d65a34e6577", hex((merge("82d001a141a56d74696d6501") as Merge.Merged).bytes))
    }

    @Test fun `a malformed UTF-8 key the web reads as name or mtime is refused`() {
        // The web decodes short keys without validating: overlong forms become ASCII, so each of these
        // reads as name (or mtime) there while the typed decoder ignores it.
        assertEquals(Merge.Refused("name", Why.ALIASED), merge("82a8c1aec1a1c1adc1a5a55469746c65a56d74696d6505"))
        assertEquals(Merge.Refused("name", Why.ALIASED), merge("82a6e081ae616d65a141a56d74696d6501"))
        assertEquals(Merge.Refused("name", Why.ALIASED), merge("82a7f08081ae616d65a141a56d74696d6501"))
        assertEquals(Merge.Refused("mtime", Why.ALIASED), merge("82a46e616d65a141a6c1ad74696d6505"))
        // with the plain key present too, the web shows the alias's value
        assertEquals(Merge.Refused("name", Why.ALIASED), merge("83a46e616d65a55469746c65a8c1aec1a1c1adc1a5a54f74686572a56d74696d6505"))
        // a sequence cut off at the end of the key reads into the bytes after it ('nam' + c1 + a5 reads as 'name')
        assertEquals(Merge.Refused("name", Why.ALIASED), merge("82a46e616dc1a55469746c65a56d74696d6505"))
    }

    @Test fun `keys longer than 16 bytes are read the same lenient way`() {
        // The browser decodes every key with utf8DecodeJs, not only the short, cached ones.
        // 'mtime' as five 4-byte overlong forms: a 20-byte key that reads as mtime there.
        val overlongMtime = "f08081adf08081b4f08081a9f08081adf08081a5"
        assertEquals(Merge.Refused("mtime", Why.ALIASED), merge("82a46e616d65a141b4${overlongMtime}05"))
        // 'mtim' in 16 overlong bytes and a lead byte cut off at the end: 17 bytes that read on into the value
        assertEquals(Merge.Refused("mtime", Why.ALIASED), merge("82a46e616d65a141b1${overlongMtime.substring(0, 32)}f005"))
        // a long key that is plainly something else is copied as it is
        val longKey = "78".repeat(40)
        assertEquals("83a46e616d65a34e6577d928${longKey}01a56d74696d6505", hex((merge("82a46e616d65a141d928${longKey}01") as Merge.Merged).bytes))
    }

    @Test fun `other malformed or near-miss keys are copied as they are`() {
        // {name, mtime, c3 28: 'x'} and {'namé': 'A', mtime}: neither reads as name or mtime anywhere
        assertEquals("83a46e616d65a34e6577a56d74696d6505a2c328a178", hex((merge("83a46e616d65a141a56d74696d6501a2c328a178") as Merge.Merged).bytes))
        assertEquals("83a56e616dc3a9a141a56d74696d6505a46e616d65a34e6577", hex((merge("82a56e616dc3a9a141a56d74696d6501") as Merge.Merged).bytes))
    }

    @Test fun `a repeated key this app does not use is copied as it is`() {
        val out = merged("83a46e616d65a161a16b01a16b02", "n", 1)
        assertEquals("84a46e616d65a16ea16b01a16b02a56d74696d6501", out)
    }

    @Test fun `anything that is not exactly one well-formed map is reported, never guessed at`() {
        assertEquals("empty", notAMap(null))
        assertEquals("empty", notAMap(ByteArray(0)))
        assertEquals("the top level is not a map", notAMap(unhex("9101")))
        assertEquals("the top level is not a map", notAMap(unhex("c0")))
        assertEquals("trailing bytes after the map", notAMap(unhex(webNote + "00")))
        for (fixture in allFixtures) {
            val full = unhex(fixture)
            for (length in 1 until full.size) {
                assertTrue("cut at $length of $fixture", NoteMetaCodec.merge(full.copyOf(length), "n", 1) is Merge.NotAMap)
                assertNull("cut at $length of $fixture", NoteMetaCodec.peek(full.copyOf(length)))
            }
        }
    }

    @Test fun `hostile lengths and counts are refused before any work`() {
        assertEquals("a container count runs past the end of the input", notAMap(unhex("dfffffffff")))
        assertEquals("a container count runs past the end of the input", notAMap(unhex("81a178ddffffffff")))
        assertEquals("a container count runs past the end of the input", notAMap(unhex("81a178dfffffffff")))
        assertEquals("a container count runs past the end of the input", notAMap(unhex("81a1789f0101")))
        assertEquals("a length runs past the end of the input", notAMap(unhex("81a178dbffffffff")))
        assertEquals("a length runs past the end of the input", notAMap(unhex("81a178c9ffffffff01")))
        assertEquals("a length runs past the end of the input", notAMap(unhex("81a178c70507abababab")))
        assertEquals("a length runs past the end of the input", notAMap(unhex("81a178d807" + "00".repeat(15))))
        assertEquals("reserved type 0xc1", notAMap(unhex("81a178c1")))
    }

    @Test fun `hostile nesting is skipped without recursion`() {
        // 200000 levels of {'': ...} as fixmaps and as map16, then of [..] as array16: well-formed, so merged and copied
        for (level in listOf("81a0", "de0001a0", "dc0001")) {
            val input = ByteArrayOutputStream().apply {
                write(unhex("81a178"))
                repeat(200_000) { write(unhex(level)) }
                write(0xc0)
            }.toByteArray()
            val out = (NoteMetaCodec.merge(input, "n", 1) as Merge.Merged).bytes
            assertEquals(input.size + 14, out.size)
            assertEquals(NoteMetaCodec.Peek("n", 1), NoteMetaCodec.peek(out))
            // one byte short at the bottom
            assertTrue(NoteMetaCodec.merge(input.copyOf(input.size - 1), "n", 1) is Merge.NotAMap)
        }
    }

    @Test fun `memory does not grow with the number of entries`() {
        // 2,000,000 entries of {'': 0}, hand-encoded; the typed decoder would accept it
        val count = 2_000_000
        val input = ByteArray(5 + 2 * count).also {
            unhex("df001e8480").copyInto(it)
            for (i in 0 until count) it[5 + 2 * i] = 0xa0.toByte()
        }
        // HotSpot's per-thread allocation counter, by reflection since unit tests compile against android.jar
        val bean = Class.forName("java.lang.management.ManagementFactory").getMethod("getThreadMXBean").invoke(null)
        val mx = Class.forName("com.sun.management.ThreadMXBean")
        val counter = mx.getMethod("getThreadAllocatedBytes", Long::class.javaPrimitiveType)
        // Without a working counter every difference below is 0 and the test would pass without measuring.
        assertTrue("allocation counting is supported", mx.getMethod("isThreadAllocatedMemorySupported").invoke(bean) as Boolean)
        assertTrue("allocation counting is enabled", mx.getMethod("isThreadAllocatedMemoryEnabled").invoke(bean) as Boolean)
        val id = Thread.currentThread().id
        fun allocated() = counter.invoke(bean, id) as Long
        assertTrue("the counter reports a value", allocated() >= 0)
        NoteMetaCodec.merge(unhex(webNote), "warm", 1)
        NoteMetaCodec.peek(unhex(webNote))
        val beforeMerge = allocated()
        val out = (NoteMetaCodec.merge(input, "n", 1) as Merge.Merged).bytes
        val merging = allocated() - beforeMerge
        val beforePeek = allocated()
        val peeked = NoteMetaCodec.peek(out)
        val peeking = allocated() - beforePeek
        assertEquals(NoteMetaCodec.Peek("n", 1), peeked)
        // the output buffer and its copy, and nothing per entry
        assertTrue("merge allocated $merging bytes for ${input.size}", merging < 3L * input.size)
        assertTrue("peek allocated $peeking bytes for ${out.size}", peeking < 64 * 1024)
    }

    // ---- reading name and mtime without the typed decoder ----

    @Test fun `peek reads what the typed decoder would and also what it rejects`() {
        assertEquals(NoteMetaCodec.Peek("Groceries", 1758800000000), NoteMetaCodec.peek(unhex(webNote)))
        assertEquals(NoteMetaCodec.Peek("Float", 1758800000000), NoteMetaCodec.peek(unhex(webFloatMtime)))
        assertEquals(NoteMetaCodec.Peek("Einkäufe für die Woche 🛒", 1758800000000), NoteMetaCodec.peek(unhex(webUnicodeTitle)))
        assertEquals(NoteMetaCodec.Peek("Old", -5), NoteMetaCodec.peek(unhex(webNegative)))
        assertEquals(NoteMetaCodec.Peek(null, null), NoteMetaCodec.peek(unhex(webEmpty)))
        assertEquals(NoteMetaCodec.Peek("Typed", 1758800000000), NoteMetaCodec.peek(unhex(typedAll)))
        // hand-encoded: mtime as float32 1.5 and float32 -2.5, truncated toward zero
        assertEquals(NoteMetaCodec.Peek("A", 1), NoteMetaCodec.peek(unhex("82a46e616d65a141a56d74696d65ca3fc00000")))
        assertEquals(NoteMetaCodec.Peek("A", -2), NoteMetaCodec.peek(unhex("82a46e616d65a141a56d74696d65cac0200000")))
    }

    @Test fun `peek leaves out values it cannot trust`() {
        // name is a number; name is invalid UTF-8; mtime is a string; mtime above Long.MAX_VALUE; NaN
        assertEquals(NoteMetaCodec.Peek(null, 1), NoteMetaCodec.peek(unhex("82a46e616d6505a56d74696d6501")))
        assertEquals(NoteMetaCodec.Peek(null, null), NoteMetaCodec.peek(unhex("81a46e616d65a2c328")))
        assertEquals(NoteMetaCodec.Peek("n", null), NoteMetaCodec.peek(unhex("82a46e616d65a16ea56d74696d65a131")))
        assertEquals(NoteMetaCodec.Peek(null, null), NoteMetaCodec.peek(unhex("81a56d74696d65cfffffffffffffffff")))
        assertEquals(NoteMetaCodec.Peek(null, null), NoteMetaCodec.peek(unhex("81a56d74696d65cb7ff8000000000000")))
        // repeated
        assertEquals(NoteMetaCodec.Peek(null, null), NoteMetaCodec.peek(unhex("82a46e616d65a161a46e616d65a162")))
        assertEquals(NoteMetaCodec.Peek("a", null), NoteMetaCodec.peek(unhex("83a46e616d65a161a56d74696d6501a56d74696d6502")))
        // aliased, by an integer key or a malformed UTF-8 key
        assertEquals(NoteMetaCodec.Peek(null, 5), NoteMetaCodec.peek(unhex("83a46e616d65a141a56d74696d650501a142")))
        assertEquals(NoteMetaCodec.Peek(null, 5), NoteMetaCodec.peek(unhex("82a8c1aec1a1c1adc1a5a55469746c65a56d74696d6505")))
        assertEquals(NoteMetaCodec.Peek("A", null), NoteMetaCodec.peek(unhex("83a46e616d65a141a56d74696d650502a142")))
        assertNull(NoteMetaCodec.peek(unhex("9101")))
    }

    // ---- widths, compared with the web's encoder ----

    @Test fun `integers are written at the same smallest width as the web's encoder`() {
        val web = "0:00,127:7f,128:cc80,255:ccff,256:cd0100,65535:cdffff,65536:ce00010000,4294967295:ceffffffff," +
            "4294967296:cf0000000100000000,1758800000000:cf0000019980a63400,-1:ff,-32:e0,-33:d0df,-128:d080," +
            "-129:d1ff7f,-32768:d18000,-32769:d2ffff7fff,-2147483648:d280000000,-2147483649:d3ffffffff7fffffff"
        for (pair in web.split(',')) {
            val (value, expected) = pair.split(':')
            val out = ByteArrayOutputStream().also { NoteMetaCodec.writeInt(it, value.toLong()) }.toByteArray()
            assertEquals(value, expected, hex(out))
        }
    }

    @Test fun `strings are written at the same smallest width as the web's encoder`() {
        val web = "0:a0,31:bf7878787878,32:d92078787878,255:d9ff78787878,256:da0100787878,65535:daffff787878,65536:db0001000078"
        for (pair in web.split(',')) {
            val (length, expectedPrefix) = pair.split(':')
            val out = ByteArrayOutputStream().also { NoteMetaCodec.writeString(it, "x".repeat(length.toInt())) }.toByteArray()
            assertEquals(length, expectedPrefix, hex(out).take(12))
            val header = when (expectedPrefix.take(2)) {
                "d9" -> 2
                "da" -> 3
                "db" -> 5
                else -> 1
            }
            assertEquals(length, header + length.toInt(), out.size)
        }
    }

    @Test fun `map headers are written at the smallest width`() {
        val expected = mapOf(0L to "80", 15L to "8f", 16L to "de0010", 65535L to "deffff", 65536L to "df00010000")
        for ((count, bytes) in expected) {
            assertEquals(count.toString(), bytes, hex(ByteArrayOutputStream().also { NoteMetaCodec.writeMapHeader(it, count) }.toByteArray()))
        }
    }

    @Test fun `every merged output is one map the codec itself reads back`() {
        for (raw in allFixtures) {
            val out = (NoteMetaCodec.merge(unhex(raw), "t", 42) as Merge.Merged).bytes
            assertEquals(raw, NoteMetaCodec.Peek("t", 42), NoteMetaCodec.peek(out))
            assertTrue(raw, NoteMetaCodec.merge(out, "t", 42).let { it is Merge.Merged && it.bytes.contentEquals(out) })
        }
    }
}
