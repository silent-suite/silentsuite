package at.bitfire.ical4android

import net.fortuna.ical4j.model.property.TzOffsetFrom
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.ComparisonFailure
import org.junit.Test
import java.time.ZoneOffset
import java.util.*

class LocaleNonWesternDigitsTest {

    companion object {
        val locale = Locale("fa", "ir", "u-un-arabext")
    }

    @Before
    fun verifyLocale() {
        assertEquals("Persian (Iran) locale not available", "fa", locale.language)
        Locale.setDefault(locale)
    }

    @Test
    fun testLocale_StringFormat() {
        // does not fail if the Locale with Persian digits is available
        assertEquals("۲۰۲۰", String.format("%d", 2020))
    }

    @Test
    fun testLocale_StringFormat_Root() {
        assertEquals("2020", String.format(Locale.ROOT, "%d", 2020))
    }

    @Test(expected = ComparisonFailure::class)      // should not fail in future
    fun testLocale_ical4j() {
        val offset = TzOffsetFrom(ZoneOffset.ofHours(1))
        val iCal = offset.toString()
        assertEquals("TZOFFSETFROM:+0100\r\n", iCal)        // fails: is "TZOFFSETFROM:+۰۱۰۰\r\n" instead
    }

}