/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 * Modified by Silent Suite
 */

package io.silentsuite.sync.ui.etebase

import android.app.Dialog
import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckedTextView
import android.widget.TextView
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.fragment.app.commit
import androidx.fragment.app.viewModels
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.observe
import com.etebase.client.Account
import com.etebase.client.Client
import com.etebase.client.User
import com.etebase.client.exceptions.EtebaseException
import io.silentsuite.sync.Constants
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.WebViewActivity
import io.silentsuite.sync.ui.setup.*
import io.silentsuite.sync.utils.ProgressDialogHelper
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import net.cachapa.expandablelayout.ExpandableLayout
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URI

class SignupFragment : Fragment() {
    internal var initialEmail: String? = null
    internal var initialPassword: String? = null
    internal lateinit var editEmail: TextInputLayout
    internal lateinit var editPassword: TextInputLayout

    internal lateinit var showAdvanced: CheckedTextView
    internal lateinit var customServer: TextInputEditText


    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val v = inflater.inflate(R.layout.signup_fragment, container, false)

        editEmail = v.findViewById(R.id.email)
        editPassword = v.findViewById(R.id.url_password)
        showAdvanced = v.findViewById(R.id.show_advanced)
        customServer = v.findViewById(R.id.custom_server)
        v.findViewById<TextView>(R.id.trial_notice).setOnClickListener {
            startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Constants.webAppUri))
        }

        if (savedInstanceState == null) {
            editEmail.editText?.setText(initialEmail ?: "")
            editPassword.editText?.setText(initialPassword ?: "")
        }

        val login = v.findViewById<Button>(R.id.login)
        login.setOnClickListener {
            parentFragmentManager.commit {
                replace(android.R.id.content, LoginCredentialsFragment.newInstance(editEmail.editText?.text.toString(), editPassword.editText?.text.toString()))
            }
        }

        val createAccount = v.findViewById<Button>(R.id.create_account)
        createAccount.setOnClickListener {
            val credentials = validateData()
            if (credentials != null) {
                SignupDoFragment.newInstance(credentials).show(requireFragmentManager(), null)
            }
        }

        val advancedLayout = v.findViewById<View>(R.id.advanced_layout) as ExpandableLayout

        showAdvanced.setOnClickListener {
            if (showAdvanced.isChecked) {
                showAdvanced.isChecked = false
                advancedLayout.collapse()
            } else {
                showAdvanced.isChecked = true
                advancedLayout.expand()
            }
        }

        return v
    }

    protected fun validateData(): SignupCredentials? {
        var valid = true

        val email = editEmail.editText?.text.toString()
        if (email.isEmpty() || !android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()) {
            editEmail.error = getString(R.string.login_email_address_error)
            valid = false
        } else {
            editEmail.error = null
        }

        val password = editPassword.editText?.text.toString()
        if (password.length < 8) {
            editPassword.error = getString(R.string.signup_password_restrictions)
            valid = false
        } else {
            editPassword.error = null
        }

        var uri: URI? = null
        if (showAdvanced.isChecked) {
            val server = customServer.text.toString()
            if (!server.isEmpty()) {
                val url = server.toHttpUrlOrNull()
                if (url != null) {
                    uri = url.toUri()
                    customServer.error = null
                } else {
                    customServer.error = getString(R.string.login_custom_server_error)
                    valid = false
                }
            }
        }

        // Use email as the username for Etebase
        return if (valid) SignupCredentials(uri, email, email, password) else null
    }

    companion object {
        fun newInstance(initialEmail: String?, initialPassword: String?): SignupFragment {
            val ret = SignupFragment()
            ret.initialEmail = initialEmail
            ret.initialPassword = initialPassword
            return ret
        }
    }
}



class SignupDoFragment: DialogFragment() {
    private val model: ConfigurationViewModel by viewModels()

    private lateinit var signupCredentials: SignupCredentials

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

        if (savedInstanceState == null) {
            model.signup(requireContext(), signupCredentials)
            model.observe(this) {
                if (it.isFailed) {
                    requireFragmentManager().beginTransaction()
                            .add(DetectConfigurationFragment.NothingDetectedFragment.newInstance(it.error!!.localizedMessage), null)
                            .commitAllowingStateLoss()
                } else {
                    requireFragmentManager().beginTransaction()
                            .replace(android.R.id.content, CreateAccountFragment.newInstance(it))
                            .addToBackStack(null)
                            .commitAllowingStateLoss()
                }
                dismissAllowingStateLoss()
            }
        }
    }

    companion object {
        fun newInstance(signupCredentials: SignupCredentials): SignupDoFragment {
            val ret = SignupDoFragment()
            ret.signupCredentials = signupCredentials
            return ret
        }
    }
}

class ConfigurationViewModel : ViewModel() {
    val account = MutableLiveData<BaseConfigurationFinder.Configuration>()
    private var asyncTask: Job? = null

    fun signup(context: Context, credentials: SignupCredentials) {
        asyncTask = viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                val httpClient = HttpClient.Builder(context).build().okHttpClient
                val uri = credentials.uri ?: URI(Constants.etebaseServiceUrl)
                var etebaseSession: String? = null
                var exception: Throwable? = null
                try {
                    val client = Client.create(httpClient, uri.toString())
                    val user = User(credentials.userName, credentials.email)
                    val etebase = Account.signup(client, user, credentials.password)
                    etebaseSession = etebase.save(null)
                } catch (e: EtebaseException) {
                    exception = e
                }

                BaseConfigurationFinder.Configuration(
                        uri,
                        credentials.userName,
                        etebaseSession,
                        exception
                )
            }
            account.value = result
        }
    }

    fun login(context: Context, credentials: LoginCredentials) {
        asyncTask = viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                val httpClient = HttpClient.Builder(context).build().okHttpClient
                val uri = credentials.uri ?: URI(Constants.etebaseServiceUrl)
                var etebaseSession: String? = null
                var exception: Throwable? = null
                try {
                    val client = Client.create(httpClient, uri.toString())
                    val etebase = Account.login(client, credentials.userName, credentials.password)
                    etebaseSession = etebase.save(null)
                } catch (e: EtebaseException) {
                    exception = e
                }

                BaseConfigurationFinder.Configuration(
                        uri,
                        credentials.userName,
                        etebaseSession,
                        exception
                )
            }
            account.value = result
        }
    }

    fun cancelLoad() {
        asyncTask?.cancel()
    }

    fun observe(owner: LifecycleOwner, observer: (BaseConfigurationFinder.Configuration) -> Unit) =
            account.observe(owner, observer)
}

data class SignupCredentials(val uri: URI?, val userName: String, val email: String, val password: String)
