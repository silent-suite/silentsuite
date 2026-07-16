package io.silentsuite.sync.ui.etebase

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.viewModels
import androidx.fragment.app.commit
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.observe
import androidx.lifecycle.viewModelScope
import com.etebase.client.CollectionManager
import com.etebase.client.ItemMetadata
import io.silentsuite.sync.*
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.setup.ExactAccountRouting
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Process-local presentation data used by runtime route tests; never persisted. */
internal data class RuntimeCollectionFixture(
    val uid: String,
    val type: String,
    val name: String,
    val description: String?,
    val color: Int,
    val accessLevel: com.etebase.client.CollectionAccessLevel,
    val itemContents: List<String>,
    val members: List<RuntimeMember>
)

internal data class RuntimeMember(val username: String, val accessLevel: com.etebase.client.CollectionAccessLevel)

@Volatile
internal var runtimeFixtureOverride: ((Context, Account, String, String?, String?) -> RuntimeCollectionFixture?)? = null

internal fun runtimeFixture(context: Context, identity: CollectionLifecycleIdentity): RuntimeCollectionFixture? =
    runtimeFixtureOverride?.invoke(context, identity.account, identity.creationId, identity.collectionUid, identity.collectionType)

internal data class RuntimeCollectionMutation(
    val name: String, val description: String?, val color: Int, val creating: Boolean
)

@Volatile
internal var collectionMutationOverride: ((Context, CollectionLifecycleIdentity, RuntimeCollectionMutation) -> String?)? = null

class CollectionActivity() : BaseActivity() {
    private lateinit var account: Account
    private val model: AccountViewModel by viewModels()
    private val collectionModel: CollectionViewModel by viewModels()
    private val itemsModel: ItemsViewModel by viewModels()
    private var installInitialView = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val route = intentRoute() ?: run {
            finish()
            return
        }
        val exactAccount = ExactAccountRouting.validate(route.account, route.creationId, App.accountType, AccountManager.get(this))
        if (exactAccount == null) {
            finish()
            return
        }
        account = exactAccount
        setContentView(R.layout.etebase_fragment_activity)
        val hasRestoredFragment = supportFragmentManager.findFragmentById(R.id.fragment_container) != null
        val fixture = runtimeFixtureOverride?.invoke(this, account, route.creationId, route.collectionUid, route.collectionType)
        if (fixture != null) {
            if (route.collectionUid != null) {
                if (fixture.uid != route.collectionUid) { finish(); return }
                if (!hasRestoredFragment) supportFragmentManager.commit {
                    replace(R.id.fragment_container, ViewCollectionFragment.newInstance(
                        CollectionLifecycleIdentity.existing(account, route.creationId, fixture.uid, fixture.type)))
                }
            } else {
                if (fixture.type != route.collectionType) { finish(); return }
                if (!hasRestoredFragment) supportFragmentManager.commit {
                    replace(R.id.fragment_container, EditCollectionFragment.newInstance(
                        CollectionLifecycleIdentity.creating(account, route.creationId, fixture.type), true))
                }
            }
            supportActionBar?.setDisplayHomeAsUpEnabled(true)
            return
        }
        installInitialView = route.collectionUid != null && !hasRestoredFragment

        model.loadAccount(this, account, route.creationId)
        model.observe(this) { accountHolder ->
            val colUid = route.collectionUid
            if (colUid != null) {
                collectionModel.loadCollection(this, route.account, route.creationId, accountHolder, colUid)
            } else if (collectionModel.value == null) {
                lifecycleScope.launch {
                    val cachedCollection = withContext(Dispatchers.IO) {
                        if (ExactAccountRouting.validate(route.account, route.creationId, App.accountType,
                                AccountManager.get(applicationContext)) == null) return@withContext null
                        val meta = ItemMetadata()
                        meta.name = ""
                        val created = CachedCollection(accountHolder.colMgr.create(requireNotNull(route.collectionType), meta, ""), meta, route.collectionType)
                        if (ExactAccountRouting.validate(route.account, route.creationId, App.accountType,
                                AccountManager.get(applicationContext)) == null) null else created
                    }
                    if (cachedCollection != null && ExactAccountRouting.validate(route.account, route.creationId,
                            App.accountType, AccountManager.get(applicationContext)) != null)
                        collectionModel.setCollection(cachedCollection)
                }
            }
        }
        collectionModel.observe(this) { cachedCollection ->
            model.value?.let { accountHolder ->
                if (route.collectionUid != null) {
                    itemsModel.loadItems(this, route.account, route.creationId, route.collectionUid, accountHolder, cachedCollection)
                    if (installInitialView) {
                        installInitialView = false
                        val exactIdentity = CollectionLifecycleIdentity.existing(
                            account,
                            route.creationId,
                            cachedCollection.col.uid,
                            cachedCollection.collectionType
                        )
                        supportFragmentManager.commit {
                            replace(R.id.fragment_container, ViewCollectionFragment.newInstance(exactIdentity))
                        }
                    }
                }
            }
        }

