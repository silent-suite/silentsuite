/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.vcard4android

import ezvcard.VCardVersion
import ezvcard.parameter.*
import ezvcard.property.*
import ezvcard.util.PartialDate
import org.apache.commons.io.IOUtils
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStreamReader
import java.io.StringReader
import java.nio.charset.Charset
import java.text.SimpleDateFormat
import java.util.*

class ContactTest {

    private fun parseContact(fname: String, charset: Charset = Charsets.UTF_8) =
            javaClass.classLoader!!.getResourceAsStream(fname).use { stream ->
                Contact.fromReader(InputStreamReader(stream, charset), null).first()
            }

    private fun regenerate(c: Contact, vCardVersion: VCardVersion): Contact {
        val os = ByteArrayOutputStream()
        c.write(vCardVersion, GroupMethod.CATEGORIES, os)
        return Contact.fromReader(InputStreamReader(ByteArrayInputStream(os.toByteArray()), Charsets.UTF_8), null).first()
    }

    private fun toString(c: Contact, groupMethod: GroupMethod, vCardVersion: VCardVersion): String {
        val os = ByteArrayOutputStream()
        c.write(vCardVersion, groupMethod, os)
        return os.toString()
    }


    @Test
    fun testDropEmptyProperties() {
        val vcard = "BEGIN:VCARD\n" +
                "VERSION:4.0\n" +
                "FN:Sample with empty values\n" +
                "TEL:12345\n" +
                "TEL:\n" +
                "EMAIL:test@example.com\n" +
                "EMAIL:\n" +
                "END:VCARD"
        val c = Contact.fromReader(StringReader(vcard), null).first()
        assertEquals(1, c.phoneNumbers.size)
        assertEquals("12345", c.phoneNumbers.first.property.text)
        assertEquals(1, c.emails.size)
        assertEquals("test@example.com", c.emails.first.property.value)
    }

    @Test
    fun testGenerateOrganizationOnly() {
        val c = Contact()
        c.uid = UUID.randomUUID().toString()
        val org = Organization()
        org.values.add("My Organization")
        org.values.add("My Department")
        c.organization = org

        // vCard 3 needs FN and N
        var vCard = toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V3_0)
        assertTrue(vCard.contains("\nORG:My Organization;My Department\r\n"))
        assertTrue(vCard.contains("\nFN:My Organization\r\n"))
        assertTrue(vCard.contains("\nN:\r\n"))

