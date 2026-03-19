package at.bitfire.ical4android

import androidx.test.filters.SmallTest
import net.fortuna.ical4j.model.Parameter
import net.fortuna.ical4j.model.parameter.Rsvp
import net.fortuna.ical4j.model.parameter.XParameter
import net.fortuna.ical4j.model.property.Attendee
import net.fortuna.ical4j.model.property.Uid
import org.json.JSONException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UnknownPropertyTest {

    @Test
    @SmallTest
    fun testFromJsonString() {
        val prop = UnknownProperty.fromJsonString("[ \"UID\", \"PropValue\" ]")
        assertTrue(prop is Uid)
        assertEquals("UID", prop.name)
        assertEquals("PropValue", prop.value)
    }

    @Test
    @SmallTest
    fun testFromJsonStringWithParameters() {
        val prop = UnknownProperty.fromJsonString("[ \"ATTENDEE\", \"PropValue\", { \"x-param1\": \"value1\", \"x-param2\": \"value2\" } ]")
        assertTrue(prop is Attendee)
        assertEquals("ATTENDEE", prop.name)
        assertEquals("PropValue", prop.value)
        assertEquals(2, prop.parameters.size())
        assertEquals("value1", prop.parameters.getParameter<Parameter>("x-param1").value)
        assertEquals("value2", prop.parameters.getParameter<Parameter>("x-param2").value)
    }

    @Test(expected = JSONException::class)
    @SmallTest
    fun testFromInvalidJsonString() {
        UnknownProperty.fromJsonString("This isn't JSON")
    }


    @Test
    @SmallTest
    fun testToJsonString() {
        val attendee = Attendee("mailto:test@test.at")
        assertEquals(
                "ATTENDEE:mailto:test@test.at",
                attendee.toString().trim()
        )

        attendee.parameters.add(Rsvp(true))
        attendee.parameters.add(XParameter("X-My-Param", "SomeValue"))
        assertEquals(
                "ATTENDEE;RSVP=TRUE;X-My-Param=SomeValue:mailto:test@test.at",
                attendee.toString().trim()
        )
    }

}