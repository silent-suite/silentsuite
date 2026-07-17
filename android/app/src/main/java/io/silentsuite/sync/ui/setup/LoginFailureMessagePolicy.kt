package io.silentsuite.sync.ui.setup

import com.etebase.client.exceptions.ConnectionException
import com.etebase.client.exceptions.UnauthorizedException
import java.io.IOException

/** Classifies login failures without retaining a throwable or any of its sensitive text. */
object LoginFailureMessagePolicy {
    enum class Message { Authentication, Connection, Generic }

    fun messageFor(error: Throwable?): Message = when (error) {
        is UnauthorizedException -> Message.Authentication
        is ConnectionException, is IOException -> Message.Connection
        else -> Message.Generic
    }
}
