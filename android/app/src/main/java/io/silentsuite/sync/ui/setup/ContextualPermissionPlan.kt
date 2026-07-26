package io.silentsuite.sync.ui.setup

import io.silentsuite.sync.Constants

/** Pure permission policy. It requests only integrations that the reconciled account can use. */
object ContextualPermissionPlan {
    data class Inputs(
        val qualifyingTypes: Set<String>,
        val installedTaskProviderPermissions: List<String> = emptyList()
    )

    fun requested(inputs: Inputs): List<String> = buildList {
        if (Constants.ETEBASE_TYPE_CALENDAR in inputs.qualifyingTypes) addAll(CALENDAR)
        if (Constants.ETEBASE_TYPE_ADDRESS_BOOK in inputs.qualifyingTypes) addAll(CONTACTS)
        if (Constants.ETEBASE_TYPE_TASKS in inputs.qualifyingTypes) addAll(inputs.installedTaskProviderPermissions)
    }.distinct()

    val CALENDAR = listOf("android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR")
    val CONTACTS = listOf("android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS")
}
