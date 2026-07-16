package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Application
import android.content.ContentResolver
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.utils.AndroidCompat

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
    private val statusCleanup = injectedStatusCleanup ?: run {
        val store = SyncStatusStore(context)
        // Snapshot the opaque generation key while AccountManager still owns the exact row.
        val statusIdentity = store.identity(account, creationId)
        ExactAccountStatusCleanup { requested -> requested == main && store.clear(statusIdentity) }
    }

    private fun currentRow(type: String, name: String): Account? =
        manager.getAccountsByType(type).firstOrNull { it.name == name }

    override fun snapshot(): CurrentAccountSignOutSnapshot? {
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

    override fun cancelSync(identity: Pair<String, String>) =
        ContentResolver.cancelSync(Account(identity.second, identity.first), null)

    override fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit) {
        val row = currentRow(main.type, main.name)
        if (row == null || manager.getUserData(row, AccountSettings.KEY_CREATION_ID) != main.creationId) {
            callback(false)
            return
        }
        AndroidCompat.removeAccount(manager, row, callback)
    }

    override fun mainGenerationAbsent(main: ExactAccountIdentity): Boolean {
        val row = currentRow(main.type, main.name)
        return row == null || manager.getUserData(row, AccountSettings.KEY_CREATION_ID) != main.creationId
    }

    override fun clearCache(main: ExactAccountIdentity): Boolean {
        val row = currentRow(main.type, main.name)
        if (row != null) {
            // Cache storage is keyed by account name. A replacement generation owns that name now.
            return manager.getUserData(row, AccountSettings.KEY_CREATION_ID) != main.creationId
        }
        return runCatching { EtebaseLocalCache.clearUserCache(context, main.name) }.isSuccess
    }

    override fun clearStatus(main: ExactAccountIdentity) = runCatching { statusCleanup.clear(main) }.getOrDefault(false)

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

    fun initialize(account: Account, creationId: String) {
        val identity = ExactAccountIdentity(account.type, account.name, creationId)
        if (exactAccount == identity) return
        check(exactAccount == null) { "Sign-out owner cannot change exact account" }
        exactAccount = identity
        val appContext = getApplication<Application>().applicationContext
        coordinator = CurrentAccountSignOutCoordinator(
            seamsFactory?.invoke(appContext, account, creationId)
                ?: AndroidCurrentAccountSignOut(appContext, account, creationId)
        ) { mutableState.postValue(it) }
    }

    fun owns(account: Account, creationId: String) =
        exactAccount == ExactAccountIdentity(account.type, account.name, creationId)

    fun hasStarted() = coordinator?.state?.let { it !is CurrentAccountSignOutState.Idle } == true

    fun begin() = coordinator?.begin()
}
