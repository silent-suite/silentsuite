package at.bitfire.ical4android

import net.fortuna.ical4j.model.Calendar
import net.fortuna.ical4j.model.Property
import net.fortuna.ical4j.transform.rfc5545.CreatedPropertyRule
import net.fortuna.ical4j.transform.rfc5545.DateListPropertyRule
import net.fortuna.ical4j.transform.rfc5545.DatePropertyRule
import net.fortuna.ical4j.transform.rfc5545.Rfc5545PropertyRule
import java.io.IOException
import java.io.Reader
import java.io.StringReader
import java.util.*
import java.util.logging.Level

/**
 * Applies some rules to increase compatibility or parsed iCalendars:
 *
 *   - [CreatedPropertyRule] to make sure CREATED is UTC
 *   - [DatePropertyRule], [DateListPropertyRule]: to rename Outlook-specific TZID parameters
 * (like "W. Europe Standard Time" to an Android-friendly name like "Europe/Vienna")
 *
 */
object ICalPreprocessor {

    private val TZOFFSET_REGEXP = Regex("^(TZOFFSET(FROM|TO):[+\\-]?)((18|19|[2-6]\\d)\\d\\d)$", RegexOption.MULTILINE)

    /** A line fold as ical4j's relaxed unfolding removes it: CRLF or LF followed by a space or tab. */
    private val FOLD_REGEXP = Regex("\\r?\\n[ \\t]")

    /**
     * A TRIGGER, DURATION or REFRESH-INTERVAL content line (in unfolded text) whose duration has
     * weeks and also days or a time, like `TRIGGER:-P1W2DT15H`. RFC 5545 allows weeks only on their
     * own, but Proton Calendar, for example, exports reminders of all-day events like this.
     *
     * The line must start after LF or at the beginning and end before CRLF, LF or the end, so other
     * line separators (like U+2028 inside a DESCRIPTION) don't count. Parameters may contain quoted
     * colons. The lookahead keeps plain `P2W` (which parses) out.
     */
    private val WEEK_DURATION_REGEXP = Regex(
        "(?:\\A|(?<=\\n))((?:TRIGGER|DURATION|REFRESH-INTERVAL)(?:;(?:\"[^\"\\r\\n]*\"|[^\":\\r\\n])*)?:)" +
                "([+\\-]?)P(\\d+)W(?=[\\dT])(?:(\\d+)D)?(T[\\dHMS]+)?(?=\\r?\\n|\\z)",
        RegexOption.IGNORE_CASE
    )

    private val propertyRules = arrayOf(
            CreatedPropertyRule(),      // make sure CREATED is UTC
            DatePropertyRule(),
            DateListPropertyRule()
    )


    /**
     * Some servers modify UTC offsets in TZOFFSET(FROM,TO) like "+005730" to an invalid "+5730".
     *
     * Rewrites values of all TZOFFSETFROM and TZOFFSETTO properties which match [TZOFFSET_REGEXP]
     * so that an hour value of 00 is inserted.
     *
     * @param reader Reader that reads the potentially broken iCalendar (which for instance contains `TZOFFSETFROM:+5730`)
     * @return Reader that reads the fixed iCalendar (for instance `TZOFFSETFROM:+005730`)
     */
    fun fixInvalidUtcOffset(reader: Reader): Reader {
        fun fixStringFromReader() =
                reader.readText().replace(TZOFFSET_REGEXP) {
                    Ical4Android.log.log(Level.FINE, "Applying Synology WebDAV fix to invalid utc-offset", it.value)
                    "${it.groupValues[1]}00${it.groupValues[3]}"
                }

        var result: String? = null

        val resetSupported = try {
            reader.reset()
            true
        } catch(e: IOException) {
            false
        }

        if (resetSupported) {
            // reset is supported, no need to copy the whole stream to another String (unless we have to fix the TZOFFSET)
            if (Scanner(reader).findWithinHorizon(TZOFFSET_REGEXP.toPattern(), 0) != null) {
                reader.reset()
                result = fixStringFromReader()
            }
        } else
            result = fixStringFromReader()

        if (result != null)
            return StringReader(result)

        // not modified, return original iCalendar
        reader.reset()
        return reader
    }


    /**
     * ical4j 3 passes a duration with days or a time to [java.time.Duration.parse], which can't
     * read weeks, so a single `TRIGGER:-P1W2DT15H` made the whole iCalendar unparseable
     * (DateTimeParseException) and stopped the calendar's sync.
     *
     * Rewrites such durations (see [WEEK_DURATION_REGEXP]) with the weeks as days, in upper case
     * so that ical4j reads whole days as a [java.time.Period] like any other `P…D` value. A week is
     * always 7 days in iCalendar, so the length stays the same. When something is rewritten, the
     * returned iCalendar is unfolded, which ical4j does anyway; otherwise it's the original text.
     *
     * @param reader Reader that reads the potentially broken iCalendar (which for instance contains `TRIGGER:-P1W2DT15H`)
     * @return Reader that reads the fixed iCalendar (for instance `TRIGGER:-P9DT15H`)
     */
    fun fixWeekDurations(reader: Reader): Reader {
        val original = reader.readText()
        val unfolded = original.replace(FOLD_REGEXP, "")
        if (!WEEK_DURATION_REGEXP.containsMatchIn(unfolded))
            return StringReader(original)

        return StringReader(unfolded.replace(WEEK_DURATION_REGEXP) {
            val days = runCatching {
                Math.addExact(Math.multiplyExact(it.groupValues[3].toLong(), 7L), it.groupValues[4].ifEmpty { "0" }.toLong())
            }.getOrNull()
            if (days == null)
                it.value        // too large to rewrite, leave it to ical4j
            else {
                Ical4Android.log.log(Level.FINE, "Rewriting weeks as days in duration", it.value)
                "${it.groupValues[1]}${it.groupValues[2]}P${days}D${it.groupValues[5].uppercase()}"
            }
        })
    }


    /**
     * Applies the set of rules (see class definition) to a given calendar object.
     *
     * @param calendar the calendar object that is going to be modified
     */
    fun preProcess(calendar: Calendar) {
        for (component in calendar.components) {
            for (property in component.properties)
                applyRules(property)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun applyRules(property: Property) {
        propertyRules
                .filter { rule -> rule.supportedType.isAssignableFrom(property::class.java) }
                .forEach {
                    Ical4Android.log.log(Level.FINER, "Applying rules to $property")
                    (it as Rfc5545PropertyRule<Property>).applyTo(property)
                    Ical4Android.log.log(Level.FINER, "-> $property")
                }
    }

}