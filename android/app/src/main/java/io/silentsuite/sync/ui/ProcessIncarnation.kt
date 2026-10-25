package io.silentsuite.sync.ui

/**
 * A token of this app process, for the dialogs that keep an answer in their arguments, which Android brings back
 * when it restores a screen in a new process. A dialog keeps the token of the process that made it, and its screen
 * takes its answer as given only when the token is this process's ([isCurrent]); otherwise it counts again and asks
 * again (the maintainer's answer on #709, 2026-10-23). The token is a random UUID made once, the first time anything
 * here is used, and kept in memory: never a process id, which a later process can be given again, nor a time, a
 * counter or anything read from storage. The app writes it to no file, preference or log; it travels only in the
 * dialogs' own saved arguments. Nothing can set it.
 */
internal object ProcessIncarnation {
    private val token: String = java.util.UUID.randomUUID().toString()

    /** This process's token, for a dialog's arguments. */
    fun current(): String = token

    /** Whether [shownIn], read from a dialog's arguments, is this process's token. null, a dialog with none, is not. */
    fun isCurrent(shownIn: String?): Boolean = shownIn != null && shownIn == token
}
