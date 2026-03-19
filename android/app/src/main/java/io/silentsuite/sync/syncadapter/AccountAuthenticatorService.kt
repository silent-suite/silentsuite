/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */
package io.silentsuite.sync.syncadapter

import android.accounts.*
import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Bundle
import at.bitfire.vcard4android.ContactsStorageException
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger

import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.ui.setup.LoginActivity
import java.util.*
import java.util.logging.Level


/**
 * Account authenticator for the main SilentSuite account enumType.
 *
 * Gets started when a SilentSuite account is removed, too, so it also watches for account removals
 * and contains the corresponding cleanup code.
 */
class AccountAuthenticatorService: Service(), OnAccountsUpdateListener {
    companion object {

        @SuppressLint("MissingPermission")
        internal fun cleanupAccounts(context: Context) {
            Logger.log.info("Cleaning up orphaned accounts")

            val accountNames = LinkedList<String>()
            val am = AccountManager.get(context)
            for (account in am.getAccountsByType(context.getString(R.string.account_type))) {
                accountNames.add(account.name)
            }

            // delete orphaned address book accounts
            for (addrBookAccount in am.getAccountsByType(context.getString(R.string.account_type_address_book))) {
                val addressBook = LocalAddressBook(context, addrBookAccount, null)
                try {
                    if (!accountNames.contains(addressBook.mainAccount.name))
                        addressBook.delete()
                } catch (e: ContactsStorageException) {
                    Logger.log.log(Level.SEVERE, "Couldn't get address book main account", e)
                }

            }
        }
    }

    private lateinit var accountManager: AccountManager
    private lateinit var accountAuthenticator: AccountAuthenticator



    override fun onCreate() {
        accountManager = AccountManager.get(this)
        accountManager.addOnAccountsUpdatedListener(this, null, true)

        accountAuthenticator = AccountAuthenticator(this)
    }

    override fun onDestroy() {
        super.onDestroy()
        accountManager.removeOnAccountsUpdatedListener(this)
    }

    override fun onBind(intent: Intent?) =
            accountAuthenticator.iBinder.takeIf { intent?.action == android.accounts.AccountManager.ACTION_AUTHENTICATOR_INTENT }


    override fun onAccountsUpdated(accounts: Array<out Account>?) {
        cleanupAccounts(this)
    }


    private class AccountAuthenticator(
            val context: Context
    ): AbstractAccountAuthenticator(context) {

        override fun addAccount(response: AccountAuthenticatorResponse?, accountType: String?, authTokenType: String?, requiredFeatures: Array<String>?, options: Bundle?): Bundle {
            val intent = Intent(context, LoginActivity::class.java)
            intent.putExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE, response)
            val bundle = Bundle(1)
            bundle.putParcelable(AccountManager.KEY_INTENT, intent)
            return bundle
        }

        override fun editProperties(response: AccountAuthenticatorResponse?, accountType: String?)  = null
        override fun getAuthTokenLabel(p0: String?) = null
        override fun confirmCredentials(p0: AccountAuthenticatorResponse?, p1: Account?, p2: Bundle?) = null
        override fun updateCredentials(p0: AccountAuthenticatorResponse?, p1: Account?, p2: String?, p3: Bundle?) = null
        override fun getAuthToken(p0: AccountAuthenticatorResponse?, p1: Account?, p2: String?, p3: Bundle?) = null
        override fun hasFeatures(p0: AccountAuthenticatorResponse?, p1: Account?, p2: Array<out String>?) = null

    }
}
