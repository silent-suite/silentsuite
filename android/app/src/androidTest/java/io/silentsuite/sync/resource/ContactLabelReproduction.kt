package io.silentsuite.sync.resource

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderClient
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
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
import android.util.Log
import at.bitfire.vcard4android.BatchOperation
import at.bitfire.vcard4android.CachedGroupMembership
import at.bitfire.vcard4android.Contact
import io.silentsuite.sync.App
import org.json.JSONArray
import org.json.JSONObject
import java.io.StringReader

/**
 * #934 diagnostic, test-only. Characterizes how whole-contact labels (vCard CATEGORIES) and per-field
 * labels (TEL/EMAIL/ADR TYPE and grouped X-ABLabel) travel through the provider path production sync uses:
 * [Contact.fromReader] -> [LocalContact.add] (new item) / fresh provider read + [LocalContact.update]
 * (ContactsSyncManager.processContact on a re-delivered item) -> [LocalContact.content] read from a fresh
 * provider-backed instance (SyncManager uploads exactly `item.setContent(local.content)`).
 *
 * This is NOT live Etebase, browser, Contacts-app UI or device acceptance, and it fixes nothing. Desired label
 * behavior that is missing is recorded, not asserted: the matrix only fails for fixture problems, unexpected
 * exceptions, failed cleanup or incomplete coverage. Every stage emits one compact JSON line on logcat tag
 * [TAG], prefixed [MARKER].
 *
 * Fixture: one synthetic address-book account per case, registered with AccountManager before any provider
 * write (ContactsProvider purges rows of unknown accounts), contacts sync disabled for it, no owning main
 * account (AddressBookCleanupPolicy skips owner-less rows) and no network. Teardown deletes only that
 * account's raw contacts and groups, verifies their absence, removes the account and verifies it is gone.
 */
internal object ContactLabelReproduction {
    const val TAG = "ContactLabelRepro"
    const val MARKER = "CLR934"

    enum class FieldKind(val mimeType: String) {
        TEL(Phone.CONTENT_ITEM_TYPE), EMAIL(Email.CONTENT_ITEM_TYPE), ADR(StructuredPostal.CONTENT_ITEM_TYPE)
    }

    /**
     * One labelled field. [value] identifies the row (number, address, or ADR street). [desiredType]/[desiredLabel]
     * are what a user would expect to see in Android's Contacts app. When [strictParserControl] is false the
     * parser's label conversion is itself under investigation: only the field's presence is a fixture control.
     */
    class FieldExpectation(
        val kind: FieldKind,
        val value: String,
        val inputLabel: String,
        val desiredType: Int,
        val desiredLabel: String?,
        val strictParserControl: Boolean,
    )

    class LabelCase(
        val id: String,
        val inputKind: String,
        val lines: List<String>,
        val expectedCategories: List<String>,
        val strictCategoryControl: Boolean,
        val fields: List<FieldExpectation>,
    ) {
        val vcard: String get() = lines.joinToString("\r\n", postfix = "\r\n")
    }

    private fun v3(id: String, vararg body: String): List<String> =
        listOf("BEGIN:VCARD", "VERSION:3.0", "UID:clr934-$id", "FN:Synthetic $id", "N:$id;Synthetic;;;") + body + "END:VCARD"

    private fun v4(id: String, vararg body: String): List<String> =
        listOf("BEGIN:VCARD", "VERSION:4.0", "UID:clr934-$id", "FN:Synthetic $id", "N:$id;Synthetic;;;") + body + "END:VCARD"

    private val AMIS_ETE = "Amis été"

