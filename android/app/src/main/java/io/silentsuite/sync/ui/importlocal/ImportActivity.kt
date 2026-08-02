package io.silentsuite.sync.ui.importlocal

import android.accounts.Account
import android.app.Activity
import android.content.Context
import android.content.DialogInterface
import android.content.Intent
import android.os.Bundle
import android.view.*
import android.widget.ImageView
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.fragment.app.Fragment
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.etebase.CollectionLifecycleIdentity

class ImportActivity : BaseActivity(), SelectImportMethod, DialogInterface {

    private lateinit var account: Account
    private lateinit var identity: CollectionLifecycleIdentity
    protected lateinit var info: CollectionInfo

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        supportActionBar!!.setDisplayHomeAsUpEnabled(true)

        title = getString(R.string.import_dialog_title)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                popBackStack()
            }
        })

        val extras = requireNotNull(intent.extras) { "ImportActivity requires intent extras" }
        account = requireNotNull(extras.getParcelable(EXTRA_ACCOUNT)) { "ImportActivity requires EXTRA_ACCOUNT" }
        info = requireNotNull(extras.getSerializable(EXTRA_COLLECTION_INFO) as? CollectionInfo) { "ImportActivity requires EXTRA_COLLECTION_INFO" }
        val creationId = extras.getString(EXTRA_CREATION_ID)?.takeIf { it.isNotBlank() }
        val uid = info.uid?.takeIf { it.isNotBlank() }
        val type = when (info.enumType) {
            CollectionInfo.Type.CALENDAR -> Constants.ETEBASE_TYPE_CALENDAR
            CollectionInfo.Type.TASKS -> Constants.ETEBASE_TYPE_TASKS
            CollectionInfo.Type.ADDRESS_BOOK -> Constants.ETEBASE_TYPE_ADDRESS_BOOK
            null -> null
        }
        identity = runCatching {
            CollectionLifecycleIdentity.existing(account, requireNotNull(creationId), requireNotNull(uid), requireNotNull(type))
        }.getOrNull() ?: run {
            finish()
            return
        }
        if (!identity.validate(this)) {
            finish()
            return
        }

        if (savedInstanceState == null)
            supportFragmentManager.beginTransaction()
                    .add(android.R.id.content, ImportActivity.SelectImportFragment())
                    .commit()
    }

    override fun importFile() {
        supportFragmentManager.beginTransaction()
                .add(ImportFragment.newInstance(identity), null)
                .commit()

    }

    override fun importAccount() {
        if (info.enumType == CollectionInfo.Type.CALENDAR) {
            supportFragmentManager.beginTransaction()
                    .replace(android.R.id.content,
                            LocalCalendarImportFragment.newInstance(identity))
                    .addToBackStack(LocalCalendarImportFragment::class.java.name)
                    .commit()
        } else if (info.enumType == CollectionInfo.Type.ADDRESS_BOOK) {
            supportFragmentManager.beginTransaction()
                    .replace(android.R.id.content,
                            LocalContactImportFragment.newInstance(identity))
                    .addToBackStack(LocalContactImportFragment::class.java.name)
                    .commit()
        }
        title = getString(R.string.import_select_account)
    }

    private fun popBackStack() {
        if (!supportFragmentManager.popBackStackImmediate()) {
            finish()
        } else {
            title = getString(R.string.import_dialog_title)
        }
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == android.R.id.home) {
            popBackStack()
            return true
        }
        return false
    }

    override fun cancel() {
        finish()
    }

    override fun dismiss() {
        finish()
    }


    class SelectImportFragment : Fragment() {

        private var mSelectImportMethod: SelectImportMethod? = null

        override fun onAttach(context: Context) {
            super.onAttach(context)
            // This makes sure that the container activity has implemented
            // the callback interface. If not, it throws an exception
            try {
                mSelectImportMethod = activity as SelectImportMethod
            } catch (e: ClassCastException) {
                throw ClassCastException(activity.toString() + " must implement MyInterface ")
            }

        }

        override fun onAttach(activity: Activity) {
            super.onAttach(activity)
            // This makes sure that the container activity has implemented
            // the callback interface. If not, it throws an exception
            try {
                mSelectImportMethod = activity as SelectImportMethod?
            } catch (e: ClassCastException) {
                throw ClassCastException(activity.toString() + " must implement MyInterface ")
            }

        }

        override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
            val v = inflater.inflate(R.layout.import_actions_list, container, false)

            var card = v.findViewById<View>(R.id.import_file)
            var img = card.findViewById<View>(R.id.action_icon) as ImageView
            var text = card.findViewById<View>(R.id.action_text) as TextView
            img.setImageResource(R.drawable.ic_file_white)
            text.setText(R.string.import_button_file)
            card.setOnClickListener { mSelectImportMethod!!.importFile() }

            card = v.findViewById(R.id.import_account)
            img = card.findViewById<View>(R.id.action_icon) as ImageView
            text = card.findViewById<View>(R.id.action_text) as TextView
            img.setImageResource(R.drawable.ic_account_circle_white)
            text.setText(R.string.import_button_local)
            card.setOnClickListener { mSelectImportMethod!!.importAccount() }

            if ((activity as ImportActivity).info.enumType == CollectionInfo.Type.TASKS) {
                card.visibility = View.GONE
            }

            return v
        }
    }

    companion object {
        val EXTRA_ACCOUNT = "account"
        val EXTRA_COLLECTION_INFO = "collectionInfo"
        private const val EXTRA_CREATION_ID = "creationId"

        fun newIntent(context: Context, account: Account, creationId: String, info: CollectionInfo): Intent {
            require(creationId.isNotBlank()) { "Creation ID must be nonblank" }
            val intent = Intent(context, ImportActivity::class.java)
            intent.putExtra(ImportActivity.EXTRA_ACCOUNT, account)
            intent.putExtra(ImportActivity.EXTRA_COLLECTION_INFO, info)
            intent.putExtra(EXTRA_CREATION_ID, creationId)
            return intent
        }
    }
}
