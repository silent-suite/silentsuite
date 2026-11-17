package io.silentsuite.sync.resource

import at.bitfire.vcard4android.Contact
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.StringReader
import java.util.Base64

/**
 * Contact photos the web app embeds as `PHOTO;VALUE=URI:data:...` in vCard 3.0 (#1127). The app
 * module hosts this because CI runs app:testDebugUnitTest, not the vendored library's unit tests.
 *
 * Synthetic cards only, parsed by the real Contact.fromReader the sync adapter uses.
 */
class EmbeddedContactPhotoTest {

    /** Records every download request; never touches the network. */
    private class RecordingDownloader(private val result: ByteArray?) : Contact.Downloader {
        val calls = mutableListOf<Pair<String, String>>()
        override fun download(url: String, accepts: String): ByteArray? {
            calls += url to accepts
            return result
        }
    }

    @Test fun `embedded data URI photo is decoded without the downloader`() {
        for (mediaType in listOf("image/png", "image/jpeg")) {
            val downloader = RecordingDownloader(byteArrayOf(9, 9, 9))
            val contact = parse(card("PHOTO;VALUE=URI:data:$mediaType;base64,$PNG_BASE64"), downloader)
            assertArrayEquals("BEHAVIOR $mediaType photo is the decoded payload", PNG_BYTES, contact.photo)
            assertEquals("BEHAVIOR $mediaType data URI is not downloaded", emptyList<Pair<String, String>>(), downloader.calls)
        }
    }

    @Test fun `embedded data URI photo is decoded without any downloader`() {
        val contact = parse(card("PHOTO;VALUE=URI:data:image/png;base64,$PNG_BASE64"), null)
        assertArrayEquals("BEHAVIOR photo is the decoded payload", PNG_BYTES, contact.photo)
    }

    @Test fun `unusable data URI photos are dropped without throwing or downloading`() {
        for (value in listOf("data:image/png;base64", "data:text/plain,hello", "data:image/png;base64,")) {
            val downloader = RecordingDownloader(byteArrayOf(9, 9, 9))
            val contact = parse(card("PHOTO;VALUE=URI:$value"), downloader)
            assertNull("BEHAVIOR unusable data URI #${value.length} gives no photo", contact.photo)
            assertEquals("BEHAVIOR unusable data URI #${value.length} is not downloaded",
                emptyList<Pair<String, String>>(), downloader.calls)
        }
    }

    @Test fun `embedded photo over the size cap is dropped`() {
        val tooLarge = ByteArray(5 * 1024 * 1024 + 1)
        val payload = Base64.getEncoder().encodeToString(tooLarge)
        val downloader = RecordingDownloader(byteArrayOf(9, 9, 9))
        val contact = parse(card("PHOTO;VALUE=URI:data:image/jpeg;base64,$payload"), downloader)
        assertNull("BEHAVIOR oversized embedded photo gives no photo", contact.photo)
        assertEquals("BEHAVIOR oversized embedded photo is not downloaded",
            emptyList<Pair<String, String>>(), downloader.calls)
    }

    @Test fun `http photo URL still goes through the downloader`() {
        val downloaded = byteArrayOf(1, 2, 3)
        val downloader = RecordingDownloader(downloaded)
        val contact = parse(card("PHOTO;VALUE=URI:https://example.invalid/photo.png"), downloader)
        assertEquals("BEHAVIOR http photo is downloaded once",
            listOf("https://example.invalid/photo.png" to "image/*"), downloader.calls)
        assertArrayEquals("BEHAVIOR photo is the downloaded body", downloaded, contact.photo)
    }

    private fun card(vararg lines: String): String =
        (listOf("BEGIN:VCARD", "VERSION:3.0", "UID:synthetic-photo", "FN:Synthetic Person", "N:Person;Synthetic;;;") +
            lines + "END:VCARD").joinToString("\r\n") + "\r\n"

    private fun parse(text: String, downloader: Contact.Downloader?): Contact {
        val contacts = Contact.fromReader(StringReader(text), downloader)
        if (contacts.size != 1) throw IllegalStateException("FIXTURE: expected one synthetic contact, got ${contacts.size}")
        return contacts[0]
    }

    private companion object {
        /** A 1x1 PNG. */
        const val PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
        val PNG_BYTES: ByteArray = Base64.getDecoder().decode(PNG_BASE64)
    }
}
