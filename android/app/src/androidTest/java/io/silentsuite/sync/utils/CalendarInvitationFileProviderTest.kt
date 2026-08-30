/*
 * Copyright © Tim Ross / SilentSuite contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 only.
 */

package io.silentsuite.sync.utils

import android.accounts.Account
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class CalendarInvitationFileProviderTest {

    private val content = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"

    @Test
    fun productionAttachmentIsReadableThroughFileProvider() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val invitationRoot = File(context.cacheDir, "calendar-invitations")
        val invitation = EventEmailInvitation(context, Account("owner@example.com", "test"))
        val existingDirectories = invitationRoot.listFiles()?.toSet().orEmpty()

        try {
            val uri = invitation.createAttachmentFromString(context, content)
            assertNotNull(uri)

            val actual = context.contentResolver.openInputStream(requireNotNull(uri)).use { stream ->
                requireNotNull(stream).bufferedReader().readText()
            }
            assertEquals(content, actual)
        } finally {
            invitationRoot.listFiles()
                ?.filterNot(existingDirectories::contains)
                ?.forEach { it.deleteRecursively() }
        }
    }

    @Test
    fun fileProviderFailureReturnsNull() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val invitationRoot = File(context.cacheDir, "calendar-invitations")
        val invitation = EventEmailInvitation(context, Account("owner@example.com", "test"))
        val existingDirectories = invitationRoot.listFiles()?.toSet().orEmpty()

        try {
            val uri = invitation.createAttachmentFromString(context, content) { _, _ ->
                throw IllegalArgumentException("test FileProvider failure")
            }

            assertNull(uri)
            assertEquals(existingDirectories, invitationRoot.listFiles()?.toSet().orEmpty())
        } finally {
            invitationRoot.listFiles()
                ?.filterNot(existingDirectories::contains)
                ?.forEach { it.deleteRecursively() }
        }
    }
}
