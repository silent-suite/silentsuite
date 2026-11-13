package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Post-login inventory and collection creation must go through the same configured client as
 * login (app proxy, custom certificates, distrust-system-certificates), not the bare shared one,
 * and must close it afterwards. HttpClient.Builder needs a real Context, so this is a source check.
 */
class PostLoginSetupClientContractTest {
    private val source = File("src/main/java/io/silentsuite/sync/ui/setup/PostLoginSetupViewModel.kt")
            .readText()
            // ignore comments
            .replace(Regex("//[^\n]*"), "")

    @Test
    fun setupDoesNotUseTheUnconfiguredSharedClient() {
        assertFalse(source.contains("sharedClient"))
    }

    @Test
    fun setupBuildsAndClosesTheConfiguredClient() {
        assertTrue(Regex("""HttpClient\.Builder\(\s*context\s*,\s*settings\s*\)\s*\.build\(\)\s*\.use\s*\{\s*httpClient\s*->""")
                .containsMatchIn(source))
        assertTrue(Regex("""EtebaseLocalCache\.getEtebase\(\s*context\s*,\s*httpClient\.okHttpClient\s*,\s*settings\s*,?\s*\)""")
                .containsMatchIn(source))
    }
}
