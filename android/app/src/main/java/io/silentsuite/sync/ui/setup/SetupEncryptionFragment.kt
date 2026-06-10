package io.silentsuite.sync.ui.setup

import androidx.fragment.app.DialogFragment

/**
 * Legacy stub — was used only by EteSync v1 account setup encryption.
 * Etebase path uses CreateAccountFragment directly.
 * Scheduled for removal in story A1.2.
 */
class SetupEncryptionFragment : DialogFragment() {

    companion object {
        fun newInstance(config: BaseConfigurationFinder.Configuration): SetupEncryptionFragment {
            return SetupEncryptionFragment()
        }
    }
}
