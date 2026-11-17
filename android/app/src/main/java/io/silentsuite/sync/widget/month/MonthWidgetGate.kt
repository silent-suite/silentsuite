/* SPDX-License-Identifier: GPL-3.0-only */
package io.silentsuite.sync.widget.month

import android.content.Context

/** Temporary preview stand-in. Replace with the shared Experimental gate before integration. */
internal object MonthWidgetGate {
    @Suppress("UNUSED_PARAMETER")
    fun areWidgetsEnabled(context: Context): Boolean = true
}
