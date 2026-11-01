package io.silentsuite.sync.birthdays

import com.etebase.client.Collection
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.CollectionManager
import com.etebase.client.FetchOptions
import com.etebase.client.Item
import com.etebase.client.ItemManager
import com.etebase.client.ItemMetadata
import com.etebase.client.exceptions.ConflictException
import com.etebase.client.exceptions.ConnectionException
import com.etebase.client.exceptions.EtebaseException
import com.etebase.client.exceptions.ServerErrorException
import com.etebase.client.exceptions.TemporaryServerErrorException
import io.silentsuite.sync.Constants
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.syncadapter.PagedListingGuard
import io.silentsuite.sync.syncadapter.PagedListingStalledException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.TreeMap

/**
 * The Birthdays calendar reconciler: the fenced write step and one fresh-read pass ([reconcile]),
 * including duplicate copies, retirement of extra active calendars and repair of retired ones, and
 * a post-commit source check and conflict recovery, both by bounded fresh reruns. Retries of unknown
 * write outcomes, coalescing and the trigger controller are not here yet.
 */
object BirthdayReconciler {
    enum class WriteOutcome { COMMITTED, CONFLICT, UNKNOWN, SKIPPED }

    /** The most items one fenced transaction carries. */
    const val MAX_CHUNK = 50

    /**
     * Writes [items] into [calendar] in one item transaction whose dependency is [calendar]'s root
     * item as this client last read it. The server rejects the whole transaction when the calendar
     * changed since (for example its marker was retired): that is [WriteOutcome.CONFLICT], and
     * nothing was written. An answer that never arrived or a server error leaves the outcome
     * [WriteOutcome.UNKNOWN]; the caller reads afresh instead of sending it again. There is no
     * unfenced fallback. Nothing to write is [WriteOutcome.SKIPPED].
     */
    fun writeFenced(itemManager: ItemManager, calendar: Collection, items: List<Item>): WriteOutcome {
        if (items.isEmpty()) return WriteOutcome.SKIPPED
        require(items.size <= MAX_CHUNK) { "at most $MAX_CHUNK items per fenced transaction" }
        val root = calendar.asItem()
        return try {
            itemManager.transaction(items.toTypedArray(), arrayOf(root))
            WriteOutcome.COMMITTED
        } catch (e: ConflictException) {
            WriteOutcome.CONFLICT
        } catch (e: ConnectionException) {
            WriteOutcome.UNKNOWN
        } catch (e: TemporaryServerErrorException) {
            WriteOutcome.UNKNOWN
        } catch (e: ServerErrorException) {
            WriteOutcome.UNKNOWN
        }
    }

    /** How a reconcile run ended; only [DONE] means the calendar matched the source at its end. */
    enum class RunStatus { DONE, SKIPPED, PENDING, FAILED }

    /** A run's outcome, as Bridge reports it: the status, every calendar uid written or possibly written, and why. */
    data class RunResult(val status: RunStatus, val written: List<String>, val reason: String? = null)

