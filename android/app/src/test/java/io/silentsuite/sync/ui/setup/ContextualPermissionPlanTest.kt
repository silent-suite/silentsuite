package io.silentsuite.sync.ui.setup

import io.silentsuite.sync.Constants
import org.junit.Assert.assertEquals
import org.junit.Test

class ContextualPermissionPlanTest {
    @Test fun `calendar contacts and task permissions follow qualifying integrations only`() {
        assertEquals(emptyList<String>(), ContextualPermissionPlan.requested(ContextualPermissionPlan.Inputs(emptySet())))
        assertEquals(ContextualPermissionPlan.CALENDAR, ContextualPermissionPlan.requested(
            ContextualPermissionPlan.Inputs(setOf(Constants.ETEBASE_TYPE_CALENDAR))))
        assertEquals(ContextualPermissionPlan.CONTACTS, ContextualPermissionPlan.requested(
            ContextualPermissionPlan.Inputs(setOf(Constants.ETEBASE_TYPE_ADDRESS_BOOK))))
        assertEquals(listOf("task.permission"), ContextualPermissionPlan.requested(
            ContextualPermissionPlan.Inputs(setOf(Constants.ETEBASE_TYPE_TASKS), listOf("task.permission"))))
    }
}
