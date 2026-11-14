package io.silentsuite.sync.resource

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderClient
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.GroupMembership
import android.provider.ContactsContract.CommonDataKinds.Note
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.StructuredPostal
import android.provider.ContactsContract.Data
import android.provider.ContactsContract.Groups
import android.provider.ContactsContract.RawContacts
import at.bitfire.vcard4android.BatchOperation
import at.bitfire.vcard4android.CachedGroupMembership
import at.bitfire.vcard4android.Contact
import at.bitfire.vcard4android.ContactsStorageException
import io.silentsuite.sync.App
import java.io.StringReader

/**
 * #934 permanent provider-boundary regression for whole-contact labels (vCard CATEGORIES). It replaces the
 * earlier diagnostic matrix in place; the host call `ContactLabelReproduction.runMatrix(context)` in
 * LocalContactUnknownPropertiesRuntimeTest#nativeParseAndWriteKeepCustomProperties is unchanged.
 *
 * Drives the real production write paths ([Contact.fromReader], [LocalContact.add], [LocalContact.update],
 * [LocalContact.createAsDirty]), fresh provider-backed reads and the upload body [LocalContact.content].
 * Label groups are identified only as this account's groups without a filename (SOURCE_ID); the certification
 * marker (RawContacts.SYNC4) is compared with the value a successful add wrote, never with a literal.
 *
 * Desired-behavior failures are collected per case as "BEHAVIOR #934" assertion errors so every case runs and
 * all are reported together. Setup, transport and split-reachability problems throw "FIXTURE #934" and are never
 * collected. Every case uses its own synthetic address-book account (registered before any provider write, sync
 * off, no owning main account) whose rows, groups and registration are removed and verified afterwards.
 */
internal object ContactLabelReproduction {

    private class Checks(val case: String) {
        val failures = mutableListOf<AssertionError>()
        fun check(ok: Boolean, what: () -> String) {
            if (!ok) failures += AssertionError("BEHAVIOR #934 $case: ${what()}")
        }
        fun <T> expect(expected: T, actual: T, what: String) =
            check(expected == actual) { "$what: expected <$expected> but was <$actual>" }
        /** Records a failure after which this case cannot meaningfully continue. */
        fun stop(what: String): Nothing {
            failures += AssertionError("BEHAVIOR #934 $case: $what")
            throw CaseStopped()
        }
    }

    private class CaseStopped : RuntimeException()

    private fun fixture(ok: Boolean, what: () -> String) {
        if (!ok) throw IllegalStateException("FIXTURE #934: ${what()}")
    }

    /** The marker value of the first successful add of this run; null until one is observed. */
    private var reference: String? = null

