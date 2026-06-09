package io.silentsuite.sync.ui.setup

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
        fun newInstance(config: BaseConfigurationFinder.Configuration): EncryptionDetailsFragment {
            return EncryptionDetailsFragment()
        }
    }
}
