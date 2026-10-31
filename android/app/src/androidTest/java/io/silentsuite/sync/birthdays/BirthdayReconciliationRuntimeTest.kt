package io.silentsuite.sync.birthdays

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.etebase.client.Client
import com.etebase.client.Collection
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.Item
import com.etebase.client.ItemMetadata
import com.etebase.client.User
import io.silentsuite.sync.Constants
import io.silentsuite.sync.notes.FakeEtebaseServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Birthdays reconcile run ([BirthdayReconciler.reconcile]) through the pinned Etebase Java
 * binding (real JNI), against the stateful in-process [FakeEtebaseServer] the boundary tests use:
 * its listings, member lists, root-dependency check and stalled listings. Every expectation is read
 * back through the SDK (fresh fetches and listings) or from the fake's captured wire (upload
 * dependencies, request lines), never from the run's own return value alone. No Android account,
 * provider or process-wide seam is involved. All data is synthetic.
 *
 * Eligibility as approved (plan3 §1, which supersedes plan2's source rule). C2, the source: every
 * non-deleted address book currently listed for the account, at any access level (every contact the
 * user can currently see), with no ownership or membership claim. C3, the destination: only a
 * calendar whose content is the active marker, with Admin access and a fully paged member list that
 * is currently exactly the SDK user, so the copies never widen the audience. Generated events are
 * recognised by their parsed `ss-bday1-` UID; nothing else in a calendar is ever touched.
 *
 * Methods marked CONTROL are expected to pass against a run that does nothing; FEATURE assertions
 * name missing behaviour. Together they keep a blanket no-op from passing.
 */
@RunWith(AndroidJUnit4::class)
class BirthdayReconciliationRuntimeTest {
    private val fake = FakeEtebaseServer()

    /** The SDK user's own session, talking to this test's stand-in. */
    private val server by lazy {
        com.etebase.client.Account.restore(Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl), session, null)
    }

    @After fun tearDown() {
        fake.releaseAll()
    }

    @Test fun anActiveSoleOwnerCalendarGetsOneFencedEventForAPrivateContactBirthday() {
        val calendar = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE))
        val book = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Contacts", ""))
        val contact = uploadItem(book, "contact-ada", ADA_VCARD)
        val since = fake.uploadDeps.size
        val requestsBefore = fake.requests.size

        val result = BirthdayReconciler.reconcile(server, username)

        val events = liveItems(calendar.uid)
        assertEquals("FEATURE: one event is generated for the contact's birthday", 1, events.size)
        val expected = BirthdayCalendar.fieldsOf(BirthdayCalendar.BirthdayEvent(
            BirthdayCalendar.eventUid(book.uid, contact.uid), "Ada Lovelace", 12, 10))
        assertEquals("FEATURE: with the shared-v1 UID and fields", expected,
            BirthdayCalendar.eventFields(String(events.single().content, Charsets.UTF_8)))
        assertEquals("FEATURE: written in one transaction whose only dependency is the calendar root",
            listOf(listOf(calendar.uid)), fake.uploadDeps.drop(since))
        assertEquals("FEATURE: into the calendar, as a transaction",
            listOf("POST collection/${calendar.uid}/item/transaction/"), uploadLines(requestsBefore))
        assertEquals(BirthdayReconciler.RunStatus.DONE, result.status)
        assertEquals(listOf(calendar.uid), result.written)
        assertTrue("the contact itself is untouched", fake.itemUids(book.uid) == setOf(contact.uid))
    }

    @Test fun aCompleteEmptySourceTombstonesOnlyGeneratedEventsWithAFencedWrite() {
        val calendar = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE))
        // Seeded directly through the SDK: a generated event whose contact is gone, and an ordinary one.
        val generated = uploadItem(calendar, GENERATED_UID, GENERATED_ICS)
        val ordinary = uploadItem(calendar, "ordinary-dentist", ORDINARY_ICS)
        val since = fake.uploadDeps.size

        val result = BirthdayReconciler.reconcile(server, username)

        val itemMgr = freshItemManager(calendar.uid)
        assertTrue("FEATURE: the generated event of a contact that no longer exists is tombstoned",
            itemMgr.fetch(generated.uid).isDeleted)
        assertFalse("the ordinary event is not deleted", itemMgr.fetch(ordinary.uid).isDeleted)
        assertEquals("the ordinary event is unchanged", ORDINARY_ICS, String(itemMgr.fetch(ordinary.uid).content, Charsets.UTF_8))
        assertEquals("FEATURE: the cleanup is one transaction fenced on the calendar root",
            listOf(listOf(calendar.uid)), fake.uploadDeps.drop(since))
        assertEquals(BirthdayReconciler.RunStatus.DONE, result.status)
    }

    /**
     * The address book's item listing never finishes (every page "not done" with the same cursor):
     * the source is incomplete, which is never evidence that a contact is gone. The preservation
     * assertions are CONTROLS (a no-op passes them); the last one is FEATURE: the run must actually
     * have read the source, so the preservation is not vacuous.
     */
    @Test fun aFailedSourceListingLeavesEveryDestinationEventAsItWas() {
        val calendar = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE))
        val generated = uploadItem(calendar, GENERATED_UID, GENERATED_ICS)
        val ordinary = uploadItem(calendar, "ordinary-dentist", ORDINARY_ICS)
        val book = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Contacts", ""))
        uploadItem(book, "contact-ada", ADA_VCARD)
        fake.stallItemList(book.uid, FakeEtebaseServer.Stall.SAME_CURSOR)
        val since = fake.uploadDeps.size
        val requestsBefore = fake.requests.size

        val result = BirthdayReconciler.reconcile(server, username)

        val itemMgr = freshItemManager(calendar.uid)
        assertFalse("the generated event is kept", itemMgr.fetch(generated.uid).isDeleted)
        assertEquals("unchanged", GENERATED_ICS, String(itemMgr.fetch(generated.uid).content, Charsets.UTF_8))
        assertFalse("the ordinary event is kept", itemMgr.fetch(ordinary.uid).isDeleted)
        assertEquals("unchanged", ORDINARY_ICS, String(itemMgr.fetch(ordinary.uid).content, Charsets.UTF_8))
        assertEquals("the calendar holds exactly what was seeded", setOf(generated.uid, ordinary.uid), fake.itemUids(calendar.uid))
        assertEquals("nothing is uploaded", emptyList<List<String>>(), fake.uploadDeps.drop(since))
        assertTrue("nothing is reported written", result.written.isEmpty())
        assertTrue("FEATURE: the run read the address book's listing (and found it incomplete)",
            fake.requests.drop(requestsBefore).any { it.startsWith("GET collection/${book.uid}/item/") })
    }

    /**
     * C2: address books shared with this user are sources at every access level (Admin, ReadWrite,
     * ReadOnly), into the same private active calendar (C3). Each book also has another member, so
     * none is private; the source needs no member listing (a read-only member cannot list members on
     * the real server). The contacts are uploaded while the books are still writable, then access is
     * lowered, and fresh SDK reads confirm the current roles before the run.
     */
    @Test fun everyListedAddressBookAtAnyAccessLevelIsASourceForThePrivateActiveCalendar() {
        val calendar = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE))
        val adminBook = uploadCollection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Shared with me (admin)", "")
        val readWriteBook = uploadCollection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Shared with me (read-write)", "")
        val readOnlyBook = uploadCollection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Shared with me (read-only)", "")
        val ada = uploadItem(adminBook, "contact-ada", ADA_VCARD)
        val grace = uploadItem(readWriteBook, "contact-grace", GRACE_VCARD)
        val lee = uploadItem(readOnlyBook, "contact-lee", LEE_VCARD)
        fake.setMembers(adminBook.uid, listOf(OTHER_USERNAME to ADMIN, username to ADMIN))
        fake.setMembers(readWriteBook.uid, listOf(OTHER_USERNAME to ADMIN, username to READ_WRITE))
        fake.setMembers(readOnlyBook.uid, listOf(OTHER_USERNAME to ADMIN, username to READ_ONLY))
        fake.setAccessLevel(readWriteBook.uid, READ_WRITE)
        fake.setAccessLevel(readOnlyBook.uid, READ_ONLY)

        // Preconditions, read fresh through the SDK: the roles the run will see.
        val colMgr = server.collectionManager
        val roles = mapOf(adminBook.uid to CollectionAccessLevel.Admin, readWriteBook.uid to CollectionAccessLevel.ReadWrite,
            readOnlyBook.uid to CollectionAccessLevel.ReadOnly)
        val listed = colMgr.list(Constants.ETEBASE_TYPE_ADDRESS_BOOK)
        assertTrue("the address book listing is complete", listed.isDone)
        val listedRoles = listed.data.associate { it.uid to it.accessLevel }
        for ((uid, role) in roles) {
            assertEquals("listed role of $uid", role, listedRoles[uid])
            assertEquals("fetched role of $uid", role, colMgr.fetch(uid).accessLevel)
        }
        val sources = mapOf(adminBook.uid to setOf(ada.uid), readWriteBook.uid to setOf(grace.uid), readOnlyBook.uid to setOf(lee.uid))
        val collections = fake.collectionUids()
        val since = fake.uploadDeps.size
        val requestsBefore = fake.requests.size

        val result = BirthdayReconciler.reconcile(server, username)

        val events = liveItems(calendar.uid)
        assertEquals("FEATURE: one event per contact, from books shared at every access level", 3, events.size)
        val expected = setOf(
            BirthdayCalendar.BirthdayEvent(BirthdayCalendar.eventUid(adminBook.uid, ada.uid), "Ada Lovelace", 12, 10),
            BirthdayCalendar.BirthdayEvent(BirthdayCalendar.eventUid(readWriteBook.uid, grace.uid), "Grace Hopper", 12, 9),
            BirthdayCalendar.BirthdayEvent(BirthdayCalendar.eventUid(readOnlyBook.uid, lee.uid), "Lee", 2, 29),
        ).map { BirthdayCalendar.fieldsOf(it) }.toSet()
        assertEquals("FEATURE: with the shared-v1 UIDs and fields", expected,
            events.map { BirthdayCalendar.eventFields(String(it.content, Charsets.UTF_8)) }.toSet())
        assertEquals("FEATURE: written in one transaction whose only dependency is the calendar root",
            listOf(listOf(calendar.uid)), fake.uploadDeps.drop(since))
        assertEquals("FEATURE: into the calendar only", listOf("POST collection/${calendar.uid}/item/transaction/"), uploadLines(requestsBefore))
        assertEquals(BirthdayReconciler.RunStatus.DONE, result.status)
        assertEquals(listOf(calendar.uid), result.written)
        for ((uid, items) in sources) assertEquals("the source book $uid is untouched", items, fake.itemUids(uid))
        assertEquals("no collection is created or removed", collections, fake.collectionUids())
    }

    /** CONTROL: an active Birthdays calendar that has another member is not written, and no copy is made. */
    @Test fun anActiveCalendarWithAnotherMemberGetsNoWrites() {
        val calendar = uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE)
        fake.setMembers(calendar.uid, listOf(username to ADMIN, OTHER_USERNAME to READ_WRITE))
        val book = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Contacts", ""))
        uploadItem(book, "contact-ada", ADA_VCARD)
        val collections = fake.collectionUids()
        val since = fake.uploadDeps.size

        val result = BirthdayReconciler.reconcile(server, username)

        assertEquals("the shared calendar gets no event", emptyList<Item>(), liveItems(calendar.uid))
        assertEquals("nothing is uploaded", emptyList<List<String>>(), fake.uploadDeps.drop(since))
        assertEquals("no calendar is created in its place", collections, fake.collectionUids())
        assertTrue("nothing is reported written", result.written.isEmpty())
    }

    /** CONTROL: a calendar merely named "Birthdays" carries no marker and is never adopted. */
    @Test fun anOrdinaryCalendarNamedBirthdaysIsNeverPromotedOrWritten() {
        val calendar = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", ""))
        val book = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Contacts", ""))
        uploadItem(book, "contact-ada", ADA_VCARD)
        val collections = fake.collectionUids()
        val since = fake.uploadDeps.size

        val result = BirthdayReconciler.reconcile(server, username)

        assertEquals("no event is generated", emptyList<Item>(), liveItems(calendar.uid))
        assertEquals("its content is still not a marker", 0, server.collectionManager.fetch(calendar.uid).content.size)
        assertEquals("nothing is uploaded", emptyList<List<String>>(), fake.uploadDeps.drop(since))
        assertEquals("no Birthdays calendar is created", collections, fake.collectionUids())
        assertTrue("nothing is reported written", result.written.isEmpty())
    }

    // ---- fixture ----

    private fun uploadCollection(type: String, name: String, content: String): Collection {
        val colMgr = server.collectionManager
        val collection = colMgr.create(type, ItemMetadata().apply { this.name = name }, content)
        colMgr.upload(collection)
        return collection
    }

    /** The collection's complete member list is exactly this SDK user, at Admin level. */
    private fun soleOwned(collection: Collection): Collection {
        fake.setMembers(collection.uid, listOf(username to ADMIN))
        return collection
    }

    private fun uploadItem(collection: Collection, name: String, content: String): Item {
        val itemMgr = server.collectionManager.getItemManager(collection)
        val item = itemMgr.create(ItemMetadata().apply {
            this.name = name
            mtime = 1_000L
        }, content)
        itemMgr.batch(arrayOf(item))
        return item
    }

    private fun freshItemManager(collectionUid: String) = server.collectionManager.let { it.getItemManager(it.fetch(collectionUid)) }

    /** A fresh, complete listing of the collection's items that are not deleted. */
    private fun liveItems(collectionUid: String): List<Item> {
        val listed = freshItemManager(collectionUid).list()
        assertTrue("the listing is complete", listed.isDone)
        return listed.data.filter { !it.isDeleted }
    }

    /** The upload request lines since [since], without their query. */
    private fun uploadLines(since: Int) = fake.requests.drop(since).filter { UPLOAD.matches(it) }.map { it.substringBefore('?') }

    companion object {
        private val UPLOAD = Regex("POST collection/[^/]+/item/(transaction|batch)/.*")

        /** The server's access levels as the fake stores them: 0 read-only, 1 admin, 2 read-write. */
        private const val READ_ONLY = 0L
        private const val ADMIN = 1L
        private const val READ_WRITE = 2L
        private const val OTHER_USERNAME = "birthday-reconcile-other-member"

        /** The shared-v1 marker bytes (`contracts/birthday-calendar/v1-vectors.json`, marker vector 1). */
        private const val MARKER_ACTIVE = "{\"type\":\"silentsuite.birthdays\",\"v\":1,\"state\":\"active\"}"

        private const val ADA_VCARD = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c-ada\r\nFN:Ada Lovelace\r\nBDAY:1815-12-10\r\nEND:VCARD\r\n"
        private const val GRACE_VCARD = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c-grace\r\nFN:Grace Hopper\r\nBDAY:1906-12-09\r\nEND:VCARD\r\n"
        private const val LEE_VCARD = "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:c-lee\r\nFN:Lee\r\nBDAY:--02-29\r\nEND:VCARD\r\n"

        /** Events vector 1's canonical text: a generated event whose source contact does not exist here. */
        private const val GENERATED_UID = "ss-bday1-c8970a5b3457981540f4ee428f84a1f4"
        private const val GENERATED_ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SilentSuite//Birthdays v1//EN\r\n" +
            "BEGIN:VEVENT\r\nUID:ss-bday1-c8970a5b3457981540f4ee428f84a1f4\r\nDTSTAMP:19720101T000000Z\r\n" +
            "DTSTART;VALUE=DATE:19720315\r\nDTEND;VALUE=DATE:19720316\r\nRRULE:FREQ=YEARLY\r\n" +
            "SUMMARY:🎂 Alex Example\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

        private const val ORDINARY_ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other client//EN\r\n" +
            "BEGIN:VEVENT\r\nUID:ordinary-dentist\r\nDTSTAMP:20261031T120000Z\r\n" +
            "DTSTART:20261105T090000Z\r\nDTEND:20261105T100000Z\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

        private val username = "birthday-reconcile-${System.nanoTime()}"

        /** One Etebase signup for the whole class; the session works against any stand-in server. */
        private val session: String by lazy {
            val fake = FakeEtebaseServer()
            val client = Client.create(OkHttpClient.Builder().addInterceptor(fake).build(), fake.baseUrl)
            com.etebase.client.Account.signup(client, User(username, "birthday-reconcile@example.invalid"), "stand-in-server-only").save(null)
        }
    }
}
