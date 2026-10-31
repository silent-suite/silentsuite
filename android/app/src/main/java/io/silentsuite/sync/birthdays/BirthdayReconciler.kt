package io.silentsuite.sync.birthdays

import com.etebase.client.Collection
import com.etebase.client.Item
import com.etebase.client.ItemManager
import com.etebase.client.exceptions.ConflictException
import com.etebase.client.exceptions.ConnectionException
import com.etebase.client.exceptions.ServerErrorException
import com.etebase.client.exceptions.TemporaryServerErrorException

/**
 * The Birthdays calendar reconciler's write step. Only the fenced write is here so far; the run
 * itself (inventory, source, plan, retire, post-check) follows in its own failing-first slice.
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
     * Fresh-read reconcile of the generated Birthdays calendar for the account [etebase] signed in
     * as the SDK user [username].
     *
     * NEUTRAL SCAFFOLD (tests-only checkpoint): makes no SDK call, reads and writes nothing, and
     * reports [RunStatus.SKIPPED]. The run follows only after its hosted test RED is observed.
     */
    @Suppress("UNUSED_PARAMETER")
    fun reconcile(etebase: com.etebase.client.Account, username: String): RunResult =
        RunResult(RunStatus.SKIPPED, emptyList(), "not-implemented")
}
