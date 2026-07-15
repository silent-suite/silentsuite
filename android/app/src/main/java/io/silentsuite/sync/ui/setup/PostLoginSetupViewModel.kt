package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.viewModelScope
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.FetchOptions
import com.etebase.client.ItemMetadata
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.ui.ActiveAccountManager
import io.silentsuite.sync.utils.AndroidCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.ensureActive

/** Retained, idempotent collection work. No session or configuration is retained by this model. */
class PostLoginSetupViewModel(application: Application) : AndroidViewModel(application) {
    enum class InventoryOutcome { Loading, Usable, Limited, Recovery }
    companion object {
        private const val PAGE_SIZE = 100L; private const val MAX_PAGES = 100
        /** androidTest override only; null always selects the application-context production seams. */
        @JvmField internal var recoverySeamsFactory: ((Context, Account, String) -> RecoveryRemovalCoordinator.Seams)? = null
        @JvmField internal var inventoryOverride: ((Account) -> Pair<InventoryOutcome, Set<String>>)? = null
    }
    sealed class CollectionsResult {
        object Working : CollectionsResult()
        data class Ready(val limited: Boolean) : CollectionsResult()
        object RecoveryRequired : CollectionsResult()
    }

    val collections = MutableLiveData<CollectionsResult>()
    val recoveryRemoval = MutableLiveData<RecoveryRemovalCoordinator.State>()
    private var initializedAccount: Account? = null
    private var started = false
    internal var inventoryInvocationCountForTest = 0
        private set
    private var removal: RecoveryRemovalCoordinator? = null
    private var recoveryAccount: Account? = null
    private var recoveryCreationId: String? = null
    private var removalRouteConsumed = false
    var limitedContinuation = false
        private set
    @Volatile var qualifyingCollectionTypes: Set<String> = emptySet()
        private set
    @Volatile var integrationCollectionTypes: Set<String> = emptySet()
        private set
    @Volatile var inventoryLoaded: Boolean = false
        private set
    @Volatile var inventoryOutcome: InventoryOutcome = InventoryOutcome.Loading
        private set

    fun initialize(account: Account) {
        if (initializedAccount == account) return
        check(initializedAccount == null) { "PostLoginSetupViewModel cannot be reused for another account" }
        initializedAccount = account
    }

    /** Retained application-context owner; no Activity is retained by platform callbacks. */
    fun initializeRecovery(account: Account, creationId: String) {
        if (recoveryAccount == account && recoveryCreationId == creationId) return
        check(recoveryAccount == null) { "Recovery removal cannot change account ownership" }
        recoveryAccount = account
        recoveryCreationId = creationId
        val appContext = getApplication<Application>().applicationContext
        val manager = AccountManager.get(appContext)
        val registry = AccountCreationRegistry.open(appContext)
        val defaults = object : RecoveryRemovalCoordinator.Seams {
            override fun ownsExact() = AccountCreationRegistry.owns(registry.get(account.type, account.name), creationId)
            override fun begin(callback: (Boolean) -> Unit) = AndroidCompat.removeAccount(manager, account, callback)
            override fun rowAbsent() = account !in manager.getAccountsByType(account.type)
            override fun clearOwned() = registry.clearOwned(account.type, account.name, creationId)
            override fun clearActive() = ActiveAccountManager.clearIfActive(appContext, account.name, creationId)
        }
        removal = RecoveryRemovalCoordinator(recoverySeamsFactory?.invoke(appContext, account, creationId) ?: defaults) { next -> recoveryRemoval.postValue(next) }
        recoveryRemoval.value = RecoveryRemovalCoordinator.State.Idle
    }

    fun beginRecoveryRemoval() { removal?.remove() }
    /** androidTest-only visibility seam; production handlers still consult SetupContinuationPolicy. */
    internal fun setInventoryOutcomeForTest(outcome: InventoryOutcome, integrationTypes: Set<String> = emptySet()) {
        inventoryOutcome = outcome
        inventoryLoaded = outcome == InventoryOutcome.Usable || outcome == InventoryOutcome.Limited
        limitedContinuation = outcome == InventoryOutcome.Limited
        integrationCollectionTypes = integrationTypes
    }
    fun consumeRecoveryRemovalRoute(): Boolean =
        recoveryRemoval.value == RecoveryRemovalCoordinator.State.Removed && !removalRouteConsumed.also { removalRouteConsumed = true }