    val CASES: List<LabelCase> = listOf(
        LabelCase("baseline-none", "none", v3("baseline-none", "TEL:+1 555 0100"), emptyList(), true,
            listOf(FieldExpectation(FieldKind.TEL, "+1 555 0100", "", Phone.TYPE_OTHER, null, true))),
        LabelCase("cat-single", "categories", v4("cat-single", "CATEGORIES:Family"), listOf("Family"), true, emptyList()),
        LabelCase("cat-multi", "categories", v4("cat-multi", "CATEGORIES:Family,Work"), listOf("Family", "Work"), true, emptyList()),
        LabelCase("cat-unicode", "categories", v4("cat-unicode", "CATEGORIES:$AMIS_ETE"), listOf(AMIS_ETE), true, emptyList()),
        LabelCase("cat-escaped-comma", "categories", v3("cat-escaped-comma", "CATEGORIES:Team\\, West"), listOf("Team, West"), false, emptyList()),
        LabelCase("cat-repeated-property", "categories", v3("cat-repeated-property", "CATEGORIES:Family", "CATEGORIES:Work"),
            listOf("Family", "Work"), true, emptyList()),
        LabelCase("tel-standard", "field-standard-type", v3("tel-standard", "TEL;TYPE=HOME:+1 555 0101", "TEL;TYPE=WORK:+1 555 0102"),
            emptyList(), true, listOf(
                FieldExpectation(FieldKind.TEL, "+1 555 0101", "HOME", Phone.TYPE_HOME, null, true),
                FieldExpectation(FieldKind.TEL, "+1 555 0102", "WORK", Phone.TYPE_WORK, null, true))),
        LabelCase("tel-x-type", "field-exporter-x-type", v3("tel-x-type", "TEL;TYPE=X-Desk:+1 555 0103"), emptyList(), true,
            listOf(FieldExpectation(FieldKind.TEL, "+1 555 0103", "X-Desk", Phone.TYPE_CUSTOM, "Desk", false))),
        LabelCase("tel-ablabel", "field-ablabel", v3("tel-ablabel", "item1.TEL:+1 555 0104", "item1.X-ABLabel:Emergency"), emptyList(), true,
            listOf(FieldExpectation(FieldKind.TEL, "+1 555 0104", "Emergency", Phone.TYPE_CUSTOM, "Emergency", true))),
        LabelCase("email-labels", "field-mixed-email", v3("email-labels",
            "EMAIL;TYPE=INTERNET,WORK:work@example.invalid",
            "EMAIL;TYPE=INTERNET,X-School:school@example.invalid",
            "item2.EMAIL;TYPE=INTERNET:club@example.invalid", "item2.X-ABLabel:Club"), emptyList(), true, listOf(
                FieldExpectation(FieldKind.EMAIL, "work@example.invalid", "WORK", Email.TYPE_WORK, null, true),
                FieldExpectation(FieldKind.EMAIL, "school@example.invalid", "X-School", Email.TYPE_CUSTOM, "School", false),
                FieldExpectation(FieldKind.EMAIL, "club@example.invalid", "Club", Email.TYPE_CUSTOM, "Club", true))),
        LabelCase("adr-labels", "field-mixed-address", v3("adr-labels",
            "ADR;TYPE=HOME:;;2 Test Way;Testville;;00000;Testland",
            "ADR;TYPE=X-Cabin:;;1 Test Way;Testville;;00000;Testland"), emptyList(), true, listOf(
                FieldExpectation(FieldKind.ADR, "2 Test Way", "HOME", StructuredPostal.TYPE_HOME, null, true),
                FieldExpectation(FieldKind.ADR, "1 Test Way", "X-Cabin", StructuredPostal.TYPE_CUSTOM, "Cabin", false))),
        LabelCase("mixed-category-and-field", "categories+field-ablabel", v3("mixed-category-and-field",
            "CATEGORIES:Family", "item1.TEL:+1 555 0105", "item1.X-ABLabel:Emergency"), listOf("Family"), true,
            listOf(FieldExpectation(FieldKind.TEL, "+1 555 0105", "Emergency", Phone.TYPE_CUSTOM, "Emergency", true))),
    )

    private const val EDIT_NOTE = "clr934 ordinary non-label edit"
    private val CATEGORY_LINE = Regex("(?im)^CATEGORIES[;:][^\\r\\n]*")
    private val FIELD_LINE = Regex("(?im)^(?:[A-Za-z0-9-]+\\.)?(?:TEL|EMAIL|ADR|X-ABLABEL)[;:][^\\r\\n]*")

    private class FixtureException(message: String) : IllegalStateException(message)

    class CaseOutcome(
        val id: String,
        val reachedStage: String,
        val fixtureError: String?,
        val behaviorError: String?,
        val cleanupErrors: List<Throwable>,
        val primary: Throwable?,
        val desiredObserved: Boolean?,
    )

