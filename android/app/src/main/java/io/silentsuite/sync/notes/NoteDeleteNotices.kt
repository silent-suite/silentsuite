package io.silentsuite.sync.notes

import android.content.Context
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.notes.edit.NotePushPolicy.DeleteNotDone
import io.silentsuite.sync.ui.ExactAccountIdentity
import java.security.MessageDigest

/**
 * The notebook list's notice about pending deletes that a Notes run dropped without deleting the note
 * ([io.silentsuite.sync.notes.edit.NotePushStep.Result.deletesNotDone]): how many, by reason, for one exact account
 * generation, until the user dismisses it. Counts only: no note uid, title, notebook or text.
 *
 * Kept in app preferences under a SHA-256 of the account type, name and creation id, as SyncStatusStore keys an
 * identity, so a same-name account of another generation never shows this one's notice. A run adds to a count and
 * never sets it, and a dismissal takes away only what the notice showed, so a delete dropped while the notice is on
 * screen is still shown afterwards. The counts of a generation that is gone stay until app data is cleared; no screen
 * of that generation can open to show them.
 */
internal class NoteDeleteNotices(private val storage: Storage) {
    /** The preferences, read as one snapshot ([all]) and written in one step. */
    interface Storage {
        fun all(): Map<String, *>
        /** Writes [values] and removes [removed] in one commit; false when the commit failed. */
        fun write(values: Map<String, Int>, removed: Collection<String>): Boolean
    }

    /** Adds [counts] to [identity]'s notice. A write that fails is logged by its kind only; the run is not failed for it. */
    fun add(identity: ExactAccountIdentity, counts: Map<DeleteNotDone, Int>) = synchronized(LOCK) {
        val wanted = counts.filterValues { it > 0 }
        if (wanted.isEmpty()) return@synchronized
        val current = read(identity)
        val values = wanted.entries.associate { (reason, n) -> key(identity, reason) to saturated((current[reason] ?: 0).toLong() + n) }
        if (!storage.write(values, emptyList())) Logger.log.warning("A Notes delete notice could not be saved")
    }

    /** [identity]'s notice, by reason; empty when there is none. A stored value that is not a positive count is left out. */
    fun read(identity: ExactAccountIdentity): Map<DeleteNotDone, Int> = synchronized(LOCK) {
        val all = storage.all()
        DeleteNotDone.values().mapNotNull { reason ->
            (all[key(identity, reason)] as? Int)?.takeIf { it > 0 }?.let { reason to it }
        }.toMap()
    }

    /**
     * The user dismissed the notice that showed [shown]: each count goes down by what was shown, and goes once it
     * reaches zero, so a delete dropped since is still shown. False when the write failed and the notice stays.
     */
    fun dismiss(identity: ExactAccountIdentity, shown: Map<DeleteNotDone, Int>): Boolean = synchronized(LOCK) {
        val current = read(identity)
        val values = HashMap<String, Int>()
        val removed = ArrayList<String>()
        for ((reason, n) in shown) {
            val left = (current[reason] ?: 0) - n
            if (left > 0) values[key(identity, reason)] = left else removed += key(identity, reason)
        }
        storage.write(values, removed)
    }

    private fun saturated(value: Long): Int = value.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()

    companion object {
        private val LOCK = Any()
        private const val FILE = "notes_delete_notices_v1"

        fun of(context: Context): NoteDeleteNotices {
            val preferences = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            return NoteDeleteNotices(object : Storage {
                override fun all(): Map<String, *> = preferences.all
                override fun write(values: Map<String, Int>, removed: Collection<String>): Boolean = preferences.edit().run {
                    values.forEach { (k, v) -> putInt(k, v) }
                    removed.forEach { remove(it) }
                    commit()
                }
            })
        }

        /** "<SHA-256 of type, name and creation id>.<reason>": no account name in the key itself. */
        internal fun key(identity: ExactAccountIdentity, reason: DeleteNotDone): String {
            val digest = MessageDigest.getInstance("SHA-256")
                .digest("${identity.type}\u0000${identity.name}\u0000${identity.creationId}".toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            return "$digest.${reason.name}"
        }
    }
}
