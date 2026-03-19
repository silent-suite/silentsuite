package io.silentsuite.sync.ui.setup

import android.os.Bundle
import androidx.fragment.app.DialogFragment

/**
 * Legacy stub — was used only by EteSync v1 account setup encryption.
 * Etebase path uses CreateAccountFragment directly.
 * Scheduled for removal in story A1.2.
 */
class SetupEncryptionFragment : DialogFragment() {

    companion object {
        private const val KEY_CONFIG = "config"

        fun newInstance(config: BaseConfigurationFinder.Configuration): SetupEncryptionFragment {
            val frag = SetupEncryptionFragment()
            val args = Bundle(1)
            args.putSerializable(KEY_CONFIG, config)
            frag.arguments = args
            return frag
        }
    }
}
