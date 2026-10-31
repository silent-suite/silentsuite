package at.bitfire.ical4android

import net.fortuna.ical4j.model.ParameterList
import net.fortuna.ical4j.model.Property
import net.fortuna.ical4j.model.parameter.XParameter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InvalidClassException
import java.io.ObjectInputStream
import java.io.ObjectOutputStream
import java.io.Serializable
import java.util.LinkedList
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Test-only inventory of the Java serialization descriptors of legitimate unknown-property graphs
 * (D2 compatibility floor). The five testLegacyRecorder_* methods run the shared [LegacyRecorderFloor]
 * (src/sharedTest), which round-trips controlled fixtures through an UNRESTRICTED stream and prints
 * the descriptor names per family and variant, with runtime and dependency provenance, to system-out.
 *
 * This is evidence collection only: it is neither the production legacy reader nor an allowlist, and
 * the recorder's own proxy rejection proves nothing about production rejection.
 *
 * The D2-T2/T3/T4 hostile tests (testLegacyReader_*) instead call the production-called seam
 * [UnknownProperty.fromLegacySerialized]. They first assert that the hostile serialization callback did
 * not run, then require the exact descriptor-denial [InvalidClassException] carrying [LEGACY_DENIAL_MARKER]
 * for the expected denied descriptor. They are tests-first: the seam is still unrestricted.
 */
class UnknownPropertyLegacyTest {

    companion object {
        /** Predeclared reason the restricted legacy reader must pass as `InvalidClassException(desc.name, reason)`. */
        const val LEGACY_DENIAL_MARKER = "D2-LEGACY-DESCRIPTOR-DENIED"
    }

    /** Shared positive floor; the JVM sink prints exactly the former system-out lines. */
    private val floor = LegacyRecorderFloor { println(it) }

    /** Hook flags of the hostile fixtures; reset and verified before every seam invocation. */
    private object HostileHookFlags {
        @Volatile var payloadHookRan = false
        @Volatile var parameterHookRan = false
    }

    /** D2-T2/T3 test-only hostile payload: its private serialization callback only records that it ran. */
    private class HostileLegacyPayload : Serializable {
        @Suppress("unused")
        private fun readObject(input: ObjectInputStream) {
            input.defaultReadObject()
            HostileHookFlags.payloadHookRan = true
        }
    }

    /** D2-T4 test-only hostile subclass of the admitted XParameter: private serialization callback, no override. */
    private class HostileParameter : XParameter("X-SILENTSUITE-HOSTILE", "1") {
        @Suppress("unused")
        private fun readObject(input: ObjectInputStream) {
            input.defaultReadObject()
            HostileHookFlags.parameterHookRan = true
        }
    }

    /** Positive fixture helper used by the hostile tests; delegates to the shared floor's PropertyBuilder helper. */
    private fun prop(name: String, value: String, vararg params: Pair<String, String>): Property =
            floor.prop(name, value, *params)


    @Test
    fun testLegacyRecorder_RoutedPropertyFamilies_RoundTrip() = floor.routedPropertyFamilies()

    @Test
    fun testLegacyRecorder_ClazzForms_RoundTrip() = floor.clazzForms()

    @Test
    fun testLegacyRecorder_DefaultParameterFamilies_RoundTrip() = floor.defaultParameterFamilies()

    @Test
    fun testLegacyRecorder_DateTimeValueShapes_RoundTrip() = floor.dateTimeValueShapes()

    @Test
    fun testLegacyRecorder_ParsedEventUnknownProperties_RoundTrip() = floor.parsedEventUnknownProperties()


    /** Test-only serialization of hostile graphs; unlike [serialize] it accepts a non-Property payload, uncast. */
    private fun serializeHostile(graph: Serializable): ByteArray {
        val bytes = ByteArrayOutputStream()
        ObjectOutputStream(bytes).use { it.writeObject(graph) }
        return bytes.toByteArray()
    }

