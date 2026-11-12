package at.bitfire.ical4android.util

import net.fortuna.ical4j.model.ComponentList
import net.fortuna.ical4j.model.DateList
import net.fortuna.ical4j.model.DateTime
import net.fortuna.ical4j.model.PropertyList
import net.fortuna.ical4j.model.component.Daylight
import net.fortuna.ical4j.model.component.Observance
import net.fortuna.ical4j.model.component.Standard
import net.fortuna.ical4j.model.component.VTimeZone
import net.fortuna.ical4j.model.parameter.Value
import net.fortuna.ical4j.model.property.DtStart
import net.fortuna.ical4j.model.property.RDate
import net.fortuna.ical4j.model.property.RRule
import net.fortuna.ical4j.model.property.TzId
import net.fortuna.ical4j.model.property.TzOffsetFrom
import net.fortuna.ical4j.model.property.TzOffsetTo
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters
import java.time.zone.ZoneOffsetTransition
import java.time.zone.ZoneOffsetTransitionRule
import java.time.zone.ZoneRules
import kotlin.math.abs

/**
 * Builds a VTIMEZONE from the platform's time zone rules ([ZoneId.getRules]), so that iCalendar
 * times are converted with the same rules Android uses to display them. The rules ical4j bundles
 * are a fixed snapshot (Olson 2020b in ical4j 3.0.20) and drift as governments change their clocks.
 *
 * Every historic transition becomes its own observance. Recurring rules become an RRULE when one
 * expresses them exactly, otherwise explicit RDATEs up to [RDATE_LAST_YEAR].
 */
object ZoneRulesVTimeZone {

    /** Last year written out for a recurring rule that has no exact RRULE form. */
    const val RDATE_LAST_YEAR = 2100

    private val LOCAL_FORMAT = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss")
    private val FIXED_OFFSET_START = LocalDateTime.of(1970, 1, 1, 0, 0)
    private val INITIAL_START = LocalDateTime.of(1800, 1, 1, 0, 0)

    fun build(id: String): VTimeZone = build(id, ZoneId.of(id).rules)

    fun build(id: String, rules: ZoneRules): VTimeZone {
        val observances = ComponentList<Observance>()
        val transitions = rules.transitions
        val transitionRules = rules.transitionRules

        if (transitions.isEmpty() && transitionRules.isEmpty()) {
            val offset = rules.getOffset(Instant.EPOCH)
            observances += observance(false, FIXED_OFFSET_START, offset, offset)
        } else {
            val first = transitions.firstOrNull()?.offsetBefore ?: transitionRules.first().offsetBefore
            observances += observance(false, INITIAL_START, first, first)

            for (transition in transitions)
                observances += observance(rules.isDaylightSavings(transition.instant),
                    transition.dateTimeBefore, transition.offsetBefore, transition.offsetAfter)

            val last = transitions.lastOrNull()?.instant
            val firstRuleYear = last?.atOffset(ZoneOffset.UTC)?.year ?: FIXED_OFFSET_START.year
            for (rule in transitionRules) {
                var start = rule.createTransition(firstRuleYear)
                if (last != null && !start.instant.isAfter(last))
                    start = rule.createTransition(firstRuleYear + 1)

                val recur = recurrence(rule, start)
                val rDates = if (recur == null)
                    (start.dateTimeBefore.year + 1..RDATE_LAST_YEAR).map { rule.createTransition(it).dateTimeBefore }
                else
                    emptyList()
                observances += observance(rules.isDaylightSavings(start.instant),
                    start.dateTimeBefore, start.offsetBefore, start.offsetAfter, recur, rDates)
            }
        }

        val properties = PropertyList<net.fortuna.ical4j.model.Property>()
        properties += TzId(id)
        return VTimeZone(properties, observances)
    }

    /**
     * RRULE value that produces exactly the local (before) date-times of [rule], or *null*.
     * [start] is the rule's first transition; its local date can be a day off the rule's date
     * when the rule's time is given in UTC or standard time.
     */
    internal fun recurrence(rule: ZoneOffsetTransitionRule, start: ZoneOffsetTransition): String? {
        val dayOfWeek = rule.dayOfWeek ?: return null
        val dom = rule.dayOfMonthIndicator
        if (rule.isMidnightEndOfDay || dom < 1)
            return null

        val month = rule.month
        val local = start.dateTimeBefore.toLocalDate()
        val year = local.year
        val ruleDate = LocalDate.of(year, month, minOf(dom, month.length(java.time.Year.isLeap(year.toLong()))))
            .with(TemporalAdjusters.nextOrSame(dayOfWeek))
        val shift = ChronoUnit.DAYS.between(ruleDate, local)
        if (abs(shift) > 1 || local.month != month)
            return null

        val byDay = dayOfWeek.plus(shift).name.substring(0, 2)
        val prefix = "FREQ=YEARLY;BYMONTH=${month.value}"
        if (shift == 0L && dom <= 22 && (dom - 1) % 7 == 0)
            return "$prefix;BYDAY=${(dom - 1) / 7 + 1}$byDay"
        if (shift == 0L && month.minLength() == month.maxLength() && dom + 6 == month.maxLength())
            return "$prefix;BYDAY=-1$byDay"

        val from = dom + shift.toInt()
        val to = from + 6
        if (from < 1 || to > month.minLength())
            return null
        return "$prefix;BYDAY=$byDay;BYMONTHDAY=${(from..to).joinToString(",")}"
    }

    private fun observance(
        daylight: Boolean,
        start: LocalDateTime,
        from: ZoneOffset,
        to: ZoneOffset,
        recur: String? = null,
        rDates: List<LocalDateTime> = emptyList()
    ): Observance {
        val properties = PropertyList<net.fortuna.ical4j.model.Property>()
        properties += DtStart(DateTime(LOCAL_FORMAT.format(start)))
        properties += TzOffsetFrom(from)
        properties += TzOffsetTo(to)
        if (recur != null)
            properties += RRule(recur)
        if (rDates.isNotEmpty()) {
            val dates = DateList(Value.DATE_TIME)
            for (date in rDates)
                dates += DateTime(LOCAL_FORMAT.format(date))
            properties += RDate(dates)
        }
        return if (daylight) Daylight(properties) else Standard(properties)
    }

}
