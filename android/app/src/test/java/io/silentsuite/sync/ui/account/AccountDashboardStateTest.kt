package io.silentsuite.sync.ui.account

import io.silentsuite.sync.syncadapter.SyncStatusStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountDashboardStateTest {
    private fun input(
        loaded: Boolean = true, loadFailed: Boolean = false, running: Boolean = false, setup: Boolean = true,
        master: Boolean = true, permission: Boolean = true, provider: Boolean = true,
        collections: Boolean = true, status: SyncStatusStore.Status? = SyncStatusStore.Status(),
    ) = AccountDashboardInput(loaded, running, setup, master, permission, provider, collections, status, loadFailed)

    private fun model(
        state: AccountDashboardState,
        block: AccountDashboardBlock? = null,
        collectionMissing: Boolean = false,
    ) = AccountDashboardModel(state, block, collectionMissing)

    @Test fun `all reducer states have deterministic truthful precedence`() {
        assertEquals(model(AccountDashboardState.LOADING), reduceAccountDashboardState(input(loaded = false, running = true)))
        assertEquals(model(AccountDashboardState.FAILURE), reduceAccountDashboardState(input(loaded = false, loadFailed = true)))
        assertEquals(model(AccountDashboardState.SETUP_REQUIRED), reduceAccountDashboardState(input(setup = false, running = true)))
        assertEquals(model(AccountDashboardState.SETUP_REQUIRED, collectionMissing = true), reduceAccountDashboardState(input(collections = false)))
        assertEquals(model(AccountDashboardState.RUNNING), reduceAccountDashboardState(input(running = true, master = false)))
        assertEquals(model(AccountDashboardState.BLOCKED, AccountDashboardBlock.MASTER_SYNC), reduceAccountDashboardState(input(master = false)))
        assertEquals(model(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION), reduceAccountDashboardState(input(permission = false)))
        assertEquals(model(AccountDashboardState.BLOCKED, AccountDashboardBlock.PROVIDER), reduceAccountDashboardState(input(provider = false)))
        assertEquals(model(AccountDashboardState.NEVER_SYNCED), reduceAccountDashboardState(input(status = null)))
        assertEquals(model(AccountDashboardState.NEVER_SYNCED), reduceAccountDashboardState(input()))
        assertEquals(model(AccountDashboardState.SETUP_REQUIRED), reduceAccountDashboardState(input(status = SyncStatusStore.Status(lastFailureAt = 30, lastFailureCategory = SyncStatusStore.FailureCategory.SETUP_REQUIRED))))
        assertEquals(model(AccountDashboardState.SUCCESS), reduceAccountDashboardState(input(status = SyncStatusStore.Status(lastSuccessAt = 20, lastFailureAt = 10, lastFailureCategory = SyncStatusStore.FailureCategory.NETWORK))))
        assertEquals(model(AccountDashboardState.FAILURE), reduceAccountDashboardState(input(status = SyncStatusStore.Status(lastSuccessAt = 10, lastFailureAt = 20, lastFailureCategory = SyncStatusStore.FailureCategory.PERMISSION))))
        assertEquals(model(AccountDashboardState.SUCCESS), reduceAccountDashboardState(input(status = SyncStatusStore.Status(lastSuccessAt = 30, lastFailureAt = 20, lastFailureCategory = SyncStatusStore.FailureCategory.SETUP_REQUIRED))))
        assertEquals(model(AccountDashboardState.FAILURE), reduceAccountDashboardState(input(status = SyncStatusStore.Status(lastSuccessAt = 30, lastFailureAt = 30, lastFailureCategory = SyncStatusStore.FailureCategory.NETWORK))))
    }

    @Test fun `actionable permission and provider remediation exhaustively outrank collection absence`() {
        listOf(true, false).forEach { permission ->
            listOf(true, false).forEach { provider ->
                listOf(true, false).forEach { collections ->
                    val reduced = reduceAccountDashboardState(input(
                        permission = permission,
                        provider = provider,
                        collections = collections,
                    ))
                    val expected = when {
                        !permission -> model(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION)
                        !provider -> model(AccountDashboardState.BLOCKED, AccountDashboardBlock.PROVIDER)
                        !collections -> model(AccountDashboardState.SETUP_REQUIRED, collectionMissing = true)
                        else -> model(AccountDashboardState.NEVER_SYNCED)
                    }
                    assertEquals(
                        "permission=$permission provider=$provider collections=$collections",
                        expected,
                        reduced,
                    )
                    val expectedAction = when {
                        !permission -> AccountDashboardAction.FIX_PERMISSIONS
                        !provider -> AccountDashboardAction.INSTALL_TASK_APP
                        !collections -> AccountDashboardAction.REVIEW_SETUP
                        else -> AccountDashboardAction.SYNC_NOW
                    }
                    assertEquals(expectedAction, presentAccountDashboard(reduced, null).action)
                }
            }
        }
    }

    @Test fun `aggregate dominant action keeps actionable blocks ahead of collection setup`() {
        val collectionMissing = model(AccountDashboardState.SETUP_REQUIRED, collectionMissing = true)
        val permissionMissing = model(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION)
        val providerMissing = model(AccountDashboardState.BLOCKED, AccountDashboardBlock.PROVIDER)

        val permissionDominant = aggregateAccountDashboard(listOf(collectionMissing, providerMissing, permissionMissing))
        assertEquals(permissionMissing, permissionDominant)
        assertEquals(AccountDashboardAction.FIX_PERMISSIONS,
            presentAccountDashboard(permissionDominant, null).action)

        val providerDominant = aggregateAccountDashboard(listOf(collectionMissing, providerMissing))
        assertEquals(providerMissing, providerDominant)
        assertEquals(AccountDashboardAction.INSTALL_TASK_APP,
            presentAccountDashboard(providerDominant, null).action)
    }

    @Test fun `inactive or merely requested sync never becomes success`() {
        assertEquals(AccountDashboardState.NEVER_SYNCED, reduceAccountDashboardState(input(running = false, status = SyncStatusStore.Status())).state)
        assertEquals(AccountDashboardState.NEVER_SYNCED, reduceAccountDashboardState(input(running = false, status = null)).state)
    }

    @Test fun `inactive incomplete latest contacts generation cannot expose old success`() {
        val status = SyncStatusStore.Status(lastSuccessAt = 10, latestGenerationIncomplete = true, pendingChildren = 1)
        assertEquals(AccountDashboardState.FAILURE, reduceAccountDashboardState(input(running = false, status = status)).state)
        assertEquals(AccountDashboardState.RUNNING, reduceAccountDashboardState(input(running = true, status = status)).state)
    }

    @Test fun `presenter maps every state to distinct supported semantics`() {
        val cases = listOf(
            model(AccountDashboardState.LOADING) to Expected(AccountDashboardLabel.CHECKING, AccountDashboardIcon.PROGRESS, AccountDashboardTone.NEUTRAL, AccountDashboardAction.NONE),
            model(AccountDashboardState.RUNNING) to Expected(AccountDashboardLabel.SYNCING, AccountDashboardIcon.SYNC, AccountDashboardTone.PRIMARY, AccountDashboardAction.NONE),
            model(AccountDashboardState.NEVER_SYNCED) to Expected(AccountDashboardLabel.NEVER_SYNCED, AccountDashboardIcon.HISTORY, AccountDashboardTone.NEUTRAL, AccountDashboardAction.SYNC_NOW),
            model(AccountDashboardState.SUCCESS) to Expected(AccountDashboardLabel.SYNCED, AccountDashboardIcon.SUCCESS, AccountDashboardTone.SUCCESS, AccountDashboardAction.SYNC_NOW),
            model(AccountDashboardState.FAILURE) to Expected(AccountDashboardLabel.NEEDS_ATTENTION, AccountDashboardIcon.WARNING, AccountDashboardTone.ERROR, AccountDashboardAction.RETRY_SYNC),
            model(AccountDashboardState.BLOCKED, AccountDashboardBlock.MASTER_SYNC) to Expected(AccountDashboardLabel.SYNC_PAUSED, AccountDashboardIcon.PAUSED, AccountDashboardTone.WARNING, AccountDashboardAction.ENABLE_SYNC),
            model(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION) to Expected(AccountDashboardLabel.PERMISSION_NEEDED, AccountDashboardIcon.PERMISSION, AccountDashboardTone.WARNING, AccountDashboardAction.FIX_PERMISSIONS),
            model(AccountDashboardState.BLOCKED, AccountDashboardBlock.PROVIDER) to Expected(AccountDashboardLabel.TASK_APP_NEEDED, AccountDashboardIcon.PROVIDER, AccountDashboardTone.WARNING, AccountDashboardAction.INSTALL_TASK_APP),
            model(AccountDashboardState.SETUP_REQUIRED) to Expected(AccountDashboardLabel.SETUP_NEEDED, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.REVIEW_SETUP),
        )

        cases.forEach { (state, expected) ->
            val presented = presentAccountDashboard(state, 123L)
            assertEquals(expected.label, presented.label)
            assertEquals(expected.icon, presented.icon)
            assertEquals(expected.tone, presented.tone)
            assertEquals(expected.action, presented.action)
            assertEquals(123L, presented.lastMeaningfulAt)
            assertTrue(presented.accessibilityKey.isNotBlank())
        }
        assertEquals(cases.size, cases.map { presentAccountDashboard(it.first, 123L).accessibilityKey }.toSet().size)
    }

    @Test fun `aggregate never claims success until every service has succeeded`() {
        assertEquals(AccountDashboardState.SUCCESS, aggregateAccountDashboard(listOf(model(AccountDashboardState.SUCCESS), model(AccountDashboardState.SUCCESS), model(AccountDashboardState.SUCCESS))).state)
        assertEquals(AccountDashboardState.NEVER_SYNCED, aggregateAccountDashboard(listOf(model(AccountDashboardState.SUCCESS), model(AccountDashboardState.NEVER_SYNCED), model(AccountDashboardState.SUCCESS))).state)
        assertEquals(AccountDashboardState.FAILURE, aggregateAccountDashboard(listOf(model(AccountDashboardState.SUCCESS), model(AccountDashboardState.FAILURE), model(AccountDashboardState.SUCCESS))).state)
        assertEquals(AccountDashboardState.BLOCKED, aggregateAccountDashboard(listOf(model(AccountDashboardState.SUCCESS), model(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION), model(AccountDashboardState.SUCCESS))).state)
        assertEquals(AccountDashboardBlock.PERMISSION, aggregateAccountDashboard(listOf(model(AccountDashboardState.BLOCKED, AccountDashboardBlock.PROVIDER), model(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION))).blockedBy)
        assertEquals(AccountDashboardState.RUNNING, aggregateAccountDashboard(listOf(model(AccountDashboardState.SUCCESS), model(AccountDashboardState.RUNNING))).state)
        assertEquals(AccountDashboardState.SETUP_REQUIRED, aggregateAccountDashboard(listOf(model(AccountDashboardState.RUNNING), model(AccountDashboardState.SETUP_REQUIRED))).state)
        assertEquals(AccountDashboardState.LOADING, aggregateAccountDashboard(emptyList()).state)
        AccountDashboardState.values().forEach { state ->
            if (state != AccountDashboardState.SUCCESS)
                assertFalse(aggregateAccountDashboard(listOf(model(AccountDashboardState.SUCCESS), model(state))).state == AccountDashboardState.SUCCESS)
        }
    }

    @Test fun `latest meaningful result is selected without inventing evidence`() {
        assertNull(latestMeaningfulResult(listOf(null, SyncStatusStore.Status(), null)))
        val result = latestMeaningfulResult(listOf(
            SyncStatusStore.Status(lastSuccessAt = 10),
            SyncStatusStore.Status(lastSuccessAt = 20, lastFailureAt = 30, lastFailureCategory = SyncStatusStore.FailureCategory.NETWORK),
            SyncStatusStore.Status(lastFailureAt = 25, lastFailureCategory = SyncStatusStore.FailureCategory.PERMISSION),
        ))
        assertEquals(30L, result?.timestamp)
        assertFalse(result?.success ?: true)
        assertFalse(latestMeaningfulResult(listOf(
            SyncStatusStore.Status(lastSuccessAt = 40, lastFailureAt = 40,
                lastFailureCategory = SyncStatusStore.FailureCategory.UNKNOWN),
        ))?.success ?: true)
    }

    @Test fun `meaningful transition announcements are deduplicated`() {
        val deduper = MeaningfulDashboardTransitionDeduper()
        val never = presentAccountDashboard(model(AccountDashboardState.NEVER_SYNCED), null)
        val success = presentAccountDashboard(model(AccountDashboardState.SUCCESS), 100)
        assertTrue(deduper.shouldAnnounce(never))
        assertFalse(deduper.shouldAnnounce(never))
        assertTrue(deduper.shouldAnnounce(success))
        assertFalse(deduper.shouldAnnounce(success))
        assertFalse(deduper.shouldAnnounce(presentAccountDashboard(model(AccountDashboardState.LOADING), null)))
        assertFalse(deduper.shouldAnnounce(success))
        assertTrue(deduper.shouldAnnounce(presentAccountDashboard(model(AccountDashboardState.SUCCESS), 101)))
        assertFalse(deduper.shouldAnnounce(presentAccountDashboard(model(AccountDashboardState.LOADING), null)))
    }

    @Test fun `unknown blocked subtype fails closed to one retry remediation`() {
        val presentation = presentAccountDashboard(model(AccountDashboardState.BLOCKED), 55)
        assertEquals(AccountDashboardLabel.NEEDS_ATTENTION, presentation.label)
        assertEquals(AccountDashboardIcon.WARNING, presentation.icon)
        assertEquals(AccountDashboardTone.ERROR, presentation.tone)
        assertEquals(AccountDashboardAction.RETRY_SYNC, presentation.action)
    }

    private data class Expected(
        val label: AccountDashboardLabel,
        val icon: AccountDashboardIcon,
        val tone: AccountDashboardTone,
        val action: AccountDashboardAction,
    )
}