    /** Final D2 GREEN requirement: descriptor-denial InvalidClassException with the exact predeclared marker. */
    private fun assertDescriptorDenied(outcome: Result<Property>, expectedDescriptor: String) {
        val error = outcome.exceptionOrNull()
        if (error !is InvalidClassException)
            throw AssertionError("expected descriptor-denial InvalidClassException for $expectedDescriptor, got " +
                    (error?.let { "${it.javaClass.name}: ${it.message}" } ?: "success: ${outcome.getOrNull()?.javaClass?.name}"), error)
        assertEquals("denied descriptor", expectedDescriptor, error.classname)
        assertEquals("descriptor-denial marker", "$expectedDescriptor; $LEGACY_DENIAL_MARKER", error.message)
    }

    @Test
    fun testLegacyReader_HostileTopLevelPayload_DeniedBeforeHook() {
        // D2-T2: a top-level non-Property payload, serialized without any Property cast.
        val bytes = serializeHostile(HostileLegacyPayload())

        HostileHookFlags.payloadHookRan = false
        assertFalse("fixture: payload hook flag must be reset before invocation", HostileHookFlags.payloadHookRan)
        val outcome = runCatching { UnknownProperty.fromLegacySerialized(bytes) }

        // Asserted first: a later Property ClassCastException earns no credit.
        assertFalse("D2-T2 hostile top-level payload hook must not execute", HostileHookFlags.payloadHookRan)
        assertDescriptorDenied(outcome, HostileLegacyPayload::class.java.name)
    }

    @Test
    fun testLegacyReader_HostileNestedContainer_DeniedBeforeHook() {
        // D2-T3: java.util.LinkedList is absent from the observed 233-descriptor union (java.util.HashMap is present via
        // Recur and therefore unsuitable). It is inserted into the admitted XProperty's ParameterList backing list.
        val property = prop("X-SILENTSUITE-TEST", "value")
        val backing = try {
            ParameterList::class.java.getDeclaredField("parameters").apply { isAccessible = true }.get(property.parameters)
        } catch (e: Exception) {
            throw AssertionError("fixture: cannot reflect ParameterList.parameters: ${e.javaClass.name}: ${e.message}", e)
        }
        if (backing !is CopyOnWriteArrayList<*>)
            throw AssertionError("fixture: ParameterList.parameters backing is ${backing?.javaClass?.name}, expected mutable java.util.concurrent.CopyOnWriteArrayList")
        val container = LinkedList<Any>().apply { add(HostileLegacyPayload()) }
        @Suppress("UNCHECKED_CAST")
        (backing as CopyOnWriteArrayList<Any>).add(container)
        if (backing.none { it === container })
            throw AssertionError("fixture: LinkedList container was not inserted into the ParameterList backing list")
        val bytes = serializeHostile(property)

        HostileHookFlags.payloadHookRan = false
        assertFalse("fixture: payload hook flag must be reset before invocation", HostileHookFlags.payloadHookRan)
        val outcome = runCatching { UnknownProperty.fromLegacySerialized(bytes) }

        assertFalse("D2-T3 hostile payload nested in a non-admitted container must not execute", HostileHookFlags.payloadHookRan)
        assertDescriptorDenied(outcome, LinkedList::class.java.name)
    }

    @Test
    fun testLegacyReader_HostileParameterSubclass_DeniedBeforeHook() {
        // D2-T4: hostile subclass of the admitted XParameter, nested in an admitted XProperty.
        val property = prop("X-SILENTSUITE-TEST", "value")
        try {
            property.parameters.add(HostileParameter())
        } catch (e: Exception) {
            throw AssertionError("fixture: cannot add HostileParameter to the XProperty: ${e.javaClass.name}: ${e.message}", e)
        }
        if (property.parameters.none { it is HostileParameter })
            throw AssertionError("fixture: HostileParameter is not part of the serialized XProperty graph")
        val bytes = serializeHostile(property)

        HostileHookFlags.parameterHookRan = false
        assertFalse("fixture: parameter hook flag must be reset before invocation", HostileHookFlags.parameterHookRan)
        val outcome = runCatching { UnknownProperty.fromLegacySerialized(bytes) }

        assertFalse("D2-T4 hostile XParameter subclass hook must not execute", HostileHookFlags.parameterHookRan)
        assertDescriptorDenied(outcome, HostileParameter::class.java.name)
    }

}
