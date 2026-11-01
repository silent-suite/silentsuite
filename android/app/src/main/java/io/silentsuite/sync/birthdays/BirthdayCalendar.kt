package io.silentsuite.sync.birthdays

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.Locale

/**
 * Shared-v1 Birthdays calendar contract (`contracts/birthday-calendar/v1-vectors.json`): the
 * marker in a calendar's collection content, a contact's birthday, the generated event UID, and
 * the generated event's iCalendar text and comparable fields. Pure functions with no SDK, provider
 * or storage access; the same rules as the web core and Bridge (`bridge/.../birthdays.py`).
 */
object BirthdayCalendar {
    enum class MarkerState { ACTIVE, RETIRED }

    data class Birthday(val name: String, val month: Int, val day: Int)

    data class BirthdayEvent(val uid: String, val name: String, val month: Int, val day: Int)

    data class EventFields(val uid: String, val dtstart: String, val dtend: String, val rrule: String, val summary: String)

    const val MARKER_TYPE = "silentsuite.birthdays"
    const val EVENT_UID_PREFIX = "ss-bday1-"
    private const val ANCHOR_YEAR = 1972 // a leap year, so February 29 exists; never shown as a birth year
    private const val LAST_DAY_OF_FEBRUARY = "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1"
    private const val CAKE = "🎂"
    private const val MAX_LINE_OCTETS = 75

    private val ANCHOR_DAYS = intArrayOf(31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    private val COMMON_DAYS = intArrayOf(31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    private val YEARLESS = Regex("--([0-9]{2})-?([0-9]{2})")
    private val DATED = Regex("([0-9]{4})-?([0-9]{2})-?([0-9]{2})(?:T[0-9:.,+\\-Z]*)?")
    private val VCARD_FOLD = Regex("\r\n[ \t]|\n[ \t]")
    private val VCARD_LINE_BREAK = Regex("\r\n|[\n\r\u000B\u000C\u001C\u001D\u001E\u0085  ]")
    private val ICS_FOLD = Regex("\r?\n[ \t]")
    private val ICS_LINE_BREAK = Regex("\r?\n")
    private val NEWLINES = Regex("\r\n|\r|\n")

    // ---- marker ----

    /**
     * The marker state of a calendar's collection content: an object whose `type` is
     * [MARKER_TYPE], whose `v` is the JSON integer 1 and whose `state` is "active" or "retired".
     * Anything else, including content that is not UTF-8 or not JSON, is not a Birthdays calendar.
     */
    fun markerState(content: ByteArray): MarkerState? {
        val text = strictUtf8(content) ?: return null
        if (text.isEmpty()) return null
        val parsed = try {
            StrictJson(text).document()
        } catch (e: StrictJson.Invalid) {
            return null
        }
        val marker = parsed as? Map<*, *> ?: return null
        val version = marker["v"]
        if (marker["type"] != MARKER_TYPE || version !is Long || version != 1L) return null
        return when (marker["state"]) {
            "active" -> MarkerState.ACTIVE
            "retired" -> MarkerState.RETIRED
            else -> null
        }
    }

    // ---- contact birthdays ----

    /**
     * The birthday event a vCard gives: the first FN (or "given family" from N when FN is empty)
     * and the first BDAY's month and day. Null without a name, or when the birthday is text, empty,
     * partial or a date that does not exist (a year named by X-APPLE-OMIT-YEAR is not a birth year).
     */
    fun birthdayOf(vcard: String): Birthday? {
        var formatted: String? = null
        var structured: String? = null
        var bday: VCardProperty? = null
        for (property in vcardProperties(vcard)) {
            when {
                property.name == "FN" && formatted == null -> formatted = vcardUnescape(property.value).trim()
                property.name == "N" && structured == null -> structured = property.value
                property.name == "BDAY" && bday == null -> bday = property
            }
        }
        var display = formatted ?: ""
        if (display.isEmpty() && structured != null) {
            val components = splitUnescaped(structured, ';').map { vcardUnescape(it).trim() }
            val family = components.getOrElse(0) { "" }
            val given = components.getOrElse(1) { "" }
            display = listOf(given, family).filter { it.isNotEmpty() }.joinToString(" ")
        }
        if (display.isEmpty() || bday == null) return null
        val monthDay = normalizeBirthday(bday.value, bday.params) ?: return null
        return Birthday(display, monthDay.first, monthDay.second)
    }

    private class VCardProperty(val name: String, val params: Map<String, String>, val value: String)

    private fun vcardProperties(vcard: String): List<VCardProperty> {
        val properties = ArrayList<VCardProperty>()
        for (line in vcard.replace(VCARD_FOLD, "").split(VCARD_LINE_BREAK)) {
            val colon = valueColon(line)
            if (colon < 0) continue
            val parts = line.substring(0, colon).split(';')
            val name = parts[0].split('.').last().trim().uppercase(Locale.ROOT)
            val params = LinkedHashMap<String, String>()
            for (part in parts.drop(1)) {
                val key = part.substringBefore('=')
                val paramValue = if ('=' in part) part.substringAfter('=') else ""
                params[key.trim().uppercase(Locale.ROOT)] = paramValue.trim().trim('"')
            }
            properties += VCardProperty(name, params, line.substring(colon + 1))
        }
        return properties
    }

    private fun normalizeBirthday(value: String, params: Map<String, String>): Pair<Int, Int>? {
        if ((params["VALUE"] ?: "").split(',').any { it.trim().lowercase(Locale.ROOT) == "text" }) return null
        val text = value.trim()
        if (text.isEmpty()) return null
        YEARLESS.matchEntire(text)?.let { return existingMonthDay(null, it.groupValues[1].toInt(), it.groupValues[2].toInt()) }
        DATED.matchEntire(text)?.let {
            val year = it.groupValues[1]
            // A year named by X-APPLE-OMIT-YEAR is not a birth year: validate as year-less.
            val effectiveYear = if (params["X-APPLE-OMIT-YEAR"] == year) null else year.toInt()
            return existingMonthDay(effectiveYear, it.groupValues[2].toInt(), it.groupValues[3].toInt())
        }
        return null
    }

    private fun existingMonthDay(year: Int?, month: Int, day: Int): Pair<Int, Int>? {
        if (month < 1 || month > 12 || day < 1) return null
        val days = if (month == 2) (if (year == null || isLeap(year)) 29 else 28) else COMMON_DAYS[month - 1]
        return if (day <= days) month to day else null
    }

    private fun isLeap(year: Int) = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0

    /** vCard unescaping: a backslash keeps the next character, and `\n`/`\N` is a line break. */
    private fun vcardUnescape(value: String): String {
        val out = StringBuilder(value.length)
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c == '\\' && i + 1 < value.length) {
                val next = value[i + 1]
                out.append(if (next == 'n' || next == 'N') '\n' else next)
                i += 2
            } else {
                out.append(c)
                i++
            }
        }
        return out.toString()
    }