    /**
     * One fresh-read pass over the generated Birthdays calendar for the account [etebase], signed
     * in as the SDK user [username]. Never throws.
     *
     * Everything is read fresh and completely before anything is written:
     * - the collection inventory (calendars and address books, deleted ones left out);
     * - the active destinations (C3): calendars with the active marker, Admin access and a fully
     *   paged member list that is exactly [username]; the one with the smallest uid is canonical;
     * - the retired calendars this user can write to (F3: Admin or ReadWrite, whatever the members);
     * - the generated items (parsed `ss-bday1-` UID) of all of these;
     * - the source (C2): every listed address book at any access level, every item fully paged.
     * A listing that does not finish, or content that cannot be decrypted or is not UTF-8, ends the
     * pass with [RunStatus.SKIPPED] and nothing written: it is never evidence that something is gone.
     * Without an active or a writable retired calendar the pass is [RunStatus.SKIPPED]; a calendar is
     * never created or adopted by its name.
     *
     * Then, in this order:
     * - F2/F4: each other active calendar is retired with a conditional calendar update
     *   (`CollectionManager.transaction`), its retired state and new root are read back, and only
     *   then are its generated items deleted, fenced on that new root;
     * - F3: generated leftovers in retired calendars are deleted, fenced on each root as read;
     * - in the canonical calendar: missing events are created; of several copies of one wanted event
     *   the one with the smallest storage uid is kept and rewritten in place if its fields differ
     *   (same storage item, canonical text, new mtime) and the others are deleted; generated events
     *   whose contact is gone are deleted; all fenced on its root as read.
     * Item writes go in [writeFenced] chunks. Ordinary items and calendars are never touched, and
     * nothing is generated into a retired calendar. An unknown outcome of any write is
     * [RunStatus.PENDING] and nothing is resent. [RunResult.written] lists every calendar a write
     * was attempted on, across passes.
     *
     * A write or conditional retirement the server rejects as a conflict (a calendar changed after
     * the pass read it) ends that pass; a fresh full pass then reads and plans everything again from
     * current state, so current eligibility applies and no old item or root is reused.
     *
     * After a pass that ends DONE, the source is checked again from the cursors that pass saved
     * (the collection inventory and each address book it read): a book that appeared, went away or
     * changed its access, or a contact added, changed or deleted, means the pass may have written
     * from an older source, so a fresh full pass runs.
     *
     * Conflicts and source changes share one bound: at most two extra passes (three in all). DONE
     * needs a complete check that finds no change; a check that cannot finish is
     * [RunStatus.PENDING] "post-check", and a run that still meets a conflict or a changing source
     * after its last pass is [RunStatus.PENDING] "conflict" or "post-check" for a later run.
     */
    fun reconcile(etebase: com.etebase.client.Account, username: String): RunResult {
        val written = LinkedHashSet<String>()
        return try {
            passes(etebase.collectionManager, username, written)
        } catch (e: Stop) {
            Logger.log.info("Birthdays reconcile stopped: ${e.reason}")
            RunResult(e.status, written.sorted(), e.reason)
        } catch (e: Exception) {
            Logger.log.warning("Birthdays reconcile failed (${e.javaClass.simpleName})")
            RunResult(RunStatus.FAILED, written.sorted(), "error")
        }
    }

    private val INVENTORY_TYPES = arrayOf(Constants.ETEBASE_TYPE_CALENDAR, Constants.ETEBASE_TYPE_ADDRESS_BOOK)
    private val GENERATED_UID = Regex("ss-bday1-[0-9a-f]{32}")

    /** Ends a pass early with nothing (more) written. */
    private class Stop(val status: RunStatus, val reason: String) : Exception(reason)

    /** A fenced write or conditional retirement was rejected by the server as a conflict; the pass ends. */
    private class Conflict : Exception("conflict")

    private class Page<T>(val data: List<T>, val cursor: String?, val done: Boolean)

    /** A complete listing and the cursor its done page gave, from which later changes can be listed. */
    private class Listing<T>(val entries: List<T>, val cursor: String?)

    /** Extra full passes after the first when the source changed while a pass ran (three passes at most). */
    private const val MAX_RERUNS = 2

    /** What a pass read from one address book: its access, its item cursor, and every live item's text. */
    private class BookRead(
        val collection: Collection,
        val accessLevel: CollectionAccessLevel,
        val cursor: String?,
        val contents: Map<String, String>,
    )

    /** What a pass read of the source (C2): the inventory cursor and every address book it read completely. */
    private class SourceRead(val inventoryCursor: String?, val books: Map<String, BookRead>)

    private enum class SourceCheck { STABLE, CHANGED, INCOMPLETE }

