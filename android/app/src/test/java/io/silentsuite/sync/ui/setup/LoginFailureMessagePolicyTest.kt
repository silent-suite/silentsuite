package io.silentsuite.sync.ui.setup

import com.etebase.client.exceptions.UnauthorizedException
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException

class LoginFailureMessagePolicyTest {
    @Test fun `null throwable uses a safe generic fallback`() {
        assertEquals(LoginFailureMessagePolicy.Message.Generic, LoginFailureMessagePolicy.messageFor(null))
    }

    @Test fun `connection and generic failures never use throwable text`() {
        assertEquals(LoginFailureMessagePolicy.Message.Connection,
            LoginFailureMessagePolicy.messageFor(IOException()))
        assertEquals(LoginFailureMessagePolicy.Message.Generic,
            LoginFailureMessagePolicy.messageFor(IllegalStateException()))
    }

    @Test fun `authentication is classified by exception type`() {
        assertEquals(LoginFailureMessagePolicy.Message.Authentication,
            LoginFailureMessagePolicy.messageFor(UnauthorizedException("")))
    }
}
