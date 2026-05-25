package io.silentsuite.sync.ui.etebase

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.*
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.fragment.app.commit
import androidx.lifecycle.lifecycleScope
import com.etebase.client.CollectionAccessLevel
import io.silentsuite.sync.CachedCollection
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.dataexport.AndroidDataExporter
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.ui.BaseActivity
import io.silentsuite.sync.ui.importlocal.ImportFragment
import io.silentsuite.sync.utils.TaskProviderHandling
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.logging.Level

class ViewCollectionFragment : Fragment() {
    private val accountModel: AccountViewModel by activityViewModels()
    private val collectionModel: CollectionViewModel by activityViewModels()
    private val itemsModel: ItemsViewModel by activityViewModels()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        val ret = inflater.inflate(R.layout.view_collection_fragment, container, false)
        setHasOptionsMenu(true)

        if (savedInstanceState == null) {
            collectionModel.observe(this) {
                (activity as? BaseActivity?)?.supportActionBar?.title = it.meta.name
                if (container != null) {
                    initUi(inflater, ret, it)
                }
            }
        }

        return ret
    }

    private fun initUi(inflater: LayoutInflater, container: View, cachedCollection: CachedCollection) {
        val title = container.findViewById<TextView>(R.id.display_name)

        val col = cachedCollection.col
        val meta = cachedCollection.meta
        val isAdmin = col.accessLevel == CollectionAccessLevel.Admin

        val colorSquare = container.findViewById<View>(R.id.color)
        val color = LocalCalendar.parseColor(meta.color)
        when (cachedCollection.collectionType) {
            Constants.ETEBASE_TYPE_CALENDAR -> {
                colorSquare.setBackgroundColor(color)
            }
            Constants.ETEBASE_TYPE_TASKS -> {
                colorSquare.setBackgroundColor(color)
                val tasksNotShowing = container.findViewById<View>(R.id.tasks_not_showing)
                tasksNotShowing.visibility = if (TaskProviderHandling.getWantedTaskSyncProvider(requireContext()) == null) {
                    View.VISIBLE
                } else {
                    View.GONE
                }
            }
            Constants.ETEBASE_TYPE_ADDRESS_BOOK -> {
                colorSquare.visibility = View.GONE
            }
        }

        title.text = meta.name

        val desc = container.findViewById<TextView>(R.id.description)
        desc.text = meta.description

        val owner = container.findViewById<TextView>(R.id.owner)
        if (isAdmin) {
            owner.visibility = View.GONE
        } else {
            owner.visibility = View.VISIBLE
            owner.text = getString(R.string.collection_shared_with_us)
        }

        itemsModel.observe(this) {
            val stats = container.findViewById<TextView>(R.id.stats)
            container.findViewById<View>(R.id.progressBar).visibility = View.GONE
            stats.text = if (it.isEmpty()) {
                getString(R.string.collection_recent_activity_none)
            } else {
                resources.getQuantityString(R.plurals.collection_recent_activity_items, it.size, it.size)
            }
        }
    }

    override fun onCreateOptionsMenu(menu: Menu, inflater: MenuInflater) {
        super.onCreateOptionsMenu(menu, inflater)
        inflater.inflate(R.menu.fragment_view_collection, menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        val cachedCollection = collectionModel.value
        if (cachedCollection == null) {
            Toast.makeText(context, R.string.loading_error_title, Toast.LENGTH_LONG).show()
            return super.onOptionsItemSelected(item)
        }

        when (item.itemId) {
            R.id.on_edit -> {
                if (cachedCollection.col.accessLevel == CollectionAccessLevel.Admin) {
                    parentFragmentManager.commit {
                        replace(R.id.fragment_container, EditCollectionFragment.newInstance(cachedCollection))
                        addToBackStack(EditCollectionFragment::class.java.name)
                    }
                } else {
                    val dialog = AlertDialog.Builder(requireContext())
                            .setIcon(R.drawable.ic_info_dark)
                            .setTitle(R.string.not_allowed_title)
                            .setMessage(R.string.edit_owner_only_anon)
                            .setPositiveButton(android.R.string.yes) { _, _ -> }.create()
                    dialog.show()
                }
            }
            R.id.on_manage_members -> {
                parentFragmentManager.commit {
                    replace(R.id.fragment_container, CollectionMembersFragment())
                    addToBackStack(null)
                }
            }
            R.id.on_import -> {
                startImport(cachedCollection)
                return true
            }
            R.id.on_export -> {
                createExportDocument(cachedCollection)
                return true
            }
        }
        return super.onOptionsItemSelected(item)
    }

    private fun startImport(cachedCollection: CachedCollection) {
        if (cachedCollection.col.accessLevel == CollectionAccessLevel.ReadOnly) {
            val dialog = AlertDialog.Builder(requireContext())
                    .setIcon(R.drawable.ic_info_dark)
                    .setTitle(R.string.not_allowed_title)
                    .setMessage(R.string.edit_owner_only_anon)
                    .setPositiveButton(android.R.string.yes) { _, _ -> }.create()
            dialog.show()
            return
        }

        val accountHolder = accountModel.value
        if (accountHolder == null) {
            Toast.makeText(context, R.string.loading_error_title, Toast.LENGTH_LONG).show()
            return
        }

        parentFragmentManager.commit {
            add(ImportFragment.newInstance(accountHolder.account, cachedCollection), null)
        }
    }

    private fun createExportDocument(cachedCollection: CachedCollection) {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = AndroidDataExporter.collectionMimeType(cachedCollection.collectionType)
            putExtra(Intent.EXTRA_TITLE, AndroidDataExporter.suggestedCollectionFileName(cachedCollection.collectionType, cachedCollection.meta.name))
        }
        startActivityForResult(intent, REQUEST_CREATE_COLLECTION_EXPORT_DOCUMENT)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_CREATE_COLLECTION_EXPORT_DOCUMENT) return

        val uri = if (resultCode == Activity.RESULT_OK) data?.data else null
        if (uri == null) return

        val cachedCollection = collectionModel.value ?: run {
            Toast.makeText(context, R.string.loading_error_title, Toast.LENGTH_LONG).show()
            return
        }
        val itemContents = itemsModel.value
            ?.filter { !it.item.isDeleted }
            ?.map { it.content }
            ?: emptyList()

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val outputStream = requireContext().contentResolver.openOutputStream(uri)
                            ?: throw IOException("Could not open export destination")
                    outputStream.use {
                        AndroidDataExporter.writeCollectionExport(cachedCollection.collectionType, itemContents, it)
                    }
                }
                Toast.makeText(requireContext(), R.string.export_data_success, Toast.LENGTH_LONG).show()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                io.silentsuite.sync.log.Logger.log.log(Level.SEVERE, "Collection data export failed", e)
                Toast.makeText(requireContext(), R.string.export_data_failed, Toast.LENGTH_LONG).show()
            }
        }
    }

    companion object {
        private const val REQUEST_CREATE_COLLECTION_EXPORT_DOCUMENT = 6385
    }
}
