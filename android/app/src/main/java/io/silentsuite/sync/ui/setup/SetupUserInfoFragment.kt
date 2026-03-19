package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.content.Context
import android.os.Bundle
import androidx.fragment.app.DialogFragment
import io.silentsuite.sync.Constants.KEY_ACCOUNT

/**
 * Legacy stub — was used only by EteSync v1 UserInfo setup.
 * Etebase account setup does not use UserInfo.
 * Scheduled for removal in story A1.2.
 */
class SetupUserInfoFragment : DialogFragment() {

    companion object {

        fun newInstance(account: Account): SetupUserInfoFragment {
            val frag = SetupUserInfoFragment()
            val args = Bundle(1)
            args.putParcelable(KEY_ACCOUNT, account)
            frag.arguments = args
            return frag
        }

        fun hasUserInfo(context: Context, account: Account): Boolean {
            return false
        }
    }
}
