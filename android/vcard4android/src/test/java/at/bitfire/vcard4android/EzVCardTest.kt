/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.vcard4android

import ezvcard.Ezvcard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import java.util.*

class EzVCardTest {

    @Test
    fun testREV_UTC() {
        val vCard = Ezvcard.parse("BEGIN:VCARD\r\n" +
                "VERSION:4.0\r\n" +
                "REV:20161218T201900Z\r\n" +
                "END:VCARD").first()
        assertNotNull(vCard.revision)
    }

    @Test
    fun testREV_UTC_Milliseconds() {
        val vCard = Ezvcard.parse("BEGIN:VCARD\r\n" +
                "VERSION:4.0\r\n" +
                "REV:2016-11-27T15:49:53.762Z\r\n" +
                "END:VCARD").first()
        assertNotNull(vCard.revision)
    }

    @Test
    fun testREV_WithoutTZ() {
        val vCard = Ezvcard.parse("BEGIN:VCARD\r\n" +
                "VERSION:4.0\r\n" +
                "REV:20161218T201900\r\n" +
                "END:VCARD").first()
        assertNotNull(vCard.revision)
    }

    @Test
    fun testREV_TZHourOffset() {
        val vCard = Ezvcard.parse("BEGIN:VCARD\r\n" +
                "VERSION:4.0\r\n" +
                "REV:20161218T201900-05\r\n" +
                "END:VCARD").first()
        assertNotNull(vCard.revision)
    }

    @Test
    fun testREV_TZHourAndMinOffset() {
        val vCard = Ezvcard.parse("BEGIN:VCARD\r\n" +
                "VERSION:4.0\r\n" +
                "REV:20161218T201900-0530\r\n" +
                "END:VCARD").first()
        assertNotNull(vCard.revision)
    }

}