    /** Runs every case, then fails only for fixture problems, unexpected exceptions, cleanup failure or lost coverage. */
    fun runMatrix(context: Context) {
        val run = "clr934-${System.nanoTime()}"
        log(run, "*", "matrix-start", JSONObject().put("api", Build.VERSION.SDK_INT).put("cases", JSONArray(CASES.map { it.id })))
        val provider = context.contentResolver.acquireContentProviderClient(ContactsContract.AUTHORITY)
            ?: throw IllegalStateException("FIXTURE ContactLabelRepro: contacts provider unavailable")
        val outcomes = ArrayList<CaseOutcome>()
        try {
            for (case in CASES) outcomes += runCase(context, provider, run, case)
        } finally {
            provider.close()
        }

        val problems = ArrayList<String>()
        if (outcomes.map { it.id } != CASES.map { it.id }) problems += "coverage: ran ${outcomes.map { it.id }}"
        outcomes.forEach { o ->
            o.fixtureError?.let { problems += "FIXTURE ${o.id} $it" }
            o.behaviorError?.let { problems += "UNEXPECTED ${o.id} $it" }
            if (o.cleanupErrors.isNotEmpty()) problems += "CLEANUP ${o.id} ${o.cleanupErrors.map { it.message }}"
        }
        log(run, "*", "summary", JSONObject()
            .put("casesRun", outcomes.size)
            .put("desiredObserved", JSONArray(outcomes.filter { it.desiredObserved == true }.map { it.id }))
            .put("desiredMissing", JSONArray(outcomes.filter { it.desiredObserved == false }.map { it.id }))
            .put("notEvaluated", JSONArray(outcomes.filter { it.desiredObserved == null }.map { it.id }))
            .put("problems", JSONArray(problems)))
        if (problems.isNotEmpty()) {
            val failure = IllegalStateException("DIAGNOSTIC ContactLabelRepro #934 matrix incomplete: ${problems.joinToString(" | ")}")
            outcomes.forEach { o -> o.primary?.let { failure.addSuppressed(it) }; o.cleanupErrors.forEach { failure.addSuppressed(it) } }
            throw failure
        }
    }

