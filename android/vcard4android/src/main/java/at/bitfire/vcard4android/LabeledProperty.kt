/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.vcard4android

import ezvcard.property.VCardProperty

data class LabeledProperty<out T: VCardProperty> @JvmOverloads constructor(
        val property: T,
        var label: String? = null
) {

    companion object {
        const val PROPERTY_AB_LABEL = "X-ABLabel"
    }

}
