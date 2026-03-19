/*
 * Copyright © Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package at.bitfire.ical4android

import androidx.test.runner.permission.PermissionRequester

object TestUtils {

    fun requestTaskPermissions() {
        PermissionRequester().apply {
            addPermissions(
                    *TaskProvider.PERMISSIONS_OPENTASKS,
                    *TaskProvider.PERMISSIONS_TASKS_ORG
            )
        }.requestPermissions()
    }

}