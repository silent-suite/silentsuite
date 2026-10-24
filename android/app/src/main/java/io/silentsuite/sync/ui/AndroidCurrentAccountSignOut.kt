package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.accounts.OnAccountsUpdateListener
import android.app.Application
import android.content.ContentResolver
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.annotation.VisibleForTesting
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.utils.AndroidCompat
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

fun interface ExactAccountStatusCleanup {
    fun clear(identity: ExactAccountIdentity): Boolean

    companion object { val NO_OP = ExactAccountStatusCleanup { true } }
}

internal class AndroidCurrentAccountSignOut(
    private val context: Context,
    private val account: Account,
    private val creationId: String,
    injectedStatusCleanup: ExactAccountStatusCleanup? = null,
) : CurrentAccountSignOutCoordinator.Seams {
    private val manager = AccountManager.get(context)
    private val main = ExactAccountIdentity(account.type, account.name, creationId)
    private val generationInvalidated = AtomicBoolean(false)
    private val accountListener = OnAccountsUpdateListener { accounts ->
        val current = accounts.firstOrNull { it.type == main.type && it.name == main.name }
        if (current == null ||
            manager.getUserData(current, AccountSettings.KEY_CREATION_ID) != main.creationId) {
            generationInvalidated.set(true)
        }
    }
    private val statusCleanup = injectedStatusCleanup ?: run {
        val store = SyncStatusStore(context)
        // Snapshot the opaque generation key while AccountManager still owns the exact row.
        val statusIdentity = store.identity(account, creationId)
        ExactAccountStatusCleanup { requested -> requested == main && store.clear(statusIdentity) }
    }

    init {
        manager.addOnAccountsUpdatedListener(accountListener, Handler(Looper.getMainLooper()), true)
    }

    private fun currentRow(type: String, name: String): Account? =
        manager.getAccountsByType(type).firstOrNull { it.name == name }

    override fun snapshot(): CurrentAccountSignOutSnapshot? {
        if (generationInvalidated.get()) return null
        val current = currentRow(account.type, account.name) ?: return null
        if (creationId.isBlank() ||
            manager.getUserData(current, AccountSettings.KEY_CREATION_ID) != creationId) return null
        val children = manager.getAccountsByType(App.addressBookAccountType).filter { child ->
            manager.getUserData(child, LocalAddressBook.USER_DATA_MAIN_ACCOUNT_TYPE) == account.type &&
                manager.getUserData(child, LocalAddressBook.USER_DATA_MAIN_ACCOUNT_NAME) == account.name
        }.map { it.type to it.name }.distinct().sortedWith(compareBy({ it.second }, { it.first }))
        val siblings = manager.getAccountsByType(App.accountType).mapNotNull { candidate ->
            manager.getUserData(candidate, AccountSettings.KEY_CREATION_ID)?.takeIf(String::isNotBlank)?.let {
                ExactAccountIdentity(candidate.type, candidate.name, it)
            }
        }
        return CurrentAccountSignOutSnapshot(main, children, AccountSwitcherPolicy.ordered(siblings))
    }

    override fun cancelSync(identity: Pair<String, String>) {
        ContentResolver.cancelSync(Account(identity.second, identity.first), null)
        // The in-app Notes job has no authority; stop it at the same account-name boundary.
        io.silentsuite.sync.notes.NotesSyncCoordinator.cancelAccount(identity.first, identity.second)
    }

    override fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit) {
        if (generationInvalidated.get()) {
            callback(false)
            return
        }
        val row = currentRow(main.type, main.name)
        if (row == null || manager.getUserData(row, AccountSettings.KEY_CREATION_ID) != main.creationId) {
            callback(false)
            return
        }
        AndroidCompat.removeAccount(manager, row, callback)
    }

    override fun mainGenerationAbsent(main: ExactAccountIdentity): Boolean {
        if (generationInvalidated.get()) return true
        val row = currentRow(main.type, main.name)
        return row == null || manager.getUserData(row, AccountSettings.KEY_CREATION_ID) != main.creationId
    }

    override fun hasObservedMainGenerationInvalidation() = generationInvalidated.get()

    override fun clearCache(main: ExactAccountIdentity): Boolean {
        val row = currentRow(main.type, main.name)
        if (row != null) {
            // Cache storage is keyed by account name. A replacement generation owns that name now.
            return manager.getUserData(row, AccountSettings.KEY_CREATION_ID) != main.creationId
        }
        return runCatching { EtebaseLocalCache.clearUserCache(context, main.name) }.isSuccess
    }

    override fun clearStatus(main: ExactAccountIdentity) = runCatching { statusCleanup.clear(main) }.getOrDefault(false)

    private fun pendingNotes(main: ExactAccountIdentity) =
        PendingNotesStore.forIdentity(context, main.type, main.name, main.creationId)

    override fun unsyncedNotes(main: ExactAccountIdentity): UnsyncedNotes = pendingNotes(main).unsynced()

    /**
     * Keyed by the exact generation, so a same-name account that replaced this one has a store of its own,
     * which this never touches. A cleared instance stays registered for the rest of the process, unless the
     * removal then fails and [reopenPendingNotes] drops it, so a save or a run that reaches the store of a
     * removed account later is refused and does not bring the directory back.
     */
    override fun discardPendingNotes(main: ExactAccountIdentity, confirmed: UnsyncedNotes?) =
        pendingNotes(main).discardStore(confirmed)

    override fun reopenPendingNotes(main: ExactAccountIdentity) = pendingNotes(main).unregister()

    override fun close() {
        runCatching { manager.removeOnAccountsUpdatedListener(accountListener) }
    }

    override fun reconcileActive(main: ExactAccountIdentity, replacement: ExactAccountIdentity?): ActiveAccountReconciliation {
        if (!ActiveAccountManager.replaceIfActive(context, main, replacement))
            return ActiveAccountReconciliation(false, null)
        val active = ActiveAccountManager.getActiveAccount(context)?.let { selected ->
            manager.getUserData(selected, AccountSettings.KEY_CREATION_ID)?.takeIf(String::isNotBlank)?.let {
                ExactAccountIdentity(selected.type, selected.name, it)
            }
        }
        return ActiveAccountReconciliation(true, active)
    }

    override fun removeAndVerifyChildren(snapshot: CurrentAccountSignOutSnapshot, callback: (Boolean) -> Unit) {
        val pending = snapshot.children.toMutableList()
        fun next() {
            if (pending.isEmpty()) { callback(true); return }
            val identity = pending.removeAt(0)
            val child = currentRow(identity.first, identity.second)
            val stillOwned = child != null &&
                manager.getUserData(child, LocalAddressBook.USER_DATA_MAIN_ACCOUNT_TYPE) == snapshot.main.type &&
                manager.getUserData(child, LocalAddressBook.USER_DATA_MAIN_ACCOUNT_NAME) == snapshot.main.name
            if (!stillOwned) { next(); return }
            AndroidCompat.removeAccount(manager, child!!) { confirmed ->
                if (confirmed && currentRow(identity.first, identity.second) == null) next() else callback(false)
            }
        }
        Handler(Looper.getMainLooper()).post(::next)
    }
}

