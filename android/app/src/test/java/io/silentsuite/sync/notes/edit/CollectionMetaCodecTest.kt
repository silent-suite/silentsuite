package io.silentsuite.sync.notes.edit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CollectionMetaCodecTest {

    private fun unhex(value: String): ByteArray =
        ByteArray(value.length / 2) { index -> value.substring(index * 2, index * 2 + 2).toInt(16).toByte() }

    private fun hex(value: ByteArray): String =
        value.joinToString("") { "%02x".format(it) }

    @Test
    fun `calendar task list and notebook fields update while unknown values survive byte for byte`() {
        // type, name, mtime, description, color and an opaque field from another client.
        val raw = unhex("86a474797065a174a46e616d65a34f6c64a56d74696d6501ab6465736372697074696f6ea164a5636f6c6f72a723616162626363a56578747261a76b6565702d6d65")

        val result = NoteMetaCodec.mergeCollection(raw, "New", null, 5L, "#112233")
        assertTrue(result is NoteMetaCodec.Merge.Merged)
        val merged = result as NoteMetaCodec.Merge.Merged
        assertEquals("New", merged.name)
        assertEquals(
            "86a474797065a174a46e616d65a34e6577a56d74696d6505ab6465736372697074696f6ec0a5636f6c6f72a723313132323333a56578747261a76b6565702d6d65",
            hex(merged.bytes),
        )
    }

    @Test
    fun `address book edit preserves color and all unknown fields`() {
        val raw = unhex("86a474797065a174a46e616d65a34f6c64a56d74696d6501ab6465736372697074696f6ea164a5636f6c6f72a723616162626363a56578747261a76b6565702d6d65")

        val result = NoteMetaCodec.mergeCollection(raw, "Contacts", "People", 9L, null)
        assertTrue(result is NoteMetaCodec.Merge.Merged)
        assertEquals(
            "86a474797065a174a46e616d65a8436f6e7461637473a56d74696d6509ab6465736372697074696f6ea650656f706c65a5636f6c6f72a723616162626363a56578747261a76b6565702d6d65",
            hex((result as NoteMetaCodec.Merge.Merged).bytes),
        )
    }

    @Test
    fun `missing description and color fields are added only when the editor owns them`() {
        val raw = unhex("82a474797065a174a17801")
        val result = NoteMetaCodec.mergeCollection(raw, "Calendar", "Work", 10L, "#abcdef")
        assertTrue(result is NoteMetaCodec.Merge.Merged)
        assertEquals(
            "86a474797065a174a17801a46e616d65a843616c656e646172a56d74696d650aab6465736372697074696f6ea4576f726ba5636f6c6f72a723616263646566",
            hex((result as NoteMetaCodec.Merge.Merged).bytes),
        )
    }

    @Test
    fun `repeated and typed integer alias keys are refused for every edited field`() {
        val repeatedName = unhex("82a46e616d65a141a46e616d65a142")
        assertEquals(NoteMetaCodec.Merge.Refused("name", NoteMetaCodec.Why.REPEATED),
            NoteMetaCodec.mergeCollection(repeatedName, "New", null, 1L, null))

        val descriptionIndex = unhex("8103a164")
        assertEquals(NoteMetaCodec.Merge.Refused("description", NoteMetaCodec.Why.ALIASED),
            NoteMetaCodec.mergeCollection(descriptionIndex, "New", null, 1L, null))

        val colorIndex = unhex("8104a723616162626363")
        assertEquals(NoteMetaCodec.Merge.Refused("color", NoteMetaCodec.Why.ALIASED),
            NoteMetaCodec.mergeCollection(colorIndex, "New", null, 1L, "#112233"))
    }

    @Test
    fun `empty metadata is accepted for a newly created collection`() {
        val result = NoteMetaCodec.mergeCollection(null, "New", null, 1L, "#112233")
        assertTrue(result is NoteMetaCodec.Merge.Merged)
        assertEquals(
            "84a46e616d65a34e6577a56d74696d6501ab6465736372697074696f6ec0a5636f6c6f72a723313132323333",
            hex((result as NoteMetaCodec.Merge.Merged).bytes),
        )
    }

    @Test
    fun `malformed metadata is refused without replacing it with a typed map`() {
        assertTrue(NoteMetaCodec.mergeCollection(unhex("81a178dbffffffff"), "New", null, 1L, null) is NoteMetaCodec.Merge.NotAMap)
        assertTrue(NoteMetaCodec.mergeCollection(unhex("8000"), "New", null, 1L, null) is NoteMetaCodec.Merge.NotAMap)
    }
}