    /**
     * Plan3 §4: the source may change after a pass read it. Only a complete check that finds no
     * change ends the run as DONE; a changed source gets a fresh full pass, at most [MAX_RERUNS]
     * times, and a check that cannot finish is never taken as "unchanged". No cross-collection
     * atomicity is claimed: a later change is left to the next trigger.
     */
    private fun passes(colMgr: CollectionManager, username: String, written: MutableSet<String>): RunResult {
        var reruns = 0
        while (true) {
            val (result, source) = try {
                pass(colMgr, username, written)
            } catch (e: Conflict) {
                // The server rejected a fenced write: a calendar changed after this pass read it.
                // Nothing of the old pass is reused or resent; a fresh full pass reads and plans again
                // from current state, sharing the same bound as source-change reruns.
                if (reruns >= MAX_RERUNS) return RunResult(RunStatus.PENDING, written.sorted(), "conflict")
                reruns++
                Logger.log.info("Birthdays write met a newer calendar; reading everything again")
                continue
            }
            if (result.status != RunStatus.DONE) return result
            when (postCheck(colMgr, source)) {
                SourceCheck.STABLE -> return result
                SourceCheck.INCOMPLETE -> return RunResult(RunStatus.PENDING, written.sorted(), "post-check")
                SourceCheck.CHANGED -> {
                    if (reruns >= MAX_RERUNS) return RunResult(RunStatus.PENDING, written.sorted(), "post-check")
                    reruns++
                    Logger.log.info("Birthdays source changed during the pass; reading it again")
                }
            }
        }
    }

