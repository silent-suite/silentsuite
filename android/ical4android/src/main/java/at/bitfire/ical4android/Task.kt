/*
 * Copyright © Ricki Hirner and contributors (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 *
 * Contributors: Alex Baker
 */

package at.bitfire.ical4android

import androidx.annotation.IntRange
import net.fortuna.ical4j.data.CalendarOutputter
import net.fortuna.ical4j.data.ParserException
import net.fortuna.ical4j.model.*
import net.fortuna.ical4j.model.Calendar
import net.fortuna.ical4j.model.TimeZone
import net.fortuna.ical4j.model.component.VAlarm
import net.fortuna.ical4j.model.component.VToDo
import net.fortuna.ical4j.model.property.*
import java.io.IOException
import java.io.OutputStream
import java.io.Reader
import java.net.URI
import java.net.URISyntaxException
import java.util.*
import java.util.logging.Level

class Task: ICalendar() {

    var createdAt: Long? = null
    var lastModified: Long? = null

    var summary: String? = null
    var location: String? = null
    var geoPosition: Geo? = null
    var description: String? = null
    var color: Int? = null
    var url: String? = null
    var organizer: Organizer? = null

    @IntRange(from = 0, to = 9)
    var priority: Int = Priority.UNDEFINED.level

    var classification: Clazz? = null
    var status: Status? = null

    var dtStart: DtStart? = null
    var due: Due? = null
    var duration: Duration? = null
    var completedAt: Completed? = null

    @IntRange(from = 0, to = 100)
    var percentComplete: Int? = null

    var rRule: RRule? = null
    val rDates = LinkedList<RDate>()
    val exDates = LinkedList<ExDate>()

    val categories = LinkedList<String>()
    var relatedTo = LinkedList<RelatedTo>()
    val unknownProperties = LinkedList<Property>()

    val alarms = LinkedList<VAlarm>()

    companion object {

        /**
         * Parses an iCalendar resource, applies [ICalPreprocessor] to increase compatibility
         * and extracts the VTODOs.
         *
         * @param reader where the iCalendar is taken from
         *
         * @return array of filled [Task] data objects (may have size 0)
         *
         * @throws ParserException when the iCalendar can't be parsed
         * @throws IllegalArgumentException when the iCalendar resource contains an invalid value
         * @throws IOException on I/O errors
         */
        @UsesThreadContextClassLoader
        fun tasksFromReader(reader: Reader): List<Task> {
            val ical = fromReader(reader)
            val vToDos = ical.getComponents<VToDo>(Component.VTODO)
            return vToDos.mapTo(LinkedList()) { this.fromVToDo(it) }
        }

        private fun fromVToDo(todo: VToDo): Task {
            val t = Task()

            if (todo.uid != null)
                t.uid = todo.uid.value
            else {
                Ical4Android.log.warning("Received VTODO without UID, generating new one")
                t.generateUID()
            }

            // sequence must only be null for locally created, not-yet-synchronized events
            t.sequence = 0

            for (prop in todo.properties)
                when (prop) {
                    is Sequence -> t.sequence = prop.sequenceNo
                    is Created -> t.createdAt = prop.dateTime.time
                    is LastModified -> t.lastModified = prop.dateTime.time
                    is Summary -> t.summary = prop.value
                    is Location -> t.location = prop.value
                    is Geo -> t.geoPosition = prop
                    is Description -> t.description = prop.value
                    is Color -> t.color = Css3Color.fromString(prop.value)?.argb
                    is Url -> t.url = prop.value
                    is Organizer -> t.organizer = prop
                    is Priority -> t.priority = prop.level
                    is Clazz -> t.classification = prop
                    is Status -> t.status = prop
                    is Due -> { t.due = prop }
                    is Duration -> t.duration = prop
                    is DtStart -> { t.dtStart = prop }
                    is Completed -> { t.completedAt = prop }
                    is PercentComplete -> t.percentComplete = prop.percentage
                    is RRule -> t.rRule = prop
                    is RDate -> t.rDates += prop
                    is ExDate -> t.exDates += prop
                    is Categories ->
                        for (category in prop.categories)
                            t.categories += category
                    is RelatedTo -> t.relatedTo.add(prop)
                    is Uid, is ProdId, is DtStamp -> { /* don't save these as unknown properties */ }
                    else -> t.unknownProperties += prop
                }

            t.alarms.addAll(todo.alarms)

            // There seem to be many invalid tasks out there because of some defect clients, do some validation.
            val dtStart = t.dtStart
            val due = t.due

            if (dtStart != null && due != null) {
                if (DateUtils.isDate(dtStart) && DateUtils.isDateTime(due)) {
                    Ical4Android.log.warning("DTSTART is DATE but DUE is DATE-TIME, rewriting DTSTART to DATE-TIME")
                    t.dtStart = DtStart(DateTime(dtStart.value, due.timeZone))
                } else if (DateUtils.isDateTime(dtStart) && DateUtils.isDate(due)) {
                    Ical4Android.log.warning("DTSTART is DATE-TIME but DUE is DATE, rewriting DUE to DATE-TIME")
                    t.due = Due(DateTime(due.value, dtStart.timeZone))
                }


                if (due.date <= dtStart.date) {
                    Ical4Android.log.warning("Found invalid DUE <= DTSTART; dropping DTSTART")
                    t.dtStart = null
                }
            }

            if (t.duration != null && t.dtStart == null) {
                Ical4Android.log.warning("Found DURATION without DTSTART; ignoring")
                t.duration = null
            }

            return t
        }

    }


