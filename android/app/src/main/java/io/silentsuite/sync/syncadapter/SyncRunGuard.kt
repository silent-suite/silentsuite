package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.EtebaseLocalCache

/**
 * Keeps a sync run from writing once it is no longer current. The Etebase cache, its cursors, the
 * collection-discovery key, and the refresh burst window are all stored under the account name,
 * which a removed and re-added account reuses. So a run that started for one account generation
 * checks, right before each write that follows a network call, that the same generation is still
 * there, and [stillWanted] adds the caller's own conditions (for the Notes job: not cancelled and
 * Notes still on).
 *
 * The check and the write run together under the cache's write fence
 * ([EtebaseLocalCache.writeIfCurrent]), which sign-out cleanup also takes, so a cleanup can never
 * fall between them: a write either lands before the cleanup deletes it, or is never made.
 *
 * [creationId] is null only for an account set up before creation ids existed; the check then
 * requires that the account row is still there and still has none, so a re-added account (which
 * always gets one) is never taken for it.
 */
internal class SyncRunGuard(
    context: Context,
    private val account: Account,
    private val creationId: String?,
    private val stillWanted: () -> Boolean = { true },
) {
    private val manager = AccountManager.get(context.applicationContext)

    fun generationCurrent(): Boolean =
        manager.getAccountsByType(account.type).any { it == account } &&
            manager.getUserData(account, AccountSettings.KEY_CREATION_ID)?.takeIf { it.isNotBlank() } == creationId

    fun mayWrite(): Boolean = stillWanted() && generationCurrent()

    /** Throws [StaleSyncRunException] when the run may no longer write. */
    fun check() {
        if (!mayWrite()) throw StaleSyncRunException()
    }

    /** Runs [write] only while the run may still write, with no sign-out cleanup in between; otherwise throws. */
    fun write(cache: EtebaseLocalCache, write: () -> Unit) {
        if (!cache.writeIfCurrent(::mayWrite, write)) throw StaleSyncRunException()
    }
}

/** A sync run stopped because its account generation went away, or its caller no longer wants it; nothing more is written. */
internal class StaleSyncRunException : Exception("The sync run is no longer current")