    private fun pass(colMgr: CollectionManager, username: String, written: MutableSet<String>): Pair<RunResult, SourceRead> {
        val inventoryListing = pagedListing("incomplete-inventory", PagedListingGuard.MAX_COLLECTION_PAGES, null) { cursor ->
            colMgr.list(INVENTORY_TYPES, FetchOptions().stoken(cursor)).let { Page(it.data.toList(), it.stoken, it.isDone) }
        }
        val inventory = inventoryListing.entries
        val calendars = ArrayList<Collection>()
        val books = ArrayList<Collection>()
        for (collection in inventory) {
            if (collection.isDeleted) continue
            when (collection.collectionType) {
                Constants.ETEBASE_TYPE_CALENDAR -> calendars += collection
                Constants.ETEBASE_TYPE_ADDRESS_BOOK -> books += collection
            }
        }

        // C3 for the active destination: Admin, and a complete member list that is exactly this user.
        // F3 for repair: every retired calendar this user can write to (Admin or ReadWrite), whatever
        // its members; no member listing is asked of it.
        val active = ArrayList<Collection>()
        val retired = ArrayList<Collection>()
        for (calendar in calendars) {
            val content = readBytes { calendar.content } ?: throw Stop(RunStatus.SKIPPED, "unreadable-calendar")
            val state = BirthdayCalendar.markerState(content)
            if (state == BirthdayCalendar.MarkerState.RETIRED) {
                if (calendar.accessLevel == CollectionAccessLevel.Admin || calendar.accessLevel == CollectionAccessLevel.ReadWrite) {
                    retired += calendar
                }
            } else if (state == BirthdayCalendar.MarkerState.ACTIVE && calendar.accessLevel == CollectionAccessLevel.Admin) {
                val memberManager = colMgr.getMemberManager(calendar)
                val members = paged("incomplete-members", PagedListingGuard.MAX_COLLECTION_PAGES) { cursor ->
                    memberManager.list(FetchOptions().iterator(cursor)).let { page -> Page(page.data.map { it.username }, page.stoken, page.isDone) }
                }
                if (members == listOf(username)) active += calendar
            }
        }
        if (active.isEmpty() && retired.isEmpty()) throw Stop(RunStatus.SKIPPED, "no-active-calendar")
        // F4: the active calendar with the smallest uid stays canonical; the others are retired.
        active.sortBy { it.uid }
        val canonical = active.firstOrNull()
        val duplicates = active.drop(1)

        // Every calendar this pass may write, read completely before anything is written.
        val itemMgr = canonical?.let { colMgr.getItemManager(it) }
        val generated = itemMgr?.let { generatedItems(it) } ?: LinkedHashMap()
        val duplicateLeftovers = duplicates.map { calendar -> calendar to generatedItems(colMgr.getItemManager(calendar)) }
        val retiredLeftovers = retired.map { calendar -> calendar to generatedItems(colMgr.getItemManager(calendar)) }

        // C2: every listed address book, every contact, read completely.
        val wanted = TreeMap<String, BirthdayCalendar.BirthdayEvent>()
        val bookReads = LinkedHashMap<String, BookRead>()
        for (book in books) {
            val listing = listItemsFrom(colMgr.getItemManager(book), "incomplete-book", null)
            val contents = LinkedHashMap<String, String>()
            for (item in listing.entries) {
                if (item.isDeleted) continue
                val text = readText { item.content } ?: throw Stop(RunStatus.SKIPPED, "unreadable-contact")
                contents[item.uid] = text
                val birthday = BirthdayCalendar.birthdayOf(text) ?: continue
                val uid = BirthdayCalendar.eventUid(book.uid, item.uid)
                wanted[uid] = BirthdayCalendar.BirthdayEvent(uid, birthday.name, birthday.month, birthday.day)
            }
            bookReads[book.uid] = BookRead(book, book.accessLevel, listing.cursor, contents)
        }
        val source = SourceRead(inventoryListing.cursor, bookReads)

        // The whole plan is built locally before the first write, so metadata that cannot be read
        // fails the pass with nothing written.
        val now = System.currentTimeMillis()
        val changes = ArrayList<Item>()
        for ((uid, copies) in generated) {
            val event = wanted[uid]
            // The copy with the smallest storage uid is kept, as core and Bridge keep it.
            val ordered = copies.sortedBy { it.first.uid }
            if (event == null) {
                // Its contact is gone from a complete source: every copy goes.
                for ((item, _) in ordered) {
                    item.delete()
                    changes += item
                }
                continue
            }
            for ((item, _) in ordered.drop(1)) {
                item.delete()
                changes += item
            }
            val (kept, keptFields) = ordered[0]
            if (keptFields != BirthdayCalendar.fieldsOf(event)) {
                // The same storage item gets the canonical text: no delete and recreate, no second copy.
                // Its existing metadata is kept except for the mtime.
                val meta = kept.meta
                meta.mtime = now
                kept.setContent(BirthdayCalendar.eventIcs(event).toByteArray(Charsets.UTF_8))
                kept.meta = meta
                changes += kept
            }
        }
        if (itemMgr != null) {
            for (event in wanted.values) {
                if (event.uid in generated) continue
                val meta = ItemMetadata().apply {
                    name = event.uid
                    mtime = now
                }
                changes += itemMgr.create(meta, BirthdayCalendar.eventIcs(event).toByteArray(Charsets.UTF_8))
            }
        }
        // Retirement and repair only ever delete generated items; nothing is created there.
        val duplicateDeletes = duplicateLeftovers.map { (calendar, leftovers) -> calendar to deleteAll(leftovers) }
        val retiredDeletes = retiredLeftovers.map { (calendar, leftovers) -> calendar to deleteAll(leftovers) }

        // F2: each extra active calendar is retired with a conditional calendar update first, then
        // loses its generated items, fenced on the new root read back from the server.
        for ((calendar, deletes) in duplicateDeletes) {
            val previousRoot = calendar.etag
            // Recorded before the write: an uncertain update may still have landed.
            written += calendar.uid
            calendar.setContent(RETIRED_MARKER)
            try {
                colMgr.transaction(calendar)
            } catch (e: ConflictException) {
                throw Conflict()
            } catch (e: ConnectionException) {
                throw Stop(RunStatus.PENDING, "write-outcome-unknown")
            } catch (e: TemporaryServerErrorException) {
                throw Stop(RunStatus.PENDING, "write-outcome-unknown")
            } catch (e: ServerErrorException) {
                throw Stop(RunStatus.PENDING, "write-outcome-unknown")
            }
            val fresh = colMgr.fetch(calendar.uid)
            val freshContent = readBytes { fresh.content }
            if (freshContent == null || BirthdayCalendar.markerState(freshContent) != BirthdayCalendar.MarkerState.RETIRED ||
                fresh.etag == previousRoot) {
                throw Stop(RunStatus.PENDING, "retirement-unconfirmed")
            }
            commitFenced(colMgr.getItemManager(fresh), fresh, deletes, written)
        }
        // F3: generated leftovers in retired calendars, fenced on each calendar's root as read.
        for ((calendar, deletes) in retiredDeletes) {
            commitFenced(colMgr.getItemManager(calendar), calendar, deletes, written)
        }
        if (canonical == null || itemMgr == null) {
            // No active calendar: repair only, and nothing is generated anywhere.
            return (if (written.isEmpty()) RunResult(RunStatus.SKIPPED, emptyList(), "no-active-calendar")
            else RunResult(RunStatus.DONE, written.sorted())) to source
        }
        commitFenced(itemMgr, canonical, changes, written)
        return RunResult(RunStatus.DONE, written.sorted()) to source
    }

