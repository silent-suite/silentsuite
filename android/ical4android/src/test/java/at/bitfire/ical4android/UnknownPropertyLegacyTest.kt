package at.bitfire.ical4android

import net.fortuna.ical4j.data.DefaultParameterFactorySupplier
import net.fortuna.ical4j.data.DefaultPropertyFactorySupplier
import net.fortuna.ical4j.model.Date
import net.fortuna.ical4j.model.DateTime
import net.fortuna.ical4j.model.Parameter
import net.fortuna.ical4j.model.ParameterBuilder
import net.fortuna.ical4j.model.Property
import net.fortuna.ical4j.model.PropertyBuilder
import net.fortuna.ical4j.model.property.Clazz
import net.fortuna.ical4j.model.property.Due
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.InvalidClassException
import java.io.ObjectInputStream
import java.io.ObjectOutputStream
import java.io.ObjectStreamClass
import java.io.StringReader

/**
 * Test-only inventory of the Java serialization descriptors of legitimate unknown-property graphs
 * (D2 compatibility floor). It round-trips controlled fixtures through an UNRESTRICTED stream and prints
 * the descriptor names per family and variant, with runtime and dependency provenance, to system-out.
 *
 * This is evidence collection only: it is neither the production legacy reader nor an allowlist, and
 * the recorder's own proxy rejection proves nothing about production rejection.
 */
class UnknownPropertyLegacyTest {

    private class RecordingObjectInputStream(input: InputStream) : ObjectInputStream(input) {
        val descriptors = sortedSetOf<String>()

        override fun resolveClass(desc: ObjectStreamClass): Class<*> {
            descriptors += desc.name
            return super.resolveClass(desc)
        }

        override fun resolveProxyClass(interfaces: Array<out String>): Class<*> =
                throw InvalidClassException("test recorder does not admit proxy classes: ${interfaces.joinToString()}")
    }

    private class Fixture(val family: String, val variant: String, val make: () -> Property, val check: ((Property, Property) -> Unit)? = null)

    private val propertyFactories = DefaultPropertyFactorySupplier().get()
    private val parameterFactories = DefaultParameterFactorySupplier().get()

    /** Properties that Event.kt (:156-179) maps to fields or drops instead of routing to unknownProperties. */
    private val handledByEvent = setOf(
            "UID", "RECURRENCE-ID", "SEQUENCE", "SUMMARY", "LOCATION", "DESCRIPTION", "CATEGORIES", "COLOR",
            "DTSTART", "DTEND", "DURATION", "RRULE", "RDATE", "EXRULE", "EXDATE", "CLASS", "STATUS", "TRANSP",
            "ORGANIZER", "ATTENDEE", "LAST-MODIFIED", "PRODID", "DTSTAMP"
    )

    private fun param(name: String, value: String): Parameter =
            ParameterBuilder().factories(parameterFactories).name(name).value(value).build()

    private fun prop(name: String, value: String, vararg params: Pair<String, String>): Property {
        val builder = PropertyBuilder().factories(propertyFactories).name(name).value(value)
        for ((paramName, paramValue) in params)
            builder.parameter(param(paramName, paramValue))
        return builder.build()
    }

