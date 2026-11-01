package io.silentsuite.sync.birthdays

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.etebase.client.Client
import com.etebase.client.Collection
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.Item
import com.etebase.client.ItemMetadata
import com.etebase.client.User
import com.etebase.client.exceptions.ConflictException
import io.silentsuite.sync.Constants
import io.silentsuite.sync.notes.FakeEtebaseServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
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

    /**
     * Added after the first reconcile pass (an update regression, not part of the original tracer):
     * a generated event that already has the contact's stable UID but stale content, seeded directly
     * through the SDK, is rewritten in place to the current shared-v1 fields: the same storage item,
     * no delete and recreate, no second copy, in one transaction fenced on the calendar root.
     */
    @Test fun aStaleGeneratedEventIsUpdatedInPlaceToTheContactsCurrentBirthday() {
        val calendar = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE))
        val book = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Contacts", ""))
        val contact = uploadItem(book, "contact-ada", ADA_VCARD)
        val uid = BirthdayCalendar.eventUid(book.uid, contact.uid)
        val stale = uploadItem(calendar, uid, BirthdayCalendar.eventIcs(BirthdayCalendar.BirthdayEvent(uid, "Ada Byron", 1, 1)))
        val expected = BirthdayCalendar.fieldsOf(BirthdayCalendar.BirthdayEvent(uid, "Ada Lovelace", 12, 10))
        assertFalse("the seeded event is stale", expected == BirthdayCalendar.eventFields(
            String(freshItemManager(calendar.uid).fetch(stale.uid).content, Charsets.UTF_8)))
        val since = fake.uploadDeps.size
        val requestsBefore = fake.requests.size

        val result = BirthdayReconciler.reconcile(server, username)

        val events = liveItems(calendar.uid)
        assertEquals("no second copy is made", 1, events.size)
        assertEquals("the same storage item is kept, not deleted and recreated", stale.uid, events.single().uid)
        assertEquals("FEATURE_UPDATE: the event now has the contact's current shared-v1 fields", expected,
            BirthdayCalendar.eventFields(String(events.single().content, Charsets.UTF_8)))
        assertEquals("FEATURE_UPDATE: in one transaction whose only dependency is the calendar root",
            listOf(listOf(calendar.uid)), fake.uploadDeps.drop(since))
        assertEquals("FEATURE_UPDATE: into the calendar only", listOf("POST collection/${calendar.uid}/item/transaction/"),
            uploadLines(requestsBefore))
        assertEquals(BirthdayReconciler.RunStatus.DONE, result.status)
        assertEquals(listOf(calendar.uid), result.written)
        assertEquals("the contact itself is untouched", setOf(contact.uid), fake.itemUids(book.uid))
    }

    /**
     * Lifecycle regression (plan2 §2 step 5, kept by plan3): two stored generated copies of the same
     * wanted event UID collapse to the copy with the smallest storage uid, as core and Bridge keep
     * it, with the contact's current fields; the other copy is tombstoned; the ordinary event is
     * unchanged; all in one transaction fenced on the calendar root. Seeded directly through the SDK.
     */
    @Test fun duplicateGeneratedCopiesOfOneEventCollapseToTheSmallestStorageItem() {
        val calendar = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE))
        val book = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Contacts", ""))
        val contact = uploadItem(book, "contact-ada", ADA_VCARD)
        val uid = BirthdayCalendar.eventUid(book.uid, contact.uid)
        val expected = BirthdayCalendar.fieldsOf(BirthdayCalendar.BirthdayEvent(uid, "Ada Lovelace", 12, 10))
        // Two copies under the same event UID: the one with the smaller storage uid is stale, the other current.
        val itemMgr = server.collectionManager.getItemManager(calendar)
        val copies = List(2) { itemMgr.create(ItemMetadata().apply { name = uid; mtime = 1_000L }, "") }.sortedBy { it.uid }
        val (kept, redundant) = copies[0] to copies[1]
        kept.setContent(BirthdayCalendar.eventIcs(BirthdayCalendar.BirthdayEvent(uid, "Ada Byron", 1, 1)).toByteArray(Charsets.UTF_8))
        redundant.setContent(BirthdayCalendar.eventIcs(BirthdayCalendar.BirthdayEvent(uid, "Ada Lovelace", 12, 10)).toByteArray(Charsets.UTF_8))
        itemMgr.batch(arrayOf(kept, redundant))
        val ordinary = uploadItem(calendar, "ordinary-dentist", ORDINARY_ICS)
        assertEquals("both copies are stored", setOf(kept.uid, redundant.uid, ordinary.uid), fake.itemUids(calendar.uid))
        val since = fake.uploadDeps.size
        val requestsBefore = fake.requests.size

        val result = BirthdayReconciler.reconcile(server, username)

        val live = generatedLive(calendar.uid)
        assertEquals("FEATURE_DUPLICATE: exactly one generated copy of the event remains", 1, live.size)
        assertEquals("FEATURE_DUPLICATE: the copy with the smallest storage uid is kept", kept.uid, live.single().uid)
        assertEquals("FEATURE_DUPLICATE: with the contact's current fields", expected,
            BirthdayCalendar.eventFields(String(live.single().content, Charsets.UTF_8)))
        val fresh = freshItemManager(calendar.uid)
        assertTrue("FEATURE_DUPLICATE: the redundant copy is tombstoned", fresh.fetch(redundant.uid).isDeleted)
        assertFalse("the ordinary event is not deleted", fresh.fetch(ordinary.uid).isDeleted)
        assertEquals("the ordinary event is unchanged", ORDINARY_ICS, String(fresh.fetch(ordinary.uid).content, Charsets.UTF_8))
        assertEquals("FEATURE_DUPLICATE: one transaction fenced on the calendar root",
            listOf("POST collection/${calendar.uid}/item/transaction/" to listOf(calendar.uid)), uploads(requestsBefore, since))
        assertEquals(BirthdayReconciler.RunStatus.DONE, result.status)
        assertEquals(listOf(calendar.uid), result.written)
        assertEquals("the contact itself is untouched", setOf(contact.uid), fake.itemUids(book.uid))
    }

    /**
     * Lifecycle regression (plan3 F4 then F2): of two currently qualifying active calendars, the one
     * with the smallest uid stays active and is filled; the other is retired with a conditional
     * calendar update first, and only then loses its generated items, fenced on its new root. User
     * events in both survive byte-for-byte and neither calendar is deleted. Seeded through the SDK.
     */
    @Test fun aSecondActiveCalendarIsRetiredBeforeItsGeneratedEventsAreCleanedUp() {
        val (canonical, duplicate) = listOf(
            soleOwned(uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE)),
            soleOwned(uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE)),
        ).sortedBy { it.uid }.let { it[0] to it[1] }
        val book = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Contacts", ""))
        val contact = uploadItem(book, "contact-ada", ADA_VCARD)
        val uid = BirthdayCalendar.eventUid(book.uid, contact.uid)
        val expected = BirthdayCalendar.fieldsOf(BirthdayCalendar.BirthdayEvent(uid, "Ada Lovelace", 12, 10))
        val leftover = uploadItem(duplicate, uid, BirthdayCalendar.eventIcs(BirthdayCalendar.BirthdayEvent(uid, "Ada Lovelace", 12, 10)))
        val duplicateOrdinary = uploadItem(duplicate, "ordinary-dentist", ORDINARY_ICS)
        val canonicalOrdinary = uploadItem(canonical, "ordinary-dentist", ORDINARY_ICS)
        val collections = fake.collectionUids()
        val since = fake.uploadDeps.size
        val requestsBefore = fake.requests.size

        val result = BirthdayReconciler.reconcile(server, username)

        val colMgr = server.collectionManager
        assertEquals("FEATURE_RETIRE: the calendar with the larger uid is retired", MARKER_RETIRED,
            String(colMgr.fetch(duplicate.uid).content, Charsets.UTF_8))
        assertEquals("the calendar with the smallest uid stays active", MARKER_ACTIVE, String(colMgr.fetch(canonical.uid).content, Charsets.UTF_8))
        val duplicateItems = freshItemManager(duplicate.uid)
        assertTrue("FEATURE_RETIRE: the retired calendar's generated event is tombstoned", duplicateItems.fetch(leftover.uid).isDeleted)
        assertFalse("its ordinary event is not deleted", duplicateItems.fetch(duplicateOrdinary.uid).isDeleted)
        assertEquals("its ordinary event is unchanged", ORDINARY_ICS, String(duplicateItems.fetch(duplicateOrdinary.uid).content, Charsets.UTF_8))
        val filled = generatedLive(canonical.uid)
        assertEquals("FEATURE_RETIRE: the canonical calendar is filled", listOf(expected),
            filled.map { BirthdayCalendar.eventFields(String(it.content, Charsets.UTF_8)) })
        val canonicalItems = freshItemManager(canonical.uid)
        assertFalse("the canonical ordinary event is not deleted", canonicalItems.fetch(canonicalOrdinary.uid).isDeleted)
        assertEquals("the canonical ordinary event is unchanged", ORDINARY_ICS,
            String(canonicalItems.fetch(canonicalOrdinary.uid).content, Charsets.UTF_8))
        val all = uploads(requestsBefore, since)
        assertEquals("FEATURE_RETIRE: the retired calendar gets its conditional update first, then a cleanup fenced on its new root",
            listOf(emptyList(), listOf(duplicate.uid)),
            all.filter { it.first == "POST collection/${duplicate.uid}/item/transaction/" }.map { it.second })
        assertEquals("FEATURE_RETIRE: the canonical calendar's write is fenced on its own root", listOf(listOf(canonical.uid)),
            all.filter { it.first == "POST collection/${canonical.uid}/item/transaction/" }.map { it.second })
        assertEquals("no other upload", all.size, all.count { it.first.endsWith("/item/transaction/") &&
            (it.first.contains(duplicate.uid) || it.first.contains(canonical.uid)) })
        assertFalse("no calendar is deleted", colMgr.fetch(duplicate.uid).isDeleted || colMgr.fetch(canonical.uid).isDeleted)
        assertEquals("no collection is created or removed", collections, fake.collectionUids())
        assertEquals(setOf(canonical.uid, duplicate.uid), result.written.toSet())
        assertEquals(BirthdayReconciler.RunStatus.DONE, result.status)
        assertEquals("the contact itself is untouched", setOf(contact.uid), fake.itemUids(book.uid))
    }

    /**
     * Lifecycle regression (plan3 F3, interrupted retirement): with no active calendar, generated
     * leftovers in every retired calendar the user can write to are deleted, each fenced on that
     * calendar's current root; one is Admin and private, the other ReadWrite and shared, so a repair
     * limited to C3's Admin-and-sole-member destination rule cannot pass. User events and the
     * calendars stay, markers stay retired, and no active calendar is created or adopted.
     */
    @Test fun generatedLeftoversInRetiredCalendarsAreCleanedWithoutAnActiveCalendar() {
        val privateRetired = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays (old)", MARKER_RETIRED))
        val sharedRetired = uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays (old, shared)", MARKER_RETIRED)
        val privateLeftover = uploadItem(privateRetired, GENERATED_UID, GENERATED_ICS)
        val privateOrdinary = uploadItem(privateRetired, "ordinary-dentist", ORDINARY_ICS)
        val sharedLeftover = uploadItem(sharedRetired, OTHER_GENERATED_UID,
            BirthdayCalendar.eventIcs(BirthdayCalendar.BirthdayEvent(OTHER_GENERATED_UID, "Lee", 2, 29)))
        val sharedOrdinary = uploadItem(sharedRetired, "ordinary-dentist", ORDINARY_ICS)
        fake.setMembers(sharedRetired.uid, listOf(OTHER_USERNAME to ADMIN, username to READ_WRITE))
        fake.setAccessLevel(sharedRetired.uid, READ_WRITE)
        assertEquals("the shared retired calendar is ReadWrite for this user", CollectionAccessLevel.ReadWrite,
            server.collectionManager.fetch(sharedRetired.uid).accessLevel)
        val book = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_ADDRESS_BOOK, "Contacts", ""))
        val contact = uploadItem(book, "contact-ada", ADA_VCARD)
        val collections = fake.collectionUids()
        val since = fake.uploadDeps.size
        val requestsBefore = fake.requests.size

        val result = BirthdayReconciler.reconcile(server, username)

        val privateItems = freshItemManager(privateRetired.uid)
        val sharedItems = freshItemManager(sharedRetired.uid)
        assertTrue("FEATURE_REPAIR: the private retired calendar's generated leftover is tombstoned", privateItems.fetch(privateLeftover.uid).isDeleted)
        assertTrue("FEATURE_REPAIR: the shared ReadWrite retired calendar's generated leftover is tombstoned", sharedItems.fetch(sharedLeftover.uid).isDeleted)
        for ((items, ordinary) in listOf(privateItems to privateOrdinary, sharedItems to sharedOrdinary)) {
            assertFalse("an ordinary event is not deleted", items.fetch(ordinary.uid).isDeleted)
            assertEquals("an ordinary event is unchanged", ORDINARY_ICS, String(items.fetch(ordinary.uid).content, Charsets.UTF_8))
        }
        val colMgr = server.collectionManager
        for (calendar in listOf(privateRetired, sharedRetired)) {
            assertEquals("the marker stays retired", MARKER_RETIRED, String(colMgr.fetch(calendar.uid).content, Charsets.UTF_8))
            assertFalse("the calendar is not deleted", colMgr.fetch(calendar.uid).isDeleted)
            assertEquals("no event is generated into a retired calendar", emptyList<Item>(), generatedLive(calendar.uid))
        }
        assertEquals("FEATURE_REPAIR: each cleanup is fenced on its own calendar's current root",
            setOf("POST collection/${privateRetired.uid}/item/transaction/" to listOf(privateRetired.uid),
                "POST collection/${sharedRetired.uid}/item/transaction/" to listOf(sharedRetired.uid)),
            uploads(requestsBefore, since).toSet())
        assertEquals("no other upload", 2, uploads(requestsBefore, since).size)
        assertEquals("no active calendar is created or adopted", collections, fake.collectionUids())
        assertEquals(setOf(privateRetired.uid, sharedRetired.uid), result.written.toSet())
        assertEquals("the contact itself is untouched", setOf(contact.uid), fake.itemUids(book.uid))
    }

    /**
     * CONTROL (pinned SDK and stand-in, no reconcile): a calendar update sent with
     * `CollectionManager.transaction` is conditional on the calendar's root. Two copies are fetched;
     * the first retires the calendar, which moves the root revision; the second, still naming the old
     * revision, is rejected with a conflict and changes nothing. Both reach the server as transactions
     * of the root item itself, with no dependencies.
     */
    @Test fun aCalendarUpdateFromAStaleCopyIsRejectedByTheSdkTransaction() {
        val colMgr = server.collectionManager
        val calendar = soleOwned(uploadCollection(Constants.ETEBASE_TYPE_CALENDAR, "Birthdays", MARKER_ACTIVE))
        val ordinary = uploadItem(calendar, "ordinary-dentist", ORDINARY_ICS)
        val first = colMgr.fetch(calendar.uid)
        val second = colMgr.fetch(calendar.uid)
        assertEquals("both copies name the same root revision", first.etag, second.etag)
        val transaction = "POST collection/${calendar.uid}/item/transaction/"

        var requestsBefore = fake.requests.size
        var since = fake.uploadDeps.size
        first.setContent(MARKER_RETIRED)
        colMgr.transaction(first)
        assertEquals("the update is a transaction of the root item, with no dependencies",
            listOf(transaction to emptyList<String>()), uploads(requestsBefore, since))
        val retired = colMgr.fetch(calendar.uid)
        assertEquals("the update landed", MARKER_RETIRED, String(retired.content, Charsets.UTF_8))
        assertFalse("the root revision moved", retired.etag == second.etag)

        requestsBefore = fake.requests.size
        since = fake.uploadDeps.size
        second.setContent(MARKER_ACTIVE)
        try {
            colMgr.transaction(second)
            fail("an update from a copy that names the old root revision was accepted")
        } catch (expected: ConflictException) {
        }
        assertEquals("the stale update reached the server as a transaction of the root item",
            listOf(transaction to emptyList<String>()), uploads(requestsBefore, since))
        val after = colMgr.fetch(calendar.uid)
        assertEquals("the rejected update changed nothing", MARKER_RETIRED, String(after.content, Charsets.UTF_8))
        assertEquals("the root revision did not move", retired.etag, after.etag)
        assertEquals("the ordinary event is still the only item", setOf(ordinary.uid), fake.itemUids(calendar.uid))
        assertEquals("and unchanged", ORDINARY_ICS, String(freshItemManager(calendar.uid).fetch(ordinary.uid).content, Charsets.UTF_8))
    }

    // ---- fixture ----

    /** The fresh, complete listing's live items whose parsed event UID has the generated form. */
    private fun generatedLive(collectionUid: String): List<Item> = liveItems(collectionUid).filter {
        BirthdayCalendar.eventFields(String(it.content, Charsets.UTF_8))?.uid?.let { uid -> GENERATED_FORM.matches(uid) } == true
    }

    /** Each upload since the marks, as (request line without query, dependency uids), in order. */
    private fun uploads(requestsSince: Int, depsSince: Int): List<Pair<String, List<String>>> {
        val lines = uploadLines(requestsSince)
        val deps = fake.uploadDeps.drop(depsSince)
        assertEquals("every upload line has its recorded dependencies", lines.size, deps.size)
        return lines.zip(deps)
    }

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
        private const val MARKER_RETIRED = "{\"type\":\"silentsuite.birthdays\",\"v\":1,\"state\":\"retired\"}"
        private const val OTHER_GENERATED_UID = "ss-bday1-1615be37fbc2437021b9d4f73fdac5e2"
        private val GENERATED_FORM = Regex("ss-bday1-[0-9a-f]{32}")

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
