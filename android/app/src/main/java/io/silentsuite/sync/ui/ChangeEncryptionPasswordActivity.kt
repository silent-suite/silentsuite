/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.accounts.Account
import android.app.ProgressDialog
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AlertDialog
import com.etebase.client.Client
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.syncadapter.requestSync
import com.google.android.material.textfield.TextInputLayout
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

open class ChangeEncryptionPasswordActivity : BaseActivity() {

    protected lateinit var account: Account
    lateinit var progress: ProgressDialog

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        account = intent.extras!!.getParcelable(EXTRA_ACCOUNT)!!

        supportActionBar!!.setDisplayHomeAsUpEnabled(true)

        setContentView(R.layout.change_encryption_password)
    }

    fun onCancelClicked(v: View) {
        finish()
    }

    fun changePasswordError(e: Exception) {
        progress.dismiss()
        AlertDialog.Builder(this)
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
                withContext(Dispatchers.IO) {
                    val httpClient = HttpClient.Builder(this@ChangeEncryptionPasswordActivity).setForeground(true).build().okHttpClient

                    Logger.log.info("Loging in with old password")
                    val client = Client.create(httpClient, settings.uri?.toString())
                    val etebase = com.etebase.client.Account.login(client, account.name, old_password)
                    Logger.log.info("Login successful")

                    etebase.changePassword(new_password)

                    settings.etebaseSession = etebase.save(null)
                }

                progress.dismiss()
                AlertDialog.Builder(this@ChangeEncryptionPasswordActivity)
                        .setTitle(R.string.change_encryption_password_success_title)
                        .setMessage(R.string.change_encryption_password_success_body)
                        .setPositiveButton(android.R.string.ok) { _, _ ->
                            this@ChangeEncryptionPasswordActivity.finish()
                        }.show()

                requestSync(applicationContext, account)
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

        AlertDialog.Builder(this)
                .setTitle(R.string.delete_collection_confirm_title)
                .setMessage(R.string.change_encryption_password_are_you_sure)
                .setPositiveButton(android.R.string.yes) { _, _ ->
                    changePasswordDo(old_password, new_password)
                    progress = ProgressDialog(this)
                    progress.setTitle(R.string.setting_up_encryption)
                    progress.setMessage(getString(R.string.setting_up_encryption_content))
                    progress.isIndeterminate = true
                    progress.setCanceledOnTouchOutside(false)
                    progress.setCancelable(false)
                    progress.show()
                }
                .setNegativeButton(android.R.string.no) { _, _ -> }
                .create().show()
    }

    companion object {
        internal val EXTRA_ACCOUNT = "account"

        fun newIntent(context: Context, account: Account): Intent {
            val intent = Intent(context, ChangeEncryptionPasswordActivity::class.java)
            intent.putExtra(EXTRA_ACCOUNT, account)
            return intent
        }
    }
}