    /** Representative legitimate values per canonical property name; a routed name without an entry fails explicitly. */
    private val routedVariants: Map<String, List<Pair<String, () -> Property>>> = mapOf(
            "ACKNOWLEDGED" to listOf("utc" to { prop("ACKNOWLEDGED", "20230105T120000Z") }),
            "ACTION" to listOf("text" to { prop("ACTION", "DISPLAY") }),
            "ATTACH" to listOf(
                    "uri" to { prop("ATTACH", "https://example.com/a.pdf", "FMTTYPE" to "application/pdf") },
                    "binary" to { prop("ATTACH", "SGVsbG8=", "ENCODING" to "BASE64", "VALUE" to "BINARY") }
            ),
            "BUSYTYPE" to listOf("text" to { prop("BUSYTYPE", "BUSY") }),
            "CALSCALE" to listOf("text" to { prop("CALSCALE", "GREGORIAN") }),
            "COMMENT" to listOf("text-altrep-language" to { prop("COMMENT", "comment", "ALTREP" to "https://example.com/c", "LANGUAGE" to "en") }),
            "COMPLETED" to listOf("utc" to { prop("COMPLETED", "20230105T120000Z") }),
            "CONTACT" to listOf("text" to { prop("CONTACT", "Jane Doe") }),
            "COUNTRY" to listOf("text" to { prop("COUNTRY", "AT") }),
            "CREATED" to listOf("utc" to { prop("CREATED", "20230105T120000Z") }),
            "DUE" to listOf("utc" to { prop("DUE", "20230105T120000Z") }),
            "EXTENDED-ADDRESS" to listOf("text" to { prop("EXTENDED-ADDRESS", "Apartment 1") }),
            "FREEBUSY" to listOf("period-list" to { prop("FREEBUSY", "20230105T120000Z/20230105T130000Z") }),
            "GEO" to listOf("decimal" to { prop("GEO", "48.2082;16.3738") }),
            "LOCALITY" to listOf("text" to { prop("LOCALITY", "Vienna") }),
            "LOCATION-TYPE" to listOf("list" to { prop("LOCATION-TYPE", "HOTEL,RESTAURANT") }),
            "METHOD" to listOf("text" to { prop("METHOD", "PUBLISH") }),
            "NAME" to listOf("text" to { prop("NAME", "Venue") }),
            "PERCENT-COMPLETE" to listOf("integer" to { prop("PERCENT-COMPLETE", "50") }),
            "POSTAL-CODE" to listOf("text" to { prop("POSTAL-CODE", "1010") }),
            "POSTALCODE" to listOf("text" to { prop("POSTALCODE", "1010") }),
            "PRIORITY" to listOf("integer" to { prop("PRIORITY", "1") }),
            "REGION" to listOf("text" to { prop("REGION", "Vienna") }),
            "RELATED-TO" to listOf("text-reltype" to { prop("RELATED-TO", "parent@example.com", "RELTYPE" to "PARENT") }),
            "REPEAT" to listOf("integer" to { prop("REPEAT", "2") }),
            "REQUEST-STATUS" to listOf("text" to { prop("REQUEST-STATUS", "2.0;Success") }),
            "RESOURCES" to listOf("text-list" to { prop("RESOURCES", "PROJECTOR,EASEL") }),
            "STREET-ADDRESS" to listOf("text" to { prop("STREET-ADDRESS", "Main Street 1") }),
            "TEL" to listOf("text" to { prop("TEL", "+43 1 234567") }),
            "TRIGGER" to listOf(
                    "duration" to { prop("TRIGGER", "-PT15M") },
                    "date-time" to { prop("TRIGGER", "20230105T120000Z", "VALUE" to "DATE-TIME") }
            ),
            "TZID" to listOf("text" to { prop("TZID", "Europe/Berlin") }),
            "TZNAME" to listOf("text" to { prop("TZNAME", "CET") }),
            "TZOFFSETFROM" to listOf("utc-offset" to { prop("TZOFFSETFROM", "+0100") }),
            "TZOFFSETTO" to listOf("utc-offset" to { prop("TZOFFSETTO", "+0200") }),
            "TZURL" to listOf("uri" to { prop("TZURL", "https://example.com/tz/Europe-Berlin.ics") }),
            "URL" to listOf("uri" to { prop("URL", "https://example.com/event") }),
            "VERSION" to listOf("text" to { prop("VERSION", "2.0") }),
            "CONFERENCE" to listOf("uri-feature-label" to { prop("CONFERENCE", "https://example.com/meet", "VALUE" to "URI", "FEATURE" to "AUDIO", "LABEL" to "Room") }),
            "IMAGE" to listOf(
                    "uri" to { prop("IMAGE", "https://example.com/i.png", "VALUE" to "URI") },
                    "binary" to { prop("IMAGE", "SGVsbG8=", "ENCODING" to "BASE64", "VALUE" to "BINARY") }
            ),
            "REFRESH-INTERVAL" to listOf("duration" to { prop("REFRESH-INTERVAL", "P1W", "VALUE" to "DURATION") }),
            "SOURCE" to listOf("uri" to { prop("SOURCE", "https://example.com/calendar.ics") }),
            "X-SILENTSUITE-TEST" to listOf("x-property-x-parameter" to { prop("X-SILENTSUITE-TEST", "value", "X-PARAM" to "1", "LANGUAGE" to "en") })
    )

    /** Representative legitimate values per default parameter class (enclosing class of its Factory). */
    private val parameterValues: Map<String, Pair<String, String>> = mapOf(
            "Abbrev" to ("ABBREV" to "CET"), "AltRep" to ("ALTREP" to "https://example.com/alt"), "Cn" to ("CN" to "Jane Doe"),
            "CuType" to ("CUTYPE" to "INDIVIDUAL"), "DelegatedFrom" to ("DELEGATED-FROM" to "mailto:a@example.com"),
            "DelegatedTo" to ("DELEGATED-TO" to "mailto:b@example.com"), "Dir" to ("DIR" to "https://example.com/dir"),
            "Encoding" to ("ENCODING" to "BASE64"), "FmtType" to ("FMTTYPE" to "text/plain"), "FbType" to ("FBTYPE" to "BUSY"),
            "Language" to ("LANGUAGE" to "en"), "Member" to ("MEMBER" to "mailto:group@example.com"), "PartStat" to ("PARTSTAT" to "ACCEPTED"),
            "Range" to ("RANGE" to "THISANDFUTURE"), "Related" to ("RELATED" to "START"), "RelType" to ("RELTYPE" to "PARENT"),
            "Role" to ("ROLE" to "CHAIR"), "Rsvp" to ("RSVP" to "TRUE"), "ScheduleAgent" to ("SCHEDULE-AGENT" to "SERVER"),
            "ScheduleStatus" to ("SCHEDULE-STATUS" to "2.0"), "SentBy" to ("SENT-BY" to "mailto:s@example.com"), "Type" to ("TYPE" to "WORK"),
            "TzId" to ("TZID" to "Europe/Berlin"), "Value" to ("VALUE" to "TEXT"), "Vvenue" to ("VVENUE" to "venue@example.com"),
            "Display" to ("DISPLAY" to "BADGE"), "Email" to ("EMAIL" to "e@example.com"), "Feature" to ("FEATURE" to "AUDIO"),
            "Label" to ("LABEL" to "Room")
    )

