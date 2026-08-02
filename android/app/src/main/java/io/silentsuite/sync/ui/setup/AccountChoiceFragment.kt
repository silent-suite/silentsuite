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
import androidx.core.view.ViewCompat
import androidx.fragment.app.Fragment
import io.silentsuite.sync.R

/** Presentation-only first destination for account entry. */
class AccountChoiceFragment : Fragment() {
    private var signupButton: View? = null

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        val view = inflater.inflate(R.layout.account_choice_fragment, container, false)
        val heading = view.findViewById<View>(R.id.account_choice_heading)
        ViewCompat.setAccessibilityHeading(heading, true)
        applyInsets(view.findViewById(R.id.account_choice_scroll))
        view.findViewById<View>(R.id.account_choice_sign_in).setOnClickListener {
            (activity as? LoginActivity)?.takeIf { it.isAccountEntryAdmissionPublished() }?.requestSignIn()
        }
        signupButton = view.findViewById(R.id.account_choice_create_account)
        signupButton?.setOnClickListener { button ->
            val host = (activity as? LoginActivity)?.takeIf { it.isAccountEntryAdmissionPublished() }
            if (host?.requestHostedSignup() == true) button.isEnabled = false
        }
        return view
    }

    override fun onResume() {
        super.onResume()
        refreshHostedSignupAdmission()
    }

    internal fun refreshHostedSignupAdmission() {
        signupButton?.isEnabled = (activity as? LoginActivity)?.takeIf {
            it.isAccountEntryAdmissionPublished()
        }?.isHostedSignupAdmissionAvailable() == true
    }

    override fun onDestroyView() {
        signupButton = null
        super.onDestroyView()
    }

    private fun applyInsets(root: View) {
        val left = root.paddingLeft
        val top = root.paddingTop
        val right = root.paddingRight
        val bottom = root.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            view.setPadding(
                left + insets.systemWindowInsetLeft,
                top + insets.systemWindowInsetTop,
                right + insets.systemWindowInsetRight,
                bottom + insets.systemWindowInsetBottom,
            )
            insets
        }
        ViewCompat.requestApplyInsets(root)
    }
}
