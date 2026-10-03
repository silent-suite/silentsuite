package io.silentsuite.sync.syncadapter

import com.etebase.client.exceptions.TemporaryServerErrorException
import io.silentsuite.sync.log.Logger

/**
 * Bounds one cursor-paged listing. The server decides when a listing is done, so a server that
 * keeps answering "not done" without a cursor, or with a cursor it already gave, would keep the
 * caller asking for pages forever. Use one instance per listing, and call [pageApplied] after each
 * page has been applied and its cursor saved, so the pages that did arrive are kept.
 *
 * A done page is never a stall: the server then repeats the cursor it was sent when nothing
 * changed, and sends none for an empty listing from scratch.
 *
 * @param startCursor the cursor of the first request, null for a listing from scratch
 */
internal class PagedListingGuard(
    private val what: String,
    startCursor: String?,
    private val maxPages: Int,
) {
    private val seen = HashSet<String>().apply { if (startCursor != null) add(startCursor) }
    private var pages = 0

    /** Throws [PagedListingStalledException] when the listing is not done and cannot go on. */
    fun pageApplied(cursor: String?, done: Boolean) {
        pages++
        if (done) return
        when {
            cursor == null -> stalled("is not done but gave no cursor for the next page")
            !seen.add(cursor) -> stalled("is not done but repeated a cursor")
            pages >= maxPages -> stalled("is still not done after $maxPages pages")
        }
    }

    private fun stalled(why: String): Nothing {
        val message = "The $what listing $why"
        // The adapters' handlers for a temporary server error log nothing.
        Logger.log.warning(message)
        throw PagedListingStalledException(message)
    }

    companion object {
        /** 50,000 collections at the server's 50 to a page, far more than an account holds. */
        const val MAX_COLLECTION_PAGES = 1000

        /**
         * Items arrive 50 to a page, deleted ones included, and a first sync of a large calendar
         * or address book needs hundreds of pages. Every page saves its cursor, so a run stopped
         * here resumes where it was.
         */
        const val MAX_ITEM_PAGES = 20_000
    }
}

/**
 * The server could not finish a listing. A temporary server error by type: the sync adapters
 * retry later without a notification, and a Notes run whose collection list stalls records a
 * network failure. The Notes item fetch checks for it first (NotesSyncRunner.notebookFailure):
 * only that notebook fails, and the other notebooks still sync.
 */
internal class PagedListingStalledException(message: String) : TemporaryServerErrorException(message)
