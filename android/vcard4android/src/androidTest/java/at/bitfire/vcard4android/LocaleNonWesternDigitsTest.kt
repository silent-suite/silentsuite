package at.bitfire.vcard4android

import ezvcard.Ezvcard
import ezvcard.VCard
import ezvcard.VCardVersion
import ezvcard.property.Geo
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
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
        assertEquals("۲۰۲۰", String.format("%d", 2020))
    }

    @Test
    fun testLocale_StringFormat_Root() {
        assertEquals("2020", String.format(Locale.ROOT, "%d", 2020))
    }

    @Test
    fun testLocale_ezVCard() {
        val vCard = VCard(VCardVersion.V4_0)
        vCard.geo = Geo(1.0, 2.0)
        assertEquals("BEGIN:VCARD\r\n" +
                "VERSION:4.0\r\n" +
                "PRODID:ez-vcard 0.11.2\r\n" +
                "GEO:geo:1.0,2.0\r\n" +             // failed before 0.11.2: was "GEO:geo:۱.۰,۲.۰\r\n" instead
                "END:VCARD\r\n", Ezvcard.write(vCard).go())
    }

}