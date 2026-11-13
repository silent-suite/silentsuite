package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File
import java.io.IOException

/** The shareable debug report names exception classes only and leaves out device and caller details. */
class DebugInfoReportTest {

    private class SyntheticException(message: String, cause: Throwable) : Exception(message, cause)

    /** Its cause can be set after construction, which lets a test build a cause cycle. */
    private class CyclicException(message: String) : Exception(message) {
        var next: Throwable? = null
        override val cause: Throwable? get() = next
    }

    @Test
    fun exceptionChainListsClassNamesWithoutMessagesOrFrames() {
        val root = IOException("secret-host.example.invalid refused")
        val error = SyntheticException("token=abc123", IllegalStateException("user@example.invalid", root))

        val chain = exceptionClassChain(error)

        assertEquals(
            listOf(
                SyntheticException::class.java.name,
                "Caused by: java.lang.IllegalStateException",
                "Caused by: java.io.IOException",
            ),
            chain.lines(),
        )
        assertFalse(chain.contains("secret-host"))
        assertFalse(chain.contains("token="))
        assertFalse(chain.contains("user@"))
        assertFalse(chain.contains("\tat "))
        assertFalse(chain.contains(DebugInfoReportTest::class.java.name + "."))
    }

    @Test
    fun exceptionChainStopsOnCauseCycle() {
        val first = CyclicException("a")
        val second = IllegalStateException("b", first)
        first.next = second

        assertEquals(
            listOf(CyclicException::class.java.name, "Caused by: java.lang.IllegalStateException"),
            exceptionClassChain(first).lines(),
        )
    }

    @Test
    fun reportSourceLeavesOutDeviceInstallerAuthorityAndCaller() {
        val source = File("src/main/java/io/silentsuite/sync/ui/DebugInfoActivity.kt").readText()

        for (forbidden in listOf(
                "Build.MODEL", "Build.DEVICE", "Build.DISPLAY", "Build.MANUFACTURER",
                "getInstallerPackageName", "getInstallSourceInfo",
                "KEY_AUTHORITY", "KEY_CALLER", "stackTrace", "Sentry",
        ))
            assertFalse("DebugInfoActivity must not use $forbidden", source.contains(forbidden))
    }
}
