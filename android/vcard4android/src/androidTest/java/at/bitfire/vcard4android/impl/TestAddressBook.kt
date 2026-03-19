/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.vcard4android.impl

import android.accounts.Account
import android.content.ContentProviderClient
import android.content.ContentValues
import at.bitfire.vcard4android.*

class TestAddressBook(
        account: Account,
        provider: ContentProviderClient
): AndroidAddressBook<AndroidContact, AndroidGroup>(account, provider, ContactFactory, GroupFactory) {

    object ContactFactory: AndroidContactFactory<AndroidContact> {

        override fun fromProvider(addressBook: AndroidAddressBook<AndroidContact, *>, values: ContentValues) =
                AndroidContact(addressBook, values)

    }


    object GroupFactory: AndroidGroupFactory<AndroidGroup> {

        override fun fromProvider(addressBook: AndroidAddressBook<*, AndroidGroup>, values: ContentValues) =
                AndroidGroup(addressBook, values)

    }
    
}