package io.silentsuite.sync.ui.account

import io.silentsuite.sync.syncadapter.SyncStatusStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountDashboardStateTest {
    private val windows = SyncLifecycleWindows(interruptionAfterMillis = 100)
    private fun input(
        loaded: Boolean = true, loadFailed: Boolean = false, running: Boolean = false, pending: Boolean = false,
        setup: Boolean = true, master: Boolean = true, permission: Boolean = true, provider: Boolean = true,
        collections: Boolean = true,
        status: SyncStatusStore.Status? = SyncStatusStore.Status(), now: Long = 10,
    ) = AccountDashboardInput(loaded, running, setup, master, permission, provider, collections, status,
        loadFailed = loadFailed, pending = pending, now = now, windows = windows)

    @Test fun `restored base reducer blocks remain deterministic`() {
        assertEquals(AccountDashboardState.LOADING, reduceAccountDashboardState(input(loaded = false)).state)
        assertEquals(AccountDashboardLabel.STORAGE,
            presentAccountDashboard(reduceAccountDashboardState(input(loadFailed = true)), null).label)
        assertEquals(AccountDashboardState.SETUP_REQUIRED, reduceAccountDashboardState(input(setup = false)).state)
        assertEquals(AccountDashboardState.RUNNING, reduceAccountDashboardState(input(running = true, master = false)).state)
        assertEquals(AccountDashboardBlock.MASTER_SYNC, reduceAccountDashboardState(input(master = false)).blockedBy)
        assertEquals(AccountDashboardBlock.PERMISSION, reduceAccountDashboardState(input(permission = false)).blockedBy)
        assertEquals(AccountDashboardBlock.PROVIDER, reduceAccountDashboardState(input(provider = false)).blockedBy)
        assertTrue(reduceAccountDashboardState(input(collections = false)).setupDueToMissingCollections)
    }

    @Test fun `lifecycle precedence is requested queued running settling then terminal`() {
        val request = SyncStatusStore.Status(activeRequestId = "request", requestedAt = 1)
        assertEquals(AccountDashboardState.REQUESTED, reduceAccountDashboardState(input(status = request)).state)
        assertEquals(AccountDashboardState.QUEUED, reduceAccountDashboardState(input(status = request, pending = true)).state)
        assertEquals(AccountDashboardState.RUNNING, reduceAccountDashboardState(input(status = request, running = true)).state)
        val attempt = request.copy(activeAttemptId = "attempt", attemptStartedAt = 1)
        assertEquals(AccountDashboardState.SETTLING, reduceAccountDashboardState(input(status = attempt)).state)
        val overdue = attempt.copy(attemptStartedAt = 1)
        assertEquals(AccountDashboardState.SETTLING, reduceAccountDashboardState(input(status = overdue, now = 101)).state)
        assertEquals(AccountDashboardState.RUNNING, reduceAccountDashboardState(input(status = overdue, now = 101, running = true)).state)
        assertEquals(AccountDashboardState.QUEUED, reduceAccountDashboardState(input(status = request, now = 101, pending = true)).state)
    }

    @Test fun `platform pending outranks historical outcomes without a durable request`() {
        val historicalFailure = SyncStatusStore.Status(lastFailureAt = 1,
            lastFailureCategory = SyncStatusStore.FailureCategory.NETWORK)
        assertEquals(AccountDashboardState.QUEUED,
            reduceAccountDashboardState(input(status = historicalFailure, pending = true)).state)
        assertEquals(AccountDashboardState.QUEUED,
            reduceAccountDashboardState(input(status = SyncStatusStore.Status(), pending = true)).state)
    }

    @Test fun `v1 incomplete contact evidence is interruption not generic failure`() {
        val reduced = reduceAccountDashboardState(input(status = SyncStatusStore.Status(
            lastSuccessAt = 1, latestGenerationIncomplete = true, pendingChildren = 1)))
        assertEquals(AccountDashboardState.INTERRUPTED, reduced.state)
        assertEquals(AccountDashboardLabel.INTERRUPTED, presentAccountDashboard(reduced, 1).label)
    }

    @Test fun `every terminal category has specific non generic presentation`() {
        SyncStatusStore.FailureCategory.values().forEach { category ->
            val model = reduceAccountDashboardState(input(status = SyncStatusStore.Status(
                lastFailureAt = 2, lastFailureCategory = category)))
            val presentation = presentAccountDashboard(model, 2)
            assertFalse("$category selected generic attention", presentation.label == AccountDashboardLabel.NEEDS_ATTENTION)
        }
    }

    @Test fun `every terminal category uses its approved label icon tone and action`() {
        val expected = mapOf(
            SyncStatusStore.FailureCategory.AUTHENTICATION to listOf(AccountDashboardLabel.AUTHENTICATION, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.OPEN_ACCOUNT_SETTINGS),
            SyncStatusStore.FailureCategory.PERMISSION to listOf(AccountDashboardLabel.PERMISSION_NEEDED, AccountDashboardIcon.PERMISSION, AccountDashboardTone.WARNING, AccountDashboardAction.FIX_PERMISSIONS),
            SyncStatusStore.FailureCategory.CONFIGURATION to listOf(AccountDashboardLabel.CONFIGURATION, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.OPEN_SYNC_SETTINGS),
            SyncStatusStore.FailureCategory.SETUP_REQUIRED to listOf(AccountDashboardLabel.SETUP_NEEDED, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.REVIEW_SETUP),
            SyncStatusStore.FailureCategory.INTERRUPTED to listOf(AccountDashboardLabel.INTERRUPTED, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC),
            SyncStatusStore.FailureCategory.NETWORK to listOf(AccountDashboardLabel.NETWORK, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC),
            SyncStatusStore.FailureCategory.PROVIDER to listOf(AccountDashboardLabel.PROVIDER, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC),
            SyncStatusStore.FailureCategory.STORAGE to listOf(AccountDashboardLabel.STORAGE, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC),
            SyncStatusStore.FailureCategory.PARENT_REFRESH to listOf(AccountDashboardLabel.PARENT_REFRESH, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC),
            SyncStatusStore.FailureCategory.CHILD_REMOVED to listOf(AccountDashboardLabel.CHILD_REMOVED, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC),
            SyncStatusStore.FailureCategory.UNKNOWN to listOf(AccountDashboardLabel.UNKNOWN, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC),
        )
        expected.forEach { (category, semantics) ->
            val presentation = presentAccountDashboard(reduceAccountDashboardState(input(status = SyncStatusStore.Status(
                lastFailureAt = 2, lastFailureCategory = category))), 2)
            assertEquals(category.name, semantics[0], presentation.label)
            assertEquals(category.name, semantics[1], presentation.icon)
            assertEquals(category.name, semantics[2], presentation.tone)
            assertEquals(category.name, semantics[3], presentation.action)
        }
    }

    @Test fun `structural storage and explicit v2 terminal result outrank timestamp ties`() {
        val successAtMaximum = SyncStatusStore.Status(
            lastSuccessAt = Long.MAX_VALUE,
            lastFailureAt = Long.MAX_VALUE,
            lastFailureCategory = SyncStatusStore.FailureCategory.NETWORK,
            lastTerminalAt = Long.MAX_VALUE,
            lastTerminalResult = SyncStatusStore.TerminalResult.SUCCESS,
        )
        assertEquals(AccountDashboardState.SUCCESS, reduceAccountDashboardState(input(status = successAtMaximum)).state)
        assertTrue(latestMeaningfulResult(listOf(successAtMaximum))!!.success)

        val malformed = successAtMaximum.copy(structuralStorageFailure = true)
        val presentation = presentAccountDashboard(reduceAccountDashboardState(input(status = malformed)), null)
        assertEquals(AccountDashboardLabel.STORAGE, presentation.label)
        assertEquals(AccountDashboardAction.RETRY_SYNC, presentation.action)
    }

    @Test fun `terminal auth and configuration follow their exact local block rank`() {
        val auth = SyncStatusStore.Status(lastFailureAt = 2,
            lastFailureCategory = SyncStatusStore.FailureCategory.AUTHENTICATION)
        val configuration = SyncStatusStore.Status(lastFailureAt = 2,
            lastFailureCategory = SyncStatusStore.FailureCategory.CONFIGURATION)
        val authInput = AccountDashboardInput(true, false, true, false, false, false, true, auth, now = 10, windows = windows)
        assertEquals(AccountDashboardAction.OPEN_ACCOUNT_SETTINGS,
            presentAccountDashboard(reduceAccountDashboardState(authInput), null).action)
        val configInput = AccountDashboardInput(true, false, true, true, true, false, true, configuration, now = 10, windows = windows)
        assertEquals(AccountDashboardAction.OPEN_SYNC_SETTINGS,
            presentAccountDashboard(reduceAccountDashboardState(configInput), null).action)
    }

    @Test fun `aggregate retains blocked sibling issue and no work precedence is stable`() {
        val running = AccountDashboardModel(AccountDashboardState.RUNNING)
        val blocked = AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION)
        val active = aggregateAccountDashboard(listOf(running, blocked))
        assertEquals(AccountDashboardState.RUNNING, active.state)
        assertEquals(AccountDashboardBlock.PERMISSION, active.secondaryIssues.single().blockedBy)

        val auth = AccountDashboardModel(AccountDashboardState.ACTION_REQUIRED,
            failure = SyncStatusStore.FailureCategory.AUTHENTICATION)
        val master = AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.MASTER_SYNC)
        val config = AccountDashboardModel(AccountDashboardState.ACTION_REQUIRED,
            failure = SyncStatusStore.FailureCategory.CONFIGURATION)
        assertEquals(AccountDashboardState.ACTION_REQUIRED, aggregateAccountDashboard(listOf(config, master, auth)).state)
        assertEquals(SyncStatusStore.FailureCategory.AUTHENTICATION,
            aggregateAccountDashboard(listOf(config, master, auth)).failure)
    }

    @Test fun `missing task provider owns aggregate action while interrupted calendar retains retry`() {
        val interruptedCalendar = AccountDashboardModel(AccountDashboardState.INTERRUPTED,
            failure = SyncStatusStore.FailureCategory.INTERRUPTED)
        val readyContacts = AccountDashboardModel(AccountDashboardState.SUCCESS)
        val missingTaskProvider = AccountDashboardModel(AccountDashboardState.BLOCKED,
            blockedBy = AccountDashboardBlock.PROVIDER)

        val calendarPresentation = presentAccountDashboard(interruptedCalendar, null)
        assertEquals(AccountDashboardLabel.INTERRUPTED, calendarPresentation.label)
        assertEquals(AccountDashboardAction.RETRY_SYNC, calendarPresentation.action)

        val aggregate = aggregateAccountDashboard(listOf(interruptedCalendar, readyContacts, missingTaskProvider))
        val aggregatePresentation = presentAccountDashboard(aggregate, null)
        assertEquals(AccountDashboardState.BLOCKED, aggregate.state)
        assertEquals(AccountDashboardBlock.PROVIDER, aggregate.blockedBy)
        assertEquals(AccountDashboardLabel.TASK_APP_NEEDED, aggregatePresentation.label)
        assertEquals(AccountDashboardAction.INSTALL_TASK_APP, aggregatePresentation.action)
        assertTrue(aggregate.secondaryIssues.any {
            it.serviceIndex == 0 && it.state == AccountDashboardState.INTERRUPTED &&
                it.category == SyncStatusStore.FailureCategory.INTERRUPTED
        })
    }

    @Test fun `restored aggregate safety never reports success for incomplete service sets`() {
        val success = AccountDashboardModel(AccountDashboardState.SUCCESS)
        assertEquals(AccountDashboardState.NEVER_SYNCED,
            aggregateAccountDashboard(listOf(success, AccountDashboardModel(AccountDashboardState.NEVER_SYNCED), success)).state)
        assertEquals(AccountDashboardState.LOADING, aggregateAccountDashboard(emptyList()).state)
        assertNull(latestMeaningfulResult(listOf(null, SyncStatusStore.Status(), null)))
    }

    @Test fun `current work headlines while sibling action required interrupted and transient issues remain`() {
        val running = AccountDashboardModel(AccountDashboardState.RUNNING)
        listOf(
            SyncStatusStore.FailureCategory.PERMISSION to AccountDashboardState.ACTION_REQUIRED,
            SyncStatusStore.FailureCategory.INTERRUPTED to AccountDashboardState.INTERRUPTED,
            SyncStatusStore.FailureCategory.NETWORK to AccountDashboardState.TRANSIENT,
            SyncStatusStore.FailureCategory.PROVIDER to AccountDashboardState.TRANSIENT,
            SyncStatusStore.FailureCategory.STORAGE to AccountDashboardState.TRANSIENT,
        ).forEach { (category, state) ->
            val aggregate = aggregateAccountDashboard(listOf(running, AccountDashboardModel(state, failure = category)))
            assertEquals(AccountDashboardState.RUNNING, aggregate.state)
            assertEquals(category, aggregate.secondaryIssues.single().category)
        }
    }

    @Test fun `stable permutations retain precedence and all success remains healthy`() {
        val success = AccountDashboardModel(AccountDashboardState.SUCCESS)
        val requested = AccountDashboardModel(AccountDashboardState.REQUESTED)
        val auth = AccountDashboardModel(AccountDashboardState.ACTION_REQUIRED,
            failure = SyncStatusStore.FailureCategory.AUTHENTICATION)
        listOf(
            listOf(success, requested, auth), listOf(auth, success, requested), listOf(requested, auth, success),
        ).forEach { services ->
            val aggregate = aggregateAccountDashboard(services)
            assertEquals(AccountDashboardState.REQUESTED, aggregate.state)
            assertEquals(SyncStatusStore.FailureCategory.AUTHENTICATION, aggregate.secondaryIssues.single().category)
        }
        assertEquals(AccountDashboardState.SUCCESS, aggregateAccountDashboard(listOf(success, success, success)).state)
    }

    @Test fun `setup precedence and mixed terminal aggregation retain every sibling`() {
        val setup = AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED)
        val auth = AccountDashboardModel(AccountDashboardState.ACTION_REQUIRED,
            failure = SyncStatusStore.FailureCategory.AUTHENTICATION)
        val system = AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.MASTER_SYNC)
        val permission = AccountDashboardModel(AccountDashboardState.ACTION_REQUIRED,
            failure = SyncStatusStore.FailureCategory.PERMISSION)
        val configuration = AccountDashboardModel(AccountDashboardState.ACTION_REQUIRED,
            failure = SyncStatusStore.FailureCategory.CONFIGURATION)
        val provider = AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PROVIDER)
        listOf(
            listOf(auth, system, permission, configuration, provider, setup),
            listOf(setup, provider, configuration, permission, system, auth),
        ).forEach { services ->
            val aggregate = aggregateAccountDashboard(services)
            assertEquals(AccountDashboardState.SETUP_REQUIRED, aggregate.state)
        }
        val interrupted = AccountDashboardModel(AccountDashboardState.INTERRUPTED,
            failure = SyncStatusStore.FailureCategory.INTERRUPTED)
        val network = AccountDashboardModel(AccountDashboardState.TRANSIENT,
            failure = SyncStatusStore.FailureCategory.NETWORK)
        val mixed = aggregateAccountDashboard(listOf(interrupted, network, interrupted))
        assertEquals(3, mixed.secondaryIssues.size)
        assertEquals(AccountDashboardLabel.MIXED_FAILURE, presentAccountDashboard(mixed, null).label)
    }

    @Test fun `per service setup system permission and configuration precedence follows the plan`() {
        val setupFailure = SyncStatusStore.Status(lastFailureAt = 2,
            lastFailureCategory = SyncStatusStore.FailureCategory.SETUP_REQUIRED)
        val authFailure = SyncStatusStore.Status(lastFailureAt = 2,
            lastFailureCategory = SyncStatusStore.FailureCategory.AUTHENTICATION)
        val permissionFailure = SyncStatusStore.Status(lastFailureAt = 2,
            lastFailureCategory = SyncStatusStore.FailureCategory.PERMISSION)
        val configurationFailure = SyncStatusStore.Status(lastFailureAt = 2,
            lastFailureCategory = SyncStatusStore.FailureCategory.CONFIGURATION)
        assertEquals(AccountDashboardState.SETUP_REQUIRED,
            reduceAccountDashboardState(input(setup = false, status = authFailure)).state)
        assertEquals(AccountDashboardBlock.MASTER_SYNC,
            reduceAccountDashboardState(input(master = false, status = permissionFailure)).blockedBy)
        assertEquals(AccountDashboardBlock.PERMISSION,
            reduceAccountDashboardState(input(permission = false, status = configurationFailure)).blockedBy)
        assertEquals(AccountDashboardState.ACTION_REQUIRED,
            reduceAccountDashboardState(input(provider = false, status = configurationFailure)).state)
        assertEquals(AccountDashboardState.SETUP_REQUIRED,
            reduceAccountDashboardState(input(collections = false, status = setupFailure)).state)
    }

    @Test fun `aggregate precedence ranks every three-service action permutation exactly`() {
        val setup = AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED)
        val auth = AccountDashboardModel(AccountDashboardState.ACTION_REQUIRED,
            failure = SyncStatusStore.FailureCategory.AUTHENTICATION)
        val system = AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.MASTER_SYNC)
        val permission = AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION)
        val configuration = AccountDashboardModel(AccountDashboardState.ACTION_REQUIRED,
            failure = SyncStatusStore.FailureCategory.CONFIGURATION)
        val provider = AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PROVIDER)
        val siblings = listOf(setup, auth, system, permission, configuration, provider)

        siblings.forEach { first -> siblings.forEach { second -> siblings.forEach { third ->
            val services = listOf(first, second, third)
            val aggregate = aggregateAccountDashboard(services)
            val expected = siblings.first { it in services }
            assertEquals(expected.state, aggregate.state)
            assertEquals(expected.failure, aggregate.failure)
            assertEquals(expected.blockedBy, aggregate.blockedBy)
        } } }
    }

    @Test fun `identical terminal siblings retain their category while only mixed outcomes use mixed copy`() {
        val network = AccountDashboardModel(AccountDashboardState.TRANSIENT,
            failure = SyncStatusStore.FailureCategory.NETWORK)
        val interrupted = AccountDashboardModel(AccountDashboardState.INTERRUPTED,
            failure = SyncStatusStore.FailureCategory.INTERRUPTED)
        listOf(listOf(network, network), listOf(interrupted, interrupted)).forEach { services ->
            val aggregate = aggregateAccountDashboard(services)
            assertEquals(services.first().failure, aggregate.failure)
            assertEquals(presentAccountDashboard(services.first(), null).label, presentAccountDashboard(aggregate, null).label)
        }
        val mixed = aggregateAccountDashboard(listOf(network, interrupted))
        assertEquals(AccountDashboardLabel.MIXED_FAILURE, presentAccountDashboard(mixed, null).label)
    }

    @Test fun `current work retains every required sibling category in every service position`() {
        val running = AccountDashboardModel(AccountDashboardState.RUNNING)
        val siblings = listOf(
            AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED),
            AccountDashboardModel(AccountDashboardState.ACTION_REQUIRED, failure = SyncStatusStore.FailureCategory.AUTHENTICATION),
            AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.MASTER_SYNC),
            AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION),
            AccountDashboardModel(AccountDashboardState.ACTION_REQUIRED, failure = SyncStatusStore.FailureCategory.CONFIGURATION),
            AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PROVIDER),
            AccountDashboardModel(AccountDashboardState.INTERRUPTED, failure = SyncStatusStore.FailureCategory.INTERRUPTED),
            AccountDashboardModel(AccountDashboardState.TRANSIENT, failure = SyncStatusStore.FailureCategory.NETWORK),
            AccountDashboardModel(AccountDashboardState.TRANSIENT, failure = SyncStatusStore.FailureCategory.STORAGE),
        )
        siblings.forEach { sibling -> (0..2).forEach { runningIndex ->
            val services = MutableList(3) { AccountDashboardModel(AccountDashboardState.SUCCESS) }
            services[runningIndex] = running
            services[(runningIndex + 1) % 3] = sibling
            val aggregate = aggregateAccountDashboard(services)
            assertEquals(AccountDashboardState.RUNNING, aggregate.state)
            assertTrue(aggregate.secondaryIssues.any { it.state == sibling.state && it.category == sibling.failure && it.blockedBy == sibling.blockedBy })
        } }
    }

    @Test fun `announcement dedupe ignores checking and repeats`() {
        val deduper = MeaningfulDashboardTransitionDeduper()
        val requested = presentAccountDashboard(AccountDashboardModel(AccountDashboardState.REQUESTED), null)
        assertTrue(deduper.shouldAnnounce(requested))
        assertFalse(deduper.shouldAnnounce(requested))
        assertFalse(deduper.shouldAnnounce(presentAccountDashboard(AccountDashboardModel(AccountDashboardState.LOADING), null)))
    }
}