    @UsesThreadContextClassLoader
    fun write(os: OutputStream) {
        Ical4Android.checkThreadContextClassLoader()

        val ical = Calendar()
        ical.properties += Version.VERSION_2_0
        ical.properties += prodId

        val vTodo = VToDo(true /* generates DTSTAMP */)
        ical.components += vTodo
        val props = vTodo.properties

        uid?.let { props += Uid(uid) }
        sequence?.let {
            if (it != 0)
                props += Sequence(it)
        }

        createdAt?.let { props += Created(DateTime(it)) }
        lastModified?.let { props += LastModified(DateTime(it)) }

        summary?.let { props += Summary(it) }
        location?.let { props += Location(it) }
        geoPosition?.let { props += it }
        description?.let { props += Description(it) }
        color?.let { props += Color(null, Css3Color.nearestMatch(it).name) }
        url?.let {
            try {
                props += Url(URI(it))
            } catch (e: URISyntaxException) {
                Ical4Android.log.log(Level.WARNING, "Ignoring invalid task URL: $url", e)
            }
        }
        organizer?.let { props += it }

        if (priority != Priority.UNDEFINED.level)
            props += Priority(priority)
        classification?.let { props += it }
        status?.let { props += it }

        rRule?.let { props += it }
        rDates.forEach { props += it }
        exDates.forEach { props += it }

        if (categories.isNotEmpty())
            props += Categories(TextList(categories.toTypedArray()))
        props.addAll(relatedTo)
        props.addAll(unknownProperties)

        // remember used time zones
        val usedTimeZones = HashSet<TimeZone>()
        due?.let {
            props += it
            it.timeZone?.let(usedTimeZones::add)
        }
        duration?.let(props::add)
        dtStart?.let {
            props += it
            it.timeZone?.let(usedTimeZones::add)
        }
        completedAt?.let {
            props += it
            it.timeZone?.let(usedTimeZones::add)
        }
        percentComplete?.let { props += PercentComplete(it) }

        if (alarms.isNotEmpty())
            vTodo.alarms.addAll(alarms)

        // determine earliest referenced date
        val earliest = arrayOf(
                dtStart?.date,
                due?.date,
                completedAt?.date
        ).filterNotNull().minOrNull()
        // add VTIMEZONE components
        for (tz in usedTimeZones)
            ical.components += minifyVTimeZone(tz.vTimeZone, earliest)

        softValidate(ical)
        CalendarOutputter(false).output(ical, os)
    }


    fun isAllDay(): Boolean {
        return  dtStart?.let { DateUtils.isDate(it) } ?:
                due?.let { DateUtils.isDate(it) } ?:
                true
    }

}
