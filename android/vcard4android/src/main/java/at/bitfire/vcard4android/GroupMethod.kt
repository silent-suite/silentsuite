/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.vcard4android

enum class GroupMethod {

    /**
     * Groups are separate VCards.
     * If VCard4 is available, group VCards have "KIND:group".
     * Otherwise (if only VCard3 is available), group VCards have "X-ADDRESSBOOKSERVER-KIND:group".
     */
    GROUP_VCARDS,

    /**
     * Groups are stored in a contact's CATEGORIES.
     */
    CATEGORIES

}
