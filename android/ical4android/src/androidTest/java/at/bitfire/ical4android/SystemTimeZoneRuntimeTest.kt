package at.bitfire.ical4android

import android.Manifest
import android.accounts.Account
import android.content.ContentUris
import android.provider.CalendarContract
import androidx.test.platform.app.InstrumentationRegistry.getInstrumentation
import androidx.test.rule.GrantPermissionRule
import at.bitfire.ical4android.MiscUtils.ContentProviderClientHelper.closeCompat
import at.bitfire.ical4android.impl.TestCalendar
import at.bitfire.ical4android.impl.TestEvent
import io.silentsuite.ical4j.SystemVTimeZones
import net.fortuna.ical4j.data.CalendarBuilder
import net.fortuna.ical4j.model.DateTime
import net.fortuna.ical4j.model.Property
import net.fortuna.ical4j.model.component.VTimeZone
import net.fortuna.ical4j.model.property.TzOffsetTo
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.StringReader
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.TreeSet

/**
 * The patched ical4j (ICAL4J-PATCH.md) on Android's own calendar classes and CalendarProvider.
 * Expected instants come from the device's zone rules, whatever tz data the emulator image has.
 */
class SystemTimeZoneRuntimeTest {

    @JvmField
    @Rule
    val permissionRule = GrantPermissionRule.grant(
        Manifest.permission.READ_CALENDAR,
        Manifest.permission.WRITE_CALENDAR
    )!!

    private val testAccount = Account("ical4android-tz@example.com", CalendarContract.ACCOUNT_TYPE_LOCAL)
    private val vancouver = ZoneId.of("America/Vancouver")
    private val wallFormat = DateTimeFormatter.ofPattern("uuuuMMdd'T'HHmmss")

    private val provider by lazy {
        getInstrumentation().targetContext.contentResolver.acquireContentProviderClient(CalendarContract.AUTHORITY)!!
    }
    private lateinit var calendar: TestCalendar

    @Before
    fun prepare() {
        Ical4Android.checkThreadContextClassLoader()
        calendar = TestCalendar.findOrCreate(testAccount, provider)
    }

    @After
    fun shutdown() {
        calendar.delete()
        provider.closeCompat()
    }

    private fun instant(wall: String, zone: ZoneId = vancouver): Long =
        LocalDateTime.parse(wall, wallFormat).atZone(zone).toInstant().toEpochMilli()

    @Test
    fun patchedIcal4jClassesAreLoaded() {
        assertEquals("system-zone-rules-1",
            net.fortuna.ical4j.model.TimeZone::class.java.getField("SILENTSUITE_PATCH").get(null))
    }

    @Test
    fun everySystemZoneMatchesTheDeviceRules() {
        val failures = mutableListOf<String>()
        var checked = 0
        for (id in TreeSet(ZoneId.getAvailableZoneIds())) {
            val tz = DateUtils.ical4jTimeZone(id) ?: continue
            // tz.alias may map an ID to another zone, which this test APK's java.time (desugared,
            // minSdk 21) may not know; the app itself (minSdk 29) uses the platform's java.time
            val zone = SystemVTimeZones.systemZone(tz.id) ?: continue
            var wall = LocalDateTime.of(2000, 1, 3, 10, 0)
            while (wall.year < 2036) {
                val expected = wall.atZone(zone).toInstant().toEpochMilli()
                val parsed = DateTime(wallFormat.format(wall), tz).time
                val formatted = DateTime(expected).apply { timeZone = tz }.toString()
                val expectedWall = wallFormat.format(LocalDateTime.ofInstant(Instant.ofEpochMilli(expected), zone))
                if ((parsed != expected || formatted != expectedWall) && failures.size < 20)
                    failures += "$id $wall: parsed ${Instant.ofEpochMilli(parsed)}, formatted $formatted (want $expectedWall)"
                checked++
                wall = wall.plusHours(997)
            }
        }
        assertTrue("checked $checked", checked > 100_000)
        assertEquals(failures.joinToString("\n"), 0, failures.size)
    }

