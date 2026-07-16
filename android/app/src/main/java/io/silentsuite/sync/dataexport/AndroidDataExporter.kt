package io.silentsuite.sync.dataexport

import android.content.Context
import android.accounts.Account
import android.accounts.AccountManager
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.ui.setup.ExactAccountRouting
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
        return datedFileName(kind.fileName)
    }

    fun collectionMimeType(collectionType: String): String {
        return when (collectionType) {
            Constants.ETEBASE_TYPE_CALENDAR, Constants.ETEBASE_TYPE_TASKS -> "text/calendar"
            Constants.ETEBASE_TYPE_ADDRESS_BOOK -> "text/vcard"
            else -> "text/plain"
        }
    }

    fun suggestedCollectionFileName(collectionType: String, displayName: String?): String {
        val fallback = when (collectionType) {
            Constants.ETEBASE_TYPE_CALENDAR -> "calendar"
            Constants.ETEBASE_TYPE_TASKS -> "tasks"
            Constants.ETEBASE_TYPE_ADDRESS_BOOK -> "contacts"
            else -> "collection"
        }
        val extension = when (collectionType) {
            Constants.ETEBASE_TYPE_CALENDAR, Constants.ETEBASE_TYPE_TASKS -> ".ics"
            Constants.ETEBASE_TYPE_ADDRESS_BOOK -> ".vcf"
            else -> ".txt"
        }
        val baseName = displayName
            ?.trim()
            ?.replace(Regex("[^A-Za-z0-9._-]+"), "-")
            ?.trim('-', '.', '_')
            ?.takeIf { it.isNotBlank() }
            ?: fallback
        return datedFileName("$baseName$extension")
    }

    fun writeCollectionExport(
        context: Context,
        account: Account,
        creationId: String,
        collectionType: String,
        itemContents: List<String>,
        outputStream: OutputStream,
    ): Boolean {
        require(creationId.isNotBlank()) { "Creation ID must be nonblank" }
        fun exactGenerationStillCurrent() = ExactAccountRouting.validate(
            account, creationId, App.accountType, AccountManager.get(context)
        ) != null
        if (!exactGenerationStillCurrent()) return false
        val exportData = when (collectionType) {
            Constants.ETEBASE_TYPE_CALENDAR, Constants.ETEBASE_TYPE_TASKS -> calendarData(itemContents)
            Constants.ETEBASE_TYPE_ADDRESS_BOOK -> contactData(itemContents)
            else -> itemContents.filter { it.isNotBlank() }.joinToString("\r\n")
        }
        if (!exactGenerationStillCurrent()) return false
        OutputStreamWriter(outputStream, StandardCharsets.UTF_8).use { writer ->
            if (!exactGenerationStillCurrent()) return false
            writer.write(exportData)
        }
        return exactGenerationStillCurrent()
    }

    fun writeExport(
        context: Context,
        account: Account,
        creationId: String,
        kind: AndroidExportKind,
        outputStream: OutputStream,
    ) {
        require(creationId.isNotBlank()) { "Creation ID must be nonblank" }
        fun exactGenerationStillCurrent() = ExactAccountRouting.validate(
            account, creationId, App.accountType, AccountManager.get(context)
        ) != null
        if (!exactGenerationStillCurrent()) return
        val settings = AccountSettings(context, account)
        if (!exactGenerationStillCurrent()) return
        val cache = EtebaseLocalCache.getInstance(context, account.name)
        if (!exactGenerationStillCurrent()) return
        val etebase = EtebaseLocalCache.getEtebase(context, HttpClient.sharedClient, settings)
        if (!exactGenerationStillCurrent()) return
        val collectionManager = etebase.collectionManager

        if (!exactGenerationStillCurrent()) return
        val exportData = synchronized(cache) {
            if (!exactGenerationStillCurrent()) return@synchronized null
            when (kind) {
                AndroidExportKind.CALENDAR -> calendarData(cache, collectionManager,
                    Constants.ETEBASE_TYPE_CALENDAR, ::exactGenerationStillCurrent)
                AndroidExportKind.TASKS -> calendarData(cache, collectionManager,
                    Constants.ETEBASE_TYPE_TASKS, ::exactGenerationStillCurrent)
                AndroidExportKind.CONTACTS -> contactData(cache, collectionManager, ::exactGenerationStillCurrent)
                AndroidExportKind.EVERYTHING -> {
                    val calendar = calendarData(cache, collectionManager,
                        Constants.ETEBASE_TYPE_CALENDAR, ::exactGenerationStillCurrent)
                        ?: return@synchronized null
                    val tasks = calendarData(cache, collectionManager,
                        Constants.ETEBASE_TYPE_TASKS, ::exactGenerationStillCurrent)
                        ?: return@synchronized null
                    val contacts = contactData(cache, collectionManager, ::exactGenerationStillCurrent)
                        ?: return@synchronized null
                    ExportData(calendar, tasks, contacts)
                }
            }
        }
        if (exportData == null || !exactGenerationStillCurrent()) return

        if (kind == AndroidExportKind.EVERYTHING) {
            val zipData = exportData as ExportData
            if (!exactGenerationStillCurrent()) return
            ZipOutputStream(outputStream).use { zip ->
                if (!exactGenerationStillCurrent()) return
                zip.writestr("calendar.ics", zipData.calendar)
                if (!exactGenerationStillCurrent()) return
                zip.writestr("tasks.ics", zipData.tasks)
                if (!exactGenerationStillCurrent()) return
                zip.writestr("contacts.vcf", zipData.contacts)
            }
        } else {
            if (!exactGenerationStillCurrent()) return
            OutputStreamWriter(outputStream, StandardCharsets.UTF_8).use { writer ->
                if (!exactGenerationStillCurrent()) return
                writer.write(exportData as String)
            }
        }
    }

    private data class ExportData(val calendar: String, val tasks: String, val contacts: String)

    private fun datedFileName(fileName: String): String {
        val date = SimpleDateFormat("yyyyMMdd", Locale.US).format(Date())
        val extensionStart = fileName.lastIndexOf('.')
        return if (extensionStart >= 0) {
            fileName.substring(0, extensionStart) + "-$date" + fileName.substring(extensionStart)
        } else {
            fileName + "-$date"
        }
    }

    private fun calendarData(
        cache: EtebaseLocalCache,
        collectionManager: com.etebase.client.CollectionManager,
        type: String,
        exactGenerationStillCurrent: () -> Boolean,
    ): String? {
        if (!exactGenerationStillCurrent()) return null
        val collections = cache.collectionList(collectionManager)
        if (!exactGenerationStillCurrent()) return null
        val contents = mutableListOf<String>()
        for (collection in collections.filter { it.collectionType == type }) {
            if (!exactGenerationStillCurrent()) return null
            val itemManager = collectionManager.getItemManager(collection.col)
            if (!exactGenerationStillCurrent()) return null
            contents += cache.itemList(itemManager, collection.col.uid).map { it.content }
            if (!exactGenerationStillCurrent()) return null
        }
        return calendarData(contents)
    }

    private fun calendarData(itemContents: List<String>): String {
        val body = itemContents
            .map { calendarBody(it) }
            .filter { it.isNotBlank() }
            .joinToString("\r\n")

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

    private fun contactData(
        cache: EtebaseLocalCache,
        collectionManager: com.etebase.client.CollectionManager,
        exactGenerationStillCurrent: () -> Boolean,
    ): String? {
        if (!exactGenerationStillCurrent()) return null
        val collections = cache.collectionList(collectionManager)
        if (!exactGenerationStillCurrent()) return null
        val contents = mutableListOf<String>()
        for (collection in collections.filter { it.collectionType == Constants.ETEBASE_TYPE_ADDRESS_BOOK }) {
            if (!exactGenerationStillCurrent()) return null
            val itemManager = collectionManager.getItemManager(collection.col)
            if (!exactGenerationStillCurrent()) return null
            contents += cache.itemList(itemManager, collection.col.uid).map { it.content.trim() }
            if (!exactGenerationStillCurrent()) return null
        }
        return contactData(contents)
    }

    private fun contactData(itemContents: List<String>): String {
        return itemContents
            .map { it.trim() }
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
