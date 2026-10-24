package io.silentsuite.sync.resource

import android.Manifest
import android.accounts.Account
import android.content.ContentProviderClient
import android.content.ContentValues
import android.provider.ContactsContract
import android.provider.ContactsContract.Data
import android.provider.ContactsContract.RawContacts
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import at.bitfire.vcard4android.Contact
import at.bitfire.vcard4android.GroupMethod
import ezvcard.VCardVersion
import io.silentsuite.sync.App
import io.silentsuite.sync.model.UnknownProperties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.StringReader

/**
 * #865: the provider row holding a contact's retained unknown vCard properties.
 *
 * Synthetic contacts only, in a per-test address-book account that is never registered with
 * AccountManager, so no sync adapter runs against it. Behavioral failures are assertion
 * failures prefixed "BEHAVIOR"; fixture/setup problems are IllegalStateException prefixed
 * "FIXTURE" and must not be read as a reproduction.
 */
@RunWith(AndroidJUnit4::class)
class LocalContactUnknownPropertiesRuntimeTest {
    @get:Rule
    val contactsPermissionRule: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.WRITE_CONTACTS,
    )

    private val blobA = card("X-TESTA:fixtureA")
    private val blobB = card("X-TESTB:fixtureB")

    @Test fun addPathPersistsUnknownRow() = withAddressBook { addressBook ->
        val local = LocalContact(addressBook, contact("add-path", blobA), "add-path", null)
        try {
            local.add()
        } catch (e: Exception) {
            fail("BEHAVIOR add-path: adding a contact with unknown properties failed: ${e.javaClass.name}")
        }
        val id = local.id ?: throw IllegalStateException("FIXTURE add-path: no raw contact id after add")
        assertEquals("BEHAVIOR add-path: raw contact rows", 1, rawContactCount(addressBook, id))
        assertEquals("BEHAVIOR add-path: unknown-properties rows bound to the new raw contact",
            listOf(blobA), unknownRows(addressBook, id))
        assertEquals("BEHAVIOR add-path: fresh read", blobA, fresh(addressBook, id).contact!!.unknownProperties)
    }

    @Test fun updateReplacesUnknownRow() = withAddressBook { addressBook ->
        // Fixture A is built without the add path's unknown-row insert.
        val local = LocalContact(addressBook, contact("update-path", null), "update-path", null)
        local.add()
        val id = local.id ?: throw IllegalStateException("FIXTURE update: no raw contact id after add")
        check(unknownRows(addressBook, id).isEmpty()) { "FIXTURE update: unexpected unknown row before insert" }
        insertDataRow(addressBook, id, UnknownProperties.CONTENT_ITEM_TYPE, blobA)
        insertDataRow(addressBook, id, OEM_MIME_TYPE, OEM_VALUE)
        check(unknownRows(addressBook, id) == listOf(blobA)) { "FIXTURE update: row A not stored exactly once" }
        check(fresh(addressBook, id).contact!!.unknownProperties == blobA) { "FIXTURE update: fresh read is not A" }

        fresh(addressBook, id).update(contact("update-path", blobB))
        assertEquals("BEHAVIOR update A->B: unknown-properties rows", listOf(blobB), unknownRows(addressBook, id))
        assertEquals("BEHAVIOR update A->B: fresh read", blobB, fresh(addressBook, id).contact!!.unknownProperties)
        assertEquals("BEHAVIOR update A->B: unrelated row", listOf(OEM_VALUE), dataRows(addressBook, id, OEM_MIME_TYPE))

        fresh(addressBook, id).update(contact("update-path", null))
        assertEquals("BEHAVIOR update B->none: unknown-properties rows", emptyList<String>(), unknownRows(addressBook, id))
        assertNull("BEHAVIOR update B->none: fresh read", fresh(addressBook, id).contact!!.unknownProperties)
        assertEquals("BEHAVIOR update B->none: unrelated row", listOf(OEM_VALUE), dataRows(addressBook, id, OEM_MIME_TYPE))
    }

    @Test fun nativeParseAndWriteKeepCustomProperties() {
        val parsed = Contact.fromReader(StringReader(ISSUE_865_SAMPLE), null).single()
        val os = ByteArrayOutputStream()
        parsed.write(VCardVersion.V4_0, GroupMethod.GROUP_VCARDS, os)
        val written = os.toString("UTF-8")
        for ((name, value) in listOf("X-TESTA" to "testA", "X-TestB" to "testB", "X-testC" to "testC", "X-testd" to "testD")) {
            assertTrue("BEHAVIOR native: $name kept", Regex("(?im)^${Regex.escape(name)}:${Regex.escape(value)}\\r?$").containsMatchIn(written))
        }
    }

    private fun withAddressBook(block: (LocalAddressBook) -> Unit) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val provider: ContentProviderClient = context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY)
            ?: throw IllegalStateException("FIXTURE: contacts provider unavailable")
        val account = Account("runtime-865-${System.nanoTime()}", App.addressBookAccountType)
        try {
            block(LocalAddressBook(context, account, provider))
        } finally {
            provider.delete(
                RawContacts.CONTENT_URI.buildUpon().appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true").build(),
                "${RawContacts.ACCOUNT_NAME}=? AND ${RawContacts.ACCOUNT_TYPE}=?",
                arrayOf(account.name, account.type),
            )
            @Suppress("DEPRECATION")
            provider.release()
        }
    }

    private fun contact(uid: String, unknown: String?) = Contact().apply {
        this.uid = uid
        displayName = "Synthetic $uid"
        unknownProperties = unknown
    }

    /** A new provider-backed instance, so no cached Contact from an earlier step is reused. */
    private fun fresh(addressBook: LocalAddressBook, id: Long): LocalContact = addressBook.findContactByID(id)

    private fun rawContactCount(addressBook: LocalAddressBook, id: Long): Int =
        addressBook.requireProvider().query(addressBook.syncAdapterURI(RawContacts.CONTENT_URI),
            arrayOf(RawContacts._ID), "${RawContacts._ID}=?", arrayOf(id.toString()), null)!!.use { it.count }

    private fun unknownRows(addressBook: LocalAddressBook, id: Long) =
        dataRows(addressBook, id, UnknownProperties.CONTENT_ITEM_TYPE)

    private fun dataRows(addressBook: LocalAddressBook, id: Long, mimeType: String): List<String?> =
        addressBook.requireProvider().query(addressBook.syncAdapterURI(Data.CONTENT_URI), arrayOf(Data.DATA1),
            "${Data.RAW_CONTACT_ID}=? AND ${Data.MIMETYPE}=?", arrayOf(id.toString(), mimeType), null)!!.use { cursor ->
            List(cursor.count) { cursor.moveToPosition(it); cursor.getString(0) }
        }

    private fun insertDataRow(addressBook: LocalAddressBook, id: Long, mimeType: String, value: String) {
        val values = ContentValues().apply {
            put(Data.RAW_CONTACT_ID, id)
            put(Data.MIMETYPE, mimeType)
            put(Data.DATA1, value)
        }
        checkNotNull(addressBook.requireProvider().insert(addressBook.syncAdapterURI(Data.CONTENT_URI), values)) {
            "FIXTURE: insert of $mimeType row failed"
        }
    }

    private companion object {
        const val OEM_MIME_TYPE = "vnd.android.cursor.item/vnd.io.silentsuite.test.unrelated"
        const val OEM_VALUE = "unrelated-row"

        // Exact sample from issue #865.
        val ISSUE_865_SAMPLE = listOf(
            "BEGIN:VCARD", "VERSION:4.0", "UID:20261023T213116Z1949487429", "FN:John Doe", "N:Doe;John;;;",
            "TEL;TYPE=cell:+1 234 567890", "X-TESTA:testA", "X-TestB:testB", "X-testC:testC", "X-testd:testD",
            "END:VCARD",
        ).joinToString("\r\n")

        fun card(line: String) = "BEGIN:VCARD\r\nVERSION:4.0\r\n$line\r\nEND:VCARD\r\n"
    }
}
