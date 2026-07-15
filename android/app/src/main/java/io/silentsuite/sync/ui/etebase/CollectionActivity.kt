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
        installInitialView = route.collectionUid != null && !hasRestoredFragment

        model.loadAccount(this, account)
        model.observe(this) { accountHolder ->
            val colUid = route.collectionUid
            if (colUid != null) {
                collectionModel.loadCollection(accountHolder, colUid)
            } else if (collectionModel.value == null) {
                lifecycleScope.launch {
                    val cachedCollection = withContext(Dispatchers.IO) {
                        val meta = ItemMetadata()
                        meta.name = ""
                        CachedCollection(accountHolder.colMgr.create(requireNotNull(route.collectionType), meta, ""), meta, route.collectionType)
                    }
                    collectionModel.setCollection(cachedCollection)
                }
            }
        }
        collectionModel.observe(this) { cachedCollection ->
            model.value?.let { accountHolder ->
                if (route.collectionUid != null) {
                    itemsModel.loadItems(accountHolder, cachedCollection)
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
        private const val EXTRA_ACCOUNT = "account"
        private const val EXTRA_COLLECTION_UID = "collectionUid"
        private const val EXTRA_COLLECTION_TYPE = "collectionType"
        private const val EXTRA_CREATION_ID = "creationId"

        fun newIntent(context: Context, account: Account, colUid: String): Intent {
            require(colUid.isNotBlank()) { "Collection UID must be nonblank" }
            val intent = Intent(context, CollectionActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            intent.putExtra(EXTRA_CREATION_ID, currentCreationId(context, account))
            intent.putExtra(EXTRA_COLLECTION_UID, colUid)
            return intent
        }

        fun newCreateCollectionIntent(context: Context, account: Account, colType: String): Intent {
            val intent = Intent(context, CollectionActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            intent.putExtra(EXTRA_CREATION_ID, currentCreationId(context, account))
            intent.putExtra(EXTRA_COLLECTION_TYPE, colType)
            return intent
        }

        private fun currentCreationId(context: Context, account: Account): String? =
            AccountManager.get(context).getUserData(account, AccountSettings.KEY_CREATION_ID)
                ?.takeIf { it.isNotBlank() }
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

    fun initialize(context: Context, account: Account, sessionOverride: String? = null) {
        if (initializedAccount == account)
            return
        check(initializedAccount == null) { "AccountViewModel cannot be reused for another account" }
        initializedAccount = account

        viewModelScope.launch {
            val accountHolder = withContext(Dispatchers.IO) {
                val settings = AccountSettings(context, account)
                val etebaseLocalCache = EtebaseLocalCache.getInstance(context, account.name)
                val httpClient = HttpClient.Builder(context).setForeground(true).build().okHttpClient
                val etebase = EtebaseLocalCache.getEtebase(context, httpClient, settings, sessionOverride)
                val colMgr = etebase.collectionManager
                AccountHolder(
                        account,
                        etebaseLocalCache,
                        etebase,
                        colMgr
                )
            }
            holder.value = accountHolder
        }
    }

    fun loadAccount(context: Context, account: Account, sessionOverride: String? = null) =
        initialize(context, account, sessionOverride)

    fun observe(owner: LifecycleOwner, observer: (AccountHolder) -> Unit) =
            holder.observe(owner, observer)

    val value: AccountHolder?
        get() = holder.value
}

data class AccountHolder(val account: Account, val etebaseLocalCache: EtebaseLocalCache, val etebase: com.etebase.client.Account, val colMgr: CollectionManager)

class CollectionViewModel : ViewModel() {
    private val collection = MutableLiveData<CachedCollection>()
    private var initializedUid: String? = null

    fun loadCollection(accountHolder: AccountHolder, colUid: String) {
        if (initializedUid == colUid) return
        check(initializedUid == null) { "CollectionViewModel cannot be reused for another collection" }
        initializedUid = colUid
        viewModelScope.launch {
            val cachedCollection = withContext(Dispatchers.IO) {
                val etebaseLocalCache = accountHolder.etebaseLocalCache
                val colMgr = accountHolder.colMgr
                synchronized(etebaseLocalCache) {
                    etebaseLocalCache.collectionGet(colMgr, colUid)!!
                }
            }
            collection.value = cachedCollection
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

    fun loadItems(accountCollectionHolder: AccountHolder, cachedCollection: CachedCollection) {
        viewModelScope.launch {
            val items = withContext(Dispatchers.IO) {
                val col = cachedCollection.col
                val itemMgr = accountCollectionHolder.colMgr.getItemManager(col)
                accountCollectionHolder.etebaseLocalCache.itemList(itemMgr, col.uid, withDeleted = true)
            }
            cachedItems.value = items
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
