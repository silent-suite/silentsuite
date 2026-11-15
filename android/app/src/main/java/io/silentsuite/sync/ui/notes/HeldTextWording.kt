package io.silentsuite.sync.ui.notes

import io.silentsuite.sync.R
import io.silentsuite.sync.notes.edit.HeldReason

/** The title and reason of one Unsynced text row, as string resources, kept apart from the view so tests can check them. */
internal object HeldTextWording {
    /** The title's resource, or null when the row's own title (or "Untitled") shows. */
    fun title(row: HeldTextRow): Int? = when {
        row.version == null -> R.string.notes_held_unreadable
        row.body == null -> R.string.notes_held_unavailable_title
        else -> null
    }

    /** Why the row is here and what can be done with it, or null when nothing needs saying. */
    fun reason(row: HeldTextRow): Int? = when {
        row.version == null && !row.canDiscard -> R.string.notes_held_unreadable_whole_store
        row.version == null -> null
        row.permitUnchecked -> R.string.notes_held_permit_unchecked
        row.discardConfirmed -> R.string.notes_held_discard_confirmed
        row.mayStillSync -> if (row.body != null) R.string.notes_held_may_still_sync else R.string.notes_held_may_still_sync_unreadable
        row.body == null -> R.string.notes_held_unavailable_reason
        row.held == null -> R.string.notes_held_not_writable
        else -> heldReason(row.held)
    }

    fun heldReason(reason: HeldReason): Int = when (reason) {
        HeldReason.READ_ONLY -> R.string.notes_held_reason_read_only
        HeldReason.LOST_ACCESS -> R.string.notes_held_reason_lost_access
        HeldReason.NOTEBOOK_DELETED -> R.string.notes_held_reason_notebook_deleted
        HeldReason.REJECTED -> R.string.notes_held_reason_rejected
        HeldReason.REPEATED_CONFLICT -> R.string.notes_held_reason_repeated_conflict
        HeldReason.UNREADABLE_METADATA -> R.string.notes_held_reason_unreadable_metadata
        HeldReason.READ_BACK_FAILED -> R.string.notes_held_reason_read_back_failed
        HeldReason.NOT_BUILT -> R.string.notes_held_reason_not_built
    }
}
