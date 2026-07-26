package io.silentsuite.sync.dataexport

import android.content.Context
import android.accounts.Account
import android.accounts.AccountManager
import android.net.Uri
import android.provider.DocumentsContract
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.ui.setup.ExactAccountRouting
import java.io.File
import java.io.IOException
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
        destination: Uri,
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
        return stageAndCommit(context, destination, ::exactGenerationStillCurrent) { outputStream ->
            if (!exactGenerationStillCurrent()) return@stageAndCommit false
            OutputStreamWriter(outputStream, StandardCharsets.UTF_8).use { writer ->
                if (!exactGenerationStillCurrent()) return@stageAndCommit false
                writer.write(exportData)
            }
            exactGenerationStillCurrent()
        }
    }

    fun writeExport(
        context: Context,
        account: Account,
        creationId: String,
        kind: AndroidExportKind,
        destination: Uri,
    ): Boolean {
        require(creationId.isNotBlank()) { "Creation ID must be nonblank" }
        fun exactGenerationStillCurrent() = ExactAccountRouting.validate(
            account, creationId, App.accountType, AccountManager.get(context)
        ) != null
        if (!exactGenerationStillCurrent()) return false
        val settings = AccountSettings(context, account)
        if (!exactGenerationStillCurrent()) return false
        val cache = EtebaseLocalCache.getInstance(context, account.name)
        if (!exactGenerationStillCurrent()) return false
        val etebase = EtebaseLocalCache.getEtebase(context, HttpClient.sharedClient, settings)
        if (!exactGenerationStillCurrent()) return false
        val collectionManager = etebase.collectionManager

        if (!exactGenerationStillCurrent()) return false
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
        if (exportData == null || !exactGenerationStillCurrent()) return false

        return stageAndCommit(context, destination, ::exactGenerationStillCurrent) { outputStream ->
            if (kind == AndroidExportKind.EVERYTHING) {
                val zipData = exportData as ExportData
                if (!exactGenerationStillCurrent()) return@stageAndCommit false
                ZipOutputStream(outputStream).use { zip ->
                    if (!exactGenerationStillCurrent()) return@stageAndCommit false
                    zip.writestr("calendar.ics", zipData.calendar)
                    if (!exactGenerationStillCurrent()) return@stageAndCommit false
                    zip.writestr("tasks.ics", zipData.tasks)
                    if (!exactGenerationStillCurrent()) return@stageAndCommit false
                    zip.writestr("contacts.vcf", zipData.contacts)
                }
            } else {
                if (!exactGenerationStillCurrent()) return@stageAndCommit false
                OutputStreamWriter(outputStream, StandardCharsets.UTF_8).use { writer ->
                    if (!exactGenerationStillCurrent()) return@stageAndCommit false
                    writer.write(exportData as String)
                }
            }
            exactGenerationStillCurrent()
        }
    }

    private fun stageAndCommit(
        context: Context,
        destination: Uri,
        exactGenerationStillCurrent: () -> Boolean,
        writeStage: (OutputStream) -> Boolean,
    ): Boolean {
        if (!exactGenerationStillCurrent()) return false
        val stagedFile = File.createTempFile("silentsuite-export-", ".tmp", context.cacheDir)
        try {
            val staged = stagedFile.outputStream().use(writeStage)
            if (!staged || !exactGenerationStillCurrent()) return false
            return commitStagedExport(
                stagedFile = stagedFile,
                openDestination = {
                    context.contentResolver.openOutputStream(destination, "wt")
                        ?: throw IOException("Could not open export destination")
                },
                clearDestination = { clearExportDestination(context, destination) },
                exactGenerationStillCurrent = exactGenerationStillCurrent,
            )
        } finally {
            runCatching { stagedFile.outputStream().use { } }
            stagedFile.delete()
        }
    }

    internal fun commitStagedExport(
        stagedFile: File,
        openDestination: () -> OutputStream,
        clearDestination: () -> Unit,
        exactGenerationStillCurrent: () -> Boolean,
    ): Boolean {
        var committed = false
        var destinationTouched = false
        var primaryFailure: Throwable? = null
        try {
            if (!exactGenerationStillCurrent()) return false
            destinationTouched = true
            openDestination().use { destination ->
                stagedFile.inputStream().use { source ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        if (!exactGenerationStillCurrent()) return false
                        val count = source.read(buffer)
                        if (count < 0) break
                        if (!exactGenerationStillCurrent()) return false
                        destination.write(buffer, 0, count)
                        destination.flush()
                        if (!exactGenerationStillCurrent()) return false
                    }
                }
            }
            if (!exactGenerationStillCurrent()) return false
            committed = true
            return true
        } catch (failure: Throwable) {
            primaryFailure = failure
            throw failure
        } finally {
            if (!committed && destinationTouched) {
                try {
                    clearDestination()
                } catch (cleanupFailure: Throwable) {
                    primaryFailure?.addSuppressed(cleanupFailure) ?: throw cleanupFailure
                }
            }
        }
    }

    internal fun finalizePublishedExport(
        committed: Boolean,
        clearDestination: () -> Unit,
        exactGenerationStillCurrent: () -> Boolean,
    ): Boolean {
        if (!committed) return false
        if (exactGenerationStillCurrent()) return true
        clearDestination()
        return false
    }

    internal fun clearExportDestination(context: Context, destination: Uri) {
        val resolver = context.contentResolver
        var truncateFailure: Throwable? = null
        try {
            val stream = resolver.openOutputStream(destination, "wt")
                ?: throw IOException("Could not reopen failed export destination")
            stream.use { }
            return
        } catch (failure: Throwable) {
            truncateFailure = failure
        }

        try {
            if (DocumentsContract.isDocumentUri(context, destination) &&
                DocumentsContract.deleteDocument(resolver, destination)
            ) {
                return
            }
        } catch (deleteFailure: Throwable) {
            truncateFailure?.addSuppressed(deleteFailure)
        }
        throw IOException("Could not clear failed export destination", truncateFailure)
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