    private fun serialize(property: Property): ByteArray {
        val bytes = ByteArrayOutputStream()
        ObjectOutputStream(bytes).use { it.writeObject(property) }
        return bytes.toByteArray()
    }

    private fun printProvenance(group: String) {
        val ical4jJar = net.fortuna.ical4j.model.Calendar::class.java.protectionDomain?.codeSource?.location
        println("D2-RECORDER provenance group=$group java.version=${System.getProperty("java.version")} " +
                "java.vendor=${System.getProperty("java.vendor")} java.vm.name=${System.getProperty("java.vm.name")} " +
                "java.runtime.version=${System.getProperty("java.runtime.version")} ical4j.jar=$ical4jJar")
    }

    /** Round-trips every fixture (none is skipped on an earlier failure) and fails at the end if any failed. */
    private fun record(group: String, fixtures: List<Fixture>) {
        printProvenance(group)
        val failures = mutableListOf<String>()
        for (fixture in fixtures) {
            try {
                val original = fixture.make()
                val recorder = RecordingObjectInputStream(ByteArrayInputStream(serialize(original)))
                val copy = recorder.use { it.readObject() } as Property
                assertEquals("${fixture.family}/${fixture.variant} class", original.javaClass, copy.javaClass)
                assertEquals("${fixture.family}/${fixture.variant} name", original.name, copy.name)
                assertEquals("${fixture.family}/${fixture.variant} value", original.value, copy.value)
                assertEquals("${fixture.family}/${fixture.variant} parameters", original.parameters, copy.parameters)
                fixture.check?.invoke(original, copy)
                println("D2-RECORDER group=$group family=${fixture.family} variant=${fixture.variant} class=${original.javaClass.name} " +
                        "descriptors=${recorder.descriptors.joinToString(",")}")
            } catch (e: Throwable) {
                failures += "${fixture.family}/${fixture.variant}: ${e.javaClass.name}: ${e.message}"
                println("D2-RECORDER group=$group family=${fixture.family} variant=${fixture.variant} status=FAILED error=${e.javaClass.name}: ${e.message}")
            }
        }
        assertTrue("D2 recorder fixtures failed (all fixtures were attempted): $failures", failures.isEmpty())
    }


    @Test
    fun testLegacyRecorder_RoutedPropertyFamilies_RoundTrip() {
        // Routed families are derived from the actual default factories, minus what Event.kt handles.
        val canonicalNames = propertyFactories.map { it.createProperty().name }.distinct().sorted()
        println("D2-RECORDER factory-property-names=${canonicalNames.joinToString(",")}")
        val routed = canonicalNames.filter { it !in handledByEvent } + "X-SILENTSUITE-TEST"
        val fixtures = routed.flatMap { name ->
            val variants = routedVariants[name]
                    ?: listOf("missing-fixture" to { throw AssertionError("no legitimate fixture defined for routed property $name") })
            variants.map { (variant, make) -> Fixture(name, variant, make) }
        }
        record("routed-properties", fixtures)
    }

    @Test
    fun testLegacyRecorder_ClazzForms_RoundTrip() {
        val equalsConfidential: (Property, Property) -> Unit = { _, copy -> assertEquals(Clazz.CONFIDENTIAL, copy) }
        record("clazz", listOf(
                Fixture("CLASS", "shared-constant", { Clazz.CONFIDENTIAL }, equalsConfidential),
                Fixture("CLASS", "factory-confidential", { prop("CLASS", "CONFIDENTIAL") }, equalsConfidential),
                Fixture("CLASS", "custom-value", { Clazz("X-SILENTSUITE-CUSTOM") })
        ))
    }

