package io.silentsuite.sync.ui.setup

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.fragment.app.commit
import io.silentsuite.sync.R

/**
 * Welcome/explainer screen shown before the login form on first launch.
 * Explains what SilentSuite does and how it works.
 */
class WelcomeFragment : Fragment() {

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val v = inflater.inflate(R.layout.welcome_fragment, container, false)

        v.findViewById<View>(R.id.get_started).setOnClickListener {
            parentFragmentManager.commit {
                setCustomAnimations(
                    android.R.anim.fade_in,
                    android.R.anim.fade_out,
                    android.R.anim.fade_in,
                    android.R.anim.fade_out
                )
                replace(android.R.id.content, LoginCredentialsFragment())
                addToBackStack(null)
            }
        }

        return v
    }
}
