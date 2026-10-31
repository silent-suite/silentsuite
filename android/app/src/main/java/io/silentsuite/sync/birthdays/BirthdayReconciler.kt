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
 * The Birthdays calendar reconciler: the fenced write step and one basic fresh-read pass
 * ([reconcile]). Updating stale events, removing duplicates, retiring extra calendars, the
 * post-commit source check, retries and the trigger controller are not here yet; a pass that
 * meets one of them reports [RunStatus.PENDING] instead of [RunStatus.DONE].
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
     * - the destination (C3): the calendar with the active marker, Admin access and a fully paged
     *   member list that is exactly [username]; none is [RunStatus.SKIPPED], and a calendar is never
     *   created or adopted by its name;
     * - the source (C2): every listed address book at any access level, every item fully paged.
     * A listing that does not finish, or content that cannot be decrypted or is not UTF-8, ends the
     * pass with [RunStatus.SKIPPED] and nothing written: it is never evidence that something is gone.
     *
     * Then missing events are created and generated events (parsed `ss-bday1-` UID) whose contact
     * is gone are deleted, in [writeFenced] chunks fenced on the calendar root as this pass read it.
     * Other items and calendars are never touched. A conflict or unknown write outcome is
     * [RunStatus.PENDING] (nothing is resent); so is a pass that needs an update, a duplicate
     * removal or a retirement, which are not handled yet. [RunResult.written] lists the calendar
     * whenever a write was attempted.
     */
    fun reconcile(etebase: com.etebase.client.Account, username: String): RunResult {
        val written = LinkedHashSet<String>()
        return try {
            pass(etebase.collectionManager, username, written)
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

    private class Page<T>(val data: List<T>, val cursor: String?, val done: Boolean)

    private fun pass(colMgr: CollectionManager, username: String, written: MutableSet<String>): RunResult {
        val inventory = paged("incomplete-inventory", PagedListingGuard.MAX_COLLECTION_PAGES) { cursor ->
            colMgr.list(INVENTORY_TYPES, FetchOptions().stoken(cursor)).let { Page(it.data.toList(), it.stoken, it.isDone) }
        }
        val calendars = ArrayList<Collection>()
        val books = ArrayList<Collection>()
        for (collection in inventory) {
            if (collection.isDeleted) continue
            when (collection.collectionType) {
                Constants.ETEBASE_TYPE_CALENDAR -> calendars += collection
                Constants.ETEBASE_TYPE_ADDRESS_BOOK -> books += collection
            }
        }

        // C3: marked calendars that are Admin and whose complete member list is exactly this user.
        val active = ArrayList<Collection>()
        var retired = false
        for (calendar in calendars) {
            val content = readBytes { calendar.content } ?: throw Stop(RunStatus.SKIPPED, "unreadable-calendar")
            val state = BirthdayCalendar.markerState(content) ?: continue
            if (calendar.accessLevel != CollectionAccessLevel.Admin) continue
            val memberManager = colMgr.getMemberManager(calendar)
            val members = paged("incomplete-members", PagedListingGuard.MAX_COLLECTION_PAGES) { cursor ->
                memberManager.list(FetchOptions().iterator(cursor)).let { page -> Page(page.data.map { it.username }, page.stoken, page.isDone) }
            }
            if (members != listOf(username)) continue
            if (state == BirthdayCalendar.MarkerState.ACTIVE) active += calendar else retired = true
        }
        if (active.isEmpty()) throw Stop(RunStatus.SKIPPED, "no-active-calendar")
        if (active.size > 1) throw Stop(RunStatus.PENDING, "duplicate-active-calendars")
        val canonical = active.single()

        // The destination, read completely: generated items by their parsed event UID.
        val itemMgr = colMgr.getItemManager(canonical)
        val generated = LinkedHashMap<String, MutableList<Pair<Item, BirthdayCalendar.EventFields>>>()
        for (item in listItems(itemMgr, "incomplete-calendar")) {
            if (item.isDeleted) continue
            val text = readText { item.content } ?: throw Stop(RunStatus.SKIPPED, "unreadable-calendar-item")
            val fields = BirthdayCalendar.eventFields(text) ?: continue
            if (!GENERATED_UID.matches(fields.uid)) continue
            generated.getOrPut(fields.uid) { ArrayList() } += item to fields
        }

        // C2: every listed address book, every contact, read completely.
        val wanted = TreeMap<String, BirthdayCalendar.BirthdayEvent>()
        for (book in books) {
            for (item in listItems(colMgr.getItemManager(book), "incomplete-book")) {
                if (item.isDeleted) continue
                val text = readText { item.content } ?: throw Stop(RunStatus.SKIPPED, "unreadable-contact")
                val birthday = BirthdayCalendar.birthdayOf(text) ?: continue
                val uid = BirthdayCalendar.eventUid(book.uid, item.uid)
                wanted[uid] = BirthdayCalendar.BirthdayEvent(uid, birthday.name, birthday.month, birthday.day)
            }
        }

        val deferred = LinkedHashSet<String>()
        if (retired) deferred += "retired-calendars-deferred"
        val changes = ArrayList<Item>()
        for ((uid, copies) in generated) {
            val event = wanted[uid]
            if (event == null) {
                // Its contact is gone from a complete source: every copy goes.
                for ((item, _) in copies) {
                    item.delete()
                    changes += item
                }
            } else if (copies.size > 1) {
                deferred += "duplicate-events-deferred"
            } else if (copies[0].second != BirthdayCalendar.fieldsOf(event)) {
                deferred += "update-deferred"
            }
        }
        val now = System.currentTimeMillis()
        for (event in wanted.values) {
            if (event.uid in generated) continue
            val meta = ItemMetadata().apply {
                name = event.uid
                mtime = now
            }
            changes += itemMgr.create(meta, BirthdayCalendar.eventIcs(event).toByteArray(Charsets.UTF_8))
        }

        for (chunk in changes.chunked(MAX_CHUNK)) {
            // Recorded before the write: an uncertain write may still have landed.
            written += canonical.uid
            when (writeFenced(itemMgr, canonical, chunk)) {
                WriteOutcome.COMMITTED, WriteOutcome.SKIPPED -> Unit
                WriteOutcome.CONFLICT -> throw Stop(RunStatus.PENDING, "conflict")
                WriteOutcome.UNKNOWN -> throw Stop(RunStatus.PENDING, "write-outcome-unknown")
            }
        }
        if (deferred.isNotEmpty()) return RunResult(RunStatus.PENDING, written.sorted(), deferred.joinToString(","))
        return RunResult(RunStatus.DONE, written.sorted())
    }

    private fun listItems(itemMgr: ItemManager, reason: String): List<Item> =
        paged(reason, PagedListingGuard.MAX_ITEM_PAGES) { cursor ->
            itemMgr.list(FetchOptions().stoken(cursor)).let { Page(it.data.toList(), it.stoken, it.isDone) }
        }

    /** Every entry of a cursor-paged listing; one that cannot finish stops the pass with [reason]. */
    private fun <T> paged(reason: String, maxPages: Int, fetch: (String?) -> Page<T>): List<T> {
        val guard = PagedListingGuard("Birthdays", null, maxPages)
        val entries = ArrayList<T>()
        var cursor: String? = null
        while (true) {
            val page = fetch(cursor)
            entries.addAll(page.data)
            try {
                guard.pageApplied(page.cursor, page.done)
            } catch (e: PagedListingStalledException) {
                throw Stop(RunStatus.SKIPPED, reason)
            }
            if (page.done) return entries
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