    /**
     * Whether the source (C2) changed after [source] was read: an address book appeared, went away
     * (deleted or no longer shared), or changed its access, or an item of a book that was read was
     * added, changed or deleted. Listed from the cursors the pass saved, with the pinned SDK's own
     * stoken listings. A listing that does not finish, content that cannot be read, or any error is
     * [SourceCheck.INCOMPLETE], never "unchanged".
     */
    private fun postCheck(colMgr: CollectionManager, source: SourceRead): SourceCheck = try {
        if (sourceChanged(colMgr, source)) SourceCheck.CHANGED else SourceCheck.STABLE
    } catch (e: Exception) {
        SourceCheck.INCOMPLETE
    }

    private fun sourceChanged(colMgr: CollectionManager, source: SourceRead): Boolean {
        val removed = ArrayList<String>()
        val changes = pagedListing("incomplete-post-check", PagedListingGuard.MAX_COLLECTION_PAGES, source.inventoryCursor) { cursor ->
            colMgr.list(INVENTORY_TYPES, FetchOptions().stoken(cursor)).let { page ->
                page.removedMemberships.mapTo(removed) { it.uid() }
                Page(page.data.toList(), page.stoken, page.isDone)
            }
        }.entries
        if (removed.any { it in source.books }) return true
        val listedBooks = HashSet<String>()
        for (collection in changes) {
            if (collection.collectionType != Constants.ETEBASE_TYPE_ADDRESS_BOOK) continue
            val known = source.books[collection.uid]
            if (collection.isDeleted || known == null || known.accessLevel != collection.accessLevel) return true
            listedBooks += collection.uid
        }
        // Listed from scratch (no cursor to start from): every book read must still be listed.
        if (source.inventoryCursor == null && listedBooks != source.books.keys) return true
        for (book in source.books.values) {
            val itemChanges = listItemsFrom(colMgr.getItemManager(book.collection), "incomplete-post-check", book.cursor).entries
            for (item in itemChanges) {
                val known = book.contents[item.uid]
                // A deleted item the pass never saw live (a tombstone, or one added and removed since) changes nothing.
                if (item.isDeleted) {
                    if (known != null) return true
                    continue
                }
                if (known == null || readText { item.content } != known) return true
            }
        }
        return false
    }

    /** The contract's retired marker, in its byte form. */
    private val RETIRED_MARKER = "{\"type\":\"silentsuite.birthdays\",\"v\":1,\"state\":\"retired\"}".toByteArray(Charsets.UTF_8)

