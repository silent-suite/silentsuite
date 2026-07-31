package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class PostLoginSetupPresentationTest {
    @Test
    fun permissionStageUsesTheAndroidAppExplanation() {
        val presentation = presentationFor(PostLoginSetupState.PERMISSIONS)

        assertEquals(PostLoginSetupPresentation.Stage.PREPARE, presentation.stage)
        assertEquals(PostLoginSetupPresentation.Title.PERMISSIONS, presentation.title)
        assertEquals(PostLoginSetupPresentation.Body.PERMISSIONS, presentation.body)
        assertEquals(PostLoginSetupPresentation.Tone.DEFAULT, presentation.tone)
    }

    @Test
    fun blockedPermissionIsAnErrorOnTheAndroidAppsStage() {
        val presentation = presentationFor(
            state = PostLoginSetupState.PERMISSIONS,
            condition = PostLoginSetupPresentationCondition.PERMISSION_BLOCKED,
        )

        assertEquals(PostLoginSetupPresentation.Stage.PREPARE, presentation.stage)
        assertEquals(PostLoginSetupPresentation.Title.PERMISSION_BLOCKED, presentation.title)
        assertEquals(PostLoginSetupPresentation.Tone.ERROR, presentation.tone)
    }

    @Test
    fun readyUsesTheDedicatedReadyStageAndRequestedSyncCopy() {
        val presentation = presentationFor(PostLoginSetupState.READY)

        assertEquals(PostLoginSetupPresentation.Stage.READY, presentation.stage)
        assertEquals(PostLoginSetupPresentation.Title.READY, presentation.title)
        assertEquals(PostLoginSetupPresentation.Body.READY, presentation.body)
    }
}
