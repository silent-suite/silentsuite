package io.silentsuite.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * An [HttpClient] holds a certificate-service binding until it is closed, so a caller must not
 * keep only its OkHttp client. These callers build Etebase clients on it; the binding is service
 * bound, so a runtime test is impractical here and the sources are checked instead.
 */
class HttpClientClosedContractTest {
    private val main = File("src/main/java/io/silentsuite/sync")
    private fun source(path: String) = File(main, path).readText()

    private val callers = listOf(
            "ui/setup/BaseConfigurationFinder.kt",
            "ui/etebase/CollectionActivity.kt",
            "ui/AppSettingsActivity.kt",
            "ui/ChangeEncryptionPasswordActivity.kt",
            "ui/AccountActivity.kt"
    )

    @Test
    fun noCallerDropsTheWrapper() {
        for (path in callers)
            assertFalse(path, Regex("""\.build\(\)\s*\.okHttpClient""").containsMatchIn(source(path)))
    }

    @Test
    fun shortLivedCallersCloseTheClientWhenTheirWorkEnds() {
        for (path in listOf("ui/setup/BaseConfigurationFinder.kt", "ui/AppSettingsActivity.kt",
                "ui/ChangeEncryptionPasswordActivity.kt"))
            assertTrue(path, Regex("""HttpClient\.Builder\([^\n]*\)(\.setForeground\(true\))?\.build\(\)\.use \{ httpClient ->""")
                    .containsMatchIn(source(path)))

        val load = source("ui/AccountActivity.kt").substringAfter("private fun doLoad(): AccountActivity.AccountInfo?")
                .substringBefore("private fun loadWith(")
        assertTrue(load.contains("HttpClient.Builder(context).build().also { httpClient = it }"))
        assertTrue(load.contains("} finally {\n                httpClient?.close()"))
    }

    @Test
    fun collectionModelKeepsTheClientOpenUntilCleared() {
        // The held Etebase account uses the client for the model's whole life.
        val model = source("ui/etebase/CollectionActivity.kt")
                .substringAfter("class AccountViewModel").substringBefore("data class AccountHolder")
        val cleared = model.substringAfter("override fun onCleared()").substringBefore("fun initialize(")
        assertTrue(cleared.contains("cleared = true"))
        assertTrue(cleared.contains("httpClient?.close()"))
        // A client built after the model was cleared is closed at once instead of being kept.
        assertTrue(Regex("""if \(cleared\) \{\s*httpClient\.close\(\)\s*return@withContext null""").containsMatchIn(model))
        assertTrue(model.contains("this@AccountViewModel.httpClient = httpClient"))
    }
}
