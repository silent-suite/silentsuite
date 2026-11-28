package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PostLoginSetupPresentationTest {
    @Test
    fun permissionStageUsesTheAndroidAppExplanation() {
        val presentation = presentationFor(PostLoginSetupState.PERMISSIONS)

        assertEquals(PostLoginSetupPresentation.Stage.PREPARE, presentation.stage)
        assertEquals(PostLoginSetupPresentation.Title.PERMISSIONS, presentation.title)
        assertEquals(PostLoginSetupPresentation.Body.PERMISSIONS, presentation.body)
    }

    @Test
    fun blockedPermissionIsAnErrorOnTheAndroidAppsStage() {
        val presentation = presentationFor(
            state = PostLoginSetupState.PERMISSIONS,
            condition = PostLoginSetupPresentationCondition.PERMISSION_BLOCKED,
        )

        assertEquals(PostLoginSetupPresentation.Stage.PREPARE, presentation.stage)
        assertEquals(PostLoginSetupPresentation.Title.PERMISSION_BLOCKED, presentation.title)
    }

    @Test
    fun readyUsesTheDedicatedReadyStageAndRequestedSyncCopy() {
        val presentation = presentationFor(PostLoginSetupState.READY)

        assertEquals(PostLoginSetupPresentation.Stage.READY, presentation.stage)
        assertEquals(PostLoginSetupPresentation.Title.READY, presentation.title)
        assertEquals(PostLoginSetupPresentation.Body.READY, presentation.body)
    }

    @Test
    fun integrationRowsShowAllowedOrNotAllowedOnlyAfterAndroidAnswers() {
        assertEquals(
            IntegrationAccess.ALLOWED,
            integrationAccessFor(PostLoginSetupOrchestrator.PermissionEvidence.GRANTED),
        )
        assertEquals(
            IntegrationAccess.NOT_ALLOWED,
            integrationAccessFor(
                PostLoginSetupOrchestrator.PermissionEvidence.DENIED_CAN_ASK_RETURNED
            ),
        )
        assertEquals(
            IntegrationAccess.NOT_ALLOWED,
            integrationAccessFor(
                PostLoginSetupOrchestrator.PermissionEvidence.DENIED_BLOCKED_RETURNED
            ),
        )
        assertNull(integrationAccessFor(PostLoginSetupOrchestrator.PermissionEvidence.NEWLY_ELIGIBLE))
        assertNull(integrationAccessFor(PostLoginSetupOrchestrator.PermissionEvidence.NO_PROVIDER))
        assertNull(integrationAccessFor(null))
    }

    @Test
    fun deniedMessageNamesOnlyTheIntegrationsMatchingItsCondition() {
        val permissions = mapOf(
            PostLoginSetupOrchestrator.Integration.CALENDAR to
                PostLoginSetupOrchestrator.PermissionEvidence.DENIED_CAN_ASK_RETURNED,
            PostLoginSetupOrchestrator.Integration.CONTACTS to
                PostLoginSetupOrchestrator.PermissionEvidence.GRANTED,
            PostLoginSetupOrchestrator.Integration.TASKS to
                PostLoginSetupOrchestrator.PermissionEvidence.DENIED_BLOCKED_RETURNED,
        )

        assertEquals(
            listOf(PostLoginSetupOrchestrator.Integration.CALENDAR),
            integrationsNamedFor(PostLoginSetupPresentationCondition.PERMISSION_DENIED, permissions),
        )
        assertEquals(
            listOf(PostLoginSetupOrchestrator.Integration.TASKS),
            integrationsNamedFor(PostLoginSetupPresentationCondition.PERMISSION_BLOCKED, permissions),
        )
        assertEquals(
            emptyList<PostLoginSetupOrchestrator.Integration>(),
            integrationsNamedFor(PostLoginSetupPresentationCondition.DEFAULT, permissions),
        )
    }
}
