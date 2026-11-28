package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NewPasswordRulesTest {

    @Test
    fun minimumLengthMatchesWebApp() {
        // apps/web sign-up and settings password change both use z.string().min(8).
        assertEquals(8, NewPasswordRules.MIN_LENGTH)
        assertFalse(NewPasswordRules.isLongEnough("a"))
        assertFalse(NewPasswordRules.isLongEnough("1234567"))
        assertTrue(NewPasswordRules.isLongEnough("12345678"))
    }

    @Test
    fun confirmationMustMatchExactly() {
        assertTrue(NewPasswordRules.matches("Secret123", "Secret123"))
        assertFalse(NewPasswordRules.matches("Secret123", "secret123"))
        assertFalse(NewPasswordRules.matches("Secret123", "Secret123 "))
        assertFalse(NewPasswordRules.matches("Secret123", ""))
    }
}