    private fun runCase(context: Context, provider: ContentProviderClient, run: String, case: LabelCase): CaseOutcome {
        val manager = AccountManager.get(context)
        val account = Account("clr934-${case.id}-${System.nanoTime()}", App.addressBookAccountType)
        var stage = "setup"
        var registered = false
        var fixtureError: String? = null
        var behaviorError: String? = null
        var primary: Throwable? = null
        var desired: Boolean? = null
        try {
            if (!manager.addAccountExplicitly(account, null, null)) throw FixtureException("could not register synthetic account")
            registered = true
            ContentResolver.setIsSyncable(account, ContactsContract.AUTHORITY, 0)
            ContentResolver.setSyncAutomatically(account, ContactsContract.AUTHORITY, false)
            ContentResolver.removePeriodicSync(account, ContactsContract.AUTHORITY, Bundle())
            val ab = LocalAddressBook(context, account, provider)
            if (ab.mainAccountOrNull != null) throw FixtureException("synthetic address book unexpectedly has an owner")

            stage = "parse"
            val parsed = Contact.fromReader(StringReader(case.vcard), null).single()
            val (controlJson, controlProblem) = parserControls(case, parsed)
            log(run, case.id, stage, controlJson)
            controlProblem?.let { throw FixtureException(it) }
            val parsedCategories = parsed.categories.toList()

            // New server item: ContactsSyncManager.processContact -> LocalContact(..., item.uid, item.etag).add()
            stage = "add"
            val local = LocalContact(ab, parsed, "clr934-${case.id}", "clr934-etag-1")
            local.add()
            val rawId = local.id ?: throw FixtureException("no raw contact id after add")
            stage = "fresh-after-add"
            val afterAdd = snapshot(ab, rawId)
            log(run, case.id, stage, afterAdd.toJson(case))

            // Re-delivered server item: the existing local gets item.etag, then update(newData).
            stage = "resync-update"
            ab.findContactByID(rawId).also { it.eTag = "clr934-etag-2" }
                .update(Contact.fromReader(StringReader(case.vcard), null).single())
            val afterUpdate = snapshot(ab, rawId)
            log(run, case.id, stage, afterUpdate.toJson(case))

            // Ordinary non-label edit as a Contacts app makes it: a non-sync-adapter data write (marks DIRTY).
            stage = "local-nonlabel-edit"
            insertNoteAsContactsApp(provider, rawId)
            val afterEdit = snapshot(ab, rawId)
            log(run, case.id, stage, afterEdit.toJson(case))
            if (afterEdit.uploadContact?.note != EDIT_NOTE) throw FixtureException("edit note did not reach the upload body")

            var importJson: Any = JSONObject.NULL
            if (parsedCategories.isNotEmpty()) {
                // Explicit equivalent of ImportFragment's category loop (findOrCreateGroup + addToGroup). The
                // ImportFragment UI/import flow itself does NOT run here.
                stage = "import-equivalent-mapping"
                val mapped = ab.findContactByID(rawId)
                val batch = BatchOperation(provider)
                val mappedIds = parsedCategories.map { ab.findOrCreateGroup(it) }
                mappedIds.forEach { mapped.addToGroup(batch, it) }
                batch.commit()
                val afterMapping = snapshot(ab, rawId)
                log(run, case.id, stage, afterMapping.toJson(case)
                    .put("mappedGroupsInAccount", mappedIds.all { it in afterMapping.groups.keys }))

                stage = "resync-after-mapping"
                ab.findContactByID(rawId).also { it.eTag = "clr934-etag-3" }
                    .update(Contact.fromReader(StringReader(case.vcard), null).single())
                val afterMappingResync = snapshot(ab, rawId)
                log(run, case.id, stage, afterMappingResync.toJson(case))
                importJson = JSONObject()
                    .put("providerGroups", groupsMatch(case.expectedCategories, afterMapping))
                    .put("uploadCategories", categoriesKept(case.expectedCategories, afterMapping))
                    .put("providerGroupsAfterResync", groupsMatch(case.expectedCategories, afterMappingResync))
                    .put("uploadCategoriesAfterResync", categoriesKept(case.expectedCategories, afterMappingResync))
            }

            stage = "verdict"
            val stages = listOf("afterAdd" to afterAdd, "afterUpdate" to afterUpdate, "afterEdit" to afterEdit)
            val catProvider = JSONObject()
            val catUpload = JSONObject()
            var ok = true
            for ((name, s) in stages) {
                val g = groupsMatch(case.expectedCategories, s)
                val u = categoriesKept(case.expectedCategories, s)
                catProvider.put(name, g); catUpload.put(name, u)
                ok = ok && g && u
            }
            val fieldsJson = JSONArray()
            for (f in case.fields) {
                val prov = JSONObject()
                val up = JSONObject()
                for ((name, s) in stages) {
                    val p = fieldProviderOk(f, s)
                    val u = fieldUploadOk(f, s)
                    prov.put(name, p); up.put(name, u)
                    ok = ok && p && u
                }
                fieldsJson.put(JSONObject().put("k", f.kind.name).put("v", f.value).put("inputLabel", f.inputLabel)
                    .put("desiredType", f.desiredType).put("desiredLabel", f.desiredLabel ?: JSONObject.NULL)
                    .put("provider", prov).put("upload", up))
            }
            desired = ok
            log(run, case.id, stage, JSONObject()
                .put("inputKind", case.inputKind)
                .put("expectedCategories", JSONArray(case.expectedCategories))
                .put("categoryProviderMembership", catProvider)
                .put("categoryUpload", catUpload)
                .put("fields", fieldsJson)
                .put("importEquivalent", importJson)
                .put("desiredObserved", ok))
            stage = "complete"
        } catch (e: FixtureException) {
            fixtureError = "$stage: ${e.message}"
            primary = e
        } catch (e: Throwable) {
            primary = e
            val text = "$stage: ${e.javaClass.name}: ${e.message?.take(160)}"
            if (stage == "setup" || stage == "parse") fixtureError = text else behaviorError = text
        }

        val cleanupJson = JSONObject()
        val cleanupErrors = cleanup(manager, provider, account, registered, cleanupJson)
        primary?.let { p -> cleanupErrors.forEach { p.addSuppressed(it) } }
        log(run, case.id, "case-end", JSONObject()
            .put("reachedStage", stage)
            .put("desiredObserved", desired ?: JSONObject.NULL)
            .put("fixtureError", fixtureError ?: JSONObject.NULL)
            .put("unexpectedError", behaviorError ?: JSONObject.NULL)
            .put("cleanup", cleanupJson.put("ok", cleanupErrors.isEmpty())))
        return CaseOutcome(case.id, stage, fixtureError, behaviorError, cleanupErrors, primary, desired)
    }