    /** A calendar's live generated items by parsed event UID, read completely; unreadable content stops the pass. */
    private fun generatedItems(itemMgr: ItemManager): LinkedHashMap<String, MutableList<Pair<Item, BirthdayCalendar.EventFields>>> {
        val generated = LinkedHashMap<String, MutableList<Pair<Item, BirthdayCalendar.EventFields>>>()
        for (item in listItems(itemMgr, "incomplete-calendar")) {
            if (item.isDeleted) continue
            val text = readText { item.content } ?: throw Stop(RunStatus.SKIPPED, "unreadable-calendar-item")
            val fields = BirthdayCalendar.eventFields(text) ?: continue
            if (!GENERATED_UID.matches(fields.uid)) continue
            generated.getOrPut(fields.uid) { ArrayList() } += item to fields
        }
        return generated
    }

    /** Marks every generated item for deletion, locally. */
    private fun deleteAll(leftovers: Map<String, List<Pair<Item, BirthdayCalendar.EventFields>>>): List<Item> =
        leftovers.values.flatten().map { (item, _) -> item.also { it.delete() } }

    /**
     * Writes [items] into [calendar] in [writeFenced] chunks. A conflict ends the pass for a fresh
     * one ([Conflict]); an unknown outcome stops the run as pending, and nothing is resent.
     */
    private fun commitFenced(itemMgr: ItemManager, calendar: Collection, items: List<Item>, written: MutableSet<String>) {
        for (chunk in items.chunked(MAX_CHUNK)) {
            // Recorded before the write: an uncertain write may still have landed.
            written += calendar.uid
            when (writeFenced(itemMgr, calendar, chunk)) {
                WriteOutcome.COMMITTED, WriteOutcome.SKIPPED -> Unit
                WriteOutcome.CONFLICT -> throw Conflict()
                WriteOutcome.UNKNOWN -> throw Stop(RunStatus.PENDING, "write-outcome-unknown")
            }
        }
    }

    private fun listItems(itemMgr: ItemManager, reason: String): List<Item> = listItemsFrom(itemMgr, reason, null).entries

    /** Every item changed after [start] (from scratch when null), and the cursor the done page gave. */
    private fun listItemsFrom(itemMgr: ItemManager, reason: String, start: String?): Listing<Item> =
        pagedListing(reason, PagedListingGuard.MAX_ITEM_PAGES, start) { cursor ->
            itemMgr.list(FetchOptions().stoken(cursor)).let { Page(it.data.toList(), it.stoken, it.isDone) }
        }

    /** Every entry of a cursor-paged listing; one that cannot finish stops the pass with [reason]. */
    private fun <T> paged(reason: String, maxPages: Int, fetch: (String?) -> Page<T>): List<T> =
        pagedListing(reason, maxPages, null, fetch).entries

    /** Every entry of a cursor-paged listing from [start], and the cursor of its done page. */
    private fun <T> pagedListing(reason: String, maxPages: Int, start: String?, fetch: (String?) -> Page<T>): Listing<T> {
        val guard = PagedListingGuard("Birthdays", start, maxPages)
        val entries = ArrayList<T>()
        var cursor: String? = start
        while (true) {
            val page = fetch(cursor)
            entries.addAll(page.data)
            try {
                guard.pageApplied(page.cursor, page.done)
            } catch (e: PagedListingStalledException) {
                throw Stop(RunStatus.SKIPPED, reason)
            }
            if (page.done) return Listing(entries, page.cursor)
            cursor = page.cursor
        }
    }

    /** Content as bytes, or null when it cannot be decrypted or is not UTF-8 text. */
    private fun readBytes(read: () -> ByteArray): ByteArray? {
        val bytes = try {
            read()
        } catch (e: EtebaseException) {
            return null
        }
        return if (strictUtf8(bytes) == null) null else bytes
    }

    private fun readText(read: () -> ByteArray): String? = readBytes(read)?.let { strictUtf8(it) }

    private fun strictUtf8(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (e: CharacterCodingException) {
        null
    }
}