    /** Splits at every [separator] not directly preceded by a backslash. */
    private fun splitUnescaped(value: String, separator: Char): List<String> {
        val parts = ArrayList<String>()
        var start = 0
        for (i in value.indices) {
            if (value[i] == separator && (i == 0 || value[i - 1] != '\\')) {
                parts += value.substring(start, i)
                start = i + 1
            }
        }
        parts += value.substring(start)
        return parts
    }

    // ---- identity ----

    /** `ss-bday1-` + the first 32 lowercase hex characters of SHA-256(UTF-8(bookUid + "/" + itemUid)). */
    fun eventUid(bookUid: String, itemUid: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("$bookUid/$itemUid".toByteArray(Charsets.UTF_8))
        val hex = StringBuilder(64)
        for (b in digest) {
            val v = b.toInt() and 0xff
            hex.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
        }
        return EVENT_UID_PREFIX + hex.substring(0, 32)
    }

    private const val HEX = "0123456789abcdef"

    // ---- events ----

    /** The comparable fields of a generated event: all-day on the anchor date with an exclusive end, yearly. */
    fun fieldsOf(event: BirthdayEvent): EventFields {
        require(event.month in 1..12 && event.day >= 1 && event.day <= ANCHOR_DAYS[event.month - 1]) { "not a calendar day" }
        val (endYear, endMonth, endDay) = when {
            event.day < ANCHOR_DAYS[event.month - 1] -> Triple(ANCHOR_YEAR, event.month, event.day + 1)
            event.month < 12 -> Triple(ANCHOR_YEAR, event.month + 1, 1)
            else -> Triple(ANCHOR_YEAR + 1, 1, 1)
        }
        val leapDay = event.month == 2 && event.day == 29
        return EventFields(
            uid = event.uid,
            dtstart = "DATE:" + date(ANCHOR_YEAR, event.month, event.day),
            dtend = "DATE:" + date(endYear, endMonth, endDay),
            rrule = if (leapDay) LAST_DAY_OF_FEBRUARY else "FREQ=YEARLY",
            summary = "$CAKE ${event.name}",
        )
    }

