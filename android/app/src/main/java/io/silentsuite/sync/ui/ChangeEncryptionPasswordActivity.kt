/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.TextView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.etebase.client.Client
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.syncadapter.requestSync
import io.silentsuite.sync.utils.ProgressDialogHelper
import io.silentsuite.sync.ui.setup.ExactAccountRouting
import com.google.android.material.textfield.TextInputLayout
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

open class ChangeEncryptionPasswordActivity : BaseActivity() {

    protected lateinit var account: Account
    private lateinit var accountCreationId: String
    lateinit var progress: Dialog

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val extras = intent.extras ?: run {
            finish()
            return
        }
        val requestedAccount = extras.getParcelable<Account>(EXTRA_ACCOUNT)
        val creationId = extras.getString(EXTRA_CREATION_ID)?.takeIf { it.isNotBlank() }
        val exactAccount = if (requestedAccount != null && creationId != null) {
            ExactAccountRouting.validate(requestedAccount, creationId, io.silentsuite.sync.App.accountType, AccountManager.get(this))
        } else null
        account = exactAccount ?: run {
            finish()
            return
        }
        accountCreationId = requireNotNull(creationId)

        supportActionBar!!.setDisplayHomeAsUpEnabled(true)

        setContentView(R.layout.change_encryption_password)
        findViewById<TextView>(R.id.account_name).text = account.name
    }

    fun onCancelClicked(v: View) {
        finish()
    }

    fun changePasswordError(e: Exception) {
        progress.dismiss()
        MaterialAlertDialogBuilder(this)
                .setTitle(R.string.wrong_encryption_password)
                .setIcon(R.drawable.ic_error_dark)
                .setMessage(e.localizedMessage)
                .setPositiveButton(android.R.string.ok) { _, _ ->
                    // dismiss
                }.show()
    }

    fun changePasswordDo(old_password: String, new_password: String) {
        val settings = AccountSettings(this, account)

        lifecycleScope.launch {
            try {
                val changed = withContext(Dispatchers.IO) {
                    if (ExactAccountRouting.validate(account, accountCreationId, io.silentsuite.sync.App.accountType,
                            AccountManager.get(applicationContext)) == null)
                        return@withContext false
                    passwordChangeOverride?.let { return@withContext it(this@ChangeEncryptionPasswordActivity, old_password, new_password) }
                    val httpClient = HttpClient.Builder(this@ChangeEncryptionPasswordActivity).setForeground(true).build().okHttpClient

                    Logger.log.info("Loging in with old password")
                    val client = Client.create(httpClient, settings.uri?.toString())
                    val etebase = com.etebase.client.Account.login(client, account.name, old_password)
                    Logger.log.info("Login successful")

                    if (ExactAccountRouting.validate(account, accountCreationId, io.silentsuite.sync.App.accountType,
                            AccountManager.get(applicationContext)) == null)
                        return@withContext false
                    etebase.changePassword(new_password)

                    if (ExactAccountRouting.validate(account, accountCreationId, io.silentsuite.sync.App.accountType,
                            AccountManager.get(applicationContext)) == null)
                        return@withContext false
                    settings.etebaseSession = etebase.save(null)
                    true
                }

                if (!changed) {
                    progress.dismiss()
                    finish()
                    return@launch
                }

                progress.dismiss()
                MaterialAlertDialogBuilder(this@ChangeEncryptionPasswordActivity)
                        .setTitle(R.string.change_encryption_password_success_title)
                        .setMessage(R.string.change_encryption_password_success_body)
                        .setPositiveButton(android.R.string.ok) { _, _ ->
                            this@ChangeEncryptionPasswordActivity.finish()
                        }.show()

                syncRequestOverride?.invoke(applicationContext, account)
                    ?: requestSync(applicationContext, account)
            } catch (e: Exception) {
                changePasswordError(e)
            }
        }
    }

    fun changePasswordClicked(v: View) {
        val old_password_view = findViewById<TextInputLayout>(R.id.encryption_password)
        val new_password_view = findViewById<TextInputLayout>(R.id.new_encryption_password)

        var valid = true
        val old_password = old_password_view.editText?.text.toString()
        if (old_password.isEmpty()) {
            old_password_view.error = getString(R.string.login_password_required)
            valid = false
        } else {
            old_password_view.error = null
        }
        val new_password = new_password_view.editText?.text.toString()
        if (new_password.isEmpty()) {
            new_password_view.error = getString(R.string.login_password_required)
            valid = false
        } else {
            new_password_view.error = null
        }

        if (!valid) {
            return
        }

        MaterialAlertDialogBuilder(this)
                .setTitle(R.string.delete_collection_confirm_title)
                .setMessage(R.string.change_encryption_password_are_you_sure)
                .setPositiveButton(android.R.string.yes) { _, _ ->
                    progress = ProgressDialogHelper.createIndeterminate(
                        this,
                        R.string.setting_up_encryption,
                        getString(R.string.setting_up_encryption_content)
                    )
                    progress.show()
                    changePasswordDo(old_password, new_password)
                }
                .setNegativeButton(android.R.string.no) { _, _ -> }
                .create().show()
    }

    companion object {
        internal val EXTRA_ACCOUNT = "account"
        internal const val EXTRA_CREATION_ID = "creationId"
        /** Test seam; null is always the real password-change implementation. */
        @Volatile internal var passwordChangeOverride: ((ChangeEncryptionPasswordActivity, String, String) -> Boolean)? = null
        /** Runtime-test seam; null schedules the normal provider sync. */
        @Volatile internal var syncRequestOverride: ((Context, Account) -> Unit)? = null

        fun newIntent(context: Context, account: Account, creationId: String): Intent {
            require(creationId.isNotBlank()) { "Creation ID must be nonblank" }
            val intent = Intent(context, ChangeEncryptionPasswordActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            intent.putExtra(EXTRA_CREATION_ID, creationId)
            return intent
        }
    }
}
