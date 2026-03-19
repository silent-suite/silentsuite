/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.vcard4android

import android.provider.ContactsContract.RawContacts.Data

object CachedGroupMembership {

    const val CONTENT_ITEM_TYPE = "x.davdroid/cached-group-membership"

    const val MIMETYPE = Data.MIMETYPE
    const val RAW_CONTACT_ID = Data.RAW_CONTACT_ID
    const val GROUP_ID = Data.DATA1

}
