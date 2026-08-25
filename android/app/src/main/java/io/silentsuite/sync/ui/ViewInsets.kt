package io.silentsuite.sync.ui

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Adds unclaimed system-bar and optional IME insets to this view's inflated padding. */
internal fun View.applySystemBarInsetsAsPadding(
    left: Boolean = true,
    top: Boolean = true,
    right: Boolean = true,
    bottom: Boolean = true,
    includeIme: Boolean = false,
) {
    val basePaddingLeft = paddingLeft
    val basePaddingTop = paddingTop
    val basePaddingRight = paddingRight
    val basePaddingBottom = paddingBottom
    val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or
        (if (includeIme) WindowInsetsCompat.Type.ime() else 0)

    ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets ->
        val applied = insets.getInsets(types)
        view.setPadding(
            basePaddingLeft + if (left) applied.left else 0,
            basePaddingTop + if (top) applied.top else 0,
            basePaddingRight + if (right) applied.right else 0,
            basePaddingBottom + if (bottom) applied.bottom else 0,
        )
        insets
    }
    requestApplyInsetsWhenAttached()
}

/** Requests insets immediately when attached, or once after the next attachment. */
internal fun View.requestApplyInsetsWhenAttached() {
    if (ViewCompat.isAttachedToWindow(this)) {
        ViewCompat.requestApplyInsets(this)
    } else {
        addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(view: View) {
                view.removeOnAttachStateChangeListener(this)
                ViewCompat.requestApplyInsets(view)
            }

            override fun onViewDetachedFromWindow(view: View) = Unit
        })
    }
}