    private fun date(year: Int, month: Int, day: Int) = String.format(Locale.ROOT, "%04d%02d%02d", year, month, day)

    /** The iCalendar text of a generated event: CRLF line ends, escaped text, folded at 75 octets between characters. */
    fun eventIcs(event: BirthdayEvent): String {
        val fields = fieldsOf(event)
        val lines = listOf(
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//SilentSuite//Birthdays v1//EN",
            "BEGIN:VEVENT",
            "UID:" + fields.uid,
            "DTSTAMP:${ANCHOR_YEAR}0101T000000Z",
            "DTSTART;VALUE=DATE:" + fields.dtstart.removePrefix("DATE:"),
            "DTEND;VALUE=DATE:" + fields.dtend.removePrefix("DATE:"),
            "RRULE:" + fields.rrule,
            "SUMMARY:" + escapeText(fields.summary),
            "TRANSP:TRANSPARENT",
            "END:VEVENT",
            "END:VCALENDAR",
        )
        return lines.joinToString("\r\n") { fold(it) } + "\r\n"
    }

    private fun escapeText(value: String): String =
        value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace(NEWLINES, "\\\\n")

    private fun fold(line: String): String {
        val out = StringBuilder()
        var octets = 0
        var i = 0
        while (i < line.length) {
            val codePoint = line.codePointAt(i)
            val chars = Character.charCount(codePoint)
            val size = when {
                codePoint < 0x80 -> 1
                codePoint < 0x800 -> 2
                codePoint < 0x10000 -> 3
                else -> 4
            }
            if (octets + size > MAX_LINE_OCTETS) {
                out.append("\r\n ")
                octets = 1
            }
            out.append(line, i, i + chars)
            octets += size
            i += chars
        }
        return out.toString()
    }

    /**
     * The comparable fields of the first VEVENT of [ics] (other clients' folding, line ends, case
     * and extra properties included; nested components are skipped), or null without a VEVENT UID.
     */
    fun eventFields(ics: String): EventFields? {
        val found = HashMap<String, String>()
        var inEvent = false
        var nested = 0
        for (line in ics.replace(ICS_FOLD, "").split(ICS_LINE_BREAK)) {
            val colon = valueColon(line)
            if (colon < 0) continue
            val head = line.substring(0, colon).split(';')
            val name = head[0].uppercase(Locale.ROOT)
            val params = head.drop(1)
            val raw = line.substring(colon + 1)
            val value = raw.trim()
            if (!inEvent) {
                if (name == "BEGIN" && value.uppercase(Locale.ROOT) == "VEVENT") inEvent = true
                continue
            }
            if (name == "BEGIN") { nested++; continue }
            if (name == "END") {
                if (nested == 0) break
                nested--
                continue
            }
            if (nested > 0 || name !in EVENT_PROPERTIES || name in found) continue
            val isDate = params.any { it.uppercase(Locale.ROOT) == "VALUE=DATE" }
            found[name] = when {
                name == "SUMMARY" -> unescapeText(raw)
                (name == "DTSTART" || name == "DTEND") && isDate -> "DATE:$value"
                else -> value
            }
        }
        val uid = found["UID"]
        if (uid.isNullOrEmpty()) return null
        return EventFields(uid, found["DTSTART"] ?: "", found["DTEND"] ?: "", found["RRULE"] ?: "", found["SUMMARY"] ?: "")
    }

    private val EVENT_PROPERTIES = setOf("UID", "DTSTART", "DTEND", "RRULE", "SUMMARY")

