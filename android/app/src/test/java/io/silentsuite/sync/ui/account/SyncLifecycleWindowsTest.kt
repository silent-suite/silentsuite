package io.silentsuite.sync.ui.account

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncLifecycleWindowsTest {
    @Test fun `product interruption window is thirty minutes and clamps age safely`() {
        val windows = SyncLifecycleWindows()
        assertEquals(30L * 60L * 1000L, windows.interruptionAfterMillis)
        assertFalse(windows.isExpired(0, windows.interruptionAfterMillis - 1))
        assertTrue(windows.isExpired(0, windows.interruptionAfterMillis))
        assertEquals(0L, windows.age(now = 10, timestamp = 20))
    }
}
