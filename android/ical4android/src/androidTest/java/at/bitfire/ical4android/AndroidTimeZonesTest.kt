package at.bitfire.ical4android

import org.junit.Assert
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.*

class AndroidTimeZonesTest {

    @Test
    fun testLoadSystemTimezones() {
        for (id in ZoneId.getAvailableZoneIds()) {
            val name = ZoneId.of(id).getDisplayName(TextStyle.FULL, Locale.US)
            val info = try {
                DateUtils.ical4jTimeZone(id)
            } catch(e: Exception) {
                Assert.fail("Invalid system timezone $name ($id)")
            }
            if (info == null)
                assertNotNull("ical4j can't load system timezone $name ($id)", info)
        }
    }

}