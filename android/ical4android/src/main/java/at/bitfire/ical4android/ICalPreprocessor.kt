package at.bitfire.ical4android

import net.fortuna.ical4j.model.Calendar
import net.fortuna.ical4j.model.Property
import net.fortuna.ical4j.transform.rfc5545.CreatedPropertyRule
import net.fortuna.ical4j.transform.rfc5545.DateListPropertyRule
import net.fortuna.ical4j.transform.rfc5545.DatePropertyRule
import net.fortuna.ical4j.transform.rfc5545.Rfc5545PropertyRule
import org.apache.commons.io.IOUtils
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
                IOUtils.toString(reader).replace(TZOFFSET_REGEXP) {
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