    // ---- parser controls ----

    private class ParsedField(val label: String?, val types: List<String>)

    private fun findField(contact: Contact, f: FieldExpectation): ParsedField? = when (f.kind) {
        FieldKind.TEL -> contact.phoneNumbers.firstOrNull { it.property.text == f.value }
            ?.let { ParsedField(it.label, it.property.types.map { t -> t.value }) }
        FieldKind.EMAIL -> contact.emails.firstOrNull { it.property.value == f.value }
            ?.let { ParsedField(it.label, it.property.types.map { t -> t.value }) }
        FieldKind.ADR -> contact.addresses.firstOrNull { it.property.streetAddress == f.value }
            ?.let { ParsedField(it.label, it.property.types.map { t -> t.value }) }
    }

    private fun labelPresent(p: ParsedField, f: FieldExpectation): Boolean =
        f.inputLabel.isEmpty() || p.label == f.inputLabel || p.types.any { it.equals(f.inputLabel, ignoreCase = true) }

    private fun parserControls(case: LabelCase, parsed: Contact): Pair<JSONObject, String?> {
        val problems = ArrayList<String>()
        val actualCategories = parsed.categories.toList()
        if (case.strictCategoryControl && actualCategories != case.expectedCategories)
            problems += "parsed categories $actualCategories != ${case.expectedCategories}"
        val fields = JSONArray()
        for (f in case.fields) {
            val p = findField(parsed, f)
            if (p == null) problems += "${f.kind} ${f.value} missing from parser output"
            else if (f.strictParserControl && !labelPresent(p, f)) problems += "${f.kind} ${f.value} label ${f.inputLabel} missing from parser output"
            fields.put(JSONObject().put("k", f.kind.name).put("v", f.value).put("inputLabel", f.inputLabel)
                .put("parsedLabel", p?.label ?: JSONObject.NULL)
                .put("parsedTypes", JSONArray(p?.types ?: emptyList<String>()))
                .put("labelPresent", p != null && labelPresent(p, f)))
        }
        val json = JSONObject()
            .put("inputKind", case.inputKind)
            .put("expectedCategories", JSONArray(case.expectedCategories))
            .put("parsedCategories", JSONArray(actualCategories))
            .put("categoriesMatchExpected", actualCategories == case.expectedCategories)
            .put("strictCategoryControl", case.strictCategoryControl)
            .put("unknownPropertiesHoldCategories", parsed.unknownProperties?.contains("CATEGORIES", ignoreCase = true) == true)
            .put("fields", fields)
            .put("controlProblems", JSONArray(problems))
        return json to problems.takeIf { it.isNotEmpty() }?.joinToString("; ")
    }

    // ---- provider snapshot ----

    private class FieldRow(val kind: FieldKind, val value: String?, val type: Int?, val label: String?)

    private class Snapshot(
        val groups: Map<Long, String?>,
        val memberTitles: List<String>,
        val cachedMembershipRows: Int,
        val fields: List<FieldRow>,
        val dirty: Int?,
        val upload: String,
        val uploadContact: Contact?,
    ) {
        val uploadCategories: List<String> get() = uploadContact?.categories?.toList() ?: emptyList()

        fun toJson(case: LabelCase): JSONObject = JSONObject()
            .put("accountGroups", JSONArray(groups.values.map { it ?: "<null>" }))
            .put("membership", JSONArray(memberTitles))
            .put("cachedMembershipRows", cachedMembershipRows)
            .put("providerFields", JSONArray(fields.map {
                JSONObject().put("k", it.kind.name).put("v", it.value ?: JSONObject.NULL)
                    .put("type", it.type ?: JSONObject.NULL).put("label", it.label ?: JSONObject.NULL)
            }))
            .put("dirty", dirty ?: JSONObject.NULL)
            .put("uploadCategories", JSONArray(uploadCategories))
            .put("uploadCategoryLines", JSONArray(ContactLabelReproduction.CATEGORY_LINE.findAll(upload).map { it.value.trim() }.toList()))
            .put("uploadFieldLines", JSONArray(ContactLabelReproduction.FIELD_LINE.findAll(upload).map { it.value.trim() }.toList()))
            .put("uploadFields", JSONArray(case.fields.map { f ->
                val p = uploadContact?.let { ContactLabelReproduction.findField(it, f) }
                JSONObject().put("k", f.kind.name).put("v", f.value).put("present", p != null)
                    .put("label", p?.label ?: JSONObject.NULL).put("types", JSONArray(p?.types ?: emptyList<String>()))
            }))
    }