    /** iCalendar TEXT unescaping: only `\\`, `\;`, `\,` and `\n`/`\N` are escapes. */
    private fun unescapeText(value: String): String {
        val out = StringBuilder(value.length)
        var i = 0
        while (i < value.length) {
            val c = value[i]
            val next = if (c == '\\' && i + 1 < value.length) value[i + 1] else null
            if (next != null && next in "\\;,nN") {
                out.append(if (next == 'n' || next == 'N') '\n' else next)
                i += 2
            } else {
                out.append(c)
                i++
            }
        }
        return out.toString()
    }

    /** The first ':' outside a quoted parameter value, or -1. */
    private fun valueColon(line: String): Int {
        var quoted = false
        for ((index, c) in line.withIndex()) {
            if (c == '"') quoted = !quoted else if (c == ':' && !quoted) return index
        }
        return -1
    }

    private fun strictUtf8(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (e: CharacterCodingException) {
        null
    }

    /**
     * Strict RFC 8259 JSON (no comments, no trailing commas, no leading zeros, no raw control
     * characters in strings), bounded in depth. Integers without fraction or exponent are Long;
     * other numbers are Double; a later duplicate key wins.
     */
    private class StrictJson(private val s: String) {
        class Invalid : Exception()

        private var i = 0

        fun document(): Any? {
            val value = value(0)
            ws()
            if (i != s.length) throw Invalid()
            return value
        }

        private fun ws() {
            while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
        }

        private fun peek(): Char = if (i < s.length) s[i] else throw Invalid()

        private fun value(depth: Int): Any? {
            if (depth > MAX_DEPTH) throw Invalid()
            ws()
            return when (peek()) {
                '{' -> obj(depth)
                '[' -> arr(depth)
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> num()
            }
        }

        private fun literal(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) throw Invalid()
            i += word.length
            return v
        }

        private fun digits(): Int {
            val start = i
            while (i < s.length && s[i] in '0'..'9') i++
            return i - start
        }

        private fun num(): Any {
            val start = i
            if (peek() == '-') i++
            if (peek() == '0') i++ else if (digits() == 0) throw Invalid()
            var integer = true
            if (i < s.length && s[i] == '.') {
                i++
                integer = false
                if (digits() == 0) throw Invalid()
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                i++
                integer = false
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                if (digits() == 0) throw Invalid()
            }
            val token = s.substring(start, i)
            return if (integer) token.toLongOrNull() ?: token.toDouble() else token.toDouble()
        }

        private fun obj(depth: Int): Map<String, Any?> {
            i++
            val m = LinkedHashMap<String, Any?>()
            ws()
            if (peek() == '}') { i++; return m }
            while (true) {
                ws()
                if (peek() != '"') throw Invalid()
                val key = str()
                ws()
                if (peek() != ':') throw Invalid()
                i++
                m[key] = value(depth + 1)
                ws()
                when (peek()) {
                    ',' -> i++
                    '}' -> { i++; return m }
                    else -> throw Invalid()
                }
            }
        }

        private fun arr(depth: Int): List<Any?> {
            i++
            val l = ArrayList<Any?>()
            ws()
            if (peek() == ']') { i++; return l }
            while (true) {
                l += value(depth + 1)
                ws()
                when (peek()) {
                    ',' -> i++
                    ']' -> { i++; return l }
                    else -> throw Invalid()
                }
            }
        }

        private fun str(): String {
            i++
            val b = StringBuilder()
            while (true) {
                val c = peek()
                i++
                when {
                    c == '"' -> return b.toString()
                    c < ' ' -> throw Invalid()
                    c != '\\' -> b.append(c)
                    else -> {
                        val e = peek()
                        i++
                        when (e) {
                            '"' -> b.append('"')
                            '\\' -> b.append('\\')
                            '/' -> b.append('/')
                            'b' -> b.append('\b')
                            'f' -> b.append('\u000C')
                            'n' -> b.append('\n')
                            'r' -> b.append('\r')
                            't' -> b.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) throw Invalid()
                                val hex = s.substring(i, i + 4)
                                // Exactly four ASCII hex digits: toIntOrNull alone also accepts a sign.
                                if (!hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) throw Invalid()
                                val code = hex.toInt(16)
                                b.append(code.toChar())
                                i += 4
                            }
                            else -> throw Invalid()
                        }
                    }
                }
            }
        }

        private companion object {
            const val MAX_DEPTH = 64
        }
    }
}
