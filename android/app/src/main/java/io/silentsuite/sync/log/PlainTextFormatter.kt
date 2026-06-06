/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.log

import org.apache.commons.lang3.StringUtils
import org.apache.commons.lang3.time.DateFormatUtils
import java.util.logging.Formatter
import java.util.logging.LogRecord

class PlainTextFormatter private constructor(
        private val logcat: Boolean
): Formatter() {

    companion object {
        val LOGCAT = PlainTextFormatter(true)
        val DEFAULT = PlainTextFormatter(false)

        const val MAX_MESSAGE_LENGTH = 20000
    }

    override fun format(r: LogRecord): String {
        val builder = StringBuilder()

        if (!logcat)
            builder .append(DateFormatUtils.format(r.millis, "yyyy-MM-dd HH:mm:ss"))
                    .append(" ").append(r.threadID).append(" ")

        val className = shortClassName(r.sourceClassName)
        if (className != r.loggerName)
            builder.append("[").append(className).append("] ")

        builder.append(StringUtils.abbreviate(r.message, MAX_MESSAGE_LENGTH))

        r.thrown?.let {
            builder .append("\nEXCEPTION ")
            appendThrowable(builder, it)
        }

        r.parameters?.let {
            for ((idx, param) in it.withIndex())
                builder.append("\n\tPARAMETER #").append(idx).append(" = <redacted ").append(param?.javaClass?.simpleName ?: "null").append(">")
        }

        if (!logcat)
            builder.append("\n")

        return builder.toString()
    }

    private fun shortClassName(className: String) = className
            .replace(Regex("^at\\.bitfire\\.(dav|cert4an|dav4an|ical4an|vcard4an)droid\\."), "")
            .replace(Regex("\\$.*$"), "")

    private fun appendThrowable(builder: StringBuilder, throwable: Throwable) {
        builder.append(throwable.javaClass.name)
        for (frame in throwable.stackTrace)
            builder.append("\n\tat ").append(frame)
        for (suppressed in throwable.suppressed) {
            builder.append("\nSuppressed: ")
            appendThrowable(builder, suppressed)
        }
        throwable.cause?.let { cause ->
            builder.append("\nCaused by: ")
            appendThrowable(builder, cause)
        }
    }

}