    fun runMatrix(context: Context) {
        reference = null
        val provider = context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY)
            ?: throw IllegalStateException("FIXTURE #934: contacts provider unavailable")
        val failures = mutableListOf<AssertionError>()
        try {
            for ((name, body) in cases()) {
                val checks = Checks(name)
                try {
                    withAccount(context, provider, name) { ab -> body(ab, checks) }
                } catch (stopped: CaseStopped) {
                    // recorded in checks
                } catch (e: AssertionError) {
                    checks.failures += AssertionError("BEHAVIOR #934 $name: ${e.message}", e)
                } catch (t: Throwable) {
                    (failures + checks.failures).forEach { t.addSuppressed(it) }
                    throw t
                }
                failures += checks.failures
            }
        } finally {
            provider.close()
        }
        if (failures.isNotEmpty()) {
            val all = AssertionError("BEHAVIOR #934: ${failures.size} failure(s): " +
                failures.joinToString(" | ") { it.message.orEmpty() })
            failures.forEach { all.addSuppressed(it) }
            throw all
        }
    }

    private fun valueCase(lines: List<String>, expected: List<String>): (LocalAddressBook, Checks) -> Unit =
        { ab: LocalAddressBook, c: Checks -> values(ab, c, lines, expected) }

    private fun cases(): List<Pair<String, (LocalAddressBook, Checks) -> Unit>> = listOf(
        "P1-single" to valueCase(listOf("CATEGORIES:Family"), listOf("Family")),
        "P1-multiple" to valueCase(listOf("CATEGORIES:Family,Work"), listOf("Family", "Work")),
        "P1-unicode" to valueCase(listOf("CATEGORIES:$AMIS_ETE"), listOf(AMIS_ETE)),
        "P1-literal-comma" to valueCase(listOf("CATEGORIES:Team\\, West"), listOf("Team, West")),
        "P1-repeated-property" to valueCase(listOf("CATEGORIES:Family", "CATEGORIES:Work"), listOf("Family", "Work")),
        "P1-duplicate-value" to valueCase(listOf("CATEGORIES:Family,Family"), listOf("Family")),
        "P2-mixed-fields" to this::mixedFields,
        "P3-replace-remove" to this::replaceAndRemove,
        "P4-idempotent" to this::idempotent,
        "P5-account-isolation" to this::accountIsolation,
        "P6-group-vcard-coexistence" to this::groupVcardCoexistence,
        "P8-create-as-dirty" to this::createAsDirty,
        "P9-split-retry" to this::splitRetry,
        "P10-label-rename" to this::labelRename,
        "P11-label-delete" to this::labelDelete,
    )

    // ---- cases ----

    private fun values(ab: LocalAddressBook, c: Checks, lines: List<String>, expected: List<String>) {
        val card = card("p1", *lines.toTypedArray())
        fixture(parse(card).categories.distinct().sorted() == expected) { "parser control for $lines: ${parse(card).categories}" }
        val id = addCard(ab, "p1", card)
        certified(ab, id, c, "after add")
        c.expect(expected, unfiledTitles(ab, id), "one membership per label after add")
        c.expect(expected, unfiledGroups(ab).values.sorted(), "one label group per distinct label")
        c.expect(expected, ab.findContactByID(id).contact!!.categories.sorted(), "fresh provider read")
        c.expect(expected, uploadCategories(ab, id), "upload body labels")
        if (expected == listOf("Team, West"))
            c.check(Regex("(?m)^CATEGORIES:Team\\\\, West\\r?$").containsMatchIn(upload(ab, id))) {
                "the literal comma stays escaped in the upload body"
            }
    }

    private fun mixedFields(ab: LocalAddressBook, c: Checks) {
        val card = card("p2", "CATEGORIES:Family", "item1.TEL:+1 555 0120", "item1.X-ABLabel:Emergency",
            "EMAIL;TYPE=INTERNET,WORK:p2@example.invalid", "ADR;TYPE=X-Cabin:;;1 Test Way;Testville;;00000;Testland",
            "X-TESTA:keep")
        val id = addCard(ab, "p2", card)
        fun stage(name: String) {
            certified(ab, id, c, name)
            c.expect(listOf("Family"), unfiledTitles(ab, id), "$name labels")
            c.check((Phone.TYPE_CUSTOM to "Emergency") in typeLabels(ab, id, Phone.CONTENT_ITEM_TYPE)) { "$name phone label" }
            c.check((Email.TYPE_WORK to null) in typeLabels(ab, id, Email.CONTENT_ITEM_TYPE)) { "$name email type" }
            c.check((StructuredPostal.TYPE_CUSTOM to "Cabin") in typeLabels(ab, id, StructuredPostal.CONTENT_ITEM_TYPE)) { "$name address label" }
            c.check(ab.findContactByID(id).contact!!.unknownProperties?.contains("X-TESTA:keep") == true) { "$name unknown property row" }
            val body = upload(ab, id)
            c.expect(listOf("Family"), categoriesOf(body), "$name upload labels")
            c.check(body.contains("X-TESTA:keep")) { "$name upload keeps the unknown property" }
            c.check(Regex("(?im)^[^:\\r\\n]*X-ABLabel:Emergency\\r?$").containsMatchIn(body)) { "$name upload keeps the phone label" }
        }
        stage("after add")
        update(ab, id, card, "p2-etag-2")
        stage("after re-delivery")
        insertNoteAsContactsApp(ab, id, "p2 ordinary edit")
        c.check(rawInt(ab, id, RawContacts.DIRTY) == 1) { "a native note edit marks the row dirty" }
        stage("after native note edit")
        c.check(upload(ab, id).contains("p2 ordinary edit")) { "the native edit is in the upload body" }
    }

    private fun replaceAndRemove(ab: LocalAddressBook, c: Checks) {
        val id = addCard(ab, "p3", card("p3", "CATEGORIES:Family,Work"))
        c.expect(listOf("Family", "Work"), unfiledTitles(ab, id), "after add")
        update(ab, id, card("p3", "CATEGORIES:Work"), "p3-etag-2")
        certified(ab, id, c, "after replacement")
        c.expect(listOf("Work"), unfiledTitles(ab, id), "a removed remote label leaves the contact")
        c.expect(listOf("Work"), uploadCategories(ab, id), "upload after replacement")
        update(ab, id, card("p3"), "p3-etag-3")
        certified(ab, id, c, "after removal")
        c.expect(emptyList<String>(), unfiledTitles(ab, id), "no labels after all were removed")
        c.expect(emptyList<String>(), uploadCategories(ab, id), "upload after removal")
    }

    private fun idempotent(ab: LocalAddressBook, c: Checks) {
        val card = card("p4", "CATEGORIES:Family,Work")
        val id = addCard(ab, "p4", card)
        for (n in 2..4) update(ab, id, card, "p4-etag-$n")
        certified(ab, id, c, "after three re-deliveries")
        c.expect(listOf("Family", "Work"), unfiledGroups(ab).values.sorted(), "no duplicate label groups")
        c.expect(listOf("Family", "Work"), unfiledTitles(ab, id), "no duplicate memberships")
        c.expect(2, groupRowIds(ab, id).size, "membership rows")
    }

    private fun accountIsolation(ab: LocalAddressBook, c: Checks) {
        val context = ab.contextForTest
        val idA = addCard(ab, "p5-a", card("p5-a", "CATEGORIES:Family"))
        withAccount(context, ab.requireProvider(), "P5-other") { other ->
            c.expect(0, unfiledGroups(other).size, "adding in one account writes no group to another")
            val idB = addCard(other, "p5-b", card("p5-b", "CATEGORIES:Family"))
            val groupsA = unfiledGroups(ab)
            val groupsB = unfiledGroups(other)
            c.expect(listOf("Family"), groupsA.values.toList(), "first account groups")
            c.expect(listOf("Family"), groupsB.values.toList(), "second account groups")
            c.check(groupsA.keys.intersect(groupsB.keys).isEmpty()) { "each account has its own label group" }
            c.check(groupRowIds(ab, idA).all { it in groupsA.keys } && groupRowIds(ab, idA).isNotEmpty()) { "first contact uses its account's group" }
            c.check(groupRowIds(other, idB).all { it in groupsB.keys } && groupRowIds(other, idB).isNotEmpty()) { "second contact uses its account's group" }
        }
    }

    private fun groupVcardCoexistence(ab: LocalAddressBook, c: Checks) {
        val legacy = insertGroupVcardGroup(ab, "Family", "p6-legacy-file", "p6-legacy-uid")
        val id = addCard(ab, "p6", card("p6"))
        val batch = BatchOperation(ab.requireProvider())
        ab.findContactByID(id).addToGroup(batch, legacy)
        batch.commit()
        c.expect(emptyList<String>(), uploadCategories(ab, id), "a group-vCard membership is not serialized as a label")
        update(ab, id, card("p6", "CATEGORIES:Family"), "p6-etag-2")
        certified(ab, id, c, "after label download")
        c.check(legacy in groupRowIds(ab, id)) { "the group-vCard membership survives a label download" }
        c.expect(1, cachedMembershipRows(ab, id, legacy), "the group-vCard cached membership survives")
        c.expect(listOf("Family"), unfiledTitles(ab, id), "the label is a separate group")
        c.expect(listOf("Family"), uploadCategories(ab, id), "the label is uploaded exactly once")
        c.expect("p6-legacy-file", groupString(ab, legacy, Groups.SOURCE_ID), "the group vCard keeps its filename")
        c.expect(1, filedGroupCount(ab), "no label group gains a filename")
    }

    private fun createAsDirty(ab: LocalAddressBook, c: Checks) {
        val local = LocalContact(ab, parse(card("p8", "CATEGORIES:Family,Work")), "p8", null)
        local.createAsDirty()
        val id = local.id ?: throw IllegalStateException("FIXTURE #934: no raw id after createAsDirty")
        certified(ab, id, c, "after createAsDirty")
        c.expect(1, rawInt(ab, id, RawContacts.DIRTY), "an imported row is dirty")
        c.expect(listOf("Family", "Work"), unfiledTitles(ab, id), "imported labels")
        c.expect(listOf("Family", "Work"), uploadCategories(ab, id), "imported labels in the upload body")
    }

    private fun splitRetry(ab: LocalAddressBook, c: Checks) {
        val id = addCard(ab, "p9", card("p9", "CATEGORIES:Family"))
        certified(ab, id, c, "after add")
        val oversized = parse(card("p9", "CATEGORIES:Work")).apply {
            unknownProperties = "BEGIN:VCARD\r\nVERSION:4.0\r\nX-BIG:${"x".repeat(800_000)}\r\nEND:VCARD\r\n"
        }
        val failure = try {
            ab.findContactByID(id).also { it.eTag = "p9-etag-B" }.update(oversized)
            null
        } catch (e: Exception) {
            e
        }
        fixture(failure != null) { "the oversized update was accepted; the real split prefix is not reachable here" }
        val causes = generateSequence<Throwable>(failure) { it.cause }.toList()
        fixture(causes.any { it is ContactsStorageException && it.message?.contains("data row too large") == true }) {
            "the oversized update failed for another reason: ${causes.map { "${it.javaClass.name}: ${it.message}" }}"
        }
        fixture(rawString(ab, id, RawContacts.SYNC2) == "p9-etag-B") { "the split committed no prefix (raw row did not take revision B)" }
        c.check(rawString(ab, id, RawContacts.SYNC4) == null) { "a committed prefix leaves a previously certified row uncertified" }
        ab.findContactByID(id).also { it.eTag = "p9-etag-B" }.update(parse(card("p9", "CATEGORIES:Work")))
        certified(ab, id, c, "after retry")
        c.expect(listOf("Work"), unfiledTitles(ab, id), "labels after retry")
        c.expect(listOf("Work"), uploadCategories(ab, id), "upload after retry")
    }

    // ---- production-path helpers ----

    private const val AMIS_ETE = "Amis été"

    /** #936: a label group renamed in a contacts app reaches its members' uploads; other group edits upload nothing. */
    private fun labelRename(ab: LocalAddressBook, c: Checks) {
        val id = addCard(ab, "p10", card("p10", "CATEGORIES:Family"))
        val group = unfiledGroups(ab).entries.single { it.value == "Family" }.key
        fixture(rawInt(ab, id, RawContacts.DIRTY) == 0) { "the downloaded contact starts clean" }
        // The server's copy of the contact still lists the label under its old name.
        val hadLabel = { _: LocalContact, label: String -> label == "Family" }

        // Control: a visibility choice also marks the group dirty, but changes no label.
        fixture(ab.requireProvider().update(ContentUris.withAppendedId(Groups.CONTENT_URI, group),
            ContentValues().apply { put(Groups.GROUP_VISIBLE, 0) }, null, null) == 1) { "contacts-app visibility change" }
        c.expect(1, groupString(ab, group, Groups.DIRTY)?.toInt(), "provider marks a group dirty on a visibility change")
        c.expect(0, ab.propagateLabelGroupEdits(true, hadLabel), "a visibility change queues no upload")
        c.expect(0, rawInt(ab, id, RawContacts.DIRTY), "the member stays clean after a visibility change")
        c.expect(0, groupString(ab, group, Groups.DIRTY)?.toInt(), "the group is settled after a visibility change")

        fixture(ab.requireProvider().update(ContentUris.withAppendedId(Groups.CONTENT_URI, group),
            ContentValues().apply { put(Groups.TITLE, "Relatives") }, null, null) == 1) { "contacts-app rename" }
        // Provider behaviour the fix relies on (#936): only the group row is marked dirty, the member keeps its row.
        c.expect(1, groupString(ab, group, Groups.DIRTY)?.toInt(), "provider marks the renamed group dirty")
        c.expect(0, rawInt(ab, id, RawContacts.DIRTY), "provider leaves the member clean")
        c.expect(listOf("Relatives"), unfiledTitles(ab, id), "the member stays in the renamed group")

        c.expect(1, ab.propagateLabelGroupEdits(true, hadLabel), "contacts queued for upload")
        c.expect(1, rawInt(ab, id, RawContacts.DIRTY), "the member is queued for upload")
        c.expect(0, groupString(ab, group, Groups.DIRTY)?.toInt(), "the group is settled")
        c.expect(listOf("Relatives"), uploadCategories(ab, id), "the upload carries the new name")
        c.expect(0, ab.propagateLabelGroupEdits(true, hadLabel), "a second pass changes nothing")
    }

    /** #937: a label group deleted in a contacts app reaches its former members' uploads and its row is removed. */
    private fun labelDelete(ab: LocalAddressBook, c: Checks) {
        val member = addCard(ab, "p11a", card("p11a", "CATEGORIES:Family,Work"))
        val other = addCard(ab, "p11b", card("p11b", "CATEGORIES:Work"))
        val family = unfiledGroups(ab).entries.single { it.value == "Family" }.key

        fixture(ab.requireProvider().delete(ContentUris.withAppendedId(Groups.CONTENT_URI, family), null, null) == 1) {
            "contacts-app delete"
        }
        // Provider behaviour the fix relies on (#937): a deleted row stays behind and the memberships are gone,
        // without marking the former member dirty.
        c.expect(1, groupRows(ab, family), "provider keeps the deleted group row")
        c.expect("1", groupString(ab, family, Groups.DELETED), "provider marks the group row deleted")
        c.expect(listOf("Work"), unfiledTitles(ab, member), "provider removes the memberships")
        c.expect(0, rawInt(ab, member, RawContacts.DIRTY), "provider leaves the former member clean")

        val serverLabels = mapOf("p11a" to listOf("Family", "Work"), "p11b" to listOf("Work"))
        val hadLabel = { contact: LocalContact, label: String -> label in serverLabels[contact.fileName].orEmpty() }
        c.expect(1, ab.propagateLabelGroupEdits(true, hadLabel), "contacts queued for upload")
        c.expect(1, rawInt(ab, member, RawContacts.DIRTY), "the former member is queued for upload")
        c.expect(0, rawInt(ab, other, RawContacts.DIRTY), "a contact without the label is not")
        c.expect(listOf("Work"), uploadCategories(ab, member), "the upload no longer carries the label")
        c.expect(0, groupRows(ab, family), "the deleted group row is removed")
        c.expect(listOf("Work"), unfiledGroups(ab).values.sorted(), "other label groups stay")
        c.expect(0, ab.propagateLabelGroupEdits(true, hadLabel), "a second pass changes nothing")
    }

    private fun groupRows(ab: LocalAddressBook, groupId: Long): Int =
        ab.requireProvider().query(ab.syncAdapterURI(Groups.CONTENT_URI), arrayOf(Groups._ID), "${Groups._ID}=?",
            arrayOf(groupId.toString()), null)?.use { it.count } ?: throw IllegalStateException("FIXTURE #934: null groups cursor")

    private fun card(uid: String, vararg lines: String) =
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:clr934-$uid\r\nFN:Synthetic $uid\r\nN:$uid;Synthetic;;;\r\n" +
            lines.joinToString("") { "$it\r\n" } + "END:VCARD\r\n"

    private fun parse(card: String): Contact = Contact.fromReader(StringReader(card), null).single()

    private fun addCard(ab: LocalAddressBook, fileName: String, card: String): Long {
        val local = LocalContact(ab, parse(card), fileName, "$fileName-etag-1")
        local.add()
        return local.id ?: throw IllegalStateException("FIXTURE #934: no raw id after add")
    }

    /** As ContactsSyncManager.processContact applies a re-delivered item: the item's eTag, then update(newData). */
    private fun update(ab: LocalAddressBook, id: Long, card: String, eTag: String) {
        ab.findContactByID(id).also { it.eTag = eTag }.update(parse(card))
    }

    private fun upload(ab: LocalAddressBook, id: Long): String = ab.findContactByID(id).content

    private fun categoriesOf(body: String): List<String> =
        Contact.fromReader(StringReader(body), null).firstOrNull()?.categories?.sorted() ?: emptyList()

    private fun uploadCategories(ab: LocalAddressBook, id: Long) = categoriesOf(upload(ab, id))

    private fun certified(ab: LocalAddressBook, id: Long, c: Checks, what: String) {
        val value = rawString(ab, id, RawContacts.SYNC4)
        if (value == null) {
            c.check(false) { "$what: the row is not certified" }
            return
        }
        val ref = reference
        if (ref == null) reference = value
        else c.check(value == ref) { "$what: certification marker <$value> differs from the add path's <$ref>" }
    }

    // ---- provider queries (all scoped to the address book's account) ----

    private fun accountSelection(column: String = Groups.ACCOUNT_NAME, typeColumn: String = Groups.ACCOUNT_TYPE) =
        "$column=? AND $typeColumn=?"

    private fun accountArgs(ab: LocalAddressBook) = arrayOf(ab.account.name, ab.account.type)

    private fun unfiledGroups(ab: LocalAddressBook): Map<Long, String> {
        val out = LinkedHashMap<Long, String>()
        ab.requireProvider().query(ab.syncAdapterURI(Groups.CONTENT_URI), arrayOf(Groups._ID, Groups.TITLE),
            "${accountSelection()} AND ${Groups.SOURCE_ID} IS NULL AND ${Groups.DELETED}=0", accountArgs(ab), null)
            ?.use { cursor -> while (cursor.moveToNext()) out[cursor.getLong(0)] = cursor.getString(1).orEmpty() }
            ?: throw IllegalStateException("FIXTURE #934: null groups cursor")
        return out
    }

    private fun filedGroupCount(ab: LocalAddressBook): Int =
        ab.requireProvider().query(ab.syncAdapterURI(Groups.CONTENT_URI), arrayOf(Groups._ID),
            "${accountSelection()} AND ${Groups.SOURCE_ID} IS NOT NULL AND ${Groups.DELETED}=0", accountArgs(ab), null)
            ?.use { it.count } ?: throw IllegalStateException("FIXTURE #934: null groups cursor")

    private fun groupRowIds(ab: LocalAddressBook, id: Long): List<Long> = dataLongs(ab, id, GroupMembership.CONTENT_ITEM_TYPE)

    private fun cachedMembershipRows(ab: LocalAddressBook, id: Long, groupId: Long): Int =
        dataLongs(ab, id, CachedGroupMembership.CONTENT_ITEM_TYPE).count { it == groupId }

    private fun dataLongs(ab: LocalAddressBook, id: Long, mimeType: String): List<Long> {
        val out = ArrayList<Long>()
        ab.requireProvider().query(ab.syncAdapterURI(Data.CONTENT_URI), arrayOf(Data.DATA1),
            "${Data.RAW_CONTACT_ID}=? AND ${Data.MIMETYPE}=?", arrayOf(id.toString(), mimeType), null)
            ?.use { cursor -> while (cursor.moveToNext()) out += cursor.getLong(0) }
            ?: throw IllegalStateException("FIXTURE #934: null data cursor")
        return out
    }

    /** Titles of the label groups (no filename) the contact belongs to, one entry per membership row, sorted. */
    private fun unfiledTitles(ab: LocalAddressBook, id: Long): List<String> {
        val groups = unfiledGroups(ab)
        return groupRowIds(ab, id).mapNotNull { groups[it] }.sorted()
    }

    /** (TYPE, LABEL) of each data row of [mimeType]; TYPE is DATA2 and LABEL DATA3 for phone, email and address. */
    private fun typeLabels(ab: LocalAddressBook, id: Long, mimeType: String): List<Pair<Int?, String?>> {
        val out = ArrayList<Pair<Int?, String?>>()
        ab.requireProvider().query(ab.syncAdapterURI(Data.CONTENT_URI), arrayOf(Data.DATA2, Data.DATA3),
            "${Data.RAW_CONTACT_ID}=? AND ${Data.MIMETYPE}=?", arrayOf(id.toString(), mimeType), null)
            ?.use { cursor ->
                while (cursor.moveToNext())
                    out += (if (cursor.isNull(0)) null else cursor.getInt(0)) to (if (cursor.isNull(1)) null else cursor.getString(1))
            } ?: throw IllegalStateException("FIXTURE #934: null data cursor")
        return out
    }

    /**
     * [column] of the single row at [uri]. A null cursor or a missing row is a FIXTURE error; an existing row
     * whose column is NULL (for example an uncertified SYNC4) returns null.
     */
    private fun singleRowColumn(ab: LocalAddressBook, uri: Uri, column: String, what: String): String? {
        val cursor = ab.requireProvider().query(uri, arrayOf(column), null, null, null)
            ?: throw IllegalStateException("FIXTURE #934: null $what cursor")
        return cursor.use {
            if (!it.moveToNext()) throw IllegalStateException("FIXTURE #934: $what row missing")
            if (it.isNull(0)) null else it.getString(0)
        }
    }

    private fun rawString(ab: LocalAddressBook, id: Long, column: String): String? =
        singleRowColumn(ab, ab.syncAdapterURI(ContentUris.withAppendedId(RawContacts.CONTENT_URI, id)), column, "raw contact $id")

    private fun rawInt(ab: LocalAddressBook, id: Long, column: String): Int? = rawString(ab, id, column)?.toInt()

    private fun groupString(ab: LocalAddressBook, groupId: Long, column: String): String? =
        singleRowColumn(ab, ab.syncAdapterURI(ContentUris.withAppendedId(Groups.CONTENT_URI, groupId)), column, "group $groupId")

    /** A group as a downloaded group vCard leaves it: with a filename and vCard UID. */
    private fun insertGroupVcardGroup(ab: LocalAddressBook, title: String, fileName: String, uid: String): Long {
        val values = ContentValues().apply {
            put(Groups.ACCOUNT_NAME, ab.account.name)
            put(Groups.ACCOUNT_TYPE, ab.account.type)
            put(Groups.TITLE, title)
            put(Groups.SOURCE_ID, fileName)
            put(Groups.SYNC1, uid)
        }
        val uri = ab.requireProvider().insert(ab.syncAdapterURI(Groups.CONTENT_URI), values)
            ?: throw IllegalStateException("FIXTURE #934: group insert failed")
        return ContentUris.parseId(uri)
    }

    /** An ordinary native edit, as a Contacts app makes it: a non-sync-adapter data insert (marks the row dirty). */
    private fun insertNoteAsContactsApp(ab: LocalAddressBook, id: Long, note: String) {
        val values = ContentValues().apply {
            put(Data.RAW_CONTACT_ID, id)
            put(Data.MIMETYPE, Note.CONTENT_ITEM_TYPE)
            put(Note.NOTE, note)
        }
        ab.requireProvider().insert(Data.CONTENT_URI, values) ?: throw IllegalStateException("FIXTURE #934: note insert failed")
    }

    // ---- synthetic account fixture ----

    private val LocalAddressBook.contextForTest: Context
        get() = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext

    private fun syncAdapter(uri: Uri): Uri =
        uri.buildUpon().appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true").build()

    private fun withAccount(context: Context, provider: ContentProviderClient, case: String, block: (LocalAddressBook) -> Unit) {
        val manager = AccountManager.get(context)
        val account = Account("clr934-$case-${System.nanoTime()}", App.addressBookAccountType)
        var registered = false
        var primary: Throwable? = null
        try {
            fixture(manager.addAccountExplicitly(account, null, null)) { "could not register ${account.name}" }
            registered = true
            ContentResolver.setIsSyncable(account, ContactsContract.AUTHORITY, 0)
            ContentResolver.setSyncAutomatically(account, ContactsContract.AUTHORITY, false)
            ContentResolver.removePeriodicSync(account, ContactsContract.AUTHORITY, Bundle())
            val ab = LocalAddressBook(context, account, provider)
            fixture(ab.mainAccountOrNull == null) { "synthetic address book unexpectedly has an owner" }
            block(ab)
        } catch (t: Throwable) {
            primary = t
            throw t
        } finally {
            val errors = if (registered) cleanup(manager, provider, account) else emptyList()
            if (errors.isNotEmpty()) {
                // A cleanup failure is never folded into a behavior result; the case's own failure is kept as suppressed.
                val failure = IllegalStateException("FIXTURE #934: cleanup of ${account.name} failed: ${errors.map { it.message }}")
                errors.forEach { failure.addSuppressed(it) }
                primary?.let { failure.addSuppressed(it) }
                throw failure
            }
        }
    }

    /** Deletes only this account's raw contacts and groups, verifies their absence, then removes the account. */
    private fun cleanup(manager: AccountManager, provider: ContentProviderClient, account: Account): List<Throwable> {
        val errors = ArrayList<Throwable>()
        val args = arrayOf(account.name, account.type)
        val rawSelection = accountSelection(RawContacts.ACCOUNT_NAME, RawContacts.ACCOUNT_TYPE)
        val groupSelection = accountSelection()
        fun count(uri: Uri, column: String, selection: String): Int =
            provider.query(uri, arrayOf(column), selection, args, null)?.use { it.count }
                ?: throw IllegalStateException("cleanup: null cursor for $uri")
        runCatching { provider.delete(syncAdapter(RawContacts.CONTENT_URI), rawSelection, args) }.onFailure { errors += it }
        runCatching { provider.delete(syncAdapter(Groups.CONTENT_URI), groupSelection, args) }.onFailure { errors += it }
        runCatching { count(syncAdapter(RawContacts.CONTENT_URI), RawContacts._ID, rawSelection) }
            .onSuccess { if (it != 0) errors += IllegalStateException("cleanup: $it raw contacts remain for ${account.name}") }
            .onFailure { errors += it }
        runCatching { count(syncAdapter(Groups.CONTENT_URI), Groups._ID, groupSelection) }
            .onSuccess { if (it != 0) errors += IllegalStateException("cleanup: $it groups remain for ${account.name}") }
            .onFailure { errors += it }
        runCatching { manager.removeAccountExplicitly(account) }
            .onSuccess { if (!it) errors += IllegalStateException("cleanup: could not remove ${account.name}") }
            .onFailure { errors += it }
        runCatching { manager.getAccountsByType(account.type).any { it == account } }
            .onSuccess { if (it) errors += IllegalStateException("cleanup: ${account.name} still registered") }
            .onFailure { errors += it }
        return errors
    }
}
