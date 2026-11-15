package io.silentsuite.sync.ui.notes

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.PersistableBundle

/**
 * The one way Notes text reaches the clipboard: the clip is marked sensitive (design 3.5), so Android 13 and
 * later show no preview of it in the copy notice, and keyboards that honor the flag do not offer it as a
 * suggestion. Earlier versions ignore the extra.
 */
internal object SensitiveClip {
    /** Runtime-test seam: takes the clip in place of the clipboard. Production leaves this null. */
    @Volatile internal var clipboardOverride: ((ClipData) -> Unit)? = null

    fun clipOf(label: CharSequence, text: CharSequence): ClipData = ClipData.newPlainText(label, text).apply {
        description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    }

    fun copy(context: Context, label: CharSequence, text: CharSequence) {
        val clip = clipOf(label, text)
        clipboardOverride?.let { it(clip); return }
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
        clipboard.setPrimaryClip(clip)
    }
}
