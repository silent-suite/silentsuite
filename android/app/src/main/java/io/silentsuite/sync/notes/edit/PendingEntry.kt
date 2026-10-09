package io.silentsuite.sync.notes.edit

/**
 * One note's unpushed local change. [blob] is the note item in the encrypted form the Etebase
 * cache uses (`ItemManager.cacheSaveWithContent`), so no title or text is ever stored in plain
 * text, and the item keeps its base revision for the server's conflict check.
 */
internal data class PendingEntry(
    val noteUid: String,
    val notebookUid: String,
    val state: State,
    /**
     * Moves on every local content change (save, delete, rebase), never on bookkeeping. Drawn from a
     * store-wide counter, so it only ever grows, even across a drop and a new entry for the same note.
     */
    val version: Long,
    /** The revision uid of [blob], as the item's etag reported when the blob was written. */
    val revision: String,
    /** True while the note has never been confirmed on the server (a local create). */
    val isCreate: Boolean,
    /**
     * Revision uids of ours that the server may hold as its current copy, capped at [MAX_SENT] with the
     * oldest end dropped first. Each send appends one, and a rebase puts the revision it was built on at
     * the newest end.
     */
    val sent: List<String> = emptyList(),
    val failureCount: Int = 0,
    val lastFailureAt: Long? = null,
    val lastFailureCategory: String? = null,
    /** Set on a note created from a conflict: which entry it replaced, so a crash can be finished. */
    val origin: Origin? = null,
    /** Set only in the [State.HELD] state. */
    val held: Held? = null,
    /**
     * The mark of a note made from a conflict ([PendingNotesStore.replaceWithNewNote]), set until the
     * note is known to be on the server. While it is set, another conflict with a server copy that is
     * not ours holds the text instead of making one more note (design 3.8). [origin] cannot say this:
     * it is cleared as soon as the original is gone.
     */
    val fromConflict: Boolean = false,
    val blob: ByteArray,
) {
    enum class State { UPSERT, DELETE, HELD }

    /** The replaced entry, identified by version and revision (a random uid), so it cannot be confused with a later entry. */
    data class Origin(val noteUid: String, val revision: String, val version: Long, val serverRevision: String)

    data class Held(val reason: HeldReason, val at: Long)

    init {
        require((state == State.HELD) == (held != null)) { "held details exist exactly in the HELD state" }
        require(sent.size <= MAX_SENT) { "sent list over its cap" }
    }

    /** Records [rev] as sent, oldest dropped first once the cap is reached. */
    fun withSent(rev: String): PendingEntry =
        if (sent.lastOrNull() == rev) this else copy(sent = (sent + rev).takeLast(MAX_SENT))

    /**
     * Puts [rev] at the newest end of the sent list, whether or not it was in it. The cap drops the
     * oldest end, so a revision that is moved here on every rebase is never dropped.
     */
    fun withNewestSent(rev: String): PendingEntry =
        if (sent.lastOrNull() == rev) this else copy(sent = (sent.filter { it != rev } + rev).takeLast(MAX_SENT))

    override fun equals(other: Any?): Boolean =
        other is PendingEntry && noteUid == other.noteUid && notebookUid == other.notebookUid &&
            state == other.state && version == other.version && revision == other.revision &&
            isCreate == other.isCreate && sent == other.sent && failureCount == other.failureCount &&
            lastFailureAt == other.lastFailureAt && lastFailureCategory == other.lastFailureCategory &&
            origin == other.origin && held == other.held && fromConflict == other.fromConflict &&
            blob.contentEquals(other.blob)

    override fun hashCode(): Int = noteUid.hashCode() * 31 + version.hashCode()

    companion object {
        const val MAX_SENT = 32
    }
}

/**
 * Why text is in the holding area. Entry files store the name, so a constant is never renamed. A build
 * that does not know a name cannot read that entry: it keeps the file and reports it, so a reason can
 * be added without a new format version.
 */
internal enum class HeldReason {
    READ_ONLY,
    LOST_ACCESS,
    NOTEBOOK_DELETED,
    REJECTED,
    /** A note made from a conflict was refused again with a server copy that is not ours (design 3.8). */
    REPEATED_CONFLICT,
    /**
     * The copy the change has to go onto carries metadata this app cannot write into without losing or
     * changing what another client put there: it is not one map, or it gives the title or the time more
     * than once or under a key another client reads as that field. Nothing is written over such metadata.
     */
    UNREADABLE_METADATA,
    /** The note built for the upload did not read back as it was written, so it was not sent. */
    READ_BACK_FAILED,
    /** The text could not be made into a note to upload (a conflict copy, or the change on the server's copy) for another reason. */
    NOT_BUILT,
}

/**
 * The saved item after a successful push, kept until the open editor has rebound or closed. While it
 * exists, a later save or delete of the note starts from it: the note is known to exist on the server
 * at [revision], so it is not a create, and a 409 against [revision] is our own write.
 */
internal data class LandedRecord(val noteUid: String, val revision: String, val version: Long, val blob: ByteArray) {
    override fun equals(other: Any?): Boolean =
        other is LandedRecord && noteUid == other.noteUid && revision == other.revision &&
            version == other.version && blob.contentEquals(other.blob)

    override fun hashCode(): Int = noteUid.hashCode() * 31 + revision.hashCode()
}
