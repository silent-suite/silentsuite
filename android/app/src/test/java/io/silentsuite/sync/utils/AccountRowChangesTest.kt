package io.silentsuite.sync.utils

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class AccountRowChangesTest {
    @Test fun `a compare holds once for a count, and never after any other move`() {
        val rows = AccountRowChanges()
        assertEquals(0L, rows.count())
        assertEquals(1L, rows.before())
        val seen = rows.count()
        assertTrue("nothing moved it since", rows.moveIfUnchanged(seen))
        assertEquals("the compare is a move of its own", seen + 1, rows.count())
        assertFalse("once", rows.moveIfUnchanged(seen))
        val again = rows.count()
        rows.before()
        assertFalse("an add or removal in between", rows.moveIfUnchanged(again))
        assertEquals(again + 1, rows.count())
        // Each instance counts alone, so the process's own is never moved by a test's.
        assertEquals(0L, AccountRowChanges().count())
    }

    @Test fun `under concurrent moves no compare holds twice for one count, and no move is lost`() {
        val rows = AccountRowChanges()
        val moves = 20_000
        val held = Collections.synchronizedList(ArrayList<Long>())
        val start = CountDownLatch(1)
        val movers = (1..3).map {
            thread { start.await(); repeat(moves) { rows.before() } }
        }
        val comparers = (1..3).map {
            thread {
                start.await()
                repeat(moves) {
                    val seen = rows.count()
                    if (rows.moveIfUnchanged(seen)) held += seen
                }
            }
        }
        start.countDown()
        (movers + comparers).forEach { it.join(TimeUnit.MINUTES.toMillis(1)) }
        assertTrue("every thread ended", (movers + comparers).none { it.isAlive })
        assertEquals("no two compares held for one count", held.size, held.toSet().size)
        assertEquals("every move counted once", 3L * moves + held.size, rows.count())
    }
}
