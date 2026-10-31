package io.silentsuite.sync.birthdays

import io.silentsuite.sync.birthdays.BirthdayCalendar.Birthday
import io.silentsuite.sync.birthdays.BirthdayCalendar.BirthdayEvent
import io.silentsuite.sync.birthdays.BirthdayCalendar.EventFields
import io.silentsuite.sync.birthdays.BirthdayCalendar.MarkerState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The shared-v1 vectors (`contracts/birthday-calendar/v1-vectors.json`, read in place as
 * `LoginLifecycleContractTest` reads the workflow) against the Android contract functions.
 * Expectations come only from the vectors. The test-side iCalendar reader below is independent of
 * production and is itself checked against every vector text ([theTestSideReaderReadsEveryVectorTextToItsFields]).
 *
 * Against the neutral scaffold, the FEATURE tests fail on their first assertion; the
 * "...IsNot..."/"...GetNo..." tests pass, because they guard against over-recognition.
 */
class BirthdayCalendarSharedVectorsTest {
    @Suppress("UNCHECKED_CAST")
    private val vectors: Map<String, Any?> by lazy {
        TestJson.parse(File("../../contracts/birthday-calendar/v1-vectors.json").readText(Charsets.UTF_8)) as Map<String, Any?>
    }

    @Suppress("UNCHECKED_CAST")
    private fun section(name: String) = vectors.getValue(name) as List<Map<String, Any?>>

    @Test fun vectorFileIsTheV1Contract() {
        assertEquals("silentsuite.birthdays", vectors["contract"])
        assertEquals(1L, vectors["version"])
    }

    /** FEATURE: fails against the scaffold. */
    @Test fun activeAndRetiredMarkersAreRecognised() {
        val marked = section("marker").filter { it["state"] != null }
        assertTrue(marked.isNotEmpty())
        for (vector in marked) {
            val expected = MarkerState.valueOf((vector["state"] as String).uppercase())
            val content = vector["content"] as String
            assertEquals("FEATURE marker <$content>", expected, BirthdayCalendar.markerState(content.toByteArray(Charsets.UTF_8)))
        }
    }

    /** Guard against over-recognition: passes against the scaffold. */
    @Test fun contentThatIsNotAnActiveOrRetiredMarkerIsNotABirthdaysCalendar() {
        val unmarked = section("marker").filter { it["state"] == null }
        assertTrue(unmarked.isNotEmpty())
        for (vector in unmarked) {
            val content = vector["content"] as String
            assertNull("marker <$content>", BirthdayCalendar.markerState(content.toByteArray(Charsets.UTF_8)))
        }
    }

    /** FEATURE: full, compact, timed, year-less, Apple omit-year, leap-day, N-fallback, multibyte and escaped names. */
    @Test @Suppress("UNCHECKED_CAST")
    fun birthdaysFromVCardsMatchTheSharedVectors() {
        val dated = section("birthdays").filter { it["expected"] != null }
        assertTrue(dated.isNotEmpty())
        for (vector in dated) {
            val expected = vector["expected"] as Map<String, Any?>
            assertEquals("FEATURE birthday: ${vector["case"]}",
                Birthday(expected["name"] as String, (expected["month"] as Long).toInt(), (expected["day"] as Long).toInt()),
                BirthdayCalendar.birthdayOf(vector["vcard"] as String))
        }
    }

    /** Guard: non-leap Feb 29, impossible dates, text, empty, partial, missing birthday and no name give no event. Passes against the scaffold. */
    @Test fun contactsWithoutAUsableBirthdayGetNoEvent() {
        val undated = section("birthdays").filter { it["expected"] == null }
        assertTrue(undated.isNotEmpty())
        for (vector in undated) assertNull("birthday: ${vector["case"]}", BirthdayCalendar.birthdayOf(vector["vcard"] as String))
    }

    /** FEATURE: fails against the scaffold. */
    @Test fun eventUidsMatchTheSharedIdentityVectors() {
        for (vector in section("identity")) {
            assertEquals("FEATURE identity ${vector["bookUid"]}/${vector["itemUid"]}", vector["uid"],
                BirthdayCalendar.eventUid(vector["bookUid"] as String, vector["itemUid"] as String))
        }
    }

    /** FEATURE: the production reader parses every vector text, other clients' foldings included, to its fields. */
    @Test @Suppress("UNCHECKED_CAST")
    fun everyVectorTextParsesToItsFields() {
        for (vector in section("events")) {
            val fields = vector["fields"] as Map<String, Any?>
            for (ics in vector["ics"] as List<String>) {
                assertEquals("FEATURE parse: ${vector["case"]}", fieldsOf(fields), BirthdayCalendar.eventFields(ics))
            }
        }
    }

    /** FEATURE: every generated event parses to the vector fields, ends lines with CRLF and keeps each line at 75 octets or less. */
    @Test @Suppress("UNCHECKED_CAST")
    fun generatedEventsParseToTheVectorFieldsWithCrlfLinesOfAtMost75Octets() {
        for (vector in section("events")) {
            val event = vector["event"] as Map<String, Any?>
            val ics = BirthdayCalendar.eventIcs(BirthdayEvent(event["uid"] as String, event["name"] as String,
                (event["month"] as Long).toInt(), (event["day"] as Long).toInt()))
            assertEquals("FEATURE generated fields: ${vector["case"]}", vector["fields"], readFields(ics))
            assertTrue("CRLF line ends: ${vector["case"]}", ics.endsWith("\r\n"))
            assertFalse("no bare LF: ${vector["case"]}", ics.replace("\r\n", "").contains('\n'))
            for (line in ics.removeSuffix("\r\n").split("\r\n")) {
                assertTrue("at most 75 octets: <$line>", line.toByteArray(Charsets.UTF_8).size <= 75)
            }
        }
    }

