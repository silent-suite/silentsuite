package io.silentsuite.sync.dataexport

import android.content.Context
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

enum class AndroidExportKind(
    val displayName: String,
    val mimeType: String,
    val fileName: String,
) {
    CALENDAR("Calendar (.ics)", "text/calendar", "calendar.ics"),
    TASKS("Tasks (.ics)", "text/calendar", "tasks.ics"),
    CONTACTS("Contacts (.vcf)", "text/vcard", "contacts.vcf"),
    EVERYTHING("Everything (.zip)", "application/zip", "silentsuite-export.zip"),
}

object AndroidDataExporter {
    fun suggestedFileName(kind: AndroidExportKind): String {
        val date = SimpleDateFormat("yyyyMMdd", Locale.US).format(Date())
        val extensionStart = kind.fileName.lastIndexOf('.')
        return if (extensionStart >= 0) {
            kind.fileName.substring(0, extensionStart) + "-$date" + kind.fileName.substring(extensionStart)
        } else {
            kind.fileName + "-$date"
        }
    }

    fun writeExport(
        context: Context,
        account: android.accounts.Account,
        kind: AndroidExportKind,
        outputStream: OutputStream,
    ) {
        val settings = AccountSettings(context, account)
        val cache = EtebaseLocalCache.getInstance(context, account.name)
        val etebase = EtebaseLocalCache.getEtebase(context, HttpClient.sharedClient, settings)
        val collectionManager = etebase.collectionManager

        val exportData = synchronized(cache) {
            when (kind) {
                AndroidExportKind.CALENDAR -> calendarData(cache, collectionManager, Constants.ETEBASE_TYPE_CALENDAR)
                AndroidExportKind.TASKS -> calendarData(cache, collectionManager, Constants.ETEBASE_TYPE_TASKS)
                AndroidExportKind.CONTACTS -> contactData(cache, collectionManager)
                AndroidExportKind.EVERYTHING -> ExportData(
                    calendar = calendarData(cache, collectionManager, Constants.ETEBASE_TYPE_CALENDAR),
                    tasks = calendarData(cache, collectionManager, Constants.ETEBASE_TYPE_TASKS),
                    contacts = contactData(cache, collectionManager)
                )
            }
        }

        if (kind == AndroidExportKind.EVERYTHING) {
            val zipData = exportData as ExportData
            ZipOutputStream(outputStream).use { zip ->
                zip.writestr("calendar.ics", zipData.calendar)
                zip.writestr("tasks.ics", zipData.tasks)
                zip.writestr("contacts.vcf", zipData.contacts)
            }
        } else {
            OutputStreamWriter(outputStream, StandardCharsets.UTF_8).use { writer ->
                writer.write(exportData as String)
            }
        }
    }

    private data class ExportData(val calendar: String, val tasks: String, val contacts: String)

    private fun calendarData(cache: EtebaseLocalCache, collectionManager: com.etebase.client.CollectionManager, type: String): String {
        val body = cache.collectionList(collectionManager)
            .filter { it.collectionType == type }
            .flatMap { collection ->
                val itemManager = collectionManager.getItemManager(collection.col)
                cache.itemList(itemManager, collection.col.uid).map { it.content }
            }
            .joinToString("\r\n") { calendarBody(it) }

        return buildString {
            append("BEGIN:VCALENDAR\r\n")
            append("VERSION:2.0\r\n")
            append("PRODID:").append(Constants.PRODID_BASE).append(" Android export\r\n")
            if (body.isNotBlank()) {
                append(body.trim())
                append("\r\n")
            }
            append("END:VCALENDAR\r\n")
        }
    }

    private fun contactData(cache: EtebaseLocalCache, collectionManager: com.etebase.client.CollectionManager): String {
        return cache.collectionList(collectionManager)
            .filter { it.collectionType == Constants.ETEBASE_TYPE_ADDRESS_BOOK }
            .flatMap { collection ->
                val itemManager = collectionManager.getItemManager(collection.col)
                cache.itemList(itemManager, collection.col.uid).map { it.content.trim() }
            }
            .filter { it.isNotBlank() }
            .joinToString("\r\n") { it }
            .let { if (it.isBlank()) "" else "$it\r\n" }
    }

    private fun calendarBody(content: String): String {
        return content
            .replace("\r\n", "\n")
            .replace("\r", "\n")
            .lineSequence()
            .filterNot { line ->
                val upper = line.uppercase(Locale.US)
                upper == "BEGIN:VCALENDAR" ||
                    upper == "END:VCALENDAR" ||
                    upper.startsWith("VERSION:") ||
                    upper.startsWith("PRODID:")
            }
            .joinToString("\r\n")
            .trim()
    }

    private fun ZipOutputStream.writestr(name: String, content: String) {
        putNextEntry(ZipEntry(name))
        write(content.toByteArray(StandardCharsets.UTF_8))
        closeEntry()
    }
}
