package io.silentsuite.sync.ui.notes

/**
 * What an empty Notes list means. An empty local cache only says "nothing here" once a Notes sync
 * has succeeded; before that, or while one runs, the user must not be told there is nothing.
 */
internal enum class NotesEmptyState {
    /** A Notes sync is running or queued; the refresh spinner shows. */
    SYNCING,

    /** No Notes sync has succeeded for this account yet, so the cache may simply be unfilled. */
    NOT_SYNCED,

    /** The local cache could not be read. */
    FAILED,

    /** A Notes sync has succeeded and there is nothing here. */
    EMPTY;

    companion object {
        fun of(syncing: Boolean, loadFailed: Boolean, everSynced: Boolean): NotesEmptyState = when {
            // A running sync reloads when it finishes, and that result decides.
            syncing -> SYNCING
            loadFailed -> FAILED
            !everSynced -> NOT_SYNCED
            else -> EMPTY
        }

        /**
         * What the note list of one notebook says when it has no rows, or null when it says nothing. A
         * failed load leaves that screen, so only the sync states apply. After a sync, a notebook whose
         * items could not be read is not empty: the line above the list counts them, and "no notes yet"
         * would say they are gone.
         */
        fun ofNoteList(syncing: Boolean, everSynced: Boolean, unreadable: Int): NotesEmptyState? =
            of(syncing, loadFailed = false, everSynced).takeUnless { it == EMPTY && unreadable > 0 }
    }
}