    private val series = """
        BEGIN:VCALENDAR
        VERSION:2.0
        PRODID:test
        BEGIN:VEVENT
        UID:tz-runtime-series
        DTSTAMP:20260101T000000Z
        SUMMARY:Weekly
        DTSTART;TZID=America/Vancouver:20260108T100000
        DTEND;TZID=America/Vancouver:20260108T110000
        RRULE:FREQ=WEEKLY;COUNT=60
        EXDATE;TZID=America/Vancouver:20261112T100000
        END:VEVENT
        BEGIN:VEVENT
        UID:tz-runtime-series
        DTSTAMP:20260101T000000Z
        SUMMARY:Moved
        RECURRENCE-ID;TZID=America/Vancouver:20260115T100000
        DTSTART;TZID=America/Vancouver:20260115T113000
        DTEND;TZID=America/Vancouver:20260115T123000
        END:VEVENT
        END:VCALENDAR
    """.trimIndent().replace("\n", "\r\n") + "\r\n"

    @Test
    fun vancouverSeriesThroughCalendarProvider() {
        val parsed = Event.eventsFromReader(StringReader(series)).single()
        assertEquals(instant("20260108T100000"), parsed.dtStart!!.date.time)

        val id = ContentUris.parseId(TestEvent(calendar, parsed).add())
        val stored = calendar.findById(id).event!!
        assertEquals(instant("20260108T100000"), stored.dtStart!!.date.time)
        assertEquals("America/Vancouver", stored.dtStart!!.timeZone.id)
        val exception = stored.exceptions.single()
        assertEquals(instant("20260115T100000"), exception.recurrenceId!!.date.time)
        assertEquals(instant("20260115T113000"), exception.dtStart!!.date.time)

        // CalendarProvider expands the series itself with the device's rules
        val from = instant("20261101T000000")
        val to = instant("20261130T235959")
        val begins = mutableListOf<Long>()
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon()
            .appendPath(from.toString()).appendPath(to.toString()).build()
        provider.query(uri, arrayOf(CalendarContract.Instances.BEGIN),
            "${CalendarContract.Instances.EVENT_ID}=?", arrayOf(id.toString()),
            CalendarContract.Instances.BEGIN)!!.use { cursor ->
            while (cursor.moveToNext())
                begins += cursor.getLong(0)
        }
        assertEquals(
            listOf("20261105T100000", "20261119T100000", "20261126T100000").map { instant(it) },
            begins)
    }

    @Test
    fun writtenEventKeepsWallTimesAndAMatchingDefinition() {
        val parsed = Event.eventsFromReader(StringReader(series)).single()
        val id = ContentUris.parseId(TestEvent(calendar, parsed).add())
        val stored = calendar.findById(id).event!!

        val written = ByteArrayOutputStream().also { stored.write(it) }.toString(Charsets.UTF_8.name())
        assertTrue(written, written.contains("DTSTART;TZID=America/Vancouver:20260108T100000"))
        assertTrue(written, written.contains("RECURRENCE-ID;TZID=America/Vancouver:20260115T100000"))
        assertTrue(written, written.contains("20261112T100000"))

        // a client that evaluates the written VTIMEZONE itself gets the device's offsets
        val custom = written.replace("TZID=America/Vancouver", "TZID=Written").replace("TZID:America/Vancouver", "TZID:Written")
        val vTimeZone = CalendarBuilder().build(StringReader(custom)).getComponent(VTimeZone.VTIMEZONE) as VTimeZone
        for (at in listOf("20260108T100000", "20260715T100000", "20261119T100000", "20270115T100000").map { instant(it) }) {
            val observance = vTimeZone.getApplicableObservance(DateTime(at))
            val offset = (observance.getProperty(Property.TZOFFSETTO) as TzOffsetTo).offset.totalSeconds
            assertEquals("at ${Instant.ofEpochMilli(at)} in\n$written", vancouver.rules.getOffset(Instant.ofEpochMilli(at)).totalSeconds, offset)
        }
    }

}
