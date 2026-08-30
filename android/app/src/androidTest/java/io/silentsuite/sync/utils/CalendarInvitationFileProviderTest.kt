package io.silentsuite.sync.utils

import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.R
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class CalendarInvitationFileProviderTest {

    @Test
    fun calendarInvitationAttachmentIsReadableThroughFileProvider() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val invitationDir = File(
            context.cacheDir,
            "calendar-invitations/${UUID.randomUUID()}"
        )
        val attachment = File(invitationDir, "invite.ics")
        val content = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"

        try {
            check(invitationDir.mkdirs())
            attachment.writeText(content)

            val uri = FileProvider.getUriForFile(
                context,
                context.getString(R.string.authority_log_provider),
                attachment
            )
            val actual = context.contentResolver.openInputStream(uri)?.use { stream ->
                stream.bufferedReader().readText()
            }

            assertEquals(content, actual)
        } finally {
            invitationDir.deleteRecursively()
        }
    }
}
