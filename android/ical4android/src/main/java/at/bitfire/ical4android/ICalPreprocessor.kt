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

    /** RRULE/EXRULE line (group 1: name, parameters and colon; group 2: value, including folded continuation lines) */
    private val RECUR_REGEXP = Regex("^((?:RRULE|EXRULE)(?:;[^:\\r\\n]*)?:)([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)",
            setOf(RegexOption.MULTILINE, RegexOption.IGNORE_CASE))
    private val FOLDING_REGEXP = Regex("\\r?\\n[ \\t]")

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
     * RFC 5545 recurrence rule names and values are case-insensitive, but ical4j's [net.fortuna.ical4j.model.Recur]
     * only accepts upper case (`RRULE:freq=weekly` fails with "A recurrence rule MUST contain a FREQ rule part")
     * and fails on rule parts without a value (like `BYDAY=`).
     *
     * Rewrites values of all RRULE and EXRULE properties to upper case and drops empty rule parts.
     *
     * @param reader Reader that reads the potentially broken iCalendar (which for instance contains `RRULE:freq=weekly;BYDAY=`)
     * @return Reader that reads the fixed iCalendar (for instance `RRULE:FREQ=WEEKLY`)
     */
    fun fixInvalidRecurrenceRules(reader: Reader): Reader {
        fun normalize(value: String) =
                value.replace(FOLDING_REGEXP, "")
                        .uppercase(Locale.ROOT)
                        .split(';')
                        .filter { part -> part.isNotBlank() && !part.endsWith("=") }
                        .joinToString(";")

        val resetSupported = try {
            reader.reset()
            true
        } catch(e: IOException) {
            false
        }

        if (resetSupported) {
            // reset is supported, no need to copy the whole stream to another String (unless there is a recurrence rule)
            val found = Scanner(reader).findWithinHorizon(RECUR_REGEXP.toPattern(), 0) != null
            reader.reset()
            if (!found)
                return reader
        }

        return StringReader(reader.readText().replace(RECUR_REGEXP) {
            val fixed = normalize(it.groupValues[2])
            if (fixed != it.groupValues[2])
                Ical4Android.log.log(Level.FINE, "Normalizing recurrence rule", it.value)
            it.groupValues[1] + fixed
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