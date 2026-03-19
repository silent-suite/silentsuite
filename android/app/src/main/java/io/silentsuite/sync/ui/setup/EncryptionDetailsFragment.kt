package io.silentsuite.sync.ui.setup

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment

/**
 * Legacy stub — was used only by EteSync v1 encryption details entry.
 * Scheduled for removal in story A1.2.
 */
class EncryptionDetailsFragment : Fragment() {

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return null
    }

    companion object {
        private const val KEY_CONFIG = "config"

        fun newInstance(config: BaseConfigurationFinder.Configuration): EncryptionDetailsFragment {
            val frag = EncryptionDetailsFragment()
            val args = Bundle(1)
            args.putSerializable(KEY_CONFIG, config)
            frag.arguments = args
            return frag
        }
    }
}