    private fun snapshot(ab: LocalAddressBook, rawId: Long): Snapshot {
        val groups = accountGroups(ab)
        val memberIds = dataLongs(ab, rawId, GroupMembership.CONTENT_ITEM_TYPE)
        val cached = dataLongs(ab, rawId, CachedGroupMembership.CONTENT_ITEM_TYPE).size
        val fields = fieldRows(ab, rawId)
        val dirty = rawDirty(ab, rawId)
        // Exactly the upload body: SyncManager calls item.setContent(local.content) on a provider-backed LocalContact.
        val upload = ab.findContactByID(rawId).content
        val reparsed = Contact.fromReader(StringReader(upload), null).firstOrNull()
        return Snapshot(groups, memberIds.map { groups[it] ?: "<not-in-account:$it>" }, cached, fields, dirty, upload, reparsed)
    }

    private fun accountGroups(ab: LocalAddressBook): Map<Long, String?> {
        val out = LinkedHashMap<Long, String?>()
        ab.requireProvider().query(ab.syncAdapterURI(Groups.CONTENT_URI), arrayOf(Groups._ID, Groups.TITLE),
            "${Groups.ACCOUNT_NAME}=? AND ${Groups.ACCOUNT_TYPE}=?", arrayOf(ab.account.name, ab.account.type), null)
            ?.use { c -> while (c.moveToNext()) out[c.getLong(0)] = c.getString(1) }
            ?: throw FixtureException("null groups cursor")
        return out
    }

    private fun dataLongs(ab: LocalAddressBook, rawId: Long, mimeType: String): List<Long> {
        val out = ArrayList<Long>()
        ab.requireProvider().query(ab.syncAdapterURI(Data.CONTENT_URI), arrayOf(Data.DATA1),
            "${Data.RAW_CONTACT_ID}=? AND ${Data.MIMETYPE}=?", arrayOf(rawId.toString(), mimeType), null)
            ?.use { c -> while (c.moveToNext()) out += c.getLong(0) }
            ?: throw FixtureException("null data cursor")
        return out
    }

    private fun fieldRows(ab: LocalAddressBook, rawId: Long): List<FieldRow> {
        val out = ArrayList<FieldRow>()
        ab.requireProvider().query(ab.syncAdapterURI(Data.CONTENT_URI),
            arrayOf(Data.MIMETYPE, Data.DATA1, Data.DATA2, Data.DATA3, StructuredPostal.STREET),
            "${Data.RAW_CONTACT_ID}=? AND ${Data.MIMETYPE} IN (?,?,?)",
            arrayOf(rawId.toString(), Phone.CONTENT_ITEM_TYPE, Email.CONTENT_ITEM_TYPE, StructuredPostal.CONTENT_ITEM_TYPE), null)
            ?.use { c ->
                while (c.moveToNext()) {
                    val kind = FieldKind.values().first { it.mimeType == c.getString(0) }
                    // TYPE is DATA2 and LABEL is DATA3 for Phone, Email and StructuredPostal alike.
                    out += FieldRow(kind, if (kind == FieldKind.ADR) c.getString(4) else c.getString(1),
                        if (c.isNull(2)) null else c.getInt(2), c.getString(3))
                }
            } ?: throw FixtureException("null field cursor")
        return out
    }

    private fun rawDirty(ab: LocalAddressBook, rawId: Long): Int? =
        ab.requireProvider().query(ab.syncAdapterURI(RawContacts.CONTENT_URI), arrayOf(RawContacts.DIRTY),
            "${RawContacts._ID}=?", arrayOf(rawId.toString()), null)
            ?.use { c -> if (c.moveToNext() && !c.isNull(0)) c.getInt(0) else null }

