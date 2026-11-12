package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import androidx.annotation.StringRes
import androidx.annotation.WorkerThread
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.NotesRemovalNotice.Kind
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Decision
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict

/**
 * The removal section of Unsynced Notes, the reason and the way to try again in the app for a removal of an account
 * that the authenticator refuses (the maintainer's reply of 2026-10-23 on #709: the notification may not be allowed).
 * It is read live, every time the screen reads its stores, and keeps nothing, so it lists the accounts Android settings
 * would not remove now, whether or not anyone tried: one row per present SilentSuite account whose guard decision is
 * not [Verdict.ALLOW], in the words of its kind ([NotesRemovalNotice.kind]), or one row with no account name when the
 * account list cannot be read. A tap checks again ([NotesRemovalOffer.open]).
 */
internal object NotesRemovalSection {
    /** One account Android settings would not remove now, in the words of [kind]. */
    data class Row(val type: String, val name: String, val kind: Kind)

    /** The section: [rows] in name order, or none and [accountsUnread] when the account list could not be read. */
    data class Section(val rows: List<Row>, val accountsUnread: Boolean) {
        /** Nothing to show: no row, and the account list read. */
        val empty: Boolean get() = rows.isEmpty() && !accountsUnread
    }

    /**
     * The section for the rows of [type] named [names], null when the account list could not be read, each decided
     * by [decide]: one that throws counts as [Verdict.REFUSE_FAILED].
     */
    fun section(type: String, names: List<String>?, decide: (String) -> Decision): Section {
        if (names == null) return Section(emptyList(), accountsUnread = true)
        val rows = names.distinct().sorted().mapNotNull { name ->
            val decision = try {
                decide(name)
            } catch (e: Exception) {
                Decision(Verdict.REFUSE_FAILED, null)
            }
            if (decision.verdict == Verdict.ALLOW) null else Row(type, name, NotesRemovalNotice.kind(decision))
        }
        return Section(rows, accountsUnread = false)
    }

    /**
     * The section on this device: the account list as the guard reads it, null when that read throws, and the guard
     * for each account. When it is empty, nothing stands in the way of any account, so the refusal notification goes
     * too. Never on the main thread.
     */
    @WorkerThread
    fun read(context: Context): Section {
        val names = try {
            AccountManager.get(context).getAccountsByType(App.accountType).map { it.name }
        } catch (e: Exception) {
            null
        }
        val section = section(App.accountType, names) { name ->
            PendingNotesRemovalGuard.decision(context, Account(name, App.accountType))
        }
        if (section.empty) NotesRemovalNotice.clear(context)
        return section
    }

    /** A row's summary for [kind]: what stands in the way now, and what a tap does. */
    @StringRes
    fun summary(kind: Kind): Int = when (kind) {
        Kind.STORE -> R.string.notes_removal_section_store
        Kind.CONFIRM -> R.string.notes_removal_section_confirm
        Kind.UNCHECKED -> R.string.notes_removal_section_unchecked
    }
}