    @Test
    fun testLegacyRecorder_DefaultParameterFamilies_RoundTrip() {
        val fixtures = parameterFactories.map { factory ->
            val family = factory.javaClass.enclosingClass?.simpleName ?: factory.javaClass.name
            val (name, value) = parameterValues[family] ?: ("" to "")
            Fixture("param:$family", "on-x-property", {
                if (name.isEmpty()) throw AssertionError("no legitimate fixture defined for default parameter factory $family")
                val parameter = factory.createParameter(value) as Parameter
                assertEquals("param:$family name", name, parameter.name)
                PropertyBuilder().factories(propertyFactories).name("X-SILENTSUITE-PARAM-CARRIER").value("v").parameter(parameter).build()
            })
        } + Fixture("param:XParameter", "on-x-property", { prop("X-SILENTSUITE-PARAM-CARRIER", "v", "X-SILENTSUITE-PARAM" to "1") })
        record("default-parameters", fixtures)
    }

    @Test
    fun testLegacyRecorder_DateTimeValueShapes_RoundTrip() {
        val tzBerlin = DateUtils.ical4jTimeZone("Europe/Berlin")!!
        record("date-time-shapes", listOf(
                Fixture("DUE", "date", { Due(Date("20230105")) }),
                Fixture("DUE", "floating", { Due(DateTime("20230105T120000")) }),
                Fixture("DUE", "utc", { prop("DUE", "20230105T120000Z") }),
                Fixture("DUE", "tzid-ical4j-timezone", { Due(DateTime("20230105T120000", tzBerlin)) }),
                Fixture("DUE", "parsed-value-date", { prop("DUE", "20230105", "VALUE" to "DATE") }),
                Fixture("CREATED", "utc", { prop("CREATED", "20230105T120000Z") }),
                Fixture("FREEBUSY", "period-list", { prop("FREEBUSY", "20230105T120000Z/20230105T130000Z") }),
                Fixture("TRIGGER", "duration", { prop("TRIGGER", "-PT15M") }),
                Fixture("TRIGGER", "date-time", { prop("TRIGGER", "20230105T120000Z", "VALUE" to "DATE-TIME") }),
                Fixture("TZOFFSETFROM", "utc-offset", { prop("TZOFFSETFROM", "+0100") }),
                Fixture("REFRESH-INTERVAL", "duration", { prop("REFRESH-INTERVAL", "P1W", "VALUE" to "DURATION") })
        ))
    }

    @Test
    fun testLegacyRecorder_ParsedEventUnknownProperties_RoundTrip() {
        // Actual parser and Event.kt routing (ICalendar.fromReader + ICalPreprocessor) produce the unknown properties.
        val ics = listOf(
                "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SilentSuite//D2 recorder//EN",
                "BEGIN:VEVENT", "UID:d2-recorder@example.com", "DTSTAMP:20230101T000000Z", "DTSTART:20230105T100000Z",
                "SUMMARY:Recorder", "CREATED:20230101T120000Z", "DUE;TZID=Europe/Berlin:20230105T120000",
                "URL:https://example.com/event", "GEO:48.2082;16.3738", "ATTACH;FMTTYPE=application/pdf:https://example.com/a.pdf",
                "COMMENT;ALTREP=\"https://example.com/c\";LANGUAGE=en:comment", "RESOURCES:PROJECTOR,EASEL", "PRIORITY:1",
                "RELATED-TO;RELTYPE=PARENT:parent@example.com", "CONTACT:Jane Doe", "REQUEST-STATUS:2.0;Success",
                "CONFERENCE;VALUE=URI;FEATURE=AUDIO;LABEL=Room:https://example.com/meet", "IMAGE;VALUE=URI:https://example.com/i.png",
                "REFRESH-INTERVAL;VALUE=DURATION:P1W", "X-SILENTSUITE-TEST;X-SILENTSUITE-PARAM=1:value", "FOO-BAR:iana-unknown",
                "END:VEVENT", "END:VCALENDAR"
        ).joinToString("\r\n", postfix = "\r\n")
        val event = Event.eventsFromReader(StringReader(ics)).single()
        val routedNames = event.unknownProperties.map { "${it.name}:${it.javaClass.name}" }
        println("D2-RECORDER parsed-routing unknownProperties=${routedNames.joinToString(",")}")
        val names = event.unknownProperties.map { it.name }.toSet()
        for (expected in listOf("CREATED", "DUE", "URL", "GEO", "ATTACH", "COMMENT", "RESOURCES", "PRIORITY", "RELATED-TO", "CONTACT",
                "REQUEST-STATUS", "CONFERENCE", "IMAGE", "REFRESH-INTERVAL", "X-SILENTSUITE-TEST"))
            assertTrue("parsed event must route $expected to unknownProperties; routed: $routedNames", expected in names)
        // FOO-BAR (non-X IANA name) is recorded as the parser actually handles it; its presence is not asserted.
        record("parsed-event", event.unknownProperties.mapIndexed { index, property ->
            Fixture(property.name, "parsed-$index", { property })
        })
    }

}
