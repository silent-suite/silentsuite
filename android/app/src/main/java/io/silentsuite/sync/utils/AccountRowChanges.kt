package io.silentsuite.sync.utils

import java.util.concurrent.atomic.AtomicLong

/**
 * A counter of adds and removals of account rows of the main SilentSuite type (App.accountType), moved first by every
 * add or removal of such a row the app makes, its own included, so that a one-time removal allowance bound to a count
 * can tell that the accounts changed since (the maintainer's second reply of 2026-10-20 on #709: the counter moves
 * before every add or removal, with no exemption). Address-book rows are of another type, which such an allowance never
 * names, so they move nothing.
 *
 * It takes no lock and does no I/O, so it is safe on any thread and under any lock. It only rises, from 0 at process
 * start, and is never reset, so an old count never matches again.
 */
class AccountRowChanges {
    private val changes = AtomicLong()

    /** Moves the counter, as the first step of an add or removal of a main-type row; gives the count after it. */
    fun before(): Long = changes.incrementAndGet()

    /** The count now. */
    fun count(): Long = changes.get()

    /**
     * Moves the counter only while it still holds [expected], in one step: true at most once for a count, and false
     * once anything else has moved it, so a caller that read [expected] knows that nothing moved it in between.
     */
    fun moveIfUnchanged(expected: Long): Boolean = changes.compareAndSet(expected, expected + 1)

    companion object {
        /** The one counter of main-type rows in this process. JVM tests make their own. */
        val mainType = AccountRowChanges()
    }
}
