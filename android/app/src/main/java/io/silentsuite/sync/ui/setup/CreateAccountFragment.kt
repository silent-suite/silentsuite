/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Activity
import android.app.Dialog
import android.os.Bundle
import android.provider.CalendarContract
import androidx.fragment.app.DialogFragment
import at.bitfire.ical4android.TaskProvider.Companion.TASK_PROVIDERS
import io.silentsuite.sync.*
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.utils.ProgressDialogHelper
import io.silentsuite.sync.ui.setup.BaseConfigurationFinder.Configuration
import io.silentsuite.sync.utils.AndroidCompat
import io.silentsuite.sync.utils.TaskProviderHandling
import java.util.logging.Level

class CreateAccountFragment : DialogFragment() {

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        isCancelable = false
        return ProgressDialogHelper.createIndeterminate(
            requireContext(),
            R.string.setting_up_encryption,
            getString(R.string.setting_up_encryption_content)
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val config = SetupSecretHolder.getPendingConfiguration()
        if (config == null) {
            Logger.log.severe("Setup configuration expired before account creation")
            SetupSecretHolder.clearCredentialsAndConfiguration()
            parentFragmentManager.beginTransaction()
                    .add(DetectConfigurationFragment.NothingDetectedFragment.newInstance(getString(R.string.setup_state_expired)), null)
                    .commitAllowingStateLoss()
            dismissAllowingStateLoss()
            return
        }

        val activity = requireActivity()
        val account = try {
            createAccount(config.userName, config)
        } catch (e: InvalidAccountException) {
            SetupSecretHolder.clearCredentialsAndConfiguration()
            throw e
        }
        if (account != null) {
            activity.setResult(Activity.RESULT_OK)
            SetupSecretHolder.setPendingSession(account.name, config.etebaseSession)
            SetupSecretHolder.clearCredentialsAndConfiguration()
            startActivity(ModeSelectionActivity.newIntent(requireContext(), account))
            activity.finish()
        } else {
            // Issue #119: addAccountExplicitly returned false (e.g. partial-state collision
            // with a previously removed account row that AccountManager hasn't fully
            // garbage-collected). Previously this branch silently no-op'd, leaving the user
            // staring at a frozen "setting up encryption" progress dialog. Log the failure
            // and dismiss the dialog so the operator notices and the user can retry.
            Logger.log.log(Level.SEVERE, "addAccountExplicitly returned false")
            SetupSecretHolder.clearCredentialsAndConfiguration()
            dismissAllowingStateLoss()
        }
    }

    @Throws(InvalidAccountException::class)
    protected fun createAccount(accountName: String, config: Configuration): Account? {
        val account = Account(accountName, App.accountType)

        // create Android account
        Logger.log.log(Level.INFO, "Creating Android account with initial config")

        val accountManager = AccountManager.get(context)
        if (!accountManager.addAccountExplicitly(account, null, null))
            return null

        AccountSettings.setUserData(accountManager, account, config.url, config.userName)

        // add entries for account to service DB
        Logger.log.log(Level.INFO, "Writing account configuration to database")
        try {
            val settings = AccountSettings(requireContext(), account)

            settings.etebaseSession = config.etebaseSession

            // contact sync is automatically enabled by isAlwaysSyncable="true" in res/xml/sync_contacts.xml
            settings.setSyncInterval(App.addressBooksAuthority, Constants.DEFAULT_SYNC_INTERVAL.toLong())

            // calendar sync is automatically enabled by isAlwaysSyncable="true" in res/xml/sync_contacts.xml
            settings.setSyncInterval(CalendarContract.AUTHORITY, Constants.DEFAULT_SYNC_INTERVAL.toLong())

            TASK_PROVIDERS.forEach {
                // enable task sync if OpenTasks is installed
                // further changes will be handled by PackageChangedReceiver
                TaskProviderHandling.updateTaskSync(requireContext(), it)
            }

        } catch (e: InvalidAccountException) {
            Logger.log.log(Level.SEVERE, "Couldn't access account settings", e)
            AndroidCompat.removeAccount(accountManager, account)
            throw e
        }

        return account
    }

    companion object {
        fun newInstance(config: Configuration): CreateAccountFragment {
            SetupSecretHolder.setPendingConfiguration(config)
            return CreateAccountFragment()
        }
    }
}