    /** CONTROL: the independent test-side reader agrees with every vector, so the generated-event test is trustworthy. */
    @Test @Suppress("UNCHECKED_CAST")
    fun theTestSideReaderReadsEveryVectorTextToItsFields() {
        for (vector in section("events")) {
            for (ics in vector["ics"] as List<String>) assertEquals("reader: ${vector["case"]}", vector["fields"], readFields(ics))
        }
    }

    private fun fieldsOf(fields: Map<String, Any?>) = EventFields(fields["uid"] as String, fields["dtstart"] as String,
        fields["dtend"] as String, fields["rrule"] as String, fields["summary"] as String)

    /** Unfolds, then reads UID, DTSTART/DTEND as "<VALUE>:<value>", RRULE and the unescaped SUMMARY of the VEVENT. */
    private fun readFields(ics: String): Map<String, Any?> {
        val unfolded = ics.replace("\r\n", "\n").replace(Regex("\n[ \t]"), "")
        val out = LinkedHashMap<String, Any?>()
        var depth = 0
        for (line in unfolded.split("\n")) {
            if (line.isEmpty()) continue
            val colon = valueColon(line)
            if (colon < 0) continue
            val head = line.substring(0, colon)
            val value = line.substring(colon + 1)
            val parts = head.split(';')
            val name = parts[0].uppercase()
            val params = parts.drop(1).associate { it.substringBefore('=').uppercase() to it.substringAfter('=') }
            if (name == "BEGIN") { if (value.equals("VEVENT", ignoreCase = true) || depth > 0) depth++; continue }
            if (name == "END") { if (depth > 0) depth--; continue }
            if (depth != 1) continue
            when (name) {
                "UID" -> out["uid"] = value
                "DTSTART", "DTEND" -> out[name.lowercase()] = "${(params["VALUE"] ?: "DATE-TIME").uppercase()}:$value"
                "RRULE" -> out["rrule"] = value
                "SUMMARY" -> out["summary"] = unescape(value)
            }
        }
        return out
    }

    private fun valueColon(line: String): Int {
        var quoted = false
        for ((index, c) in line.withIndex()) {
            if (c == '"') quoted = !quoted else if (c == ':' && !quoted) return index
        }
        return -1
    }

    private fun unescape(value: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < value.length) {
            val c = value[i++]
            if (c != '\\' || i >= value.length) { out.append(c); continue }
            when (val e = value[i++]) {
                'n', 'N' -> out.append('\n')
                else -> out.append(e)
            }
        }
        return out.toString()
    }
}

/** A JSON reader for the vector file: objects keep their order, integers are Long. */
private object TestJson {
    fun parse(text: String): Any? {
        val reader = Reader(text)
        val value = reader.value()
        reader.ws()
        check(reader.i == text.length) { "trailing text after the JSON value" }
        return value
    }

    private class Reader(val s: String) {
        var i = 0

        fun ws() { while (i < s.length && s[i] in " \t\r\n") i++ }

        fun value(): Any? {
            ws()
            return when (s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> num()
            }
        }

        private fun literal(word: String, v: Any?): Any? {
            check(s.startsWith(word, i)) { "bad literal at $i" }
            i += word.length
            return v
        }

        private fun num(): Any {
            val start = i
            while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
            val t = s.substring(start, i)
            return t.toLongOrNull() ?: t.toDouble()
        }

        private fun obj(): Map<String, Any?> {
            i++
            val m = LinkedHashMap<String, Any?>()
            ws()
            if (s[i] == '}') { i++; return m }
            while (true) {
                ws()
                val key = str()
                ws()
                check(s[i++] == ':') { "expected ':' at ${i - 1}" }
                m[key] = value()
                ws()
                val sep = s[i++]
                if (sep == '}') return m
                check(sep == ',') { "expected ',' at ${i - 1}" }
            }
        }

        private fun arr(): List<Any?> {
            i++
            val l = ArrayList<Any?>()
            ws()
            if (s[i] == ']') { i++; return l }
            while (true) {
                l += value()
                ws()
                val sep = s[i++]
                if (sep == ']') return l
                check(sep == ',') { "expected ',' at ${i - 1}" }
            }
        }

        fun str(): String {
            check(s[i++] == '"') { "expected a string at ${i - 1}" }
            val b = StringBuilder()
            while (true) {
                val c = s[i++]
                if (c == '"') return b.toString()
                if (c != '\\') { b.append(c); continue }
                when (val e = s[i++]) {
                    '"' -> b.append('"')
                    '\\' -> b.append('\\')
                    '/' -> b.append('/')
                    'b' -> b.append('\b')
                    'f' -> b.append('\u000C')
                    'n' -> b.append('\n')
                    'r' -> b.append('\r')
                    't' -> b.append('\t')
                    'u' -> { b.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
                    else -> error("bad escape \\$e")
                }
            }
        }
    }
}
