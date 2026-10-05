package io.silentsuite.sync.syncadapter

import com.etebase.client.exceptions.TemporaryServerErrorException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PagedListingGuardTest {
    private fun guard(start: String? = null, maxPages: Int = 100) = PagedListingGuard("test", start, maxPages)

    @Test fun `a listing whose cursor moves on every page runs to its end`() {
        val guard = guard()
        guard.pageApplied("s1", done = false)
        guard.pageApplied("s2", done = false)
        guard.pageApplied("s3", done = true)
    }

    @Test fun `a done page is never a stall, whatever cursor it carries`() {
        // Nothing changed since the saved cursor: the server sends that cursor back.
        guard(start = "s1").pageApplied("s1", done = true)
        // An empty listing from scratch has no cursor at all.
        guard().pageApplied(null, done = true)
        // The last page may repeat the cursor of the page before it.
        guard().apply { pageApplied("s1", done = false) }.pageApplied("s1", done = true)
        // And it may be the page that reaches the cap.
        guard(maxPages = 2).apply { pageApplied("s1", done = false) }.pageApplied("s2", done = true)
    }

    @Test fun `a page that is not done and has no cursor stops the listing`() {
        val first = assertThrows(PagedListingStalledException::class.java) { guard().pageApplied(null, done = false) }
        assertEquals("The test listing is not done but gave no cursor for the next page", first.message)

        val later = guard().apply { pageApplied("s1", done = false) }
        assertThrows(PagedListingStalledException::class.java) { later.pageApplied(null, done = false) }
    }

    @Test fun `a page that is not done and returns the cursor it was asked with stops the listing`() {
        val fromSaved = guard(start = "s1")
        val error = assertThrows(PagedListingStalledException::class.java) { fromSaved.pageApplied("s1", done = false) }
        assertEquals("The test listing is not done but repeated a cursor", error.message)

        val later = guard().apply { pageApplied("s1", done = false) }
        assertThrows(PagedListingStalledException::class.java) { later.pageApplied("s1", done = false) }
    }

    @Test fun `an earlier cursor coming back after other pages stops the listing`() {
        val guard = guard(start = "s0")
        guard.pageApplied("s1", done = false)
        guard.pageApplied("s2", done = false)
        assertThrows(PagedListingStalledException::class.java) { guard.pageApplied("s1", done = false) }

        val backToStart = guard(start = "s0").apply { pageApplied("s1", done = false) }
        assertThrows(PagedListingStalledException::class.java) { backToStart.pageApplied("s0", done = false) }
    }

    @Test fun `a listing that keeps producing new cursors stops at the page cap`() {
        val guard = guard(maxPages = 3)
        guard.pageApplied("s1", done = false)
        guard.pageApplied("s2", done = false)
        val error = assertThrows(PagedListingStalledException::class.java) { guard.pageApplied("s3", done = false) }
        assertEquals("The test listing is still not done after 3 pages", error.message)
    }

    @Test fun `each listing has its own state`() {
        // A forced collection refresh lists from the saved cursor and then again from scratch; the
        // second listing passes cursors the first one already returned.
        guard(start = "s1").apply { pageApplied("s2", done = false) }.pageApplied("s3", done = true)
        guard().apply {
            pageApplied("s1", done = false)
            pageApplied("s2", done = false)
        }.pageApplied("s3", done = true)
    }

    @Test fun `a stalled listing is a temporary server error by type`() {
        // The sync adapters retry that later without a notification, and a stalled Notes collection
        // list is recorded as a network failure. The Notes item fetch tells it apart by the subclass.
        val error = assertThrows(PagedListingStalledException::class.java) { guard().pageApplied(null, done = false) }
        assertTrue(error is TemporaryServerErrorException)
    }

    @Test fun `the page caps leave room for large accounts`() {
        // Pages hold 50 rows unless a caller asks for more, deleted rows included.
        assertEquals(1000, PagedListingGuard.MAX_COLLECTION_PAGES)
        assertTrue("a first sync of a million item rows must fit", PagedListingGuard.MAX_ITEM_PAGES * 50L >= 1_000_000L)
    }

    @Test fun `every sync listing loop is guarded after its page has been applied`() {
        // The loops themselves run only on a device (the binding's responses are native). This
        // pins where each guard sits: one per listing, created with the listing's first cursor
        // right before the loop, and asked once per page as the last step of the loop body.
        fun source(path: String) = File("src/main/java/io/silentsuite/sync/$path").readText()
        fun assertGuarded(source: String, create: String, loopStart: String, saveCursor: String, check: String, loopEnd: String) {
            val created = source.indexOf(create)
            assertTrue("the guard is created with the listing's first cursor: $create", created >= 0)
            assertEquals("one guard per listing", 1, source.split("PagedListingGuard(").size - 1)
            val loop = source.indexOf(loopStart, created)
            assertTrue("the guard is created right before the loop, not on every page",
                loop > created && source.substring(created + create.length, loop).isBlank())
            val saved = source.indexOf(saveCursor, loop)
            assertTrue("the page's cursor is saved before the guard is asked: $saveCursor", saved > loop)
            val checked = source.indexOf(check, saved)
            assertTrue("the guard is asked on every page: $check", checked > saved)
            assertEquals("the guard is asked once per page; a second call would see its own cursor as repeated",
                1, source.split("paging.pageApplied(").size - 1)
            val body = source.substring(loop, checked)
            assertEquals("the guard is asked in the loop body itself, not in a nested block or after the loop",
                1, body.count { it == '{' } - body.count { it == '}' })
            val end = source.indexOf(loopEnd, checked)
            assertTrue("the guard is the last step of the loop body",
                end > checked && source.substring(checked + check.length, end).isBlank())
        }

        assertGuarded(source("syncadapter/CollectionListRefresh.kt"),
            create = "val paging = PagedListingGuard(\"collection\", startStoken, PagedListingGuard.MAX_COLLECTION_PAGES)",
            loopStart = "while (!done) {",
            saveCursor = "colList.stoken?.let { etebaseLocalCache.saveStoken(it) }",
            check = "paging.pageApplied(stoken, done)",
            loopEnd = "}")
        assertGuarded(source("syncadapter/SyncManager.kt"),
            create = "val paging = PagedListingGuard(\"item\", stoken, PagedListingGuard.MAX_ITEM_PAGES)",
            loopStart = "do {",
            saveCursor = "etebaseLocalCache.collectionSaveStoken(cachedCollection.col.uid, stoken)",
            check = "paging.pageApplied(stoken, itemList.isDone)",
            loopEnd = "} while (!itemList!!.isDone)")
        assertGuarded(source("notes/NotesSyncRunner.kt"),
            create = "val paging = PagedListingGuard(\"notebook item\", stoken, PagedListingGuard.MAX_ITEM_PAGES)",
            loopStart = "do {",
            saveCursor = "itemList.stoken?.let { cache.collectionSaveStoken(colUid, it) }",
            check = "paging.pageApplied(stoken, itemList.isDone)",
            loopEnd = "} while (!itemList.isDone)")
    }
}
