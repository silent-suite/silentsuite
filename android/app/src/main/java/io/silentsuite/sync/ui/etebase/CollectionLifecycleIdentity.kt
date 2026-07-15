package io.silentsuite.sync.ui.etebase

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.os.Bundle
import io.silentsuite.sync.Constants
import io.silentsuite.sync.App
import io.silentsuite.sync.ui.setup.ExactAccountRouting

/** Non-secret identity required to restore an active collection surface exactly. */
data class CollectionLifecycleIdentity(
    val account: Account,
    val creationId: String,
    val collectionUid: String?,
    val collectionType: String
) {
    init {
        require(account.name.isNotBlank()) { "Collection identity requires an account name" }
        require(account.type == App.accountType) { "Collection identity requires the app account type" }
        require(creationId.isNotBlank()) { "Collection identity requires a creation generation" }
        require(collectionUid == null || collectionUid.isNotBlank()) { "Collection UID must be nonblank" }
        require(collectionType in SUPPORTED_TYPES) { "Unsupported collection type" }
    }

    fun toBundle(): Bundle = Bundle().apply {
        putParcelable(ARG_ACCOUNT, account)
        putString(ARG_CREATION_ID, creationId)
        collectionUid?.let { putString(ARG_COLLECTION_UID, it) }
        putString(ARG_COLLECTION_TYPE, collectionType)
    }

    companion object {
        const val ARG_ACCOUNT = "collection.identity.account"
        const val ARG_CREATION_ID = "collection.identity.creationId"
        const val ARG_COLLECTION_UID = "collection.identity.uid"
        const val ARG_COLLECTION_TYPE = "collection.identity.type"

        private val SUPPORTED_TYPES = setOf(
            Constants.ETEBASE_TYPE_CALENDAR,
            Constants.ETEBASE_TYPE_TASKS,
            Constants.ETEBASE_TYPE_ADDRESS_BOOK
        )

        fun existing(account: Account, creationId: String, uid: String, type: String) =
            CollectionLifecycleIdentity(account, creationId, uid, type)

        fun creating(account: Account, creationId: String, type: String) =
            CollectionLifecycleIdentity(account, creationId, null, type)

        fun from(bundle: Bundle?): CollectionLifecycleIdentity? {
            bundle ?: return null
            val account = bundle.getParcelable<Account>(ARG_ACCOUNT) ?: return null
            val creationId = bundle.getString(ARG_CREATION_ID) ?: return null
            val type = bundle.getString(ARG_COLLECTION_TYPE) ?: return null
            val uid = bundle.getString(ARG_COLLECTION_UID)
            return runCatching { CollectionLifecycleIdentity(account, creationId, uid, type) }.getOrNull()
        }
    }

    fun validate(context: Context): Boolean =
        ExactAccountRouting.validate(account, creationId, App.accountType, AccountManager.get(context)) == account
}
