package io.silentsuite.sync.birthdays

/**
 * Shared-v1 Birthdays calendar contract (`contracts/birthday-calendar/v1-vectors.json`).
 *
 * NEUTRAL SCAFFOLD (S4 tests-only checkpoint): only the typed shapes the tests compile against.
 * Every function returns an empty, null or "not a Birthdays calendar" answer. Nothing here parses,
 * generates, persists or talks to the SDK or a provider yet; behaviour follows only after the
 * hosted test RED is observed.
 */
object BirthdayCalendar {
    enum class MarkerState { ACTIVE, RETIRED }

    data class Birthday(val name: String, val month: Int, val day: Int)

    data class BirthdayEvent(val uid: String, val name: String, val month: Int, val day: Int)

    data class EventFields(val uid: String, val dtstart: String, val dtend: String, val rrule: String, val summary: String)

    /** The marker state of a calendar's collection content, or null when it is not a Birthdays calendar. */
    @Suppress("UNUSED_PARAMETER")
    fun markerState(content: ByteArray): MarkerState? = null

    /** The birthday a vCard gives, or null when the contact gets no birthday event. */
    @Suppress("UNUSED_PARAMETER")
    fun birthdayOf(vcard: String): Birthday? = null

    /** The generated event UID for an address book item. */
    @Suppress("UNUSED_PARAMETER")
    fun eventUid(bookUid: String, itemUid: String): String = ""

    /** The iCalendar text of a generated event. */
    @Suppress("UNUSED_PARAMETER")
    fun eventIcs(event: BirthdayEvent): String = ""

    /** The contract fields of a generated event's iCalendar text, or null when it does not parse. */
    @Suppress("UNUSED_PARAMETER")
    fun eventFields(ics: String): EventFields? = null
}