        // vCard 4 only needs FN
        vCard = toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V4_0)
        assertTrue(vCard.contains("\nORG:My Organization;My Department\r\n"))
        assertTrue(vCard.contains("\nFN:My Organization\r\n"))
        assertFalse(vCard.contains("\nN:"))
    }

    @Test
    fun testGenerateOrgDepartmentOnly() {
        val c = Contact()
        c.uid = UUID.randomUUID().toString()
        val org = Organization()
        org.values.add("")
        org.values.add("My Department")
        c.organization = org

        // vCard 3 needs FN and N
        var vCard = toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V3_0)
        assertTrue(vCard.contains("\nORG:;My Department\r\n"))
        assertTrue(vCard.contains("\nFN:My Department\r\n"))
        assertTrue(vCard.contains("\nN:\r\n"))

        // vCard 4 only needs FN
        vCard = toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V4_0)
        assertTrue(vCard.contains("\nORG:;My Department\r\n"))
        assertTrue(vCard.contains("\nFN:My Department\r\n"))
        assertFalse(vCard.contains("\nN:"))
    }

    @Test
    fun testGenerateGroup() {
        val c = Contact()
        c.uid = UUID.randomUUID().toString()
        c.displayName = "My Group"
        c.group = true
        c.members += "member1"
        c.members += "member2"

        // vCard 3 needs FN and N
        // exception for Apple: "N:<group name>"
        var vCard = toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V3_0)
        assertTrue(vCard.contains("\nX-ADDRESSBOOKSERVER-KIND:group\r\n"))
        assertTrue(vCard.contains("\nFN:My Group\r\n"))
        assertTrue(vCard.contains("\nN:My Group\r\n"))
        assertTrue(vCard.contains("\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:member1\r\n"))
        assertTrue(vCard.contains("\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:member2\r\n"))

        // vCard 4 only needs FN
        vCard = toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V4_0)
        assertTrue(vCard.contains("\nKIND:group\r\n"))
        assertTrue(vCard.contains("\nFN:My Group\r\n"))
        assertFalse(vCard.contains("\nN:"))
        assertTrue(vCard.contains("\nMEMBER:urn:uuid:member1\r\n"))
        assertTrue(vCard.contains("\nMEMBER:urn:uuid:member2\r\n"))
    }

    @Test
    fun testGenerateWithoutName() {
        /* no data */
        val c = Contact()
        // vCard 3 needs FN and N
        var vCard = toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V3_0)
        assertTrue(vCard.contains("\nFN:\r\n"))
        assertTrue(vCard.contains("\nN:\r\n"))
        // vCard 4 only needs FN
        vCard = toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V4_0)
        assertTrue(vCard.contains("\nFN:\r\n"))
        assertFalse(vCard.contains("\nN:"))

        /* only UID */
        c.uid = UUID.randomUUID().toString()
        vCard = toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V3_0)
        // vCard 3 needs FN and N
        assertTrue(vCard.contains("\nFN:${c.uid}\r\n"))
        assertTrue(vCard.contains("\nN:\r\n"))
        // vCard 4 only needs FN
        vCard = toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V4_0)
        assertTrue(vCard.contains("\nFN:${c.uid}\r\n"))
        assertFalse(vCard.contains("\nN:"))

        // phone number available
        c.phoneNumbers += LabeledProperty(Telephone("12345"))
        assertTrue(toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V3_0).contains("\nFN:12345\r\n"))

        // email address available
        c.emails += LabeledProperty(Email("test@example.com"))
        assertTrue(toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V3_0).contains("\nFN:test@example.com\r\n"))

        // nick name available
        c.nickName = Nickname()
        c.nickName!!.values += "Nikki"
        assertTrue(toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V3_0).contains("\nFN:Nikki\r\n"))
    }

    @Test
    fun testGenerateLabeledProperty() {
        var c = Contact()
        c.uid = UUID.randomUUID().toString()
        c.phoneNumbers += LabeledProperty(Telephone("12345"), "My Phone")
        val vCard = toString(c, GroupMethod.GROUP_VCARDS, VCardVersion.V3_0)
        assertTrue(vCard.contains("\ngroup1.TEL:12345\r\n"))
        assertTrue(vCard.contains("\ngroup1.X-ABLabel:My Phone\r\n"))

        c = regenerate(c, VCardVersion.V4_0)
        assertEquals("12345", c.phoneNumbers.first.property.text)
        assertEquals("My Phone", c.phoneNumbers.first.label)
    }

    @Test
    fun testInvalidREV() {
        val c = parseContact("invalid-rev.vcf")
        assertFalse(c.unknownProperties!!.contains("REV"))
    }


    @Test
    fun testVCard3FieldsAsVCard3() {
        val c = regenerate(parseContact("allfields-vcard3.vcf"), VCardVersion.V3_0)

        // UID
        assertEquals("mostfields1@at.bitfire.vcard4android", c.uid)

        // FN
        assertEquals("Ämi Display", c.displayName)

        // N
        assertEquals("Firstname", c.givenName)
        assertEquals("Middlename1 Middlename2", c.middleName)
        assertEquals("Lastname", c.familyName)

        // phonetic names
        assertEquals("Förstnehm", c.phoneticGivenName)
        assertEquals("Mittelnehm", c.phoneticMiddleName)
        assertEquals("Laastnehm", c.phoneticFamilyName)

        // TEL
        assertEquals(2, c.phoneNumbers.size)
        var phone = c.phoneNumbers.first
        assertEquals("Useless", phone.label)
        assertTrue(phone.property.types.contains(TelephoneType.VOICE))
        assertTrue(phone.property.types.contains(TelephoneType.HOME))
        assertTrue(phone.property.types.contains(TelephoneType.PREF))
        assertNull(phone.property.pref)
        assertEquals("+49 1234 56788", phone.property.text)
        phone = c.phoneNumbers[1]
        assertNull(phone.label)
        assertTrue(phone.property.types.contains(TelephoneType.FAX))
        assertEquals("+1-800-MYFAX", phone.property.text)

        // EMAIL
        assertEquals(2, c.emails.size)
        var email = c.emails.first
        assertNull(email.label)
        assertTrue(email.property.types.contains(EmailType.HOME))
        assertTrue(email.property.types.contains(EmailType.PREF))
        assertNull(email.property.pref)
        assertEquals("private@example.com", email.property.value)
        email = c.emails[1]
        assertEquals("@work", email.label)
        assertTrue(email.property.types.contains(EmailType.WORK))
        assertEquals("work@example.com", email.property.value)

        // ORG, TITLE, ROLE
        assertEquals(
                listOf("ABC, Inc.", "North American Division", "Marketing"),
                c.organization!!.values
        )
        assertEquals("Director, Research and Development", c.jobTitle)
        assertEquals("Programmer", c.jobDescription)

        // IMPP
        assertEquals(3, c.impps.size)
        var impp = c.impps.first
        assertEquals("MyIM", impp.label)
        assertTrue(impp.property.types.contains(ImppType.PERSONAL))
        assertTrue(impp.property.types.contains(ImppType.MOBILE))
        assertTrue(impp.property.types.contains(ImppType.PREF))
        assertNull(impp.property.pref)
        assertEquals("myIM", impp.property.protocol)
        assertEquals("anonymous@example.com", impp.property.handle)
        impp = c.impps[1]
        assertNull(impp.label)
        assertTrue(impp.property.types.contains(ImppType.BUSINESS))
        assertEquals("skype", impp.property.protocol)
        assertEquals("echo@example.com", impp.property.handle)
        impp = c.impps[2]
        assertNull(impp.label)
        assertEquals("sip", impp.property.protocol)
        assertEquals("mysip@example.com", impp.property.handle)

        // NICKNAME
        assertEquals(
                listOf("Nick1", "Nick2"),
                c.nickName!!.values
        )

        // ADR
        assertEquals(2, c.addresses.size)
        var addr = c.addresses.first
        assertNull(addr.label)
        assertTrue(addr.property.types.contains(AddressType.WORK))
        assertTrue(addr.property.types.contains(AddressType.POSTAL))
        assertTrue(addr.property.types.contains(AddressType.PARCEL))
        assertTrue(addr.property.types.contains(AddressType.PREF))
        assertNull(addr.property.pref)
        assertNull(addr.property.poBox)
        assertNull(addr.property.extendedAddress)
        assertEquals("6544 Battleford Drive", addr.property.streetAddress)
        assertEquals("Raleigh", addr.property.locality)
        assertEquals("NC", addr.property.region)
        assertEquals("27613-3502", addr.property.postalCode)
        assertEquals("U.S.A.", addr.property.country)
        addr = c.addresses[1]
        assertEquals("Monkey Tree", addr.label)
        assertTrue(addr.property.types.contains(AddressType.WORK))
        assertEquals("Postfach 314", addr.property.poBox)
        assertEquals("vorne hinten", addr.property.extendedAddress)
        assertEquals("Teststraße 22", addr.property.streetAddress)
        assertEquals("Mönchspfaffingen", addr.property.locality)
        assertNull(addr.property.region)
        assertEquals("4043", addr.property.postalCode)
        assertEquals("Klöster-Reich", addr.property.country)

        // NOTE
        assertEquals("This fax number is operational 0800 to 1715 EST, Mon-Fri.\n\n\nSecond note", c.note)

        // CATEGORIES
        assertEquals(
                listOf("A", "B'C"),
                c.categories
        )

        // URL
        assertEquals(2, c.urls.size)
        var url1 = false
        var url2 = false
        for (url in c.urls) {
            if ("https://davdroid.bitfire.at/" == url.property.value && url.property.type == null && url.label == null)
                url1 = true
            if ("http://www.swbyps.restaurant.french/~chezchic.html" == url.property.value && "x-blog" == url.property.type && "blog" == url.label)
                url2 = true
        }
        assertTrue(url1 && url2)

        // BDAY
        val dateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT)
        assertEquals("1996-04-15", dateFormat.format(c.birthDay!!.date))
        // ANNIVERSARY
        assertEquals("2014-08-12", dateFormat.format(c.anniversary!!.date))

        // RELATED
        assertEquals(2, c.relations.size)
        var rel = c.relations.first
        assertTrue(rel.types.contains(RelatedType.CO_WORKER))
        assertTrue(rel.types.contains(RelatedType.CRUSH))
        assertEquals("Ägidius", rel.text)
        rel = c.relations[1]
        assertTrue(rel.types.contains(RelatedType.PARENT))
        assertEquals("muuuum", rel.text)

        // PHOTO
        javaClass.classLoader!!.getResourceAsStream("lol.jpg").use { photo ->
            assertArrayEquals(IOUtils.toByteArray(photo), c.photo)
        }
    }

    @Test
    fun testVCard3FieldsAsVCard4() {
        val c = regenerate(parseContact("allfields-vcard3.vcf"), VCardVersion.V4_0)
        // let's check only things that should be different when VCard 4.0 is generated

        val phone = c.phoneNumbers.first.property
        assertFalse(phone.types.contains(TelephoneType.PREF))
        assertNotNull(phone.pref)

        val email = c.emails.first.property
        assertFalse(email.types.contains(EmailType.PREF))
        assertNotNull(email.pref)

        val impp = c.impps.first.property
        assertFalse(impp.types.contains(ImppType.PREF))
        assertNotNull(impp.pref)

        val addr = c.addresses.first.property
        assertFalse(addr.types.contains(AddressType.PREF))
        assertNotNull(addr.pref)
    }

    @Test
    fun testVCard4FieldsAsVCard3() {
        val c = regenerate(parseContact("vcard4.vcf"), VCardVersion.V3_0)
        assertEquals(Birthday(PartialDate.parse("--04-16")), c.birthDay)
    }

    @Test
    fun testVCard4FieldsAsVCard4() {
        val c = regenerate(parseContact("vcard4.vcf"), VCardVersion.V4_0)
        assertEquals(Birthday(PartialDate.parse("--04-16")), c.birthDay)
    }


    @Test
    fun testStrangeREV() {
        val c = parseContact("strange-rev.vcf")
        assertNull(c.unknownProperties)
    }

}
