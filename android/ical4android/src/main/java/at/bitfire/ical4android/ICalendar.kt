/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android

import net.fortuna.ical4j.data.CalendarBuilder
import net.fortuna.ical4j.data.ParserException
import net.fortuna.ical4j.model.Calendar
import net.fortuna.ical4j.model.Date
import net.fortuna.ical4j.model.Parameter
import net.fortuna.ical4j.model.Property
import net.fortuna.ical4j.model.component.*
import net.fortuna.ical4j.model.parameter.Related
import net.fortuna.ical4j.model.property.*
import net.fortuna.ical4j.validate.ValidationException
import java.io.Reader
import java.io.StringReader
import java.time.Duration
import java.time.Period
import java.util.*
import java.util.logging.Level
import java.util.logging.Logger

open class ICalendar {

    var uid: String? = null
    var sequence: Int? = null

    companion object {

        // static ical4j initialization
        init {
            // reduce verbosity of various ical4j loggers
            org.slf4j.LoggerFactory.getLogger(net.fortuna.ical4j.data.CalendarParserImpl::class.java)
            Logger.getLogger(net.fortuna.ical4j.data.CalendarParserImpl::class.java.name).level = Level.CONFIG

            org.slf4j.LoggerFactory.getLogger(net.fortuna.ical4j.model.Recur::class.java)
            Logger.getLogger(net.fortuna.ical4j.model.Recur::class.java.name).level = Level.CONFIG

            org.slf4j.LoggerFactory.getLogger(net.fortuna.ical4j.data.FoldingWriter::class.java)
            Logger.getLogger(net.fortuna.ical4j.data.FoldingWriter::class.java.name).level = Level.CONFIG
        }

        // known iCalendar properties
        const val CALENDAR_NAME = "X-WR-CALNAME"

        /**
         * Default PRODID used when generating iCalendars. If you want another value, set it
         * statically before writing the first iCalendar.
         */
        var prodId = ProdId("+//IDN bitfire.at//ical4android")


        // parser

        /**
         * Parses an iCalendar resource and applies [ICalPreprocessor] to increase compatibility.
         *
         * @param reader where the iCalendar is taken from
         * @param properties Known iCalendar properties (like [CALENDAR_NAME]) will be put into this map. Key: property name; value: property value
         *
         * @return parsed iCalendar resource
         * @throws ParserException when the iCalendar can't be parsed
         * @throws IllegalArgumentException when the iCalendar resource contains an invalid value
         */
        @UsesThreadContextClassLoader
        fun fromReader(reader: Reader, properties: MutableMap<String, String>? = null): Calendar {
            Ical4Android.log.fine("Parsing iCalendar stream")
            Ical4Android.checkThreadContextClassLoader()

            // apply hacks and workarounds that operate on plain text level
            val reader2 = ICalPreprocessor.fixInvalidUtcOffset(reader)

            // parse stream
            val calendar: Calendar
            try {
                calendar = CalendarBuilder().build(reader2)
            } catch(e: ParserException) {
                throw InvalidCalendarException("Couldn't parse iCalendar", e)
            } catch(e: IllegalArgumentException) {
                throw InvalidCalendarException("iCalendar contains invalid value", e)
            }

            // apply ICalPreprocessor for increased compatibility
            try {
                ICalPreprocessor.preProcess(calendar)
            } catch (e: Exception) {
                Ical4Android.log.log(Level.WARNING, "Couldn't pre-process iCalendar", e)
            }

            // fill calendar properties
            properties?.let {
                calendar.getProperty<Property>(CALENDAR_NAME)?.let { calName ->
                    properties[CALENDAR_NAME] = calName.value
                }
            }

            return calendar
        }


        // time zone helpers

        /**
         * Minifies a VTIMEZONE so that only these observances are kept:
         *
         *   - the last STANDARD observance matching [start], and
         *   - the last DAYLIGHT observance matching [start], and
         *   - observances beginning after [start]
         *
         * Additionally, TZURL properties are filtered.
         *
         * @param originalTz    time zone definition to minify
         * @param start         start date for components (usually DTSTART); *null* if unknown
         * @return              minified time zone definition
         */
        fun minifyVTimeZone(originalTz: VTimeZone, start: Date?): VTimeZone {
            val newTz = originalTz.copy() as VTimeZone
            val keep = mutableSetOf<Observance>()

            if (start != null) {
                // find latest matching STANDARD/DAYLIGHT observances
                var latestDaylight: Pair<Date, Observance>? = null
                var latestStandard: Pair<Date, Observance>? = null
                for (observance in newTz.observances) {
                    val latest = observance.getLatestOnset(start)

                    if (latest == null)         // observance begins after "start", keep in any case
                        keep += observance
                    else
                        when (observance) {
                            is Standard ->
                                if (latestStandard == null || latest > latestStandard.first)
                                    latestStandard = Pair(latest, observance)
                            is Daylight ->
                                if (latestDaylight == null || latest > latestDaylight.first)
                                    latestDaylight = Pair(latest, observance)
                        }
                }

                // keep latest STANDARD observance
                latestStandard?.second?.let { keep += it }

                // Check latest DAYLIGHT for whether it can apply in the future. Otherwise, DST is not
                // used in this time zone anymore and the DAYLIGHT component can be dropped completely.
                latestDaylight?.second?.let { daylight ->
                    // check whether start time is in DST
                    if (latestStandard != null) {
                        val latestStandardOnset = latestStandard.second.getLatestOnset(start)
                        val latestDaylightOnset = daylight.getLatestOnset(start)
                        if (latestStandardOnset != null && latestDaylightOnset != null && latestDaylightOnset > latestStandardOnset) {
                            // we're currently in DST
                            keep += daylight
                            return@let
                        }
                    }

                    // check RRULEs
                    for (rRule in daylight.getProperties<RRule>(Property.RRULE)) {
                        val nextDstOnset = rRule.recur.getNextDate(daylight.startDate.date, start)
                        if (nextDstOnset != null) {
                            // there will be a DST onset in the future -> keep DAYLIGHT
                            keep += daylight
                            return@let
                        }
                    }
                    // no RRULE, check whether there's an RDATE in the future
                    for (rDate in daylight.getProperties<RDate>(Property.RDATE)) {
                        if (rDate.dates.any { it >= start }) {
                            // RDATE in the future
                            keep += daylight
                            return@let
                        }
                    }
                }

                // remove all observances that shall not be kept
                val iterator = newTz.observances.iterator() as MutableIterator<Observance>
                while (iterator.hasNext()) {
                    val entry = iterator.next()
                    if (!keep.contains(entry))
                        iterator.remove()
                }
            }

            // remove unnecessary properties
            newTz.properties.removeAll { it is TzUrl || it is XProperty }

            // validate minified timezone
            try {
                newTz.validate()
            } catch (e: ValidationException) {
                // This should never happen!
                Ical4Android.log.log(Level.WARNING, "Minified timezone is invalid, using original one", e)
                return originalTz
            }

            return newTz
        }

        /**
         * Takes a string with a timezone definition and returns the time zone ID.
         * @param timezoneDef time zone definition (VCALENDAR with VTIMEZONE component)
         * @return time zone id (TZID) if VTIMEZONE contains a TZID, null otherwise
         */
        @UsesThreadContextClassLoader
        fun timezoneDefToTzId(timezoneDef: String): String? {
            Ical4Android.checkThreadContextClassLoader()
            try {
                val builder = CalendarBuilder()
                val cal = builder.build(StringReader(timezoneDef))
                val timezone = cal.getComponent(VTimeZone.VTIMEZONE) as VTimeZone?
                timezone?.timeZoneId?.let { return it.value }
            } catch (e: ParserException) {
                Ical4Android.log.log(Level.SEVERE, "Can't understand time zone definition", e)
            }
            return null
        }

        /**
         * Validates an iCalendar resource.
         *
         * Debug builds only: throws [ValidationException] when the resource is invalid.
         * Release builds only: prints a warning to the log when the resource is invalid.
         *
         * @param ical iCalendar resource to be validated
         *
         * @throws ValidationException when the resource is invalid (only if [BuildConfig.DEBUG] is set)
         */
        fun softValidate(ical: Calendar) {
            try {
                ical.validate(true)
            } catch (e: ValidationException) {
                if (BuildConfig.DEBUG)
                    // debug build, re-throw ValidationException
                    throw e
                else
                    Ical4Android.log.log(Level.WARNING, "iCalendar validation failed - This is only a warning!", e)
            }
        }


        // misc. iCalendar helpers

        /**
         * Calculates the minutes before/after an event/task a given alarm occurs.
         *
         * @param alarm the alarm to calculate the minutes from
         * @param reference reference [VEvent] or [VToDo] to take start/end time from (required for calculations)
         * @param allowRelEnd *true*: caller accepts minutes related to the end;
         * *false*: caller only accepts minutes related to the start
         *
         * Android's alarm granularity is minutes. This methods calculates with milliseconds, but the result
         * is rounded down to minutes (seconds cut off).
         *
         * @return Pair of values:
         *
         * 1. whether the minutes are related to the start or end (always [Related.START] if [allowRelEnd] is *false*)
         * 2. number of minutes before start/end (negative value means number of minutes *after* start/end)
         *
         * May be *null* if there's not enough information to calculate the number of minutes.
         */
        fun vAlarmToMin(alarm: VAlarm, reference: ICalendar, allowRelEnd: Boolean): Pair<Related, Int>? {
            val trigger = alarm.trigger ?: return null

            val minutes: Int    // minutes before/after the event
            var related = trigger.getParameter<Related>(Parameter.RELATED) ?: Related.START

            // event/task start time
            val start: java.util.Date?
            var end: java.util.Date?
            when (reference) {
                is Event -> {
                    start = reference.dtStart?.date
                    end = reference.dtEnd?.date
                }
                is Task -> {
                    start = reference.dtStart?.date
                    end = reference.due?.date
                }
                else -> throw IllegalArgumentException("reference must be Event or Task")
            }

            // event/task end time
            if (end == null && start != null) {
                val duration = when (reference) {
                    is Event -> reference.duration?.duration
                    is Task -> reference.duration?.duration
                    else -> throw IllegalArgumentException("reference must be Event or Task")
                }
                if (duration != null)
                    end = Date.from(start.toInstant() + duration)
            }

            // event/task duration
            val duration: Duration? =
                    if (start != null && end != null)
                        Duration.between(start.toInstant(), end.toInstant())
                    else
                        null

            val triggerDur = trigger.duration
            val triggerTime = trigger.dateTime

            if (triggerDur != null) {
                // TRIGGER value is a DURATION. Important:
                // 1) Negative values in TRIGGER mean positive values in Reminders.MINUTES and vice versa.
                // 2) Android doesn't know alarm seconds, but only minutes. Cut off seconds from the final result.
                // 3) DURATION can be a Duration (time-based) or a Period (date-based), which have to be treated differently.
                var millisBefore =
                        if (triggerDur is Duration)
                            -triggerDur.toMillis()
                        else if (triggerDur is Period)
                            // TODO: Take time zones into account (will probably be possible with ical4j 4.x).
                            // For instance, an alarm one day before the DST change should be 23/25 hours before the event.
                            -triggerDur.days.toLong()*24*3600000     // months and years are not used in DURATION values; weeks are calculated to days
                        else
                            throw AssertionError("triggerDur must be Duration or Period")

                if (related == Related.END && !allowRelEnd) {
                    if (duration == null) {
                        Ical4Android.log.warning("Event/task without duration; can't calculate END-related alarm")
                        return null
                    }
                    // move alarm towards end
                    related = Related.START
                    millisBefore -= duration.toMillis()
                }
                minutes = (millisBefore / 60000).toInt()

            } else if (triggerTime != null && start != null) {
                // TRIGGER value is a DATE-TIME, calculate minutes from start time
                related = Related.START
                minutes = Duration.between(triggerTime.toInstant(), start.toInstant()).toMinutes().toInt()

            } else {
                Ical4Android.log.log(Level.WARNING, "VALARM TRIGGER type is not DURATION or DATE-TIME (requires event DTSTART for Android), ignoring alarm", alarm)
                return null
            }

            return Pair(related, minutes)
        }

    }


    protected fun generateUID() {
        uid = UUID.randomUUID().toString()
    }

    override fun toString() = MiscUtils.reflectionToString(this)

}