class CurrentAccountSignOutViewModel(application: Application) : AndroidViewModel(application) {
    companion object {
        @JvmField internal var seamsFactory: ((Context, Account, String) -> CurrentAccountSignOutCoordinator.Seams)? = null
    }
    private val mutableState = MutableLiveData<CurrentAccountSignOutState>()
    val state: LiveData<CurrentAccountSignOutState> = mutableState
    private var exactAccount: ExactAccountIdentity? = null
    private var coordinator: CurrentAccountSignOutCoordinator? = null

    /**
     * Where the coordinator's store steps run: on IO, each handing its result back on the main thread. The scope
     * is not the view model's own and is never canceled, so a sign-out past its count runs to its end after the
     * screen is gone, as the removal's answer always did.
     */
    private val steps = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** Steps started and not ended. Main thread only. */
    private var inFlight = 0

    /** Whether [onCleared] ran. The seams are closed once no step is in flight. Main thread only. */
    private var cleared = false

    private val offMain = object : CurrentAccountSignOutCoordinator.OffMain {
        override fun <T> run(work: () -> T, then: (T) -> Unit) {
            inFlight++
            steps.launch {
                try {
                    then(withContext(Dispatchers.IO) { work() })
                } finally {
                    inFlight--
                    if (cleared && inFlight == 0) coordinator?.close()
                }
            }
        }

        override fun onMain(block: () -> Unit) {
            steps.launch { block() }
        }
    }

    fun initialize(account: Account, creationId: String) {
        val identity = ExactAccountIdentity(account.type, account.name, creationId)
        if (exactAccount == identity) return
        check(exactAccount == null) { "Sign-out owner cannot change exact account" }
        exactAccount = identity
        val appContext = getApplication<Application>().applicationContext
        coordinator = CurrentAccountSignOutCoordinator(
            seamsFactory?.invoke(appContext, account, creationId)
                ?: AndroidCurrentAccountSignOut(appContext, account, creationId),
            offMain,
        ) { mutableState.postValue(it) }
    }

    fun owns(account: Account, creationId: String) =
        exactAccount == ExactAccountIdentity(account.type, account.name, creationId)

    fun hasStarted() = coordinator?.state?.let {
        it !is CurrentAccountSignOutState.Idle && it !is CurrentAccountSignOutState.Refused
    } == true

    fun ownsCurrentGeneration() = exactAccount?.let { identity ->
        coordinator?.isMainGenerationPresent(identity)
    } == true

    @VisibleForTesting
    internal fun hasObservedMainGenerationInvalidation() =
        coordinator?.hasObservedMainGenerationInvalidation() == true

    /** The coordinator's store steps in flight. Main thread only. */
    @VisibleForTesting
    internal fun stepsInFlight() = inFlight

    fun begin() = coordinator?.begin()

    /** The exact account this owner was initialized for, or null before that. */
    internal fun identity(): ExactAccountIdentity? = exactAccount

    /**
     * The coordinator's state right now, or null before [initialize]. [state] is set with postValue, so it can be
     * behind this.
     */
    internal fun currentState(): CurrentAccountSignOutState? = coordinator?.state

    /**
     * What this account's pending Notes store holds that has not synced, as the coordinator answers it. Nothing
     * before [initialize]. It reads the store, so the screen asks it on IO.
     */
    internal fun unsyncedNotes(): UnsyncedNotes =
        exactAccount?.let { coordinator?.unsyncedNotes(it) } ?: UnsyncedNotes.NOTHING

    /** Passes the separate discard confirmation for [shown] on to the coordinator. Does nothing before [initialize]. */
    internal fun confirmNotesDiscard(shown: UnsyncedNotes) {
        exactAccount?.let { coordinator?.confirmNotesDiscard(it, shown) }
    }

    internal fun acknowledgeRefusal() { coordinator?.acknowledgeRefusal() }

    /** A step in flight still uses the seams, so they are closed only once the last one ends. */
    override fun onCleared() {
        cleared = true
        if (inFlight == 0) coordinator?.close()
        super.onCleared()
    }
}