    fun inventoryAndCreate(context: Context, account: Account) {
        initialize(account)
        inventoryOverride?.invoke(account)?.let { (outcome, types) -> setInventoryOutcomeForTest(outcome, types); collections.value=CollectionsResult.Ready(outcome==InventoryOutcome.Limited); return }
        inventoryInvocationCountForTest++
        if (started) return
        started = true
        collections.value = CollectionsResult.Working
        viewModelScope.launch {
            val result = try {
                CollectionsResult.Ready(withContext(Dispatchers.IO) { reconcile(context.applicationContext, account) })
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                CollectionsResult.RecoveryRequired
            }
            started = false
            limitedContinuation = (result as? CollectionsResult.Ready)?.limited == true
            inventoryOutcome = when (result) {
                is CollectionsResult.Ready -> if (result.limited) InventoryOutcome.Limited else InventoryOutcome.Usable
                CollectionsResult.RecoveryRequired -> InventoryOutcome.Recovery
                CollectionsResult.Working -> InventoryOutcome.Loading
            }
            collections.value = result
        }
    }

    /** @return true when continuation is necessarily read-only/limited. */
    private fun reconcile(context: Context, account: Account): Boolean {
        val settings = AccountSettings(context, account)
        val cache = EtebaseLocalCache.getInstance(context, account.name)
        val etebase = EtebaseLocalCache.getEtebase(context, HttpClient.sharedClient, settings)
        val manager = etebase.collectionManager
        val required = Constants.COLLECTION_TYPES.toList()
        fun checkpoint() = viewModelScope.coroutineContext.ensureActive()
        val reconciliation = CollectionReconciliation.reconcile(required,
            refresh = {
            checkpoint()
            val byUid = linkedMapOf<String, CollectionEligibility.Collection>()
            var stoken: String? = null
            var done = false
            var pages = 0
            while (!done) {
                checkpoint()
                if (++pages > MAX_PAGES) throw IllegalStateException("Collection inventory page cap exceeded")
                val previousToken = stoken
                val chunk = manager.list(Constants.COLLECTION_TYPES, FetchOptions().stoken(previousToken).limit(PAGE_SIZE))
                chunk.data.forEach {
                    byUid[it.uid] = CollectionEligibility.Collection(
                        type = it.collectionType,
                        writable = it.accessLevel != CollectionAccessLevel.ReadOnly,
                        removed = it.isDeleted,
                        uid = it.uid
                    )
                }
                stoken = chunk.stoken
                done = chunk.isDone
                if (!done && (stoken == null || stoken == previousToken))
                    throw IllegalStateException("Collection inventory token did not progress")
            }
            byUid.values.toList().also { inventory ->
                qualifyingCollectionTypes = CollectionEligibility.qualifyingTypes(inventory, required.toSet())
                integrationCollectionTypes = CollectionEligibility.activeTypes(inventory, required.toSet())
                inventoryLoaded = true
            }
        }, createAndCache = { type ->
            checkpoint()
            val metadata = ItemMetadata().apply {
                name = defaultName(type)
                mtime = System.currentTimeMillis()
            }
            val created = manager.create(type, metadata, "")
            checkpoint()
            manager.upload(created)
            // Cache failure is an uncertain result; the coordinator refreshes remotely before retrying.
            checkpoint()
            synchronized(cache) { cache.collectionSet(manager, created) }
        })
        return when (reconciliation) {
            CollectionReconciliation.Result.Ready -> false
            CollectionReconciliation.Result.Limited -> true
            CollectionReconciliation.Result.Recovery -> throw IllegalStateException("No recoverable remote collection inventory")
        }
    }

    private fun defaultName(type: String) = when (type) {
        Constants.ETEBASE_TYPE_ADDRESS_BOOK -> "My Contacts"
        Constants.ETEBASE_TYPE_CALENDAR -> "My Calendar"
        Constants.ETEBASE_TYPE_TASKS -> "My Tasks"
        else -> type
    }
}
