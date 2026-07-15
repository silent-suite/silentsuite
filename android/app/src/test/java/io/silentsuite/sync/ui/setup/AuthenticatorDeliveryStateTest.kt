package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class AuthenticatorDeliveryStateTest {
    @Test fun `result action preserves exact name and type once`() {
        val (terminal, action) = AuthenticatorDeliveryState().complete("alice@example", "sync.type").finish()
        assertEquals(AuthenticatorDeliveryState.Action.Result("alice@example", "sync.type"), action)
        assertEquals(true, terminal.delivered)
        assertEquals(AuthenticatorDeliveryState.Action.None, terminal.finish().second)
    }

    @Test fun `cancel duplicate completion and post terminal mutation are no ops`() {
        val cancelled = AuthenticatorDeliveryState().finish().first
        assertEquals(AuthenticatorDeliveryState.Action.None, cancelled.finish().second)
        assertEquals(cancelled, cancelled.complete("other", "type"))
        val staged = AuthenticatorDeliveryState().complete("one", "type")
        assertEquals(staged, staged.complete("two", "type"))
    }

    @Test fun `snapshot restore keeps staged result without Android objects`() {
        val staged = AuthenticatorDeliveryState().complete("account", "type")
        val restored = AuthenticatorDeliveryState.restore(staged.snapshot())
        assertEquals(AuthenticatorDeliveryState.Action.Result("account", "type"), restored.finish().second)
    }
}
