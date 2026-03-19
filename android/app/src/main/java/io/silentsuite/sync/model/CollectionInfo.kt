/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.model

import java.io.Serializable

/**
 * Collection type enum and legacy metadata holder.
 *
 * The primary purpose of this class is to hold the Type enum used throughout
 * the codebase. The metadata fields (uid, displayName, etc.) are legacy holdovers
 * used by a few remaining legacy UI screens (CreateCollectionActivity, EditCollectionActivity)
 * and will be removed in Story A1.3.
 */
class CollectionInfo : Serializable {
    var uid: String? = null
    var displayName: String? = null
    var description: String? = null
    var color: Int? = null
    var enumType: Type? = null

    enum class Type {
        ADDRESS_BOOK,
        CALENDAR,
        TASKS,
    }
}
