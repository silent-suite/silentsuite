/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.vcard4android

import android.Manifest
import android.accounts.Account
import android.content.ContentProviderClient
import android.provider.ContactsContract
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import at.bitfire.vcard4android.impl.TestAddressBook
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class AndroidGroupTest {

    @JvmField
    @Rule
    val permissionRule = GrantPermissionRule.grant(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)!!

    private val testAccount = Account("AndroidContactGroupTest", "at.bitfire.vcard4android")

    private lateinit var provider: ContentProviderClient
    private lateinit var addressBook: TestAddressBook

    @Before
    fun connect() {
        val context = InstrumentationRegistry.getInstrumentation().context
        provider = context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY)!!
        assertNotNull(provider)

        addressBook = TestAddressBook(testAccount, provider)
    }

    @After
    fun disconnect() {
        @Suppress("DEPRECATION")
        provider.release()
    }


    @Test
    fun testCreateReadDeleteGroup() {
        val contact = Contact()
        contact.displayName = "at.bitfire.vcard4android-AndroidGroupTest"
        contact.note = "(test group)"

        // ensure we start without this group
        assertEquals(0, addressBook.queryGroups("${ContactsContract.Groups.TITLE}=?", arrayOf(contact.displayName!!)).size)

        // create group
        val group = AndroidGroup(addressBook, contact, null, null)
        group.add()
        val groups = addressBook.queryGroups("${ContactsContract.Groups.TITLE}=?", arrayOf(contact.displayName!!))
        assertEquals(1, groups.size)
        val contact2 = groups.first().contact
        assertEquals(contact.displayName, contact2?.displayName)
        assertEquals(contact.note, contact2?.note)

        // delete group
        group.delete()
        assertEquals(0, addressBook.queryGroups("${ContactsContract.Groups.TITLE}=?", arrayOf(contact.displayName!!)).size)
    }

}
