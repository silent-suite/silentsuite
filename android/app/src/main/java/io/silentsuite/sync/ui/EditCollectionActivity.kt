/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.accounts.Account
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.EditText
import io.silentsuite.sync.R
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.resource.LocalTaskList

class EditCollectionActivity : CreateCollectionActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setTitle(R.string.edit_collection)

        when (info.enumType) {
            CollectionInfo.Type.CALENDAR -> {
                val colorSquare = findViewById<View>(R.id.color)
                colorSquare.setBackgroundColor(info.color ?: LocalCalendar.defaultColor)
            }
            CollectionInfo.Type.TASKS -> {
                val colorSquare = findViewById<View>(R.id.color)
                colorSquare.setBackgroundColor(info.color ?: LocalTaskList.defaultColor)
            }
            CollectionInfo.Type.ADDRESS_BOOK -> {
            }
            null -> {
            }
        }

        val edit = findViewById<View>(R.id.display_name) as EditText
        edit.setText(info.displayName)

        val desc = findViewById<View>(R.id.description) as EditText
        desc.setText(info.description)
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.activity_edit_collection, menu)
        return true
    }

    override fun onDestroy() {
        super.onDestroy()

        if (parent is Refreshable) {
            (parent as Refreshable).refresh()
        }
    }

    fun onDeleteCollection(item: MenuItem) {
        DeleteCollectionFragment.ConfirmDeleteCollectionFragment.newInstance(account, info).show(supportFragmentManager, null)
    }

    companion object {
        fun newIntent(context: Context, account: Account, info: CollectionInfo): Intent {
            val intent = Intent(context, EditCollectionActivity::class.java)
            intent.putExtra(CreateCollectionActivity.EXTRA_ACCOUNT, account)
            intent.putExtra(CreateCollectionActivity.EXTRA_COLLECTION_INFO, info)
            return intent
        }
    }
}