        if (route.collectionUid == null && !hasRestoredFragment) {
            val identity = CollectionLifecycleIdentity.creating(account, route.creationId, requireNotNull(route.collectionType))
            supportFragmentManager.commit {
                replace(R.id.fragment_container, EditCollectionFragment.newInstance(identity, true))
            }
        }

        supportActionBar?.setDisplayHomeAsUpEnabled(true)
    }

    companion object {
        internal const val EXTRA_ACCOUNT = "account"
        internal const val EXTRA_COLLECTION_UID = "collectionUid"
        internal const val EXTRA_COLLECTION_TYPE = "collectionType"
        internal const val EXTRA_CREATION_ID = "creationId"

        fun newIntent(context: Context, account: Account, creationId: String, colUid: String): Intent {
            require(colUid.isNotBlank()) { "Collection UID must be nonblank" }
            require(creationId.isNotBlank()) { "Creation ID must be nonblank" }
            val intent = Intent(context, CollectionActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            intent.putExtra(EXTRA_CREATION_ID, creationId)
            intent.putExtra(EXTRA_COLLECTION_UID, colUid)
            return intent
        }

        fun newCreateCollectionIntent(context: Context, account: Account, creationId: String, colType: String): Intent {
            require(creationId.isNotBlank()) { "Creation ID must be nonblank" }
            val intent = Intent(context, CollectionActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            intent.putExtra(EXTRA_CREATION_ID, creationId)
            intent.putExtra(EXTRA_COLLECTION_TYPE, colType)
            return intent
        }
    }

    private data class CollectionRoute(
        val account: Account,
        val creationId: String,
        val collectionUid: String?,
        val collectionType: String?
    )

    private fun intentRoute(): CollectionRoute? {
        val extras = intent.extras ?: return null
        val exactAccount = extras.getParcelable<Account>(EXTRA_ACCOUNT) ?: return null
        val creationId = extras.getString(EXTRA_CREATION_ID)?.takeIf { it.isNotBlank() } ?: return null
        val uid = extras.getString(EXTRA_COLLECTION_UID)
        val type = extras.getString(EXTRA_COLLECTION_TYPE)
        if ((uid == null) == (type == null)) return null
        return if (uid != null) {
            if (uid.isBlank()) null else CollectionRoute(exactAccount, creationId, uid, null)
        } else {
            runCatching {
                CollectionLifecycleIdentity.creating(exactAccount, creationId, type!!)
                CollectionRoute(exactAccount, creationId, null, type)
            }.getOrNull()
        }
    }
}

class AccountViewModel : ViewModel() {
    private val holder = MutableLiveData<AccountHolder>()
    private var initializedAccount: Account? = null

    fun initialize(context: Context, account: Account, creationId: String, sessionOverride: String? = null) {
        if (initializedAccount == account)
            return
        check(initializedAccount == null) { "AccountViewModel cannot be reused for another account" }
        initializedAccount = account

        viewModelScope.launch {
            val accountHolder = withContext(Dispatchers.IO) {
                val manager = AccountManager.get(context)
                if (ExactAccountRouting.validate(account, creationId, App.accountType, manager) == null)
                    return@withContext null
                val settings = AccountSettings(context, account)
                if (ExactAccountRouting.validate(account, creationId, App.accountType, manager) == null)
                    return@withContext null
                val etebaseLocalCache = EtebaseLocalCache.getInstance(context, account.name)
                if (ExactAccountRouting.validate(account, creationId, App.accountType, manager) == null)
                    return@withContext null
                val httpClient = HttpClient.Builder(context).setForeground(true).build().okHttpClient
                val etebase = EtebaseLocalCache.getEtebase(context, httpClient, settings, sessionOverride)
                if (ExactAccountRouting.validate(account, creationId, App.accountType, manager) == null)
                    return@withContext null
                val colMgr = etebase.collectionManager
                AccountHolder(
                        account,
                        etebaseLocalCache,
                        etebase,
                        colMgr
                )
            }
            if (accountHolder != null && ExactAccountRouting.validate(account, creationId, App.accountType,
                    AccountManager.get(context)) != null)
                holder.value = accountHolder
        }
    }

    fun loadAccount(context: Context, account: Account, creationId: String, sessionOverride: String? = null) =
        initialize(context, account, creationId, sessionOverride)

    fun observe(owner: LifecycleOwner, observer: (AccountHolder) -> Unit) =
            holder.observe(owner, observer)

    val value: AccountHolder?
        get() = holder.value
}

data class AccountHolder(val account: Account, val etebaseLocalCache: EtebaseLocalCache, val etebase: com.etebase.client.Account, val colMgr: CollectionManager)

class CollectionViewModel : ViewModel() {
    private val collection = MutableLiveData<CachedCollection>()
    private var initializedUid: String? = null

    fun loadCollection(context: Context, account: Account, creationId: String, accountHolder: AccountHolder, colUid: String) {
        if (initializedUid == colUid) return
        check(initializedUid == null) { "CollectionViewModel cannot be reused for another collection" }
        initializedUid = colUid
        viewModelScope.launch {
            val cachedCollection = withContext(Dispatchers.IO) {
                if (ExactAccountRouting.validate(account, creationId, App.accountType, AccountManager.get(context)) == null ||
                    accountHolder.account != account) return@withContext null
                val etebaseLocalCache = accountHolder.etebaseLocalCache
                val colMgr = accountHolder.colMgr
                synchronized(etebaseLocalCache) {
                    if (ExactAccountRouting.validate(account, creationId, App.accountType, AccountManager.get(context)) == null ||
                        accountHolder.account != account) return@withContext null
                    val value = etebaseLocalCache.collectionGet(colMgr, colUid)
                    if (ExactAccountRouting.validate(account, creationId, App.accountType, AccountManager.get(context)) == null ||
                        accountHolder.account != account) null else value
                }
            }
            if (cachedCollection != null && ExactAccountRouting.validate(account, creationId, App.accountType, AccountManager.get(context)) != null &&
                accountHolder.account == account) collection.value = cachedCollection
        }
    }

    fun observe(owner: LifecycleOwner, observer: (CachedCollection) -> Unit) =
            collection.observe(owner, observer)

    val value: CachedCollection?
        get() = collection.value

    fun setCollection(cachedCollection: CachedCollection) {
        check(initializedUid == null || initializedUid == cachedCollection.col.uid)
        initializedUid = cachedCollection.col.uid
        collection.value = cachedCollection
    }
}

class ItemsViewModel : ViewModel() {
    private val cachedItems = MutableLiveData<List<CachedItem>>()

    fun loadItems(context: Context, account: Account, creationId: String, collectionUid: String, accountCollectionHolder: AccountHolder, cachedCollection: CachedCollection) {
        viewModelScope.launch {
            val items = withContext(Dispatchers.IO) {
                if (ExactAccountRouting.validate(account, creationId, App.accountType, AccountManager.get(context)) == null ||
                    accountCollectionHolder.account != account || cachedCollection.col.uid != collectionUid) return@withContext null
                val col = cachedCollection.col
                val itemMgr = accountCollectionHolder.colMgr.getItemManager(col)
                if (ExactAccountRouting.validate(account, creationId, App.accountType, AccountManager.get(context)) == null ||
                    accountCollectionHolder.account != account || cachedCollection.col.uid != collectionUid) return@withContext null
                val value = accountCollectionHolder.etebaseLocalCache.itemList(itemMgr, col.uid, withDeleted = true)
                if (ExactAccountRouting.validate(account, creationId, App.accountType, AccountManager.get(context)) == null ||
                    accountCollectionHolder.account != account || cachedCollection.col.uid != collectionUid) null else value
            }
            if (items != null && ExactAccountRouting.validate(account, creationId, App.accountType, AccountManager.get(context)) != null &&
                accountCollectionHolder.account == account && cachedCollection.col.uid == collectionUid) cachedItems.value = items
        }
    }

    fun observe(owner: LifecycleOwner, observer: (List<CachedItem>) -> Unit) =
            cachedItems.observe(owner, observer)

    val value: List<CachedItem>?
        get() = cachedItems.value
}


class LoadingViewModel : ViewModel() {
    private val loading = MutableLiveData(false)

    fun setLoading(value: Boolean) {
        loading.value = value
    }

    fun observe(owner: LifecycleOwner, observer: (Boolean) -> Unit) =
            loading.observe(owner, observer)

    val isLoading: Boolean
        get() = loading.value == true
}
