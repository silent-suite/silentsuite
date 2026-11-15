package io.silentsuite.sync.ui.notes

import android.content.Context
import android.util.AttributeSet
import androidx.appcompat.widget.AppCompatEditText
import io.silentsuite.sync.R

/**
 * The note editor's text field. Its own Cut and Copy go through [SensitiveClip], as the editor's Copy button does,
 * so note text never reaches the clipboard without the sensitive mark. Every other action is the platform's.
 */
internal class SensitiveEditText @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = androidx.appcompat.R.attr.editTextStyle,
) : AppCompatEditText(context, attrs, defStyleAttr) {

    override fun onTextContextMenuItem(id: Int): Boolean {
        if (id != android.R.id.copy && id != android.R.id.cut) return super.onTextContextMenuItem(id)
        val text = text ?: return true
        val start = minOf(selectionStart, selectionEnd).coerceAtLeast(0)
        val end = maxOf(selectionStart, selectionEnd).coerceAtLeast(0)
        if (start == end) return true
        SensitiveClip.copy(context, context.getString(R.string.notes_held_clip_label), text.subSequence(start, end).toString())
        // A cut is an edit like any other: the field's watcher records it, so it is saved and can be undone.
        if (id == android.R.id.cut) text.delete(start, end)
        return true
    }
}