    private fun insertNoteAsContactsApp(provider: ContentProviderClient, rawId: Long) {
        val values = ContentValues().apply {
            put(Data.RAW_CONTACT_ID, rawId)
            put(Data.MIMETYPE, Note.CONTENT_ITEM_TYPE)
            put(Note.NOTE, EDIT_NOTE)
        }
        provider.insert(Data.CONTENT_URI, values) ?: throw FixtureException("note insert returned null")
    }

    // ---- evaluation ----

    private fun groupsMatch(expected: List<String>, s: Snapshot) = expected.toSet() == s.memberTitles.toSet()

    private fun categoriesKept(expected: List<String>, s: Snapshot) = expected.toSet() == s.uploadCategories.toSet()

    private fun fieldProviderOk(f: FieldExpectation, s: Snapshot): Boolean =
        s.fields.firstOrNull { it.kind == f.kind && it.value == f.value }
            ?.let { it.type == f.desiredType && (f.desiredLabel == null || it.label == f.desiredLabel) } ?: false

    private fun fieldUploadOk(f: FieldExpectation, s: Snapshot): Boolean {
        val p = s.uploadContact?.let { findField(it, f) } ?: return false
        return if (f.desiredLabel != null) p.label == f.desiredLabel else labelPresent(p, f)
    }

    // ---- cleanup (only this case's account, rows and groups) ----

    private fun syncAdapter(uri: Uri): Uri =
        uri.buildUpon().appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true").build()

    private fun cleanup(manager: AccountManager, provider: ContentProviderClient, account: Account, registered: Boolean,
                        out: JSONObject): List<Throwable> {
        val errors = ArrayList<Throwable>()
        if (!registered) {
            out.put("account", "never-registered")
            return errors
        }
        val rawUri = syncAdapter(RawContacts.CONTENT_URI)
        val groupUri = syncAdapter(Groups.CONTENT_URI)
        val rawSelection = "${RawContacts.ACCOUNT_NAME}=? AND ${RawContacts.ACCOUNT_TYPE}=?"
        val groupSelection = "${Groups.ACCOUNT_NAME}=? AND ${Groups.ACCOUNT_TYPE}=?"
        val args = arrayOf(account.name, account.type)
        fun count(uri: Uri, column: String, selection: String): Int =
            provider.query(uri, arrayOf(column), selection, args, null)?.use { it.count }
                ?: throw IllegalStateException("CLEANUP null cursor for $uri")

        runCatching { provider.delete(rawUri, rawSelection, args) }
            .onSuccess { out.put("rawContactsDeleted", it) }.onFailure { errors += it }
        runCatching { provider.delete(groupUri, groupSelection, args) }
            .onSuccess { out.put("groupsDeleted", it) }.onFailure { errors += it }
        runCatching { count(rawUri, RawContacts._ID, rawSelection) }.onSuccess {
            out.put("rawContactsRemaining", it)
            if (it != 0) errors += IllegalStateException("CLEANUP $it raw contacts remain for ${account.name}")
        }.onFailure { errors += it }
        runCatching { count(groupUri, Groups._ID, groupSelection) }.onSuccess {
            out.put("groupsRemaining", it)
            if (it != 0) errors += IllegalStateException("CLEANUP $it groups remain for ${account.name}")
        }.onFailure { errors += it }
        runCatching { manager.removeAccountExplicitly(account) }.onSuccess {
            out.put("accountRemoved", it)
            if (!it) errors += IllegalStateException("CLEANUP could not remove ${account.name}")
        }.onFailure { errors += it }
        runCatching { manager.getAccountsByType(account.type).any { it == account } }.onSuccess {
            out.put("accountPresentAfter", it)
            if (it) errors += IllegalStateException("CLEANUP ${account.name} still registered")
        }.onFailure { errors += it }
        return errors
    }

    private fun log(run: String, caseId: String, stage: String, body: JSONObject) {
        val line = JSONObject().put("marker", MARKER).put("run", run).put("case", caseId).put("stage", stage)
        val keys = body.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            line.put(key, body.get(key))
        }
        Log.i(TAG, "$MARKER $line")
    }
}
