package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.provider.CalendarContract
import android.system.ErrnoException
import android.system.Os
import androidx.test.platform.app.InstrumentationRegistry
import at.bitfire.ical4android.TaskProvider
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.notes.edit.NotesFolderListings
import io.silentsuite.sync.notes.edit.NotesFolderListings.Folder
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.ui.NotesRemovalAllowance.FolderStat
import io.silentsuite.sync.ui.NotesRemovalAllowance.Key
import io.silentsuite.sync.ui.NotesRemovalAllowance.Mint
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import io.silentsuite.sync.utils.AccountRowChanges
import io.silentsuite.sync.utils.AndroidCompat
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cross-process gate for the Notes removal allowance: it lives only in the app process that made it (the maintainer's
 * reply of 2026-10-20 on #709 asks PR 4 to show that this holds across the process ending). Every method is one step
 * that android/scripts/run-registry-process-boundary.sh runs as its own `am instrument` invocation, with the app
 * process terminated before it. The writer and the reader are a pair: a reader run alone, or in the writer's process,
 * fails by design. It is deliberately outside the focused runtime ledger, which runs its methods in one process.
 *
 * No seam reaches a fresh process, so notes-pending is made unlistable for real, mode 000, before anything is shown;
 * the cleanup step, which the runner always runs last, gives its mode back and removes the rows. Rows are added raw and
 * removed through AndroidCompat, which the authenticator never sees; only the removals under test ask Android.
 */
class NotesRemovalProcessBoundaryRuntimeTest {
    private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager: AccountManager get() = AccountManager.get(context)
    private val dir get() = File(context.filesDir, "notes-removal-process-boundary")
    private val stateFile get() = File(dir, "writer-state")
    private val cleanupFile get() = File(dir, "cleanup")
    private val pending get() = File(context.noBackupFilesDir, PendingNotesStore.PENDING)

    /** The control: the same setup in one process, with a slot minted there, lets the authenticator answer true. */
    @Test fun controlRemovesTheRowWithASlotMintedInTheSameProcess() {
        val account = setUp("control")
        minted(account)
        assertTrue("the process that minted the slot answers with it", removeThroughAndroid(account))
        assertFalse("the row went", present(account))
    }

    /** The writer: a slot minted for the row, and no answer; the process then ends with the slot in memory. */
    @Test fun writerMintsAnAllowanceAndStopsBeforeTheAnswer() {
        val account = setUp("pair")
        writeState(account.name, minted(account))
    }

    /**
     * The reader, in a fresh process within the slot's two minutes, with the same key, verdict and fingerprint as the
     * writer's, and the counters the slot binds where the writer left them: only the process differs, and the
     * authenticator refuses, so the row stays.
     *
     * This process's launch classified the row first (PostLoginSetupMigration, run from App.onCreate) and gave it a
     * creation id and a setup state, which alone would refuse it: the guard then checks the row's own store folder,
     * which notes-pending at mode 000 cannot show absent. The reader takes both off again, so the row is the writer's.
     *
     * Both counters start at 0 in every process, so a slot that outlived its process would still be refused on its row
     * count. The reader moves this process's row counter up to the writer's, and checks that notes-pending's listing
     * counter, the one folder the verdict binds, is the writer's too, so that only the slot's absence can refuse.
     */
    @Test fun readerInAFreshProcessIsRefusedWithTheSameVerdictAndFingerprint() {
        val state = consumeState()
        val account = Account(state.name, App.accountType)
        assertTrue("the writer's row is there", present(account))
        assertTrue("within the slot's window of the writer's tap",
            NotesRemovalAllowance.process.now() - state.tapped < NotesRemovalAllowance.WINDOW_MS)
        assertNotNull("this process's launch gave the row a creation id",
            manager.getUserData(account, AccountSettings.KEY_CREATION_ID))
        for (key in listOf(AccountSettings.KEY_CREATION_ID, AccountSettings.KEY_POST_LOGIN_SETUP_STATE)) {
            manager.setUserData(account, key, null)
            assertNull(key, manager.getUserData(account, key))
        }
        val decision = PendingNotesRemovalGuard.decision(context, account)
        assertNull("the same key", decision.creationId)
        assertEquals("the same verdict", Verdict.ROOT_UNLISTABLE_ONLY, decision.verdict)
        assertEquals("the same fingerprint", state.fingerprint, NotesRemovalOffer.fingerprintOnDevice(context, decision))
        val rows = AccountRowChanges.mainType
        while (rows.count() < state.rows) rows.before()
        assertEquals("the writer's row count", state.rows, rows.count())
        assertEquals("the writer's notes-pending count", state.pendingListings, NotesFolderListings.count(Folder.PENDING))
        assertFalse("a fresh process has no allowance", removeThroughAndroid(account))
        assertTrue("the row stays", present(account))
    }

    /** Always last: notes-pending gets its mode back, and every row a step added goes, through AndroidCompat. */
    @Test fun cleanupGivesNotesPendingItsModeBackAndRemovesTheRows() {
        val lines = try {
            cleanupFile.readLines(Charsets.UTF_8)
        } catch (e: java.io.IOException) {
            emptyList()
        }
        val mode = lines.firstOrNull()?.toIntOrNull() ?: OWNER_ONLY
        try {
            Os.chmod(pending.path, mode)
        } catch (e: ErrnoException) {
            // No notes-pending: nothing to give back.
        }
        for (name in lines.drop(1).filter { it.isNotEmpty() }) {
            val account = Account(name, App.accountType)
            if (present(account)) removeExplicitly(account)
        }
        NotesRemovalNotice.clear(context)
        stateFile.delete()
        cleanupFile.delete()
        assertTrue("notes-pending lists again", pending.list() != null || pending.parentFile?.list()
            ?.contains(pending.name) == false)
        val left = lines.drop(1).filter { it.isNotEmpty() && present(Account(it, App.accountType)) }
        assertTrue("rows left: $left", left.isEmpty())
    }

    /**
     * A row with no creation id while notes-pending is there and cannot be listed: the guard's one eligible case for a
     * row nothing else names. Its name is noted for the cleanup step before it is added, and notes-pending's mode
     * before it is changed.
     */
    private fun setUp(label: String): Account {
        assertTrue("no SilentSuite account is on this device", manager.getAccountsByType(App.accountType).isEmpty())
        ActiveAccountManager.clearActiveAccount(context)
        assertTrue(pending.isDirectory || pending.mkdirs())
        val account = Account("notes-boundary-$label-${UUID.randomUUID()}@example.invalid", App.accountType)
        val mode = (Os.stat(pending.path).st_mode and MODE_BITS).takeIf { it != 0 } ?: OWNER_ONLY
        noteForCleanup(account.name, mode)
        assertTrue(manager.addAccountExplicitly(account, null, null))
        for (authority in authorities) ContentResolver.setIsSyncable(account, authority, 0)
        Os.chmod(pending.path, 0)
        assertNull("notes-pending cannot be listed", pending.list())
        return account
    }

    /**
     * The confirmation for [account] shown and tapped on this process's allowance, with the guard's real decision and
     * the real fingerprint, read again at the tap; gives the tap's time, the fingerprint and the counters after it.
     */
    private fun minted(account: Account): Minted {
        val allowance = NotesRemovalAllowance.process
        val counts = allowance.counts()
        val decision = PendingNotesRemovalGuard.decision(context, account)
        assertEquals(Verdict.ROOT_UNLISTABLE_ONLY, decision.verdict)
        assertNull(decision.creationId)
        val fingerprint = NotesRemovalOffer.fingerprintOnDevice(context, decision)
        val key = Key(account.type, account.name, null)
        val shown = checkNotNull(allowance.show(counts, key, decision.verdict, fingerprint, null)) { "nothing shown" }
        val tapped = allowance.now()
        val again = PendingNotesRemovalGuard.decision(context, account)
        assertEquals(Mint.Done(key, null), allowance.mint(shown.id, key, again.verdict,
            NotesRemovalOffer.fingerprintOnDevice(context, again), tapped))
        // The counters as this process holds them once the slot is there: the row counter after the tap moved it, and
        // notes-pending's listing counter, the one folder the slot binds.
        assertEquals(setOf(Folder.PENDING), shown.folders.keys)
        val after = allowance.counts()
        return Minted(tapped, fingerprint, after.rows, after.folders.getValue(Folder.PENDING))
    }

    private class Minted(
        val tapped: Long,
        val fingerprint: NotesRemovalAllowance.Fingerprint,
        val rows: Long,
        val pendingListings: Long,
    )

    /** A removal through Android's asking path, so the authenticator answers. */
    private fun removeThroughAndroid(account: Account): Boolean =
        manager.removeAccount(account, null, null, null).getResult(20, TimeUnit.SECONDS)
            .getBoolean(AccountManager.KEY_BOOLEAN_RESULT)

    private fun removeExplicitly(account: Account) {
        val finished = CountDownLatch(1)
        AndroidCompat.removeAccount(manager, account) { finished.countDown() }
        assertTrue(finished.await(10, TimeUnit.SECONDS))
    }

    private fun present(account: Account) = account in manager.getAccountsByType(App.accountType)

    private fun noteForCleanup(name: String, mode: Int) {
        assertTrue(dir.isDirectory || dir.mkdirs())
        val earlier = try {
            cleanupFile.readLines(Charsets.UTF_8)
        } catch (e: java.io.IOException) {
            emptyList()
        }
        val lines = (earlier.ifEmpty { listOf(mode.toString()) }) + name
        write(cleanupFile, lines.joinToString("\n", postfix = "\n"))
    }

    private data class State(
        val name: String,
        val tapped: Long,
        val fingerprint: NotesRemovalAllowance.Fingerprint,
        val rows: Long,
        val pendingListings: Long,
    )

    private fun writeState(name: String, minted: Minted) {
        val fingerprint = minted.fingerprint
        val stat = fingerprint.stats.getValue(Folder.PENDING) as FolderStat.Stat
        assertEquals(setOf(Folder.PENDING), fingerprint.stats.keys)
        assertTrue(fingerprint.names.isEmpty() && fingerprint.entries.isEmpty())
        write(stateFile, listOf(processNonce, name, minted.tapped.toString(), stat.device.toString(),
            stat.inode.toString(), stat.mode.toString(), stat.changed.toString(), minted.rows.toString(),
            minted.pendingListings.toString()).joinToString("\n", postfix = "\n"))
    }

    /** Consumes the writer's state, so one write never serves two readers, and checks this is another process. */
    private fun consumeState(): State {
        val lines = try {
            stateFile.readLines(Charsets.UTF_8)
        } catch (e: java.io.IOException) {
            throw AssertionError("no writer ran before this reader")
        }
        assertTrue("the writer's state could not be consumed", stateFile.delete())
        assertEquals(9, lines.size)
        assertEquals(36, lines[0].length)
        assertNotEquals("the reader shares the writer's process", lines[0], processNonce)
        val stat = FolderStat.Stat(lines[3].toLong(), lines[4].toLong(), lines[5].toInt(), lines[6].toLong())
        return State(lines[1], lines[2].toLong(), NotesRemovalAllowance.Fingerprint(mapOf(Folder.PENDING to stat)),
            lines[7].toLong(), lines[8].toLong())
    }

    private fun write(file: File, text: String) {
        FileOutputStream(file).use { stream ->
            stream.write(text.toByteArray(Charsets.UTF_8))
            stream.fd.sync()
        }
    }

    private val authorities: List<String>
        get() = TaskProvider.TASK_PROVIDERS.map { it.authority } +
            listOf(CalendarContract.AUTHORITY, App.addressBooksAuthority)

    private companion object {
        /** Made once per process: a reader that sees the writer's value is not in a fresh process. */
        val processNonce: String = UUID.randomUUID().toString()

        /** The permission bits of a mode, and the mode notes-pending gets back when none was noted: 0700. */
        const val MODE_BITS = 0xfff
        const val OWNER_ONLY = 0x1c0
    }
}
