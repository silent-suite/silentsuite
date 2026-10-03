package io.silentsuite.sync.resource

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LocalCalendarColorTest {
    @Test fun `hex colors parse with or without a hash and with alpha`() {
        assertEquals(0xFFFF0000.toInt(), LocalCalendar.parseColorOrNull("#FF0000"))
        assertEquals(0xFF00FF00.toInt(), LocalCalendar.parseColorOrNull("00ff00"))
        assertEquals(0x800000FF.toInt(), LocalCalendar.parseColorOrNull("#0000FF80"))
    }

    @Test fun `absent colors read as no color`() {
        assertNull(LocalCalendar.parseColorOrNull(null))
        assertNull(LocalCalendar.parseColorOrNull(""))
        assertNull(LocalCalendar.parseColorOrNull("   "))
    }

    @Test fun `six and eight character values that are not hex read as no color instead of throwing`() {
        // parseColor throws NumberFormatException on these; another client can write any of them.
        assertNull(LocalCalendar.parseColorOrNull("orange"))
        assertNull(LocalCalendar.parseColorOrNull("#purple"))
        assertNull(LocalCalendar.parseColorOrNull("lavender"))
        assertNull(LocalCalendar.parseColorOrNull("#ff0000zz"))
    }

    @Test fun `other lengths keep the existing default color`() {
        assertEquals(LocalCalendar.defaultColor, LocalCalendar.parseColorOrNull("red"))
        assertEquals(LocalCalendar.defaultColor, LocalCalendar.parseColorOrNull("#fff"))
    }
}
