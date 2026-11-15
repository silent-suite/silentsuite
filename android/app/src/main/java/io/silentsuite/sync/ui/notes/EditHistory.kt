package io.silentsuite.sync.ui.notes

/**
 * One text field's undo and redo steps, in memory only. The field's TextWatcher records each change the user makes; a
 * change the screen makes itself is not recorded. Typing is grouped into steps: a pause, the start of a new word, a
 * paste, a deletion after typing (or the other way round) and a change somewhere else each end one. A keyboard that
 * rewrites the word it is composing records only what it added or removed.
 *
 * At most [maxSteps] steps and [maxChars] characters are kept, undo and redo steps together, and the oldest undo steps
 * go first; the newest step always stays, so a large deletion can still be undone. A step is applied only over the text
 * it was recorded against. Otherwise the history is cleared and nothing changes, so a step can never write text from
 * another version of the note.
 */
internal class EditHistory(
    private val maxSteps: Int = 200,
    private val maxChars: Int = 1_000_000,
    private val pauseMillis: Long = 1_000,
) {
    /** At [start], [removed] was replaced by [inserted]. A [sealed] step takes nothing more into it. */
    private data class Step(val start: Int, val removed: String, val inserted: String, val at: Long, val sealed: Boolean) {
        val size: Int get() = removed.length + inserted.length
    }

    /** What an undo or a redo leaves: the field's new text and where the cursor goes. */
    data class Applied(val text: String, val cursor: Int)

    private val undo = ArrayDeque<Step>()
    private val redo = ArrayDeque<Step>()
    private var chars = 0

    val canUndo: Boolean get() = undo.isNotEmpty()
    val canRedo: Boolean get() = redo.isNotEmpty()

    /** The user replaced [removed] at [start] with [inserted]. New typing drops the redo steps. */
    fun record(start: Int, removed: CharSequence, inserted: CharSequence, now: Long) {
        // A keyboard that rewrites its composing word sends the whole word each time: keep only what changed.
        val r = removed.toString()
        val i = inserted.toString()
        var prefix = 0
        while (prefix < r.length && prefix < i.length && r[prefix] == i[prefix]) prefix++
        var suffix = 0
        while (suffix < r.length - prefix && suffix < i.length - prefix && r[r.length - 1 - suffix] == i[i.length - 1 - suffix]) suffix++
        val gone = r.substring(prefix, r.length - suffix)
        val added = i.substring(prefix, i.length - suffix)
        if (gone.isEmpty() && added.isEmpty()) return
        val at = start + prefix
        while (redo.isNotEmpty()) chars -= redo.removeLast().size
        val last = undo.lastOrNull()
        val merged = last?.let { merge(it, at, gone, added, now) }
        if (merged != null) {
            chars -= undo.removeLast().size
            push(merged)
        } else {
            // A paste, or a deletion of more than one character, is a step of its own.
            push(Step(at, gone, added, now, sealed = added.length > 1 || gone.length > 1))
        }
        trim()
    }

    /** Reverts the newest step in [text], or null when there is none, or when [text] is not what it was recorded on. */
    fun undo(text: String): Applied? {
        val step = undo.lastOrNull() ?: return null
        if (!text.regionMatches(step.start, step.inserted, 0, step.inserted.length) || step.start + step.inserted.length > text.length) {
            clear()
            return null
        }
        undo.removeLast()
        redo.addLast(step.copy(sealed = true))
        sealLast()
        return Applied(text.replaceRange(step.start, step.start + step.inserted.length, step.removed), step.start + step.removed.length)
    }

    /** Applies again the newest step an undo reverted, or null as for [undo]. */
    fun redo(text: String): Applied? {
        val step = redo.lastOrNull() ?: return null
        if (!text.regionMatches(step.start, step.removed, 0, step.removed.length) || step.start + step.removed.length > text.length) {
            clear()
            return null
        }
        redo.removeLast()
        undo.addLast(step.copy(sealed = true))
        return Applied(text.replaceRange(step.start, step.start + step.removed.length, step.inserted), step.start + step.inserted.length)
    }

    /** Forgets every step: the field now holds another version of the text. */
    fun clear() {
        undo.clear()
        redo.clear()
        chars = 0
    }

    private fun merge(last: Step, start: Int, gone: String, added: String, now: Long): Step? {
        if (last.sealed || now - last.at > pauseMillis) return null
        // Typing on at the end of the step, until a new word starts.
        if (gone.isEmpty() && added.length == 1 && last.inserted.isNotEmpty() && start == last.start + last.inserted.length) {
            val newWord = !added[0].isWhitespace() && last.inserted.last().isWhitespace()
            return if (newWord) null else last.copy(inserted = last.inserted + added, at = now)
        }
        // Deleting on, one character at a time, backward or forward.
        if (added.isEmpty() && gone.length == 1 && last.inserted.isEmpty()) {
            if (start + 1 == last.start) return Step(start, gone + last.removed, "", now, sealed = false)
            if (start == last.start) return last.copy(removed = last.removed + gone, at = now)
        }
        return null
    }

    private fun push(step: Step) {
        undo.addLast(step)
        chars += step.size
    }

    /** New typing after an undo starts a step of its own. */
    private fun sealLast() {
        val last = undo.removeLastOrNull() ?: return
        undo.addLast(last.copy(sealed = true))
    }

    private fun trim() {
        while ((undo.size + redo.size > maxSteps || chars > maxChars) && undo.size > 1) chars -= undo.removeFirst().size
    }
}
