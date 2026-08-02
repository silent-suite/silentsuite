/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui.setup


import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.fragment.app.Fragment

import androidx.core.view.ViewCompat

import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.WebViewActivity
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import net.cachapa.expandablelayout.ExpandableLayout
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.URI

class LoginCredentialsFragment : Fragment() {
    internal lateinit var editUserName: EditText
    internal lateinit var editUrlPassword: TextInputLayout

    internal lateinit var showAdvanced: TextView
    internal lateinit var customServer: EditText
    private var advancedExpanded = false
    private var submissionInProgress = false



    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val v = inflater.inflate(R.layout.login_credentials_fragment, container, false)
        advancedExpanded = savedInstanceState?.getBoolean(KEY_ADVANCED_EXPANDED) ?: advancedExpanded

        applyLoginActionBarInsets(v.findViewById(R.id.login_action_bar))
        ViewCompat.setAccessibilityHeading(v.findViewById(R.id.login_existing_account_heading), true)


        editUserName = v.findViewById<TextInputEditText>(R.id.user_name)
        editUrlPassword = v.findViewById<TextInputLayout>(R.id.url_password)
        showAdvanced = v.findViewById<TextView>(R.id.show_advanced)
        customServer = v.findViewById<TextInputEditText>(R.id.custom_server)


        val login = v.findViewById<View>(R.id.login) as Button
        login.setOnClickListener {
            val credentials = validateLoginData()
            if (credentials != null && !submissionInProgress &&
                parentFragmentManager.findFragmentByTag(LoginActivity.DETECT_CONFIGURATION_TAG) == null) {
                // This guard closes the gap before DialogFragment.show() commits its transaction.
                submissionInProgress = true
                val host = activity as? LoginActivity
                val lease = host?.setupLease()
                val operation = if (lease != null && host != null) host.beginSetupOperation(lease) else null
                if (host == null || lease == null || operation == null || !host.commitSetupOperation(
                        operation,
                        SetupSecretHolder.CommitKind.HOLDER_MUTATION,
                        SetupSecretHolder.CommitKind.FRAGMENT_COMMIT,
                    ) || !SetupSecretHolder.setLoginCredentials(lease, credentials)) {
                    submissionInProgress = false
                    return@setOnClickListener
                }
                DetectConfigurationFragment.newInstance(SetupSecretHolder.reference(lease))
                    .show(requireFragmentManager(), LoginActivity.DETECT_CONFIGURATION_TAG)
            }
        }
        editUrlPassword.editText?.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                login.performClick()
                true
            } else {
                false
            }
        }
        customServer.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                login.performClick()
                true
            } else {
                false
            }
        }

        val forgotPassword = v.findViewById<View>(R.id.forgot_password) as TextView
        forgotPassword.setOnClickListener { WebViewActivity.openUrl(requireContext(), Constants.forgotPassword) }

        val advancedLayout = v.findViewById<View>(R.id.advanced_layout) as ExpandableLayout
        if (advancedExpanded) {
            advancedLayout.expand()
        }
        updateAdvancedDisclosure()

        showAdvanced.setOnClickListener {
            advancedExpanded = !advancedExpanded
            if (advancedExpanded) {
                advancedLayout.expand()
            } else {
                advancedLayout.collapse()
            }
            updateAdvancedDisclosure()
        }

        return v
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(KEY_ADVANCED_EXPANDED, advancedExpanded)
    }

    protected fun validateLoginData(): LoginCredentials? {
        var valid = true

        val userName = editUserName.text.toString()
        if (userName.isEmpty()) {
            editUserName.error = getString(R.string.login_email_address_error)
            valid = false
        } else {
            editUserName.error = null
        }

        val password = editUrlPassword.editText?.text.toString()
        if (password.isEmpty()) {
            editUrlPassword.error = getString(R.string.login_password_required)
            valid = false
        } else {
            editUrlPassword.error = null
        }

        var uri: URI? = null
        if (advancedExpanded) {
            val server = customServer.text.toString()
            // If this field is null, just use the default
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

        return if (valid) LoginCredentials(uri, userName, password) else null
    }

    internal fun onSubmissionFailed() {
        submissionInProgress = false
    }

    private fun updateAdvancedDisclosure() {
        showAdvanced.setCompoundDrawablesRelativeWithIntrinsicBounds(
                0,
                0,
                if (advancedExpanded) R.drawable.ic_chevron_up else R.drawable.ic_chevron_down,
                0
        )
        showAdvanced.contentDescription = getString(
                if (advancedExpanded) R.string.login_custom_server_expanded else R.string.login_custom_server_collapsed
        )
    }

    private fun applyLoginActionBarInsets(actionBar: View) {
        val basePaddingLeft = actionBar.paddingLeft
        val basePaddingTop = actionBar.paddingTop
        val basePaddingRight = actionBar.paddingRight
        val basePaddingBottom = actionBar.paddingBottom

        ViewCompat.setOnApplyWindowInsetsListener(actionBar) { view, insets ->
            view.setPadding(
                    basePaddingLeft,
                    basePaddingTop,
                    basePaddingRight,
                    basePaddingBottom + insets.systemWindowInsetBottom
            )
            insets
        }

        if (ViewCompat.isAttachedToWindow(actionBar)) {
            ViewCompat.requestApplyInsets(actionBar)
        } else {
            actionBar.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(view: View) {
                    view.removeOnAttachStateChangeListener(this)
                    ViewCompat.requestApplyInsets(view)
                }

                override fun onViewDetachedFromWindow(view: View) = Unit
            })
        }
    }

    companion object {
        private const val KEY_ADVANCED_EXPANDED = "advancedExpanded"

    }
}
