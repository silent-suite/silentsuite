package io.silentsuite.sync.birthdays

import com.etebase.client.Collection
import com.etebase.client.Item
import com.etebase.client.ItemManager

/**
 * The Birthdays calendar reconciler.
 *
 * NEUTRAL SCAFFOLD (S4 tests-only checkpoint): only the typed outcome and the signature the
 * runtime tests compile against. It makes no SDK call, writes nothing and has no trigger; the
 * fenced write (items sent with the calendar's root item as their dependency) follows only after
 * the hosted test RED is observed.
 */
object BirthdayReconciler {
    enum class WriteOutcome { COMMITTED, CONFLICT, UNKNOWN, SKIPPED }

    /** Writes [items] into [calendar] fenced on the calendar's current root revision. */
    @Suppress("UNUSED_PARAMETER")
    fun writeFenced(itemManager: ItemManager, calendar: Collection, items: List<Item>): WriteOutcome = WriteOutcome.SKIPPED
}
